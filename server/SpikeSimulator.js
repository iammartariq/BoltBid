// ============================================================================
// server/SpikeSimulator.js — Admin-Controlled Flash Spike Simulator
// ============================================================================
// Generates high-concurrency virtual bidders inside the server process to
// test the atomic per-item queues, rate limiter, anti-sniping logic, and
// real-time Admin/User dashboards on demand.
// ============================================================================

'use strict';

const { AuctionStatus } = require('../shared/protocol');

class SpikeSimulator {
  /**
   * @param {import('./AuctionEngine')} auctionEngine
   * @param {import('./RateLimiter')} rateLimiter
   */
  constructor(auctionEngine, rateLimiter) {
    this.engine = auctionEngine;
    this.rl     = rateLimiter;

    this._running      = false;
    this._auctionId    = null;
    this._bidders      = 0;
    this._bidsSent     = 0;
    this._startedAt    = null;
    this._endsAt       = null;
    this._tickTimer    = null;
    this._stopTimer    = null;
    this._simConnIds   = [];
  }

  getStatus() {
    return {
      running:        this._running,
      auctionId:      this._auctionId,
      virtualBidders: this._bidders,
      bidsSent:       this._bidsSent,
      startedAt:      this._startedAt,
      endsAt:         this._endsAt,
    };
  }

  start({ auctionId, bidders = 250, durationSec = 15, jumpToFinal10s = true, bidIntervalMs = 200 } = {}) {
    if (this._running) {
      this.stop();
    }

    let snapshot = auctionId ? this.engine.getAuctionSnapshot(auctionId) : null;
    if (!snapshot) {
      const active = this.engine.listAuctions().find(
        a => a.status === AuctionStatus.ACTIVE || a.status === AuctionStatus.ENDING
      );
      if (!active) {
        return { error: 'No active auction available to simulate.' };
      }
      snapshot = this.engine.getAuctionSnapshot(active.id);
    }

    if (snapshot.status === AuctionStatus.ENDED || snapshot.items.length === 0) {
      return { error: 'Target auction has already ended or has no items.' };
    }

    const count    = Math.max(10, Math.min(5000, parseInt(bidders, 10) || 250));
    const durMs    = Math.max(2, Math.min(60, parseInt(durationSec, 10) || 15)) * 1000;
    const interval = Math.max(50, Math.min(1000, parseInt(bidIntervalMs, 10) || 200));

    if (jumpToFinal10s) {
      this.engine.triggerFinalCountdown(snapshot.id, 10);
    }

    this._running   = true;
    this._auctionId = snapshot.id;
    this._bidders   = count;
    this._bidsSent  = 0;
    this._startedAt = Date.now();
    this._endsAt    = this._startedAt + durMs;
    this._simConnIds = [];

    for (let i = 0; i < count; i++) {
      const simId = `sim-${this._startedAt}-${i}`;
      this._simConnIds.push(simId);
      this.rl.register(simId);
    }

    const botsPerTick = Math.max(5, Math.ceil(count / 8));
    let cursor = 0;

    this._tickTimer = setInterval(() => {
      if (!this._running) return;
      const currentSnap = this.engine.getAuctionSnapshot(this._auctionId);
      if (!currentSnap || currentSnap.status === AuctionStatus.ENDED) {
        this.stop();
        return;
      }

      const items = currentSnap.items;
      for (let k = 0; k < botsPerTick; k++) {
        const botIdx  = cursor % count;
        cursor++;

        const simId   = this._simConnIds[botIdx];
        const rlCheck = this.rl.allow(simId);
        if (!rlCheck.allowed) {
          if (this.engine.analytics) this.engine.analytics.recordRateLimited();
          continue;
        }

        const item = items[Math.floor(Math.random() * items.length)];
        // Mix realistic competitive increments and occasional stale/low bids
        const delta = Math.random() < 0.85
          ? (Math.floor(Math.random() * 15) + 1)
          : 0;
        const basePrice = item.stock > 1 ? Math.max(item.cutoffBid, item.startingPrice) : item.currentBid;
        const amount    = Number((basePrice + delta).toFixed(2));

        this._bidsSent += 1;
        this.engine.placeBid({
          auctionId:    this._auctionId,
          itemId:       item.id,
          amount,
          bidderId:     simId,
          bidderName:   `SimBot-${botIdx + 1}`,
          connectionId: simId,
        }).catch(() => {});
      }
    }, interval);

    this._stopTimer = setTimeout(() => {
      this.stop();
    }, durMs);

    return this.getStatus();
  }

  stop() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._stopTimer) {
      clearTimeout(this._stopTimer);
      this._stopTimer = null;
    }

    for (const simId of this._simConnIds) {
      this.rl.unregister(simId);
    }
    this._simConnIds = [];
    this._running    = false;

    return this.getStatus();
  }
}

module.exports = SpikeSimulator;
