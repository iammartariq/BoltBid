// ============================================================================
// server/RateLimiter.js — Token-Bucket Rate Limiter
// ============================================================================
// Each WebSocket connection gets its own bucket.  Prevents a single client
// from flooding the server with bids during the final seconds.
//
// Algorithm: Token Bucket
//   - Bucket starts full (bucketSize tokens).
//   - Each accepted message consumes 1 token.
//   - Tokens refill at refillRate per second (computed lazily on each call).
//   - If bucket is empty → message is rejected with RATE_LIMITED.
// ============================================================================

'use strict';

const config = require('./config');

class TokenBucket {
  /**
   * @param {number} bucketSize  - maximum burst capacity
   * @param {number} refillRate  - tokens added per second
   */
  constructor(bucketSize, refillRate) {
    this.bucketSize = bucketSize;
    this.refillRate = refillRate;
    this.tokens     = bucketSize;
    this.lastRefill = Date.now();
  }

  /** Lazily refill tokens based on elapsed time. */
  _refill() {
    const now     = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // seconds
    this.tokens   = Math.min(this.bucketSize, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  /**
   * Try to consume one token.
   * @returns {{ allowed: boolean, retryAfterMs?: number }}
   */
  consume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true };
    }
    // Calculate how long until 1 token is available
    const deficit      = 1 - this.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillRate) * 1000);
    return { allowed: false, retryAfterMs };
  }
}

// ── Per-connection rate limiter registry ────────────────────────────────────

class RateLimiter {
  constructor() {
    /** @type {Map<string, TokenBucket>} connectionId → bucket */
    this.buckets = new Map();
  }

  /**
   * Register a new connection.
   * @param {string} connectionId
   */
  register(connectionId) {
    this.buckets.set(
      connectionId,
      new TokenBucket(config.RATE_LIMIT_BUCKET_SIZE, config.RATE_LIMIT_REFILL_RATE)
    );
  }

  /**
   * Unregister a connection (cleanup).
   * @param {string} connectionId
   */
  unregister(connectionId) {
    this.buckets.delete(connectionId);
  }

  /**
   * Check whether a message from this connection is allowed.
   * @param {string} connectionId
   * @returns {{ allowed: boolean, retryAfterMs?: number }}
   */
  allow(connectionId) {
    const bucket = this.buckets.get(connectionId);
    if (!bucket) return { allowed: false, retryAfterMs: 1000 };
    return bucket.consume();
  }
}

module.exports = RateLimiter;
