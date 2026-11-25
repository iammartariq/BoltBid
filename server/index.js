// ============================================================================
// server/index.js — Application Entry Point
// ============================================================================
// Sets up the HTTP server (PWA static files + User & Admin REST APIs) and
// the WebSocket server (real-time bidding + live Admin telemetry).
// ============================================================================

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const config             = require('./config');
const Database           = require('./Database');
const AuthService        = require('./AuthService');
const AnalyticsCollector = require('./AnalyticsCollector');
const ConnectionManager  = require('./ConnectionManager');
const RateLimiter        = require('./RateLimiter');
const AuctionEngine      = require('./AuctionEngine');
const MessageRouter      = require('./MessageRouter');
const SpikeSimulator     = require('./SpikeSimulator');
const { ServerMsg, buildMessage } = require('../shared/protocol');

// ── Initialise components ──────────────────────────────────────────────────

const database          = new Database();
const authService       = new AuthService(database);
const analytics         = new AnalyticsCollector();
const connectionManager = new ConnectionManager(analytics);
const rateLimiter       = new RateLimiter();
const auctionEngine     = new AuctionEngine(connectionManager, analytics, database);
const spikeSimulator    = new SpikeSimulator(auctionEngine, rateLimiter);

function getAdminSnapshot() {
  return analytics.getSnapshot({
    auctionEngine,
    connectionManager,
    database,
    simulator: spikeSimulator,
  });
}

const messageRouter = new MessageRouter(
  auctionEngine,
  connectionManager,
  rateLimiter,
  analytics,
  getAdminSnapshot,
  authService
);

// ── HTTP Helpers ───────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html':        'text/html; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.js':          'application/javascript; charset=utf-8',
  '.json':        'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':         'image/png',
  '.jpg':         'image/jpeg',
  '.svg':         'image/svg+xml',
  '.ico':         'image/x-icon',
};

const CLIENT_DIR = path.join(__dirname, '..', 'client');

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type':  'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sendRedirect(res, location) {
  res.writeHead(302, {
    Location:        location,
    'Cache-Control': 'no-store',
  });
  res.end();
}

function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function isAdminAuthorized(req) {
  return Boolean(authService.getAdminSessionFromReq(req));
}

function getRequestOrigin(req) {
  const proto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'http';
  const host  = req.headers.host || `localhost:${config.PORT}`;
  return `${proto}://${host}`;
}

// ── HTTP Server ────────────────────────────────────────────────────────────

const httpServer = http.createServer(async (req, res) => {
  const urlObj   = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const method   = (req.method || 'GET').toUpperCase();

  try {
    // ── Health Check ────────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/health') {
      const mem = process.memoryUsage();
      return sendJson(res, 200, {
        status:      'ok',
        uptime:      process.uptime(),
        connections: connectionManager.size,
        stats:       connectionManager.getStats(),
        memoryMB:    Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
        db:          database.getStatus(),
      });
    }

    // ── Public Auction APIs ─────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/auctions') {
      return sendJson(res, 200, auctionEngine.listAuctions());
    }

    const singleAuctionMatch = pathname.match(/^\/api\/auctions\/([^/]+)$/);
    if (method === 'GET' && singleAuctionMatch) {
      const snap = auctionEngine.getAuctionSnapshot(decodeURIComponent(singleAuctionMatch[1]));
      if (!snap) return sendJson(res, 404, { error: 'Auction not found' });
      return sendJson(res, 200, snap);
    }

    // ── User Auth APIs ──────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/auth/me') {
      const session = authService.getUserSessionFromReq(req);
      if (!session) return sendJson(res, 401, { authenticated: false });
      return sendJson(res, 200, {
        authenticated: true,
        user: {
          id:        session.sub,
          email:     session.email,
          fullName:  session.fullName,
          avatarUrl: session.avatarUrl || '',
          provider:  session.provider || 'email',
          role:      session.role || 'bidder',
        },
      });
    }

    if (method === 'GET' && pathname === '/api/auth/google-url') {
      const info = await authService.getGoogleAuthInfo(getRequestOrigin(req));
      return sendJson(res, 200, info);
    }

    if (method === 'POST' && pathname === '/api/auth/signup') {
      const body   = await readJsonBody(req);
      const result = await authService.signup(body);
      const cookie = authService.buildCookie(AuthService.USER_COOKIE, result.token, {
        maxAgeSec: AuthService.USER_SESSION_MS / 1000,
      });
      return sendJson(res, 201, { user: result.user, storage: result.storage }, { 'Set-Cookie': cookie });
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const body   = await readJsonBody(req);
      const result = await authService.login(body);
      const cookie = authService.buildCookie(AuthService.USER_COOKIE, result.token, {
        maxAgeSec: AuthService.USER_SESSION_MS / 1000,
      });
      return sendJson(res, 200, { user: result.user, storage: result.storage }, { 'Set-Cookie': cookie });
    }

    if (method === 'POST' && pathname === '/api/auth/oauth-session') {
      const body   = await readJsonBody(req);
      const result = await authService.completeOAuthSession(body);
      const cookie = authService.buildCookie(AuthService.USER_COOKIE, result.token, {
        maxAgeSec: AuthService.USER_SESSION_MS / 1000,
      });
      return sendJson(res, 200, { user: result.user, storage: result.storage }, { 'Set-Cookie': cookie });
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      const cookie = authService.clearCookie(AuthService.USER_COOKIE);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }

    // ── Admin Auth APIs ─────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/admin/me') {
      const session = authService.getAdminSessionFromReq(req);
      if (!session) return sendJson(res, 401, { authenticated: false });
      return sendJson(res, 200, {
        authenticated: true,
        admin: { username: session.username || config.ADMIN_USERNAME, role: 'admin' },
      });
    }

    if (method === 'POST' && pathname === '/api/admin/login') {
      const body   = await readJsonBody(req);
      const result = authService.loginAdmin(body);
      const cookie = authService.buildCookie(AuthService.ADMIN_COOKIE, result.token, {
        maxAgeSec: AuthService.ADMIN_SESSION_MS / 1000,
      });
      return sendJson(res, 200, { ok: true, admin: result.admin }, { 'Set-Cookie': cookie });
    }

    if (method === 'POST' && pathname === '/api/admin/logout') {
      const cookie = authService.clearCookie(AuthService.ADMIN_COOKIE);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie });
    }

    // ── Admin Analytics & Control APIs (Protected) ──────────────────────
    if (method === 'GET' && pathname === '/api/admin/analytics') {
      if (!isAdminAuthorized(req)) {
        return sendJson(res, 401, { error: 'Admin authentication required.' });
      }
      return sendJson(res, 200, getAdminSnapshot());
    }

    if (method === 'GET' && pathname === '/api/admin/history') {
      if (!isAdminAuthorized(req)) {
        return sendJson(res, 401, { error: 'Admin authentication required.' });
      }
      const [recentBids, winnersHistory, persistedAuctions] = await Promise.all([
        database.getRecentBids(50),
        database.getWinnersHistory(50),
        database.getPersistedAuctions(),
      ]);
      return sendJson(res, 200, {
        recentBids,
        winnersHistory,
        persistedAuctions,
        dbStatus: database.getStatus(),
      });
    }

    if (pathname.startsWith('/api/admin/') && method === 'POST') {
      if (!isAdminAuthorized(req)) {
        return sendJson(res, 401, { error: 'Admin authentication required.' });
      }

      const body = await readJsonBody(req);

      if (pathname === '/api/admin/auctions') {
        const title       = typeof body.title === 'string' ? body.title.trim() : '';
        const durationSec = Number(body.durationSec) || config.DEFAULT_AUCTION_DURATION_SEC;
        const items       = Array.isArray(body.items) ? body.items : [];

        if (!title || items.length === 0) {
          return sendJson(res, 400, { error: 'Title and at least one item are required.' });
        }

        const sanitizedItems = items.map(it => ({
          name:          String(it.name || 'Unnamed Item').trim().slice(0, 80),
          description:   String(it.description || '').trim().slice(0, 200),
          startingPrice: Math.max(1, Number(it.startingPrice) || 10),
          stock:         Math.max(1, parseInt(it.stock, 10) || 1),
        }));

        const created = auctionEngine.createAuction({
          title,
          durationSec,
          items: sanitizedItems,
        });

        connectionManager.broadcastAll(buildMessage(ServerMsg.AUCTION_LIST_UPDATE, {
          auctions: auctionEngine.listAuctions(),
        }));

        return sendJson(res, 201, created);
      }

      const extendMatch = pathname.match(/^\/api\/admin\/auctions\/([^/]+)\/extend$/);
      if (extendMatch) {
        const updated = auctionEngine.extendAuction(
          decodeURIComponent(extendMatch[1]),
          Number(body.extraSec) || 30
        );
        if (!updated) return sendJson(res, 404, { error: 'Active auction not found' });
        return sendJson(res, 200, updated);
      }

      const rushMatch = pathname.match(/^\/api\/admin\/auctions\/([^/]+)\/final-countdown$/);
      if (rushMatch) {
        const updated = auctionEngine.triggerFinalCountdown(
          decodeURIComponent(rushMatch[1]),
          Number(body.remainingSec) || 10
        );
        if (!updated) return sendJson(res, 404, { error: 'Active auction not found' });
        return sendJson(res, 200, updated);
      }

      const endMatch = pathname.match(/^\/api\/admin\/auctions\/([^/]+)\/end$/);
      if (endMatch) {
        const ended = auctionEngine.endAuctionNow(decodeURIComponent(endMatch[1]));
        if (!ended) return sendJson(res, 404, { error: 'Auction not found' });
        return sendJson(res, 200, ended);
      }

      if (pathname === '/api/admin/simulate') {
        if (body.action === 'stop') {
          return sendJson(res, 200, spikeSimulator.stop());
        }
        const result = spikeSimulator.start({
          auctionId:      body.auctionId,
          bidders:        body.bidders,
          durationSec:    body.durationSec,
          jumpToFinal10s: body.jumpToFinal10s !== false,
          bidIntervalMs:  body.bidIntervalMs,
        });
        if (result.error) return sendJson(res, 400, result);
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { error: 'Admin endpoint not found' });
    }

    // ── Static Client & Auth-Guarded PWA Routes ─────────────────────────
    let relPath = pathname;
    if (relPath === '/' || relPath === '/index.html') {
      if (!authService.getUserSessionFromReq(req)) {
        return sendRedirect(res, '/login');
      }
      relPath = '/index.html';
    } else if (relPath === '/login' || relPath === '/signup') {
      relPath = '/login.html';
    } else if (relPath === '/admin/login') {
      relPath = '/admin-login.html';
    } else if (relPath === '/admin' || relPath === '/admin/' || relPath === '/admin.html') {
      if (!isAdminAuthorized(req)) {
        return sendRedirect(res, '/admin/login');
      }
      relPath = '/admin.html';
    }

    const filePath = path.resolve(CLIENT_DIR, `.${relPath}`);
    if (!filePath.startsWith(path.resolve(CLIENT_DIR))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    const ext = path.extname(filePath).toLowerCase();
    let mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    if (path.basename(filePath) === 'manifest.json') {
      mimeType = 'application/manifest+json; charset=utf-8';
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const headers = { 'Content-Type': mimeType };
      if (ext === '.html') {
        headers['Cache-Control'] = 'no-store';
      }
      if (relPath === '/sw.js') {
        headers['Service-Worker-Allowed'] = '/';
        headers['Cache-Control'] = 'no-cache';
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  } catch (err) {
    if (err && typeof err.status === 'number') {
      return sendJson(res, err.status, { error: err.message });
    }
    console.error('[HTTP] Request error:', err.message);
    if (!res.headersSent) {
      sendJson(res, 400, { error: err.message });
    }
  }
});

// ── WebSocket Server ───────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server: httpServer,
  path:   config.WS_PATH,
  maxPayload: config.MAX_PAYLOAD,
  perMessageDeflate: false,
});

wss.on('connection', (ws, req) => {
  const userSession          = authService.getUserSessionFromReq(req);
  const isAuthenticatedAdmin = Boolean(authService.getAdminSessionFromReq(req));
  const connectionId         = connectionManager.add(ws, req, { userSession, isAuthenticatedAdmin });
  if (!connectionId) return;

  rateLimiter.register(connectionId);

  const auctions = auctionEngine.listAuctions();
  connectionManager.send(connectionId, buildMessage(ServerMsg.INFO, {
    message:    'Connected to BoltBid',
    auctions,
    connectionId,
  }));

  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    messageRouter.handle(connectionId, raw).catch(err => {
      console.error(`[WS] Error handling message from ${connectionId}:`, err);
      connectionManager.send(connectionId, buildMessage(ServerMsg.ERROR, {
        message: 'Internal server error processing your request.',
      }));
    });
  });

  ws.on('pong', () => {
    connectionManager.markAlive(connectionId);
  });

  ws.on('close', () => {
    rateLimiter.unregister(connectionId);
    connectionManager.remove(connectionId);
  });

  ws.on('error', (err) => {
    if (config.VERBOSE_LOGS) {
      console.error(`[WS] Connection error (${connectionId}):`, err.message);
    }
    rateLimiter.unregister(connectionId);
    connectionManager.remove(connectionId);
  });
});

// ── Background Telemetry & Maintenance Loops ───────────────────────────────

connectionManager.startHeartbeat();
connectionManager.startPresenceSync();
analytics.start(
  () => connectionManager.size,
  (snap) => database.saveAnalyticsSnapshot(snap).catch(() => {})
);

const adminTelemetryTimer = setInterval(() => {
  if (connectionManager.adminSubscriberCount > 0) {
    connectionManager.broadcastAdmins(buildMessage(ServerMsg.ADMIN_METRICS, {
      metrics: getAdminSnapshot(),
    }));
  }
}, 1000);
if (typeof adminTelemetryTimer.unref === 'function') adminTelemetryTimer.unref();

// ── Demo Auction Bootstrap ─────────────────────────────────────────────────

function createDemoAuction() {
  return auctionEngine.createAuction({
    title: '⚡ BoltBid Flash Drop — Limited Edition Electronics',
    durationSec: config.DEFAULT_AUCTION_DURATION_SEC,
    items: [
      {
        name:          'MacBook Pro M4 — 16" Space Black',
        description:   'Apple MacBook Pro with M4 Pro chip, 36GB RAM, 1TB SSD',
        startingPrice: 500,
        stock:         1,
      },
      {
        name:          'Sony PlayStation 6 — Launch Edition',
        description:   'Next-gen gaming console with 2TB SSD and DualSense Ultra controller',
        startingPrice: 200,
        stock:         1,
      },
      {
        name:          'iPhone 17 Pro Max — 1TB Titanium',
        description:   'Apple iPhone 17 Pro Max, A19 Pro chip, 1TB, Natural Titanium',
        startingPrice: 300,
        stock:         1,
      },
      {
        name:          'Samsung 85" Neo QLED 8K TV',
        description:   'Samsung QN900D 85-inch Neo QLED 8K Smart TV with AI Upscaling',
        startingPrice: 800,
        stock:         1,
      },
      {
        name:          'DJI Mavic 5 Pro Drone (2 Units)',
        description:   'Professional drone with Hasselblad camera, 50MP, 8K video — Top 2 bidders win!',
        startingPrice: 150,
        stock:         2,
      },
    ],
  });
}

// ── Start Server ───────────────────────────────────────────────────────────

async function bootstrap() {
  await database.init();
  const demoAuction = createDemoAuction();

  httpServer.listen(config.PORT, config.HOST, () => {
    const dbStatus = database.getStatus();
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                  ⚡ BOLTBID ENGINE — RUNNING ⚡                ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Bidder Arena:   http://localhost:${config.PORT}/                  ║`);
    console.log(`║  Admin Panel:    http://localhost:${config.PORT}/admin             ║`);
    console.log(`║  WebSocket:      ws://localhost:${config.PORT}${config.WS_PATH}               ║`);
    console.log(`║  Health Check:   http://localhost:${config.PORT}/health            ║`);
    console.log(`║  Persistence:    ${dbStatus.mode.toUpperCase().padEnd(42)}║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Demo Auction:   ${demoAuction.id.substring(0, 36)}    ║`);
    console.log(`║  Items:          ${String(demoAuction.items.length + ' items').padEnd(42)}║`);
    console.log(`║  Duration:       ${String(config.DEFAULT_AUCTION_DURATION_SEC + 's').padEnd(42)}║`);
    console.log(`║  Max Connections: ${String(config.MAX_CONNECTIONS).padEnd(41)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  });
}

bootstrap().catch((err) => {
  console.error('[Server] Fatal bootstrap error:', err);
  process.exit(1);
});

// ── Graceful Shutdown ──────────────────────────────────────────────────────

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[Server] ${signal} received. Shutting down gracefully...`);

  clearInterval(adminTelemetryTimer);
  spikeSimulator.stop();
  analytics.shutdown();
  auctionEngine.shutdown();
  connectionManager.stopPresenceSync();
  connectionManager.stopHeartbeat();

  try {
    await database.shutdown();
  } catch (err) {
    console.error('[Server] Database shutdown flush error:', err.message);
  }

  wss.close(() => {
    console.log('[Server] WebSocket server closed.');
  });

  httpServer.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });

  setTimeout(() => {
    console.log('[Server] Forcing exit...');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
});
