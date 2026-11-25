// ============================================================================
// server/AuctionEngine.js — Core Bidding Engine
// ============================================================================
// Manages auction lifecycle and processes bids atomically using per-item
// FIFO AsyncQueues to eliminate race conditions, stale reads, and overselling.
// Supports single-unit and limited multi-unit stock (Top-K winning slots),
// anti-sniping extensions, coalesced broadcast batching, live analytics, and
// write-behind database persistence.
// ============================================================================

'use strict';

const { v4: uuidv4 } = require('uuid');
const config         = require('./config');
const { ServerMsg, RejectReason, AuctionStatus, buildMessage } = require('../shared/protocol');

// ── Async Queue (serialises tasks for one item) ────────────────────────────

class AsyncQueue {
  constructor() {
    this._queue      = [];
    this._processing = false;
  }

  get depth() {
    return this._queue.length + (this._processing ? 1 : 0);
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this._queue.push({ task, resolve, reject });
      this._processNext();
    });
  }

  /** @private */
  async _processNext() {
    if (this._processing) return;
    this._processing = true;

    while (this._queue.length > 0) {
      const { task, resolve, reject } = this._queue.shift();
      try {
        resolve(await task());
      } catch (err) {
        reject(err);
      }
    }

    this._processing = false;
  }
}

// ── Auction Engine ─────────────────────────────────────────────────────────

class AuctionEngine {
  /**
   * @param {import('./ConnectionManager')} connectionManager
   * @param {import('./AnalyticsCollector')|null} [analytics]
   * @param {import('./Database')|null} [database]
   */
  constructor(connectionManager, analytics = null, database = null) {
    this.cm        = connectionManager;
    this.analytics = analytics;
    this.db        = database;

    this.auctions   = new Map();
    this._bidQueues = new Map();

    // Coalesced broadcast batches: auctionId → Map<itemId, updateObj>
    this._broadcastBatches = new Map();
    this._batchTimer       = null;
  }

  // ── Auction Lifecycle ─────────────────────────────────────────────────

  createAuction({ title, durationSec, items }) {
    const auctionId = uuidv4();
    const duration  = Math.max(1, Number(durationSec) || config.DEFAULT_AUCTION_DURATION_SEC) * 1000;
    const now       = Date.now();
    const startTime = now;
    const endTime   = now + duration;

    const itemsMap = new Map();
    for (const item of items) {
      const itemId = uuidv4();
      const stock  = Math.max(1, parseInt(item.stock, 10) || 1);
      const startingPrice = Number(item.startingPrice);

      itemsMap.set(itemId, {
        id:            itemId,
        name:          item.name,
        description:   item.description || '',
        imageUrl:      item.imageUrl || null,
        startingPrice,
        currentBid:    startingPrice,
        cutoffBid:     startingPrice,
        currentBidder: null,
        bidderName:    null,
        stock,
        topBids:       [],       // Top-K active winning slots sorted desc
        totalBids:     0,
        bidHistory:    [],
        version:       0,
      });

      this._bidQueues.set(`${auctionId}:${itemId}`, new AsyncQueue());
    }

    const auction = {
      id:        auctionId,
      title,
      status:    duration <= 30000 ? AuctionStatus.ENDING : AuctionStatus.ACTIVE,
      startTime,
      endTime,
      items:     itemsMap,
      timers:    {},
    };

    this.auctions.set(auctionId, auction);
    this._scheduleEnding(auction);

    const snapshot = this._snapshotAuction(auction);
    if (this.db) {
      this.db.saveAuction(snapshot).catch(() => {});
    }

    console.log(`[AuctionEngine] Created auction "${title}" (${auctionId}) ` +
                `with ${items.length} items, ends in ${Math.round(duration / 1000)}s`);

    return snapshot;
  }

  getAuctionSnapshot(auctionId) {
    const auction = this.auctions.get(auctionId);
    if (!auction) return null;
    return this._snapshotAuction(auction);
  }

  listAuctions() {
    const list = [];
    for (const [id, a] of this.auctions) {
      let totalBids = 0;
      for (const [, item] of a.items) totalBids += item.totalBids;
      list.push({
        id,
        title:       a.title,
        status:      a.status,
        startTime:   a.startTime,
        endTime:     a.endTime,
        remainingMs: Math.max(0, a.endTime - Date.now()),
        itemCount:   a.items.size,
        bidderCount: this.cm.roomSize(id),
        totalBids,
      });
    }
    return list;
  }

  /** Rich telemetry view for the Admin Dashboard. */
  getDetailedAuctions() {
    const list = [];
    for (const [id, a] of this.auctions) {
      let totalBids  = 0;
      let gmv        = 0;
      let queueDepth = 0;
      const items    = [];

      for (const [itemId, item] of a.items) {
        totalBids += item.totalBids;
        const itemRevenue = item.stock > 1
          ? item.topBids.reduce((s, b) => s + b.amount, 0)
          : (item.currentBidder ? item.currentBid : 0);
        gmv += itemRevenue;

        const q = this._bidQueues.get(`${id}:${itemId}`);
        const qDepth = q ? q.depth : 0;
        queueDepth += qDepth;

        const upliftPct = item.startingPrice > 0 && item.totalBids > 0
          ? Number((((item.currentBid - item.startingPrice) / item.startingPrice) * 100).toFixed(1))
          : 0;

        items.push({
          id:            itemId,
          name:          item.name,
          stock:         item.stock,
          startingPrice: item.startingPrice,
          currentBid:    item.currentBid,
          cutoffBid:     item.cutoffBid,
          bidderName:    item.bidderName,
          filledSlots:   item.topBids.length,
          totalBids:     item.totalBids,
          upliftPct,
          queueDepth:    qDepth,
        });
      }

      list.push({
        id,
        title:       a.title,
        status:      a.status,
        startTime:   a.startTime,
        endTime:     a.endTime,
        remainingMs: Math.max(0, a.endTime - Date.now()),
        bidderCount: this.cm.roomSize(id),
        totalBids,
        gmv:         Number(gmv.toFixed(2)),
        queueDepth,
        items,
      });
    }
    return list;
  }

  // ── Admin Controls ────────────────────────────────────────────────────

  extendAuction(auctionId, extraSec = 30) {
    const auction = this.auctions.get(auctionId);
    if (!auction || auction.status === AuctionStatus.ENDED) return null;

    const addMs = Math.max(5, Number(extraSec) || 30) * 1000;
    auction.endTime += addMs;
    this._scheduleEnding(auction);

    const remainingMs = Math.max(0, auction.endTime - Date.now());
    this.cm.broadcast(auctionId, buildMessage(ServerMsg.ANTI_SNIPE_EXTENDED, {
      auctionId,
      extensionSec: Math.round(addMs / 1000),
      newEndTime:   auction.endTime,
      remainingMs,
      reason:       'ADMIN_EXTENDED',
    }));

    const snapshot = this._snapshotAuction(auction);
    if (this.db) this.db.updateAuction(snapshot).catch(() => {});
    return snapshot;
  }

  triggerFinalCountdown(auctionId, remainingSec = 10) {
    const auction = this.auctions.get(auctionId);
    if (!auction || auction.status === AuctionStatus.ENDED) return null;

    const sec = Math.max(3, Math.min(30, Number(remainingSec) || 10));
    const now = Date.now();
    auction.endTime = now + sec * 1000;
    auction.status  = AuctionStatus.ENDING;
    this._scheduleEnding(auction);

    this.cm.broadcast(auctionId, buildMessage(ServerMsg.AUCTION_COUNTDOWN, {
      auctionId,
      remainingMs: sec * 1000,
    }));

    const snapshot = this._snapshotAuction(auction);
    if (this.db) this.db.updateAuction(snapshot).catch(() => {});
    return snapshot;
  }

  endAuctionNow(auctionId) {
    const auction = this.auctions.get(auctionId);
    if (!auction) return null;
    if (auction.status !== AuctionStatus.ENDED) {
      this._endAuction(auction);
    }
    return this._snapshotAuction(auction);
  }

  // ── Bid Processing (the critical path) ────────────────────────────────

  async placeBid({ auctionId, itemId, amount, bidderId, bidderName, connectionId }) {
    const t0 = performance.now();

    // ── Pre-queue validation (fast reject) ───────────────────────────
    const auction = this.auctions.get(auctionId);
    if (!auction) {
      return this._rejectBid(connectionId, RejectReason.AUCTION_NOT_FOUND, amount, { itemId }, t0);
    }
    if (auction.status !== AuctionStatus.ACTIVE && auction.status !== AuctionStatus.ENDING) {
      return this._rejectBid(connectionId, RejectReason.AUCTION_NOT_ACTIVE, amount, { itemId }, t0);
    }
    const item = auction.items.get(itemId);
    if (!item) {
      return this._rejectBid(connectionId, RejectReason.ITEM_NOT_FOUND, amount, { itemId }, t0);
    }
    if (typeof amount !== 'number' || Number.isNaN(amount) || !Number.isFinite(amount) || amount <= 0) {
      return this._rejectBid(connectionId, RejectReason.INVALID_AMOUNT, amount, { itemId }, t0);
    }

    const queueKey = `${auctionId}:${itemId}`;
    const queue    = this._bidQueues.get(queueKey);
    if (!queue) {
      return this._rejectBid(connectionId, RejectReason.ITEM_NOT_FOUND, amount, { itemId }, t0);
    }

    await queue.enqueue(async () => {
      // ── ATOMIC SECTION — only one bid executes here at a time ────
      if (auction.status !== AuctionStatus.ACTIVE && auction.status !== AuctionStatus.ENDING) {
        return this._rejectBid(connectionId, RejectReason.AUCTION_NOT_ACTIVE, amount, { itemId }, t0);
      }

      if (item.stock <= 0) {
        return this._rejectBid(connectionId, RejectReason.OUT_OF_STOCK, amount, { itemId }, t0);
      }

      const now = Date.now();
      let evictedBidder = null;

      if (item.stock === 1) {
        if (item.currentBidder === bidderId) {
          return this._rejectBid(connectionId, RejectReason.OWN_BID, amount, { itemId }, t0);
        }

        const minRequired = item.currentBid + config.MIN_BID_INCREMENT;
        if (amount < minRequired) {
          return this._rejectBid(connectionId, RejectReason.BID_TOO_LOW, amount, {
            itemId,
            currentBid: item.currentBid,
            minRequired,
          }, t0);
        }

        if (item.currentBidder && item.currentBidder !== bidderId) {
          evictedBidder = item.currentBidder;
        }

        item.currentBid    = amount;
        item.cutoffBid     = amount;
        item.currentBidder = bidderId;
        item.bidderName    = bidderName;
        item.topBids       = [{ bidderId, bidderName, amount, timestamp: now }];
      } else {
        // Multi-unit limited-stock Top-K bidding
        if (item.topBids.some(b => b.bidderId === bidderId)) {
          return this._rejectBid(connectionId, RejectReason.OWN_BID, amount, { itemId }, t0);
        }

        const slotsFilled = item.topBids.length >= item.stock;
        const floorBid    = slotsFilled ? item.topBids[item.stock - 1].amount : item.startingPrice;
        const minRequired = floorBid + config.MIN_BID_INCREMENT;

        if (amount < minRequired) {
          return this._rejectBid(connectionId, RejectReason.BID_TOO_LOW, amount, {
            itemId,
            currentBid: floorBid,
            minRequired,
          }, t0);
        }

        item.topBids.push({ bidderId, bidderName, amount, timestamp: now });
        item.topBids.sort((a, b) => (b.amount - a.amount) || (a.timestamp - b.timestamp));

        if (item.topBids.length > item.stock) {
          const evicted = item.topBids.pop();
          if (evicted && evicted.bidderId !== bidderId) {
            evictedBidder = evicted.bidderId;
          }
        }

        item.currentBid    = item.topBids[0].amount;
        item.currentBidder = item.topBids[0].bidderId;
        item.bidderName    = item.topBids[0].bidderName;
        item.cutoffBid     = item.topBids.length >= item.stock
          ? item.topBids[item.stock - 1].amount
          : item.startingPrice;
      }

      item.totalBids += 1;
      item.version   += 1;

      const bidRecord = {
        bidderId,
        bidderName,
        amount,
        timestamp: now,
      };
      item.bidHistory.push(bidRecord);
      if (item.bidHistory.length > 20) {
        item.bidHistory.shift();
      }

      // ── Anti-snipe extension ───────────────────────────────────────
      let antiSnipeExtended = false;
      const remainingMs = auction.endTime - now;
      if (remainingMs > 0 && remainingMs <= config.ANTI_SNIPE_THRESHOLD_SEC * 1000) {
        auction.endTime += config.ANTI_SNIPE_EXTENSION_SEC * 1000;
        this._scheduleEnding(auction);
        antiSnipeExtended = true;

        if (this.analytics) this.analytics.recordAntiSnipe();

        this.cm.broadcast(auctionId, buildMessage(ServerMsg.ANTI_SNIPE_EXTENDED, {
          auctionId,
          extensionSec: config.ANTI_SNIPE_EXTENSION_SEC,
          newEndTime:   auction.endTime,
          remainingMs:  auction.endTime - Date.now(),
        }));

        if (config.VERBOSE_LOGS) {
          console.log(`[AuctionEngine] Anti-snipe: extended auction ${auctionId} by ${config.ANTI_SNIPE_EXTENSION_SEC}s`);
        }
      }

      const processingMs = performance.now() - t0;

      // ── Notify winning bidder ──────────────────────────────────────
      this.cm.send(connectionId, buildMessage(ServerMsg.BID_ACCEPTED, {
        auctionId,
        itemId,
        amount,
        version:      item.version,
        processingMs: Number(processingMs.toFixed(3)),
      }));

      // ── Notify evicted / outbid bidder directly ────────────────────
      if (evictedBidder) {
        this.cm.sendToBidder(evictedBidder, buildMessage(ServerMsg.OUTBID_ALERT, {
          auctionId,
          itemId,
          itemName:   item.name,
          newBid:     amount,
          cutoffBid:  item.cutoffBid,
          bidderName: item.bidderName,
        }), { critical: false });
      }

      // ── Broadcast update (direct for small rooms, coalesced at scale)
      const updatePayload = {
        auctionId,
        itemId,
        itemName:      item.name,
        currentBid:    item.currentBid,
        cutoffBid:     item.cutoffBid,
        stock:         item.stock,
        currentBidder: item.currentBidder,
        bidderName:    item.bidderName,
        topBids:       item.topBids.map(b => ({ bidderId: b.bidderId, bidderName: b.bidderName, amount: b.amount })),
        totalBids:     item.totalBids,
        version:       item.version,
        lastBid:       bidRecord,
        remainingMs:   Math.max(0, auction.endTime - Date.now()),
      };

      this._publishBidUpdate(auctionId, updatePayload);

      // ── Telemetry & Write-Behind DB ────────────────────────────────
      if (this.analytics) {
        this.analytics.recordBidAccepted({
          auctionId,
          auctionTitle: auction.title,
          itemId,
          itemName:     item.name,
          bidderId,
          bidderName,
          amount,
          processingMs,
        });
      }

      if (this.db) {
        this.db.enqueueBid({
          auctionId,
          itemId,
          itemName: item.name,
          bidderId,
          bidderName,
          amount,
          version:  item.version,
          processingMs,
          timestamp: now,
        });
        if (antiSnipeExtended) {
          this.db.updateAuction(this._snapshotAuction(auction)).catch(() => {});
        }
      }

      if (config.VERBOSE_LOGS) {
        console.log(`[AuctionEngine] Bid accepted: ${bidderName} bid $${amount.toFixed(2)} on "${item.name}" (${item.totalBids} total bids)`);
      }
    });
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  _publishBidUpdate(auctionId, updatePayload) {
    const useBatching = config.BROADCAST_BATCH_INTERVAL_MS > 0 && this.cm.roomSize(auctionId) >= 25;
    if (!useBatching) {
      this.cm.broadcast(auctionId, buildMessage(ServerMsg.BID_UPDATE, updatePayload), null, { critical: false });
      return;
    }

    if (!this._broadcastBatches.has(auctionId)) {
      this._broadcastBatches.set(auctionId, new Map());
    }
    this._broadcastBatches.get(auctionId).set(updatePayload.itemId, updatePayload);

    if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => {
        this._batchTimer = null;
        this._flushBroadcastBatches();
      }, config.BROADCAST_BATCH_INTERVAL_MS);
    }
  }

  _flushBroadcastBatches() {
    for (const [auctionId, itemMap] of this._broadcastBatches) {
      if (itemMap.size === 0) continue;
      const updates = Array.from(itemMap.values());
      if (updates.length === 1) {
        this.cm.broadcast(
          auctionId,
          buildMessage(ServerMsg.BID_UPDATE, updates[0]),
          null,
          { critical: false }
        );
      } else {
        const auction = this.auctions.get(auctionId);
        this.cm.broadcast(
          auctionId,
          buildMessage(ServerMsg.BID_BATCH_UPDATE, {
            auctionId,
            updates,
            remainingMs: auction ? Math.max(0, auction.endTime - Date.now()) : 0,
          }),
          null,
          { critical: false }
        );
      }
    }
    this._broadcastBatches.clear();
  }

  _rejectBid(connectionId, reason, amount, extra = {}, t0 = null) {
    if (this.analytics) {
      const processingMs = t0 !== null ? performance.now() - t0 : 0;
      this.analytics.recordBidRejected({ reason, processingMs });
    }
    this.cm.send(connectionId, buildMessage(ServerMsg.BID_REJECTED, {
      reason,
      amount,
      ...extra,
    }));
  }

  _scheduleEnding(auction) {
    if (auction.timers.countdownTimeout) clearTimeout(auction.timers.countdownTimeout);
    if (auction.timers.countdown)        clearInterval(auction.timers.countdown);
    if (auction.timers.end)              clearTimeout(auction.timers.end);

    const now       = Date.now();
    const remaining = auction.endTime - now;

    if (remaining <= 0) {
      this._endAuction(auction);
      return;
    }

    const startCountdownLoop = () => {
      auction.status = AuctionStatus.ENDING;
      if (auction.timers.countdown) clearInterval(auction.timers.countdown);
      auction.timers.countdown = setInterval(() => {
        const left = auction.endTime - Date.now();
        if (left <= 0) {
          clearInterval(auction.timers.countdown);
          return;
        }
        const msg = buildMessage(ServerMsg.AUCTION_COUNTDOWN, {
          auctionId:   auction.id,
          remainingMs: left,
        });
        this.cm.broadcast(auction.id, msg, null, { critical: false });
      }, config.COUNTDOWN_BROADCAST_INTERVAL_MS);
    };

    const countdownStart = remaining - 30000;
    if (countdownStart <= 0) {
      startCountdownLoop();
    } else {
      auction.status = AuctionStatus.ACTIVE;
      auction.timers.countdownTimeout = setTimeout(startCountdownLoop, countdownStart);
    }

    auction.timers.end = setTimeout(() => {
      this._endAuction(auction);
    }, remaining);
  }

  _endAuction(auction) {
    if (auction.status === AuctionStatus.ENDED) return;
    auction.status = AuctionStatus.ENDED;

    if (auction.timers.countdown)        clearInterval(auction.timers.countdown);
    if (auction.timers.countdownTimeout) clearTimeout(auction.timers.countdownTimeout);
    if (auction.timers.end)              clearTimeout(auction.timers.end);

    // Flush any pending updates before closing
    if (this._broadcastBatches.has(auction.id)) {
      this._flushBroadcastBatches();
    }

    const winners = [];
    for (const [itemId, item] of auction.items) {
      if (item.stock > 1 && item.topBids.length > 0) {
        item.topBids.forEach((slot, idx) => {
          winners.push({
            itemId,
            itemName:   item.name,
            unitNumber: idx + 1,
            winningBid: slot.amount,
            winnerId:   slot.bidderId,
            winnerName: slot.bidderName,
            totalBids:  item.totalBids,
          });
        });
      } else if (item.currentBidder) {
        winners.push({
          itemId,
          itemName:   item.name,
          unitNumber: 1,
          winningBid: item.currentBid,
          winnerId:   item.currentBidder,
          winnerName: item.bidderName,
          totalBids:  item.totalBids,
        });
      }
    }

    const msg = buildMessage(ServerMsg.AUCTION_ENDED, {
      auctionId: auction.id,
      title:     auction.title,
      winners,
    });
    this.cm.broadcast(auction.id, msg);

    if (this.db) {
      const snapshot = this._snapshotAuction(auction);
      this.db.updateAuction(snapshot).catch(() => {});
      this.db.saveWinners(auction.id, auction.title, winners).catch(() => {});
    }

    console.log(`[AuctionEngine] Auction "${auction.title}" ended. Winners: ${winners.length}`);

    for (const [itemId] of auction.items) {
      this._bidQueues.delete(`${auction.id}:${itemId}`);
    }
  }

  _snapshotAuction(auction) {
    const items = [];
    for (const [itemId, item] of auction.items) {
      items.push({
        id:            itemId,
        name:          item.name,
        description:   item.description,
        imageUrl:      item.imageUrl,
        startingPrice: item.startingPrice,
        currentBid:    item.currentBid,
        cutoffBid:     item.cutoffBid,
        currentBidder: item.currentBidder,
        bidderName:    item.bidderName,
        stock:         item.stock,
        topBids:       item.topBids.map(b => ({ bidderId: b.bidderId, bidderName: b.bidderName, amount: b.amount })),
        totalBids:     item.totalBids,
        bidHistory:    item.bidHistory.slice(-10),
        version:       item.version,
      });
    }

    return {
      id:          auction.id,
      title:       auction.title,
      status:      auction.status,
      startTime:   auction.startTime,
      endTime:     auction.endTime,
      remainingMs: Math.max(0, auction.endTime - Date.now()),
      items,
      bidderCount: this.cm.roomSize(auction.id),
    };
  }

  shutdown() {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
    }
    this._broadcastBatches.clear();

    for (const [, auction] of this.auctions) {
      if (auction.status === AuctionStatus.ACTIVE || auction.status === AuctionStatus.ENDING) {
        this._endAuction(auction);
      }
    }
  }
}

module.exports = AuctionEngine;
