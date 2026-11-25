// ============================================================================
// tests/loadTest.js — Load Test: Simulate 50,000 Concurrent Bidders
// ============================================================================
// This script connects N simulated bidders over WebSocket, joins them
// to an auction, and fires rapid bids during the final seconds.
//
// Usage:
//   node tests/loadTest.js                     # default: 1000 bidders
//   node tests/loadTest.js --bidders=5000      # 5k bidders
//   node tests/loadTest.js --bidders=50000     # full 50k test
//   node tests/loadTest.js --bidders=50000 --ramp=5000  # connect 5k/sec
//
// Prerequisites:
//   • The server must be running: npm start
//   • For 50k connections, increase OS file descriptor limits:
//       Windows:  no special config needed (handles via IOCP)
//       Linux:    ulimit -n 65536
//       macOS:    ulimit -n 65536
//   • Node.js max-old-space-size may need increasing:
//       node --max-old-space-size=4096 tests/loadTest.js --bidders=50000
// ============================================================================

'use strict';

const WebSocket = require('ws');

// ── Parse CLI Arguments ─────────────────────────────────────────────────────

function parseArgs() {
  const args = {
    bidders:  1000,
    host:     'ws://localhost:8080/ws',
    ramp:     2000,     // connections per second (ramp-up rate)
    bidDelay: 100,      // ms between bids per bidder
    duration: 15000,    // how long to bid (ms)
  };

  for (const arg of process.argv.slice(2)) {
    const [key, val] = arg.replace('--', '').split('=');
    if (key === 'bidders')  args.bidders  = parseInt(val, 10);
    if (key === 'host')     args.host     = val;
    if (key === 'ramp')     args.ramp     = parseInt(val, 10);
    if (key === 'bidDelay') args.bidDelay  = parseInt(val, 10);
    if (key === 'duration') args.duration  = parseInt(val, 10);
  }

  return args;
}

const args = parseArgs();

// ── Metrics ─────────────────────────────────────────────────────────────────

const metrics = {
  connectAttempts:  0,
  connected:        0,
  connectionErrors: 0,
  joined:           0,
  bidsSent:         0,
  bidsAccepted:     0,
  bidsRejected:     0,
  rateLimited:      0,
  errors:           0,
  latencies:        [],   // bid round-trip times in ms
  startTime:        0,
  endTime:          0,
};

// ── Simulated Bidder ────────────────────────────────────────────────────────

function createBidder(index, auctionId) {
  return new Promise((resolve) => {
    const name = `LoadBot-${index}`;
    let ws;
    let bidderId    = null;
    let auctionItems = [];
    let bidTimer    = null;
    let bidCount    = 0;
    const pendingBidTimes = [];

    metrics.connectAttempts++;

    try {
      ws = new WebSocket(args.host, {
        // Disable per-message deflate for load testing
        perMessageDeflate: false,
        handshakeTimeout:  10000,
      });
    } catch (err) {
      metrics.connectionErrors++;
      resolve();
      return;
    }

    ws.on('open', () => {
      metrics.connected++;
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      switch (msg.type) {
        case 'INFO':
          // Connection welcome — join the auction
          if (msg.auctions && msg.auctions.length > 0 && !bidderId) {
            const targetAuction = auctionId || msg.auctions[0].id;
            ws.send(JSON.stringify({
              type:       'JOIN_AUCTION',
              auctionId:  targetAuction,
              bidderName: name,
            }));
          }
          break;

        case 'AUCTION_STATE':
          bidderId     = msg.bidderId;
          auctionItems = msg.auction.items || [];
          metrics.joined++;

          // Start bidding after a random delay
          const startDelay = Math.random() * 2000;
          setTimeout(() => startBidding(), startDelay);
          break;

        case 'BID_ACCEPTED':
          metrics.bidsAccepted++;
          if (pendingBidTimes.length > 0) {
            metrics.latencies.push(Date.now() - pendingBidTimes.shift());
          }
          break;

        case 'BID_REJECTED':
          metrics.bidsRejected++;
          if (pendingBidTimes.length > 0) {
            metrics.latencies.push(Date.now() - pendingBidTimes.shift());
          }
          break;

        case 'BID_BATCH_UPDATE':
          // Server coalesced batch update received cleanly
          break;

        case 'RATE_LIMITED':
          metrics.rateLimited++;
          if (pendingBidTimes.length > 0) pendingBidTimes.shift();
          break;

        case 'ERROR':
          metrics.errors++;
          break;

        case 'AUCTION_ENDED':
          cleanup();
          break;
      }
    });

    ws.on('error', () => {
      metrics.connectionErrors++;
      cleanup();
    });

    ws.on('close', () => {
      cleanup();
    });

    function startBidding() {
      if (!auctionItems.length) return;

      bidTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          cleanup();
          return;
        }

        // Pick a random item
        const item   = auctionItems[Math.floor(Math.random() * auctionItems.length)];
        // Bid a random amount above the starting price
        const amount = item.startingPrice + Math.floor(Math.random() * 500) + bidCount + 1;

        const sendTime = Date.now();
        pendingBidTimes.push(sendTime);
        ws.send(JSON.stringify({
          type:    'PLACE_BID',
          itemId:  item.id,
          amount:  amount,
        }));
        metrics.bidsSent++;
        bidCount++;

      }, args.bidDelay + Math.random() * 50);
    }

    function cleanup() {
      if (bidTimer) clearInterval(bidTimer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(); } catch {}
      }
      resolve();
    }

    // Auto-cleanup after duration
    setTimeout(cleanup, args.duration + 5000);
  });
}

// ── Progress Reporter ───────────────────────────────────────────────────────

function startProgressReporting() {
  return setInterval(() => {
    const elapsed = ((Date.now() - metrics.startTime) / 1000).toFixed(1);
    process.stdout.write(
      `\r  [${elapsed}s] Connected: ${metrics.connected}/${args.bidders} | ` +
      `Joined: ${metrics.joined} | ` +
      `Bids: ${metrics.bidsSent} (✅${metrics.bidsAccepted} ❌${metrics.bidsRejected}) | ` +
      `Rate-limited: ${metrics.rateLimited} | ` +
      `Errors: ${metrics.connectionErrors}    `
    );
  }, 500);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          ⚡ Flash Auction Engine — Load Test ⚡              ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Bidders:    ${String(args.bidders).padEnd(47)}║`);
  console.log(`║  Ramp rate:  ${String(args.ramp + '/sec').padEnd(47)}║`);
  console.log(`║  Bid delay:  ${String(args.bidDelay + 'ms').padEnd(47)}║`);
  console.log(`║  Duration:   ${String((args.duration/1000) + 's').padEnd(47)}║`);
  console.log(`║  Server:     ${args.host.padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  metrics.startTime = Date.now();
  const progress = startProgressReporting();

  // Ramp up connections
  const batchSize   = Math.ceil(args.ramp / 10);  // connect in batches (10 batches/sec)
  const batchDelay  = 100;  // ms between batches
  const promises    = [];

  for (let i = 0; i < args.bidders; i += batchSize) {
    const batch = [];
    for (let j = i; j < Math.min(i + batchSize, args.bidders); j++) {
      batch.push(createBidder(j));
    }
    promises.push(...batch);

    // Wait between batches for ramp-up
    if (i + batchSize < args.bidders) {
      await new Promise(r => setTimeout(r, batchDelay));
    }
  }

  // Wait for all bidders to finish or timeout
  const timeoutPromise = new Promise(r => setTimeout(r, args.duration + 10000));
  await Promise.race([
    Promise.allSettled(promises),
    timeoutPromise,
  ]);

  metrics.endTime = Date.now();
  clearInterval(progress);
  console.log('\n');

  // ── Print Results ───────────────────────────────────────────────────
  const totalTime  = (metrics.endTime - metrics.startTime) / 1000;
  const bidsPerSec = (metrics.bidsSent / totalTime).toFixed(0);

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    📊 Load Test Results                     ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Total Time:           ${String(totalTime.toFixed(1) + 's').padEnd(37)}║`);
  console.log(`║  Connection Attempts:  ${String(metrics.connectAttempts).padEnd(37)}║`);
  console.log(`║  Connected:            ${String(metrics.connected).padEnd(37)}║`);
  console.log(`║  Connection Errors:    ${String(metrics.connectionErrors).padEnd(37)}║`);
  console.log(`║  Joined Auction:       ${String(metrics.joined).padEnd(37)}║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Bids Sent:            ${String(metrics.bidsSent).padEnd(37)}║`);
  console.log(`║  Bids Accepted:        ${String(metrics.bidsAccepted).padEnd(37)}║`);
  console.log(`║  Bids Rejected:        ${String(metrics.bidsRejected).padEnd(37)}║`);
  console.log(`║  Rate Limited:         ${String(metrics.rateLimited).padEnd(37)}║`);
  console.log(`║  Errors:               ${String(metrics.errors).padEnd(37)}║`);
  console.log(`║  Throughput:           ${String(bidsPerSec + ' bids/sec').padEnd(37)}║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');

  const successRate = metrics.bidsSent > 0
    ? ((metrics.bidsAccepted / metrics.bidsSent) * 100).toFixed(1)
    : '0.0';
  const connectRate = args.bidders > 0
    ? ((metrics.connected / args.bidders) * 100).toFixed(1)
    : '0.0';
  const sortedLat = metrics.latencies.slice().sort((a, b) => a - b);
  const avgLat = sortedLat.length
    ? (sortedLat.reduce((s, v) => s + v, 0) / sortedLat.length).toFixed(1)
    : '0.0';
  const p95Lat = sortedLat.length
    ? sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * 0.95))].toFixed(1)
    : '0.0';

  console.log(`║  Connection Success:   ${String(connectRate + '%').padEnd(37)}║`);
  console.log(`║  Bid Acceptance Rate:  ${String(successRate + '%').padEnd(37)}║`);
  console.log(`║  Bid RTT Avg / P95:    ${String(avgLat + 'ms / ' + p95Lat + 'ms').padEnd(37)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Verdict
  console.log('');
  if (metrics.connected >= args.bidders * 0.95 && metrics.connectionErrors < args.bidders * 0.05) {
    console.log('  ✅ PASS — Server handled the load successfully!');
  } else if (metrics.connected >= args.bidders * 0.8) {
    console.log('  ⚠️  PARTIAL — Some connections were dropped. Consider tuning OS limits.');
  } else {
    console.log('  ❌ FAIL — Too many connection failures. Check server capacity.');
  }
  console.log('');

  process.exit(0);
}

main().catch(err => {
  console.error('\nLoad test error:', err);
  process.exit(1);
});
