# ⚡ BoltBid — Flash Auction Engine (Internet Computing CEP)

A high-performance **Progressive Web App (PWA)** and real-time flash-auction bidding engine engineered to handle **50,000 concurrent bidders** competing for limited-stock items in the critical final 10 seconds of an auction.

Designed specifically to eliminate the critical failure points of standard HTTP REST architectures:
- ❌ **Race conditions** & duplicate bid wins
- ❌ **Stale reads** from caching/polling lags
- ❌ **Server thread pool exhaustion** & socket crashes during traffic spikes

---

## 🌟 Core Features & Architecture

1. **Persistent WebSocket Protocol (`shared/protocol.js`):**
   - Zero-polling bi-directional streaming (`AUCTION_STATE`, `BID_UPDATE`, `BID_BATCH_UPDATE`, `OUTBID_ALERT`, `ANTI_SNIPE_EXTENDED`, `ADMIN_METRICS`).
   - Coalesced broadcast batching and `ws.bufferedAmount` backpressure protection for 50k scale.

2. **Atomic Serialized Queue Processing (`server/AuctionEngine.js`):**
   - Per-item FIFO `AsyncQueue` guarantees zero race conditions without global cross-item locking.
   - Supports both single-unit (`stock = 1`) and **multi-unit limited-stock Top-K winning slots** (`stock > 1`) with direct `OUTBID_ALERT` notifications.

3. **User Bidder Arena & Admin Analytics Dashboards (`client/`):**
   - **Bidder Arena (`/`)**: Real-time countdown, quick-bid chips (`+$1`, `+$10`, `+$50`, `+$100`), live bid history, WebSocket RTT latency indicator, multi-unit slot leaderboard, and auto-rejoin on reconnect.
   - **Admin Dashboard (`/admin`)**: Live WebSocket telemetry stream, 60-second rolling throughput & latency `<canvas>` charts, rejection breakdown, item uplift & top-bidder tables, auction lifecycle controls (`10s Rush`, `+30s`, `End`), new auction launcher, and a built-in **Final-10s Flash Spike Simulator**.

4. **Progressive Web App (PWA):**
   - Installable via `client/manifest.json`, vector + PNG icons (`client/icons/`), and offline-resilient Service Worker (`client/sw.js`).

5. **Database Persistence (`server/Database.js` & `supabase/schema.sql`):**
   - **Supabase PostgreSQL (PostgREST)** support via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY`) using async write-behind batching so DB I/O never blocks the bidding hot path.
   - **Zero-config local JSON fallback** (`data/store.json`) when Supabase credentials are not set.

---

## 📂 Project Structure

```
IC CEP 1/
├── package.json
├── .env.example                 # Environment configuration template
├── supabase/
│   └── schema.sql               # PostgreSQL tables & indexes for Supabase
├── docs/
│   └── ARCHITECTURE.md          # Technical analysis, scaling report & diagrams
├── shared/
│   └── protocol.js              # Typed WebSocket protocol messages & schemas
├── server/
│   ├── index.js                 # HTTP PWA server, REST/Admin APIs & WS bootstrap
│   ├── config.js                # Tunable parameters & .env loader
│   ├── AuctionEngine.js         # Core engine, per-item FIFO queues & batching
│   ├── ConnectionManager.js     # O(1) rooms, backpressure guard & presence sync
│   ├── MessageRouter.js         # Incoming frame validation & dispatch
│   ├── RateLimiter.js           # Token bucket rate limiter per connection
│   ├── AnalyticsCollector.js    # Real-time KPIs, p50/p95/p99 latency & time-series
│   ├── Database.js              # Write-behind Supabase + local JSON persistence
│   └── SpikeSimulator.js        # Admin-controlled concurrent bidder simulator
├── client/
│   ├── index.html / app.js / styles.css   # User Bidder Arena PWA
│   ├── admin.html / admin.js / admin.css  # Admin Analytics & Operations Dashboard
│   ├── manifest.json / sw.js              # PWA manifest & Service Worker
│   └── icons/                             # App icons (SVG + 192px/512px PNG)
└── tests/
    ├── auctionEngine.test.js    # Unit, concurrency, anti-snipe, DB & analytics tests
    └── loadTest.js              # Simulated high-concurrency WebSocket load test
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher (tested on v22+)
- **npm**: v9.0.0 or higher

### 2. Installation & Run
```bash
npm install
npm start
```
By default, the server runs on `http://localhost:8080`:
- **User Bidder Arena (PWA)**: `http://localhost:8080/`
- **Admin Analytics Dashboard**: `http://localhost:8080/admin`
- **Health Check**: `http://localhost:8080/health`
- **REST API**: `http://localhost:8080/api/auctions` and `http://localhost:8080/api/admin/analytics`

### 3. Optional Supabase Setup
1. Create a Supabase project and execute `supabase/schema.sql` in the **SQL Editor**.
2. Copy `.env.example` to `.env` and fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Restart `npm start` — the Admin Dashboard badge will switch from `LOCAL` to `SUPABASE`.

---

## 🧪 Testing & Verification

```bash
# Run unit, race-condition, anti-snipe, multi-stock, rate-limiter, analytics & DB tests
npm test

# Default WebSocket load test (1,000 concurrent bidders)
npm run load-test

# Full scale 50,000 bidder stress test
npm run load-test:50k
```

---

## 📜 Documentation

For mathematical proofs, concurrency race-condition analyses, OS tuning, and horizontal scaling blueprints, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
