/**
 * Delta Exchange Real-Time Bitcoin & Ethereum Straddle Matrix Engine
 * Computes 10 Upper Strikes + ATM + 10 Lower Strikes (21 Strikes Total)
 * Live WebSocket streaming & side-by-side multi-asset financial grid.
 */

(function () {
  'use strict';

  // --- CONFIGURATION & ENDPOINTS ---
  const ENDPOINTS = {
    global: {
      rest: 'https://api.delta.exchange/v2',
      ws: 'wss://socket.delta.exchange',
      label: 'Delta Global'
    },
    india: {
      rest: 'https://cdn.india.delta.exchange/v2',
      ws: 'wss://socket.india.delta.exchange',
      label: 'Delta India'
    }
  };

  // --- APPLICATION STATE ---
  const STATE = {
    exchange: 'global',
    activeView: 'matrix', // 'matrix' | 'chain'
    layoutColumns: 4,     // 4 | 2
    pricingMode: 'mark',  // 'mark' | 'ltp'
    theme: localStorage.getItem('delta_straddle_theme') || 'classic', // 'classic' | 'dark'
    audioEnabled: false,

    // Spot Prices & Changes
    spotPrices: { BTC: 0, ETH: 0 },
    spotChanges: { BTC: 0, ETH: 0 },

    // Expiries per asset: { BTC: ['170926', ...], ETH: ['170926', ...] }
    expiries: { BTC: [], ETH: [] },

    // Matrix Column Configurations
    columns: [
      { id: 0, asset: 'BTC', expiryCode: null, labelSuffix: 'Expiry 1' },
      { id: 1, asset: 'BTC', expiryCode: null, labelSuffix: 'Expiry 2' },
      { id: 2, asset: 'ETH', expiryCode: null, labelSuffix: 'Expiry 1' },
      { id: 3, asset: 'ETH', expiryCode: null, labelSuffix: 'Expiry 2' }
    ],

    // Classic Chain State
    chainAsset: 'BTC',
    chainExpiry: null,
    chainStrikeLimit: 21,

    // Live Tickers Storage
    tickersMap: new Map(),        // symbol -> ticker object
    previousStraddles: new Map(), // key `${asset}-${expiry}-${strike}` -> number

    // WebSocket & Polling
    ws: null,
    wsConnected: false,
    wsSubscribedSymbols: new Set(),
    reconnectAttempts: 0,
    pingTimer: null,
    lastPushTime: null,
    pollTimer: null
  };

  // Apply initial theme
  document.body.className = `theme-${STATE.theme}`;

  // --- DOM CACHE ---
  const DOM = {
    btnViewMatrix: document.getElementById('btnViewMatrix'),
    btnViewChain: document.getElementById('btnViewChain'),
    matrixWorkspace: document.getElementById('matrixWorkspace'),
    chainWorkspace: document.getElementById('chainWorkspace'),

    btnThemeToggle: document.getElementById('btnThemeToggle'),
    wsStatusBadge: document.getElementById('wsStatusBadge'),
    statusPulse: document.getElementById('statusPulse'),
    statusText: document.getElementById('statusText'),
    pingLatency: document.getElementById('pingLatency'),
    exchangeServerSelect: document.getElementById('exchangeServerSelect'),
    btnManualRefresh: document.getElementById('btnManualRefresh'),
    btnExportMenu: document.getElementById('btnExportMenu'),
    exportDropdownMenu: document.getElementById('exportDropdownMenu'),
    btnExportCSV: document.getElementById('btnExportCSV'),
    btnExportJSON: document.getElementById('btnExportJSON'),

    headerBtcPrice: document.getElementById('headerBtcPrice'),
    headerBtcChange: document.getElementById('headerBtcChange'),
    headerBtcAtm: document.getElementById('headerBtcAtm'),
    headerEthPrice: document.getElementById('headerEthPrice'),
    headerEthChange: document.getElementById('headerEthChange'),
    headerEthAtm: document.getElementById('headerEthAtm'),

    btnLayout4Col: document.getElementById('btnLayout4Col'),
    btnLayout2Col: document.getElementById('btnLayout2Col'),
    btnPriceMark: document.getElementById('btnPriceMark'),
    btnPriceLtp: document.getElementById('btnPriceLtp'),
    chkAudioAlerts: document.getElementById('chkAudioAlerts'),

    matrixGridContainer: document.getElementById('matrixGridContainer'),

    // Chain DOM
    tabChainBTC: document.getElementById('tabChainBTC'),
    tabChainETH: document.getElementById('tabChainETH'),
    chainExpirySelect: document.getElementById('chainExpirySelect'),
    chainDteBadge: document.getElementById('chainDteBadge'),
    chainStrikeCountSelect: document.getElementById('chainStrikeCountSelect'),
    straddleTableBody: document.getElementById('straddleTableBody'),

    footerConnectionInfo: document.getElementById('footerConnectionInfo'),
    lastPushTimeBadge: document.getElementById('lastPushTimeBadge'),

    // Login & Security Gate
    loginScreen: document.getElementById('loginScreen'),
    loginCard: document.getElementById('loginCard'),
    loginForm: document.getElementById('loginForm'),
    loginPasswordInput: document.getElementById('loginPasswordInput'),
    btnTogglePassword: document.getElementById('btnTogglePassword'),
    loginErrorMsg: document.getElementById('loginErrorMsg'),
    btnLoginSubmit: document.getElementById('btnLoginSubmit'),
    btnPinClear: document.getElementById('btnPinClear'),
    btnPinBackspace: document.getElementById('btnPinBackspace'),
    btnLockTerminal: document.getElementById('btnLockTerminal'),
    appLayout: document.getElementById('appLayout')
  };

  // --- AUDIO SYNTHESIZER ---
  let audioCtx = null;
  function playTickSound(isUp) {
    if (!STATE.audioEnabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(isUp ? 880 : 440, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.02, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.05);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.05);
    } catch (e) {}
  }

  // --- FORMATTING UTILITIES ---
  function formatCurrency(val, decimals = 2) {
    if (val === null || val === undefined || isNaN(val)) return '-';
    return '$' + Number(val).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function formatNumber(val, decimals = 2) {
    if (val === null || val === undefined || isNaN(val)) return '-';
    return Number(val).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function parseExpiryCode(code) {
    if (!code || code.length !== 6) return { formatted: code || 'Unknown', dte: 0 };
    const day = code.substring(0, 2);
    const monthIndex = parseInt(code.substring(2, 4), 10) - 1;
    const year = '20' + code.substring(4, 6);

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = months[monthIndex] || '---';
    const formatted = `${day}-${monthStr}-${code.substring(4, 6)}`;

    // Days to expiry
    const targetDate = new Date(Date.UTC(parseInt(year, 10), monthIndex, parseInt(day, 10), 12, 0, 0));
    const now = new Date();
    const diffMs = targetDate - now;
    const diffDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));

    return { formatted, dte: diffDays, targetDate };
  }

  // --- CONNECTION STATUS UPDATER ---
  function updateConnectionStatus(status, text) {
    if (status === 'connected') {
      DOM.wsStatusBadge.className = 'connection-status';
      DOM.statusText.textContent = text || 'LIVE WEBSOCKET';
    } else if (status === 'connecting') {
      DOM.wsStatusBadge.className = 'connection-status';
      DOM.statusText.textContent = text || 'CONNECTING...';
    } else {
      DOM.wsStatusBadge.className = 'connection-status disconnected';
      DOM.statusText.textContent = text || 'DISCONNECTED';
    }
  }

  // --- REST INITIALIZATION ---
  async function fetchInitialSnapshot() {
    const currentEndpoint = ENDPOINTS[STATE.exchange].rest;
    try {
      updateConnectionStatus('connecting', 'FETCHING REST SNAPSHOT...');

      // Fetch options tickers and spot prices concurrently
      const [tickersRes, btcRes, ethRes] = await Promise.all([
        fetch(`${currentEndpoint}/tickers?contract_types=call_options,put_options`, {
          headers: { Accept: 'application/json' }
        }).then(r => r.json()).catch(() => ({ result: [] })),
        fetch(`${currentEndpoint}/tickers/BTCUSDT`).then(r => r.json()).catch(() => null),
        fetch(`${currentEndpoint}/tickers/ETHUSDT`).then(r => r.json()).catch(() => null)
      ]);

      // Spot BTC
      if (btcRes && btcRes.result) {
        const b = btcRes.result;
        STATE.spotPrices.BTC = parseFloat(b.spot_price || b.mark_price || b.close || 0);
        STATE.spotChanges.BTC = parseFloat(b.mark_change_24h || b.ltp_change_24h || 0);
      }

      // Spot ETH
      if (ethRes && ethRes.result) {
        const e = ethRes.result;
        STATE.spotPrices.ETH = parseFloat(e.spot_price || e.mark_price || e.close || 0);
        STATE.spotChanges.ETH = parseFloat(e.mark_change_24h || e.ltp_change_24h || 0);
      }

      updateSummaryCards();

      // Store options tickers
      const tickers = tickersRes.result || [];
      tickers.forEach(t => {
        if (t.symbol) STATE.tickersMap.set(t.symbol, t);
      });

      // Extract expiries for both BTC and ETH
      extractAvailableExpiries();

      // Assign initial expiries to columns if empty
      assignDefaultColumnExpiries();

      // Connect WebSocket
      initWebSocket();

      // Render Matrix UI
      renderStraddleMatrix();

      // Start 1-second polling loop
      start1sPollingEngine();

      // If Chain view is open, render that too
      if (STATE.activeView === 'chain') {
        renderClassicChain();
      }

    } catch (err) {
      console.error('[REST Snapshot Error]', err);
      updateConnectionStatus('error', 'API CONNECT ERROR');
      setTimeout(fetchInitialSnapshot, 4000);
    }
  }

  function updateSummaryCards() {
    // BTC
    const bPrice = STATE.spotPrices.BTC;
    const bChange = STATE.spotChanges.BTC;
    if (DOM.headerBtcPrice && bPrice > 0) {
      DOM.headerBtcPrice.textContent = formatCurrency(bPrice, 1);
    }
    if (DOM.headerBtcChange) {
      const isUp = bChange >= 0;
      DOM.headerBtcChange.textContent = (isUp ? '+' : '') + bChange.toFixed(2) + '%';
      DOM.headerBtcChange.className = 'mini-change ' + (isUp ? 'up' : 'down');
    }

    // ETH
    const ePrice = STATE.spotPrices.ETH;
    const eChange = STATE.spotChanges.ETH;
    if (DOM.headerEthPrice && ePrice > 0) {
      DOM.headerEthPrice.textContent = formatCurrency(ePrice, 2);
    }
    if (DOM.headerEthChange) {
      const isUp = eChange >= 0;
      DOM.headerEthChange.textContent = (isUp ? '+' : '') + eChange.toFixed(2) + '%';
      DOM.headerEthChange.className = 'mini-change ' + (isUp ? 'up' : 'down');
    }
  }

  // --- EXPIRIES EXTRACTION ---
  function extractAvailableExpiries() {
    const btcSet = new Set();
    const ethSet = new Set();

    STATE.tickersMap.forEach(t => {
      const sym = t.symbol || '';
      const asset = t.underlying_asset_symbol;
      const parts = sym.split('-');
      if (parts.length >= 4) {
        const rawCode = parts[parts.length - 1];
        if (rawCode.length === 6) {
          if (asset === 'BTC') btcSet.add(rawCode);
          if (asset === 'ETH') ethSet.add(rawCode);
        }
      }
    });

    const sortFn = (a, b) => {
      const { targetDate: da } = parseExpiryCode(a);
      const { targetDate: db } = parseExpiryCode(b);
      return da - db;
    };

    STATE.expiries.BTC = Array.from(btcSet).sort(sortFn);
    STATE.expiries.ETH = Array.from(ethSet).sort(sortFn);

    // Default chain expiry
    if (!STATE.chainExpiry) {
      STATE.chainExpiry = STATE.expiries[STATE.chainAsset][0] || null;
    }
    updateChainExpiryDropdown();
  }

  function assignDefaultColumnExpiries() {
    const btcExp = STATE.expiries.BTC;
    const ethExp = STATE.expiries.ETH;

    // Col 0: BTC Expiry 1
    if (!STATE.columns[0].expiryCode && btcExp.length > 0) {
      STATE.columns[0].expiryCode = btcExp[0];
    }
    // Col 1: BTC Expiry 2
    if (!STATE.columns[1].expiryCode && btcExp.length > 1) {
      STATE.columns[1].expiryCode = btcExp[1];
    } else if (!STATE.columns[1].expiryCode && btcExp.length > 0) {
      STATE.columns[1].expiryCode = btcExp[0];
    }

    // Col 2: ETH Expiry 1
    if (!STATE.columns[2].expiryCode && ethExp.length > 0) {
      STATE.columns[2].expiryCode = ethExp[0];
    }
    // Col 3: ETH Expiry 2
    if (!STATE.columns[3].expiryCode && ethExp.length > 1) {
      STATE.columns[3].expiryCode = ethExp[1];
    } else if (!STATE.columns[3].expiryCode && ethExp.length > 0) {
      STATE.columns[3].expiryCode = ethExp[0];
    }
  }

  // --- CORE COMPUTATION: 10 UPPER + ATM + 10 LOWER STRIKES ---
  function computeAssetExpiryStraddles(asset, expiryCode) {
    if (!expiryCode) return null;

    const spotPrice = STATE.spotPrices[asset] || 0;
    const strikeMap = new Map(); // strike -> { call, put }

    STATE.tickersMap.forEach(t => {
      if (t.underlying_asset_symbol === asset && (t.symbol || '').endsWith(`-${expiryCode}`)) {
        const strike = parseFloat(t.strike_price);
        if (isNaN(strike)) return;

        if (!strikeMap.has(strike)) {
          strikeMap.set(strike, { call: null, put: null });
        }
        const item = strikeMap.get(strike);
        if (t.contract_type === 'call_options') item.call = t;
        if (t.contract_type === 'put_options') item.put = t;
      }
    });

    const allStrikes = Array.from(strikeMap.keys()).sort((a, b) => a - b);
    if (allStrikes.length === 0) return null;

    // 1. Identify At-The-Money (ATM) strike: min(|strike - spot|)
    let atmStrike = allStrikes[0];
    let minDiff = Infinity;
    allStrikes.forEach(s => {
      const diff = Math.abs(s - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        atmStrike = s;
      }
    });

    const atmIndex = allStrikes.indexOf(atmStrike);

    // 2. Extract EXACTLY 10 strikes below ATM and 10 strikes above ATM
    // Lower strikes: up to 10 strikes immediately lower than ATM
    const lowerStrikes = allStrikes.slice(Math.max(0, atmIndex - 10), atmIndex);

    // Upper strikes: up to 10 strikes immediately higher than ATM
    const upperStrikes = allStrikes.slice(atmIndex + 1, atmIndex + 1 + 10);

    // Combined strikes list (sorted ascending, centered on ATM)
    const selectedStrikes = [...lowerStrikes, atmStrike, ...upperStrikes];

    // Build row calculations
    const rows = selectedStrikes.map(strike => {
      const item = strikeMap.get(strike) || {};
      const call = item.call || {};
      const put = item.put || {};

      const cMark = parseFloat(call.mark_price || 0) || 0;
      const pMark = parseFloat(put.mark_price || 0) || 0;
      const cLtp = call.close !== undefined && call.close !== null ? parseFloat(call.close) : null;
      const pLtp = put.close !== undefined && put.close !== null ? parseFloat(put.close) : null;

      const straddleMark = cMark + pMark;
      const straddleLtp = (cLtp !== null ? cLtp : cMark) + (pLtp !== null ? pLtp : pMark);

      const activeStraddle = STATE.pricingMode === 'mark' ? straddleMark : straddleLtp;
      const isAtm = (strike === atmStrike);

      // Relative offset from ATM (-10 to +10)
      const offset = selectedStrikes.indexOf(strike) - lowerStrikes.length;

      return {
        strike,
        isAtm,
        offset, // -10 .. 0 .. +10
        straddlePrice: activeStraddle,
        straddleMark,
        straddleLtp,
        callSymbol: call.symbol,
        putSymbol: put.symbol
      };
    });

    const atmRow = rows.find(r => r.isAtm);
    const atmStraddle = atmRow ? atmRow.straddlePrice : 0;

    return {
      asset,
      expiryCode,
      spotPrice,
      atmStrike,
      atmStraddle,
      rows
    };
  }

  // --- RENDER PRIMARY STRADDLE MATRIX (PHOTO REPLICATION) ---
  function renderStraddleMatrix() {
    const container = DOM.matrixGridContainer;
    if (!container) return;

    // Apply layout class
    if (STATE.layoutColumns === 2) {
      container.className = 'matrix-grid-container layout-2col';
    } else {
      container.className = 'matrix-grid-container';
    }

    const activeCols = STATE.layoutColumns === 2
      ? [STATE.columns[0], STATE.columns[2]] // BTC Expiry 1 & ETH Expiry 1
      : STATE.columns;                      // All 4 columns

    container.innerHTML = '';

    activeCols.forEach((colConfig, colIdx) => {
      const { asset, expiryCode } = colConfig;
      const data = computeAssetExpiryStraddles(asset, expiryCode);

      // Update top mini ticker ATM info
      if (colIdx === 0 && data) {
        DOM.headerBtcAtm.innerHTML = `ATM: <span>$${formatNumber(data.atmStrike, 0)}</span> (${formatCurrency(data.atmStraddle, 1)})`;
      } else if (colIdx === (STATE.layoutColumns === 2 ? 1 : 2) && data) {
        DOM.headerEthAtm.innerHTML = `ATM: <span>$${formatNumber(data.atmStrike, 0)}</span> (${formatCurrency(data.atmStraddle, 2)})`;
      }

      // Build column card
      const card = document.createElement('div');
      card.className = 'matrix-column-card';
      card.dataset.colId = colConfig.id;

      // Card Header
      const { formatted: expiryFormatted, dte } = parseExpiryCode(expiryCode);
      const isBtc = asset === 'BTC';
      const coinIcon = isBtc ? '₿' : 'Ξ';
      const coinClass = isBtc ? 'col-asset-btc' : 'col-asset-eth';
      const spotStr = formatCurrency(data ? data.spotPrice : STATE.spotPrices[asset], isBtc ? 1 : 2);
      const atmStr = data ? `$${formatNumber(data.atmStrike, 0)}` : '--';
      const atmStradStr = data ? formatCurrency(data.atmStraddle, isBtc ? 1 : 2) : '--';

      // Build Expiry Options
      const availableExpiries = STATE.expiries[asset] || [];
      const expiryOptionsHtml = availableExpiries.map(code => {
        const { formatted } = parseExpiryCode(code);
        const sel = code === expiryCode ? 'selected' : '';
        return `<option value="${code}" ${sel}>${formatted}</option>`;
      }).join('');

      card.innerHTML = `
        <div class="matrix-col-header">
          <div class="col-header-top">
            <span class="col-asset-title ${coinClass}">
              <span>${coinIcon}</span>
              <span>${asset === 'BTC' ? 'BITCOIN' : 'ETHEREUM'}</span>
            </span>
            <div class="col-expiry-selector-wrapper">
              <select class="col-expiry-select" data-col-id="${colConfig.id}" title="Select Expiration Date">
                ${expiryOptionsHtml || `<option>${expiryFormatted}</option>`}
              </select>
            </div>
          </div>
          <div class="col-stats-row">
            <span class="col-spot-val">Spot: <strong>${spotStr}</strong></span>
            <span class="col-atm-badge" title="ATM Strike and Combined Straddle Premium">ATM: ${atmStr} | ${atmStradStr}</span>
          </div>
        </div>

        <div class="matrix-table-wrapper">
          <table class="matrix-table">
            <thead>
              <tr>
                <th class="th-strike">Strike</th>
                <th class="th-straddle">Straddle</th>
              </tr>
            </thead>
            <tbody>
              ${renderMatrixTableRows(asset, expiryCode, data, isBtc)}
            </tbody>
          </table>
        </div>
      `;

      container.appendChild(card);
    });

    // Attach expiry change listeners to column dropdowns
    container.querySelectorAll('.col-expiry-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const colId = parseInt(e.target.dataset.colId, 10);
        const newExpiry = e.target.value;
        const col = STATE.columns.find(c => c.id === colId);
        if (col) {
          col.expiryCode = newExpiry;
          subscribeLiveChannels();
          renderStraddleMatrix();
        }
      });
    });

    // Auto-center each table on the ATM strike for immediate visibility
    requestAnimationFrame(() => {
      container.querySelectorAll('.matrix-table-wrapper').forEach(wrapper => {
        const atmRow = wrapper.querySelector('.row-atm');
        if (atmRow) {
          atmRow.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
      });
    });
  }

  function renderMatrixTableRows(asset, expiryCode, data, isBtc) {
    if (!data || !data.rows || data.rows.length === 0) {
      return `
        <tr>
          <td colspan="2" style="text-align: center; padding: 24px; color: var(--text-muted);">
            No options strikes found for ${asset} (${expiryCode || 'N/A'}).
          </td>
        </tr>
      `;
    }

    return data.rows.map(r => {
      const isAtm = r.isAtm;
      const rowClass = isAtm ? 'row-atm' : '';
      const strikeDisplay = formatNumber(r.strike, 0);
      const straddlePrice = r.straddlePrice;
      const straddleDisplay = straddlePrice > 0 ? (isBtc ? straddlePrice.toFixed(2) : straddlePrice.toFixed(2)) : '-';

      // Price change diff key for tick flashes
      const cacheKey = `${asset}-${expiryCode}-${r.strike}`;
      const prevPrice = STATE.previousStraddles.get(cacheKey);
      let tickClass = '';
      if (prevPrice !== undefined && straddlePrice > 0) {
        if (straddlePrice > prevPrice) {
          tickClass = 'tick-up';
          playTickSound(true);
        } else if (straddlePrice < prevPrice) {
          tickClass = 'tick-down';
          playTickSound(false);
        }
      }
      STATE.previousStraddles.set(cacheKey, straddlePrice);

      const atmBadgeHtml = isAtm ? `<span class="atm-tag">ATM</span>` : '';
      const offsetClass = r.offset > 0 ? 'offset-upper' : (r.offset < 0 ? 'offset-lower' : '');
      const offsetHtml = !isAtm ? `<span class="strike-offset ${offsetClass}">${r.offset > 0 ? '+' + r.offset : r.offset}</span>` : '';

      return `
        <tr class="${rowClass}" data-strike="${r.strike}">
          <td class="td-strike">
            ${strikeDisplay} ${atmBadgeHtml || offsetHtml}
          </td>
          <td class="td-straddle ${tickClass}" id="strad-${cacheKey.replace(/[^a-zA-Z0-9]/g, '_')}">
            ${straddleDisplay}
          </td>
        </tr>
      `;
    }).join('');
  }

  // --- WEBSOCKET ENGINE & SUBSCRIPTIONS ---
  function initWebSocket() {
    if (STATE.ws) {
      try { STATE.ws.close(); } catch (e) {}
      STATE.ws = null;
    }

    const wsUrl = ENDPOINTS[STATE.exchange].ws;
    DOM.footerConnectionInfo.textContent = `WebSocket: ${wsUrl}`;
    updateConnectionStatus('connecting', 'CONNECTING WEBSOCKET...');

    try {
      const ws = new WebSocket(wsUrl);
      STATE.ws = ws;
      const connectStartTime = Date.now();

      ws.onopen = () => {
        STATE.wsConnected = true;
        STATE.reconnectAttempts = 0;
        const latency = Date.now() - connectStartTime;
        DOM.pingLatency.textContent = `${latency}ms`;
        updateConnectionStatus('connected', 'LIVE WEBSOCKET: CONNECTED');
        subscribeLiveChannels();
        startHeartbeat();
      };

      ws.onmessage = (event) => {
        handleWsMessage(event.data);
      };

      ws.onerror = (err) => {
        console.warn('[WS Error]', err);
      };

      ws.onclose = () => {
        STATE.wsConnected = false;
        clearInterval(STATE.pingTimer);
        updateConnectionStatus('disconnected', 'DISCONNECTED - RECONNECTING...');
        handleWsReconnect();
      };

    } catch (e) {
      console.error('[WS Init Error]', e);
      handleWsReconnect();
    }
  }

  function handleWsReconnect() {
    const delay = Math.min(10000, (STATE.reconnectAttempts + 1) * 2000);
    STATE.reconnectAttempts++;
    setTimeout(() => {
      if (!STATE.wsConnected) {
        initWebSocket();
      }
    }, delay);
  }

  function startHeartbeat() {
    clearInterval(STATE.pingTimer);
    STATE.pingTimer = setInterval(() => {
      if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
        const pingStart = Date.now();
        try {
          STATE.ws.send(JSON.stringify({ type: 'ping' }));
          DOM.pingLatency.textContent = `${Date.now() - pingStart}ms`;
        } catch (e) {}
      }
    }, 15000);
  }

  function subscribeLiveChannels() {
    if (!STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;

    // Collect symbols needed for active matrix columns (visible strikes)
    const symbolsToSub = new Set(['BTCUSDT', 'ETHUSDT']);
    const l2SymbolsToSub = new Set();

    const activeCols = STATE.layoutColumns === 2
      ? [STATE.columns[0], STATE.columns[2]]
      : STATE.columns;

    activeCols.forEach(col => {
      if (col.expiryCode) {
        const data = computeAssetExpiryStraddles(col.asset, col.expiryCode);
        if (data && data.rows) {
          data.rows.forEach(r => {
            if (r.callSymbol) {
              symbolsToSub.add(r.callSymbol);
              l2SymbolsToSub.add(r.callSymbol);
            }
            if (r.putSymbol) {
              symbolsToSub.add(r.putSymbol);
              l2SymbolsToSub.add(r.putSymbol);
            }
          });
        }
      }
    });

    if (STATE.activeView === 'chain' && STATE.chainExpiry) {
      STATE.tickersMap.forEach((t, sym) => {
        if (t.underlying_asset_symbol === STATE.chainAsset && sym.endsWith(`-${STATE.chainExpiry}`)) {
          symbolsToSub.add(sym);
        }
      });
    }

    const symbolList = Array.from(symbolsToSub);
    if (symbolList.length === 0) return;

    // Subscribe to both v2/ticker and l2_orderbook for high-frequency sub-second updates
    const channelsPayload = [
      {
        name: 'v2/ticker',
        symbols: symbolList
      }
    ];

    const l2List = Array.from(l2SymbolsToSub).slice(0, 42);
    if (l2List.length > 0) {
      channelsPayload.push({
        name: 'l2_orderbook',
        symbols: l2List
      });
    }

    const subPayload = {
      type: 'subscribe',
      payload: {
        channels: channelsPayload
      }
    };

    try {
      STATE.ws.send(JSON.stringify(subPayload));
      STATE.wsSubscribedSymbols = symbolsToSub;
    } catch (e) {
      console.warn('[WS Subscribe Error]', e);
    }
  }

  let throttledRenderTimer = null;
  function scheduleFastRender() {
    if (!throttledRenderTimer) {
      throttledRenderTimer = setTimeout(() => {
        throttledRenderTimer = null;
        if (STATE.activeView === 'matrix') {
          updateMatrixCellsOnly();
        } else {
          renderClassicChain();
        }
      }, 50); // Ultra-fast 50ms refresh debounce for real-time responsiveness
    }
  }

  function handleWsMessage(raw) {
    try {
      const msg = JSON.parse(raw);
      if (!msg || msg.type === 'pong') return;

      const now = new Date();
      STATE.lastPushTime = now;
      DOM.lastPushTimeBadge.textContent = `1s Live: ${now.toTimeString().split(' ')[0]}`;

      // Handle L2 Orderbook for sub-second quote changes
      if (msg.type === 'l2_orderbook' && msg.symbol) {
        const sym = msg.symbol;
        const existing = STATE.tickersMap.get(sym) || { symbol: sym };
        const bestBid = (msg.buy && msg.buy.length > 0) ? parseFloat(msg.buy[0].limit_price) : (existing.quotes?.best_bid || 0);
        const bestAsk = (msg.sell && msg.sell.length > 0) ? parseFloat(msg.sell[0].limit_price) : (existing.quotes?.best_ask || 0);
        const midPrice = (bestBid > 0 && bestAsk > 0) ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || existing.mark_price || 0);

        if (midPrice > 0) {
          existing.mark_price = midPrice;
          if (!existing.quotes) existing.quotes = {};
          existing.quotes.best_bid = bestBid;
          existing.quotes.best_ask = bestAsk;
          STATE.tickersMap.set(sym, existing);
          scheduleFastRender();
        }
        return;
      }

      if (msg.symbol) {
        const sym = msg.symbol;

        // Spot update (BTCUSDT or ETHUSDT)
        if (sym === 'BTCUSDT' || sym === 'ETHUSDT') {
          const coin = sym.startsWith('BTC') ? 'BTC' : 'ETH';
          const newSpot = parseFloat(msg.spot_price || msg.mark_price || msg.close || 0);
          if (newSpot > 0) {
            STATE.spotPrices[coin] = newSpot;
            STATE.spotChanges[coin] = parseFloat(msg.mark_change_24h || msg.ltp_change_24h || STATE.spotChanges[coin]);
            updateSummaryCards();
            scheduleFastRender();
          }
        }

        // Option ticker update
        if (sym.startsWith('C-') || sym.startsWith('P-')) {
          const existing = STATE.tickersMap.get(sym) || {};
          STATE.tickersMap.set(sym, { ...existing, ...msg });
          scheduleFastRender();
        }
      }
    } catch (e) {}
  }

  // Fast targeted DOM update for visible straddle matrix cells
  function updateMatrixCellsOnly() {
    const activeCols = STATE.layoutColumns === 2
      ? [STATE.columns[0], STATE.columns[2]]
      : STATE.columns;

    activeCols.forEach((colConfig, colIdx) => {
      const { asset, expiryCode } = colConfig;
      const data = computeAssetExpiryStraddles(asset, expiryCode);
      if (!data) return;

      // Update spot & ATM badge in column header
      const card = DOM.matrixGridContainer.querySelector(`[data-col-id="${colConfig.id}"]`);
      if (card) {
        const spotValEl = card.querySelector('.col-spot-val strong');
        if (spotValEl) {
          spotValEl.textContent = formatCurrency(data.spotPrice, asset === 'BTC' ? 1 : 2);
        }
        const atmBadgeEl = card.querySelector('.col-atm-badge');
        if (atmBadgeEl) {
          atmBadgeEl.textContent = `ATM: $${formatNumber(data.atmStrike, 0)} | ${formatCurrency(data.atmStraddle, asset === 'BTC' ? 1 : 2)}`;
        }
      }

      // Live update top mini card ATM info as well
      if (colIdx === 0 && DOM.headerBtcAtm) {
        DOM.headerBtcAtm.innerHTML = `ATM: <span>$${formatNumber(data.atmStrike, 0)}</span> (${formatCurrency(data.atmStraddle, 1)})`;
      } else if (colIdx === (STATE.layoutColumns === 2 ? 1 : 2) && DOM.headerEthAtm) {
        DOM.headerEthAtm.innerHTML = `ATM: <span>$${formatNumber(data.atmStrike, 0)}</span> (${formatCurrency(data.atmStraddle, 2)})`;
      }

      // Update straddle values in table cells
      data.rows.forEach(r => {
        const cacheKey = `${asset}-${expiryCode}-${r.strike}`;
        const cellId = `strad-${cacheKey.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const cell = document.getElementById(cellId);
        if (cell) {
          const oldVal = STATE.previousStraddles.get(cacheKey);
          const newVal = r.straddlePrice;

          if (oldVal !== undefined && newVal !== oldVal && newVal > 0) {
            cell.className = 'td-straddle ' + (newVal > oldVal ? 'tick-up' : 'tick-down');
            if (newVal > oldVal) playTickSound(true);
            else playTickSound(false);
          }
          cell.textContent = newVal > 0 ? newVal.toFixed(2) : '-';
          STATE.previousStraddles.set(cacheKey, newVal);
        }
      });
    });
  }

  // --- SECONDARY VIEW: CLASSIC 19-COLUMN OPTIONS CHAIN ---
  function updateChainExpiryDropdown() {
    const expiries = STATE.expiries[STATE.chainAsset] || [];
    DOM.chainExpirySelect.innerHTML = '';
    expiries.forEach(code => {
      const opt = document.createElement('option');
      opt.value = code;
      const { formatted, dte } = parseExpiryCode(code);
      opt.textContent = `${formatted} (${dte}d DTE)`;
      if (code === STATE.chainExpiry) opt.selected = true;
      DOM.chainExpirySelect.appendChild(opt);
    });

    const { dte } = parseExpiryCode(STATE.chainExpiry);
    DOM.chainDteBadge.textContent = dte === 0 ? 'Today' : `DTE: ${dte}d`;
  }

  function renderClassicChain() {
    const asset = STATE.chainAsset;
    const expiry = STATE.chainExpiry;
    const spot = STATE.spotPrices[asset] || 0;

    const data = computeAssetExpiryStraddles(asset, expiry);
    if (!data || !data.rows || data.rows.length === 0) {
      DOM.straddleTableBody.innerHTML = `
        <tr class="loading-row">
          <td colspan="19">No active options for ${asset} (${expiry || 'selected'}).</td>
        </tr>
      `;
      return;
    }

    const rowsHtml = data.rows.map(r => {
      const strike = r.strike;
      const isAtm = r.isAtm;

      const symC = `C-${asset}-${strike}-${expiry}`;
      const symP = `P-${asset}-${strike}-${expiry}`;
      const c = STATE.tickersMap.get(symC) || {};
      const p = STATE.tickersMap.get(symP) || {};

      const cQuotes = c.quotes || {};
      const pQuotes = p.quotes || {};
      const cGreeks = c.greeks || {};
      const pGreeks = p.greeks || {};

      const cMark = parseFloat(c.mark_price || 0) || 0;
      const pMark = parseFloat(p.mark_price || 0) || 0;
      const cLtp = c.close !== undefined && c.close !== null ? parseFloat(c.close) : null;
      const pLtp = p.close !== undefined && p.close !== null ? parseFloat(p.close) : null;

      const straddlePrice = r.straddlePrice;
      const upperBe = strike + straddlePrice;
      const lowerBe = Math.max(0, strike - straddlePrice);
      const straddlePct = spot > 0 ? (straddlePrice / spot) * 100 : 0;

      const rowClass = isAtm ? 'style="background: var(--atm-row-bg); font-weight: 800;"' : '';
      const strikeClass = isAtm ? 'style="background: var(--strike-header-bg); font-weight: 800;"' : 'style="background: var(--strike-bg);"';

      return `
        <tr ${rowClass}>
          <td>${(parseFloat(cGreeks.delta || 0)).toFixed(2)}</td>
          <td>${(parseFloat(cQuotes.mark_iv || 0) * 100).toFixed(1)}%</td>
          <td>${formatNumber(c.oi, 0)}</td>
          <td>${formatNumber(cQuotes.best_bid, 1)}</td>
          <td>${formatNumber(cQuotes.best_ask, 1)}</td>
          <td>${cLtp !== null ? cLtp.toFixed(1) : '-'}</td>
          <td style="font-weight: 700;">${cMark.toFixed(2)}</td>

          <td ${strikeClass}>${formatNumber(strike, 0)} ${isAtm ? '<strong>*ATM*</strong>' : ''}</td>

          <td style="color: #f59e0b; font-weight: 800;">${straddlePrice.toFixed(2)}</td>
          <td>${formatNumber(parseFloat(cQuotes.best_bid || 0) + parseFloat(pQuotes.best_bid || 0), 1)} - ${formatNumber(parseFloat(cQuotes.best_ask || 0) + parseFloat(pQuotes.best_ask || 0), 1)}</td>
          <td>${formatNumber(lowerBe, 0)} / ${formatNumber(upperBe, 0)}</td>
          <td>${straddlePct.toFixed(2)}%</td>

          <td style="font-weight: 700;">${pMark.toFixed(2)}</td>
          <td>${pLtp !== null ? pLtp.toFixed(1) : '-'}</td>
          <td>${formatNumber(pQuotes.best_bid, 1)}</td>
          <td>${formatNumber(pQuotes.best_ask, 1)}</td>
          <td>${formatNumber(p.oi, 0)}</td>
          <td>${(parseFloat(pQuotes.mark_iv || 0) * 100).toFixed(1)}%</td>
          <td>${(parseFloat(pGreeks.delta || 0)).toFixed(2)}</td>
        </tr>
      `;
    }).join('');

    DOM.straddleTableBody.innerHTML = rowsHtml;
  }

  // --- EXPORT TO CSV & JSON ---
  function exportMatrixData(type) {
    const activeCols = STATE.layoutColumns === 2
      ? [STATE.columns[0], STATE.columns[2]]
      : STATE.columns;

    const exportRows = [];
    activeCols.forEach(col => {
      const data = computeAssetExpiryStraddles(col.asset, col.expiryCode);
      if (data && data.rows) {
        data.rows.forEach(r => {
          exportRows.push({
            Asset: col.asset,
            Expiry: col.expiryCode,
            Spot: data.spotPrice,
            Strike: r.strike,
            Is_ATM: r.isAtm,
            Offset: r.offset,
            Straddle_Price: r.straddlePrice,
            Pricing_Mode: STATE.pricingMode
          });
        });
      }
    });

    if (type === 'json') {
      const blob = new Blob([JSON.stringify(exportRows, null, 2)], { type: 'application/json' });
      downloadBlob(blob, `delta_straddle_matrix_${Date.now()}.json`);
    } else if (type === 'csv') {
      const headers = ['Asset', 'Expiry', 'Spot', 'Strike', 'Is_ATM', 'Offset', 'Straddle_Price', 'Pricing_Mode'];
      const csvLines = [headers.join(',')];
      exportRows.forEach(row => {
        csvLines.push(headers.map(h => JSON.stringify(row[h] !== undefined ? row[h] : '')).join(','));
      });
      const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      downloadBlob(blob, `delta_straddle_matrix_${Date.now()}.csv`);
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- EVENT LISTENERS & WIRING ---
  function bindEventListeners() {
    // View Switcher
    DOM.btnViewMatrix.addEventListener('click', () => {
      STATE.activeView = 'matrix';
      DOM.btnViewMatrix.classList.add('active');
      DOM.btnViewChain.classList.remove('active');
      DOM.matrixWorkspace.style.display = 'block';
      DOM.chainWorkspace.style.display = 'none';
      renderStraddleMatrix();
    });

    DOM.btnViewChain.addEventListener('click', () => {
      STATE.activeView = 'chain';
      DOM.btnViewChain.classList.add('active');
      DOM.btnViewMatrix.classList.remove('active');
      DOM.matrixWorkspace.style.display = 'none';
      DOM.chainWorkspace.style.display = 'flex';
      renderClassicChain();
    });

    // Theme Toggle
    DOM.btnThemeToggle.addEventListener('click', () => {
      STATE.theme = STATE.theme === 'classic' ? 'dark' : 'classic';
      document.body.className = `theme-${STATE.theme}`;
      localStorage.setItem('delta_straddle_theme', STATE.theme);
    });

    // Layout Columns Switcher
    DOM.btnLayout4Col.addEventListener('click', () => {
      STATE.layoutColumns = 4;
      DOM.btnLayout4Col.classList.add('active');
      DOM.btnLayout2Col.classList.remove('active');
      subscribeLiveChannels();
      renderStraddleMatrix();
    });

    DOM.btnLayout2Col.addEventListener('click', () => {
      STATE.layoutColumns = 2;
      DOM.btnLayout2Col.classList.add('active');
      DOM.btnLayout4Col.classList.remove('active');
      subscribeLiveChannels();
      renderStraddleMatrix();
    });

    // Pricing Mode
    DOM.btnPriceMark.addEventListener('click', () => {
      STATE.pricingMode = 'mark';
      DOM.btnPriceMark.classList.add('active');
      DOM.btnPriceLtp.classList.remove('active');
      if (STATE.activeView === 'matrix') renderStraddleMatrix();
      else renderClassicChain();
    });

    DOM.btnPriceLtp.addEventListener('click', () => {
      STATE.pricingMode = 'ltp';
      DOM.btnPriceLtp.classList.add('active');
      DOM.btnPriceMark.classList.remove('active');
      if (STATE.activeView === 'matrix') renderStraddleMatrix();
      else renderClassicChain();
    });

    // Audio Alert Toggle
    DOM.chkAudioAlerts.addEventListener('change', (e) => {
      STATE.audioEnabled = e.target.checked;
      if (STATE.audioEnabled) playTickSound(true);
    });

    // Manual Refresh
    DOM.btnManualRefresh.addEventListener('click', () => {
      fetchInitialSnapshot();
    });

    // Exchange Server Switch
    DOM.exchangeServerSelect.addEventListener('change', (e) => {
      STATE.exchange = e.target.value;
      STATE.tickersMap.clear();
      STATE.previousStraddles.clear();
      fetchInitialSnapshot();
    });

    // Export Menu
    DOM.btnExportMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      DOM.exportDropdownMenu.classList.toggle('show');
    });

    window.addEventListener('click', () => {
      DOM.exportDropdownMenu.classList.remove('show');
    });

    DOM.btnExportCSV.addEventListener('click', () => exportMatrixData('csv'));
    DOM.btnExportJSON.addEventListener('click', () => exportMatrixData('json'));

    // Chain View Listeners
    DOM.tabChainBTC.addEventListener('click', () => {
      STATE.chainAsset = 'BTC';
      DOM.tabChainBTC.classList.add('active');
      DOM.tabChainETH.classList.remove('active');
      STATE.chainExpiry = STATE.expiries.BTC[0] || null;
      updateChainExpiryDropdown();
      subscribeLiveChannels();
      renderClassicChain();
    });

    DOM.tabChainETH.addEventListener('click', () => {
      STATE.chainAsset = 'ETH';
      DOM.tabChainETH.classList.add('active');
      DOM.tabChainBTC.classList.remove('active');
      STATE.chainExpiry = STATE.expiries.ETH[0] || null;
      updateChainExpiryDropdown();
      subscribeLiveChannels();
      renderClassicChain();
    });

    DOM.chainExpirySelect.addEventListener('change', (e) => {
      STATE.chainExpiry = e.target.value;
      const { dte } = parseExpiryCode(STATE.chainExpiry);
      DOM.chainDteBadge.textContent = dte === 0 ? 'Today' : `DTE: ${dte}d`;
      subscribeLiveChannels();
      renderClassicChain();
    });
  }

  // --- 1-SECOND HIGH-FREQUENCY REFRESH ENGINE ---
  let isFetchingOptions = false;
  function start1sPollingEngine() {
    if (STATE.pollTimer) return;

    STATE.pollTimer = setInterval(async () => {
      if (!isUserAuthenticated()) return;
      const endpoint = ENDPOINTS[STATE.exchange].rest;
      const now = new Date();
      DOM.lastPushTimeBadge.textContent = `1s Live: ${now.toTimeString().split(' ')[0]}`;

      try {
        // 1. Fetch spot prices every 1 second
        const [bRes, eRes] = await Promise.all([
          fetch(`${endpoint}/tickers/BTCUSDT`).then(r => r.json()).catch(() => null),
          fetch(`${endpoint}/tickers/ETHUSDT`).then(r => r.json()).catch(() => null)
        ]);

        let spotChanged = false;
        if (bRes && bRes.result) {
          const newBtc = parseFloat(bRes.result.spot_price || bRes.result.mark_price || 0);
          if (newBtc > 0 && newBtc !== STATE.spotPrices.BTC) {
            STATE.spotPrices.BTC = newBtc;
            STATE.spotChanges.BTC = parseFloat(bRes.result.mark_change_24h || bRes.result.ltp_change_24h || 0);
            spotChanged = true;
          }
        }
        if (eRes && eRes.result) {
          const newEth = parseFloat(eRes.result.spot_price || eRes.result.mark_price || 0);
          if (newEth > 0 && newEth !== STATE.spotPrices.ETH) {
            STATE.spotPrices.ETH = newEth;
            STATE.spotChanges.ETH = parseFloat(eRes.result.mark_change_24h || eRes.result.ltp_change_24h || 0);
            spotChanged = true;
          }
        }
        updateSummaryCards();

        // 2. High-frequency options snapshot poll
        if (!isFetchingOptions) {
          isFetchingOptions = true;
          fetch(`${endpoint}/tickers?contract_types=call_options,put_options`)
            .then(r => r.json())
            .then(data => {
              if (data && data.result) {
                data.result.forEach(t => {
                  if (t.symbol) {
                    const existing = STATE.tickersMap.get(t.symbol) || {};
                    STATE.tickersMap.set(t.symbol, { ...existing, ...t });
                  }
                });
                if (STATE.activeView === 'matrix') {
                  updateMatrixCellsOnly();
                } else {
                  renderClassicChain();
                }
              }
            })
            .catch(() => {})
            .finally(() => {
              isFetchingOptions = false;
            });
        } else if (spotChanged) {
          if (STATE.activeView === 'matrix') {
            updateMatrixCellsOnly();
          }
        }
      } catch (e) {}
    }, 1000);
  }

  // --- AUTHENTICATION & SECURITY GATE (PASSWORD: 1010) ---
  const REQUIRED_PASSWORD = '1010';

  function isUserAuthenticated() {
    return sessionStorage.getItem('delta_terminal_auth') === REQUIRED_PASSWORD;
  }

  function showLoginScreen() {
    if (DOM.loginScreen) {
      DOM.loginScreen.classList.remove('hidden');
      DOM.loginPasswordInput.value = '';
      DOM.loginErrorMsg.textContent = '';
      setTimeout(() => DOM.loginPasswordInput.focus(), 120);
    }
  }

  function hideLoginScreen() {
    if (DOM.loginScreen) {
      DOM.loginScreen.classList.add('hidden');
    }
  }

  function attemptLogin(entered) {
    if (entered === REQUIRED_PASSWORD) {
      sessionStorage.setItem('delta_terminal_auth', REQUIRED_PASSWORD);
      hideLoginScreen();
      playTickSound(true);
      // Immediately render existing data if present, and fetch live snapshot
      if (STATE.expiries.BTC.length > 0 && STATE.expiries.ETH.length > 0) {
        assignDefaultColumnExpiries();
        renderStraddleMatrix();
        initWebSocket();
        start1sPollingEngine();
      } else {
        fetchInitialSnapshot();
      }
    } else {
      DOM.loginErrorMsg.textContent = 'Incorrect password. Access denied.';
      DOM.loginCard.classList.add('shake');
      setTimeout(() => DOM.loginCard.classList.remove('shake'), 400);
      DOM.loginPasswordInput.value = '';
      DOM.loginPasswordInput.focus();
    }
  }

  function bindAuthListeners() {
    if (!DOM.loginForm) return;

    DOM.loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      attemptLogin(DOM.loginPasswordInput.value.trim());
    });

    DOM.loginPasswordInput.addEventListener('input', (e) => {
      DOM.loginErrorMsg.textContent = '';
      if (e.target.value === REQUIRED_PASSWORD) {
        attemptLogin(e.target.value);
      }
    });

    document.querySelectorAll('.pin-key[data-digit]').forEach(btn => {
      btn.addEventListener('click', () => {
        DOM.loginPasswordInput.value += btn.dataset.digit;
        DOM.loginErrorMsg.textContent = '';
        if (DOM.loginPasswordInput.value === REQUIRED_PASSWORD) {
          attemptLogin(DOM.loginPasswordInput.value);
        }
      });
    });

    if (DOM.btnPinClear) {
      DOM.btnPinClear.addEventListener('click', () => {
        DOM.loginPasswordInput.value = '';
        DOM.loginErrorMsg.textContent = '';
        DOM.loginPasswordInput.focus();
      });
    }

    if (DOM.btnPinBackspace) {
      DOM.btnPinBackspace.addEventListener('click', () => {
        DOM.loginPasswordInput.value = DOM.loginPasswordInput.value.slice(0, -1);
        DOM.loginPasswordInput.focus();
      });
    }

    if (DOM.btnTogglePassword) {
      DOM.btnTogglePassword.addEventListener('click', () => {
        const isPass = DOM.loginPasswordInput.type === 'password';
        DOM.loginPasswordInput.type = isPass ? 'text' : 'password';
        DOM.btnTogglePassword.textContent = isPass ? '🔒' : '👁️';
      });
    }

    if (DOM.btnLockTerminal) {
      DOM.btnLockTerminal.addEventListener('click', () => {
        sessionStorage.removeItem('delta_terminal_auth');
        if (STATE.pollTimer) {
          clearInterval(STATE.pollTimer);
          STATE.pollTimer = null;
        }
        if (STATE.ws) {
          try { STATE.ws.close(); } catch(e) {}
          STATE.ws = null;
        }
        showLoginScreen();
      });
    }
  }

  // --- INITIALIZE APPLICATION ---
  bindEventListeners();
  bindAuthListeners();

  if (isUserAuthenticated()) {
    hideLoginScreen();
    fetchInitialSnapshot();
  } else {
    showLoginScreen();
  }

})();

