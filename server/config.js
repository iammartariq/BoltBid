// ============================================================================
// server/config.js — Centralized Configuration
// ============================================================================
// All tunable parameters for the flash-auction engine. Values can be
// overridden via environment variables or a local .env file.
// ============================================================================

'use strict';

const fs   = require('fs');
const path = require('path');

// Lightweight zero-dependency .env loader (never overwrites existing env vars)
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val   = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore .env parsing errors so default config still boots cleanly
  }
})();

const config = {
  // ── Server ────────────────────────────────────────────────────────────
  PORT: parseInt(process.env.PORT, 10) || 8080,
  HOST: process.env.HOST || '0.0.0.0',

  // ── WebSocket ─────────────────────────────────────────────────────────
  WS_PATH: '/ws',
  // Maximum payload size per WebSocket frame (bytes)
  MAX_PAYLOAD: parseInt(process.env.MAX_PAYLOAD, 10) || 4096,
  // Heartbeat interval in ms — connections silent longer than this are pruned
  HEARTBEAT_INTERVAL_MS: parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10) || 10000,
  // Time to wait for pong before considering connection dead
  HEARTBEAT_TIMEOUT_MS: parseInt(process.env.HEARTBEAT_TIMEOUT_MS, 10) || 5000,
  // Maximum queued outbound bytes per socket before dropping non-critical updates
  MAX_WS_BACKPRESSURE_BYTES: parseInt(process.env.MAX_WS_BACKPRESSURE_BYTES, 10) || 65536,

  // ── Rate Limiter (Token Bucket) ───────────────────────────────────────
  // Max tokens (burst capacity) per connection
  RATE_LIMIT_BUCKET_SIZE: parseInt(process.env.RATE_LIMIT_BUCKET_SIZE, 10) || 10,
  // Tokens refilled per second
  RATE_LIMIT_REFILL_RATE: parseInt(process.env.RATE_LIMIT_REFILL_RATE, 10) || 5,

  // ── Auction ───────────────────────────────────────────────────────────
  // Default auction duration in seconds
  DEFAULT_AUCTION_DURATION_SEC: parseInt(process.env.DEFAULT_AUCTION_DURATION_SEC, 10) || 120,
  // Minimum bid increment (currency units)
  MIN_BID_INCREMENT: parseFloat(process.env.MIN_BID_INCREMENT) || 1.00,
  // Countdown broadcast interval in ms (last 30 seconds)
  COUNTDOWN_BROADCAST_INTERVAL_MS: parseInt(process.env.COUNTDOWN_BROADCAST_INTERVAL_MS, 10) || 250,
  // Anti-snipe extension: add seconds if bid placed in last N seconds
  ANTI_SNIPE_THRESHOLD_SEC: parseInt(process.env.ANTI_SNIPE_THRESHOLD_SEC, 10) || 5,
  ANTI_SNIPE_EXTENSION_SEC: parseInt(process.env.ANTI_SNIPE_EXTENSION_SEC, 10) || 10,

  // ── Connection Limits ─────────────────────────────────────────────────
  MAX_CONNECTIONS: parseInt(process.env.MAX_CONNECTIONS, 10) || 60000,
  MAX_CONNECTIONS_PER_IP: parseInt(process.env.MAX_CONNECTIONS_PER_IP, 10) || 50,
  // Allow localhost load-testing without hitting per-IP limits
  EXEMPT_LOOPBACK_IP_LIMIT: process.env.EXEMPT_LOOPBACK_IP_LIMIT !== 'false',

  // ── Broadcast Batching & Presence ─────────────────────────────────────
  // Coalesce bid-update broadcasts to reduce per-message overhead at 50k scale
  BROADCAST_BATCH_INTERVAL_MS: parseInt(process.env.BROADCAST_BATCH_INTERVAL_MS, 10) || 50,
  // Throttle room presence (bidderCount) broadcasts
  PRESENCE_BROADCAST_INTERVAL_MS: parseInt(process.env.PRESENCE_BROADCAST_INTERVAL_MS, 10) || 1000,

  // ── Admin & Persistence (Supabase + Local JSON Fallback) ──────────────
  ADMIN_KEY:                 process.env.ADMIN_KEY || '',
  ADMIN_USERNAME:            process.env.ADMIN_USERNAME || 'admin123',
  ADMIN_PASSWORD:            process.env.ADMIN_PASSWORD || 'admin456',
  SESSION_SECRET:            process.env.SESSION_SECRET || '',
  SUPABASE_URL:              process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  SUPABASE_ANON_KEY:         process.env.SUPABASE_ANON_KEY || '',
  SUPABASE_KEY:              process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '',
  DATA_DIR:                  process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  VERBOSE_LOGS:              process.env.VERBOSE_LOGS === 'true',
};

module.exports = config;
