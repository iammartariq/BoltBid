// ============================================================================
// tests/auctionEngine.test.js — Unit Tests for the Bidding Engine
// ============================================================================
// Verifies that the auction engine correctly handles:
//   1. Normal bid acceptance
//   2. Bid-too-low rejection
//   3. Race condition prevention (concurrent bids on same item)
//   4. Own-bid rejection (can't outbid yourself)
//   5. Auction lifecycle (active → ending → ended)
//   6. Anti-snipe extension
//
// Run: node tests/auctionEngine.test.js
// ============================================================================

'use strict';

// ── Minimal mock ConnectionManager ──────────────────────────────────────────

class MockConnectionManager {
  constructor() {
    this.sent      = [];   // { connectionId, message }
    this.broadcasts = [];  // { auctionId, message }
    this._rooms     = new Map();
  }

  send(connectionId, message) {
    this.sent.push({ connectionId, message: JSON.parse(message) });
  }

  sendToBidder(bidderId, message) {
    this.sent.push({ connectionId: `bidder:${bidderId}`, message: JSON.parse(message) });
  }

  broadcast(auctionId, message, exclude) {
    this.broadcasts.push({ auctionId, message: JSON.parse(message), exclude });
  }

  roomSize(auctionId) {
    return this._rooms.get(auctionId)?.size || 0;
  }

  // helpers for tests
  getLastSent(connectionId) {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i].connectionId === connectionId) return this.sent[i].message;
    }
    return null;
  }

  getSentOfType(connectionId, type) {
    return this.sent.filter(s => s.connectionId === connectionId && s.message.type === type);
  }

  reset() {
    this.sent = [];
    this.broadcasts = [];
  }
}

// ── Import Engine & Subsystems ──────────────────────────────────────────────

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const AuctionEngine      = require('../server/AuctionEngine');
const RateLimiter        = require('../server/RateLimiter');
const AnalyticsCollector = require('../server/AnalyticsCollector');
const Database           = require('../server/Database');
const AuthService        = require('../server/AuthService');

// ── Test Runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results = [];

function assert(condition, testName) {
  if (condition) {
    passed++;
    results.push(`  ✅ ${testName}`);
  } else {
    failed++;
    results.push(`  ❌ ${testName}`);
  }
}

async function assertEqual(actual, expected, testName) {
  if (actual === expected) {
    passed++;
    results.push(`  ✅ ${testName}`);
  } else {
    failed++;
    results.push(`  ❌ ${testName} — expected: ${expected}, got: ${actual}`);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function testCreateAuction() {
  console.log('\n📋 Test: Create Auction');
  const cm     = new MockConnectionManager();
  const engine = new AuctionEngine(cm);

  const auction = engine.createAuction({
    title: 'Test Auction',
    durationSec: 60,
    items: [
      { name: 'Item A', startingPrice: 100, stock: 1 },
      { name: 'Item B', startingPrice: 200, stock: 1 },
    ],
  });

  assert(auction.id !== undefined, 'Auction has an ID');
  assert(auction.title === 'Test Auction', 'Auction has correct title');
  assert(auction.status === 'ACTIVE', 'Auction status is ACTIVE');
  assert(auction.items.length === 2, 'Auction has 2 items');
  assert(auction.items[0].currentBid === 100, 'Item A starts at $100');
  assert(auction.items[1].currentBid === 200, 'Item B starts at $200');

  engine.shutdown();
}

async function testAcceptBid() {
  console.log('\n📋 Test: Accept Valid Bid');
  const cm     = new MockConnectionManager();
  const engine = new AuctionEngine(cm);

  const auction = engine.createAuction({
    title: 'Bid Test',
    durationSec: 60,
    items: [{ name: 'Widget', startingPrice: 10, stock: 1 }],
  });

  const itemId = auction.items[0].id;

  await engine.placeBid({
    auctionId:    auction.id,
    itemId,
    amount:       15,
    bidderId:     'bidder-1',
    bidderName:   'Alice',
    connectionId: 'conn-1',
  });

  const accepted = cm.getSentOfType('conn-1', 'BID_ACCEPTED');
  assert(accepted.length === 1, 'BID_ACCEPTED sent to bidder');
  assertEqual(accepted[0].message.amount, 15, 'Accepted amount is $15');

  // Check item was updated
  const snapshot = engine.getAuctionSnapshot(auction.id);
  const item     = snapshot.items.find(i => i.id === itemId);
  assertEqual(item.currentBid, 15, 'Item current bid updated to $15');
  assertEqual(item.bidderName, 'Alice', 'Item bidder is Alice');

  engine.shutdown();
}

async function testRejectLowBid() {
  console.log('\n📋 Test: Reject Bid Too Low');
  const cm     = new MockConnectionManager();
  const engine = new AuctionEngine(cm);

  const auction = engine.createAuction({
    title: 'Low Bid Test',
    durationSec: 60,
    items: [{ name: 'Widget', startingPrice: 100, stock: 1 }],
  });

  const itemId = auction.items[0].id;

  // Bid must be > 100 + MIN_INCREMENT (1) = 101
  await engine.placeBid({
    auctionId:    auction.id,
    itemId,
    amount:       100,  // too low
    bidderId:     'bidder-1',
    bidderName:   'Bob',
    connectionId: 'conn-1',
  });

  const rejected = cm.getSentOfType('conn-1', 'BID_REJECTED');
  assert(rejected.length === 1, 'BID_REJECTED sent for low bid');
  assertEqual(rejected[0].message.reason, 'BID_TOO_LOW', 'Reason is BID_TOO_LOW');

  engine.shutdown();
}

async function testRejectOwnBid() {
  console.log('\n📋 Test: Reject Own Bid (can\'t outbid yourself)');
  const cm     = new MockConnectionManager();
  const engine = new AuctionEngine(cm);

  const auction = engine.createAuction({
    title: 'Own Bid Test',
    durationSec: 60,
    items: [{ name: 'Widget', startingPrice: 10, stock: 1 }],
  });

  const itemId = auction.items[0].id;

  // First bid — accepted
  await engine.placeBid({
    auctionId: auction.id, itemId, amount: 15,
    bidderId: 'bidder-1', bidderName: 'Alice', connectionId: 'conn-1',
  });

  cm.reset();

  // Second bid by same bidder — should be rejected
  await engine.placeBid({
    auctionId: auction.id, itemId, amount: 20,
    bidderId: 'bidder-1', bidderName: 'Alice', connectionId: 'conn-1',
  });

  const rejected = cm.getSentOfType('conn-1', 'BID_REJECTED');
  assert(rejected.length === 1, 'BID_REJECTED sent for own bid');
  assertEqual(rejected[0].message.reason, 'OWN_BID', 'Reason is OWN_BID');

  engine.shutdown();
}

async function testRaceConditionPrevention() {
  console.log('\n📋 Test: Race Condition Prevention (100 concurrent bids)');
  const cm     = new MockConnectionManager();
  const engine = new AuctionEngine(cm);

  const auction = engine.createAuction({
    title: 'Race Test',
    durationSec: 60,
    items: [{ name: 'Rare Item', startingPrice: 10, stock: 1 }],
  });

  const itemId = auction.items[0].id;

  // Fire 100 bids concurrently for the SAME item
  // Each bidder bids their index + 11 (so bids are 11, 12, 13, ... 110)
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(
      engine.placeBid({
        auctionId:    auction.id,
        itemId,
        amount:       11 + i,
        bidderId:     `bidder-${i}`,
        bidderName:   `Bidder${i}`,
        connectionId: `conn-${i}`,
      })
    );
  }

  await Promise.all(promises);

  // After all bids processed, the item should have a single, deterministic winner
  const snapshot = engine.getAuctionSnapshot(auction.id);
  const item     = snapshot.items.find(i => i.id === itemId);

  assert(item.currentBid > 10, `Final bid is > $10 (got $${item.currentBid})`);
  assert(item.currentBidder !== null, 'There is exactly one winning bidder');
  assert(item.totalBids > 0, `Multiple bids were processed (${item.totalBids} total)`);

  // Count accepted vs rejected
  const accepted = cm.sent.filter(s => s.message.type === 'BID_ACCEPTED');
  const rejected = cm.sent.filter(s => s.message.type === 'BID_REJECTED');

  assert(accepted.length + rejected.length === 100, 
    `All 100 bids got a response (${accepted.length} accepted + ${rejected.length} rejected)`);
  assert(accepted.length >= 1, `At least 1 bid accepted (got ${accepted.length})`);

  console.log(`    📊 ${accepted.length} accepted, ${rejected.length} rejected, final bid: $${item.currentBid}`);

  // CRITICAL: Verify no two bids report the same version (no double-accept)
  const versions = accepted.map(a => a.message.version);
  const uniqueVersions = new Set(versions);
  assertEqual(versions.length, uniqueVersions.size, 'No duplicate versions (no double-accept)');

  engine.shutdown();
}

async function testMultipleItemsConcurrent() {
  console.log('\n📋 Test: Concurrent Bids on Different Items (no cross-interference)');
  const cm     = new MockConnectionManager();
  const engine = new AuctionEngine(cm);

  const auction = engine.createAuction({
    title: 'Multi-Item Test',
    durationSec: 60,
    items: [
      { name: 'Item A', startingPrice: 10, stock: 1 },
      { name: 'Item B', startingPrice: 10, stock: 1 },
    ],
  });

  const itemA = auction.items[0].id;
  const itemB = auction.items[1].id;

  // Fire 50 bids on each item concurrently
  const promises = [];
  for (let i = 0; i < 50; i++) {
    promises.push(
      engine.placeBid({
        auctionId: auction.id, itemId: itemA, amount: 11 + i,
        bidderId: `a-bidder-${i}`, bidderName: `A-Bidder${i}`, connectionId: `a-conn-${i}`,
      }),
      engine.placeBid({
        auctionId: auction.id, itemId: itemB, amount: 11 + i,
        bidderId: `b-bidder-${i}`, bidderName: `B-Bidder${i}`, connectionId: `b-conn-${i}`,
      })
    );
  }

  await Promise.all(promises);

  const snapshot = engine.getAuctionSnapshot(auction.id);
  const itemAState = snapshot.items.find(i => i.id === itemA);
  const itemBState = snapshot.items.find(i => i.id === itemB);

  assert(itemAState.currentBidder !== null, 'Item A has a winner');
  assert(itemBState.currentBidder !== null, 'Item B has a winner');
  assert(itemAState.currentBidder !== itemBState.currentBidder || 
         itemAState.currentBidder.startsWith('a-') !== itemBState.currentBidder.startsWith('a-'),
    'Items have independent winners');

  console.log(`    📊 Item A: $${itemAState.currentBid} (${itemAState.totalBids} bids), ` +
              `Item B: $${itemBState.currentBid} (${itemBState.totalBids} bids)`);

  engine.shutdown();
}

async function testAuctionNotActive() {
  console.log('\n📋 Test: Reject Bids on Ended Auction');
  const cm     = new MockConnectionManager();
  const engine = new AuctionEngine(cm);

  const auction = engine.createAuction({
    title: 'Ended Test',
    durationSec: 1,  // 1 second
    items: [{ name: 'Widget', startingPrice: 10, stock: 1 }],
  });

  const itemId = auction.items[0].id;

  // Wait for auction to end
  await new Promise(resolve => setTimeout(resolve, 1500));

  await engine.placeBid({
    auctionId: auction.id, itemId, amount: 15,
    bidderId: 'bidder-1', bidderName: 'Alice', connectionId: 'conn-1',
  });

  const rejected = cm.getSentOfType('conn-1', 'BID_REJECTED');
  assert(rejected.length >= 1, 'Bid rejected after auction end');
  assertEqual(rejected[rejected.length - 1].message.reason, 'AUCTION_NOT_ACTIVE', 'Reason is AUCTION_NOT_ACTIVE');

  engine.shutdown();
}

async function testAntiSnipeExtension() {
  console.log('\n📋 Test: Anti-Snipe Extension');
  const cm     = new MockConnectionManager();
  const engine = new AuctionEngine(cm);

  const auction = engine.createAuction({
    title: 'Anti-Snipe Test',
    durationSec: 5,
    items: [{ name: 'Limited Watch', startingPrice: 100, stock: 1 }],
  });

  const beforeSnap = engine.getAuctionSnapshot(auction.id);
  await engine.placeBid({
    auctionId:    auction.id,
    itemId:       auction.items[0].id,
    amount:       150,
    bidderId:     'sniper-1',
    bidderName:   'Sniper',
    connectionId: 'conn-sniper',
  });

  const afterSnap = engine.getAuctionSnapshot(auction.id);
  const snipeBroadcasts = cm.broadcasts.filter(b => b.message.type === 'ANTI_SNIPE_EXTENDED');

  assert(afterSnap.endTime > beforeSnap.endTime, 'Auction endTime extended on final-5s bid');
  assert(snipeBroadcasts.length === 1, 'ANTI_SNIPE_EXTENDED broadcast emitted');

  engine.shutdown();
}

async function testMultiStockLimitedSupply() {
  console.log('\n📋 Test: Multi-Stock Limited Supply (stock = 2)');
  const cm     = new MockConnectionManager();
  const engine = new AuctionEngine(cm);

  const auction = engine.createAuction({
    title: 'Multi-Stock Test',
    durationSec: 60,
    items: [{ name: 'Drone', startingPrice: 100, stock: 2 }],
  });

  const itemId = auction.items[0].id;

  await engine.placeBid({ auctionId: auction.id, itemId, amount: 110, bidderId: 'u1', bidderName: 'U1', connectionId: 'c1' });
  await engine.placeBid({ auctionId: auction.id, itemId, amount: 120, bidderId: 'u2', bidderName: 'U2', connectionId: 'c2' });
  // u3 bids 105 — below cutoff (110 + 1 = 111) once 2 slots are filled
  await engine.placeBid({ auctionId: auction.id, itemId, amount: 105, bidderId: 'u3', bidderName: 'U3', connectionId: 'c3' });
  const u3Reject = cm.getSentOfType('c3', 'BID_REJECTED');
  assert(u3Reject.length === 1 && u3Reject[0].message.reason === 'BID_TOO_LOW', 'Rejects bid below multi-stock cutoff');

  // u3 bids 130 — evicts u1 (lowest of top 2) and sends OUTBID_ALERT to u1
  await engine.placeBid({ auctionId: auction.id, itemId, amount: 130, bidderId: 'u3', bidderName: 'U3', connectionId: 'c3' });
  const outbidAlerts = cm.getSentOfType('bidder:u1', 'OUTBID_ALERT');
  assert(outbidAlerts.length === 1, 'OUTBID_ALERT sent to evicted multi-stock bidder');

  const ended = engine.endAuctionNow(auction.id);
  const endedMsgs = cm.broadcasts.filter(b => b.message.type === 'AUCTION_ENDED');
  assert(ended.status === 'ENDED', 'Auction ended cleanly');
  assertEqual(endedMsgs[0].message.winners.length, 2, 'Awards exactly 2 winners for stock=2');
}

async function testRateLimiter() {
  console.log('\n📋 Test: Token-Bucket Rate Limiter');
  const rl = new RateLimiter();
  rl.register('conn-rl');

  let allowedCount = 0;
  let blocked = null;
  for (let i = 0; i < 15; i++) {
    const res = rl.allow('conn-rl');
    if (res.allowed) allowedCount++;
    else blocked = res;
  }

  assert(allowedCount >= 1 && allowedCount <= 10, `Burst capped at bucket size (${allowedCount})`);
  assert(blocked !== null && blocked.allowed === false && blocked.retryAfterMs > 0, 'Returns retryAfterMs when rate limited');
  rl.unregister('conn-rl');
}

async function testAnalyticsCollector() {
  console.log('\n📋 Test: Analytics Collector');
  const ac = new AnalyticsCollector({ disableTimers: true });
  ac.recordConnection(12);
  ac.recordBidAccepted({ auctionId: 'a1', itemId: 'i1', itemName: 'GPU', bidderId: 'b1', bidderName: 'Alice', amount: 500, processingMs: 0.42 });
  ac.recordBidRejected({ reason: 'BID_TOO_LOW', processingMs: 0.15 });
  ac.recordRateLimited();

  const snap = ac.getSnapshot();
  assertEqual(snap.kpis.totalBidsAccepted, 1, 'Tracks accepted bids');
  assertEqual(snap.kpis.totalBidsRejected, 1, 'Tracks rejected bids');
  assertEqual(snap.kpis.totalRateLimited, 1, 'Tracks rate-limited requests');
  assertEqual(snap.rejectionsByReason.BID_TOO_LOW, 1, 'Tracks rejection breakdown');
  assert(snap.latency.p95 >= 0.15, 'Computes latency percentiles');
  ac.shutdown();
}

async function testDatabaseLocalPersistence() {
  console.log('\n📋 Test: Database Local JSON Persistence');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-auction-db-'));
  const db = new Database({ dataDir: tmpDir, supabaseUrl: '', supabaseKey: '', disableTimers: true });
  await db.init();

  await db.saveAuction({
    id:        'auc-1',
    title:     'DB Test Auction',
    status:    'ACTIVE',
    startTime: Date.now(),
    endTime:   Date.now() + 60000,
    items:     [{ id: 'item-1', name: 'Laptop', startingPrice: 100, currentBid: 100, stock: 1, totalBids: 0 }],
  });

  db.enqueueBid({
    auctionId: 'auc-1',
    itemId:    'item-1',
    itemName:  'Laptop',
    bidderId:  'b-1',
    bidderName:'Tester',
    amount:    125,
    version:   1,
    processingMs: 0.3,
  });

  await db.flush();
  await db.saveWinners('auc-1', 'DB Test Auction', [{
    itemId: 'item-1', itemName: 'Laptop', unitNumber: 1,
    winningBid: 125, winnerId: 'b-1', winnerName: 'Tester', totalBids: 1,
  }]);
  await db.shutdown();

  const db2 = new Database({ dataDir: tmpDir, supabaseUrl: '', supabaseKey: '', disableTimers: true });
  await db2.init();
  const bids    = await db2.getRecentBids(10);
  const winners = await db2.getWinnersHistory(10);
  assertEqual(bids.length, 1, 'Persisted bid reloaded from disk');
  assertEqual(winners.length, 1, 'Persisted winner reloaded from disk');
  await db2.shutdown();

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function testAuthService() {
  console.log('\n📋 Test: AuthService (Signup, Login, Tokens, Cookies, Admin)');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-auction-auth-'));
  const db = new Database({ dataDir: tmpDir, supabaseUrl: '', supabaseKey: '', disableTimers: true });
  await db.init();

  const auth = new AuthService(db, {
    supabaseUrl:    '',
    serviceRoleKey: '',
    anonKey:        '',
    adminUsername:  'admin123',
    adminPassword:  'admin456',
    sessionSecret:  'unit-test-secret',
  });

  // 1. Signup stores scrypt-hashed password (never plaintext) and returns valid token
  const signedUp = await auth.signup({
    fullName: 'Test Bidder',
    email:    'TestBidder@Example.com',
    password: 'password123',
  });
  assert(signedUp.user.email === 'testbidder@example.com', 'Normalizes signup email');
  assert(signedUp.storage === 'local', 'Uses local fallback when Supabase is omitted');
  const storedRecord = db.findLocalUserByEmail('testbidder@example.com');
  assert(storedRecord && storedRecord.passwordHash !== 'password123', 'Password is hashed with salt');
  assert(storedRecord.passwordSalt && storedRecord.passwordHash.length > 32, 'Stores password salt and scrypt hash');

  // 2. Duplicate email rejected with 409
  let dupErr = null;
  try {
    await auth.signup({ fullName: 'Dup', email: 'testbidder@example.com', password: 'password123' });
  } catch (err) {
    dupErr = err;
  }
  assert(dupErr && dupErr.status === 409, 'Rejects duplicate signup with 409');

  // 3. Login succeeds with valid credentials and fails (401) with wrong password
  const loggedIn = await auth.login({ email: 'testbidder@example.com', password: 'password123' });
  assert(loggedIn.user.id === signedUp.user.id, 'Login returns matching user');

  let badPassErr = null;
  try {
    await auth.login({ email: 'testbidder@example.com', password: 'wrong-password' });
  } catch (err) {
    badPassErr = err;
  }
  assert(badPassErr && badPassErr.status === 401, 'Rejects invalid password with 401');

  // 4. Token verification & role isolation
  const verifiedBidder = auth.verifyToken(loggedIn.token, 'bidder');
  assert(verifiedBidder && verifiedBidder.sub === signedUp.user.id, 'Verifies valid bidder token');
  assert(auth.verifyToken(loggedIn.token, 'admin') === null, 'Rejects bidder token for admin role');
  assert(auth.verifyToken(`${loggedIn.token}tamper`, 'bidder') === null, 'Rejects tampered token');

  // 5. Admin login succeeds with admin123 / admin456 and fails (401) with wrong credentials
  const adminRes = auth.loginAdmin({ username: 'admin123', password: 'admin456' });
  assert(adminRes.admin.username === 'admin123', 'Admin login succeeds with admin123/admin456');
  assert(auth.verifyToken(adminRes.token, 'admin')?.role === 'admin', 'Admin token verifies with admin role');

  let badAdminErr = null;
  try {
    auth.loginAdmin({ username: 'admin123', password: 'wrong' });
  } catch (err) {
    badAdminErr = err;
  }
  assert(badAdminErr && badAdminErr.status === 401, 'Rejects invalid admin credentials with 401');

  // 6. Cookie parsing
  const parsedCookies = auth.parseCookies('foo=bar; fa_session=abc%2Edef; theme=dark');
  assertEqual(parsedCookies.foo, 'bar', 'Parses simple cookie');
  assertEqual(parsedCookies.fa_session, 'abc.def', 'Decodes URL-encoded cookie');

  await db.shutdown();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Run All Tests ───────────────────────────────────────────────────────────

async function runAll() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║               ⚡ BoltBid — Unit Tests ⚡                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await testCreateAuction();
  await testAcceptBid();
  await testRejectLowBid();
  await testRejectOwnBid();
  await testRaceConditionPrevention();
  await testMultipleItemsConcurrent();
  await testAuctionNotActive();
  await testAntiSnipeExtension();
  await testMultiStockLimitedSupply();
  await testRateLimiter();
  await testAnalyticsCollector();
  await testDatabaseLocalPersistence();
  await testAuthService();

  console.log('\n' + '═'.repeat(60));
  console.log('Results:');
  for (const r of results) console.log(r);
  console.log('─'.repeat(60));
  console.log(`  Total: ${passed + failed}  |  ✅ Passed: ${passed}  |  ❌ Failed: ${failed}`);
  console.log('═'.repeat(60));

  if (failed > 0) process.exit(1);
}

runAll().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
