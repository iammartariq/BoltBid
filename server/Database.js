// ============================================================================
// server/Database.js — Async Write-Behind Persistence (Supabase + Local JSON)
// ============================================================================
// Persists auctions, items, accepted bids, winners, and analytics snapshots
// without ever blocking the atomic in-memory bidding hot path.
//
// Modes:
//   1. Supabase mode: Activated automatically when SUPABASE_URL & SUPABASE_KEY
//      are configured. Uses native Node fetch() against Supabase PostgREST.
//   2. Local JSON mode: Zero-config fallback writing to data/store.json so
//      the full application, history, and analytics work out-of-the-box.
// ============================================================================

'use strict';

const fs   = require('fs');
const path = require('path');
const config = require('./config');

class Database {
  /**
   * @param {object} [opts]
   * @param {string} [opts.supabaseUrl]
   * @param {string} [opts.supabaseKey]
   * @param {string} [opts.dataDir]
   * @param {boolean} [opts.disableTimers]
   */
  constructor(opts = {}) {
    this.supabaseUrl = (opts.supabaseUrl !== undefined ? opts.supabaseUrl : config.SUPABASE_URL).replace(/\/+$/, '');
    this.supabaseKey = opts.supabaseKey !== undefined ? opts.supabaseKey : config.SUPABASE_KEY;
    this.dataDir     = opts.dataDir || config.DATA_DIR;
    this.storePath   = path.join(this.dataDir, 'store.json');
    this.disableTimers = Boolean(opts.disableTimers);

    this.mode        = (this.supabaseUrl && this.supabaseKey) ? 'supabase' : 'local';
    this.connected   = false;
    this.lastError   = null;
    this.totalPersistedBids = 0;
    this._profilesWarned = false;

    // Write-behind bid queue
    this._bidQueue    = [];
    this._flushing    = false;
    this._flushTimer  = null;
    this._flushBatchSize = 100;
    this._flushIntervalMs = 1000;

    // In-memory mirror for local mode & fast history queries
    this._store = {
      auctions: [],
      bids:     [],
      winners:  [],
      snapshots: [],
      users:    [],
    };
  }

  /** Initialise persistence backend and start write-behind flush timer. */
  async init() {
    if (this.mode === 'supabase') {
      try {
        const res = await this._supabaseRequest('GET', '/rest/v1/auctions?select=id&limit=1');
        if (res.ok) {
          this.connected = true;
          this.lastError = null;
          console.log('[Database] Connected to Supabase PostgREST persistence.');
        } else {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
      } catch (err) {
        this.lastError = `Supabase unreachable (${err.message}); falling back to local JSON store`;
        console.warn(`[Database] ${this.lastError}`);
        this.mode = 'local';
      }
    }

    if (this.mode === 'local') {
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
        if (fs.existsSync(this.storePath)) {
          const raw = fs.readFileSync(this.storePath, 'utf8');
          const parsed = JSON.parse(raw);
          this._store = {
            auctions:  Array.isArray(parsed.auctions)  ? parsed.auctions  : [],
            bids:      Array.isArray(parsed.bids)      ? parsed.bids      : [],
            winners:   Array.isArray(parsed.winners)   ? parsed.winners   : [],
            snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
            users:     Array.isArray(parsed.users)     ? parsed.users     : [],
          };
          this.totalPersistedBids = this._store.bids.length;
        } else {
          this._writeLocalStoreSync();
        }
        this.connected = true;
        console.log(`[Database] Using local JSON store at ${this.storePath}`);
      } catch (err) {
        this.connected = false;
        this.lastError = err.message;
        console.error('[Database] Failed to initialise local store:', err.message);
      }
    }

    if (!this.disableTimers && !this._flushTimer) {
      this._flushTimer = setInterval(() => {
        this.flush().catch(err => {
          this.lastError = err.message;
        });
      }, this._flushIntervalMs);
      if (typeof this._flushTimer.unref === 'function') {
        this._flushTimer.unref();
      }
    }
  }

  /** Connection and queue health metadata for /health and Admin Dashboard. */
  getStatus() {
    return {
      mode:               this.mode,
      connected:          this.connected,
      pendingWrites:      this._bidQueue.length,
      totalPersistedBids: this.totalPersistedBids,
      lastError:          this.lastError,
    };
  }

  /** Persist a newly created auction + its items asynchronously. */
  async saveAuction(snapshot) {
    if (!snapshot) return;

    const auctionRow = {
      id:         snapshot.id,
      title:      snapshot.title,
      status:     snapshot.status,
      start_time: new Date(snapshot.startTime).toISOString(),
      end_time:   new Date(snapshot.endTime).toISOString(),
      total_bids: 0,
      total_gmv:  0,
    };

    const itemRows = (snapshot.items || []).map(item => ({
      id:             item.id,
      auction_id:     snapshot.id,
      name:           item.name,
      description:    item.description || '',
      starting_price: item.startingPrice,
      current_bid:    item.currentBid,
      cutoff_bid:     item.cutoffBid || item.startingPrice,
      stock:          item.stock || 1,
      total_bids:     item.totalBids || 0,
      winner_name:    item.bidderName || null,
    }));

    this._upsertLocalAuction(snapshot);

    if (this.mode === 'supabase') {
      try {
        await this._supabaseRequest('POST', '/rest/v1/auctions', auctionRow, {
          Prefer: 'resolution=merge-duplicates',
        });
        if (itemRows.length > 0) {
          await this._supabaseRequest('POST', '/rest/v1/auction_items', itemRows, {
            Prefer: 'resolution=merge-duplicates',
          });
        }
      } catch (err) {
        this.lastError = err.message;
      }
    } else {
      await this._writeLocalStoreAsync();
    }
  }

  /** Update auction metadata (status, endTime, totals) asynchronously. */
  async updateAuction(snapshot) {
    if (!snapshot) return;
    this._upsertLocalAuction(snapshot);

    if (this.mode === 'supabase') {
      try {
        const totalBids = (snapshot.items || []).reduce((s, i) => s + (i.totalBids || 0), 0);
        const totalGmv  = (snapshot.items || []).reduce((s, i) => {
          if (!i.currentBidder) return s;
          return s + (i.currentBid || 0);
        }, 0);

        await this._supabaseRequest(
          'PATCH',
          `/rest/v1/auctions?id=eq.${encodeURIComponent(snapshot.id)}`,
          {
            status:     snapshot.status,
            end_time:   new Date(snapshot.endTime).toISOString(),
            total_bids: totalBids,
            total_gmv:  Number(totalGmv.toFixed(2)),
            updated_at: new Date().toISOString(),
          }
        );

        for (const item of snapshot.items || []) {
          await this._supabaseRequest(
            'PATCH',
            `/rest/v1/auction_items?id=eq.${encodeURIComponent(item.id)}`,
            {
              current_bid: item.currentBid,
              cutoff_bid:  item.cutoffBid || item.startingPrice,
              total_bids:  item.totalBids || 0,
              winner_name: item.bidderName || null,
              updated_at:  new Date().toISOString(),
            }
          );
        }
      } catch (err) {
        this.lastError = err.message;
      }
    } else {
      await this._writeLocalStoreAsync();
    }
  }

  /**
   * Queue an accepted bid for batched write-behind persistence.
   * Synchronous/non-blocking for the atomic bid loop.
   */
  enqueueBid(bidRecord) {
    this._bidQueue.push({
      auction_id:    bidRecord.auctionId,
      item_id:       bidRecord.itemId,
      item_name:     bidRecord.itemName,
      bidder_id:     bidRecord.bidderId,
      bidder_name:   bidRecord.bidderName,
      amount:        bidRecord.amount,
      version:       bidRecord.version,
      processing_ms: Number((bidRecord.processingMs || 0).toFixed(3)),
      created_at:    new Date(bidRecord.timestamp || Date.now()).toISOString(),
    });

    // Cap in-memory queue under extreme sustained outage to protect heap
    if (this._bidQueue.length > 20000) {
      this._bidQueue.splice(0, this._bidQueue.length - 20000);
    }

    if (this._bidQueue.length >= this._flushBatchSize && !this._flushing) {
      this.flush().catch(() => {});
    }
  }

  /** Persist final auction winners (supports multi-unit limited stock). */
  async saveWinners(auctionId, auctionTitle, winners) {
    if (!winners || winners.length === 0) return;

    const rows = winners.map(w => ({
      auction_id:    auctionId,
      auction_title: auctionTitle,
      item_id:       w.itemId,
      item_name:     w.itemName,
      unit_number:   w.unitNumber || 1,
      winner_id:     w.winnerId,
      winner_name:   w.winnerName,
      winning_bid:   w.winningBid,
      total_bids:    w.totalBids || 0,
      ended_at:      new Date().toISOString(),
    }));

    this._store.winners.unshift(...rows);
    if (this._store.winners.length > 250) {
      this._store.winners.length = 250;
    }

    if (this.mode === 'supabase') {
      try {
        await this._supabaseRequest('POST', '/rest/v1/auction_winners', rows);
      } catch (err) {
        this.lastError = err.message;
      }
    } else {
      await this._writeLocalStoreAsync();
    }
  }

  /** Save periodic analytics snapshot. */
  async saveAnalyticsSnapshot(snap) {
    if (!snap) return;
    const row = {
      active_connections: snap.activeConnections || 0,
      bids_per_sec:       snap.bidsPerSec || 0,
      total_accepted:     snap.totalAccepted || 0,
      total_rejected:     snap.totalRejected || 0,
      total_rate_limited: snap.totalRateLimited || 0,
      p95_latency_ms:     snap.p95LatencyMs || 0,
      heap_used_mb:       snap.heapUsedMB || 0,
      created_at:         new Date().toISOString(),
    };

    this._store.snapshots.push(row);
    if (this._store.snapshots.length > 120) {
      this._store.snapshots.shift();
    }

    if (this.mode === 'supabase') {
      try {
        await this._supabaseRequest('POST', '/rest/v1/analytics_snapshots', row);
      } catch (err) {
        this.lastError = err.message;
      }
    }
  }

  /** Flush queued bid records to Supabase or local store. */
  async flush() {
    if (this._flushing || this._bidQueue.length === 0) return;
    this._flushing = true;

    try {
      while (this._bidQueue.length > 0) {
        const batch = this._bidQueue.splice(0, this._flushBatchSize);

        // Keep recent 500 bids in local mirror for quick UI hydration
        this._store.bids.unshift(...batch.slice().reverse());
        if (this._store.bids.length > 500) {
          this._store.bids.length = 500;
        }
        this.totalPersistedBids += batch.length;

        if (this.mode === 'supabase') {
          const res = await this._supabaseRequest('POST', '/rest/v1/bids', batch);
          if (!res.ok) {
            const text = await res.text();
            this.lastError = `Supabase bid flush failed (${res.status}): ${text}`;
          } else {
            this.lastError = null;
          }
        } else {
          await this._writeLocalStoreAsync();
          this.lastError = null;
        }
      }
    } catch (err) {
      this.lastError = err.message;
    } finally {
      this._flushing = false;
    }
  }

  /** Retrieve recent persisted bids. */
  async getRecentBids(limit = 50) {
    if (this.mode === 'supabase') {
      try {
        const res = await this._supabaseRequest(
          'GET',
          `/rest/v1/bids?select=*&order=created_at.desc&limit=${limit}`
        );
        if (res.ok) return await res.json();
      } catch (err) {
        this.lastError = err.message;
      }
    }
    return this._store.bids.slice(0, limit);
  }

  /** Retrieve persisted winners history. */
  async getWinnersHistory(limit = 50) {
    if (this.mode === 'supabase') {
      try {
        const res = await this._supabaseRequest(
          'GET',
          `/rest/v1/auction_winners?select=*&order=ended_at.desc&limit=${limit}`
        );
        if (res.ok) return await res.json();
      } catch (err) {
        this.lastError = err.message;
      }
    }
    return this._store.winners.slice(0, limit);
  }

  /** Retrieve persisted auction summaries. */
  async getPersistedAuctions() {
    if (this.mode === 'supabase') {
      try {
        const res = await this._supabaseRequest(
          'GET',
          '/rest/v1/auctions?select=*&order=created_at.desc&limit=50'
        );
        if (res.ok) return await res.json();
      } catch (err) {
        this.lastError = err.message;
      }
    }
    return this._store.auctions.slice();
  }

  /**
   * Upsert a user profile into Supabase `public.profiles` (or local store).
   * Fails gracefully if `public.profiles` has not yet been created in Supabase.
   */
  async upsertUserProfile(profile) {
    if (!profile || !profile.id || !profile.email) return { synced: false };

    const nowIso = new Date().toISOString();
    const row = {
      id:            profile.id,
      email:         String(profile.email).trim().toLowerCase(),
      full_name:     String(profile.fullName || profile.email.split('@')[0]).trim(),
      avatar_url:    profile.avatarUrl || '',
      provider:      profile.provider === 'google' ? 'google' : 'email',
      role:          profile.role === 'admin' ? 'admin' : 'bidder',
      last_login_at: nowIso,
    };

    if (this.mode === 'supabase') {
      try {
        const res = await this._supabaseRequest('POST', '/rest/v1/profiles', row, {
          Prefer: 'resolution=merge-duplicates',
        });
        if (!res.ok) {
          const text = await res.text();
          if (!this._profilesWarned) {
            this._profilesWarned = true;
            console.warn(`[Database] Could not sync public.profiles (${res.status}): ${text}`);
          }
          return { synced: false };
        }
        return { synced: true };
      } catch (err) {
        if (!this._profilesWarned) {
          this._profilesWarned = true;
          console.warn('[Database] Profile sync warning:', err.message);
        }
        return { synced: false };
      }
    }

    const idx = this._store.users.findIndex(u => u.id === row.id || u.email.toLowerCase() === row.email);
    if (idx >= 0) {
      this._store.users[idx] = {
        ...this._store.users[idx],
        fullName:    row.full_name,
        avatarUrl:   row.avatar_url,
        provider:    row.provider,
        role:        row.role,
        lastLoginAt: nowIso,
      };
      await this._writeLocalStoreAsync();
    } else {
      this._store.users.push({
        id:          row.id,
        email:       row.email,
        fullName:    row.full_name,
        avatarUrl:   row.avatar_url,
        provider:    row.provider,
        role:        row.role,
        createdAt:   nowIso,
        lastLoginAt: nowIso,
      });
      await this._writeLocalStoreAsync();
    }
    return { synced: true };
  }

  /** Retrieve user profile from Supabase `public.profiles` or local store. */
  async getUserProfile(userId) {
    if (!userId) return null;

    if (this.mode === 'supabase') {
      try {
        const res = await this._supabaseRequest(
          'GET',
          `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*&limit=1`
        );
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows[0]) {
            return {
              id:        rows[0].id,
              email:     rows[0].email,
              fullName:  rows[0].full_name,
              avatarUrl: rows[0].avatar_url || '',
              provider:  rows[0].provider || 'email',
              role:      rows[0].role || 'bidder',
            };
          }
        }
      } catch {
        // Fail gracefully if profiles table is unavailable
      }
      return null;
    }

    const local = this._store.users.find(u => u.id === userId);
    return local ? this._sanitizeLocalUser(local) : null;
  }

  /** Find a local-fallback user record by email (case-insensitive). */
  findLocalUserByEmail(email) {
    if (!email) return null;
    const normalized = String(email).trim().toLowerCase();
    return this._store.users.find(u => String(u.email || '').toLowerCase() === normalized) || null;
  }

  /** Persist a newly created local-fallback user record. */
  async saveLocalUser(userRecord) {
    this._store.users.push({
      id:           userRecord.id,
      email:        String(userRecord.email).trim().toLowerCase(),
      fullName:     userRecord.fullName,
      passwordHash: userRecord.passwordHash,
      passwordSalt: userRecord.passwordSalt,
      avatarUrl:    userRecord.avatarUrl || '',
      provider:     userRecord.provider || 'email',
      role:         userRecord.role || 'bidder',
      createdAt:    userRecord.createdAt || new Date().toISOString(),
      lastLoginAt:  userRecord.lastLoginAt || new Date().toISOString(),
    });
    await this._writeLocalStoreAsync();
  }

  /** Update lastLoginAt for a local-fallback user. */
  async updateLocalUserLogin(userId) {
    const user = this._store.users.find(u => u.id === userId);
    if (!user) return;
    user.lastLoginAt = new Date().toISOString();
    await this._writeLocalStoreAsync();
  }

  _sanitizeLocalUser(u) {
    return {
      id:        u.id,
      email:     u.email,
      fullName:  u.fullName,
      avatarUrl: u.avatarUrl || '',
      provider:  u.provider || 'email',
      role:      u.role || 'bidder',
    };
  }

  /** Flush pending writes and clear background timer. */
  async shutdown() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    await this.flush();
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  _upsertLocalAuction(snapshot) {
    const idx = this._store.auctions.findIndex(a => a.id === snapshot.id);
    const totalBids = (snapshot.items || []).reduce((s, i) => s + (i.totalBids || 0), 0);
    const record = {
      id:         snapshot.id,
      title:      snapshot.title,
      status:     snapshot.status,
      startTime:  snapshot.startTime,
      endTime:    snapshot.endTime,
      totalBids,
      itemsCount: (snapshot.items || []).length,
      updatedAt:  Date.now(),
    };

    if (idx >= 0) {
      this._store.auctions[idx] = record;
    } else {
      this._store.auctions.unshift(record);
      if (this._store.auctions.length > 100) {
        this._store.auctions.length = 100;
      }
    }
  }

  _writeLocalStoreSync() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify(this._store, null, 2), 'utf8');
  }

  async _writeLocalStoreAsync() {
    await fs.promises.mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.storePath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(this._store, null, 2), 'utf8');
    await fs.promises.rename(tmpPath, this.storePath);
  }

  async _supabaseRequest(method, pathAndQuery, body = null, extraHeaders = {}) {
    const headers = {
      apikey:         this.supabaseKey,
      Authorization:  `Bearer ${this.supabaseKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    const options = { method, headers };
    if (body !== null && method !== 'GET') {
      options.body = JSON.stringify(body);
    }
    return fetch(`${this.supabaseUrl}${pathAndQuery}`, options);
  }
}

module.exports = Database;
