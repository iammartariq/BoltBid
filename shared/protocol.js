// ============================================================================
// shared/protocol.js — WebSocket Message Protocol
// ============================================================================
// Defines every message type exchanged between client and server.
// Both sides import this module so the protocol stays in sync.
// ============================================================================

'use strict';

// ── Client → Server message types ──────────────────────────────────────────
const ClientMsg = Object.freeze({
  /** Register a bidder and join an auction room */
  JOIN_AUCTION:      'JOIN_AUCTION',
  /** Leave the current auction room */
  LEAVE_AUCTION:     'LEAVE_AUCTION',
  /** Place a bid on an item */
  PLACE_BID:         'PLACE_BID',
  /** Client heartbeat (keep-alive) */
  PING:              'PING',
  /** Admin dashboard live telemetry subscription */
  SUBSCRIBE_ADMIN:   'SUBSCRIBE_ADMIN',
  /** Unsubscribe from admin telemetry */
  UNSUBSCRIBE_ADMIN: 'UNSUBSCRIBE_ADMIN',
});

// ── Server → Client message types ──────────────────────────────────────────
const ServerMsg = Object.freeze({
  /** Full auction state snapshot after joining */
  AUCTION_STATE:       'AUCTION_STATE',
  /** A new bid was accepted (broadcast to room) */
  BID_UPDATE:          'BID_UPDATE',
  /** Coalesced batch of bid updates during high concurrency */
  BID_BATCH_UPDATE:    'BID_BATCH_UPDATE',
  /** Confirmation sent only to the bidder whose bid was accepted */
  BID_ACCEPTED:        'BID_ACCEPTED',
  /** Rejection sent only to the bidder whose bid failed validation */
  BID_REJECTED:        'BID_REJECTED',
  /** Notification sent to the bidder who was just outbid */
  OUTBID_ALERT:        'OUTBID_ALERT',
  /** Periodic countdown during the final seconds */
  AUCTION_COUNTDOWN:   'AUCTION_COUNTDOWN',
  /** Anti-snipe timer extension notification */
  ANTI_SNIPE_EXTENDED: 'ANTI_SNIPE_EXTENDED',
  /** Auction has ended — includes winners */
  AUCTION_ENDED:       'AUCTION_ENDED',
  /** Server-wide update when a new auction is created */
  AUCTION_LIST_UPDATE: 'AUCTION_LIST_UPDATE',
  /** Live analytics payload pushed to admin dashboard subscribers */
  ADMIN_METRICS:       'ADMIN_METRICS',
  /** Server heartbeat reply */
  PONG:                'PONG',
  /** Rate-limit warning */
  RATE_LIMITED:        'RATE_LIMITED',
  /** Generic error */
  ERROR:               'ERROR',
  /** Informational (e.g. welcome, connection count) */
  INFO:                'INFO',
});

// ── Bid rejection reasons ──────────────────────────────────────────────────
const RejectReason = Object.freeze({
  AUCTION_NOT_FOUND:    'AUCTION_NOT_FOUND',
  AUCTION_NOT_ACTIVE:   'AUCTION_NOT_ACTIVE',
  ITEM_NOT_FOUND:       'ITEM_NOT_FOUND',
  BID_TOO_LOW:          'BID_TOO_LOW',
  OUTBID:               'OUTBID',
  OWN_BID:              'OWN_BID',
  OUT_OF_STOCK:         'OUT_OF_STOCK',
  INVALID_AMOUNT:       'INVALID_AMOUNT',
  NOT_JOINED:           'NOT_JOINED',
});

// ── Auction status ─────────────────────────────────────────────────────────
const AuctionStatus = Object.freeze({
  PENDING:  'PENDING',
  ACTIVE:   'ACTIVE',
  ENDING:   'ENDING',   // last 10 seconds
  ENDED:    'ENDED',
});

// ── Helper: build a typed message ──────────────────────────────────────────
function buildMessage(type, payload = {}) {
  return JSON.stringify({ type, ts: Date.now(), ...payload });
}

// ── Helper: safely parse a message ─────────────────────────────────────────
function parseMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg.type !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}

module.exports = {
  ClientMsg,
  ServerMsg,
  RejectReason,
  AuctionStatus,
  buildMessage,
  parseMessage,
};
