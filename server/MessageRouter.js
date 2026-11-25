// ============================================================================
// server/MessageRouter.js — WebSocket Message Router
// ============================================================================
// Parses incoming WebSocket messages and dispatches them to the
// appropriate handler (join, bid, leave, admin telemetry, ping).
// ============================================================================

'use strict';

const { v4: uuidv4 } = require('uuid');
const config         = require('./config');
const { ClientMsg, ServerMsg, buildMessage, parseMessage } = require('../shared/protocol');

class MessageRouter {
  /**
   * @param {import('./AuctionEngine')}       auctionEngine
   * @param {import('./ConnectionManager')}   connectionManager
   * @param {import('./RateLimiter')}         rateLimiter
   * @param {import('./AnalyticsCollector')|null} [analytics]
   * @param {(() => object)|null}             [getAdminSnapshot]
   * @param {import('./AuthService')|null}    [authService]
   */
  constructor(auctionEngine, connectionManager, rateLimiter, analytics = null, getAdminSnapshot = null, authService = null) {
    this.engine           = auctionEngine;
    this.cm               = connectionManager;
    this.rl               = rateLimiter;
    this.analytics        = analytics;
    this.getAdminSnapshot = getAdminSnapshot;
    this.authService      = authService;
  }

  /**
   * Handle a raw WebSocket message from a connection.
   * @param {string} connectionId
   * @param {string|Buffer} raw
   */
  async handle(connectionId, raw) {
    this.cm.markAlive(connectionId);

    const msg = parseMessage(raw);
    if (!msg) {
      this.cm.send(connectionId, buildMessage(ServerMsg.ERROR, {
        message: 'Invalid message format. Expected JSON with a "type" field.',
      }));
      return;
    }

    // Rate limit check (exempt PING and SUBSCRIBE_ADMIN / UNSUBSCRIBE_ADMIN)
    if (msg.type !== ClientMsg.PING &&
        msg.type !== ClientMsg.SUBSCRIBE_ADMIN &&
        msg.type !== ClientMsg.UNSUBSCRIBE_ADMIN) {
      const rlResult = this.rl.allow(connectionId);
      if (!rlResult.allowed) {
        if (this.analytics) this.analytics.recordRateLimited();
        this.cm.send(connectionId, buildMessage(ServerMsg.RATE_LIMITED, {
          retryAfterMs: rlResult.retryAfterMs,
          message:      'Too many requests. Please slow down.',
        }));
        return;
      }
    }

    switch (msg.type) {
      case ClientMsg.JOIN_AUCTION:
        await this._handleJoin(connectionId, msg);
        break;

      case ClientMsg.LEAVE_AUCTION:
        this._handleLeave(connectionId);
        break;

      case ClientMsg.PLACE_BID:
        await this._handleBid(connectionId, msg);
        break;

      case ClientMsg.SUBSCRIBE_ADMIN:
        this._handleSubscribeAdmin(connectionId, msg);
        break;

      case ClientMsg.UNSUBSCRIBE_ADMIN:
        this.cm.unsubscribeAdmin(connectionId);
        break;

      case ClientMsg.PING:
        this.cm.send(connectionId, buildMessage(ServerMsg.PONG, {
          clientTs: msg.clientTs || msg.ts || null,
        }));
        break;

      default:
        this.cm.send(connectionId, buildMessage(ServerMsg.ERROR, {
          message: `Unknown message type: "${msg.type}"`,
        }));
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────

  async _handleJoin(connectionId, msg) {
    const { auctionId, bidderName } = msg;

    if (!auctionId || !bidderName || typeof bidderName !== 'string') {
      this.cm.send(connectionId, buildMessage(ServerMsg.ERROR, {
        message: 'JOIN_AUCTION requires "auctionId" and "bidderName".',
      }));
      return;
    }

    const cleanName = bidderName.trim().slice(0, 32);
    if (!cleanName) {
      this.cm.send(connectionId, buildMessage(ServerMsg.ERROR, {
        message: 'Bidder name cannot be empty.',
      }));
      return;
    }

    const snapshot = this.engine.getAuctionSnapshot(auctionId);
    if (!snapshot) {
      this.cm.send(connectionId, buildMessage(ServerMsg.ERROR, {
        message: `Auction "${auctionId}" not found.`,
      }));
      return;
    }

    const conn     = this.cm.get(connectionId);
    const bidderId = conn?.userSession?.sub || uuidv4();
    this.cm.joinRoom(connectionId, auctionId, bidderId, cleanName);

    const bidderCount = this.cm.roomSize(auctionId);
    snapshot.bidderCount = bidderCount;

    this.cm.send(connectionId, buildMessage(ServerMsg.AUCTION_STATE, {
      auction: snapshot,
      bidderId,
      bidderCount,
    }));

    if (config.VERBOSE_LOGS) {
      console.log(`[Router] ${cleanName} joined auction "${snapshot.title}" (${bidderCount} bidders)`);
    }
  }

  _handleLeave(connectionId) {
    const conn = this.cm.get(connectionId);
    if (!conn || !conn.auctionId) return;
    this.cm.leaveRoom(connectionId);
  }

  _handleSubscribeAdmin(connectionId, msg) {
    const conn            = this.cm.get(connectionId);
    const hasAdminSession = Boolean(conn?.isAuthenticatedAdmin);
    const hasAdminToken   = Boolean(this.authService && msg.adminToken && this.authService.verifyToken(msg.adminToken, 'admin'));
    const hasAdminKey     = Boolean(config.ADMIN_KEY && msg.adminKey === config.ADMIN_KEY);

    if (!hasAdminSession && !hasAdminToken && !hasAdminKey) {
      this.cm.send(connectionId, buildMessage(ServerMsg.ERROR, {
        message: 'Unauthorized admin telemetry subscription.',
      }));
      return;
    }

    this.cm.subscribeAdmin(connectionId);
    if (this.getAdminSnapshot) {
      this.cm.send(connectionId, buildMessage(ServerMsg.ADMIN_METRICS, {
        metrics: this.getAdminSnapshot(),
      }));
    }
  }

  async _handleBid(connectionId, msg) {
    const conn = this.cm.get(connectionId);
    if (!conn || !conn.auctionId) {
      if (this.analytics) this.analytics.recordBidRejected({ reason: 'NOT_JOINED', processingMs: 0 });
      this.cm.send(connectionId, buildMessage(ServerMsg.BID_REJECTED, {
        reason:  'NOT_JOINED',
        itemId:  msg.itemId || null,
        message: 'You must join an auction before placing bids.',
      }));
      return;
    }

    const { itemId, amount } = msg;
    if (!itemId || typeof amount !== 'number' || Number.isNaN(amount)) {
      this.cm.send(connectionId, buildMessage(ServerMsg.ERROR, {
        message: 'PLACE_BID requires "itemId" (string) and "amount" (number).',
      }));
      return;
    }

    await this.engine.placeBid({
      auctionId:    conn.auctionId,
      itemId,
      amount:       parseFloat(amount.toFixed(2)),
      bidderId:     conn.bidderId,
      bidderName:   conn.bidderName,
      connectionId,
    });
  }
}

module.exports = MessageRouter;
