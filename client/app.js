// ============================================================================
// client/app.js — BoltBid Client Application (PWA + Real-Time Bidder)
// ============================================================================

'use strict';

// ── State ──────────────────────────────────────────────────────────────────

const state = {
  ws:           null,
  connected:    false,
  user:         null,
  bidderId:     null,
  bidderName:   null,
  auctionId:    null,
  auction:      null,
  auctions:     [],
  reconnectAttempts: 0,
  maxReconnectAttempts: 12,
  reconnectDelay: 1000,
  pingInterval: null,
  deferredInstallPrompt: null,
  pendingAutoRejoin: false,
};

// ── Protocol Constants (mirror shared/protocol.js) ─────────────────────────

const ClientMsg = {
  JOIN_AUCTION:  'JOIN_AUCTION',
  LEAVE_AUCTION: 'LEAVE_AUCTION',
  PLACE_BID:     'PLACE_BID',
  PING:          'PING',
};

const ServerMsg = {
  AUCTION_STATE:       'AUCTION_STATE',
  BID_UPDATE:          'BID_UPDATE',
  BID_BATCH_UPDATE:    'BID_BATCH_UPDATE',
  BID_ACCEPTED:        'BID_ACCEPTED',
  BID_REJECTED:        'BID_REJECTED',
  OUTBID_ALERT:        'OUTBID_ALERT',
  AUCTION_COUNTDOWN:   'AUCTION_COUNTDOWN',
  ANTI_SNIPE_EXTENDED: 'ANTI_SNIPE_EXTENDED',
  AUCTION_ENDED:       'AUCTION_ENDED',
  AUCTION_LIST_UPDATE: 'AUCTION_LIST_UPDATE',
  PONG:                'PONG',
  RATE_LIMITED:        'RATE_LIMITED',
  ERROR:               'ERROR',
  INFO:                'INFO',
};

// ── DOM References ─────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);

const dom = {
  statusDot:       $('.status-dot'),
  statusText:      $('#status-text'),
  bidderCount:     $('#bidder-count'),
  latencyRtt:      $('#latency-rtt'),
  offlinePill:     $('#offline-pill'),
  installBtn:      $('#install-pwa-btn'),
  userPill:        $('#user-pill'),
  userAvatar:      $('#user-avatar'),
  userDisplayName: $('#user-display-name'),
  logoutBtn:       $('#logout-btn'),

  joinScreen:      $('.join-screen'),
  nameInput:       $('#bidder-name'),
  auctionSelect:   $('#auction-select'),
  joinBtn:         $('#join-btn'),

  auctionContainer:$('.auction-container'),
  auctionTitle:    $('#auction-title'),
  auctionSubmeta:  $('#auction-submeta'),
  leaveBtn:        $('#leave-auction-btn'),
  snipeBanner:     $('#snipe-banner'),
  timeRemaining:   $('#time-remaining'),
  timeLabel:       $('#time-label'),
  countdownBar:    $('.countdown-bar'),
  progressBar:     $('.countdown-bar .progress'),
  itemsGrid:       $('#items-grid'),

  eventLog:        $('#event-log'),
  endedOverlay:    $('.auction-ended-overlay'),
  winnersList:     $('#winners-list'),
  toastContainer:  $('.toast-container'),
};

// ── PWA Registration & Install Prompt ──────────────────────────────────────

function initPwa() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    if (dom.installBtn) dom.installBtn.hidden = false;
  });

  if (dom.installBtn) {
    dom.installBtn.addEventListener('click', async () => {
      if (!state.deferredInstallPrompt) return;
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      dom.installBtn.hidden = true;
    });
  }

  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    if (dom.installBtn) dom.installBtn.hidden = true;
    showToast('BoltBid installed as an app!', 'success');
  });

  const syncOnline = () => {
    if (dom.offlinePill) dom.offlinePill.hidden = navigator.onLine;
  };
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();
}

// ── WebSocket Connection ───────────────────────────────────────────────────

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl    = `${protocol}//${window.location.host}/ws`;

  updateStatus('connecting');
  logEvent('Connecting to server...', 'info');

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    state.connected = true;
    state.reconnectAttempts = 0;
    updateStatus('connected');
    logEvent('Connected to BoltBid', 'info');

    // Auto-rejoin if user was already in an auction before disconnect
    if (state.pendingAutoRejoin && state.auctionId && state.bidderName) {
      state.pendingAutoRejoin = false;
      send({
        type:       ClientMsg.JOIN_AUCTION,
        auctionId:  state.auctionId,
        bidderName: state.bidderName,
      });
    }

    if (state.pingInterval) clearInterval(state.pingInterval);
    state.pingInterval = setInterval(() => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        send({ type: ClientMsg.PING, clientTs: Date.now() });
      }
    }, 5000);
    // Send immediate ping for RTT readout
    send({ type: ClientMsg.PING, clientTs: Date.now() });
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  };

  state.ws.onclose = (event) => {
    state.connected = false;
    updateStatus('disconnected');
    if (state.pingInterval) clearInterval(state.pingInterval);
    if (state.auctionId && state.bidderName) {
      state.pendingAutoRejoin = true;
    }
    logEvent(`Disconnected (code: ${event.code})`, 'info');

    if (state.reconnectAttempts < state.maxReconnectAttempts) {
      const delay = Math.min(10000, state.reconnectDelay * Math.pow(1.5, state.reconnectAttempts));
      state.reconnectAttempts++;
      logEvent(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${state.reconnectAttempts})...`, 'info');
      setTimeout(connect, delay);
    } else {
      showToast('Connection lost. Please refresh the page.', 'error');
    }
  };

  state.ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

// ── Message Handler ────────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case ServerMsg.INFO:
      handleInfo(msg);
      break;
    case ServerMsg.AUCTION_LIST_UPDATE:
      if (Array.isArray(msg.auctions)) {
        state.auctions = msg.auctions;
        populateAuctionSelect();
        showToast('New flash auction available!', 'info');
      }
      break;
    case ServerMsg.AUCTION_STATE:
      handleAuctionState(msg);
      break;
    case ServerMsg.BID_UPDATE:
      handleBidUpdate(msg);
      break;
    case ServerMsg.BID_BATCH_UPDATE:
      handleBatchBidUpdate(msg);
      break;
    case ServerMsg.BID_ACCEPTED:
      handleBidAccepted(msg);
      break;
    case ServerMsg.BID_REJECTED:
      handleBidRejected(msg);
      break;
    case ServerMsg.OUTBID_ALERT:
      handleOutbidAlert(msg);
      break;
    case ServerMsg.AUCTION_COUNTDOWN:
      updateCountdown(msg.remainingMs);
      break;
    case ServerMsg.ANTI_SNIPE_EXTENDED:
      handleAntiSnipeExtended(msg);
      break;
    case ServerMsg.AUCTION_ENDED:
      handleAuctionEnded(msg);
      break;
    case ServerMsg.RATE_LIMITED:
      handleRateLimited(msg);
      break;
    case ServerMsg.PONG:
      if (msg.clientTs && dom.latencyRtt) {
        dom.latencyRtt.textContent = Math.max(1, Date.now() - msg.clientTs);
      }
      break;
    case ServerMsg.ERROR:
      showToast(msg.message || 'Server error', 'error');
      logEvent(`Error: ${msg.message}`, 'bid-reject');
      break;
  }
}

// ── Specific Handlers ──────────────────────────────────────────────────────

function handleInfo(msg) {
  if (!msg.silent && msg.message) {
    logEvent(msg.message, 'info');
  }
  if (msg.bidderCount != null) {
    dom.bidderCount.textContent = msg.bidderCount.toLocaleString();
  }
  if (msg.auctions && msg.auctions.length > 0) {
    state.auctions = msg.auctions;
    populateAuctionSelect();
  }
}

function handleAuctionState(msg) {
  state.bidderId  = msg.bidderId;
  state.auction   = msg.auction;
  state.auctionId = msg.auction.id;

  if (msg.bidderCount != null) {
    dom.bidderCount.textContent = msg.bidderCount.toLocaleString();
  }

  dom.joinBtn.disabled = false;
  dom.joinBtn.textContent = 'Enter Auction ⚡';
  dom.joinScreen.style.display = 'none';
  dom.auctionContainer.classList.add('active');
  dom.endedOverlay.classList.remove('active');
  dom.countdownBar.classList.remove('ended');

  dom.auctionTitle.textContent = state.auction.title;
  dom.auctionSubmeta.textContent = `Signed in as ${state.bidderName} • ${state.auction.items.length} items`;

  renderItems(state.auction.items);
  updateCountdown(state.auction.remainingMs);

  logEvent(`Joined auction: ${state.auction.title}`, 'info');
  showToast('Successfully joined the auction!', 'success');
}

function applySingleItemUpdate(msg) {
  if (!state.auction) return;
  const item = state.auction.items.find(i => i.id === msg.itemId);
  if (!item) return;

  item.currentBid    = msg.currentBid;
  item.cutoffBid     = msg.cutoffBid ?? msg.currentBid;
  item.currentBidder = msg.currentBidder || null;
  item.bidderName    = msg.bidderName;
  item.topBids       = msg.topBids || item.topBids || [];
  item.totalBids     = msg.totalBids;
  item.version       = msg.version;

  if (msg.lastBid) {
    item.bidHistory = item.bidHistory || [];
    item.bidHistory.push(msg.lastBid);
    if (item.bidHistory.length > 15) item.bidHistory.shift();
  }

  updateItemCard(item);
}

function handleBidUpdate(msg) {
  applySingleItemUpdate(msg);
  if (typeof msg.remainingMs === 'number') {
    updateCountdown(msg.remainingMs);
  }
  logEvent(`💰 ${msg.bidderName} bid $${msg.currentBid.toFixed(2)} on ${msg.itemName}`, 'bid-update');
}

function handleBatchBidUpdate(msg) {
  if (!Array.isArray(msg.updates)) return;
  for (const upd of msg.updates) {
    applySingleItemUpdate(upd);
  }
  if (typeof msg.remainingMs === 'number') {
    updateCountdown(msg.remainingMs);
  }
  logEvent(`⚡ Batch sync: ${msg.updates.length} items updated`, 'bid-update');
}

function handleBidAccepted(msg) {
  const card = document.querySelector(`[data-item-id="${msg.itemId}"]`);
  if (card) {
    const feedback = card.querySelector('.bid-feedback');
    feedback.className = 'bid-feedback accepted';
    feedback.textContent = `✓ Bid of $${msg.amount.toFixed(2)} accepted (${msg.processingMs ?? 0} ms)`;
    setTimeout(() => { feedback.className = 'bid-feedback'; }, 3000);
  }

  logEvent(`✅ Your bid of $${msg.amount.toFixed(2)} was accepted!`, 'bid-accept');
  showToast(`Bid accepted: $${msg.amount.toFixed(2)}`, 'success');
}

function handleBidRejected(msg) {
  let reasonText = '';
  switch (msg.reason) {
    case 'BID_TOO_LOW':
      reasonText = `Bid too low. Min required: $${msg.minRequired?.toFixed(2) ?? '--'}`;
      break;
    case 'OWN_BID':
      reasonText = 'You already hold a winning slot on this item!';
      break;
    case 'AUCTION_NOT_ACTIVE':
      reasonText = 'This auction is no longer active.';
      break;
    case 'OUT_OF_STOCK':
      reasonText = 'This item is out of stock.';
      break;
    case 'NOT_JOINED':
      reasonText = 'You must join an auction first.';
      break;
    default:
      reasonText = msg.reason || 'Bid rejected';
  }

  if (msg.itemId) {
    const card = document.querySelector(`[data-item-id="${msg.itemId}"]`);
    if (card) {
      const feedback = card.querySelector('.bid-feedback');
      feedback.className = 'bid-feedback rejected';
      feedback.textContent = `✕ ${reasonText}`;
      setTimeout(() => { feedback.className = 'bid-feedback'; }, 3000);
    }
  }

  logEvent(`❌ Bid rejected: ${reasonText}`, 'bid-reject');
  showToast(reasonText, 'error');
}

function handleOutbidAlert(msg) {
  const text = `⚠️ Outbid on ${msg.itemName}! New leader: ${msg.bidderName} ($${msg.newBid.toFixed(2)})`;
  logEvent(text, 'countdown');
  showToast(text, 'warning');
}

function handleAntiSnipeExtended(msg) {
  if (state.auction && msg.newEndTime) {
    state.auction.endTime = msg.newEndTime;
  }
  if (typeof msg.remainingMs === 'number') {
    updateCountdown(msg.remainingMs);
  }
  if (dom.snipeBanner) {
    dom.snipeBanner.hidden = false;
    clearTimeout(dom.snipeBanner._hideTimer);
    dom.snipeBanner._hideTimer = setTimeout(() => {
      dom.snipeBanner.hidden = true;
    }, 4500);
  }
  const label = msg.reason === 'ADMIN_EXTENDED'
    ? `⏱️ Admin extended auction by +${msg.extensionSec}s`
    : `🛡️ Anti-snipe triggered! Timer extended by +${msg.extensionSec}s`;
  logEvent(label, 'countdown');
  showToast(label, 'warning');
}

function handleAuctionEnded(msg) {
  if (state.auction && msg.auctionId === state.auction.id) {
    state.auction.status = 'ENDED';
    updateCountdown(0);
  }

  logEvent(`🏁 Auction ended! ${msg.winners.length} winning allocation(s).`, 'info');

  dom.winnersList.innerHTML = '';
  if (msg.winners.length === 0) {
    dom.winnersList.innerHTML = '<div class="winner-item"><div class="winner-info"><div class="item-name">No bids placed in this auction</div></div></div>';
  } else {
    for (const winner of msg.winners) {
      const isYou = winner.winnerId === state.bidderId;
      const div = document.createElement('div');
      div.className = `winner-item${isYou ? ' you-won' : ''}`;
      const unitTag = winner.unitNumber && winner.unitNumber > 1 ? ` (Unit #${winner.unitNumber})` : '';
      div.innerHTML = `
        <div class="winner-info">
          <div class="item-name">${escapeHtml(winner.itemName)}${unitTag}</div>
          <div class="winner-name">${isYou ? '🏆 YOU WON!' : `Winner: ${escapeHtml(winner.winnerName)}`}</div>
        </div>
        <div class="winning-bid">$${winner.winningBid.toFixed(2)}</div>
      `;
      dom.winnersList.appendChild(div);
    }
  }

  dom.endedOverlay.classList.add('active');

  if (msg.winners.some(w => w.winnerId === state.bidderId)) {
    showToast('🏆 Congratulations! You won an item!', 'success');
  }
}

function handleRateLimited(msg) {
  logEvent(`⚠️ Rate limited. Retry in ${msg.retryAfterMs}ms`, 'countdown');
  showToast(`Slow down! Try again in ${(msg.retryAfterMs / 1000).toFixed(1)}s`, 'warning');

  document.querySelectorAll('.btn-bid').forEach((btn) => {
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, msg.retryAfterMs);
  });
}

// ── UI Rendering ───────────────────────────────────────────────────────────

function populateAuctionSelect() {
  const prevVal = dom.auctionSelect.value;
  dom.auctionSelect.innerHTML = '';
  for (const a of state.auctions) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.title} (${a.status})`;
    dom.auctionSelect.appendChild(opt);
  }
  if (prevVal && state.auctions.some(a => a.id === prevVal)) {
    dom.auctionSelect.value = prevVal;
  }
}

function isUserWinningItem(item) {
  if (!state.bidderId) return false;
  if (item.currentBidder === state.bidderId) return true;
  if (Array.isArray(item.topBids)) {
    return item.topBids.some(b => b.bidderId === state.bidderId);
  }
  return false;
}

function getMinRequiredBid(item) {
  if (item.stock > 1) {
    const slotsFilled = Array.isArray(item.topBids) && item.topBids.length >= item.stock;
    const base = slotsFilled ? (item.cutoffBid || item.currentBid) : item.startingPrice;
    return base + 1;
  }
  return item.currentBid + 1;
}

function renderItems(items) {
  dom.itemsGrid.innerHTML = '';

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'item-card';
    card.dataset.itemId = item.id;

    const isWinning = isUserWinningItem(item);
    if (isWinning) card.classList.add('winning');

    const minBid = getMinRequiredBid(item);

    card.innerHTML = `
      <div class="item-header">
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-badges">
          <span class="stock-badge">${item.stock} ${item.stock > 1 ? 'units' : 'unit'}</span>
          <span class="bid-count"><span class="total-bids">${item.totalBids}</span> bids</span>
        </div>
      </div>
      <div class="item-description">${escapeHtml(item.description)}</div>
      <div class="price-section">
        <div>
          <div class="current-bid-label">${item.stock > 1 ? 'Highest Bid' : 'Current Bid'}</div>
          <div class="current-bid-amount">$<span class="bid-amount">${item.currentBid.toFixed(2)}</span></div>
        </div>
        <div class="starting-price">
          <div>Starting: $${item.startingPrice.toFixed(2)}</div>
          ${item.stock > 1 ? `<div class="cutoff-line">Cutoff: $<span class="cutoff-bid">${(item.cutoffBid || item.startingPrice).toFixed(2)}</span></div>` : ''}
        </div>
      </div>
      <div class="bid-leader ${isWinning ? 'you-winning' : ''}">
        ${renderLeaderText(item, isWinning)}
      </div>
      <div class="quick-bids">
        <button type="button" class="btn-quick" onclick="quickBid('${item.id}', 1)">+$1</button>
        <button type="button" class="btn-quick" onclick="quickBid('${item.id}', 10)">+$10</button>
        <button type="button" class="btn-quick" onclick="quickBid('${item.id}', 50)">+$50</button>
        <button type="button" class="btn-quick" onclick="quickBid('${item.id}', 100)">+$100</button>
      </div>
      <div class="bid-form">
        <div class="bid-input-wrapper">
          <span class="currency">$</span>
          <input type="number" class="bid-input"
                 placeholder="${minBid.toFixed(2)}"
                 min="${minBid.toFixed(2)}"
                 step="1"
                 data-item-id="${item.id}">
        </div>
        <button class="btn-bid" onclick="placeBid('${item.id}', this)" data-item-id="${item.id}">
          Bid Now
        </button>
      </div>
      <div class="bid-feedback"></div>
      <button class="bid-history-toggle" onclick="toggleHistory(this)">
        ▶ Bid History
      </button>
      <div class="bid-history">
        ${renderBidHistory(item.bidHistory || [])}
      </div>
    `;

    dom.itemsGrid.appendChild(card);

    const input = card.querySelector('.bid-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        placeBid(item.id, card.querySelector('.btn-bid'));
      }
    });
  }
}

function renderLeaderText(item, isWinning) {
  if (!item.bidderName) {
    return '<em>No bids yet — be the first!</em>';
  }
  if (item.stock > 1 && Array.isArray(item.topBids) && item.topBids.length > 0) {
    const slots = item.topBids.map((b, idx) => {
      const me = b.bidderId === state.bidderId;
      return `<span class="slot-chip ${me ? 'mine' : ''}">#${idx + 1} ${me ? 'YOU' : escapeHtml(b.bidderName)} ($${b.amount.toFixed(0)})</span>`;
    }).join(' ');
    return `Top ${item.stock} Slots: ${slots}`;
  }
  return `Leading bidder: <strong>${isWinning ? '🏆 YOU' : escapeHtml(item.bidderName)}</strong>`;
}

function updateItemCard(item) {
  const card = document.querySelector(`[data-item-id="${item.id}"]`);
  if (!card) return;

  const isWinning = isUserWinningItem(item);
  card.classList.toggle('winning', isWinning);
  card.classList.toggle('outbid', !isWinning && item.bidderName != null && item.totalBids > 0);

  card.querySelector('.bid-amount').textContent = item.currentBid.toFixed(2);
  card.querySelector('.total-bids').textContent = item.totalBids;

  const cutoffEl = card.querySelector('.cutoff-bid');
  if (cutoffEl) {
    cutoffEl.textContent = (item.cutoffBid || item.startingPrice).toFixed(2);
  }

  const leaderEl = card.querySelector('.bid-leader');
  leaderEl.className = `bid-leader ${isWinning ? 'you-winning' : ''}`;
  leaderEl.innerHTML = renderLeaderText(item, isWinning);

  const minBid = getMinRequiredBid(item);
  const input  = card.querySelector('.bid-input');
  input.placeholder = minBid.toFixed(2);
  input.min         = minBid.toFixed(2);

  const historyEl = card.querySelector('.bid-history');
  if (historyEl) {
    historyEl.innerHTML = renderBidHistory(item.bidHistory || []);
  }

  card.style.transition = 'none';
  card.style.boxShadow  = isWinning
    ? '0 0 28px rgba(34,197,94,0.4)'
    : '0 0 28px rgba(59,130,246,0.35)';
  setTimeout(() => {
    card.style.transition = 'box-shadow 0.45s ease';
    card.style.boxShadow  = '';
  }, 50);
}

function renderBidHistory(history) {
  if (!history || history.length === 0) {
    return '<div style="color:var(--text-muted);font-size:0.8rem;padding:8px 0;">No bids yet</div>';
  }
  return history.slice().reverse().map(b => `
    <div class="bid-history-item">
      <span class="bidder">${escapeHtml(b.bidderName)}</span>
      <span class="amount">$${b.amount.toFixed(2)}</span>
      <span class="time">${new Date(b.timestamp).toLocaleTimeString()}</span>
    </div>
  `).join('');
}

// ── Countdown ──────────────────────────────────────────────────────────────

let countdownInterval = null;
let auctionEndTime    = 0;

function updateCountdown(remainingMs) {
  auctionEndTime = Date.now() + Math.max(0, remainingMs);

  if (countdownInterval) clearInterval(countdownInterval);

  const tick = () => {
    const left     = Math.max(0, auctionEndTime - Date.now());
    const totalSec = Math.ceil(left / 1000);
    const min      = Math.floor(totalSec / 60);
    const sec      = totalSec % 60;

    dom.timeRemaining.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    const totalDuration = state.auction ? Math.max(1000, state.auction.endTime - state.auction.startTime) : 120000;
    const progress = Math.max(0, Math.min(100, (left / totalDuration) * 100));
    dom.progressBar.style.width = `${progress}%`;

    if (left <= 0) {
      dom.countdownBar.classList.add('ended');
      dom.countdownBar.classList.remove('urgent');
      dom.timeLabel.textContent = 'AUCTION ENDED';
      clearInterval(countdownInterval);
    } else if (left <= 10000) {
      dom.countdownBar.classList.add('urgent');
      dom.timeLabel.textContent = '⚡ FINAL SECONDS — BID NOW!';
    } else if (left <= 30000) {
      dom.countdownBar.classList.remove('urgent');
      dom.timeLabel.textContent = '⏰ Ending soon!';
    } else {
      dom.countdownBar.classList.remove('urgent');
      dom.timeLabel.textContent = 'Time Remaining';
    }
  };

  tick();
  countdownInterval = setInterval(tick, 200);
}

// ── Actions ────────────────────────────────────────────────────────────────

function joinAuction() {
  const name      = dom.nameInput.value.trim();
  const auctionId = dom.auctionSelect.value;

  if (!name) {
    showToast('Please enter your name', 'warning');
    dom.nameInput.focus();
    return;
  }

  if (!auctionId) {
    showToast('No auction available', 'error');
    return;
  }

  state.bidderName = name;
  dom.joinBtn.disabled = true;
  dom.joinBtn.textContent = 'Joining...';

  send({
    type:       ClientMsg.JOIN_AUCTION,
    auctionId,
    bidderName: name,
  });

  setTimeout(() => {
    dom.joinBtn.disabled = false;
    dom.joinBtn.textContent = 'Enter Auction ⚡';
  }, 3000);
}

function leaveAuction() {
  send({ type: ClientMsg.LEAVE_AUCTION });
  state.auctionId = null;
  state.auction   = null;
  state.bidderId  = null;
  state.pendingAutoRejoin = false;
  if (countdownInterval) clearInterval(countdownInterval);

  dom.endedOverlay.classList.remove('active');
  dom.auctionContainer.classList.remove('active');
  dom.joinScreen.style.display = 'flex';
}

window.quickBid = function quickBid(itemId, increment) {
  const item = state.auction?.items.find(i => i.id === itemId);
  const card = document.querySelector(`[data-item-id="${itemId}"]`);
  if (!item || !card) return;

  const base = (item.stock > 1 && Array.isArray(item.topBids) && item.topBids.length >= item.stock)
    ? (item.cutoffBid || item.currentBid)
    : (item.stock > 1 ? item.startingPrice : item.currentBid);

  const amount = Number((base + increment).toFixed(2));
  const btn    = card.querySelector('.btn-bid');
  submitBid(itemId, amount, btn);
};

window.placeBid = function placeBid(itemId, btnElement) {
  const card   = document.querySelector(`[data-item-id="${itemId}"]`);
  const input  = card.querySelector('.bid-input');
  const amount = parseFloat(input.value);

  if (!amount || Number.isNaN(amount) || amount <= 0) {
    const item = state.auction?.items.find(i => i.id === itemId);
    if (item) {
      input.value = getMinRequiredBid(item).toFixed(2);
    }
    showToast('Enter a valid bid amount', 'warning');
    input.focus();
    return;
  }

  submitBid(itemId, amount, btnElement);
  input.value = '';
};

function submitBid(itemId, amount, btnElement) {
  if (btnElement) {
    btnElement.disabled = true;
    setTimeout(() => { btnElement.disabled = false; }, 350);
  }
  send({
    type:   ClientMsg.PLACE_BID,
    itemId,
    amount,
  });
}

window.toggleHistory = function toggleHistory(btn) {
  const history  = btn.nextElementSibling;
  const expanded = history.classList.toggle('expanded');
  btn.textContent = expanded ? '▼ Bid History' : '▶ Bid History';
};

// ── Event Log & Toasts ─────────────────────────────────────────────────────

function logEvent(message, className = 'info') {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-msg ${className}">${escapeHtml(message)}</span>
  `;
  dom.eventLog.prepend(entry);
  while (dom.eventLog.children.length > 100) {
    dom.eventLog.removeChild(dom.eventLog.lastChild);
  }
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 3000);
}

function updateStatus(status) {
  dom.statusDot.className = `status-dot ${status}`;
  const labels = { connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting...' };
  dom.statusText.textContent = labels[status] || status;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// ── Auth Session ───────────────────────────────────────────────────────────

async function loadAuthUser() {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (res.status === 401) {
      window.location.replace('/login');
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.authenticated || !data.user) {
      window.location.replace('/login');
      return null;
    }

    state.user = data.user;
    if (dom.userPill && dom.userDisplayName && dom.userAvatar) {
      dom.userDisplayName.textContent = data.user.fullName || data.user.email;
      if (data.user.avatarUrl) {
        dom.userAvatar.innerHTML = `<img src="${escapeHtml(data.user.avatarUrl)}" alt="">`;
      } else {
        const initials = (data.user.fullName || data.user.email || '?')
          .split(/\s+/)
          .map((w) => w[0])
          .join('')
          .slice(0, 2)
          .toUpperCase();
        dom.userAvatar.textContent = initials;
      }
      dom.userPill.hidden = false;
    }
    if (dom.logoutBtn) dom.logoutBtn.hidden = false;
    if (dom.nameInput && !dom.nameInput.value) {
      dom.nameInput.value = data.user.fullName || '';
    }
    return data.user;
  } catch {
    return null;
  }
}

async function logoutUser() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.replace('/login');
  }
}

// ── Initialise ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const user = await loadAuthUser();
  if (!user) return;

  initPwa();
  connect();

  if (dom.logoutBtn) dom.logoutBtn.addEventListener('click', logoutUser);

  dom.joinBtn.addEventListener('click', joinAuction);
  dom.nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinAuction();
  });

  if (dom.leaveBtn) dom.leaveBtn.addEventListener('click', leaveAuction);

  const closeBtn  = document.getElementById('close-ended');
  const switchBtn = document.getElementById('switch-after-end');
  if (closeBtn) closeBtn.addEventListener('click', () => dom.endedOverlay.classList.remove('active'));
  if (switchBtn) switchBtn.addEventListener('click', leaveAuction);
});
