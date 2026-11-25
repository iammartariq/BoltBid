// ============================================================================
// client/admin.js — Admin Analytics & Operations Controller
// ============================================================================

'use strict';

const adminState = {
  ws: null,
  connected: false,
  metrics: null,
  adminKey: localStorage.getItem('flashAuctionAdminKey') || '',
  deferredInstallPrompt: null,
  activeHistoryTab: 'bids',
};

const $ = (sel) => document.querySelector(sel);

const dom = {
  wsDot:          $('#admin-ws-dot'),
  wsText:         $('#admin-ws-text'),
  dbBadge:        $('#db-mode-badge'),
  uptimeVal:      $('#uptime-val'),
  installBtn:     $('#install-pwa-btn'),
  authBar:        $('#admin-auth-bar'),
  adminKeyInput:  $('#admin-key-input'),
  saveKeyBtn:     $('#save-admin-key'),
  adminUserPill:  $('#admin-user-pill'),
  adminUserBadge: $('#admin-username-badge'),
  adminLogoutBtn: $('#admin-logout-btn'),

  kpiConnections:  $('#kpi-connections'),
  kpiPeakConn:     $('#kpi-peak-conn'),
  kpiConnBar:      $('#kpi-conn-bar'),
  kpiBps:          $('#kpi-bps'),
  kpiTotalBids:    $('#kpi-total-bids'),
  kpiAcceptRate:   $('#kpi-accept-rate'),
  kpiAccepted:     $('#kpi-accepted'),
  kpiRejected:     $('#kpi-rejected'),
  kpiRatelim:      $('#kpi-ratelim'),
  kpiP95:          $('#kpi-p95'),
  kpiP50:          $('#kpi-p50'),
  kpiLag:          $('#kpi-lag'),
  kpiGmv:          $('#kpi-gmv'),
  kpiAuctionCount: $('#kpi-auction-count'),
  kpiHeap:         $('#kpi-heap'),
  kpiSnipes:       $('#kpi-snipes'),
  kpiDropped:      $('#kpi-dropped'),

  chartThroughput: $('#chart-throughput'),
  chartLatency:    $('#chart-latency'),
  rejectionBars:   $('#rejection-bars'),

  simStatusPill:   $('#sim-status-pill'),
  simAuction:      $('#sim-auction'),
  simBidders:      $('#sim-bidders'),
  simDuration:     $('#sim-duration'),
  simJump10s:      $('#sim-jump-10s'),
  startSimBtn:     $('#start-sim-btn'),
  stopSimBtn:      $('#stop-sim-btn'),

  createForm:      $('#create-auction-form'),
  newTitle:        $('#new-auction-title'),
  newDuration:     $('#new-auction-duration'),
  newItemsList:    $('#new-items-list'),
  addItemRowBtn:   $('#add-item-row'),

  auctionsTbody:   $('#auctions-tbody'),
  itemsTbody:      $('#items-tbody'),
  biddersTbody:    $('#bidders-tbody'),
  recentBidsTbody: $('#recent-bids-tbody'),
  winnersTbody:    $('#winners-history-tbody'),
  historyBidsWrap: $('#history-bids-wrap'),
  historyWinWrap:  $('#history-winners-wrap'),
  dbDetailSub:     $('#db-detail-sub'),
  refreshHistBtn:  $('#refresh-history-btn'),
  toastContainer:  $('.toast-container'),
};

// ── PWA Setup ──────────────────────────────────────────────────────────────

function initPwa() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    adminState.deferredInstallPrompt = e;
    if (dom.installBtn) dom.installBtn.hidden = false;
  });
  if (dom.installBtn) {
    dom.installBtn.addEventListener('click', async () => {
      if (!adminState.deferredInstallPrompt) return;
      adminState.deferredInstallPrompt.prompt();
      await adminState.deferredInstallPrompt.userChoice;
      adminState.deferredInstallPrompt = null;
      dom.installBtn.hidden = true;
    });
  }
}

// ── API Helper ─────────────────────────────────────────────────────────────

async function apiRequest(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (adminState.adminKey) headers['x-admin-key'] = adminState.adminKey;

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.replace('/admin/login');
    throw new Error(data.error || 'Admin authentication required.');
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// ── WebSocket Telemetry Stream ─────────────────────────────────────────────

function connectAdminWs() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl    = `${protocol}//${window.location.host}/ws`;

  setWsStatus('connecting');
  adminState.ws = new WebSocket(wsUrl);

  adminState.ws.onopen = () => {
    adminState.connected = true;
    setWsStatus('connected');
    adminState.ws.send(JSON.stringify({
      type:     'SUBSCRIBE_ADMIN',
      adminKey: adminState.adminKey || undefined,
    }));
  };

  adminState.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'ADMIN_METRICS' && msg.metrics) {
        adminState.metrics = msg.metrics;
        renderDashboard(msg.metrics);
      } else if (msg.type === 'ERROR') {
        showToast(msg.message || 'Telemetry error', 'error');
        if (String(msg.message || '').toLowerCase().includes('unauthorized') && dom.authBar) {
          dom.authBar.hidden = false;
        }
      }
    } catch (err) {
      console.error('Admin WS parse error:', err);
    }
  };

  adminState.ws.onclose = () => {
    adminState.connected = false;
    setWsStatus('disconnected');
    setTimeout(connectAdminWs, 2000);
  };
}

function setWsStatus(status) {
  dom.wsDot.className = `status-dot ${status}`;
  const labels = { connected: 'Live Stream', disconnected: 'Reconnecting...', connecting: 'Connecting...' };
  dom.wsText.textContent = labels[status] || status;
}

// ── Render Dashboard ───────────────────────────────────────────────────────

function renderDashboard(m) {
  const k = m.kpis;
  const l = m.latency;
  const h = m.systemHealth;

  dom.uptimeVal.textContent = formatDuration(m.uptimeSec * 1000);

  // DB Badge
  const db = m.dbStatus || {};
  dom.dbBadge.textContent = `DB: ${String(db.mode || 'local').toUpperCase()} (${db.totalPersistedBids || 0} bids)`;
  dom.dbBadge.classList.toggle('supabase', db.mode === 'supabase');
  dom.dbDetailSub.textContent = `Mode: ${db.mode || 'local'} • Pending write-behind: ${db.pendingWrites || 0} • Persisted bids: ${db.totalPersistedBids || 0}`;

  // KPIs
  dom.kpiConnections.textContent = k.activeConnections.toLocaleString();
  dom.kpiPeakConn.textContent    = k.peakConcurrentConnections.toLocaleString();
  const connPct = Math.min(100, (k.activeConnections / 50000) * 100);
  dom.kpiConnBar.style.width = `${Math.max(k.activeConnections > 0 ? 2 : 0, connPct)}%`;

  dom.kpiBps.innerHTML        = `${k.bidsPerSec.toLocaleString()} <span class="unit">bids/s</span>`;
  dom.kpiTotalBids.textContent = k.totalBidsReceived.toLocaleString();

  dom.kpiAcceptRate.textContent = `${k.acceptanceRate}%`;
  dom.kpiAccepted.textContent   = k.totalBidsAccepted.toLocaleString();
  dom.kpiRejected.textContent   = k.totalBidsRejected.toLocaleString();
  dom.kpiRatelim.textContent    = k.totalRateLimited.toLocaleString();

  dom.kpiP95.innerHTML   = `${l.p95.toFixed(2)} <span class="unit">ms</span>`;
  dom.kpiP50.textContent = l.p50.toFixed(2);
  dom.kpiLag.textContent = h.eventLoopLagMs.toFixed(1);

  dom.kpiGmv.textContent          = `$${k.totalGmv.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  dom.kpiAuctionCount.textContent = m.auctions.length;

  dom.kpiHeap.innerHTML    = `${h.heapUsedMB.toFixed(1)} <span class="unit">MB</span>`;
  dom.kpiSnipes.textContent  = k.totalAntiSnipeExtensions;
  dom.kpiDropped.textContent = k.droppedBackpressureFrames;

  // Simulator Status
  const sim = m.simulatorStatus || {};
  dom.simStatusPill.textContent = sim.running
    ? `Running (${sim.virtualBidders} bots • ${sim.bidsSent} bids)`
    : 'Idle';
  dom.simStatusPill.classList.toggle('running', Boolean(sim.running));
  dom.startSimBtn.disabled = Boolean(sim.running);
  dom.stopSimBtn.disabled  = !sim.running;

  // Charts & Breakdowns
  drawThroughputChart(m.timeSeries || []);
  drawLatencyChart(m.timeSeries || []);
  renderBreakdownBars(k, m.rejectionsByReason || {});

  // Tables
  populateSimulatorAuctions(m.auctions);
  renderAuctionsTable(m.auctions);
  renderItemsTable(m.auctions);
  renderTopBidders(m.topBidders || []);
  renderRecentBids(m.recentBids || []);
}

// ── Canvas Charts (High-DPI, Zero External Dependencies) ───────────────────

function prepareCanvas(canvas) {
  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w    = Math.max(300, Math.floor(rect.width));
  const h    = 220;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawGrid(ctx, w, h, pad, maxVal, unitLabel) {
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  ctx.lineWidth   = 1;
  ctx.fillStyle   = '#64748b';
  ctx.font        = '11px JetBrains Mono, monospace';

  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = pad.top + ((h - pad.top - pad.bottom) * i) / steps;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();

    const val = maxVal * (1 - i / steps);
    const lbl = val >= 10 ? Math.round(val) : val.toFixed(1);
    ctx.fillText(`${lbl}${unitLabel}`, 6, y + 4);
  }
}

function drawSeriesLine(ctx, series, accessor, w, h, pad, maxVal, color, fillAlpha = 0) {
  if (series.length === 0) return;
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  const getPoint = (idx) => {
    const x = series.length === 1
      ? pad.left + plotW
      : pad.left + (idx / (series.length - 1)) * plotW;
    const v = Math.max(0, Number(accessor(series[idx]) || 0));
    const y = pad.top + plotH - (v / maxVal) * plotH;
    return [x, y];
  };

  ctx.beginPath();
  series.forEach((_, idx) => {
    const [x, y] = getPoint(idx);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth   = 2.2;
  ctx.stroke();

  if (fillAlpha > 0 && series.length > 1) {
    const [lastX]  = getPoint(series.length - 1);
    const [firstX] = getPoint(0);
    ctx.lineTo(lastX, pad.top + plotH);
    ctx.lineTo(firstX, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = color.replace('rgb(', 'rgba(').replace(')', `, ${fillAlpha})`);
    if (color.startsWith('#')) {
      ctx.globalAlpha = fillAlpha;
      ctx.fillStyle   = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.fill();
    }
  }
}

function drawThroughputChart(series) {
  const { ctx, w, h } = prepareCanvas(dom.chartThroughput);
  const pad = { top: 14, right: 12, bottom: 18, left: 46 };
  const maxVal = Math.max(
    10,
    ...series.map(p => Math.max(p.acceptedPerSec || 0, p.rejectedPerSec || 0, p.rateLimitedPerSec || 0))
  ) * 1.15;

  drawGrid(ctx, w, h, pad, maxVal, '');
  drawSeriesLine(ctx, series, p => p.acceptedPerSec, w, h, pad, maxVal, '#22c55e', 0.14);
  drawSeriesLine(ctx, series, p => p.rejectedPerSec, w, h, pad, maxVal, '#ef4444', 0.08);
  drawSeriesLine(ctx, series, p => p.rateLimitedPerSec, w, h, pad, maxVal, '#f59e0b', 0);
}

function drawLatencyChart(series) {
  const { ctx, w, h } = prepareCanvas(dom.chartLatency);
  const pad = { top: 14, right: 12, bottom: 18, left: 50 };
  const maxLat = Math.max(1, ...series.map(p => p.p95LatencyMs || 0)) * 1.25;
  const maxCon = Math.max(1, ...series.map(p => p.activeConnections || 0)) * 1.2;

  drawGrid(ctx, w, h, pad, maxLat, 'ms');
  drawSeriesLine(ctx, series, p => p.p95LatencyMs, w, h, pad, maxLat, '#3b82f6', 0.15);
  drawSeriesLine(ctx, series, p => ((p.activeConnections || 0) / maxCon) * maxLat, w, h, pad, maxLat, '#06b6d4', 0);
}

function renderBreakdownBars(kpis, reasons) {
  const total = kpis.totalBidsReceived;
  if (!total) {
    dom.rejectionBars.innerHTML = '<div class="empty-note">Waiting for bid traffic...</div>';
    return;
  }

  const rows = [
    { label: 'ACCEPTED', count: kpis.totalBidsAccepted, color: '#22c55e' },
    ...Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({
        label: reason,
        count,
        color: reason === 'RATE_LIMITED' ? '#f59e0b' : '#ef4444',
      })),
  ];

  dom.rejectionBars.innerHTML = rows.map(r => {
    const pct = ((r.count / total) * 100).toFixed(1);
    return `
      <div class="breakdown-item">
        <div class="breakdown-meta">
          <span>${escapeHtml(r.label)}</span>
          <span>${r.count.toLocaleString()} (${pct}%)</span>
        </div>
        <div class="breakdown-track">
          <div class="breakdown-fill" style="width:${pct}%; background:${r.color}"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Tables ─────────────────────────────────────────────────────────────────

function populateSimulatorAuctions(auctions) {
  const active = auctions.filter(a => a.status !== 'ENDED');
  const prev   = dom.simAuction.value;
  dom.simAuction.innerHTML = active.length
    ? active.map(a => `<option value="${a.id}">${escapeHtml(a.title)} (${a.status})</option>`).join('')
    : '<option value="">No active auctions</option>';
  if (prev && active.some(a => a.id === prev)) dom.simAuction.value = prev;
}

function renderAuctionsTable(auctions) {
  if (!auctions.length) {
    dom.auctionsTbody.innerHTML = '<tr><td colspan="8" class="empty-note">No auctions created yet</td></tr>';
    return;
  }

  dom.auctionsTbody.innerHTML = auctions.map(a => {
    const ended = a.status === 'ENDED';
    return `
      <tr>
        <td><strong>${escapeHtml(a.title)}</strong></td>
        <td><span class="status-badge ${a.status}">${a.status}</span></td>
        <td class="mono">${ended ? '00:00' : formatDuration(a.remainingMs)}</td>
        <td class="mono">${a.bidderCount.toLocaleString()}</td>
        <td class="mono">${a.totalBids.toLocaleString()}</td>
        <td class="mono">${a.queueDepth}</td>
        <td class="mono text-success">$${a.gmv.toFixed(2)}</td>
        <td>
          <div class="ctrl-group">
            <button class="btn btn-secondary btn-sm" ${ended ? 'disabled' : ''} onclick="adminAction('${a.id}','final-countdown',{remainingSec:10})">⚡ 10s Rush</button>
            <button class="btn btn-secondary btn-sm" ${ended ? 'disabled' : ''} onclick="adminAction('${a.id}','extend',{extraSec:30})">+30s</button>
            <button class="btn btn-danger btn-sm" ${ended ? 'disabled' : ''} onclick="adminAction('${a.id}','end',{})">🏁 End</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderItemsTable(auctions) {
  const rows = [];
  for (const a of auctions) {
    for (const item of a.items) {
      rows.push(`
        <tr>
          <td><strong>${escapeHtml(item.name)}</strong></td>
          <td class="mono">${item.filledSlots}/${item.stock}</td>
          <td class="mono">$${item.startingPrice.toFixed(0)} → <span class="text-success">$${item.currentBid.toFixed(2)}</span></td>
          <td class="mono">${item.upliftPct > 0 ? `+${item.upliftPct}%` : '0%'}</td>
          <td class="mono">${item.totalBids}</td>
          <td>${item.bidderName ? escapeHtml(item.bidderName) : '<span style="color:var(--text-muted)">—</span>'}</td>
        </tr>
      `);
    }
  }
  dom.itemsTbody.innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="6" class="empty-note">No items yet</td></tr>';
}

function renderTopBidders(bidders) {
  if (!bidders.length) {
    dom.biddersTbody.innerHTML = '<tr><td colspan="5" class="empty-note">No accepted bids yet</td></tr>';
    return;
  }
  dom.biddersTbody.innerHTML = bidders.map((b, idx) => `
    <tr>
      <td class="mono">#${idx + 1}</td>
      <td><strong>${escapeHtml(b.bidderName)}</strong></td>
      <td class="mono">${b.accepted}</td>
      <td class="mono text-success">$${b.maxBid.toFixed(2)}</td>
      <td class="mono">$${b.totalVolume.toFixed(2)}</td>
    </tr>
  `).join('');
}

function renderRecentBids(bids) {
  if (!bids.length) {
    dom.recentBidsTbody.innerHTML = '<tr><td colspan="5" class="empty-note">No recent accepted bids</td></tr>';
    return;
  }
  dom.recentBidsTbody.innerHTML = bids.slice(0, 25).map(b => `
    <tr>
      <td class="mono">${new Date(b.timestamp || b.created_at).toLocaleTimeString()}</td>
      <td><strong>${escapeHtml(b.bidderName || b.bidder_name)}</strong></td>
      <td>${escapeHtml(b.itemName || b.item_name)}</td>
      <td class="mono text-success">$${Number(b.amount).toFixed(2)}</td>
      <td class="mono">${Number(b.processingMs ?? b.processing_ms ?? 0).toFixed(3)} ms</td>
    </tr>
  `).join('');
}

async function loadHistory() {
  try {
    const data = await apiRequest('/api/admin/history');
    const winners = data.winnersHistory || [];
    if (!winners.length) {
      dom.winnersTbody.innerHTML = '<tr><td colspan="6" class="empty-note">No completed auctions persisted yet</td></tr>';
    } else {
      dom.winnersTbody.innerHTML = winners.map(w => `
        <tr>
          <td class="mono">${new Date(w.ended_at).toLocaleTimeString()}</td>
          <td>${escapeHtml(w.auction_title)}</td>
          <td>${escapeHtml(w.item_name)} ${w.unit_number > 1 ? `(Unit #${w.unit_number})` : ''}</td>
          <td><strong>${escapeHtml(w.winner_name)}</strong></td>
          <td class="mono text-success">$${Number(w.winning_bid).toFixed(2)}</td>
          <td class="mono">${w.total_bids}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Admin Actions & Item Builder ───────────────────────────────────────────

window.adminAction = async function adminAction(auctionId, endpoint, payload) {
  try {
    await apiRequest(`/api/admin/auctions/${encodeURIComponent(auctionId)}/${endpoint}`, {
      method: 'POST',
      body:   JSON.stringify(payload || {}),
    });
    showToast(`Executed ${endpoint} successfully`, 'success');
    const snap = await apiRequest('/api/admin/analytics');
    renderDashboard(snap);
    if (endpoint === 'end') loadHistory();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

function addBuilderItemRow(defaults = {}) {
  const row = document.createElement('div');
  row.className = 'item-builder-row';
  row.innerHTML = `
    <input type="text" class="item-name-in" placeholder="Item Name" value="${escapeHtml(defaults.name || '')}" required>
    <input type="number" class="item-price-in" placeholder="Start $" value="${defaults.startingPrice || 100}" min="1" required>
    <input type="number" class="item-stock-in" placeholder="Stock" value="${defaults.stock || 1}" min="1" max="100" required>
    <button type="button" class="btn btn-danger btn-sm remove-row-btn">✕</button>
  `;
  row.querySelector('.remove-row-btn').addEventListener('click', () => {
    if (dom.newItemsList.children.length > 1) row.remove();
  });
  dom.newItemsList.appendChild(row);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 3200);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

// ── Admin Session Verification ─────────────────────────────────────────────

async function verifyAdminSession() {
  try {
    const res = await fetch('/api/admin/me', { cache: 'no-store' });
    if (res.status === 401) {
      window.location.replace('/admin/login');
      return false;
    }
    if (res.ok) {
      const data = await res.json();
      if (data.admin?.username && dom.adminUserBadge && dom.adminUserPill) {
        dom.adminUserBadge.textContent = data.admin.username;
        dom.adminUserPill.hidden = false;
      }
      return true;
    }
  } catch {
    // Allow fallback if transient network error
  }
  return true;
}

// ── Initialise ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const authed = await verifyAdminSession();
  if (!authed) return;

  if (dom.adminLogoutBtn) {
    dom.adminLogoutBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/admin/logout', { method: 'POST' });
      } finally {
        window.location.replace('/admin/login');
      }
    });
  }

  initPwa();
  addBuilderItemRow({ name: 'NVIDIA RTX 5090 Founders Edition', startingPrice: 1000, stock: 1 });
  addBuilderItemRow({ name: 'Custom Mechanical Keyboard (2 Units)', startingPrice: 120, stock: 2 });

  dom.addItemRowBtn.addEventListener('click', () => addBuilderItemRow());

  if (dom.saveKeyBtn) {
    dom.saveKeyBtn.addEventListener('click', () => {
      adminState.adminKey = dom.adminKeyInput.value.trim();
      localStorage.setItem('flashAuctionAdminKey', adminState.adminKey);
      dom.authBar.hidden = true;
      showToast('Admin key saved', 'success');
      if (adminState.ws && adminState.ws.readyState === WebSocket.OPEN) {
        adminState.ws.send(JSON.stringify({ type: 'SUBSCRIBE_ADMIN', adminKey: adminState.adminKey }));
      }
    });
  }

  dom.startSimBtn.addEventListener('click', async () => {
    try {
      await apiRequest('/api/admin/simulate', {
        method: 'POST',
        body: JSON.stringify({
          action:         'start',
          auctionId:      dom.simAuction.value || undefined,
          bidders:        Number(dom.simBidders.value),
          durationSec:    Number(dom.simDuration.value),
          jumpToFinal10s: dom.simJump10s.checked,
        }),
      });
      showToast('Flash traffic spike simulator launched!', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  dom.stopSimBtn.addEventListener('click', async () => {
    try {
      await apiRequest('/api/admin/simulate', {
        method: 'POST',
        body: JSON.stringify({ action: 'stop' }),
      });
      showToast('Simulator stopped', 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  dom.createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const rows = Array.from(dom.newItemsList.querySelectorAll('.item-builder-row'));
    const items = rows.map(r => ({
      name:          r.querySelector('.item-name-in').value.trim(),
      startingPrice: Number(r.querySelector('.item-price-in').value),
      stock:         Number(r.querySelector('.item-stock-in').value),
      description:   'Flash auction limited release item',
    })).filter(it => it.name);

    try {
      const created = await apiRequest('/api/admin/auctions', {
        method: 'POST',
        body: JSON.stringify({
          title:       dom.newTitle.value.trim(),
          durationSec: Number(dom.newDuration.value),
          items,
        }),
      });
      dom.newTitle.value = '';
      showToast(`Created "${created.title}"!`, 'success');
      const snap = await apiRequest('/api/admin/analytics');
      renderDashboard(snap);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-history-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-history-tab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.historyTab;
      dom.historyBidsWrap.hidden = tab !== 'bids';
      dom.historyWinWrap.hidden  = tab !== 'winners';
      if (tab === 'winners') loadHistory();
    });
  });

  dom.refreshHistBtn.addEventListener('click', loadHistory);

  try {
    const initial = await apiRequest('/api/admin/analytics');
    renderDashboard(initial);
  } catch (err) {
    showToast(err.message, 'error');
  }

  loadHistory();
  connectAdminWs();
});
