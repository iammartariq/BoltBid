-- ============================================================================
-- supabase/schema.sql — BoltBid PostgreSQL Schema
-- ============================================================================
-- Run this script in your Supabase SQL Editor to enable persistent storage
-- for auctions, items, bid audit logs, limited-stock winners, and telemetry.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Auctions ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auctions (
  id           UUID PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'ENDING', 'ENDED')),
  start_time   TIMESTAMPTZ NOT NULL,
  end_time     TIMESTAMPTZ NOT NULL,
  total_bids   INTEGER NOT NULL DEFAULT 0,
  total_gmv    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Auction Items ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auction_items (
  id              UUID PRIMARY KEY,
  auction_id      UUID NOT NULL REFERENCES public.auctions(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  starting_price  NUMERIC(12, 2) NOT NULL,
  current_bid     NUMERIC(12, 2) NOT NULL,
  cutoff_bid      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  stock           INTEGER NOT NULL DEFAULT 1,
  total_bids      INTEGER NOT NULL DEFAULT 0,
  winner_name     TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auction_items_auction
  ON public.auction_items (auction_id);

-- ── Accepted Bid Audit Trail (Write-Behind Batched) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.bids (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id     UUID NOT NULL REFERENCES public.auctions(id) ON DELETE CASCADE,
  item_id        UUID NOT NULL REFERENCES public.auction_items(id) ON DELETE CASCADE,
  item_name      TEXT NOT NULL,
  bidder_id      TEXT NOT NULL,
  bidder_name    TEXT NOT NULL,
  amount         NUMERIC(12, 2) NOT NULL,
  version        INTEGER NOT NULL,
  processing_ms  NUMERIC(8, 3) DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bids_auction_created
  ON public.bids (auction_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bids_item
  ON public.bids (item_id, amount DESC);

-- ── Auction Winners (Supports Multi-Unit Limited Stock) ─────────────────────
CREATE TABLE IF NOT EXISTS public.auction_winners (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id    UUID NOT NULL REFERENCES public.auctions(id) ON DELETE CASCADE,
  auction_title TEXT NOT NULL,
  item_id       UUID NOT NULL REFERENCES public.auction_items(id) ON DELETE CASCADE,
  item_name     TEXT NOT NULL,
  unit_number   INTEGER NOT NULL DEFAULT 1,
  winner_id     TEXT NOT NULL,
  winner_name   TEXT NOT NULL,
  winning_bid   NUMERIC(12, 2) NOT NULL,
  total_bids    INTEGER NOT NULL DEFAULT 0,
  ended_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_winners_auction
  ON public.auction_winners (auction_id, ended_at DESC);

-- ── Periodic Analytics Snapshots ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.analytics_snapshots (
  id                  BIGSERIAL PRIMARY KEY,
  active_connections  INTEGER NOT NULL DEFAULT 0,
  bids_per_sec        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  total_accepted      INTEGER NOT NULL DEFAULT 0,
  total_rejected      INTEGER NOT NULL DEFAULT 0,
  total_rate_limited  INTEGER NOT NULL DEFAULT 0,
  p95_latency_ms      NUMERIC(8, 3) NOT NULL DEFAULT 0,
  heap_used_mb        NUMERIC(8, 2) NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── User Profiles (Synced with Supabase Auth: Email & Google OAuth) ─────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT UNIQUE NOT NULL,
  full_name     TEXT NOT NULL,
  avatar_url    TEXT DEFAULT '',
  provider      TEXT NOT NULL DEFAULT 'email' CHECK (provider IN ('email', 'google')),
  role          TEXT NOT NULL DEFAULT 'bidder' CHECK (role IN ('bidder', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_email
  ON public.profiles (email);

-- ── Optional Row Level Security (Uncomment if exposing anon key publicly) ────
-- ALTER TABLE public.auctions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.auction_items ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.bids ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.auction_winners ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.analytics_snapshots ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
--
-- CREATE POLICY "Public read auctions" ON public.auctions FOR SELECT USING (true);
-- CREATE POLICY "Public read items" ON public.auction_items FOR SELECT USING (true);
-- CREATE POLICY "Public read winners" ON public.auction_winners FOR SELECT USING (true);
-- CREATE POLICY "Users read own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
