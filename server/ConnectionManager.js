// ============================================================================
// server/ConnectionManager.js — WebSocket Connection & Room Manager
// ============================================================================
// Tracks every WebSocket connection, maps connections to auction "rooms",
// manages admin telemetry subscribers, enforces backpressure safety, and
// throttles presence broadcasts for 50,000+ concurrent connections.
// ============================================================================

'use strict';

const { v4: uuidv4 } = require('uuid');
const config         = require('./config');
const { ServerMsg, buildMessage } = require('../shared/protocol');

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

class ConnectionManager {
  constructor(analytics = null) {
    this.analytics = analytics;

    /**
     * connectionId → {
     *   ws:          WebSocket,
     *   ip:          string,
     *   bidderId:    string | null,
     *   bidderName:  string | null,
     *   auctionId:   string | null,
     *   isAdmin:     boolean,
     *   isAlive:     boolean,
     *   connectedAt: number
     * }
     */
    this.connections = new Map();

    /** auctionId → Set<connectionId> */
    this.rooms = new Map();

    /** bidderId → connectionId (O(1) direct outbid notifications) */
    this.bidderConnections = new Map();

    /** Set<connectionId> of subscribed admin dashboard sockets */
    this.adminSubscribers = new Set();

    /** ip → count */
    this.ipCounts = new Map();

    /** Rooms whose bidderCount changed and need a throttled presence sync */
    this._dirtyRooms = new Set();

    this.droppedFrames   = 0;
    this._heartbeatTimer = null;
    this._presenceTimer  = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Register a new WebSocket connection.
   * @param {import('ws').WebSocket} ws
   * @param {import('http').IncomingMessage} req
   * @param {object} [authContext]
   * @returns {string|null} connectionId
   */
  add(ws, req, authContext = {}) {
    if (this.connections.size >= config.MAX_CONNECTIONS) {
      ws.close(1013, 'Server at capacity');
      return null;
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress
            || 'unknown';

    const currentIpCount = this.ipCounts.get(ip) || 0;
    const isLoopback = LOOPBACK_IPS.has(ip);
    if (!(config.EXEMPT_LOOPBACK_IP_LIMIT && isLoopback)) {
      if (currentIpCount >= config.MAX_CONNECTIONS_PER_IP) {
        ws.close(1013, 'Too many connections from your IP');
        return null;
      }
    }

    const connectionId = uuidv4();

    this.connections.set(connectionId, {
      ws,
      ip,
      bidderId:             null,
      bidderName:           null,
      auctionId:            null,
      isAdmin:              false,
      userSession:          authContext.userSession || null,
      isAuthenticatedAdmin: Boolean(authContext.isAuthenticatedAdmin),
      isAlive:              true,
      connectedAt:          Date.now(),
    });

    this.ipCounts.set(ip, currentIpCount + 1);
    ws._connectionId = connectionId;

    if (this.analytics) {
      this.analytics.recordConnection(this.connections.size);
    }

    return connectionId;
  }

  /**
   * Remove a connection and clean up room/admin membership.
   * @param {string} connectionId
   */
  remove(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    if (conn.auctionId) {
      const auctionId = conn.auctionId;
      this._leaveRoom(connectionId, auctionId);
      this.markRoomDirty(auctionId);
    }

    if (conn.bidderId) {
      this.bidderConnections.delete(conn.bidderId);
    }

    this.adminSubscribers.delete(connectionId);

    const ipCount = (this.ipCounts.get(conn.ip) || 1) - 1;
    if (ipCount <= 0) this.ipCounts.delete(conn.ip);
    else this.ipCounts.set(conn.ip, ipCount);

    this.connections.delete(connectionId);
  }

  get(connectionId) {
    return this.connections.get(connectionId) || null;
  }

  get size() {
    return this.connections.size;
  }

  get adminSubscriberCount() {
    return this.adminSubscribers.size;
  }

  // ── Room (Auction) Management ─────────────────────────────────────────

  joinRoom(connectionId, auctionId, bidderId, bidderName) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;

    if (conn.auctionId) {
      this._leaveRoom(connectionId, conn.auctionId);
      this.markRoomDirty(conn.auctionId);
    }
    if (conn.bidderId) {
      this.bidderConnections.delete(conn.bidderId);
    }

    conn.auctionId  = auctionId;
    conn.bidderId   = bidderId;
    conn.bidderName = bidderName;

    if (!this.rooms.has(auctionId)) {
      this.rooms.set(auctionId, new Set());
    }
    this.rooms.get(auctionId).add(connectionId);
    if (bidderId) {
      this.bidderConnections.set(bidderId, connectionId);
    }

    this.markRoomDirty(auctionId);
  }

  leaveRoom(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.auctionId) return;

    const auctionId = conn.auctionId;
    this._leaveRoom(connectionId, auctionId);
    if (conn.bidderId) {
      this.bidderConnections.delete(conn.bidderId);
    }

    conn.auctionId  = null;
    conn.bidderId   = null;
    conn.bidderName = null;

    this.markRoomDirty(auctionId);
  }

  /** @private */
  _leaveRoom(connectionId, auctionId) {
    const room = this.rooms.get(auctionId);
    if (room) {
      room.delete(connectionId);
      if (room.size === 0) this.rooms.delete(auctionId);
    }
  }

  roomSize(auctionId) {
    return this.rooms.get(auctionId)?.size || 0;
  }

  markRoomDirty(auctionId) {
    if (auctionId) this._dirtyRooms.add(auctionId);
  }

  // ── Admin Telemetry Subscriptions ─────────────────────────────────────

  subscribeAdmin(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.isAdmin = true;
    this.adminSubscribers.add(connectionId);
  }

  unsubscribeAdmin(connectionId) {
    const conn = this.connections.get(connectionId);
    if (conn) conn.isAdmin = false;
    this.adminSubscribers.delete(connectionId);
  }

  broadcastAdmins(message) {
    if (this.adminSubscribers.size === 0) return;
    for (const connId of this.adminSubscribers) {
      this.send(connId, message, { critical: false });
    }
  }

  // ── Messaging ─────────────────────────────────────────────────────────

  /**
   * Send a message to a single connection with optional backpressure guard.
   * Non-critical high-frequency broadcasts are dropped for congested slow clients
   * so one stalled TCP receiver cannot exhaust server memory.
   */
  send(connectionId, message, { critical = true } = {}) {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.ws.readyState !== 1 /* OPEN */) return false;

    if (!critical && conn.ws.bufferedAmount > config.MAX_WS_BACKPRESSURE_BYTES) {
      this.droppedFrames += 1;
      if (this.analytics) this.analytics.recordDroppedFrame();
      return false;
    }

    conn.ws.send(message);
    return true;
  }

  /** Direct O(1) send by bidderId (used for OUTBID_ALERT). */
  sendToBidder(bidderId, message, options = { critical: true }) {
    if (!bidderId) return false;
    const connId = this.bidderConnections.get(bidderId);
    if (!connId) return false;
    return this.send(connId, message, options);
  }

  broadcast(auctionId, message, excludeConnectionId, options = { critical: true }) {
    const room = this.rooms.get(auctionId);
    if (!room) return;

    for (const connId of room) {
      if (connId === excludeConnectionId) continue;
      this.send(connId, message, options);
    }
  }

  broadcastAll(message, options = { critical: false }) {
    for (const [connId] of this.connections) {
      this.send(connId, message, options);
    }
  }

  // ── Presence Sync & Heartbeat ─────────────────────────────────────────

  /** Throttled presence sync avoids O(N^2) broadcast storms during 50k joins. */
  startPresenceSync() {
    if (this._presenceTimer) return;
    this._presenceTimer = setInterval(() => {
      if (this._dirtyRooms.size === 0) return;
      for (const auctionId of this._dirtyRooms) {
        const count = this.roomSize(auctionId);
        if (count > 0) {
          this.broadcast(
            auctionId,
            buildMessage(ServerMsg.INFO, {
              auctionId,
              bidderCount: count,
              silent:      true,
            }),
            null,
            { critical: false }
          );
        }
      }
      this._dirtyRooms.clear();
    }, config.PRESENCE_BROADCAST_INTERVAL_MS);
    if (typeof this._presenceTimer.unref === 'function') this._presenceTimer.unref();
  }

  stopPresenceSync() {
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
    this._dirtyRooms.clear();
  }

  startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      for (const [connId, conn] of this.connections) {
        if (!conn.isAlive) {
          conn.ws.terminate();
          this.remove(connId);
          continue;
        }
        conn.isAlive = false;
        if (conn.ws.readyState === 1) {
          conn.ws.ping();
        }
      }
    }, config.HEARTBEAT_INTERVAL_MS);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  markAlive(connectionId) {
    const conn = this.connections.get(connectionId);
    if (conn) conn.isAlive = true;
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  getStats() {
    const roomStats = {};
    for (const [auctionId, members] of this.rooms) {
      roomStats[auctionId] = members.size;
    }
    return {
      totalConnections: this.connections.size,
      uniqueIPs:        this.ipCounts.size,
      adminSubscribers: this.adminSubscribers.size,
      droppedFrames:    this.droppedFrames,
      rooms:            roomStats,
    };
  }
}

module.exports = ConnectionManager;
