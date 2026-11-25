// ============================================================================
// server/AnalyticsCollector.js — Real-Time Telemetry & Admin Analytics
// ============================================================================
// Captures sub-millisecond bid processing latencies, throughput rates,
// rejection breakdowns, event-loop lag, memory health, and 60-second rolling
// time-series metrics for the Admin Dashboard.
// ============================================================================

'use strict';

class AnalyticsCollector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxLatencySamples=2000]
   * @param {number} [opts.historySeconds=60]
   * @param {boolean} [opts.disableTimers=false]
   */
  constructor(opts = {}) {
    this._maxLatencySamples = opts.maxLatencySamples || 2000;
    this._historySeconds    = opts.historySeconds || 60;
    this._disableTimers     = Boolean(opts.disableTimers);

    // Cumulative counters
    this.totalBidsReceived        = 0;
    this.totalBidsAccepted        = 0;
    this.totalBidsRejected        = 0;
    this.totalRateLimited         = 0;
    this.totalAntiSnipeExtensions = 0;
    this.totalConnectionsEver     = 0;
    this.peakConcurrentConnections = 0;
    this.droppedBackpressureFrames = 0;

    // Rejection reasons map
    this.rejectionsByReason = {};

    // Current 1-second interval counters (reset on each 1s sample tick)
    this._secBids      = 0;
    this._secAccepted  = 0;
    this._secRejected  = 0;
    this._secRateLim   = 0;

    // Ring buffer for latency samples (ms)
    this._latencies = [];

    // 60-second rolling time-series
    this.timeSeries = [];

    // Recent accepted bids (in-memory hot feed, last 100)
    this.recentBids = [];

    // Top bidders map: bidderName -> { bidderName, bids, accepted, maxBid, totalVolume }
    this._topBidders = new Map();

    // Event-loop lag tracking
    this.eventLoopLagMs = 0;
    this._lastLagCheck  = Date.now();
    this._lagTimer      = null;
    this._sampleTimer   = null;
    this._startedAt     = Date.now();
  }

  /** Start 1-second time-series sampling & event-loop lag monitoring. */
  start(getActiveConnectionsFn = () => 0, onSnapshotFn = null) {
    if (this._disableTimers) return;

    this._lastLagCheck = Date.now();
    if (!this._lagTimer) {
      this._lagTimer = setInterval(() => {
        const now = Date.now();
        const drift = Math.max(0, now - this._lastLagCheck - 500);
        this.eventLoopLagMs = Number((this.eventLoopLagMs * 0.6 + drift * 0.4).toFixed(2));
        this._lastLagCheck = now;
      }, 500);
      if (typeof this._lagTimer.unref === 'function') this._lagTimer.unref();
    }

    if (!this._sampleTimer) {
      let tickCount = 0;
      this._sampleTimer = setInterval(() => {
        const memMB = Number((process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(2));
        const latencyStats = this.getLatencyStats();
        const activeConnections = Number(getActiveConnectionsFn() || 0);
        if (activeConnections > this.peakConcurrentConnections) {
          this.peakConcurrentConnections = activeConnections;
        }

        const point = {
          ts:                Date.now(),
          bidsPerSec:        this._secBids,
          acceptedPerSec:    this._secAccepted,
          rejectedPerSec:    this._secRejected,
          rateLimitedPerSec: this._secRateLim,
          activeConnections,
          avgLatencyMs:      latencyStats.avg,
          p95LatencyMs:      latencyStats.p95,
          heapUsedMB:        memMB,
          eventLoopLagMs:    this.eventLoopLagMs,
        };

        this.timeSeries.push(point);
        if (this.timeSeries.length > this._historySeconds) {
          this.timeSeries.shift();
        }

        this._secBids     = 0;
        this._secAccepted = 0;
        this._secRejected = 0;
        this._secRateLim  = 0;

        tickCount++;
        if (onSnapshotFn && tickCount % 10 === 0) {
          onSnapshotFn({
            activeConnections,
            bidsPerSec:       point.bidsPerSec,
            totalAccepted:    this.totalBidsAccepted,
            totalRejected:    this.totalBidsRejected,
            totalRateLimited: this.totalRateLimited,
            p95LatencyMs:     point.p95LatencyMs,
            heapUsedMB:       memMB,
          });
        }
      }, 1000);
      if (typeof this._sampleTimer.unref === 'function') this._sampleTimer.unref();
    }
  }

  /** Stop background timers. */
  shutdown() {
    if (this._lagTimer) {
      clearInterval(this._lagTimer);
      this._lagTimer = null;
    }
    if (this._sampleTimer) {
      clearInterval(this._sampleTimer);
      this._sampleTimer = null;
    }
  }

  // ── Recording Hooks ───────────────────────────────────────────────────

  recordConnection(currentCount) {
    this.totalConnectionsEver += 1;
    if (currentCount > this.peakConcurrentConnections) {
      this.peakConcurrentConnections = currentCount;
    }
  }

  recordBidAccepted({ auctionId, auctionTitle, itemId, itemName, bidderId, bidderName, amount, processingMs = 0 }) {
    this.totalBidsReceived += 1;
    this.totalBidsAccepted += 1;
    this._secBids          += 1;
    this._secAccepted      += 1;

    this._pushLatency(processingMs);

    const record = {
      auctionId,
      auctionTitle: auctionTitle || '',
      itemId,
      itemName,
      bidderId,
      bidderName,
      amount,
      processingMs: Number(processingMs.toFixed(3)),
      timestamp: Date.now(),
    };
    this.recentBids.unshift(record);
    if (this.recentBids.length > 100) {
      this.recentBids.length = 100;
    }

    const key = bidderName || bidderId || 'Anonymous';
    const existing = this._topBidders.get(key) || {
      bidderName:  key,
      accepted:    0,
      maxBid:      0,
      totalVolume: 0,
      lastBidAt:   0,
    };
    existing.accepted    += 1;
    existing.maxBid       = Math.max(existing.maxBid, amount);
    existing.totalVolume += amount;
    existing.lastBidAt    = record.timestamp;
    this._topBidders.set(key, existing);

    // Keep top-bidders map bounded for long-running sessions
    if (this._topBidders.size > 5000) {
      const oldestKey = this._topBidders.keys().next().value;
      this._topBidders.delete(oldestKey);
    }
  }

  recordBidRejected({ reason = 'UNKNOWN', processingMs = 0 }) {
    this.totalBidsReceived += 1;
    this.totalBidsRejected += 1;
    this._secBids          += 1;
    this._secRejected      += 1;

    this.rejectionsByReason[reason] = (this.rejectionsByReason[reason] || 0) + 1;
    this._pushLatency(processingMs);
  }

  recordRateLimited() {
    this.totalBidsReceived += 1;
    this.totalRateLimited  += 1;
    this._secBids          += 1;
    this._secRateLim       += 1;
    this.rejectionsByReason.RATE_LIMITED = (this.rejectionsByReason.RATE_LIMITED || 0) + 1;
  }

  recordAntiSnipe() {
    this.totalAntiSnipeExtensions += 1;
  }

  recordDroppedFrame() {
    this.droppedBackpressureFrames += 1;
  }

  _pushLatency(ms) {
    if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) return;
    this._latencies.push(ms);
    if (this._latencies.length > this._maxLatencySamples) {
      this._latencies.shift();
    }
  }

  getLatencyStats() {
    if (this._latencies.length === 0) {
      return { avg: 0, p50: 0, p95: 0, p99: 0, samples: 0 };
    }
    const sorted = this._latencies.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const pct = (p) => {
      const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
      return Number(sorted[idx].toFixed(3));
    };

    return {
      avg:     Number((sum / sorted.length).toFixed(3)),
      p50:     pct(50),
      p95:     pct(95),
      p99:     pct(99),
      samples: sorted.length,
    };
  }

  getTopBidders(limit = 10) {
    return Array.from(this._topBidders.values())
      .sort((a, b) => b.accepted - a.accepted || b.maxBid - a.maxBid)
      .slice(0, limit);
  }

  /**
   * Build complete telemetry payload for Admin Dashboard & REST API.
   */
  getSnapshot({ auctionEngine, connectionManager, database, simulator } = {}) {
    const connStats = connectionManager ? connectionManager.getStats() : { totalConnections: 0, uniqueIPs: 0, rooms: {} };
    const auctions  = auctionEngine ? auctionEngine.getDetailedAuctions() : [];
    const mem       = process.memoryUsage();
    const latency   = this.getLatencyStats();

    const lastPoint = this.timeSeries.length > 0
      ? this.timeSeries[this.timeSeries.length - 1]
      : { bidsPerSec: this._secBids, acceptedPerSec: this._secAccepted, rejectedPerSec: this._secRejected, rateLimitedPerSec: this._secRateLim };

    const totalGmv = auctions.reduce((sum, a) => sum + (a.gmv || 0), 0);
    const acceptanceRate = this.totalBidsReceived > 0
      ? Number(((this.totalBidsAccepted / this.totalBidsReceived) * 100).toFixed(1))
      : 100;

    return {
      timestamp: Date.now(),
      uptimeSec: Math.floor(process.uptime()),
      kpis: {
        activeConnections:         connStats.totalConnections,
        uniqueIPs:                 connStats.uniqueIPs,
        peakConcurrentConnections: Math.max(this.peakConcurrentConnections, connStats.totalConnections),
        totalConnectionsEver:      this.totalConnectionsEver,
        bidsPerSec:                lastPoint.bidsPerSec,
        acceptedPerSec:            lastPoint.acceptedPerSec,
        rejectedPerSec:            lastPoint.rejectedPerSec,
        rateLimitedPerSec:         lastPoint.rateLimitedPerSec,
        totalBidsReceived:         this.totalBidsReceived,
        totalBidsAccepted:         this.totalBidsAccepted,
        totalBidsRejected:         this.totalBidsRejected,
        totalRateLimited:          this.totalRateLimited,
        acceptanceRate,
        totalAntiSnipeExtensions:  this.totalAntiSnipeExtensions,
        totalGmv:                  Number(totalGmv.toFixed(2)),
        droppedBackpressureFrames: this.droppedBackpressureFrames,
      },
      latency,
      systemHealth: {
        heapUsedMB:     Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
        heapTotalMB:    Number((mem.heapTotal / (1024 * 1024)).toFixed(2)),
        rssMB:          Number((mem.rss / (1024 * 1024)).toFixed(2)),
        eventLoopLagMs: this.eventLoopLagMs,
        nodeVersion:    process.version,
      },
      rejectionsByReason: { ...this.rejectionsByReason },
      timeSeries:         this.timeSeries.slice(),
      auctions,
      topBidders:         this.getTopBidders(10),
      recentBids:         this.recentBids.slice(0, 30),
      dbStatus:           database ? database.getStatus() : { mode: 'memory', connected: true },
      simulatorStatus:    simulator ? simulator.getStatus() : { running: false },
    };
  }
}

module.exports = AnalyticsCollector;
