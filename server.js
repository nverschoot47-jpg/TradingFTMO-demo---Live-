"use strict";
// ═══════════════════════════════════════════════════════════════
//  PRONTO-AI  v13.3.0  server.js
//
//  CHANGES v13.3.0:
//  1. RR MILESTONES 0.1R GRANULARITEIT (Open Positions + Ghost Tracker):
//     updateGhost() trackt nu alle RR stappen van -1.0R t/m +15.0R
//     in stappen van 0.1R. Keys worden opgeslagen als strings:
//     FAV: "0.1", "0.2", ... "15.0" in rrMilestones
//     ADV: "-0.1", "-0.2", ... "-1.0" in rrMilestones
//     Backward compatible met legacy integer keys (1,2,3,5,10).
//
//  2. GHOST HISTORY RR MILESTONES:
//     Detail sub-tabel toont alle 0.1R milestone kolommen per trade.
//     SL HIT = peak -RR altijd gelijkgesteld aan 100% / -1.0R.
//     rrMilestones worden doorgegeven via /api/ghost-history-by-pair.
//
//  3. COMPLIANCE DATE VERWIJDERD:
//     COMPLIANCE_DATE -> '2000-01-01' (geen filtering meer).
//     Compliance bar verborgen in dashboard.
//     loadAll() filtert trades niet meer op cutoff datum.
//
//  4. SELECTIEVE DATUMFILTER GHOST HISTORY:
//     Datefilter bovenaan Ghost History tab (van/tot datum).
//     loadGhostHistory() stuurt from/to params naar API.
//     /api/ghost-history-by-pair?from=YYYY-MM-DD&to=YYYY-MM-DD
//     loadGhostHistoryByPair(from, to) in db.js.
//
//  INHERITED (v13.2.0):
//  FIX 1a \-- VWAP EXHAUSTION BLOCK
//  FIX 1b \-- DUPLICATE POSITION BLOCK
//  KEY FIX: app.listen() fires BEFORE any DB/MetaAPI call.
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const helmet  = require("helmet");
const cron    = require("node-cron");

const db = require("./db");
const {
  COMPLIANCE_DATE, COMPLIANCE_DATE_MS,
  DEFAULT_RISK_BY_TYPE, SL_BUFFER_MULT, STOCK_SL_BUFFER_MULT,
  getBrusselsComponents, getBrusselsDateStr, getBrusselsDateOnly,
  getSession, getSubSession, isMarketOpen, canOpenNewTrade,
  isMonitoringActive, isGhostActive, isShadowActive,
  normalizeSymbol, getSymbolInfo, getVwapPosition, buildOptimizerKey,
} = require("./session");

// ── Version ──────────────────────────────────────────────────────
const VERSION = "14.9.11"; // v14.8.7: hotfix - bg used before initialization (ReferenceError crash) shadow fix (_slFF/_rrFF), type resolution client-side, ghost scroll, FAV 20 cols final fixes - Time/ALL OUTCOMES/no dup Lots ghost_trades has peak_rr/realized/lots, ghost finalized from individual trades ghost finalized uses individual ghost_trades, fin header fixed, mt5comment in fin no scroll tables, dup lots fixed, all scroll removed fixed trades header, signal highlights, 500 row limit, Dutch->English Peak- in RR, no scroll tables, English labels, signal cols fixed, realPnl chain fix rrNow/buyCnt direction case, ghost KPI peakRR from ghost subobj, remove date filter bdDir/bdVwap case-insensitive, shows BUY/ABOVE correctly fix 500 on open-positions (symInfo undefined), fix openPositions in browser, fix loadHeader ghost block FX/STK/IDX/COM labels, ghost stopReason never manual, realPnl EUR, mt5Comment at placement FX/STK labels, ghost col cleanup, close reason SL/TP only mt5Comment in trades, ghost stop labels, outcome badges, what-if comment, SYNC_RAW removed asset_type in signal_log, daily log from open pos, mt5 comment in ghost, slDist/tvEntry in adopt fmtMs global helper, no inline functions in templates, browser syntax error fixed auto currency detection EUR/USD, correct conversion, currency symbol in dashboard USD->EUR conversion, verbose logs removed, complete API fields, mt5Comment shadowRow bdSess fix, milestone format fix, ghost active count fix, signal stats fix, data from 20/05 10:00 ghost restore assetType+vwapBandPct, all display fixes complete ghost restore assetType, ghost peakRRNeg display, signal log session cols, fin ghost realizedPnl fix startBalance fix, peakRRNeg display fix, exitPrice in trades, force adoption on startup, session fallback assetType everywhere, unrealizedPnl, signal outcomes, signal stats fixed correct signal outcomes, unrealizedPnl, assetType in API, signal stats per outcome /api/performance returns balance/equity/startBalance from latestEquity fix isTrackableBlock (no STOCK_OOH in shadow), bdSess fix fix bdSess template literal, add assetType/keyCount to shadow API MetaAPI auto-deploy on startup, stock timing 15:30-18:00, symInfoB crash fix fix symInfoB undefined crash, META_BASE global URL fix DB connection timeout 5s->15s, retry backoff 3s->5s, META_BASE london TP default 1.5R, session_high/low/day_high/low from webhook, vwapBandPct in all ghost saves MetaAPI 429 fix (60s cache), SL TV vs MT5 log, vwapBandPct everywhere, circuit open skip (1 aandeel=1lot, P&L=lots\xmove) // v14.3: bugs fixed (const->let adoptPosition, dupNumber, blockTypes, duplicate fetchHistoryDeals, NY_NIGHT/ASIA_MORNING shadow tracking) all milestone gaps fixed, outside night 21-02h, daily open log, ghost finalized fix, slHitAt EOD keep

// ── Config ───────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const META_API_TOKEN = process.env.META_API_TOKEN || "";
const META_ACCOUNT   = process.env.META_ACCOUNT   || "";
const META_BASE      = process.env.META_BASE || "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";

// ── App state ────────────────────────────────────────────────────
let dbReady          = false;   // true once initDB() succeeds
let openPositions    = new Map();
let blockedPositions = new Map(); // invisible ghost trackers voor blocked signals
let tpConfigs        = {};
let symbolRiskMap    = {};
let keyRiskMults     = {};
let liveComplianceDate = COMPLIANCE_DATE;

// Rolling error log (1 h window)
let errorLog = [];
function recordError(msg, ctx = {}) {
  const now = Date.now();
  errorLog.push({ ts: now, msg: String(msg).slice(0,500), ...ctx });
  errorLog = errorLog.filter(e => now - e.ts < 3_600_000);
  console.error("[ERR]", msg, Object.keys(ctx).length ? JSON.stringify(ctx) : '');
}
// Structured event logger for key trading events
function logEvent(type, data = {}) {
  console.log(`[${type}]`, JSON.stringify(data));
}
function getErrorCount() {
  const now = Date.now();
  return errorLog.filter(e => now - e.ts < 3_600_000).length;
}

// ── Express \-- start listening IMMEDIATELY ────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));

const server = app.listen(PORT, () => {
  console.log(`[PRONTO-AI v${VERSION}] Server running on port ${PORT}`);
  console.log('[FIXES] weekend-sync | ghost-combined | stock-session | peak-rr-neg');
  console.log(`[PRONTO-AI] Listening on port ${PORT} \-- DB init starting...`);
});

// ── Webhook secret check ──────────────────────────────────────────
function checkSecret(req, res) {
  if (!WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Unauthorized \-- WEBHOOK_SECRET not configured' });
    return false;
  }
  // v14.1: Header-only auth. Query params are logged by proxies/Railway \-- security risk.
  // TradingView supports custom headers: add "x-webhook-secret: YOUR_SECRET" in alert config.
  // Body/query fallback kept ONLY for backward compat with existing TV alerts (deprecated).
  const provided = req.headers['x-webhook-secret']
    || req.headers['x-secret']
    || req.body?.secret   // deprecated: body secret logged in Railway access logs
    || req.query?.secret; // deprecated: URL params logged everywhere \-- migrate to header
  if (provided !== WEBHOOK_SECRET) {
    const ip = req.ip || '?';
    recordError(`Bad webhook secret from ${ip} \-- migrate TradingView alerts to x-webhook-secret header`);
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ── MetaAPI helpers ───────────────────────────────────────────────
// Circuit breaker for MetaAPI \-- tracks consecutive failures
let _metaFailCount = 0;
let _metaCircuitOpen = false;
let _metaCircuitOpenAt = 0;
const META_CIRCUIT_THRESHOLD = 5;     // open after 5 consecutive failures
const META_CIRCUIT_RESET_MS  = 120000; // wait 120s \-- MetaAPI 429 needs time to clear rate limit
// Helper: readable circuit state for other functions
const circuitOpen = () => _metaCircuitOpen && (Date.now() - _metaCircuitOpenAt < META_CIRCUIT_RESET_MS);

async function metaFetch(path, method = "GET", body = null, retries = 2) {
  // Circuit breaker: if MetaAPI is known-down, fail fast
  if (_metaCircuitOpen) {
    if (Date.now() - _metaCircuitOpenAt > META_CIRCUIT_RESET_MS) {
      _metaCircuitOpen = false; _metaFailCount = 0;
      console.log('[MetaAPI] Circuit breaker reset \-- retrying');
    } else {
      throw new Error('MetaAPI circuit open \-- skipping call');
    }
  }
  const url = `${META_BASE}${path}`;
  const opts = {
    method,
    headers: { "auth-token": META_API_TOKEN, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(12000), // 12s \-- leaves buffer for 30s cron
  };
  if (body) opts.body = JSON.stringify(body);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        let errBody = "";
        try { errBody = await res.text(); } catch {}
        throw new Error(`MetaAPI ${method} ${path} -> ${res.status} ${errBody.slice(0, 200)}`);
      }
      // Success \-- reset failure counter
      _metaFailCount = 0;
      return res.json().catch(() => null);
    } catch (e) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // backoff: 1s, 2s
        continue;
      }
      // All retries failed
      _metaFailCount++;
      if (_metaFailCount >= META_CIRCUIT_THRESHOLD) {
        _metaCircuitOpen = true;
        _metaCircuitOpenAt = Date.now();
        recordError(`MetaAPI circuit OPEN after ${_metaFailCount} failures`);
      }
      throw e;
    }
  }
}

// ── getAccountInfo: 60s cache \-- prevents TooManyRequests 429 on MetaAPI ──
// MetaAPI has strict rate limits. Calling this every 10s sync causes 429 storms.
// Cache ensures max 1 real call per 60s across ALL callers (sync, /status, webhook).
let _acctCache   = null;
let _acctCacheTs = 0;
const ACCT_CACHE_TTL = 60000; // 60 seconds

async function getAccountInfo() {
  const now = Date.now();
  if (_acctCache && (now - _acctCacheTs) < ACCT_CACHE_TTL) {
    return _acctCache; // return cached \-- no MetaAPI call
  }
  if (!META_API_TOKEN || !META_ACCOUNT) {
    console.warn("[MetaAPI] getAccountInfo: TOKEN or ACCOUNT not set");
    return null;
  }
  try {
    const data = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`);
    if (data?.balance !== undefined) {
      _acctCache   = data;
      _acctCacheTs = now;
      if (data.currency) latestAccountCurrency = data.currency;
      console.log(`[MetaAPI] getAccountInfo: balance=${data.balance} equity=${data.equity} currency=${data.currency} (cached 60s)`);
    }
    return data;
  } catch (e) {
    recordError(`getAccountInfo: ${e.message}`);
    return _acctCache ?? null; // return stale cache on error rather than null
  }
}

async function getPositions() {
  if (!META_API_TOKEN || !META_ACCOUNT) return [];
  try {
    const d = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/positions`);
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

async function placeOrder(order) {
  return metaFetch(`/users/current/accounts/${META_ACCOUNT}/trade`, "POST", order);
}

async function closePositionMeta(positionId) {
  return metaFetch(`/users/current/accounts/${META_ACCOUNT}/positions/${positionId}/close`, "POST", {});
}

async function fetchHistoryDeals(positionId) {
  try {
    const to   = new Date().toISOString();
    const from = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const d    = await metaFetch(
      `/users/current/accounts/${META_ACCOUNT}/history-deals/position/${positionId}?from=${from}&to=${to}`
    );
    return Array.isArray(d) ? d : (d?.deals ?? []);
  } catch { return []; }
}

// ── DB timeout wrapper ───────────────────────────────────────────
function dbCall(promise, fallback, ms = 7000) {
  return Promise.race([
    promise.catch(e => { recordError(e.message); return fallback; }),
    new Promise(r => setTimeout(() => r(fallback), ms)),
  ]);
}

// ── Ghost helpers ────────────────────────────────────────────────
function initGhost(pos) {
  return {
    positionId:   pos.positionId,
    optimizerKey: pos.optimizerKey,
    symbol:       pos.symbol,
    mt5Symbol:    pos.mt5Symbol,
    session:      pos.session,
    direction:    pos.direction,
    vwapPosition: pos.vwapPosition,
    entry:        parseFloat(pos.entry),
    sl:           parseFloat(pos.sl),
    slPct:        pos.slPct,
    tpRRUsed:     pos.tpRRUsed,
    maxPrice:     parseFloat(pos.entry),
    maxRR:        0,
    maxSlPctUsed: 0,
    openedAt:     pos.openedAt,
    riskPct:      pos.riskPct,
    riskEUR:      pos.riskEUR,
    evMult:       pos.evMult ?? 1.0,
    dayMult:      pos.dayMult ?? 1.0,
    tradeNumber:  pos.tradeNumber,
    peakRRPos:    0,
    peakRRNeg:    0,
    slMilestones: {},
    rrMilestones: {},
    phantomSLHit: false,
    stopReason:   null,
    timeToSLMin:  null,
    closedAt:     null,
  };
}

function updateGhost(ghost, price) {
  // Don't update after phantom SL hit \-- that is the ONLY way a ghost closes now
  if (ghost.phantomSLHit) return;
  price = parseFloat(price);
  const entry   = ghost.entry;
  const sl      = ghost.sl;
  const slRange = Math.abs(entry - sl);
  if (slRange <= 0) return;
  const isBuy = ghost.direction === "buy";
  if (isBuy ? price > ghost.maxPrice : price < ghost.maxPrice) ghost.maxPrice = price;
  const fav  = isBuy ? price - entry : entry - price;
  const rr   = parseFloat((fav / slRange).toFixed(4));
  if (rr > ghost.maxRR) ghost.maxRR = rr;
  if (rr > ghost.peakRRPos) ghost.peakRRPos = rr;
  const adv    = isBuy ? entry - price : price - entry;
  const slUsed = parseFloat(((adv / slRange) * 100).toFixed(2));
  if (slUsed > ghost.maxSlPctUsed) ghost.maxSlPctUsed = slUsed;
  if (slUsed > ghost.peakRRNeg)    ghost.peakRRNeg    = slUsed;
  for (const p of [25, 50, 75, 90, 100])
    if (slUsed >= p && !ghost.slMilestones[p]) ghost.slMilestones[p] = new Date().toISOString();
  // FAV milestones: 0.1R steps from 0.1 to 15.0
  // Key format: '+0.1', '+0.2', ... '+15.0' (dashboard expects '+' prefix)
  for (let rv = 0.1; rv <= 15.0 + 1e-9; rv = Math.round((rv + 0.1) * 10) / 10) {
    const key = '+' + rv.toFixed(1);
    if (rr >= rv - 1e-9 && !ghost.rrMilestones[key]) {
      ghost.rrMilestones[key] = Date.now(); // timestamp in ms for elapsed time calc
    }
  }
  // ADV milestones: 0.1 steps from 0.1 to 1.0 (stored as -0.1 to -1.0)
  const advRR = isBuy ? (entry - price) / slRange : (price - entry) / slRange;
  for (let rv = 0.1; rv <= 1.0 + 1e-9; rv = Math.round((rv + 0.1) * 10) / 10) {
    const key = '-' + rv.toFixed(1);
    if (advRR >= rv - 1e-9 && !ghost.rrMilestones[key]) {
      ghost.rrMilestones[key] = Date.now(); // timestamp in ms
    }
  }
  const hitSL = isBuy ? price <= sl : price >= sl;
  if (hitSL && !ghost.phantomSLHit) {
    ghost.phantomSLHit = true;
    ghost.stopReason   = "phantom_sl";
    ghost.slHitAt      = new Date().toISOString();
    // Save sub_session at SL hit time (stap 1)
    if (!ghost.subSession) {
      try { ghost.subSession = getSubSession ? getSubSession() : null; } catch(_){}
    }
    // STAP 2 FIX: null-safe openedAt guard
    const openedTs = ghost.openedAt
      ? new Date(ghost.openedAt).getTime()
      : Date.now() - 60000; // fallback: 1m ago
    ghost.timeToSLMin = Math.round((Date.now() - openedTs) / 60000);
    const elapsed = Math.max(1, ghost.timeToSLMin);
    // All 10 ADV milestones filled: -X.XR hit at openedAt + elapsed*X.X minutes
    // -0.1R = 10% of elapsed (hit first), -1.0R = 100% of elapsed (hit last = SL)
    for (const step of [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1]) {
      const key = '-' + step.toFixed(1);
      if (!ghost.rrMilestones[key]) {
        ghost.rrMilestones[key] = new Date(openedTs + Math.round(elapsed * step * 60000)).toISOString();
      }
    }
  }
  // NOTE: ghost no longer auto-closes at 15R \-- runs until phantom SL hit (-1R)
  // 15R milestone is still tracked but does NOT finalize the ghost
  if (rr >= 15 && !ghost.rrMilestones['+15.0']) {
    // Just a milestone record, not a stop
  }
}

async function closePosition(positionId, reason = "manual", pnl = null) {
  const pos = openPositions.get(positionId);
  if (!pos) return;
  openPositions.delete(positionId);
  const ghost = pos.ghost;
  const now   = new Date().toISOString();
  let realPnl = pnl;

  // Fetch deals
  if (dbReady) {
    try {
      const deals = await fetchHistoryDeals(positionId);
      for (const d of deals) {
        await db.saveDeal({ positionId, dealId: d.id ?? d.dealId, symbol: d.symbol,
          type: d.type, profit: d.profit ?? 0, commission: d.commission ?? 0,
          swap: d.swap ?? 0, volume: d.volume, price: d.price, time: d.time });
      }
      // Try DB deals first, then MetaAPI deals, then closingDeal profit
      let _rawPnl = await db.fetchRealizedPnl(positionId).catch(()=>null);
      if (_rawPnl == null && closingDeal?.profit != null) {
        _rawPnl = parseFloat(closingDeal.profit);
      }
      if (_rawPnl == null && pnl != null) _rawPnl = pnl;
      const _posExRate = pos?.exchangeRate ?? (latestAccountCurrency === 'EUR' ? 1.0 : 1.0);
      realPnl = _rawPnl != null ? parseFloat((_rawPnl * _posExRate).toFixed(2)) : null;
    } catch (e) { recordError(`closePos deals: ${e.message}`); }
  }
  // v14.2 FIX: Gap detection \-- uses deals already fetched above (no second call)
  let gapStop = false;
  if (reason === 'sl' && pos) {
    try {
      const slDist = Math.abs(pos.entry - pos.sl);
      const deals = (dbReady ? await fetchHistoryDeals(positionId).catch(() => []) : []);
      const closingDeal = deals
        .filter(d => d.entryType === 'DEAL_ENTRY_OUT' || (d.type||'').includes('OUT'))
        .sort((a,b) => new Date(b.time||0) - new Date(a.time||0))[0];
      if (closingDeal && slDist > 0) {
        const fillPrice = parseFloat(closingDeal.price ?? closingDeal.executionPrice ?? 0);
        if (fillPrice > 0) {
          // How far PAST the SL was the actual fill?
          const overrun = pos.direction === 'buy'
            ? pos.sl - fillPrice    // buy: SL is below entry, fill should be AT SL, gap = fill below SL
            : fillPrice - pos.sl;   // sell: SL is above entry, gap = fill above SL
          // If fill is more than 0.5\x slDist past the SL -> gap
          if (overrun > slDist * 0.5) {
            gapStop = true;
            console.warn(`[Gap] ${positionId} ${pos.symbol} stopped via GAP \-- fill=${fillPrice} SL=${pos.sl} overrun=${overrun.toFixed(5)}`);
          }
        }
      }
    } catch { /* non-critical */ }
  }
  const finalCloseReason = gapStop ? 'sl_gap' : reason;

  if (ghost && dbReady) {
    ghost.closedAt       = now;
    // stopReason: never "manual" \-- use the close reason (sl/tp) as fallback
    const _finalGhostStop = gapStop ? 'gap_stop' 
      : ghost.stopReason && ghost.stopReason !== 'manual' ? ghost.stopReason
      : reason === 'manual' ? 'sl'  // fallback: manual close treated as SL
      : reason;
    ghost.stopReason = _finalGhostStop;
    // For gap stops: price jumped past SL - record all ADV milestones as triggered
    if (_finalGhostStop === 'gap_stop' && ghost.rrMilestones) {
      const _now = Date.now();
      for (const _rv of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
        const _k = '-' + _rv.toFixed(1);
        if (!ghost.rrMilestones[_k]) ghost.rrMilestones[_k] = _now;
      }
    }
    ghost.realizedPnlEUR = realPnl ?? null;
    ghost.lots           = pos.lots ?? null;
    ghost.mt5Comment     = pos.orderComment ?? pos.mt5Comment ?? pos.comment ?? null;
    ghost.vwapBandPct    = pos.vwapBandPct ?? ghost.vwapBandPct ?? null;
    await db.saveGhostTrade({ ...ghost, maxRRBeforeSL: ghost.maxRR }).catch(e => recordError(e.message));
    db.computeAndSaveGhostComboAnalysis(ghost.optimizerKey).catch(() => {});
    // v14.2: Check if this ghost pushed us over the TP lock threshold
    // Don't wait for the hourly cron \-- recompute TP immediately
    const gcCount = await db.countGhostsByKey(ghost.optimizerKey).catch(() => 0);
    if (gcCount >= 10) {
      setTimeout(() => runTPOptimizer().catch(() => {}), 2000); // async, 2s delay
    }
  }

  if (dbReady) {
    // Extract exit price from deals (the actual fill price at close)
    let exitPrice = null;
    try {
      const closeDeals = await fetchHistoryDeals(positionId).catch(() => []);
      const closingDeal = closeDeals
        .filter(d => d.entryType === 'DEAL_ENTRY_OUT' || (d.type||'').includes('OUT'))
        .sort((a,b) => new Date(b.time||0) - new Date(a.time||0))[0];
      if (closingDeal) exitPrice = parseFloat(closingDeal.price ?? closingDeal.executionPrice ?? 0) || null;
    } catch(e) { /* non-critical */ }

    await db.saveTrade({
      positionId, symbol: pos.symbol, mt5Symbol: pos.mt5Symbol,
      direction: pos.direction, vwapPosition: pos.vwapPosition,
      entry: pos.entry, sl: pos.sl, tp: pos.tp, lots: pos.lots,
      riskPct: pos.riskPct, riskEUR: pos.riskEUR,
      maxPrice: ghost?.maxPrice ?? pos.entry, maxRR: ghost?.maxRR ?? 0,
      trueMaxRR: ghost?.maxRR ?? 0, trueMaxPrice: ghost?.maxPrice ?? pos.entry,
      ghostStopReason: ghost?.stopReason, ghostFinalizedAt: now,
      session: pos.session, vwapAtEntry: pos.vwapAtEntry,
      openedAt: pos.openedAt, closedAt: now,
      slMultiplier: pos.slMultiplier ?? 1.0,
      realizedPnlEUR: realPnl, hitTP: reason === 'tp',
      closeReason: finalCloseReason,
      spreadAtEntry: pos.spreadAtEntry, vwapBandPct: pos.vwapBandPct,
      executionPrice: pos.executionPrice, tvEntry: pos.tvEntry, slippage: pos.slippage,
      exitPrice: exitPrice ?? (reason === 'tp' ? pos.tp : pos.sl) ?? null,
      assetType: pos.assetType ?? null,
      tradeNumber: pos.tradeNumber ?? null,
      mt5Comment: pos.orderComment ?? pos.mt5Comment ?? pos.comment ?? null,
    }).catch(e => recordError(e.message));
    db.deleteGhostState(positionId).catch(() => {});
  }
  logEvent('TRADE_CLOSED', { positionId, symbol: pos.symbol, direction: pos.direction, reason: finalCloseReason, pnl: realPnl, gapStop });
}

// ── Blocked Ghost helpers ─────────────────────────────────────────
// Maak een invisible ghost tracker voor een geblokkeerd signaal
function initBlockedGhost({ blockType, blockTypes, symbol, mt5Symbol, session, direction,
    vwapPosition, entry, sl, slPct, tpRRUsed, optimizerKey, vwapBandPct, blockReason,
    keyCount, duplicateCount, subSession, type }) {
  const id = `BGT_${Date.now()}_${optimizerKey}`.replace(/[^a-z0-9_]/gi, '_');
  return {
    id, blockType, blockTypes: blockTypes ?? [blockType], optimizerKey, symbol, mt5Symbol: mt5Symbol ?? symbol,
    session, direction, vwapPosition: vwapPosition ?? 'unknown',
    entry: parseFloat(entry), sl: parseFloat(sl),
    slPct: slPct ?? null, tpRRUsed: tpRRUsed ?? null,
    maxPrice: parseFloat(entry), maxRR: 0, maxSlPctUsed: 0,
    peakRRPos: 0, peakRRNeg: 0,
    slMilestones: {}, rrMilestones: {},
    phantomSLHit: false, stopReason: null, timeToSLMin: null,
    vwapBandPct: vwapBandPct ?? null, blockReason: blockReason ?? null,
    duplicateCount: duplicateCount ?? null,
    keyCount: keyCount ?? null,
    subSession: subSession ?? null,
    assetType: type ?? null,
    openedAt: new Date().toISOString(), closedAt: null,
  };
}

async function closeBlockedGhost(id, reason = 'timeout') {
  const bg = blockedPositions.get(id);
  if (!bg) return;
  blockedPositions.delete(id);
  bg.closedAt   = new Date().toISOString();
  bg.stopReason = bg.stopReason ?? reason;
  if (dbReady) {
    await db.saveBlockedGhostTrade(bg).catch(e => recordError(`saveBlockedGhostTrade: ${e.message}`));
    db.deleteBlockedGhostState(id).catch(() => {});
  }
  console.log(`[BlockedGhost] Closed ${id} ${bg.symbol} ${bg.direction} reason=${reason}`);
}

// ── Adopt an MT5 position that is not in openPositions ───────────
// Wordt aangeroepen bij syncPositions wanneer een live MT5 positie
// niet in memory zit \-- bv. na een deploy/restart terwijl er een trade open stond.
// Reconstrueert de positie vanuit MT5 data + comment parsing.
function parseMT5Comment(comment = '') {
  // Two comment formats:
  // OLD: "S-NY-UNK #10"           -> DIR-SESS-VWAP #N
  // NEW: "EURCHF S-LD-ABV #1"     -> SYMBOL DIR-SESS-VWAP #N
  // NEW: "NZDCHF B-LD-ABV #1"     -> SYMBOL DIR-SESS-VWAP #N
  const dirMap  = { B: 'buy',  S: 'sell' };
  const sessMap = { NY: 'ny',  LD: 'london', AS: 'asia', LOND: 'london' };
  const vwapMap = { ABV: 'above', BLW: 'below', UNK: 'unknown' };
  const parts   = comment.trim().toUpperCase().split(/[\s#]+/);
  
  // Try each part as the DIR-SESS-VWAP segment
  for (let i = 0; i < Math.min(parts.length, 2); i++) {
    const segs = parts[i].split('-');
    const dir  = dirMap[segs[0]];
    const sess = sessMap[segs[1]];
    const vwap = vwapMap[segs[2]] ?? 'unknown';
    if (dir && sess) {
      // Found a valid DIR-SESS segment \-- get trade number from next hash part
      const numPart = parts.find((p, j) => j > i && /^\d+$/.test(p));
      return {
        direction:    dir,
        session:      sess,
        vwapPosition: vwap,
        tradeNumber:  numPart ? parseInt(numPart) : null,
      };
    }
  }
  // Fallback: try MT5 type field (handled in adoptPosition)
  return { direction: null, session: null, vwapPosition: 'unknown', tradeNumber: null };
}

async function adoptPosition(lp) {
  const id  = String(lp.id);
  if (openPositions.has(id)) return; // already tracked

  // Resolve symbol
  const rawSym  = lp.symbol ?? '';
  const symbol  = normalizeSymbol(rawSym) ?? rawSym;
  const symInfo = getSymbolInfo(symbol);
  const mt5Sym  = rawSym; // keep original MT5 symbol

  // Parse comment for direction/session/vwap
  const parsed = parseMT5Comment(lp.comment ?? '');
  // Determine direction: comment parse -> MT5 type field -> current position type
  const lpType = (lp.type ?? lp.positionType ?? '').toString().toUpperCase();
  const isBuyType = lpType.includes('BUY') || lpType === 'BUY' || lpType === 'POSITION_TYPE_BUY';
  const direction = parsed.direction ?? (isBuyType ? 'buy' : 'sell');
  const session   = parsed.session ?? getSession();
  const vwapPos   = parsed.vwapPosition ?? 'unknown';
  let entry     = parseFloat(lp.openPrice ?? lp.currentPrice ?? 0);
  let sl        = parseFloat(lp.stopLoss  ?? 0);
  let tp        = parseFloat(lp.takeProfit ?? 0) || null;
  let lots      = parseFloat(lp.volume ?? 0);
  const openedAt  = (lp.time ?? lp.openTime) ? new Date(lp.time ?? lp.openTime).toISOString() : new Date().toISOString();
  const optKey    = buildOptimizerKey(symbol, session, direction, vwapPos);

  // Guard: don't adopt if we can't determine direction reliably \-- log and skip
  if (!direction) {
    console.error(`[Adopt] SKIP ${id} ${symbol} \-- cannot determine direction. lp.type="${lp.type}", comment="${lp.comment ?? ''}"`);
    return;
  }

  // Estimate SL pct from entry/sl distance
  const slPct = entry > 0 && sl > 0 ? Math.abs(entry - sl) / entry : 0.003;

  // Use ALL available MT5 data for adopted positions \-- handle all field variants
  const lpVol2    = lp.volume ?? lp.currentVolume ?? lp.size;
  const lpSL2     = lp.stopLoss ?? lp.currentStopLoss;
  const lpTP2     = lp.takeProfit ?? lp.currentTakeProfit;
  const lpProfit2 = lp.profit ?? lp.unrealizedProfit ?? lp.currentProfit;
  const lpPrice2  = lp.currentPrice ?? lp.currentBid ?? lp.currentAsk ?? lp.openPrice;
  const liveLots  = lpVol2 != null ? Math.max(0, parseFloat(lpVol2)) : lots;
  const liveSL    = lpSL2 ? parseFloat(lpSL2) : sl;
  const liveTP    = lpTP2 ? (parseFloat(lpTP2) || null) : tp;
  const livePnl   = lpProfit2 != null ? parseFloat(lpProfit2) : null;
  const liveEntry = lp.openPrice ? parseFloat(lp.openPrice) : entry;
  const livePrice = lpPrice2 ? parseFloat(lpPrice2) : null;
  logEvent('ADOPT', { id: lp.id, symbol: lp.symbol, lots: liveLots, profit: livePnl, price: livePrice });
  // Override with live values
  if (liveLots)  lots  = liveLots;
  if (liveSL)    sl    = liveSL;
  if (liveTP)    tp    = liveTP;
  if (liveEntry) entry = liveEntry;

  // Always resolve assetType for adopted positions - critical for risk calculation
  const _resolvedType = symInfo?.type ?? (
    // Fallback: detect by symbol name pattern
    /USD$|EUR$|GBP$|JPY$|CHF$|CAD$|AUD$|NZD$/.test(symbol) ? 'forex' :
    /US30|NAS100|DE30|UK100|GER40|SPX|DAX|FTSE|cash$/.test(symbol) ? 'index' :
    /XAUUSD|XAGUSD|OIL|GAS|WHEAT|CORN/.test(symbol) ? 'commodity' : 'forex'
  );
  const assetTypeA = _resolvedType;
  const slDistA = Math.abs(entry - sl);
  let riskEURAdopted = null;
  if (lots > 0 && slDistA > 0) {
    if (assetTypeA === 'index')     riskEURAdopted = lots * slDistA;  // index: 1 lot = 1 unit, P&L = lots \x points
    else if (assetTypeA === 'stock')riskEURAdopted = lots * slDistA;  // stock CFD: 1 lot = 1 share
    else if (assetTypeA === 'commodity') riskEURAdopted = lots * slDistA * 100;
    else                            riskEURAdopted = lots * 100000 * slDistA; // forex default
    riskEURAdopted = parseFloat(riskEURAdopted.toFixed(2));
  }
  const equityA  = latestEquity || 50000;
  const riskPctA = riskEURAdopted ? riskEURAdopted / equityA : null;

  const pos = {
    positionId: id, symbol, mt5Symbol: mt5Sym,
    direction, vwapPosition: vwapPos, session,
    entry, sl, tp, lots,
    riskPct: riskPctA, riskEUR: riskEURAdopted,
    openedAt, optimizerKey: optKey,
    tpRRUsed: tp && sl && entry ? Math.abs(tp - entry) / Math.abs(entry - sl) : null,
    slMultiplier: null, tradeNumber: parsed.tradeNumber,
    // Reconstruct SL metrics from MT5 data for ghost display
    slDist: sl && entry ? parseFloat(Math.abs(entry - sl).toFixed(6)) : null,
    slPctFinal: sl && entry && entry > 0 ? parseFloat((Math.abs(entry - sl) / entry * 100).toFixed(4)) : null,
    tvEntry: entry, // use MT5 openPrice as tvEntry approximation for adopted positions
    liveProfitMT5: livePnl ?? null,
    unrealizedPnl: livePnl ?? null,
    currentPrice:  livePrice ?? (lp.currentPrice ? parseFloat(lp.currentPrice) : null),
    assetType: symInfo?.type ?? getSymbolInfo(normalizeSymbol(rawSym)??rawSym)?.type ?? null,
    type: symInfo?.type ?? getSymbolInfo(normalizeSymbol(rawSym)??rawSym)?.type ?? null,
    exchangeRate: latestAccountCurrency === 'EUR' ? 1.0 : parseFloat(lp.accountCurrencyExchangeRate ?? 1.0),
    accountCurrency: latestAccountCurrency,
    lots: parseFloat(lp.volume ?? lp.lots ?? 0),
    mt5Comment: lp.comment ?? lp.brokerComment ?? null,
    ghost: null,
  };
  pos.ghost = initGhost({ ...pos, slPct });
  openPositions.set(id, pos);

  if (dbReady) db.saveGhostState(pos.ghost).catch(() => {});
  console.log(`[Adopt] Hersteld MT5 positie ${id} ${symbol} ${direction} entry=${entry} \-- comment="${lp.comment ?? ''}"`);
}

// ── Position sync (cron) ─────────────────────────────────────────
let _syncRunning  = false;
let _syncCount    = 0;
let latestEquity  = 50000;   // updated by pollStatus / placeOrder
let latestAccountCurrency = process.env.ACCOUNT_CURRENCY || 'USD'; // auto-detected from MetaAPI
let _lastEquityRecord = 0;   // timestamp of last equity_curve insert
async function syncPositions() {
  // Always sync \-- weekends included. Market may be closed but positions exist.
  if (!dbReady) return;
  if (_syncRunning) {
    console.warn('[Sync] Skipping \-- previous sync still running');
    return;
  }
  _syncRunning = true;
  try {
    await _doSyncPositions();
  } finally {
    _syncRunning = false;
  }
}
async function _doSyncPositions() {
  // Run sync ALWAYS \-- even weekends. Positions stay open over weekend.
  // isMonitoringActive() only affects NEW trade signals, not position tracking.
  if (!dbReady) return;
  // Update equity from account info every 5 syncs (~2.5 min)
  _syncCount = (_syncCount || 0) + 1;
  // Update equity from account info every 10 syncs (~100s) \-- avoid 429 TooManyRequests
  if (_syncCount % 10 === 1 && !circuitOpen()) {
    try {
      const acct = await getAccountInfo(); // has 60s internal cache
      if (acct?.equity && acct.equity > 0) latestEquity = parseFloat(acct.equity);
    } catch {} // non-critical
  }
  const live = await getPositions();
  const liveIds = new Set(live.map(p => String(p.id)));

  // Sluit posities die niet meer in MT5 zitten \-- detecteer SL/TP via deals
  for (const [id] of openPositions) {
    if (!liveIds.has(id)) {
      // v13.5.1: probeer close reason te detecteren via history deals
      let closeReason = "manual";
      try {
        const deals = await fetchHistoryDeals(id);
        // Zoek de sluitende deal (laatste deal voor deze positie)
        const closingDeal = deals
          .filter(d => d.entryType === 'DEAL_ENTRY_OUT' || d.entryType === 'out' || (d.type && d.type.includes('OUT')))
          .sort((a,b) => new Date(b.time||b.createdAt||0) - new Date(a.time||a.createdAt||0))[0]
          ?? deals[deals.length - 1];
        if (closingDeal) {
          const r = (closingDeal.reason ?? closingDeal.closeReason ?? '').toString().toUpperCase();
          const t = (closingDeal.type ?? '').toString().toUpperCase();
          if (r.includes('SL') || r.includes('STOP_LOSS') || t.includes('SL')) closeReason = 'sl';
          else if (r.includes('TP') || r.includes('TAKE_PROFIT') || t.includes('TP')) closeReason = 'tp';
          // Profit-based fallback: als SL prijs bereikt is
          const pos = openPositions.get(id);
          if (closeReason === 'manual' && pos && closingDeal.profit != null) {
            const profit = parseFloat(closingDeal.profit);
            const currentPrice = parseFloat(closingDeal.price ?? 0);
            // Use price vs SL/TP to determine close reason
            if (pos.sl && pos.tp && currentPrice > 0) {
              const slDist = Math.abs(currentPrice - parseFloat(pos.sl));
              const tpDist = Math.abs(currentPrice - parseFloat(pos.tp));
              closeReason = slDist <= tpDist ? 'sl' : 'tp';
            } else if (profit < 0) {
              closeReason = 'sl';
            } else if (profit > 0) {
              closeReason = 'tp';
            } else {
              closeReason = 'sl'; // fallback - never show "manual"
            }
          }
        }
      } catch (e) { closeReason = 'sl'; /* fallback is always SL, never manual */ }
      await closePosition(id, closeReason, null);
    }
  }

  for (const lp of live) {
    const id  = String(lp.id);
    const pos = openPositions.get(id);
    if (!pos) {
      // ── v13.5: positie bestaat in MT5 maar niet in memory -> adopteer ──
      await adoptPosition(lp);
    } else {
      // ALWAYS sync MT5 position data \-- handle multiple MetaAPI field name variants
      // Lots: volume / currentVolume / size
      const lpVol = lp.volume ?? lp.currentVolume ?? lp.size;
      if (lpVol != null) pos.lots = Math.max(0, parseFloat(lpVol));

      // SL / TP: currentStopLoss fallback
      const lpSL = lp.stopLoss ?? lp.currentStopLoss;
      const lpTP = lp.takeProfit ?? lp.currentTakeProfit;
      if (lpSL) pos.sl = parseFloat(lpSL);
      if (lpTP) pos.tp = parseFloat(lpTP) || null;

      // P&L: profit / unrealizedProfit / currentProfit / swap included
      const lpProfit = lp.profit ?? lp.unrealizedProfit ?? lp.currentProfit;
      if (lpProfit != null) {
        // Currency conversion: EUR account = no conversion, USD = use exchange rate
        const _rawProfit = parseFloat(lpProfit);
        const _exRate = latestAccountCurrency === 'EUR' ? 1.0
          : parseFloat(lp.accountCurrencyExchangeRate ?? 1.0);
        const _profitDisplay = parseFloat((_rawProfit * _exRate).toFixed(2));
        pos.liveProfitMT5  = _profitDisplay;
        pos.unrealizedPnl  = _profitDisplay;
        pos.profitRaw      = _rawProfit;
        pos.exchangeRate   = _exRate;
        pos.accountCurrency = latestAccountCurrency;
      }
      // Always resolve assetType from symbol catalog
      if (pos.symbol) {
        const _si = getSymbolInfo(normalizeSymbol(pos.symbol) ?? pos.symbol);
        if (_si?.type) {
          pos.assetType = _si.type;
          pos.type = _si.type;
        }
      }
      // Keep currentPrice in sync
      if (lp.currentPrice) pos.currentPrice = parseFloat(lp.currentPrice);

      // Current price: currentPrice / currentBid / currentAsk / openPrice fallback
      const lpPrice = lp.currentPrice ?? lp.currentBid ?? lp.currentAsk ?? lp.openPrice;
      if (lpPrice) pos.currentPrice = parseFloat(lpPrice);

      // Entry price: openPrice
      if (lp.openPrice) pos.entry = pos.entry || parseFloat(lp.openPrice);

      // Log first time we get data for a position (debugging)
      pos._synced = true; // position data received}
      if (pos.ghost) {
        if (!pos.ghost.direction || !pos.ghost.entry || !pos.ghost.sl) {
          console.warn(`[Sync] Skipping ghost ${id} ${pos.symbol} \-- missing direction/entry/sl`);
          continue;
        }
        // Use best available price for ghost tracking
        const priceForGhost = lp.currentPrice ?? lp.currentBid ?? lp.currentAsk ?? lp.openPrice;
        if (priceForGhost) {
          const wasHit = pos.ghost.phantomSLHit;
          updateGhost(pos.ghost, priceForGhost);
          pos.ghost.lastPriceTs = Date.now();
          // v14.2: When phantom SL is just hit -> record slHitAt + save finalized ghost trade
          if (!wasHit && pos.ghost.phantomSLHit && dbReady) {
            pos.ghost.slHitAt  = new Date().toISOString();
            pos.ghost.closedAt = pos.ghost.slHitAt;
            pos.ghost.realizedPnlEUR = pos.liveProfitMT5 ?? null;
            pos.ghost.lots = pos.lots ?? null;
            db.saveGhostTrade({ ...pos.ghost, maxRRBeforeSL: pos.ghost.maxRR }).catch(e => recordError(e.message));
            db.computeAndSaveGhostComboAnalysis(pos.ghost.optimizerKey).catch(() => {});
            console.log(`[Ghost] Finalized ${id} ${pos.symbol} \-- phantom SL hit at peak ${pos.ghost.peakRRPos?.toFixed(2)}R`);
            pos.ghost.closedAt = null; // reset so ghost stays "active" in memory till EOD
          }
        }
        if (dbReady) db.saveGhostState(pos.ghost).catch(() => {});
      }
    }
  }
  // ── Blocked ghost trackers: update via live MT5 prices ──
  // Gebruik de liveIds priceMap \-- blocked ghosts volgen hetzelfde symbool
  const priceMap = new Map(live.map(p => [p.symbol, p.currentPrice]));
  const now = Date.now();
  for (const [id, bg] of blockedPositions) {
    const price = priceMap.get(bg.mt5Symbol) ?? priceMap.get(bg.symbol);
    if (price) updateGhost(bg, price);
    if (bg.phantomSLHit) {
      // v14.2: record slHitAt when first hit + backfill ALL adverse milestones
      if (!bg.slHitAt) {
        bg.slHitAt = new Date().toISOString();
        const elapsed = bg.openedAt
          ? Math.round((Date.now() - new Date(bg.openedAt).getTime()) / 60000) : 1;
        // Backfill -0.1R through -1.0R (same logic as live ghost)
        for (const step of [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1]) {
          const key = '-' + step.toFixed(1);
          if (!bg.rrMilestones[key]) {
            const msFromOpen = Math.round(elapsed * step * 60000);
            bg.rrMilestones[key] = new Date(new Date(bg.openedAt).getTime() + msFromOpen).toISOString();
          }
        }
      }
      // Keep shadow till end of Brussels day \-- remove after Brussels midnight
      const now = new Date();
      const bru  = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));
      const slHitDate = new Date(new Date(bg.slHitAt).toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));
      const sameBruDay =
        slHitDate.getFullYear() === bru.getFullYear() &&
        slHitDate.getMonth()    === bru.getMonth() &&
        slHitDate.getDate()     === bru.getDate();
      if (!sameBruDay) {
        // Past Brussels midnight since SL hit \-- save to DB first, then remove
        if (dbReady) await db.saveBlockedGhostTrade(bg).catch(()=>{});
        await closeBlockedGhost(id, bg.stopReason ?? 'phantom_sl');
      } else if (dbReady) {
        db.saveBlockedGhostState(bg).catch(() => {});
      }
    } else if (dbReady) {
      db.saveBlockedGhostState(bg).catch(() => {});
    }
  }
}

// ── Shadow snapshots (cron) ───────────────────────────────────────
async function runShadowSnapshots() {
  if (!isShadowActive() || !dbReady || openPositions.size === 0) return;
  const live     = await getPositions();
  const priceMap = new Map(live.map(p => [String(p.id), p.currentPrice]));
  for (const [id, pos] of openPositions) {
    const price   = priceMap.get(id);
    if (!price) continue;
    // v14.0: skip if direction missing \-- would cause NOT NULL constraint error
    if (!pos.direction || !pos.symbol || !pos.session) continue;
    const slDist  = Math.abs(pos.entry - pos.sl);
    if (slDist <= 0) continue;
    const adv     = pos.direction === 'buy' ? pos.entry - price : price - pos.entry;
    const pctUsed = Math.max(0, parseFloat(((adv / slDist) * 100).toFixed(2)));
    db.saveShadowSnapshot({ positionId: id, optimizerKey: pos.optimizerKey,
      symbol: pos.symbol, session: pos.session, direction: pos.direction,
      vwapPosition: pos.vwapPosition ?? 'unknown',
      entry: pos.entry, sl: pos.sl,
      currentPrice: price, pctSlUsed: pctUsed }).catch(() => {});
  }
}

// ── TP Optimizer (cron) ───────────────────────────────────────────
async function runTPOptimizer() {
  if (!isMonitoringActive() || !dbReady) return;
  try {
    tpConfigs = await db.loadTPConfig();
    const grouped = await db.loadGhostGrouped();
    for (const g of grouped) {
      if ((g.n || 0) < 10) continue;
      const ev = await db.computeEVStats(g.optimizerKey).catch(() => null);
      if (!ev || ev.count < 10 || !ev.bestRR) continue;
      const km  = keyRiskMults[g.optimizerKey] ?? { streak: 0, evMult: 1.0, dayMult: 1.0 };
      // Conservative multiplier: requires 20+ ghosts, capped at 1.25\x (not 1.5\x)
      // Prevents over-betting on small sample sizes
      if (ev.count < 20) continue; // skip multiplier update with < 20 data points
      const mul = ev.bestEV > 0
        ? Math.min(1.25, 1 + ev.bestEV * 0.5)   // positive EV: max +25% increase
        : Math.max(0.6,  1 + ev.bestEV * 0.8);  // negative EV: max -40% decrease
      keyRiskMults[g.optimizerKey] = { streak: km.streak, evMult: parseFloat(mul.toFixed(4)), dayMult: km.dayMult ?? 1.0 };
      db.saveKeyRiskMult(g.optimizerKey, keyRiskMults[g.optimizerKey]).catch(() => {});
      const existing = tpConfigs[g.optimizerKey];
      // Relock if: never locked, doubled since last lock, OR best RR changed by 0.5R+
      const rrChanged = existing?.lockedRR != null && Math.abs(ev.bestRR - existing.lockedRR) >= 0.5;
      const doubledData = g.n >= (existing?.lockedGhosts ?? 0) * 2;
      if (!existing || doubledData || rrChanged) {
        await db.saveTPConfig(g.optimizerKey, g.symbol, g.session, g.direction,
          g.vwapPosition, ev.bestRR, g.n, ev.bestEV, existing?.lockedRR ?? null).catch(() => {});
        tpConfigs[g.optimizerKey] = { ...existing, lockedRR: ev.bestRR, lockedGhosts: g.n };
        if (rrChanged) console.log(`[TP] ${g.optimizerKey}: TP updated ${existing?.lockedRR}R -> ${ev.bestRR}R (${g.n} ghosts, EV=${ev.bestEV?.toFixed(3)})`);
      }
    }
  } catch (e) { recordError(`TPOptimizer: ${e.message}`); }
}

// ══════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════

// ── Dashboard ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dashboardHTML());
});

// /dashboard -> alias for root (fixes broken /dashboard link)
app.get("/dashboard", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(dashboardHTML());
});

// ── Health ────────────────────────────────────────────────────────
// Debug: show raw MetaAPI data + in-memory positions
app.get("/api/debug/positions", async (req, res) => {
  try {
    const raw = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/positions`);
    const mem = [];
    for (const [id, pos] of openPositions) {
      mem.push({
        id, symbol: pos.symbol, direction: pos.direction,
        lots: pos.lots, entry: pos.entry, sl: pos.sl, tp: pos.tp,
        liveProfitMT5: pos.liveProfitMT5, currentPrice: pos.currentPrice,
        riskPct: pos.riskPct, riskEUR: pos.riskEUR,
        ghostMaxRR: pos.ghost?.maxRR, ghostPeakPos: pos.ghost?.peakRRPos,
        rrMilestonesCount: pos.ghost ? Object.keys(pos.ghost.rrMilestones||{}).length : 0,
      });
    }
    // Show first raw position's exact field names
    const firstRaw = Array.isArray(raw) ? raw[0] : null;
    res.json({
      rawCount: Array.isArray(raw) ? raw.length : 0,
      memCount: mem.length,
      firstRawFieldNames: firstRaw ? Object.keys(firstRaw) : [],
      firstRaw: firstRaw,
      memPositions: mem,
      latestEquity,
    });
  } catch(e) { res.json({ error: e.message, stack: e.stack?.slice(0,300) }); }
});

// Force immediate sync
app.post("/api/debug/force-sync", async (req, res) => {
  try {
    await _doSyncPositions();
    const mem = [];
    for (const [id, pos] of openPositions) {
      mem.push({ id, symbol: pos.symbol, lots: pos.lots,
        profit: pos.liveProfitMT5, price: pos.currentPrice,
        ghostRR: pos.ghost?.maxRR, milestones: Object.keys(pos.ghost?.rrMilestones||{}).length });
    }
    res.json({ ok: true, positions: mem, count: openPositions.size });
  } catch(e) { res.json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// DB ANALYSIS \-- analyse comment formats + backfill missing data
// ═══════════════════════════════════════════════════════════════

// Analyse comment formats in closed_trades
app.get("/api/debug/db-analysis", async (req, res) => {
  if (!dbReady) return res.json({ error: 'DB not ready' });
  try {
    const [comments, ghostState, ghostTrades, closedCount] = await Promise.all([
      db.pool.query(`
        SELECT 
          COALESCE(comment, brokerComment, mt5_comment, '') AS comment,
          direction, session, vwap_position, symbol,
          COUNT(*) as cnt
        FROM closed_trades
        GROUP BY COALESCE(comment, brokerComment, mt5_comment, ''), direction, session, vwap_position, symbol
        ORDER BY cnt DESC
        LIMIT 100
      `),
      db.pool.query(`SELECT COUNT(*) as cnt, 
        COUNT(CASE WHEN direction IS NULL THEN 1 END) as no_dir,
        COUNT(CASE WHEN session IS NULL THEN 1 END) as no_sess,
        COUNT(CASE WHEN optimizer_key IS NULL THEN 1 END) as no_key
        FROM ghost_state`),
      db.pool.query(`SELECT COUNT(*) as cnt,
        COUNT(CASE WHEN stop_reason IS NULL AND phantom_sl_hit IS FALSE THEN 1 END) as no_close,
        COUNT(CASE WHEN peak_rr_pos > 0 THEN 1 END) as has_peak
        FROM ghost_trades`),
      db.pool.query(`SELECT COUNT(*) as cnt,
        COUNT(CASE WHEN direction IS NULL THEN 1 END) as no_dir,
        COUNT(CASE WHEN session IS NULL THEN 1 END) as no_sess
        FROM closed_trades`),
    ]);
    res.json({
      closedTrades: closedCount.rows[0],
      commentFormats: comments.rows,
      ghostState: ghostState.rows[0],
      ghostTrades: ghostTrades.rows[0],
    });
  } catch(e) { res.json({ error: e.message }); }
});

// Backfill closed_trades direction/session/vwap from comment field
app.post("/api/debug/backfill-comments", async (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!dbReady) return res.json({ error: 'DB not ready' });
  try {
    // Get all closed_trades with a comment but missing direction/session
    const r = await db.pool.query(`
      SELECT position_id, 
        COALESCE(comment, broker_comment, '') AS comment,
        symbol, direction, session, vwap_position
      FROM closed_trades
      WHERE (direction IS NULL OR session IS NULL OR vwap_position IS NULL OR vwap_position = 'unknown')
        AND COALESCE(comment, broker_comment, '') != ''
    `);
    
    let fixed = 0, skipped = 0;
    for (const row of r.rows) {
      const parsed = parseMT5Comment(row.comment);
      if (!parsed.direction && !parsed.session) { skipped++; continue; }
      
      const dir  = parsed.direction  ?? row.direction;
      const sess = parsed.session    ?? row.session;
      const vwap = parsed.vwapPosition !== 'unknown' ? parsed.vwapPosition : (row.vwap_position ?? 'unknown');
      
      // Build optimizer key if we have enough info
      const sym    = normalizeSymbol(row.symbol) ?? row.symbol;
      const symInf = getSymbolInfo ? getSymbolInfo(sym) : null;
      const optKey = dir && sess && vwap ? buildOptimizerKey(sym, sess, dir, vwap) : null;
      
      await db.pool.query(`
        UPDATE closed_trades SET
          direction     = COALESCE(direction, $1),
          session       = COALESCE(session, $2),
          vwap_position = CASE WHEN vwap_position IS NULL OR vwap_position='unknown' THEN $3 ELSE vwap_position END,
          optimizer_key = COALESCE(optimizer_key, $4)
        WHERE position_id = $5
      `, [dir, sess, vwap, optKey, row.position_id]);
      fixed++;
    }
    
    // Also backfill ghost_state
    const gs = await db.pool.query(`
      SELECT position_id, symbol, direction, session, vwap_position, optimizer_key
      FROM ghost_state
      WHERE direction IS NULL OR session IS NULL OR optimizer_key IS NULL
    `);
    let gsFixed = 0;
    for (const row of gs.rows) {
      const sym  = normalizeSymbol(row.symbol) ?? row.symbol;
      if (row.direction && row.session && !row.optimizer_key) {
        const vwap   = row.vwap_position ?? 'unknown';
        const optKey = buildOptimizerKey(sym, row.session, row.direction, vwap);
        await db.pool.query(`UPDATE ghost_state SET optimizer_key=$1 WHERE position_id=$2`,
          [optKey, row.position_id]);
        gsFixed++;
      }
    }
    
    res.json({ ok: true, closedFixed: fixed, closedSkipped: skipped, ghostStateFixed: gsFixed });
  } catch(e) { res.json({ error: e.message, stack: e.stack?.slice(0,500) }); }
});

// Backfill ghost_trades from closed_trades (link via position_id)
app.post("/api/debug/backfill-ghost-trades", async (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!dbReady) return res.json({ error: 'DB not ready' });
  try {
    // Find closed_trades that have no matching ghost_trade yet
    const r = await db.pool.query(`
      SELECT ct.position_id, ct.symbol, ct.direction, ct.session, ct.vwap_position,
        ct.entry, ct.sl, ct.sl_pct, ct.lots, ct.realized_pnl_eur,
        ct.opened_at, ct.closed_at, ct.close_reason, ct.optimizer_key,
        ct.true_max_rr, ct.max_rr
      FROM closed_trades ct
      LEFT JOIN ghost_trades gt ON gt.position_id = ct.position_id
      WHERE gt.position_id IS NULL
        AND ct.direction IS NOT NULL
        AND ct.session IS NOT NULL
        AND ct.sl IS NOT NULL
        AND ct.entry IS NOT NULL
      LIMIT 500
    `);
    
    let inserted = 0;
    for (const ct of r.rows) {
      const sym    = normalizeSymbol(ct.symbol) ?? ct.symbol;
      const vwap   = ct.vwap_position ?? 'unknown';
      const optKey = ct.optimizer_key ?? buildOptimizerKey(sym, ct.session, ct.direction, vwap);
      const peakRR = ct.true_max_rr ?? ct.max_rr ?? 0;
      
      await db.pool.query(`
        INSERT INTO ghost_trades
          (position_id, optimizer_key, symbol, session, direction, vwap_position,
           entry, sl, realized_pnl_eur, lots, peak_rr_pos,
           stop_reason, opened_at, closed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (position_id) WHERE position_id IS NOT NULL DO NOTHING
      `, [
        ct.position_id, optKey, sym, ct.session, ct.direction, vwap,
        ct.entry, ct.sl, ct.realized_pnl_eur, ct.lots, peakRR,
        ct.close_reason, ct.opened_at, ct.closed_at
      ]);
      inserted++;
    }
    
    res.json({ ok: true, inserted, total: r.rows.length });
  } catch(e) { res.json({ error: e.message }); }
});

// Debug: recent errors
app.get("/api/debug/errors", (req, res) => {
  res.json({ count: errorLog.length, errors: errorLog.slice(-50) });
});

// Debug: specific position ghost state
app.get("/api/debug/ghost/:id", (req, res) => {
  const pos = openPositions.get(req.params.id);
  if (!pos) return res.json({ error: 'position not found', ids: [...openPositions.keys()] });
  res.json({
    position: { id: req.params.id, symbol: pos.symbol, direction: pos.direction,
      lots: pos.lots, entry: pos.entry, sl: pos.sl, tp: pos.tp,
      currentPrice: pos.currentPrice, liveProfitMT5: pos.liveProfitMT5 },
    ghost: pos.ghost ? {
      maxRR: pos.ghost.maxRR, peakRRPos: pos.ghost.peakRRPos, peakRRNeg: pos.ghost.peakRRNeg,
      phantomSLHit: pos.ghost.phantomSLHit, stopReason: pos.ghost.stopReason,
      rrMilestonesCount: Object.keys(pos.ghost.rrMilestones||{}).length,
      rrMilestones: pos.ghost.rrMilestones,
      slMilestones: pos.ghost.slMilestones,
      openedAt: pos.ghost.openedAt,
    } : null,
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true, version: VERSION, dbReady,
    openPositions: openPositions.size,
    blockedPositions: blockedPositions.size,
    latestEquity,
    metaCircuitOpen: _metaCircuitOpen,
    metaFailCount: _metaFailCount,
    uptime: Math.round(process.uptime()),
    memMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    ts: new Date().toISOString(),
  });
});

// ── Status (always fast) ──────────────────────────────────────────
app.get("/status", async (req, res) => {
  const base = {
    version:        VERSION,
    dbReady,
    openPositions:  openPositions.size,
    complianceDate: liveComplianceDate,
    errorCount:     getErrorCount(),
    ts:             new Date().toISOString(),
  };
  // Account info: use cached value (60s TTL) \-- never hammer MetaAPI on /status polls
  const acct = circuitOpen() ? _acctCache : await Promise.race([
    getAccountInfo(),
    new Promise(r => setTimeout(() => r(null), 8000)),
  ]);
  if (acct?.equity) {
    latestEquity = parseFloat(acct.equity);
    // Record equity curve every 5 min
    const nowMs = Date.now();
    if (dbReady && acct.balance && (!_lastEquityRecord || nowMs - _lastEquityRecord > 300_000)) {
      _lastEquityRecord = nowMs;
      db.pool.query('INSERT INTO equity_curve (balance,equity,open_pnl,open_pos) VALUES ($1,$2,$3,$4)',
        [acct.balance, acct.equity, (acct.equity-acct.balance), openPositions.size]).catch(()=>{});
    }
  }
  res.json({
    ...base,
    account: acct ? { balance: acct.balance, equity: acct.equity,
                      margin: acct.margin, currency: acct.currency } : null,
  });
});

// ── Compliance date ───────────────────────────────────────────────
app.get("/compliance-date", (req, res) => res.json({ complianceDate: liveComplianceDate }));

app.post("/compliance-date", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { date } = req.body ?? {};
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  const iso = date.length === 10 ? `${date} 00:00:00` : date;
  liveComplianceDate = iso;
  db.setComplianceDateLive(iso);
  if (dbReady) await db.saveComplianceDate(iso).catch(() => {});
  res.json({ ok: true, complianceDate: iso });
});

// ── Webhook ───────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const t0 = Date.now();
  if (!checkSecret(req, res)) return;
  if (!dbReady) return res.status(503).json({ error: "DB not ready yet, retry in a moment" });

  const { symbol: rawSym, direction: _dir, action: _action, sl_pct, vwap, vwap_upper, vwap_upper2,
          vwap_lower, vwap_lower2, close: tvClose,
          session_high: wh_session_high, session_low: wh_session_low,
          day_high: wh_day_high, day_low: wh_day_low,
          bull_breaks: wh_bull_breaks, bear_breaks: wh_bear_breaks,
          sl_points: wh_sl_points } = req.body ?? {};
  // Informatieve velden vanuit webhook \-- geen filters, alleen opslaan
  const sessionHigh  = wh_session_high  ? parseFloat(wh_session_high)  : null;
  const sessionLow   = wh_session_low   ? parseFloat(wh_session_low)   : null;
  const dayHigh      = wh_day_high      ? parseFloat(wh_day_high)      : null;
  const dayLow       = wh_day_low       ? parseFloat(wh_day_low)       : null;
  const bullBreaks   = wh_bull_breaks   ? parseInt(wh_bull_breaks)     : null;
  const bearBreaks   = wh_bear_breaks   ? parseInt(wh_bear_breaks)     : null;
  const slPoints     = wh_sl_points     ? parseFloat(wh_sl_points)     : null;
  // Pine Script sends "action":"buy"/"sell" \-- normalize to direction
  const direction = (_dir ?? _action ?? '').toLowerCase().trim() || null;
  if (!direction || (direction !== 'buy' && direction !== 'sell')) {
    recordError(`Webhook missing valid direction/action. body=${JSON.stringify(req.body).slice(0,200)}`);
    return res.status(400).json({ error: `Missing or invalid direction/action field. Got: "${direction}"` });
  }

  const symbol = normalizeSymbol(rawSym);
  if (!symbol) return res.status(400).json({ error: `Unknown symbol: ${rawSym}` });

  const symInfo   = getSymbolInfo(symbol);
  const mt5Sym    = symInfo?.mt5 ?? symbol;
  const assetType = symInfo?.type ?? "forex";

  const { allowed, reason: mktReason } = canOpenNewTrade(symbol);
  if (!allowed) {
    const sesForLog = getSession();
    const _sigOutcome = mktReason?.includes('NY_NIGHT') ? 'NY_NIGHT' :
      mktReason?.includes('ASIA_MORNING') ? 'ASIA_MORNING' :
      mktReason?.includes('NY_DEAD_ZONE') ? 'NY_DEAD_ZONE' :
      mktReason?.includes('STOCK_OUTSIDE_MARKET') ? 'STOCK_OOH' :
      mktReason?.includes('WEEKEND') ? 'WEEKEND' :
      mktReason?.includes('UNKNOWN_SYMBOL_TYPE') ? 'UNKNOWN_SYMBOL' :
      mktReason?.includes('MAX_POSITIONS') ? 'MAX_POSITIONS' : 'REJECTED';
    const _tvEntryLog = parseFloat(req.body?.entry ?? req.body?.close ?? 0) || null;
    const _vwapLog    = req.body?.vwap ? parseFloat(req.body.vwap) : null;
    const _slPctLog   = parseFloat(req.body?.sl_pct ?? 0.003);
    const _vwapPosLog = (_tvEntryLog && _vwapLog) ? getVwapPosition(_tvEntryLog, _vwapLog) : null;
    // Compute vwapBandPct for signal log
    let _bandLog = null;
    if (_tvEntryLog && _vwapLog && req.body?.vwap_upper) {
      const _hb = Math.abs(parseFloat(req.body.vwap_upper) - _vwapLog);
      if (_hb > 0) _bandLog = parseFloat((Math.abs(_tvEntryLog - _vwapLog) / _hb * 100).toFixed(2));
    }
    db.logSignal({ symbol, direction, outcome: _sigOutcome, rejectReason: mktReason,
      session: sesForLog, vwapPosition: _vwapPosLog,
      tvEntry: _tvEntryLog, slPct: _slPctLog, vwapBandPct: _bandLog,
      assetType: symInfo?.type ?? null,
      sessionHigh: sessionHigh, sessionLow: sessionLow,
      dayHigh: dayHigh, dayLow: dayLow, bullBreaks: bullBreaks,
      latencyMs: Date.now() - t0 }).catch(() => {});

    // ── Shadow Playbook: ALL tradeable-but-blocked signals get a ghost tracker ──
    // NY_DEAD_ZONE: outside 15:30-18:00 Brussels (forex/stocks blocked at NYSE open)
    // OUTSIDE_WINDOW: outside 21:00-02:00 Brussels (market closed overnight)
    // STOCK_OUTSIDE_MARKET: stocks outside 16:00-21:00 Brussels
    // These are trades that WOULD have been valid setups \-- we track them for EV analysis
    // Shadow tracker: ONLY block reasons where market IS open but we chose not to trade
    // STOCK_OUTSIDE_MARKET = market closed -> NOT tracked in shadow
    // WEEKEND = market closed -> NOT tracked in shadow
    const isTrackableBlock = mktReason && (
      mktReason.includes('NY_DEAD_ZONE') ||
      mktReason.includes('NY_NIGHT') ||
      mktReason.includes('ASIA_MORNING') ||
      mktReason.includes('OUTSIDE_WINDOW')        // legacy compat only
    );

    if (dbReady && isTrackableBlock) {
      const tvEntryB = parseFloat(req.body?.entry ?? req.body?.close ?? 0) || null;
      const slPctB   = parseFloat(req.body?.sl_pct ?? 0.003);
      if (tvEntryB && slPctB && direction) {
        // v14.2: session is always ny for 21:00-02:00 (no 4th session)
        const sesB = 'ny'; // getSession now returns 'ny' for all non-asia/london times
        const vwapB    = req.body?.vwap ? parseFloat(req.body.vwap) : null;
        const vwapPosB = getVwapPosition(tvEntryB, vwapB);
        const optKeyB  = buildOptimizerKey(symbol, sesB, direction, vwapPosB);
        const slBuf    = symInfo?.type === 'stock' ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;
        const slDistB  = slPctB * slBuf * tvEntryB;
        const slPriceB = direction === 'buy' ? tvEntryB - slDistB : tvEntryB + slDistB;

        // Determine block type from sub-session reason (stap 1 fix)
        // NY_DEAD_ZONE, NY_NIGHT, ASIA_MORNING all route to shadow timezone tab
        let blockType = 'NY_DEAD_ZONE'; // default
        if (mktReason.includes('NY_NIGHT'))            blockType = 'NY_NIGHT';
        else if (mktReason.includes('ASIA_MORNING'))   blockType = 'ASIA_MORNING';
        else if (mktReason.includes('NY_DEAD_ZONE'))   blockType = 'NY_DEAD_ZONE';
        else if (mktReason.includes('OUTSIDE_WINDOW')) blockType = 'NY_DEAD_ZONE';
        else if (mktReason.includes('STOCK_OUTSIDE_MARKET')) blockType = 'NY_DEAD_ZONE';

        // blockTypes array for multi-block support
        const blockTypes = [blockType];

        // keyCount: how many same pair+dir+vwap trades already open today (as blocked ghost)
        const todayBruStart = (() => {
          const now = new Date();
          const bru = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));
          bru.setHours(0, 0, 0, 0);
          return new Date(now.getTime() - (bru.getTime() - now.getTime()) + bru.getTime() - now.getTime());
        })();
        const sameKeyToday = [...blockedPositions.values()]
          .filter(b => b.optimizerKey === optKeyB).length +
          [...openPositions.values()]
          .filter(p => (p.ghost?.optimizerKey ?? p.optimizerKey) === optKeyB).length;
        const keyCount = sameKeyToday + 1;

        // Get sub_session for shadow tracker routing (stap 1)
        const subSessB = getSubSession ? getSubSession() : 'NY_DEAD_ZONE';
        const bg = initBlockedGhost({
          blockType, blockTypes, symbol, mt5Symbol: mt5Sym,
          session: sesB, direction, vwapPosition: vwapPosB,
          entry: tvEntryB, sl: slPriceB, slPct: slPctB,
          tpRRUsed: tpConfigs[optKeyB]?.lockedRR ?? 1.5,
          optimizerKey: optKeyB, blockReason: mktReason,
          keyCount, subSession: subSessB,
          type: symInfo?.type ?? 'unknown',
        });
        blockedPositions.set(bg.id, bg);
        db.saveBlockedGhostState(bg).catch(() => {});
        console.log(`[BlockedGhost] ${blockType} tracker created: ${bg.id} ${symbol} ${direction} entry=${tvEntryB}`);
      }
    }
    return res.json({ ok: false, reason: mktReason });
  }

  // Pine Script sends both "entry" and "close" \-- accept either
  const tvEntry  = tvClose ? parseFloat(tvClose) : (req.body?.entry ? parseFloat(req.body.entry) : null);
  const vwapMid  = vwap    ? parseFloat(vwap)    : null;
  const session  = getSession();
  const vwapPos  = getVwapPosition(tvEntry, vwapMid);
  const optKey   = buildOptimizerKey(symbol, session, direction, vwapPos);
  const slPct    = sl_pct ? parseFloat(sl_pct) : 0.003;

  // ── FIX 1a: VWAP band% block \-- blokkeer signalen ≥150% van de VWAP band ──
  // bandPct = afstand van prijs tot VWAP mid, uitgedrukt als % van de halve band breedte.
  // 100% = prijs zit op de eerste band (vwap_upper / vwap_lower).
  // 150% = prijs zit 1.5\x de halve band buiten de VWAP mid -> te ver uitgerokken.
  // Geldt voor ALLE asset types: forex, stock, index, commodity.
  let vwapBandPct = null;
  if (tvEntry !== null && vwapMid !== null && vwap_upper) {
    const halfBand = Math.abs(parseFloat(vwap_upper) - vwapMid);
    if (halfBand > 0) {
      const dist  = Math.abs(tvEntry - vwapMid);
      vwapBandPct = parseFloat(((dist / halfBand) * 100).toFixed(2));
    }
  }
  // VWAP exhaustion threshold \-- configurable per asset type
  // Stocks: wider bands (higher volatility) -> higher threshold
  // Forex/Index: tighter bands -> lower threshold  
  const vwapThreshold = assetType === 'stock' ? 250 : assetType === 'index' ? 130 : 150; // stocks: open+ghost allowed up to 250%, above->shadow
  if (vwapBandPct !== null && vwapBandPct >= vwapThreshold) {
    const rejectReason = `VWAP_EXHAUSTION: band_pct=${vwapBandPct.toFixed(1)}% (max ${vwapThreshold}% for ${assetType})`;
    db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
      tvEntry, slPct, vwapBandPct, outcome: "REJECTED", rejectReason,
      latencyMs: Date.now() - t0 }).catch(() => {});
    // ── v13.4: VWAP_EXHAUSTION -> maak invisible blocked ghost tracker ──
    if (dbReady && tvEntry && slPct) {
      const slBufVE  = assetType === 'stock' ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;
      const slDistVE = slPct * slBufVE * tvEntry;
      const slPriceVE = direction === 'buy' ? tvEntry - slDistVE : tvEntry + slDistVE;
      const bg = initBlockedGhost({
        blockType: 'VWAP_EXHAUSTION',
        blockTypes: ['VWAP_EXHAUSTION'],
        symbol, mt5Symbol: mt5Sym,
        session, direction, vwapPosition: vwapPos,
        entry: tvEntry, sl: slPriceVE, slPct,
        tpRRUsed: tpConfigs[optKey]?.lockedRR ?? 1.5,
        optimizerKey: optKey, vwapBandPct, blockReason: rejectReason,
        keyCount: [...openPositions.values()].filter(p=>(p.ghost?.optimizerKey??p.optimizerKey)===optKey).length +
                  [...blockedPositions.values()].filter(b=>b.optimizerKey===optKey).length + 1,
      });
      blockedPositions.set(bg.id, bg);
      db.saveBlockedGhostState(bg).catch(() => {});
      console.log(`[BlockedGhost] VWAP_EXHAUSTION tracker created: ${bg.id} ${symbol} band=${vwapBandPct}%`);
    }
    return res.json({ ok: false, reason: rejectReason, vwapBandPct });
  }

  // ── v14.2: MAX POSITIONS SAFETY LIMIT ─────────────────────────
  const MAX_OPEN_POSITIONS = 50;
  if (openPositions.size >= MAX_OPEN_POSITIONS) {
    const rejectReason = `MAX_POSITIONS: ${openPositions.size} positions open (limit ${MAX_OPEN_POSITIONS})`;
    db.logSignal({ symbol, direction, session, outcome: 'REJECTED', rejectReason, latencyMs: Date.now() - t0 }).catch(() => {});
    return res.json({ ok: false, reason: rejectReason });
  }

  // ── FIX 1b: Duplicate check \-- max 1 open positie per optimizerKey ──
  for (const [, existingPos] of openPositions) {
    if (existingPos.optimizerKey === optKey) {
      const rejectReason = `DUPLICATE_POSITION: ${optKey} already open (positionId=${existingPos.positionId})`;
      db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
        tvEntry, slPct, vwapBandPct, outcome: "REJECTED", rejectReason,
        latencyMs: Date.now() - t0 }).catch(() => {});
      // ── v13.4: DUPLICATE -> maak invisible blocked ghost tracker ──
      if (dbReady && tvEntry && slPct) {
        const slBufD  = assetType === 'stock' ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;
        const slDistD = slPct * slBufD * tvEntry;
        const slPriceD = direction === 'buy' ? tvEntry - slDistD : tvEntry + slDistD;
        // STAP 10 FIX: keyCount = existing ghosts + 1 (don't count the current new one)
        // openPositions: existing trades for this key (already placed)
        // blockedPositions: already blocked for this key (not the current one being blocked)
        const keyCountDup =
          [...openPositions.values()].filter(p=>(p.ghost?.optimizerKey??p.optimizerKey)===optKey).length +
          [...blockedPositions.values()].filter(b=>b.optimizerKey===optKey).length + 1;
        // blockTypes: check if ALSO VWAP exhaustion (can be both)
        const blockTypesDup = ['DUPLICATE_POSITION'];
        if (vwapBandPct !== null && vwapBandPct >= 150) blockTypesDup.push('VWAP_EXHAUSTION');
        const bg = initBlockedGhost({
          blockType: 'DUPLICATE_POSITION',
          blockTypes: blockTypesDup,
          symbol, mt5Symbol: mt5Sym,
          session, direction, vwapPosition: vwapPos,
          entry: tvEntry, sl: slPriceD, slPct,
          tpRRUsed: tpConfigs[optKey]?.lockedRR ?? 1.5,
          optimizerKey: optKey, blockReason: rejectReason,
          vwapBandPct,
          keyCount: keyCountDup,
          duplicateCount: keyCountDup,
        });
        blockedPositions.set(bg.id, bg);
        db.saveBlockedGhostState(bg).catch(() => {});
        console.log(`[BlockedGhost] DUPLICATE #${keyCountDup} tracker created: ${bg.id} ${symbol} ${direction}`);
      }
      return res.json({ ok: false, reason: rejectReason });
    }
  }

  // Use cached equity \-- if circuit is open or cache fresh, avoid extra MetaAPI call
  let equity = latestEquity || 10000;
  if (!circuitOpen()) {
    const acct = await Promise.race([getAccountInfo(), new Promise(r => setTimeout(() => r(null), 5000))]);
    if (acct?.equity) { equity = parseFloat(acct.equity); latestEquity = equity; }
  }

  const baseRisk = symbolRiskMap[symbol] ?? DEFAULT_RISK_BY_TYPE[assetType] ?? DEFAULT_RISK_BY_TYPE.forex;
  const km       = keyRiskMults[optKey] ?? { evMult: 1.0, dayMult: 1.0 };
  const riskPct  = baseRisk * (km.evMult ?? 1) * (km.dayMult ?? 1);
  const riskEUR  = parseFloat((equity * riskPct).toFixed(2));

  // Live quote
  let execPrice = tvEntry, spreadAtEntry = null, bid = null, ask = null;
  try {
    const q = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/symbols/${mt5Sym}/current-price`);
    bid = q?.bid ? parseFloat(q.bid) : null;
    ask = q?.ask ? parseFloat(q.ask) : null;
    if (bid && ask) { spreadAtEntry = parseFloat((ask - bid).toFixed(6)); execPrice = direction === "buy" ? ask : bid; }
  } catch {}

  const slippage    = tvEntry && execPrice ? parseFloat(Math.abs(execPrice - tvEntry).toFixed(6)) : null;
  const slBuf       = assetType === "stock" ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;

  // SL PLACEMENT LOGIC:
  // Step 1: TV sends sl_pct = raw % distance from TV entry (e.g. 0.003 = 0.3%)
  // Step 2: We apply SL_BUFFER_MULT to give extra room (1.5\x forex, 3.0\x stock)
  // Step 3: We apply the buffered % to MT5 EXECUTION price (not TV entry)
  //         This ensures the SL is always correctly placed relative to where we filled
  // Verification:
  //   slDistTV  = sl_pct \x slBuf \x tvEntry   (what TV would place)
  //   slDistMT5 = sl_pct \x slBuf \x execPrice (what we actually place \-- CORRECT)
  //   Difference = slippage \x slBuf (small, expected)
  const slDistTV    = tvEntry ? parseFloat((slPct * slBuf * tvEntry).toFixed(6)) : null;
  const slDist      = parseFloat((slPct * slBuf * execPrice).toFixed(6));
  // slPctFinal: cap at 50% to prevent absurd values for indices (US30 at 50000 has tiny %)  
  const slPctFinal  = parseFloat(Math.min(50, (slDist / execPrice * 100)).toFixed(4)); // actual % on MT5

  console.log(`[SL-CALC] ${symbol} ${direction.toUpperCase()}`
    + ` | TV entry=${tvEntry} sl_pct=${(slPct*100).toFixed(3)}% buf=${slBuf}x`
    + ` | MT5 exec=${execPrice} slippage=${slippage}`
    + ` | slDist=${slDist.toFixed(6)} (${slPctFinal}% of execPrice)`
    + (slDistTV ? ` | TV slDist would have been=${slDistTV.toFixed(6)}` : ''));

  const slPrice     = direction === "buy"
    ? parseFloat((execPrice - slDist).toFixed(6))
    : parseFloat((execPrice + slDist).toFixed(6));
  const tpRR        = tpConfigs[optKey]?.lockedRR ?? 1.5;
  const tpPrice     = direction === "buy"
    ? parseFloat((execPrice + slDist * tpRR).toFixed(6))
    : parseFloat((execPrice - slDist * tpRR).toFixed(6));

  let lots;
  const lotNom = slDist > 0 ? riskEUR / slDist : 0.01;
  if (assetType === 'forex')     lots = Math.max(0.01, parseFloat((lotNom / 100000).toFixed(2)));
  else if (assetType === 'index') lots = Math.max(0.01, parseFloat(lotNom.toFixed(2)));
  else if (assetType === 'stock') {
    // Stocks (FTMO CFD): 1 lot = 1 share
    // P&L = lots \x price_move (dollar \~ euro on FTMO)
    // Example: JNJ entry=221.25 SL=222.59 slDist=1.34 riskEUR=38
    //   -> lots = 38 / 1.34 = 28 aandelen \OK
    // No multiplier \-- 1 share moves dollar-for-dollar
    const rawLots = slDist > 0 ? riskEUR / slDist : 1;
    lots = Math.max(1, Math.round(rawLots)); // whole shares only (FTMO)
  }
  else lots = Math.max(0.01, parseFloat((lotNom / 100).toFixed(2)));

  let tradeNumber = null;
  if (dbReady) tradeNumber = await db.getNextTradeNumber().catch(() => null);

  // Place order
  let positionId;
  // v14.0: MT5 comment \-- readable format shown in MetaTrader position list
  // Format: "SYMBOL D-SESS-VWAP #N"  e.g. "GBPUSD S-NY-BLW #42"
  const orderComment = (()=>{
    const d = direction === 'buy' ? 'B' : 'S';
    // getSession() returns 'ny'|'london'|'asia'|'outside' \-- NOT 'new_york'
    const sessMap = { ny: 'NY', london: 'LD', asia: 'AS', outside: 'NY' }; // outside->ny
    const s = sessMap[session] ?? (session||'??').slice(0,2).toUpperCase();
    const v = vwapPos === 'above' ? 'ABV' : vwapPos === 'below' ? 'BLW' : 'UNK';
    const n = tradeNumber ?? '?';
    // Keep under 31 chars (MT5 comment limit)
    const sym = (symbol||mt5Sym||'').slice(0,7);
    return `${sym} ${d}-${s}-${v} #${n}`;
  })();
  try {
    const r = await placeOrder({
      symbol: mt5Sym,
      actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      volume: lots, stopLoss: slPrice, takeProfit: tpPrice,
      comment: orderComment,
    });
    positionId = r?.positionId ?? r?.orderId ?? null;

    // ── v13.5.1: ORDER_NOT_CONFIRMED \-- poll MT5 voor positionId ──
    // Stocks (GOOG, AAPL, JNJ etc.) geven soms geen positionId terug
    // bij market open. Poll tot 10s om de nieuwe positie te vinden.
    if (!positionId) {
      console.warn(`[Order] Geen positionId ontvangen voor ${mt5Sym} ${direction} \-- polling MT5...`);
      const placeTime = Date.now();
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
          const livePosNow = await getPositions();
          // Zoek een positie die matcht: zelfde symbol + direction + recent geopend
          const match = livePosNow.find(lp => {
            const lpDir = lp.type === 'POSITION_TYPE_BUY' || lp.type === 'buy' ? 'buy' : 'sell';
            const openMs = (lp.time ?? lp.openTime) ? new Date(lp.time ?? lp.openTime).getTime() : 0;
            return lp.symbol === mt5Sym && lpDir === direction
              && openMs >= placeTime - 30000
              && !openPositions.has(String(lp.id));
          });
          if (match) { positionId = String(match.id); console.log(`[Order] Gevonden via poll: ${positionId}`); break; }
        } catch {}
      }
      if (!positionId) {
        // ORDER_NOT_CONFIRMED: positie niet gevonden \-- log en geef error terug.
        // Maak GEEN fallback ghost met Date.now() ID \-- dit leidt tot orphan ghosts.
        const _errMsg = `geen positionId van MetaApi en positie niet gevonden op MT5 (${symbol} ${direction})`;
        console.error(`[Order] ORDER_NOT_CONFIRMED: geen positie gevonden voor ${mt5Sym} ${direction}`);
        db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
          tvEntry, slPct, outcome: "ORDER_NOT_CONFIRMED",
          rejectReason: _errMsg, latencyMs: Date.now() - t0 }).catch(() => {});
        return res.status(202).json({ ok: false, reason: "ORDER_NOT_CONFIRMED", message: _errMsg });
      }
    }
  } catch (e) {
    recordError(`placeOrder: ${e.message}`);
    db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
      tvEntry, slPct, outcome: "ERROR", rejectReason: e.message, latencyMs: Date.now() - t0 }).catch(() => {});
    return res.status(500).json({ error: e.message });
  }

  const pos = { positionId, symbol, mt5Symbol: mt5Sym, direction,
    vwapPosition: vwapPos, session, entry: execPrice, sl: slPrice, tp: tpPrice, lots,
    riskPct, riskEUR, openedAt: new Date().toISOString(), optimizerKey: optKey,
    tpRRUsed: tpRR, slMultiplier: slBuf, vwapAtEntry: vwapMid, tvEntry, executionPrice: execPrice,
    slippage, spreadAtEntry, vwapBandPct, tradeNumber,
    slDistTV, slDist, slPctFinal, assetType,  // SL verification fields
    // Informatieve velden vanuit webhook (geen filters \-- enkel opslaan voor analyse)
    sessionHigh, sessionLow, dayHigh, dayLow, bullBreaks, bearBreaks, slPoints,
    mt5Comment: orderComment,  // "EURUSD S-NY-BLW #5" \-- saved for display
    orderComment: orderComment,
    ghost: null };
  pos.ghost = initGhost({ ...pos, slPct, evMult: km.evMult, dayMult: km.dayMult });
  openPositions.set(positionId, pos);

  if (dbReady) {
    db.saveGhostState(pos.ghost).catch(() => {});
    db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
      tvEntry, slPct, vwapBandPct, outcome: "PLACED", latencyMs: Date.now() - t0, positionId,
      sessionHigh, sessionLow, dayHigh, dayLow, bullBreaks, bearBreaks }).catch(() => {});
    db.logWebhook({ symbol, direction, session, vwapPos, action: "place", status: "OK",
      positionId, entry: execPrice, sl: slPrice, tp: tpPrice, lots, riskPct, optimizerKey: optKey,
      latencyMs: Date.now() - t0, tvEntry, executionPrice: execPrice, slippage, vwapBandPct,
      sessionHigh, sessionLow, dayHigh, dayLow, bullBreaks, bearBreaks, slPoints }).catch(() => {});
    if (bid && ask) db.saveSpreadLog({ symbol, mt5Symbol: mt5Sym, session,
      hourBrussels: getBrusselsComponents().hour, minuteBrussels: getBrusselsComponents().minute,
      dayOfWeek: getBrusselsComponents().day,
      bid, ask, spreadAbs: spreadAtEntry,
      spreadPct: spreadAtEntry && execPrice > 0 ? parseFloat((spreadAtEntry / execPrice * 100).toFixed(4)) : null,
      assetType, positionId }).catch(() => {});
  }

  res.json({ ok: true, positionId, symbol, direction, lots,
    entry: execPrice, sl: slPrice, tp: tpPrice, riskEUR, tpRR, tradeNumber,
    latencyMs: Date.now() - t0 });
});

// ── Manual close ──────────────────────────────────────────────────
app.post("/close/:id", async (req, res) => {
  if (!checkSecret(req, res)) return;
  try {
    await closePositionMeta(req.params.id);
    await closePosition(req.params.id, "manual", null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── History deals ─────────────────────────────────────────────────
app.post("/history-deals", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { positionId } = req.body ?? {};
  if (!positionId) return res.status(400).json({ error: "positionId required" });
  try {
    const deals = await fetchHistoryDeals(positionId);
    for (const d of deals)
      await db.saveDeal({ positionId, dealId: d.id ?? d.dealId, symbol: d.symbol,
        type: d.type, profit: d.profit ?? 0, commission: d.commission ?? 0,
        swap: d.swap ?? 0, volume: d.volume, price: d.price, time: d.time });
    const pnl = await db.fetchRealizedPnl(positionId);
    res.json({ ok: true, deals: deals.length, realizedPnl: pnl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API endpoints (all safe \-- return empty on error/not ready) ───

function apiGet(path, fn, empty = []) {
  app.get(path, async (req, res) => {
    if (!dbReady) return res.json(empty);
    try { res.json(await dbCall(fn(req), empty)); }
    catch (e) { recordError(`${path}: ${e.message}`); res.json(empty); }
  });
}

apiGet("/api/trades",              r  => db.loadAllTrades({ since: r.query.since??null, until: r.query.until??null, openFrom: r.query.openFrom??null, openTo: r.query.openTo??null }), []);
apiGet("/api/ghost-trades",        r  => db.loadGhostTrades(r.query.key??null, parseInt(r.query.limit)||200), []);
apiGet("/api/ghost-grouped",       () => db.loadGhostGrouped(),                []);
app.get("/api/performance", async (req, res) => {
  if (!dbReady) return res.json(null);
  try {
    const stats = await db.loadPerformanceStats();
    // Add live balance/equity from MetaAPI cache + ACCOUNT_BALANCE env var
    const acctBalance = parseFloat(process.env.ACCOUNT_BALANCE || 0);
    const equity = latestEquity || acctBalance || 0;
    const realizedPnl = stats?.totalPnl ?? 0;
    // Unrealized = sum of all open position P&L
    // Calculate from components for consistency
    const unrealizedPnl = [...openPositions.values()]
      .reduce((s, p) => s + (p.unrealizedPnl ?? p.liveProfitMT5 ?? 0), 0);
    // cashBalance = startBalance + realized (what we've earned and closed)
    const cashBalance = parseFloat((acctBalance + realizedPnl).toFixed(2));
    // equity = cash + unrealized
    const equityCalc  = parseFloat((cashBalance + unrealizedPnl).toFixed(2));
    res.json({
      ...(stats ?? {}),
      balance:       cashBalance,
      equity:        equityCalc,
      realizedPnl:   realizedPnl,
      totalPnl:      realizedPnl,
      unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
      startBalance:  acctBalance,
      currency:      latestAccountCurrency,
      mt5Balance:    latestEquity, // raw MT5 value for reference
    });
  } catch (e) { res.json(null); }
});
// ── Manual position recovery ──────────────────────────────────────
// POST /api/recover-positions [secret]
// Scant MT5 live posities en adopteert alles wat niet in memory zit.
// Gebruik dit na een deploy als je ziet dat een positie ontbreekt.
app.post("/api/recover-positions", async (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!dbReady) return res.status(503).json({ error: "DB not ready" });
  try {
    const live = await Promise.race([
      getPositions(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 15s")), 15000)),
    ]);
    const results = [];
    for (const lp of live) {
      const id = String(lp.id);
      const alreadyTracked = openPositions.has(id);
      if (!alreadyTracked) {
        await adoptPosition(lp);
        results.push({ id, symbol: lp.symbol, status: "adopted" });
      } else {
        results.push({ id, symbol: lp.symbol, status: "already_tracked" });
      }
    }
    res.json({ ok: true, livePositions: live.length, results });
  } catch (e) {
    recordError(`recover-positions: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

apiGet("/api/ghost-history-by-pair", r => db.loadAllGhostsCombined(r.query.from??null, r.query.to??null), []);
// v13.4: blocked ghost tracker routes
app.get("/api/blocked-ghosts/active", (req, res) => {
  // Serve from in-memory blockedPositions map for live milestone data
  // Fall back to DB if memory is empty (after restart before sync)
  if(blockedPositions.size > 0) {
    return res.json([...blockedPositions.values()].map(bg => ({
      id: bg.id, blockType: bg.blockType, optimizerKey: bg.optimizerKey,
      symbol: bg.symbol, mt5Symbol: bg.mt5Symbol,
      session: bg.session || bg.subSession || 'ny',
      direction: bg.direction, vwapPosition: bg.vwapPosition,
      entry: bg.entry, sl: bg.sl, slPct: bg.slPct,
      maxRR: bg.maxRR, maxSlPctUsed: bg.maxSlPctUsed,
      peakRRPos: bg.peakRRPos ?? bg.maxRR ?? 0,
      peakRRNeg: bg.peakRRNeg ?? bg.maxSlPctUsed ?? 0,
      slMilestones: bg.slMilestones ?? {},
      rrMilestones: bg.rrMilestones ?? {},
      vwapBandPct: bg.vwapBandPct, blockReason: bg.blockReason,
      duplicateCount: bg.duplicateCount ?? null,
      keyCount: bg.keyCount ?? 1,
      assetType: bg.assetType ?? null,
      type: bg.assetType ?? null,
      openedAt: bg.openedAt, currentPrice: bg.currentPrice ?? null,
    })));
  }
  if(!dbReady) return res.json([]);
  db.loadActiveBlockedGhosts().then(r => res.json(r)).catch(() => res.json([]));
});
apiGet("/api/blocked-ghosts/history", r  => db.loadBlockedGhostHistory(
  r.query.blockType ?? 'NY_DEAD_ZONE', r.query.from ?? null, r.query.to ?? null), []);
apiGet("/api/ghost-combo-analysis",r  => db.loadGhostComboAnalysis(r.query.key??null), []);
apiGet("/api/session-stats",       () => db.loadSessionStats(),                               []);
apiGet("/api/milestone-probability",r => db.loadMilestoneProbability(r.query.key??null),      []);
apiGet("/api/shadow-whatif",       () => db.loadShadowWhatIfStats(),                          {summary:[],details:[]});
apiGet("/api/shadow-analysis",     () => db.loadAllShadowAnalysis(),           []);
apiGet("/api/shadow-winners",      () => db.loadShadowWinners(),               {});
apiGet("/api/mae-stats",           r  => db.loadMAEStats(r.query.since??null), []);
apiGet("/api/equity-curve",        () => db.loadEquityCurve(200),               []);
apiGet("/api/signal-stats",        r  => db.loadSignalStats({ since: r.query.since??null, until: r.query.until??null }), { total:0, placed:0, conversionPct:0 });
apiGet("/api/signal-rejects",      r  => db.loadSignalRejects({ since: r.query.since??null, until: r.query.until??null }), []);
apiGet("/api/signal-log",          r  => db.loadSignalLog({ since: r.query.since??null, until: r.query.until??null }), []);
apiGet("/api/blocked-raw",         r  => db.loadBlockedRaw(r.query.since??null, r.query.until??null), []);
apiGet("/api/webhook-history",     r  => db.loadWebhookHistory(parseInt(r.query.limit)||100, r.query.since??null, r.query.until??null), []);
apiGet("/api/spread-stats",        r  => db.loadSpreadStats(r.query),          []);
apiGet("/api/spread-log",          r  => db.loadSpreadLog({ symbol: r.query.symbol, session: r.query.session, limit: parseInt(r.query.limit)||500 }), []);
apiGet("/api/band-ghosts",         r  => db.loadBandGhosts(r.query),           []);
apiGet("/api/symbol-risk",         () => db.loadSymbolRiskConfig(),            {});

app.get("/api/open-positions", (req, res) => {
  // No secret required \-- served to the dashboard which runs on same origin
  // Data is position metadata only; full security would need session auth
  const out = [];
  for (const [id, pos] of openPositions) {
    // Use ghost.lots as fallback when pos.lots is null (weekend/adopted positions)
    const lotsOut = pos.lots ?? pos.ghost?.lots ?? null;
    out.push({
      positionId: id, symbol: pos.symbol, direction: pos.direction,
      session: pos.session, vwapPosition: pos.vwapPosition, optimizerKey: pos.optimizerKey,
      entry: pos.entry, sl: pos.sl, tp: pos.tp, lots: lotsOut,
      riskPct: pos.riskPct, riskEUR: pos.riskEUR, vwapBandPct: pos.vwapBandPct ?? null,
      sessionHigh: pos.sessionHigh ?? pos.session_high ?? null,
      sessionLow:  pos.sessionLow  ?? pos.session_low  ?? null,
      mt5Comment:  pos.orderComment ?? pos.mt5Comment ?? pos.comment ?? null,
      slDistTV: pos.slDistTV ?? null, slDist: pos.slDist ?? null, slPctFinal: pos.slPctFinal ?? null,
      slMultiplier: pos.slMultiplier ?? null, tvEntry: pos.tvEntry ?? null,
      openedAt: pos.openedAt,
      tradeNumber: pos.tradeNumber,
      currentPrice:  pos.currentPrice ?? null,
      liveProfitMT5: pos.liveProfitMT5 ?? null,
      unrealizedPnl: pos.liveProfitMT5 ?? null,
      profitUSD:     pos.profitUSD ?? null,
      exchangeRate:  pos.exchangeRate ?? 1.0,
      assetType:     pos.assetType ?? getSymbolInfo(pos.symbol)?.type ?? null,
      type:          pos.assetType ?? getSymbolInfo(pos.symbol)?.type ?? null,
      exitPrice:     pos.exitPrice ?? null,
      lots:          pos.lots ?? null,
      ghost: pos.ghost ? {
        maxRR:        pos.ghost.maxRR        ?? 0,
        maxSlPctUsed: pos.ghost.maxSlPctUsed ?? 0,
        peakRRPos:    pos.ghost.peakRRPos    ?? pos.ghost.maxRR ?? 0,
        peakRRNeg:    pos.ghost.peakRRNeg    ?? pos.ghost.maxSlPctUsed ?? 0,
        slMilestones: pos.ghost.slMilestones ?? {},
        rrMilestones: pos.ghost.rrMilestones ?? {},
        phantomSLHit: pos.ghost.phantomSLHit ?? false,
        slHitAt:      pos.ghost.slHitAt      ?? null,
        stopReason:   pos.ghost.stopReason   ?? null,
        openedAt:     pos.ghost.openedAt     ?? pos.openedAt,
        entry:        pos.ghost.entry        ?? pos.entry,
        sl:           pos.ghost.sl           ?? pos.sl,
        tp:           pos.ghost.tp           ?? pos.tp ?? null,
        tpRRUsed:     pos.ghost.tpRRUsed     ?? null,
        lots:         pos.ghost.lots         ?? pos.lots ?? null,
        optimizerKey: pos.ghost.optimizerKey ?? pos.optimizerKey,
        maxPrice:     pos.ghost.maxPrice     ?? pos.entry,
        vwapBandPct:  pos.ghost.vwapBandPct  ?? null,
      } : null,
      vwapBandPct: pos.vwapBandPct ?? pos.ghost?.vwapBandPct ?? null,
    });
  }
  res.json(out);
});


app.get("/api/tp-config", (req, res) => res.json(tpConfigs));

// /api/performance \-- served by apiGet above (loadPerformanceStats)
// Old loadPerformanceSummary route removed to avoid duplicate registration

app.get("/api/daily-breakdown", async (req, res) => {
  const empty = { days: [], bestTrades: [], worstTrades: [] };
  if (!dbReady) return res.json(empty);
  res.json(await dbCall(db.loadDailyBreakdown(), empty));
});

app.get("/api/ev-stats", async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: "key required" });
  if (!dbReady) return res.json({ count: 0, rrLevels: [] });
  res.json(await dbCall(db.computeEVStats(key), { count: 0, rrLevels: [] }));
});

app.get("/api/band-ghost-stats", async (req, res) => {
  const { bandTier } = req.query;
  if (!bandTier) return res.status(400).json({ error: "bandTier required" });
  if (!dbReady) return res.json([]);
  res.json(await dbCall(db.loadBandGhostStats(bandTier), []));
});

app.post("/api/symbol-risk", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const { symbol, riskPct } = req.body ?? {};
  if (!symbol || riskPct == null) return res.status(400).json({ error: "symbol + riskPct required" });
  if (dbReady) await db.upsertSymbolRisk(symbol, riskPct).catch(e => recordError(e.message));
  symbolRiskMap[symbol] = parseFloat(riskPct);
  res.json({ ok: true, symbol, riskPct });
});

// ══════════════════════════════════════════════════════════════════
//  /api/snapshot  \-- full system state in one call (for Claude / monitoring)
//  Secret required. Returns everything needed to diagnose any issue.
// ══════════════════════════════════════════════════════════════════
app.get("/api/snapshot", async (req, res) => {
  if (!checkSecret(req, res)) return;
  const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

  const [acct, positions, trades, ghostGrouped, daily, performance,
         signalStats, tpConfig, symbolRisk, shadowAnalysis, webhookHistory,
         signalRejects, blockedRaw, spreadStats, evKeys] = await Promise.all([
    safe(getAccountInfo,                        null),
    safe(getPositions,                          []),
    safe(() => dbReady ? db.loadAllTrades()                          : [], []),
    safe(() => dbReady ? db.loadGhostGrouped()                       : [], []),
    safe(() => dbReady ? db.loadDailyBreakdown()                     : {}  , {}),
    safe(() => dbReady ? db.loadPerformanceSummary()                 : {}  , {}),
    safe(() => dbReady ? db.loadSignalStats()                        : {}  , {}),
    safe(() => Promise.resolve(tpConfigs),                           {}),
    safe(() => Promise.resolve(symbolRiskMap),                       {}),
    safe(() => dbReady ? db.loadAllShadowAnalysis()                  : [], []),
    safe(() => dbReady ? db.loadWebhookHistory(50)                   : [], []),
    safe(() => dbReady ? db.loadSignalRejects({})                    : [], []),
    safe(() => dbReady ? db.loadBlockedRaw()                         : [], []),
    safe(() => dbReady ? db.loadSpreadStats({})                      : [], []),
    safe(() => Promise.resolve(Object.keys(keyRiskMults)),           []),
  ]);

  res.json({
    meta: {
      version: VERSION,
      ts: new Date().toISOString(),
      dbReady,
      errorCount: getErrorCount(),
      recentErrors: errorLog.slice(-20),
      complianceDate: liveComplianceDate,
      openPositionCount: openPositions.size,
    },
    account: acct ? {
      balance: acct.balance, equity: acct.equity,
      margin: acct.margin, freeMargin: acct.freeMargin,
      marginLevel: acct.marginLevel, currency: acct.currency,
    } : null,
    livePositions: positions.map(p => ({
      id: p.id, symbol: p.symbol, type: p.type,
      volume: p.volume, openPrice: p.openPrice,
      currentPrice: p.currentPrice, profit: p.profit,
      swap: p.swap, openTime: p.openTime,
    })),
    openPositions: (() => {
      const out = [];
      for (const [id, pos] of openPositions)
        out.push({ positionId: id, symbol: pos.symbol, direction: pos.direction,
          session: pos.session, entry: pos.entry, sl: pos.sl, tp: pos.tp,
          riskPct: pos.riskPct, riskEUR: pos.riskEUR, openedAt: pos.openedAt,
          ghost: pos.ghost ? { maxRR: pos.ghost.maxRR, maxSlPctUsed: pos.ghost.maxSlPctUsed,
            phantomSLHit: pos.ghost.phantomSLHit, stopReason: pos.ghost.stopReason } : null });
      return out;
    })(),
    performance,
    daily,
    signalStats,
    tpConfig,
    symbolRisk,
    keyRiskMults,
    evKeys,
    recentTrades:  (trades  || []).slice(-30),
    ghostGrouped:  (ghostGrouped || []).slice(0, 50),
    shadowAnalysis:(shadowAnalysis || []).slice(0, 30),
    webhookHistory:(webhookHistory || []).slice(0, 50),
    signalRejects: (signalRejects || []).slice(0, 30),
    blockedRaw:    (blockedRaw || []).slice(0, 50),
    spreadStats:   (spreadStats || []).slice(0, 30),
    endpoints: [
      "GET  /",
      "GET  /dashboard",
      "GET  /health",
      "GET  /status",
      "GET  /compliance-date",
      "POST /compliance-date          [secret]",
      "POST /webhook                  [secret]",
      "POST /close/:id                [secret]",
      "POST /history-deals            [secret]",
      "GET  /api/snapshot             [secret]",
      "GET  /api/open-positions",
      "GET  /api/trades",
      "GET  /api/daily-breakdown",
      "GET  /api/performance",
      "GET  /api/tp-config",
      "GET  /api/ev-stats?key=",
      "GET  /api/ghost-trades",
      "GET  /api/ghost-grouped",
      "GET  /api/ghost-history-by-pair",
      "GET  /api/ghost-combo-analysis",
      "GET  /api/shadow-analysis",
      "GET  /api/shadow-winners",
      "GET  /api/mae-stats",
      "GET  /api/signal-log",
      "GET  /api/signal-stats",
      "GET  /api/signal-rejects",
      "GET  /api/blocked-raw",
      "GET  /api/webhook-history",
      "GET  /api/spread-stats",
      "GET  /api/spread-log",
      "GET  /api/band-ghosts",
      "GET  /api/band-ghost-stats?bandTier=",
      "GET  /api/symbol-risk",
      "POST /api/symbol-risk          [secret]",
    ],
  });
});

// ══════════════════════════════════════════════════════════════════
//  DASHBOARD HTML  (self-contained \-- all JS inline)
// ══════════════════════════════════════════════════════════════════

function dashboardHTML() {

const _css = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',system-ui,sans-serif;font-size:12px;line-height:1.4;overflow-x:hidden}
/* Layout */
.hdr{background:#161b22;border-bottom:1px solid rgba(139,148,158,.2);padding:6px 16px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:200;flex-wrap:wrap}
.brand{font-size:13px;font-weight:700;color:#3fb950;letter-spacing:1px;white-space:nowrap}
.hkv{font-size:10px;color:#8b949e;white-space:nowrap}.hkv b{color:#e6edf3}
.hkv.cg b{color:#3fb950}.hkv.cr b{color:#f85149}.hkv.co b{color:#f0883e}.hkv.cb b{color:#388bfd}
.hstat{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:10px}
.dot-g{width:7px;height:7px;border-radius:50%;background:#3fb950;display:inline-block}
.dot-r{width:7px;height:7px;border-radius:50%;background:#f85149;display:inline-block}
.nav{background:#161b22;border-bottom:1px solid rgba(139,148,158,.15);display:flex;padding:0 16px}
.ntab{padding:9px 14px;font-size:11px;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;user-select:none}
.ntab:hover{color:#e6edf3}.ntab.on{color:#3fb950;border-bottom-color:#3fb950;font-weight:600}
.nbdg{background:rgba(139,148,158,.15);color:#8b949e;border-radius:8px;padding:1px 5px;font-size:9px;font-weight:600;margin-left:4px}
/* Pages */
.pg{display:none;padding:14px 16px}.pg.on{display:block}
/* Cards */
.card{background:#161b22;border:1px solid rgba(139,148,158,.15);border-radius:6px;margin-bottom:12px}
.chdr{padding:8px 12px;border-bottom:1px solid rgba(139,148,158,.1);display:flex;align-items:center;gap:8px;font-size:10px;color:#8b949e}
.ctitle{font-size:11px;font-weight:600;color:#e6edf3;display:flex;align-items:center;gap:6px}
.dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.dot.g{background:#3fb950}.dot.r{background:#f85149}.dot.o{background:#f0883e}
.dot.b{background:#388bfd}.dot.p{background:#bc8cff}.dot.y{background:#d29922}
.cm{margin-left:auto;font-size:9px}
/* Balance grid */
.balgrid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1.4fr;gap:10px;padding:10px}
.balcard{padding:10px 12px;background:#0d1117;border-radius:5px;border:1px solid rgba(139,148,158,.1)}
.balcard.eq{border-color:rgba(56,139,253,.3);background:rgba(56,139,253,.04)}
.bll{font-size:9px;color:#8b949e;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.blv{font-size:20px;font-weight:700}
.bls{font-size:9px;color:#6e7681;margin-top:2px}
.bleq{font-size:9px;color:#8b949e;margin-top:3px}
/* KPI strip */
.kst{display:grid;gap:8px;padding:8px 10px}
.ks{background:#0d1117;border-radius:4px;padding:6px 10px;border:1px solid rgba(139,148,158,.1)}
.ksl{font-size:9px;color:#8b949e;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.ksv{font-size:16px;font-weight:700}
/* Tables */
.tw{width:100%;overflow-x:auto}
table{border-collapse:collapse;width:100%}
th{text-align:left;font-size:9px;font-weight:500;color:#6e7681;padding:4px 6px;border-bottom:1px solid rgba(139,148,158,.15);white-space:nowrap;background:#161b22;position:sticky;top:0;z-index:10}
td{padding:4px 6px;border-bottom:1px solid rgba(139,148,158,.08);font-size:10px;vertical-align:middle}
tr:hover td{background:rgba(139,148,158,.04)}
tr:last-child td{border-bottom:none}
.nd{text-align:center;color:#6e7681;padding:20px}
/* Milestone headers */
.adv-th{background:rgba(248,81,73,.07)!important}
.fav-th{background:rgba(63,185,80,.07)!important}
.adv-hit{background:rgba(248,81,73,.25)!important;border-left:1px solid rgba(248,81,73,.3)!important}
.fav-hit{background:rgba(63,185,80,.25)!important;border-left:1px solid rgba(63,185,80,.3)!important}
/* Badges */
.bd{display:inline-flex;align-items:center;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;white-space:nowrap}
.bd-buy{background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3)}
.bd-sell{background:rgba(248,81,73,.15);color:#f85149;border:1px solid rgba(248,81,73,.3)}
.bd-ab{background:rgba(63,185,80,.1);color:#3fb950}
.bd-bw{background:rgba(248,81,73,.1);color:#f85149}
.bd-fx{background:rgba(56,139,253,.15);color:#388bfd;border:1px solid rgba(56,139,253,.3)}
.bd-stk{background:rgba(240,136,62,.15);color:#f0883e;border:1px solid rgba(240,136,62,.3)}
.bd-idx{background:rgba(57,211,242,.15);color:#39d3f2;border:1px solid rgba(57,211,242,.3)}
.bd-com{background:rgba(188,140,255,.15);color:#bc8cff;border:1px solid rgba(188,140,255,.3)}
.bd-sl{background:rgba(248,81,73,.2);color:#f85149;border:1px solid rgba(248,81,73,.4)}
.bd-tp{background:rgba(63,185,80,.2);color:#3fb950;border:1px solid rgba(63,185,80,.4)}
.bd-gap{background:rgba(210,153,34,.2);color:#d29922;border:1px solid rgba(210,153,34,.4)}
.bd-ny{color:#f0883e;font-size:10px;font-weight:500}
.bd-ld{color:#3fb950;font-size:10px;font-weight:500}
.bd-as{color:#8b949e;font-size:10px;font-weight:500}
.bd-live{background:rgba(63,185,80,.12);color:#3fb950;border:1px solid rgba(63,185,80,.25);padding:2px 7px;border-radius:3px;font-size:9px;font-weight:700}
.bd-slhit{background:rgba(248,81,73,.2);color:#f85149;border:1px solid rgba(248,81,73,.4);padding:2px 7px;border-radius:3px;font-size:9px;font-weight:700}
.bd-placed{background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3)}
.bd-rej{background:rgba(248,81,73,.15);color:#f85149;border:1px solid rgba(248,81,73,.3)}
.bd-ooh{background:rgba(139,148,158,.1);color:#8b949e;border:1px solid rgba(139,148,158,.25)}
.bd-block{background:rgba(240,136,62,.15);color:#f0883e;border:1px solid rgba(240,136,62,.3)}
.bd-dup{background:rgba(210,153,34,.15);color:#d29922;border:1px solid rgba(210,153,34,.3)}
.bd-vwap{background:rgba(188,140,255,.15);color:#bc8cff;border:1px solid rgba(188,140,255,.3)}
.bd-err{background:rgba(248,81,73,.3);color:#ff4444;border:1px solid #f85149;font-weight:700}
.bd-k1{background:rgba(139,148,158,.1);color:#8b949e;border:1px solid rgba(139,148,158,.25)}
.bd-k2{background:rgba(56,139,253,.15);color:#388bfd;border:1px solid rgba(56,139,253,.3)}
.bd-k4{background:rgba(188,140,255,.15);color:#bc8cff;border:1px solid rgba(188,140,255,.3)}
/* Colors */
.cg{color:#3fb950}.cr{color:#f85149}.co{color:#f0883e}.cb{color:#388bfd}.cp{color:#bc8cff}.cy{color:#d29922}.cd{color:#8b949e}
.fw{font-weight:700}.cb2{color:#39d3f2}.cw{color:#e6edf3}
/* Sig row highlight */
.row-rej{background:rgba(248,81,73,.04)!important}
.row-placed{background:rgba(63,185,80,.03)!important}
.row-ooh{background:rgba(139,148,158,.03)!important}
.row-dup{background:rgba(210,153,34,.03)!important}
/* Sechdr */
.sechdr{font-size:10px;font-weight:600;color:#8b949e;padding:8px 12px 4px;display:flex;align-items:center;gap:6px;text-transform:uppercase;letter-spacing:.4px}
/* Expandable raw webhook */
.raw-json{display:none;background:#0d1117;border-radius:4px;padding:8px;font-family:monospace;font-size:9px;color:#8b949e;max-height:200px;overflow-y:auto;margin-top:4px;border:1px solid rgba(139,148,158,.15);white-space:pre-wrap;word-break:break-all}
.raw-json.open{display:block}
/* Scroll */
.sl-row{background:rgba(248,81,73,.05)!important}
`;

return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO\.AI</title>
<style>${_css}</style>
</head>
<body>

<!-- HEADER -->
<div class="hdr">
  <div class="brand">PRONTO\.AI <span id="ver" style="font-size:10px;color:#6e7681;font-weight:400">v14.8</span></div>
  <div class="hkv">Balance <b id="h-bal">\--</b></div>
  <div class="hkv cg">Unrealized <b id="h-upnl">\--</b></div>
  <div class="hkv cg">Realized <b id="h-rpnl">\--</b></div>
  <div class="hkv">Open MT5 <b id="h-open">\--</b></div>
  <div class="hkv cp">Active Ghost <b id="h-ghost">\--</b></div>
  <div class="hkv cc">Finalized <b id="h-fin">\--</b></div>
  <div class="hkv cp">Shadow <b id="h-shadow">\--</b></div>
  <div class="hkv">TP Locked <b id="h-tp">\--</b></div>
  <div class="hkv cr">Errors <b id="h-err">0</b></div>
  <div class="hkv cb" id="h-db">DB init...</div>
  <div class="hstat">
    <span id="h-sess-dot" class="dot-g"></span>
    <span id="h-sess" style="font-size:10px;color:#8b949e">\--</span>
    <span id="h-time" style="font-size:10px;color:#6e7681">\--</span>
  </div>
</div>

<!-- NAV -->
<div class="nav">
  <div class="ntab on" onclick="go('ov',this)">Overview</div>
  <div class="ntab" onclick="go('sig',this)">Signals &amp; Blocked<span class="nbdg" id="nb-sig">0</span></div>
  <div class="ntab" onclick="go('gh',this)">Ghost Tracker<span class="nbdg" id="nb-gh" style="background:rgba(188,140,255,.15);color:#bc8cff">0</span></div>
  <div class="ntab" onclick="go('sh',this)">Shadow Tracker<span class="nbdg" id="nb-sh" style="background:rgba(188,140,255,.15);color:#bc8cff">0</span></div>
  <div class="ntab" onclick="go('ev',this)">EV + Optimizer</div>
</div>

<!-- ══════════ OVERVIEW ══════════ -->
<div class="pg on" id="p-ov">

  <!-- Balance -->
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot g"></div>Account Balance</div></div>
    <div class="balgrid">
      <div class="balcard">
        <div class="bll">Start Balance</div>
        <div class="blv" id="ov-startbal">EUR50.000</div>
        <div class="bls">at trading start</div>
      </div>
      <div class="balcard">
        <div class="bll">+ Realized P&amp;L</div>
        <div class="blv cg" id="ov-realbal">\--</div>
        <div class="bls"><span id="ov-tradecount">\--</span> closed trades</div>
      </div>
      <div class="balcard">
        <div class="bll">= Cash Balance</div>
        <div class="blv" id="ov-cashbal">\--</div>
        <div class="bls">start + closed P&amp;L</div>
      </div>
      <div class="balcard">
        <div class="bll">+ Unrealized P&amp;L</div>
        <div class="blv cg" id="ov-upnl">\--</div>
        <div class="bls"><span id="ov-opencount">\--</span> open positions</div>
      </div>
      <div class="balcard eq">
        <div class="bll">= Equity (MT5)</div>
        <div class="blv cb" id="ov-equity">\--</div>
        <div class="bleq" id="ov-equitycheck">\--</div>
      </div>
    </div>
  </div>

  <!-- Equity Curve Chart (Fix 10) -->
  <div class="card" style="padding:12px 12px 8px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <span style="font-size:11px;font-weight:600;color:#e6edf3"> Equity Curve</span>
      <span id="eq-stats" style="font-size:9px;color:#8b949e">loading...</span>
    </div>
    <canvas id="equity-chart" style="width:100%;height:80px;display:block"></canvas>
  </div>

  <!-- Open Positions Performance -->
  <div class="card">
    <div class="chdr">
      <div class="ctitle"><div class="dot g"></div>Open Positions Performance</div>
      <div class="cm">WR = P&amp;L &gt; 0</div>
    </div>
    <div class="kst" style="grid-template-columns:repeat(8,1fr)">
      <div class="ks"><div class="ksl">Open MT5</div><div class="ksv" id="ov-open">\--</div></div>
      <div class="ks"><div class="ksl">Wins (P&amp;L&gt;0)</div><div class="ksv cg" id="ov-wins">\--</div></div>
      <div class="ks"><div class="ksl">Losses</div><div class="ksv cr" id="ov-loss">\--</div></div>
      <div class="ks"><div class="ksl">Win Rate</div><div class="ksv cy" id="ov-wr">\--</div></div>
      <div class="ks"><div class="ksl">Best Peak+RR</div><div class="ksv cg fw" id="ov-bestpeak">\--</div></div>
      <div class="ks"><div class="ksl">Worst Peak−RR</div><div class="ksv cr fw" id="ov-worstpeak">\--</div></div>
      <div class="ks"><div class="ksl">Max Possible +RR</div><div class="ksv cy" id="ov-maxrr">\--</div></div>
      <div class="ks"><div class="ksl">Unrealized P&amp;L</div><div class="ksv cg" id="ov-upnl2">\--</div></div>
    </div>
  </div>

  <!-- Open Trades Table (live MT5) -->
  <div class="card">
    <div class="chdr">
      <div class="ctitle"><div class="dot g"></div>Open Trades \-- Live MT5</div>
      <div class="cm" id="ov-open-cm">\--</div>
    </div>
    <div class="tw">
      <table>
        <thead><tr>
          <th>Status</th><th>Symbol</th><th>Type</th><th>Dir</th><th>VWAP</th><th>Session</th>
          <th>Risk%</th><th>RiskEUR</th>
          <th>Entry</th><th>SL</th><th>TP</th>
          <th style="color:#388bfd">RR Now</th>
          <th style="color:#3fb950">Peak+</th>
          <th style="color:#f85149">Peak−</th>
          <th>TP Set</th>
          <th>Band%</th><th>S.High</th><th>S.Low</th><th>#</th>
          <th>Curr.Price</th><th>Unrealized</th><th>Lots</th>
          <th>MT5 Comment</th><th>Opened</th>
        </tr></thead>
        <tbody id="ov-open-body"><tr><td colspan="24" class="nd">⏳ Loading...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- Daily Log removed by user request -->

  <!-- Closed Trades Full Table -->
  <div class="card">
    <div class="chdr">
      <div class="ctitle"><div class="dot r"></div>Closed Trades</div>
      <div class="cm" id="ov-trades-cm">\--</div>
    </div>
    <div class="tw">
      <table>
        <thead><tr>
          <th>SL/TP</th><th>Symbol</th><th>Type</th><th>Dir</th><th>VWAP</th><th>Session</th>
          <th>Entry</th><th>SL</th><th>TP</th><th>Exit</th>
          <th>Risk%</th><th>RiskEUR</th>
          <th>Realized EUR</th><th>Lots</th>
          <th style="color:#3fb950">Peak+RR</th><th style="color:#f85149">Peak−RR</th><th>Ghost</th><th>MT5 Comment</th>
          <th>Opened</th><th>Closed</th>
        </tr></thead>
        <tbody id="ov-trades"><tr><td colspan="20" class="nd">⏳ Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════ SIGNALS & BLOCKED ══════════ -->
<div class="pg" id="p-sig">

  <!-- KPIs -->
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot b"></div>Signal Intelligence</div><div class="cm">last 7 days</div></div>
    <div class="kst" style="grid-template-columns:repeat(11,1fr)">
      <div class="ks"><div class="ksl">Total</div><div class="ksv" id="sg-total">\--</div></div>
      <div class="ks"><div class="ksl">-> Placed</div><div class="ksv cg" id="sg-placed">\--</div></div>
      <div class="ks"><div class="ksl">Conv%</div><div class="ksv cy" id="sg-conv">\--</div></div>
      <div class="ks"><div class="ksl">-> Shadow</div><div class="ksv cp" id="sg-shadow">\--</div></div>
      <div class="ks"><div class="ksl" style="font-size:8px"> NY Dead 15:30</div><div class="ksv co" id="sg-ny-dead">\--</div></div>
      <div class="ks"><div class="ksl" style="font-size:8px"> NY Night 21h</div><div class="ksv co" id="sg-ny-night">\--</div></div>
      <div class="ks"><div class="ksl" style="font-size:8px"> Asia 0-2h</div><div class="ksv co" id="sg-asia">\--</div></div>
      <div class="ks"><div class="ksl">⚡ VWAP Exh</div><div class="ksv cp" id="sg-vwap">\--</div></div>
      <div class="ks"><div class="ksl"> Duplicate</div><div class="ksv cy" id="sg-dup">\--</div></div>
      <div class="ks"><div class="ksl"> Stk OOH</div><div class="ksv cd" id="sg-ooh">\--</div></div>
      <div class="ks" style="background:rgba(248,81,73,.06)"><div class="ksl" style="color:#f85149">⚠ Errors</div><div class="ksv cr fw" id="sg-err">\--</div></div>
    </div>
  </div>

  <!-- Signal Log -->
  <div class="card">
    <div class="chdr">
      <div class="ctitle"><div class="dot g"></div>Signal Log \-- All Outcomes</div>
      <div class="cm">most recent first</div>
    </div>
    <div class="tw">
      <table>
        <thead><tr>
          <th>Time</th>
          <th>Symbol</th>
          <th>Type</th>
          <th>Dir</th>
          <th>Session</th>
          <th>VWAP</th>
          <th>Entry</th>
          <th style="color:#d29922">Band%</th>
          <th>S.High</th>
          <th>S.Low</th>
          <th>Bulls</th>
          <th>#Key</th>
          <th>Outcome</th>
          <th>Destination / What-If</th>
          <th>Latency</th>
          <th style="font-size:8px">Raw</th>
        </tr></thead>
        <tbody id="sig-log"><tr><td colspan="16" class="nd">⏳ Loading...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- Errors section -->
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot r"></div>Errors \-- Did Not Reach Ghost or Shadow</div></div>
    <div class="tw">
      <table>
        <thead><tr>
          <th>Time</th><th>Symbol</th><th>Dir</th><th>Error Type</th><th>Detail</th><th>Retried</th>
        </tr></thead>
        <tbody id="sig-err-body"><tr><td colspan="6" class="nd">No errors</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════ GHOST TRACKER ══════════ -->
<div class="pg" id="p-gh">

  <!-- KPIs -->
  <div class="kst" style="grid-template-columns:repeat(8,1fr);margin-bottom:12px">
    <div class="ks card"><div class="ksl">Active</div><div class="ksv" id="gh-active-cnt">\--</div></div>
    <div class="ks card"><div class="ksl">SL Today</div><div class="ksv cr" id="gh-sl-today">\--</div></div>
    <div class="ks card"><div class="ksl">Best Peak+</div><div class="ksv cg fw" id="gh-best-peak">\--</div></div>
    <div class="ks card"><div class="ksl">Avg Peak+</div><div class="ksv cy" id="gh-avg-peak">\--</div></div>
    <div class="ks card"><div class="ksl">Buy</div><div class="ksv cg" id="gh-buy">\--</div></div>
    <div class="ks card"><div class="ksl">Sell</div><div class="ksv cr" id="gh-sell">\--</div></div>
    <div class="ks card"><div class="ksl">TP Estimated</div><div class="ksv cy" id="gh-tp-est">\--</div></div>
    <div class="ks card"><div class="ksl">Finalized Total</div><div class="ksv cc" id="gh-fin-cnt">\--</div></div>
  </div>

  <!-- Active Ghost Table -->
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot g"></div>Active Ghost Tracker \-- Live Milestones</div></div>
    <div class="tw">
      <table style="min-width:2000px">
        <thead><tr>
          <th>Status</th>
          <th>Symbol</th>
          <th style="max-width:110px">MT5 Comment</th>
          <th>Type</th>
          <th>Dir</th>
          <th>VWAP</th>
          <th>Session</th>
          <th>#Key</th>
          <th style="color:#388bfd">RR Now</th>
          <th style="color:#3fb950">Peak+RR</th>
          <th style="color:#f85149">Peak−RR</th>
          <th>TP Set</th>
          <th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-1.0</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.9</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.8</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.7</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.6</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.5</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.4</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.3</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.2</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.0</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+2.0</th>
          <th>TV Entry</th>
          <th>Entry</th>
          <th>SL</th>
          <th>TP</th>
          <th>Unreal.</th>
          <th>Lots</th>
          <th>Opened</th>
        </tr></thead>
        <tbody id="gh-active-body"><tr><td colspan="48" class="nd">⏳ Loading...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- Ghost Finalized -->
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot r"></div>Ghost Finalized \-- Stop Reasons: PHANTOM_SL \. GAP_STOP \. TP_HIT</div></div>
    <div class="tw">
      <table style="min-width:2000px">
        <thead><tr>
          <th>#</th>
          <th>Symbol</th>
          <th>Type</th>
          <th>Session</th>
          <th>Dir</th>
          <th>VWAP</th>
          <th>Stop</th>
          <th>TP Used</th>
          <th style="color:#3fb950">Peak+RR</th>
          <th style="color:#f85149">Peak−RR</th>
          <th>Band%</th>
          <th>#Key</th>
          <th>Realized EUR</th>
          <th>Lots</th>
          <th>MT5 Comment</th>
          <th>Optimizer Key</th>
          <th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-1.0</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.9</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.8</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.7</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.6</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.5</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.4</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.3</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.2</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.0</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+2.0</th>
          <th>Opened</th>
          <th>Elapsed</th>
        </tr></thead>
        <tbody id="gh-fin-body"><tr><td colspan="47" class="nd">⏳ Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════ SHADOW TRACKER ══════════ -->
<div class="pg" id="p-sh">

  <!-- Timezone Blocks -->
  <div class="sechdr"><div class="dot o"></div> Timezone Blocks \-- NY Dead \. NY Night \. Asia Morning</div>
  <div class="card">
    <div class="tw">
      <table style="min-width:1800px">
        <thead><tr>
          <th>Block</th><th>Symbol</th><th>Type</th><th>#Key</th><th>Dir</th><th>VWAP</th>
          <th>Session</th>
          <th style="color:#3fb950">Peak+</th>
          <th style="color:#f85149">Peak−RR</th>
          <th>Band%</th>
          <th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-1.0</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.9</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.8</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.7</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.6</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.5</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.4</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.3</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.2</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.0</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+2.0</th>
          <th>Entry</th><th>Blocked At</th><th>Elapsed</th>
        </tr></thead>
        <tbody id="sh-tz-body"><tr><td colspan="43" class="nd">⏳ Loading...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- VWAP Exhaustion -->
  <div class="sechdr"><div class="dot p"></div>⚡ VWAP Exhaustion Blocks</div>
  <div class="card">
    <div class="tw">
      <table style="min-width:1800px">
        <thead><tr>
          <th>Block</th><th>Symbol</th><th>Type</th><th>#Key</th><th>Dir</th><th>VWAP</th>
          <th style="color:#3fb950">Peak+</th>
          <th style="color:#f85149">Peak−RR</th>
          <th>Band%</th>
          <th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-1.0</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.9</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.8</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.7</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.6</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.5</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.4</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.3</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.2</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.0</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+2.0</th>
          <th>Entry</th><th>Blocked At</th>
        </tr></thead>
        <tbody id="sh-vwap-body"><tr><td colspan="41" class="nd">⏳ Loading...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- Duplicate Blocks -->
  <div class="sechdr"><div class="dot y"></div> Duplicate Position Blocks (#KEY ≥ 2)</div>
  <div class="card">
    <div class="tw">
      <table style="min-width:1800px">
        <thead><tr>
          <th>Block</th><th>Symbol</th><th>Type</th><th>#Key</th><th>Dir</th><th>VWAP</th>
          <th style="color:#3fb950">Peak+</th>
          <th style="color:#f85149">Peak−RR</th>
          <th>Band%</th>
          <th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-1.0</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.9</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.8</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.7</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.6</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.5</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.4</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.3</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.2</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.0</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+2.0</th>
          <th>Entry</th><th>Blocked At</th>
        </tr></thead>
        <tbody id="sh-dup-body"><tr><td colspan="41" class="nd">⏳ Loading...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- Shadow Finalized -->
  <div class="sechdr"><div class="dot cd"></div> Shadow Finalized \-- History</div>
  <div class="card">
    <div class="tw">
      <table style="min-width:1800px">
        <thead><tr>
          <th>Block</th><th>Symbol</th><th>Type</th><th>#Key</th><th>Dir</th><th>VWAP</th>
          <th>Stop</th>
          <th style="color:#3fb950">Peak+RR</th>
          <th style="color:#f85149">Peak−RR</th>
          <th>Band%</th>
          <th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-1.0</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.9</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.8</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.7</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.6</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.5</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.4</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.3</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.2</th><th class="adv-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">-0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+0.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.0</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.1</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.2</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.3</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.4</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.5</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.6</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.7</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.8</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+1.9</th><th class="fav-th" style="min-width:28px;font-size:7px;text-align:center;padding:2px 1px">+2.0</th>
          <th>Entry</th><th>Blocked</th><th>Elapsed</th>
        </tr></thead>
        <tbody id="sh-fin-body"><tr><td colspan="43" class="nd">⏳ Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ══════════ EV + OPTIMIZER ══════════ -->
<div class="pg" id="p-ev">
  <!-- Session Win Rate -->
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot g"></div>Win Rate per Session</div><div class="cm">based on finalized ghosts</div></div>
    <div class="tw"><table>
      <thead><tr>
        <th>Session</th><th>Ghosts</th><th>Would TP</th><th>Win%</th>
        <th style="color:#3fb950">Avg Peak+</th><th style="color:#f85149">Avg Peak−%</th><th>Avg T->SL</th>
      </tr></thead>
      <tbody id="sess-stats-body"><tr><td colspan="7" class="nd">⏳ Loading...</td></tr></tbody>
    </table></div>
  </div>

  <!-- Milestone Probability -->
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot y"></div>Milestone Probability per Key</div><div class="cm">% chance of reaching each RR level \. min 3 ghosts</div></div>
    <div class="tw"><table style="min-width:900px">
      <thead><tr>
        <th>Key</th><th>#</th>
        <th style="color:#f85149">-0.1R</th><th style="color:#f85149">-0.3R</th>
        <th style="color:#f85149">-0.5R</th><th style="color:#f85149">-0.8R</th>
        <th style="color:#f85149;border-right:1px solid rgba(139,148,158,.2)">-1.0R</th>
        <th style="color:#3fb950">+0.3R</th><th style="color:#3fb950">+0.5R</th>
        <th style="color:#3fb950">+0.8R</th><th style="color:#3fb950">+1.0R</th>
        <th style="color:#3fb950">+1.5R</th>
        <th style="color:#d29922">Recovery</th><th>Avg T->SL</th>
      </tr></thead>
      <tbody id="ms-prob-body"><tr><td colspan="14" class="nd">⏳ Loading...</td></tr></tbody>
    </table></div>
  </div>

  <!-- Shadow What-If -->
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot o"></div>Shadow -> Ghost "What If"</div><div class="cm">if blocked signals were placed \-- peak tracking from shadow</div></div>
    <div class="tw"><table>
      <thead><tr>
        <th>Block Type</th><th>Total</th>
        <th style="color:#3fb950">Would TP (≥1.5R)</th><th>TP%</th>
        <th style="color:#f85149">Would SL (≥100%)</th><th>SL%</th>
        <th style="color:#3fb950">Avg Peak+</th><th style="color:#f85149">Avg Peak−%</th>
        <th style="color:#388bfd">Est. Missed EUR</th>
      </tr></thead>
      <tbody id="shadow-whatif-body"><tr><td colspan="9" class="nd">⏳ Loading...</td></tr></tbody>
    </table></div>
  </div>

  <!-- EV Optimizer -->
  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot p"></div>EV TP Optimizer \-- per Optimizer Key</div><div class="cm">min 5 ghosts for reliable stats</div></div>
    <div class="tw"><table>
      <thead><tr>
        <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
        <th>#Ghosts</th><th>Win%</th><th>EV Score</th>
        <th style="color:#3fb950">Avg Peak+</th><th style="color:#f85149">Avg Peak−</th>
        <th>Avg T-SL</th><th>Best TP</th><th>TP Lock</th><th>Risk&times;</th><th>P&amp;L EUR</th>
      </tr></thead>
      <tbody id="ev-body"><tr><td colspan="15" class="nd">⏳ Loading...</td></tr></tbody>
    </table></div>
  </div

<script>
'use strict';
// ==============================================
// HELPERS
// ==============================================
const $  = id => document.getElementById(id);
const el = id => document.getElementById(id);
const fmt   = (v,d=2) => v==null?'\--':Number(v).toFixed(d);
const fmtE  = v => v==null?'\--':(v>=0?'+':'')+'EUR'+Math.abs(Number(v)).toFixed(0);
const fmtR  = v => v==null?'\--':(v>=0?'+':'')+Number(v).toFixed(2)+'R';
const fmtP  = v => v==null?'\--':Number(v).toFixed(1)+'%';
const fmtPct= v => v==null?'\--':(v*100).toFixed(2)+'%';
const cRR   = v => v==null?'cd':v>0.5?'cg fw':v>0?'cg':v<-0.5?'cr fw':v<0?'cr':'cd';
const cE    = v => v==null?'cd':v>0?'cg':v<0?'cr':'cd';
const fmtT  = s => !s?'\--':new Date(s).toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const fmtTs = s => !s?'\--':new Date(s).toLocaleString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const fmtEl = (s,e) => {
  if(!s) return '\--';
  const ms=(e?new Date(e):new Date())-new Date(s);
  const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000);
  return h>0?h+'h'+String(m).padStart(2,'0')+'m':m+'m';
};
const fmtMs = (v,openTs) => {
  if(v==null) return null;
  let n=null;
  if(typeof v==='number'&&v>1000000000000) n=v;
  else if(typeof v==='string'&&v.length>10) n=new Date(v).getTime();
  if(n&&openTs){
    const el2=Math.round((n-openTs)/60000);
    if(el2<0) return '0m';
    if(el2<60) return el2+'m';
    const hh=Math.floor(el2/60),mm=el2%60;
    return hh+'h'+(mm?String(mm).padStart(2,'0')+'m':'');
  }
  return typeof v==='number'&&v<100000?v+'m':String(v);
};
const nd = (cols,msg='No data') => '<tr><td colspan="'+cols+'" class="nd">'+msg+'</td></tr>';

// Client-side symbol type catalog
const STYPE={
  forex:['EURUSD','GBPUSD','AUDUSD','USDCAD','USDCHF','USDJPY','NZDUSD','EURGBP','EURJPY','GBPJPY','AUDJPY','CADJPY','CHFJPY','EURAUD','EURCAD','EURCHF','EURNZD','GBPAUD','GBPCAD','GBPCHF','GBPNZD','AUDCAD','AUDCHF','AUDNZD','CADCHF','NZDCAD','NZDCHF','NZDJPY','XAUUSD','XAGUSD'],
  stock:['AAPL','MSFT','GOOGL','GOOG','AMZN','META','TSLA','ZM','BRKB','ARM','NKE','ASML','JPM','GE','SNOW','PLTR','GS','MS','C','WFC','BAC','NVDA','AMD','INTC','CSCO','ORCL','IBM','QCOM','TXN','AVGO','MU','JPM','BAC','WFC','GS','MS','C','UNH','JNJ','PFE','ABBV','MRK','BMY','LLY','AMGN','GILD','CVX','XOM','COP','EOG','KO','PEP','MCD','SBUX','YUM','WMT','TGT','COST','HD','DIS','NFLX','PARA','BA','LMT','RTX','NOC','GD','GE','HON','MMM','AZN','MSTR','KO','INTC','V','MA','NFLX','AMD','BA','CSCO','SBUX','WMT','LMT','QCOM','IBM','MSTR','MCD','GOOGL','DIS','META','TSLA','AAPL','AMZN','AZN','JNJ','MSTR','AVGO','LMT','INTC','QCOM','AZN','V','MA','MSTR','JNJ','NVDA','AMD','BA','IBM','KO','WMT','LMT','MCD','NFLX','AZN','CSCO','INTC','QCOM','SBUX','AMZN','DIS','META','MSFT','TSLA','AAPL','GOOGL','AVGO','JNJ','KO','WMT','AZN','GME','AMC','PLTR','RIVN','LCID','SOFI','BB','NOK','SPCE','NIO','XPEV','LI','BIDU','PDD','BABA','JD','SE','GRAB','COIN','HOOD','RBLX','U','PATH','AI','SNOW','DDOG','NET','CRWD','ZS','OKTA','MDB','CFLT','GTLB','BILL','PCTY','PAYC','HUBS','TEAM','ZI','RNG','FROG','ESTC','SUMO','BIGC','BRZE','TOST','DLO','MGNI','TTD','PUBM','APPS','IRBT','SQ','PYPL','AFRM','UPST','SOFI','OPEN','OPENDOOR','LMND','ROOT','METROMILE','HIPPO','DOMA','PAYO','GH','ILMN','EDIT','NTLA','BEAM','CRSP','FATE','SANA','AGEN','RCKT','ARVN','ARWR','IDYA','IMVT','NKTR','ALNY','BMRN','JAZZ','RARE','ACAD','SGEN','EXAS','NTRA','IOVA','MRSN','FATE','VERV','TALS','DNLI','KYMR'],
  index:['SPX500','US500','US30','NAS100','US100','DE30','GER40','UK100','JP225','AUS200','NAS100USD','US30USD','UK100GBP','DE30EUR','GER40EUR','USTEC','SPX','DAX','FTSE','CAC40','STOXX50','US30.cash','US100.cash','NAS100.cash','NAS100USD','US30USD'],
  commodity:['XAUUSD','XAGUSD','XPTUSD','XPDUSD','WTIUSD','BCOUSD','XTIUSD','NGAS','WHEAT','CORN','COPPER','USOIL','UKOIL'],
};
function resolveType(sym){
  if(!sym) return null;
  const s=sym.toUpperCase().replace(/\..*$/,'');
  for(const [type,arr] of Object.entries(STYPE)){
    if(arr.includes(s)||arr.includes(sym.toUpperCase())) return type;
  }
  return null;
}

// Badge functions
function bdType(t,sym){
  const _r=t||(sym?resolveType(sym):null);
  const _t=(_r||'').toLowerCase();
  const m={forex:'FX',stock:'STK',index:'IDX',commodity:'COM'};
  const lbl=m[_t]||(_t&&_t.length>0&&_t!=='?'?_t.toUpperCase().slice(0,4):'?');
  const cls={FX:'bd-fx',STK:'bd-stk',IDX:'bd-idx',COM:'bd-com'}[lbl]||'';
  return '<span class="bd '+cls+'">'+lbl+'</span>';
}
function bdDir(d){
  const _d=(d||'').toUpperCase();
  return _d==='BUY'?'<span class="bd bd-buy">BUY</span>':'<span class="bd bd-sell">SELL</span>';
}
function bdVwap(v){
  const _v=(v||'').toUpperCase();
  return _v==='ABOVE'?'<span class="bd bd-ab">ABOVE</span>':'<span class="bd bd-bw">BELOW</span>';
}
function bdSess(s){
  const _s=(s||'').toLowerCase();
  const m={ny:'NEW YORK',london:'LONDON',asia:'ASIA',ny_dead_zone:'NY DEAD',ny_night:'NY NIGHT',asia_morning:'ASIA'};
  const lbl=m[_s]||_s.toUpperCase();
  const cls={ny:'bd-ny',london:'bd-ld',asia:'bd-as',ny_dead_zone:'bd-ny',ny_night:'bd-ny',asia_morning:'bd-as'}[_s]||'cd';
  return '<span class="'+cls+'">'+lbl+'</span>';
}
function bdStop(r){
  const _r=(r||'').toLowerCase();
  const m={sl:'SL',tp:'TP',sl_gap:'GAP',gap_stop:'GAP',phantom_sl:'SL',tp_hit:'TP',manual:'SL',sl_gap_stop:'GAP'};
  const lbl=m[_r]||(r?r.toUpperCase().slice(0,4):'?');
  const cls={TP:'bd-tp',SL:'bd-sl',GAP:'bd-gap'}[lbl]||'';
  return '<span class="bd '+cls+'">'+lbl+'</span>';
}
function bdKey(n){
  const k=parseInt(n)||1;
  const cls=k>=4?'bd-k4':k>=2?'bd-k2':'bd-k1';
  return '<span class="bd '+cls+'">'+k+'</span>';
}
function bdBlock(bt){
  const t=(bt||'').toUpperCase();
  if(t.includes('NY_DEAD')||t.includes('NY_NIGHT')||t.includes('ASIA')||t.includes('TIMEZONE')||t.includes('OUTSIDE'))
    return '<span class="bd bd-block">'+( t.includes('NY_DEAD')?'NY Dead':t.includes('NY_NIGHT')?'NY Night':t.includes('ASIA')?'Asia':'TZ Block')+'</span>';
  if(t.includes('DUPLICATE')) return '<span class="bd bd-dup">Duplicate</span>';
  if(t.includes('VWAP')) return '<span class="bd bd-vwap">VWAP Exh</span>';
  return '<span class="bd bd-ooh">'+t+'</span>';
}
function outcomeBdg(o){
  const _map={
    PLACED:{l:'PLACED',c:'rgba(63,185,80,.2)',t:'#3fb950',b:'rgba(63,185,80,.4)'},
    NY_DEAD_ZONE:{l:'NY Dead',c:'rgba(240,136,62,.15)',t:'#f0883e',b:'rgba(240,136,62,.4)'},
    NY_NIGHT:{l:'NY Night',c:'rgba(240,136,62,.15)',t:'#f0883e',b:'rgba(240,136,62,.4)'},
    ASIA_MORNING:{l:'Asia',c:'rgba(240,136,62,.15)',t:'#f0883e',b:'rgba(240,136,62,.4)'},
    VWAP_EXHAUSTION:{l:'VWAP Exh',c:'rgba(188,140,255,.15)',t:'#bc8cff',b:'rgba(188,140,255,.4)'},
    DUPLICATE_POSITION:{l:'Duplicate',c:'rgba(210,153,34,.15)',t:'#d29922',b:'rgba(210,153,34,.4)'},
    REJECTED:{l:'REJECTED',c:'rgba(248,81,73,.15)',t:'#f85149',b:'rgba(248,81,73,.4)'},
    ERROR:{l:'ERROR',c:'rgba(248,81,73,.3)',t:'#ff4444',b:'#f85149'},
    ORDER_NOT_CONFIRMED:{l:'No Pos',c:'rgba(248,81,73,.2)',t:'#f85149',b:'#f85149'},
    STOCK_OOH:{l:'Stk OOH',c:'rgba(139,148,158,.1)',t:'#8b949e',b:'rgba(139,148,158,.3)'},
    WEEKEND:{l:'Weekend',c:'rgba(139,148,158,.1)',t:'#8b949e',b:'rgba(139,148,158,.3)'},
    UNKNOWN_SYMBOL:{l:'Unk Sym',c:'rgba(248,81,73,.1)',t:'#f85149',b:'rgba(248,81,73,.3)'},
    MAX_POSITIONS:{l:'Max Pos',c:'rgba(210,153,34,.1)',t:'#d29922',b:'rgba(210,153,34,.3)'},
  };
  const m=_map[o]||{l:o||'?',c:'rgba(139,148,158,.1)',t:'#8b949e',b:'rgba(139,148,158,.25)'};
  return '<span style="background:'+m.c+';color:'+m.t+';border:1px solid '+m.b+';padding:1px 5px;border-radius:3px;font-size:9px;font-weight:600;white-space:nowrap">'+m.l+'</span>';
}

// Milestone cells (shared by ghost and shadow)
const ADV=['-1.0','-0.9','-0.8','-0.7','-0.6','-0.5','-0.4','-0.3','-0.2','-0.1'];
const FAV=['+0.1','+0.2','+0.3','+0.4','+0.5','+0.6','+0.7','+0.8','+0.9','+1.0','+1.1','+1.2','+1.3','+1.4','+1.5','+1.6','+1.7','+1.8','+1.9','+2.0'];
function msCells(ms){
  ms=ms||{};
  let h='';
  for(const k of ADV){
    const v=ms[k];
    h+=v!=null?'<td class="adv-hit" style="min-width:28px;text-align:center;padding:2px 1px"><span style="color:#f85149;font-size:8px;font-weight:600">'+v+'</span></td>'
             :'<td class="adv-th" style="min-width:28px;text-align:center;padding:2px 1px;opacity:.2;font-size:7px">\.</td>';
  }
  for(const k of FAV){
    const v=ms[k];
    h+=v!=null?'<td class="fav-hit" style="min-width:28px;text-align:center;padding:2px 1px"><span style="color:#3fb950;font-size:8px;font-weight:600">'+v+'</span></td>'
             :'<td class="fav-th" style="min-width:28px;text-align:center;padding:2px 1px;opacity:.2;font-size:7px">\.</td>';
  }
  return h;
}

// ==============================================
// API helper
// ==============================================
async function api(url){
  try{
    const r=await fetch(url);
    if(!r.ok) return null;
    return await r.json();
  }catch(e){return null;}
}

// ==============================================
// CLOCK
// ==============================================
function updateClock(){
  const now=new Date();
  const s=now.toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const h=parseInt(now.toLocaleString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',hour12:false}));
  const isNY=(h>=18&&h<21),isLD=(h>=8&&h<15)||( h===15&&now.getMinutes()<30);
  const sess=isNY?'NEW YORK':isLD?'LONDON':'ASIA/CLOSED';
  const sessEl=$('h-sess');const dotEl=$('h-sess-dot');
  if(sessEl)sessEl.textContent=sess;
  if(dotEl)dotEl.className=isNY||isLD?'dot-g':'dot-r';
  const t=$('h-time');if(t)t.textContent=s;
}
setInterval(updateClock,1000);updateClock();

// ==============================================
// OVERVIEW
// ==============================================
async function loadOverview(){
  const [pos,perf,trades,daily] = await Promise.all([
    api('/api/open-positions').catch(()=>[]),
    api('/api/performance').catch(()=>({})),
    api('/api/trades').catch(()=>[]),
    api('/api/daily-breakdown').catch(()=>({days:[]})),
  ]);

  // --- Balance ---
  if(perf){
    const _cs=perf.currency==='EUR'?'EUR':perf.currency==='USD'?'$':'EUR';
    const s=perf.startBalance||50000;
    const rp=perf.realizedPnl||perf.totalPnl||0;
    const up=perf.unrealizedPnl||0;
    const cash=s+rp;
    const eq=cash+up;
    const f=v=>Math.round(v).toLocaleString('nl-BE');
    if($('ov-startbal'))$('ov-startbal').textContent='EUR'+f(s);
    if($('ov-realbal')){$('ov-realbal').textContent=(rp>=0?'+':'')+'EUR'+f(Math.abs(rp));$('ov-realbal').className='blv '+(rp>=0?'cg':'cr');}
    if($('ov-cashbal'))$('ov-cashbal').textContent='EUR'+f(cash);
    if($('ov-upnl')){$('ov-upnl').textContent=(up>=0?'+':'')+'EUR'+f(Math.abs(up));$('ov-upnl').className='blv '+(up>=0?'cg':'cr');}
    if($('ov-equity'))$('ov-equity').textContent='EUR'+f(eq);
    if($('ov-equitycheck'))$('ov-equitycheck').textContent='EUR'+f(s)+' + EUR'+f(rp)+' + '+(up>=0?'+':'')+f(up)+' = EUR'+f(eq)+' \OK';
    if($('ov-tradecount'))$('ov-tradecount').textContent=(perf.tradeCount||0)+' closed';
    if($('ov-opencount'))$('ov-opencount').textContent=(pos||[]).length+' open';
  }

  // --- Open Positions ---
  const _pos=pos||[];
  let wins=0,loss=0,bestP=null,worstP=null,maxRR=null,totLots=0;
  _pos.forEach(p=>{
    const up=p.unrealizedPnl||p.liveProfitMT5||0;
    if(up>0)wins++;else if(up<0)loss++;
    const g=p.ghost||{};
    const peakP=g.peakRRPos||p.peakRRPos||0;
    if(bestP===null||peakP>bestP)bestP=peakP;
    const peakN=g.peakRRNeg||p.peakRRNeg||0;
    const pr=peakN>0?-(peakN/100):null;
    if(pr!=null&&(worstP===null||pr<worstP))worstP=pr;
    if(g.tpRRUsed!=null&&(maxRR===null||g.tpRRUsed>maxRR))maxRR=g.tpRRUsed;
    totLots+=p.lots||0;
  });
  const wr=_pos.length?((wins/_pos.length)*100).toFixed(1)+'%':'\--';
  if($('ov-open'))$('ov-open').textContent=_pos.length;
  if($('ov-wins'))$('ov-wins').textContent=wins;
  if($('ov-loss'))$('ov-loss').textContent=loss;
  if($('ov-wr')){$('ov-wr').textContent=wr;$('ov-wr').className='ksv '+(_pos.length&&wins/_pos.length>=0.6?'cg':'cy');}
  if($('ov-bestpeak'))$('ov-bestpeak').textContent=bestP!=null?fmtR(bestP):'\--';
  if($('ov-worstpeak'))$('ov-worstpeak').textContent=worstP!=null?fmtR(worstP):'\--';
  if($('ov-maxrr'))$('ov-maxrr').textContent=maxRR!=null?'+'+maxRR.toFixed(2)+'R':'\--';
  if($('ov-upnl2')){const u=perf?.unrealizedPnl||0;$('ov-upnl2').textContent=(u>=0?'+':'')+Math.round(u)+'EUR';$('ov-upnl2').className='ksv '+(u>=0?'cg':'cr');}
  if($('ov-open-cm'))$('ov-open-cm').textContent=_pos.length+' positions';

  // --- Open positions table ---
  const ob=$('ov-open-body');
  if(ob){
    if(!_pos.length){ob.innerHTML=nd(22,'No open positions');}
    else{
      ob.innerHTML=_pos.map(p=>{
        const g=p.ghost||{};
        const sl=parseFloat(p.sl)||0;
        const en=parseFloat(p.entry)||0;
        const cur=parseFloat(p.currentPrice||p.entry)||0;
        const slD=Math.abs(en-sl);
        const rrNow=slD>0?(((p.direction||'').toUpperCase()==='BUY'?(cur-en):(en-cur))/slD):null;
        const peakP=g.peakRRPos||p.peakRRPos||0;
        const peakN=g.peakRRNeg||p.peakRRNeg||0;
        const pr=peakN>0?-(peakN/100):null;
        const isLive=(g.phantomSLHit||g.phantom_sl_hit)?'<span class="bd bd-slhit">SL HIT</span>':'<span class="bd bd-live">\* LIVE</span>';
        const rp=parseFloat(p.riskPct||0);
        const re=parseFloat(p.riskEUR||0);
        return '<tr>'+
          '<td>'+isLive+'</td>'+
          '<td class="cw fw">'+( p.symbol||'\--')+'</td>'+
          '<td>'+bdType(p.assetType||p.type,p.symbol)+'</td>'+
          '<td>'+bdDir(p.direction)+'</td>'+
          '<td>'+bdVwap(p.vwapPosition||p.vwap_position)+'</td>'+
          '<td>'+bdSess(p.session)+'</td>'+
          '<td class="cd">'+( (()=>{ if(rp>0&&rp<0.1)return fmtPct(rp); if(re>0)return ((re/50000)*100).toFixed(4)+'%'; return '\--'; })())+'</td>'+
          '<td class="cr">'+( re>0?'EUR'+re.toFixed(0):'\--')+'</td>'+
          '<td class="cd">'+fmt(en,5)+'</td>'+
          '<td class="cr">'+fmt(sl,5)+'</td>'+
          '<td class="cg">'+fmt(p.tp,5)+'</td>'+
          '<td class="'+cRR(rrNow)+' fw">'+fmtR(rrNow)+'</td>'+
          '<td class="'+(peakP>0?'cg fw':'cd')+' fw">'+( peakP>0?'+'+peakP.toFixed(2)+'R':'\--')+'</td>'+
          '<td class="'+(pr!=null&&pr<-0.5?'cr fw':pr!=null&&pr<0?'cr':'cd')+' fw">'+( pr!=null?fmtR(pr):'\--')+'</td>'+
          '<td class="cg">+'+( g.tpRRUsed||1.5).toFixed(2)+'R</td>'+
          '<td class="'+(p.vwapBandPct>150?'co fw':p.vwapBandPct>100?'co':'cd')+'">'+(p.vwapBandPct!=null?fmtP(p.vwapBandPct):(g.vwapBandPct!=null?fmtP(g.vwapBandPct):'\--'))+'</td>'+
          '<td class="cd" style="font-size:8px">'+( p.sessionHigh!=null?fmt(p.sessionHigh,3):'\--')+'</td>'+
          '<td class="cd" style="font-size:8px">'+( p.sessionLow!=null?fmt(p.sessionLow,3):'\--')+'</td>'+
          '<td>'+bdKey(p.tradeNumber)+'</td>'+
          '<td class="cb2">'+fmt(cur,5)+'</td>'+
          '<td class="'+(p.unrealizedPnl>=0?'cg':'cr')+' fw">'+fmtE(p.unrealizedPnl)+'</td>'+
          '<td class="cd">'+( p.lots!=null?p.lots.toFixed(2):'\--')+'</td>'+
          '<td class="cd" style="font-size:8px;max-width:120px">'+( p.mt5Comment||p.orderComment||'\--')+'</td>'+
          '<td class="cd" style="font-size:9px">'+fmtTs(p.openedAt)+'</td>'+
        '</tr>';
      }).join('');
    }
  }

  // --- Daily log ---
  const dEl=$('ov-daily');
  if(dEl){
    const days=(daily?.days)||[];
    let _rows=days;
    if(!_rows.length&&_pos.length){
      const _wCount=_pos.filter(p=>(p.unrealizedPnl||0)>0).length;
      const _lCount=_pos.filter(p=>(p.unrealizedPnl||0)<0).length;
      const _today=new Date().toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit'});
      _rows=[{date:_today,total:_pos.length,wins:_wCount,losses:_lCount,
        peakRRPos:bestP,peakRRNeg:worstP!=null?Math.abs(worstP)*100:null,
        lots:totLots,pnl:perf?.unrealizedPnl||0}];
    }
    if(!_rows.length){dEl.innerHTML=nd(12,'No closed trades yet');}
    else{
      dEl.innerHTML=_rows.slice(0,30).map(d=>{
        const wr2=d.total?((d.wins/d.total)*100).toFixed(0)+'%':'\--';
        const wN=d.peakRRNeg!=null?-(d.peakRRNeg/100):null;
        return '<tr>'+
          '<td class="cw fw">'+(d.date||'\--')+'</td>'+
          '<td class="cb">'+( d.total||0)+'</td>'+
          '<td class="cg">'+( d.wins||0)+'</td>'+
          '<td class="cr">'+( d.losses||0)+'</td>'+
          '<td class="'+(d.total&&d.wins/d.total>=0.6?'cg fw':'cy')+'">'+wr2+'</td>'+
          '<td class="'+(d.peakRRPos>1?'cg fw':'cg')+'">'+( d.peakRRPos!=null?fmtR(d.peakRRPos):'\--')+'</td>'+
          '<td class="cd" style="font-size:9px">'+( d.peakPosTime||'\--')+'</td>'+
          '<td class="'+(wN!=null&&wN<-0.5?'cr fw':'cr')+'">'+( wN!=null?fmtR(wN):'\--')+'</td>'+
          '<td class="cd" style="font-size:9px">'+( d.peakNegTime||'\--')+'</td>'+
          '<td class="'+(d.maxDD!=null&&d.maxDD>-50?'cr fw':'cr')+'">'+( d.maxDD!=null?fmtP(d.maxDD):'\--')+'</td>'+
          '<td class="cd">'+( d.lots!=null?d.lots.toFixed(2):'\--')+'</td>'+
          '<td class="'+cE(d.pnl)+' fw">'+fmtE(d.pnl)+'</td>'+
        '</tr>';
      }).join('');
    }
  }

  // --- Closed trades ---
  const tb=$('ov-trades');
  // Fix 10: Draw equity curve chart
  (async () => {
    try {
      const eq = await api('/api/equity-curve').catch(()=>[]);
      const canvas = $('equity-chart');
      if (!canvas || !eq || !eq.length) return;
      const ctx = canvas.getContext('2d');
      const W = canvas.offsetWidth || canvas.parentElement.offsetWidth || 400;
      canvas.width = W * window.devicePixelRatio;
      canvas.height = 80 * window.devicePixelRatio;
      canvas.style.width = W + 'px';
      canvas.style.height = '80px';
      const s = window.devicePixelRatio;
      ctx.scale(s, s);
      const h = 80, pad = 6;
      // Filter to last 100 points sorted by time
      const pts = [...eq].sort((a,b)=>new Date(a.ts||a.recorded_at||a.created_at)-new Date(b.ts||b.recorded_at||b.created_at)).slice(-100);
      if (pts.length < 2) return;
      const vals = pts.map(p => parseFloat(p.equity ?? p.balance ?? 0));
      const minV = Math.min(...vals), maxV = Math.max(...vals);
      const range = maxV - minV || 1;
      const xs = i => pad + (i / (pts.length-1)) * (W - pad*2);
      const ys = v => h - pad - ((v - minV) / range) * (h - pad*2);
      // Fill gradient
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      const isUp = vals[vals.length-1] >= vals[0];
      grad.addColorStop(0, isUp ? 'rgba(63,185,80,.25)' : 'rgba(248,81,73,.15)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.moveTo(xs(0), ys(vals[0]));
      for (let i=1; i<vals.length; i++) ctx.lineTo(xs(i), ys(vals[i]));
      ctx.lineTo(xs(vals.length-1), h); ctx.lineTo(xs(0), h);
      ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      // Line
      ctx.beginPath();
      ctx.moveTo(xs(0), ys(vals[0]));
      for (let i=1; i<vals.length; i++) ctx.lineTo(xs(i), ys(vals[i]));
      ctx.strokeStyle = isUp ? '#3fb950' : '#f85149';
      ctx.lineWidth = 1.5; ctx.stroke();
      // Start/end markers
      const start = vals[0], end = vals[vals.length-1];
      const diff = end - start;
      if ($('eq-stats')) $('eq-stats').textContent = 'EUR'+Math.round(start).toLocaleString('nl-BE')+' -> EUR'+Math.round(end).toLocaleString('nl-BE')+' ('+(diff>=0?'+':'')+Math.round(diff)+'EUR)';
    } catch(e) {}
  })();

  const trList=Array.isArray(trades)?trades:[];
  if($('ov-trades-cm'))$('ov-trades-cm').textContent=trList.length+' trades';
  if(tb){
    if(!trList.length){tb.innerHTML=nd(18,'No closed trades');}
    else{
      tb.innerHTML=trList.slice(0,500).map(t=>{
        const gr=t.ghostStopReason||t.ghost_stop_reason||'';
        const cr=t.closeReason||t.close_reason||'sl';
        const pnl=t.realizedPnlEUR||t.realizedPnl||t.realized_pnl_eur||null;
        const stopCell=gr==='tp_hit'||gr==='tp'||cr==='tp'?bdStop('tp'):
                        gr==='sl'||gr==='phantom_sl'||gr==='gap_stop'||cr==='sl'?bdStop(gr||cr):
                        !t.closedAt?'<span class="bd bd-live">\* Live</span>':bdStop('sl');
        return '<tr>'+
          '<td>'+stopCell+'</td>'+
          '<td class="cw fw">'+( t.symbol||'\--')+'</td>'+
          '<td>'+bdType(t.assetType||t.asset_type,t.symbol)+'</td>'+
          '<td>'+bdDir(t.direction)+'</td>'+
          '<td>'+bdVwap(t.vwapPosition||t.vwap_position)+'</td>'+
          '<td>'+bdSess(t.session)+'</td>'+
          '<td class="cd">'+fmt(t.entry,5)+'</td>'+
          '<td class="cr">'+fmt(t.sl,5)+'</td>'+
          '<td class="cg">'+fmt(t.tp,5)+'</td>'+
          '<td class="cy">'+fmt(t.exitPrice||t.exit_price,5)+'</td>'+
          '<td class="cd">'+( (()=>{ const rp=t.riskPct||t.risk_pct||null; const re=t.riskEUR||t.risk_eur||null; if(rp!=null&&rp<0.1) return fmtPct(rp); if(re!=null) return ((re/50000)*100).toFixed(4)+'%'; return '\--'; })())+'</td>'+
          '<td class="cr">'+( t.riskEUR!=null?'EUR'+t.riskEUR.toFixed(0):'\--')+'</td>'+
          '<td class="'+( (()=>{ if(pnl!=null&&pnl!==0)return cE(pnl); const re=t.riskEUR||t.risk_eur||null; return re?'cr':'cd'; })())+' fw">'+( (()=>{ if(pnl!=null&&pnl!==0)return fmtE(pnl); const stop=gr||cr||''; const re=t.riskEUR||t.risk_eur||null; if(re!=null&&(stop.includes('sl')||stop.includes('SL')||stop==='gap_stop'))return '\~'+fmtE(-re); return pnl!=null?fmtE(pnl):'\--'; })())+'</td>'+
          '<td class="cd">'+( t.lots!=null?Number(t.lots).toFixed(2):'\--')+'</td>'+
          '<td class="'+(( t.peakRRPos||t.peak_rr_pos||0)>0?'cg fw':'cd')+'">'+((t.peakRRPos||t.peak_rr_pos||0)>0?'+'+Number(t.peakRRPos||t.peak_rr_pos).toFixed(2)+'R':'\--')+'</td>'+
          '<td class="'+(( t.peakRRNeg||t.peak_rr_neg||0)>0?'cr fw':'cd')+'">'+((t.peakRRNeg||t.peak_rr_neg||0)>0?fmtR(-(t.peakRRNeg||t.peak_rr_neg)/100):'\--')+'</td>'+
          '<td>'+bdStop(gr||cr)+'</td>'+
          '<td class="cd" style="font-size:8px;max-width:120px">'+( t.mt5Comment||t.mt5_comment||'\--')+'</td>'+
          '<td class="cd" style="font-size:9px">'+fmtTs(t.openedAt||t.opened_at)+'</td>'+
          '<td class="cd" style="font-size:9px">'+fmtTs(t.closedAt||t.closed_at)+'</td>'+
        '</tr>';
      }).join('');
    }
  }
}

// ==============================================
// SIGNALS
// ==============================================
async function loadSignals(){
  const [stats,log,errs] = await Promise.all([
    api('/api/signal-stats').catch(()=>({})),
    api('/api/signal-log').catch(()=>[]),
    api('/api/signal-rejects').catch(()=>[]),
  ]);

  // KPIs
  const by=(stats?.byOutcome||[]).reduce((a,o)=>{a[o.outcome]=(o.count||0);return a;},{});
  const total=(stats?.total||0);
  const placed=by['PLACED']||0;
  const conv=total>0?((placed/total)*100).toFixed(1)+'%':'\--';
  const shadow=(by['NY_DEAD_ZONE']||0)+(by['NY_NIGHT']||0)+(by['ASIA_MORNING']||0)+(by['VWAP_EXHAUSTION']||0)+(by['DUPLICATE_POSITION']||0);
  const realErrors=(stats?.byOutcome||[]).filter(o=>['ERROR','ORDER_NOT_CONFIRMED','TIMEOUT'].includes(o.outcome)).reduce((s,o)=>s+(o.count||0),0);

  const f=(id,v)=>{const e=$(id);if(e)e.textContent=v;};
  f('sg-total',total);f('sg-placed',placed);f('sg-conv',conv);f('sg-shadow',shadow);
  f('sg-ny-dead',by['NY_DEAD_ZONE']||0);f('sg-ny-night',by['NY_NIGHT']||0);
  f('sg-asia',by['ASIA_MORNING']||0);f('sg-vwap',by['VWAP_EXHAUSTION']||0);
  f('sg-dup',by['DUPLICATE_POSITION']||0);f('sg-ooh',by['STOCK_OOH']||0);
  f('sg-err',realErrors);
  if($('nb-sig'))$('nb-sig').textContent=total;

  // Signal log
  const sl=$('sig-log');
  const signals=Array.isArray(log)?log:[];
  if(sl){
    if(!signals.length){sl.innerHTML=nd(16,'No signals yet');}
    else{
      // Filter: exclude STK_OOH from signal log (market closed, not tradeable)
    const filteredSigs=signals.filter(s=>s.outcome!=='STOCK_OOH'&&s.outcome!=='WEEKEND');
    sl.innerHTML=filteredSigs.slice(0,500).map(s=>{
        const outcome=s.outcome||'?';
        const isPlaced=outcome==='PLACED';
        const isRej=outcome==='REJECTED'||outcome==='ERROR';
        const isOoh=outcome==='STOCK_OOH'||outcome==='WEEKEND';
        const isDup=outcome==='DUPLICATE_POSITION';
        const rowCls=isPlaced?'row-placed':isRej?'row-rej':isOoh?'row-ooh':isDup?'row-dup':'';
        const _dir2=(s.direction||'').toUpperCase()==='BUY'?'B':'S';
        const _vm={ny:'NY',london:'LD',asia:'AS'};
        const _ss=_vm[(s.session||'ny').toLowerCase()]||'NY';
        const _vp=(s.vwapPosition||s.vwap_position||'').toUpperCase()==='ABOVE'?'ABV':'BLW';
        const _whatif=s.symbol?s.symbol.slice(0,7)+' '+_dir2+'-'+_ss+'-'+_vp:'\--';
        const pid=s.positionId||s.position_id;
        // Determine destination label
        let destCell;
        if(pid){
          const _mt5c=s.orderComment||s.mt5_comment||_whatif;
          destCell='<span style="background:rgba(63,185,80,.15);color:#3fb950;padding:1px 6px;border-radius:3px;font-size:9px;border:1px solid rgba(63,185,80,.3);font-weight:700">-> Ghost #'+(s.tradeNumber||pid.slice(-4))+'</span> <span style="color:#6e7681;font-size:8px">'+_mt5c+'</span>';
        } else if(outcome==='NY_DEAD_ZONE'||outcome==='NY_NIGHT'||outcome==='ASIA_MORNING'){
          destCell='<span style="background:rgba(240,136,62,.15);color:#f0883e;padding:1px 6px;border-radius:3px;font-size:9px;border:1px solid rgba(240,136,62,.3);font-weight:700">-> Shadow TZ</span>';
        } else if(outcome==='VWAP_EXHAUSTION'){
          destCell='<span style="background:rgba(188,140,255,.15);color:#bc8cff;padding:1px 6px;border-radius:3px;font-size:9px;border:1px solid rgba(188,140,255,.3);font-weight:700">-> Shadow VWAP</span>';
        } else if(outcome==='DUPLICATE_POSITION'){
          destCell='<span style="background:rgba(210,153,34,.15);color:#d29922;padding:1px 6px;border-radius:3px;font-size:9px;border:1px solid rgba(210,153,34,.3);font-weight:700">-> Shadow DUP</span>';
        } else if(isOoh){
          destCell='<span class="cd" style="font-size:9px">'+_whatif+' (OOH)</span>';
        } else {
          destCell=outcomeBdg(outcome);
        }
        // Raw webhook expandable
        const rawId='raw-'+Math.random().toString(36).slice(2,8);
        return '<tr class="'+rowCls+'">'+
          '<td class="cd" style="font-size:9px;white-space:nowrap">'+fmtT(s.ts||s.receivedAt||s.received_at)+'</td>'+
          '<td class="cw fw">'+( s.symbol||'\--')+'</td>'+
          '<td>'+bdType(s.assetType||s.asset_type,s.symbol)+'</td>'+
          '<td>'+bdDir(s.direction)+'</td>'+
          '<td style="white-space:nowrap">'+bdSess(s.session)+'</td>'+
          '<td>'+bdVwap(s.vwapPosition||s.vwap_position)+'</td>'+
          '<td class="cd" style="font-size:9px">'+fmt(s.entry||s.tvEntry||s.tv_entry,5)+'</td>'+
          '<td class="'+(s.band_pct>150?'co fw':s.band_pct>100?'co':'cd')+'">'+( s.band_pct!=null?fmtP(s.band_pct):'\--')+'</td>'+
          '<td class="cd" style="font-size:8px">'+( s.session_high!=null?fmt(s.session_high,3):'\--')+'</td>'+
          '<td class="cd" style="font-size:8px">'+( s.session_low!=null?fmt(s.session_low,3):'\--')+'</td>'+
          '<td class="'+(s.bull_breaks>=8?'cg fw':'cd')+'">'+( s.bull_breaks!=null?s.bull_breaks:'\--')+'</td>'+
          '<td>'+bdKey(s.optimizer_key?.split('_').pop()||1)+'</td>'+
          '<td>'+outcomeBdg(outcome)+'</td>'+
          '<td>'+destCell+'</td>'+
          '<td class="cd" style="font-size:9px">'+( s.latency_ms!=null?s.latency_ms+'ms':'\--')+'</td>'+
          '<td></td>'+
        '</tr>';
      }).join('');
    }
  }

  // Error table
  const errBody=$('sig-err-body');
  const errList=Array.isArray(errs)?errs:[];
  if(errBody){
    if(!errList.length){errBody.innerHTML=nd(6,'No errors');}
    else{
      errBody.innerHTML=errList.slice(0,50).map(e=>{
        return '<tr>'+
          '<td class="cd" style="font-size:9px">'+fmtTs(e.ts||e.receivedAt)+'</td>'+
          '<td class="cw fw">'+( e.symbol||'\--')+'</td>'+
          '<td>'+bdDir(e.direction)+'</td>'+
          '<td class="cr">'+( e.outcome||e.error_type||'ERROR')+'</td>'+
          '<td class="cd" style="font-size:9px">'+( e.reason||e.rejectReason||e.detail||'\--')+'</td>'+
          '<td class="cd">'+( e.retried!=null?e.retried:'\--')+'</td>'+
        '</tr>';
      }).join('');
    }
  }
}

// ==============================================
// GHOST TRACKER
// ==============================================
async function loadGhost(){
  const [pos,ghostFin] = await Promise.all([
    api('/api/open-positions').catch(()=>[]),
    api('/api/ghost-trades').catch(()=>[]),
  ]);

  const _pos=Array.isArray(pos)?pos:[];
  const fin=Array.isArray(ghostFin)?ghostFin.filter(g=>g.stopReason||g.stop_reason||g.closedAt||g.closed_at):[];

  // KPIs
  let buyCnt=0,sellCnt=0,sumP=0,bestP=null,slToday=0,tpCnt=0;
  _pos.forEach(g=>{
    if((g.direction||'').toUpperCase()==='BUY')buyCnt++;else sellCnt++;
    const pk=g.ghost?.peakRRPos||g.peakRRPos||0;
    sumP+=pk;
    if(bestP===null||pk>bestP)bestP=pk;
    if(g.ghost?.phantomSLHit||g.ghost?.phantom_sl_hit)slToday++;
    const tp=g.ghost?.tpRRUsed||1.5;
    if(pk>=tp)tpCnt++;
  });
  const avgP=_pos.length?sumP/_pos.length:0;
  const f2=(id,v,cls)=>{const e=$(id);if(!e)return;e.textContent=v;if(cls)e.className='ksv '+cls;};
  f2('gh-active-cnt',_pos.length,'');
  f2('gh-sl-today',slToday,'cr'+(slToday>0?' fw':''));
  f2('gh-best-peak',bestP!=null?fmtR(bestP):'\--','cg fw');
  f2('gh-avg-peak',_pos.length?fmtR(avgP):'\--','cy');
  f2('gh-buy',buyCnt,'cg');f2('gh-sell',sellCnt,'cr');
  f2('gh-tp-est',tpCnt,'cy');f2('gh-fin-cnt',fin.length,'cb2');
  if($('nb-gh'))$('nb-gh').textContent=_pos.length;

  // Active ghost table
  const ab=$('gh-active-body');
  const MS_COLS=30;
  if(ab){
    if(!_pos.length){ab.innerHTML=nd(12+MS_COLS+6,'No active ghosts');}
    else{
      ab.innerHTML=_pos.map(p=>{
        const g=p.ghost||{};
        const sl=parseFloat(p.sl)||0;
        const en=parseFloat(p.entry)||0;
        const cur=parseFloat(p.currentPrice||p.entry)||0;
        const slD=Math.abs(en-sl);
        const rrNow=slD>0?(((p.direction||'').toUpperCase()==='BUY'?(cur-en):(en-cur))/slD):null;
        const peakP=g.peakRRPos||p.peakRRPos||0;
        const peakN=g.peakRRNeg||p.peakRRNeg||0;
        const prR=peakN>0?-(peakN/100):null;
        const isLive=(g.phantomSLHit||g.phantom_sl_hit)?'<span class="bd bd-slhit">SL HIT</span>':'<span class="bd bd-live">\* LIVE</span>';
        // Milestones
        const openTs=p.openedAt||g.openedAt?new Date(p.openedAt||g.openedAt).getTime():null;
        const slMs=g.slMilestones||g.sl_milestones||{};
        const rrMs=g.rrMilestones||g.rr_milestones||{};
        const allMs={};
        for(const k in slMs)allMs[k]=fmtMs(slMs[k],openTs);
        for(const k in rrMs)allMs[k]=fmtMs(rrMs[k],openTs);
        return '<tr class="'+(g.phantomSLHit?'sl-row':'')+'">'+
          '<td>'+isLive+'</td>'+
          '<td class="cw fw" style="white-space:nowrap">'+( p.symbol||'\--')+'</td>'+
          '<td style="font-size:8px;color:#8b949e;max-width:110px;overflow:hidden;white-space:nowrap" title="'+( p.mt5Comment||p.orderComment||'')+'">'+( p.mt5Comment||p.orderComment||'\--')+'</td>'+
          '<td>'+bdType(p.assetType||p.type,p.symbol)+'</td>'+
          '<td>'+bdDir(p.direction)+'</td>'+
          '<td>'+bdVwap(p.vwapPosition||p.vwap_position)+'</td>'+
          '<td style="white-space:nowrap">'+bdSess(p.session)+'</td>'+
          '<td>'+bdKey(p.keyCount||g.keyCount||p.tradeNumber||1)+'</td>'+
          '<td class="'+cRR(rrNow)+' fw">'+fmtR(rrNow)+'</td>'+
          '<td class="'+(peakP>0?'cg fw':'cd')+'">'+( peakP>0?'+'+peakP.toFixed(2)+'R':'\--')+'</td>'+
          '<td class="'+(prR!=null&&prR<-0.5?'cr fw':prR!=null?'cr':'cd')+'">'+( prR!=null?fmtR(prR):'\--')+'</td>'+
          '<td class="cg fw">+'+( g.tpRRUsed||1.5).toFixed(2)+'R</td>'+
          '<td class="'+(( g.vwapBandPct||p.vwapBandPct||0)>150?'co fw':(g.vwapBandPct||p.vwapBandPct||0)>100?'co':'cd')+'">'+((g.vwapBandPct||p.vwapBandPct)!=null?fmtP(g.vwapBandPct||p.vwapBandPct):'\--')+'</td>'+
          '<td class="cd" style="font-size:8px">'+( p.sessionHigh!=null?fmt(p.sessionHigh,3):'\--')+'</td>'+
          '<td class="cd" style="font-size:8px">'+( p.sessionLow!=null?fmt(p.sessionLow,3):'\--')+'</td>'+
          msCells(allMs)+
          '<td class="cd" style="font-size:8px">'+fmt(p.tvEntry||g.tvEntry,5)+'</td>'+
          '<td class="cd" style="font-size:8px">'+fmt(en,5)+'</td>'+
          '<td class="cr" style="font-size:8px">'+fmt(sl,5)+'</td>'+
          '<td class="cg" style="font-size:8px">'+fmt(p.tp,5)+'</td>'+
          '<td class="'+(p.unrealizedPnl>=0?'cg':'cr')+' fw">'+fmtE(p.unrealizedPnl)+'</td>'+
          '<td class="cd">'+( p.lots!=null?p.lots.toFixed(2):'\--')+'</td>'+
          '<td class="cd" style="font-size:9px">'+fmtTs(p.openedAt||g.openedAt)+'</td>'+
        '</tr>';
      }).join('');
    }
  }

  // Finalized ghost table
  const fb=$('gh-fin-body');
  if(fb){
    if(!fin.length){fb.innerHTML=nd(17+MS_COLS,'No finalized ghosts yet \-- waiting for positions to close');}
    else{
      fb.innerHTML=fin.slice(0,500).map((g,i)=>{
        const openTs=g.openedAt||g.opened_at?new Date(g.openedAt||g.opened_at).getTime():null;
        const slMs=g.slMilestones||g.sl_milestones||{};
        const rrMs=g.rrMilestones||g.rr_milestones||{};
        const allMs={};
        for(const k in slMs)allMs[k]=fmtMs(slMs[k],openTs);
        for(const k in rrMs)allMs[k]=fmtMs(rrMs[k],openTs);
        const pnl=g.realizedPnlEUR||g.realized_pnl_eur||null;
        const peakP=g.peakRRPos||g.peak_rr_pos||0;
        const peakN=g.peakRRNeg||g.peak_rr_neg||0;
        const prR=peakN>0?-(peakN/100):null;
        return '<tr>'+
          '<td class="cd">'+( i+1)+'</td>'+
          '<td class="cw fw">'+( g.symbol||'\--')+'</td>'+
          '<td>'+bdType(g.assetType||g.type,g.symbol)+'</td>'+
          '<td>'+bdSess(g.session)+'</td>'+
          '<td>'+bdDir(g.direction)+'</td>'+
          '<td>'+bdVwap(g.vwapPosition||g.vwap_position)+'</td>'+
          '<td>'+bdStop(g.stopReason||g.stop_reason)+'</td>'+
          '<td class="cg">+'+( g.tpRRUsed||g.tp_rr_used||1.5).toFixed(2)+'R</td>'+
          '<td class="'+(peakP>0?'cg fw':'cd')+'">'+( peakP>0?'+'+peakP.toFixed(2)+'R':'\--')+'</td>'+
          '<td class="'+(prR!=null&&prR<-0.5?'cr fw':'cr')+'">'+( prR!=null?fmtR(prR):'\--')+'</td>'+
          '<td class="'+(g.vwapBandPct>150?'co fw':'cd')+'">'+( g.vwapBandPct!=null?fmtP(g.vwapBandPct):'\--')+'</td>'+
          '<td>'+bdKey(g.keyCount||1)+'</td>'+
          '<td class="'+cE(pnl)+' fw">'+( pnl!=null?fmtE(pnl):'\--')+'</td>'+
          '<td class="cd">'+( g.lots!=null?Number(g.lots).toFixed(2):'\--')+'</td>'+
          '<td class="cd" style="font-size:8px;max-width:110px">'+( g.mt5Comment||g.mt5_comment||'\--')+'</td>'+
          '<td class="cd" style="font-size:9px">'+( g.optimizerKey||g.optimizer_key||'\--')+'</td>'+
          msCells(allMs)+
          '<td class="cd" style="font-size:9px">'+fmtTs(g.openedAt||g.opened_at)+'</td>'+
          '<td class="cd">'+fmtEl(g.openedAt||g.opened_at,g.closedAt||g.closed_at)+'</td>'+
        '</tr>';
      }).join('');
    }
  }
}

// ==============================================
// SHADOW TRACKER
// ==============================================
async function loadShadow(){
  const [active,history] = await Promise.all([
    api('/api/blocked-ghosts/active').catch(()=>[]),
    api('/api/blocked-ghosts/history').catch(()=>[]),
  ]);

  const _active=Array.isArray(active)?active:[];
  if($('nb-sh'))$('nb-sh').textContent=_active.length;

  function shadowRow(b,showStop){
    const openTs=b.openedAt||b.opened_at?new Date(b.openedAt||b.opened_at).getTime():null;
    const slMs=b.slMilestones||b.sl_milestones||{};
    const rrMs=b.rrMilestones||b.rr_milestones||{};
    const allMs={};
    for(const k in slMs)allMs[k]=fmtMs(slMs[k],openTs);
    for(const k in rrMs)allMs[k]=fmtMs(rrMs[k],openTs);
    const peakP=b.peakRRPos||b.peak_rr_pos||0;
    const peakN=b.peakRRNeg||b.peak_rr_neg||0;
    const prR=peakN>0?-(peakN/100):null;
    const sessOrStop=showStop?bdStop(b.stopReason||b.stop_reason||'sl'):bdSess(b.session||b.sub_session||'ny');
    return '<tr>'+
      '<td>'+bdBlock(b.blockType||b.block_type)+'</td>'+
      '<td class="cw fw">'+( b.symbol||'\--')+'</td>'+
      '<td>'+bdType(b.assetType||b.type,b.symbol)+'</td>'+
      '<td>'+bdKey(b.keyCount||b.key_count||1)+'</td>'+
      '<td>'+bdDir(b.direction)+'</td>'+
      '<td>'+bdVwap(b.vwapPosition||b.vwap_position)+'</td>'+
      '<td>'+sessOrStop+'</td>'+
      '<td class="'+(peakP>0?'cg fw':'cd')+'">'+( peakP>0?fmtR(peakP):'\--')+'</td>'+
      '<td class="'+(prR!=null&&prR<-0.5?'cr fw':prR!=null?'cr':'cd')+'">'+( prR!=null?fmtR(prR):'\--')+'</td>'+
      '<td class="'+(b.vwapBandPct>150?'co fw':b.vwapBandPct>100?'co':'cd')+'">'+( b.vwapBandPct!=null?fmtP(b.vwapBandPct):'\--')+'</td>'+
      msCells(allMs)+
      '<td class="cd" style="font-size:8px">'+fmt(b.entry,5)+'</td>'+
      '<td class="cd" style="font-size:9px">'+fmtTs(b.openedAt||b.opened_at)+'</td>'+
      '<td class="cd">'+fmtEl(b.openedAt||b.opened_at,b.finalizedAt||b.finalized_at)+'</td>'+
    '</tr>';
  }

  function render(bodyId,list,cols,emptyMsg){
    const el2=$(bodyId);
    if(!el2)return;
    if(!list.length){el2.innerHTML=nd(cols,emptyMsg);}
    else el2.innerHTML=list.map(b=>shadowRow(b,bodyId==='sh-fin-body')).filter(Boolean).join('');
  }

  // Filter by type
  const isTZ=b=>{const bt=(b.blockType||b.block_type||'').toUpperCase();return bt.includes('NY_DEAD')||bt.includes('NY_NIGHT')||bt.includes('ASIA')||bt.includes('TIMEZONE')||bt.includes('OUTSIDE');};
  const isVW=b=>{const bt=(b.blockType||b.block_type||'').toUpperCase();return bt.includes('VWAP');};
  const isDU=b=>{const bt=(b.blockType||b.block_type||'').toUpperCase();return bt.includes('DUPLICATE');};

  const tz=_active.filter(isTZ);
  const vw=_active.filter(isVW);
  const du=_active.filter(isDU);
  const hist=Array.isArray(history)?history:[];
  const MS_COLS=30;

  render('sh-tz-body',  tz,   10+MS_COLS+3, 'No timezone blocks active');
  render('sh-vwap-body',vw,   9+MS_COLS+2,  'No VWAP exhaustion blocks');
  render('sh-dup-body', du,   9+MS_COLS+2,  'No duplicate blocks');
  // Shadow finalized: DB history only (truly finalized positions)
  // Active timezone blocks still showing as active in other sections
  render('sh-fin-body', hist, 10+MS_COLS+3, 'No shadow history yet \-- finalized positions appear here after SL/TP/gap');
}

// ==============================================
// EV OPTIMIZER
// ==============================================
async function loadEV(){
  const [evData,tpCfg,sessData,msData,wiData] = await Promise.all([
    api('/api/ghost-combo-analysis').catch(()=>[]),
    api('/api/tp-config').catch(()=>({})),
    api('/api/session-stats').catch(()=>[]),
    api('/api/milestone-probability').catch(()=>[]),
    api('/api/shadow-whatif').catch(()=>({summary:[],details:[]})),
  ]);

  // Session Win Rate table (Fix 7)
  const ssb=$('sess-stats-body');
  const sessList=Array.isArray(sessData)?sessData:[];
  if(ssb){
    if(!sessList.length){ssb.innerHTML=nd(7,'No session data \-- need finalized ghosts');}
    else{
      ssb.innerHTML=sessList.map(s=>{
        const sessLabel={'ny':'NEW YORK','london':'LONDON','asia':'ASIA'}[s.session]||s.session?.toUpperCase()||'\--';
        const wrCls=s.winRate>=60?'cg fw':s.winRate>=50?'cy':'cr';
        const avgTsl=s.avgTimeToSL!=null?(s.avgTimeToSL>=60?Math.floor(s.avgTimeToSL/60)+'h'+(s.avgTimeToSL%60)+'m':s.avgTimeToSL+'m'):'\--';
        return '<tr>'+
          '<td class="cw fw" style="white-space:nowrap">'+sessLabel+'</td>'+
          '<td class="cd">'+s.total+'</td>'+
          '<td class="cg">'+s.wins+'</td>'+
          '<td class="'+wrCls+' fw">'+s.winRate+'%</td>'+
          '<td class="cg">'+( s.avgPeakPos!=null?'+'+s.avgPeakPos.toFixed(3)+'R':'\--')+'</td>'+
          '<td class="cr">'+( s.avgPeakNeg!=null?'-'+s.avgPeakNeg.toFixed(1)+'%':'\--')+'</td>'+
          '<td class="cd">'+avgTsl+'</td>'+
        '</tr>';
      }).join('');
    }
  }

  // Milestone Probability table (Fix 8)
  const mpb=$('ms-prob-body');
  const msList=Array.isArray(msData)?msData:[];
  if(mpb){
    if(!msList.length){mpb.innerHTML=nd(14,'No milestone data \-- need min 3 finalized ghosts per key');}
    else{
      mpb.innerHTML=msList.slice(0,100).map(m=>{
        const avgTsl=m.avgTimeToSL!=null?(m.avgTimeToSL>=60?Math.floor(m.avgTimeToSL/60)+'h'+(m.avgTimeToSL%60)+'m':m.avgTimeToSL+'m'):'\--';
        const pct=v=>'<td class="'+(v>=70?'cr fw':v>=40?'co':'cd')+'" style="font-size:10px">'+v+'%</td>';
        const pctG=v=>'<td class="'+(v>=70?'cg fw':v>=40?'cy':'cd')+'" style="font-size:10px">'+v+'%</td>';
        const rec=m.pRecovery!=null?'<td class="'+(m.pRecovery>=50?'cy fw':'cd')+'" style="font-size:10px">'+m.pRecovery+'%</td>':'<td class="cd">\--</td>';
        return '<tr>'+
          '<td class="cw" style="font-size:9px">'+( m.optimizerKey||'\--')+'</td>'+
          '<td class="cd">'+m.total+'</td>'+
          pct(m.pNeg01)+pct(m.pNeg03)+pct(m.pNeg05)+pct(m.pNeg08)+
          '<td class="'+(m.pNeg10>=70?'cr fw':m.pNeg10>=40?'co':'cd')+'" style="font-size:10px;border-right:1px solid rgba(139,148,158,.2)">'+m.pNeg10+'%</td>'+
          pctG(m.pPos03)+pctG(m.pPos05)+pctG(m.pPos08)+pctG(m.pPos10)+pctG(m.pPos15)+
          rec+'<td class="cd" style="font-size:9px">'+avgTsl+'</td>'+
        '</tr>';
      }).join('');
    }
  }

  // Shadow What-If table (Fix 9)
  const swb=$('shadow-whatif-body');
  const wiSummary=Array.isArray(wiData?.summary)?wiData.summary:[];
  if(swb){
    if(!wiSummary.length){swb.innerHTML=nd(9,'No shadow data with peak tracking yet');}
    else{
      swb.innerHTML=wiSummary.map(w=>{
        const riskPerTrade=19; // approx
        const missedEst=Math.round((w.wouldTP*(1.5*riskPerTrade))-(w.wouldSL*riskPerTrade));
        return '<tr>'+
          '<td><span class="bd bd-block" style="background:rgba(240,136,62,.15);color:#f0883e;padding:1px 6px;border-radius:3px;font-size:9px">'+
            (w.blockType?.replace('_',' ')||'\--')+'</span></td>'+
          '<td class="cd">'+w.total+'</td>'+
          '<td class="cg fw">'+w.wouldTP+'</td>'+
          '<td class="'+(w.tpRate>=50?'cg fw':'cy')+'" >'+w.tpRate+'%</td>'+
          '<td class="cr">'+w.wouldSL+'</td>'+
          '<td class="'+(w.slRate>=50?'cr fw':'co')+'">'+w.slRate+'%</td>'+
          '<td class="cg">'+( w.avgPeakPos!=null?'+'+w.avgPeakPos.toFixed(3)+'R':'\--')+'</td>'+
          '<td class="cr">'+( w.avgPeakNeg!=null?'-'+w.avgPeakNeg.toFixed(1)+'%':'\--')+'</td>'+
          '<td class="'+(missedEst>=0?'cg':'cr')+' fw">'+( missedEst>=0?'+':'')+fmtE(missedEst)+'</td>'+
        '</tr>';
      }).join('');
    }
  }
  const evBody=$('ev-body');
  const evList=Array.isArray(evData)?evData:[];
  if(evBody){
    if(!evList.length){evBody.innerHTML=nd(16,'No EV data yet \-- need min 5 finalized ghosts per combo');}
    else{
      evBody.innerHTML=evList.map(c=>{
        const cfg=tpCfg?.[c.optimizerKey||c.optimizer_key];
        const ev=c.evScore||c.ev_score||0;
        return '<tr>'+
          '<td class="cw fw">'+( c.symbol||'\--')+'</td>'+
          '<td>'+bdType(c.assetType||c.type,c.symbol)+'</td>'+
          '<td>'+bdSess(c.session)+'</td>'+
          '<td>'+bdDir(c.direction)+'</td>'+
          '<td>'+bdVwap(c.vwapPosition||c.vwap_position)+'</td>'+
          '<td>'+bdKey(c.keyMax||1)+'</td>'+
          '<td class="cd">'+( c.n||c.total||0)+'</td>'+
          '<td class="cd">'+( c.wins||0)+'/'+( c.n||0)+'</td>'+
          '<td class="'+(c.winPct>=60?'cg fw':'cy')+'">'+( c.winPct!=null?c.winPct.toFixed(1)+'%':'\--')+'</td>'+
          '<td class="'+(ev>=0.5?'cg fw':ev>=0?'cg':'cr')+' fw">'+( c.evScore!=null?c.evScore.toFixed(3):'\--')+'</td>'+
          '<td class="cg">'+( c.bestTP!=null?'+'+c.bestTP.toFixed(2)+'R':'\--')+'</td>'+
          '<td class="cd" style="font-size:9px">'+( cfg?.status||'Need data 0/5')+'</td>'+
          '<td class="'+(cfg?.lockedRR?'cg fw':'cd')+'">'+( cfg?.lockedRR?'+'+cfg.lockedRR.toFixed(2)+'R':'\--')+'</td>'+
          '<td class="cd">'+( c.avgTimeToSL!=null?c.avgTimeToSL+'m':'\--')+'</td>'+
          '<td class="cd">x'+( c.riskMult||1).toFixed(2)+'</td>'+
          '<td class="'+cE(c.totalPnl||c.total_pnl)+' fw">'+( c.totalPnl!=null?fmtE(c.totalPnl):'\--')+'</td>'+
        '</tr>';
      }).join('');
    }
  }
}

// ==============================================
// HEADER
// ==============================================
async function loadHeader(){
  const [status,pos,perf,ghostG,blockedA] = await Promise.all([
    api('/status').catch(()=>({})),
    api('/api/open-positions').catch(()=>[]),
    api('/api/performance').catch(()=>({})),
    api('/api/ghost-trades').catch(()=>[]),
    api('/api/blocked-ghosts/active').catch(()=>[]),
  ]);

  if(status){
    if($('ver'))$('ver').textContent='v'+(status.version||'14.8');
    if($('h-err')){$('h-err').textContent=status.errorCount||0;$('h-err').className='hkv '+((status.errorCount||0)>0?'cr':'cg');}
    if($('h-db')){$('h-db').textContent=status.dbReady?'DB ready':'DB init\...';$('h-db').className='hkv '+( status.dbReady?'cg':'co');}
  }
  const _pos=Array.isArray(pos)?pos:[];
  const _gh=Array.isArray(ghostG)?ghostG:[];
  const _ba=Array.isArray(blockedA)?blockedA:[];
  const _finCount=_gh.filter(g=>g.stopReason||g.stop_reason||g.closedAt||g.closed_at).length;
  if(perf){
    const _cs='EUR';
    if($('h-bal'))$('h-bal').textContent=perf.mt5Balance?'$'+Math.round(perf.mt5Balance).toLocaleString():'EUR'+(Math.round(perf.balance||50000)).toLocaleString();
    const rp=perf.realizedPnl||0;const up=perf.unrealizedPnl||0;
    if($('h-rpnl')){$('h-rpnl').textContent=(rp>=0?'+':'')+_cs+Math.round(Math.abs(rp));$('h-rpnl').className='hkv cg';}
    if($('h-upnl')){$('h-upnl').textContent=(up>=0?'+':'')+_cs+Math.round(Math.abs(up));$('h-upnl').className='hkv '+(up>=0?'cg':'cr');}
  }
  if($('h-open'))$('h-open').textContent=_pos.length;
  if($('h-ghost'))$('h-ghost').textContent=_pos.length;
  if($('h-fin'))$('h-fin').textContent=_finCount;
  if($('h-shadow'))$('h-shadow').textContent=_ba.length;
  if($('nb-gh'))$('nb-gh').textContent=_pos.length;
  if($('nb-sh'))$('nb-sh').textContent=_ba.length;
}

// ==============================================
// TAB NAVIGATION
// ==============================================
function go(n,el2){
  ['ov','sig','gh','sh','ev'].forEach(p=>{const d=$('p-'+p);if(d)d.classList.remove('on');});
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('on'));
  const pg=$('p-'+n);if(pg)pg.classList.add('on');el2.classList.add('on');
  if(n==='sig')loadSignals().catch(()=>{});
  else if(n==='gh') loadGhost().catch(()=>{});
  else if(n==='sh') loadShadow().catch(()=>{});
  else if(n==='ev') loadEV().catch(()=>{});
}

// ==============================================
// INIT + REFRESH
// ==============================================
async function loadAll(){
  await Promise.all([
    loadHeader().catch(e=>console.error('[loadHeader]',e.message)),
    loadOverview().catch(e=>console.error('[loadOverview]',e.message)),
    loadSignals().catch(e=>console.error('[loadSignals]',e.message)),
    loadGhost().catch(e=>console.error('[loadGhost]',e.message)),
    loadShadow().catch(e=>console.error('[loadShadow]',e.message)),
    loadEV().catch(e=>console.error('[loadEV]',e.message)),
  ]);
}

async function waitForDBAndLoad(){
  const s=await api('/status');
  if(s&&s.dbReady){
    await loadAll();
  }else{
    ['ov-open-body','ov-daily','ov-trades','gh-active-body','gh-fin-body','sh-tz-body','sh-vwap-body','sh-dup-body','sh-fin-body','ev-body','sig-log'].forEach(id=>{
      const e=$(id);if(e)e.innerHTML='<tr><td colspan="90" class="nd">Waiting for database\...</td></tr>';
    });
    setTimeout(waitForDBAndLoad,3000);
  }
}

// Refresh intervals
setInterval(()=>loadHeader().catch(()=>{}),15000);
setInterval(()=>loadOverview().catch(()=>{}),30000);
setInterval(()=>{if($('p-sig')?.classList.contains('on'))loadSignals().catch(()=>{});},20000);
setInterval(()=>{if($('p-gh')?.classList.contains('on'))loadGhost().catch(()=>{});},10000);
setInterval(()=>{if($('p-sh')?.classList.contains('on'))loadShadow().catch(()=>{});},10000);
setInterval(()=>{if($('p-ev')?.classList.contains('on'))loadEV().catch(()=>{});},30000);

waitForDBAndLoad();
</script>
</body>
</html>`;
}


// ══════════════════════════════════════════════════════════════════
//  BACKGROUND DB INIT  (runs after server is already listening)
// ══════════════════════════════════════════════════════════════════
async function initBackground() {
  // Retry DB init up to 5 times with backoff
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await db.initDB();
      console.log("[DB] initDB() success");
      break;
    } catch (e) {
      console.error(`[DB] initDB attempt ${attempt}/5 failed: ${e.message}`);
      if (attempt < 5) await new Promise(r => setTimeout(r, 5000 * attempt));
      else { recordError(`initDB failed permanently: ${e.message}`); return; }
    }
  }

  // Load compliance date
  try {
    const saved = await db.loadComplianceDate();
    if (saved) { liveComplianceDate = saved; db.setComplianceDateLive(saved); }
  } catch {}

  // Load cached config
  try {
    [tpConfigs, symbolRiskMap, keyRiskMults] = await Promise.all([
      db.loadTPConfig().catch(() => ({})),
      db.loadSymbolRiskConfig().catch(() => ({})),
      db.loadKeyRiskMults().catch(() => ({})),
    ]);
    console.log(`[DB] Loaded: ${Object.keys(tpConfigs).length} TP, ${Object.keys(symbolRiskMap).length} risk, ${Object.keys(keyRiskMults).length} mults`);
  } catch {}

  // Restore open positions
  try {
    const states = await db.loadAllGhostStates();
    for (const gs of states) {
      if (openPositions.has(gs.positionId)) continue;
      if (!gs.direction || !gs.entry || !gs.sl) {
        console.warn(`[DB] Skipping incomplete ghost state ${gs.positionId} \-- missing direction/entry/sl`);
        continue;
      }
      // v14.0: Preserve phantomSLHit/stopReason from ghost_state (don't reset on restart)
      const ghost = { ...gs, maxPrice: gs.maxPrice??gs.entry, maxRR: gs.maxRR??0,
        maxSlPctUsed: gs.maxSlPctUsed??0, slMilestones: gs.slMilestones??{},
        rrMilestones: gs.rrMilestones??{},
        peakRRPos: gs.peakRRPos??0, peakRRNeg: gs.peakRRNeg??0,
        phantomSLHit: gs.phantomSLHit??false,
        stopReason: gs.stopReason??null, closedAt: null };
      // Reconstruct TP from tpRRUsed stored in ghost (sl distance \x tpRR)
      const _slDist = Math.abs((gs.entry||0) - (gs.sl||0));
      const _tp = (gs.tpRRUsed && _slDist > 0)
        ? parseFloat((gs.direction === 'buy'
            ? gs.entry + _slDist * gs.tpRRUsed
            : gs.entry - _slDist * gs.tpRRUsed).toFixed(6))
        : null;
      const _gsSymInfo = getSymbolInfo ? getSymbolInfo(normalizeSymbol(gs.symbol)??gs.symbol) : null;
      openPositions.set(gs.positionId, {
        positionId: gs.positionId, symbol: gs.symbol, mt5Symbol: gs.mt5Symbol??gs.symbol,
        direction: gs.direction, vwapPosition: gs.vwapPosition,
        session: gs.session, entry: gs.entry, sl: gs.sl, tp: _tp, lots: gs.lots ?? null,
        riskPct: gs.riskPct, riskEUR: gs.riskEUR, openedAt: gs.openedAt,
        optimizerKey: gs.optimizerKey,
        vwapBandPct: gs.vwapBandPct ?? null,
        assetType: _gsSymInfo?.type ?? null,
        type: _gsSymInfo?.type ?? null,
        tradeNumber: gs.tradeNumber ?? null,
        ghost });
    }
    console.log(`[DB] Restored ${openPositions.size} positions from ghost_state`);
    // Also immediately sync with MT5 to adopt any positions not in ghost_state
    // Don't wait \-- this runs in background
    setTimeout(async () => {
      try {
        const live = await getPositions();
        let adopted = 0;
        for (const lp of live) {
          const id = String(lp.id);
          if (!openPositions.has(id)) {
            await adoptPosition(lp);
            adopted++;
          }
        }
        if (adopted > 0) console.log(`[Startup] Adopted ${adopted} extra MT5 positions not in ghost_state`);
        console.log(`[Startup] Total open positions: ${openPositions.size}`);
      } catch(e) { console.error('[Startup] MT5 adopt error:', e.message); }
    }, 8000); // wait 8s for MetaAPI to fully connect + deploy account
    // Second adoption attempt after 20s \-- catches positions missed in first attempt
    setTimeout(async () => {
      try {
        const live2 = await getPositions();
        let late = 0;
        for (const lp of (live2||[])) {
          if (!openPositions.has(String(lp.id))) { await adoptPosition(lp); late++; }
        }
        if (late > 0) console.log(`[Startup] Late-adopted ${late} MT5 positions (20s retry)`);
        else console.log(`[Startup] 20s check: all ${openPositions.size} positions tracked \OK`);
      } catch(e) { console.warn('[Startup] 20s retry failed:', e.message); }
    }, 20000);
  } catch (e) { console.error("[DB] restorePositions failed:", e.message); }

  // Restore blocked ghost trackers
  try {
    const bgStates = await db.loadAllBlockedGhostStates();
    for (const bg of bgStates) {
      if (!bg.id || !bg.direction || !bg.entry || !bg.sl) continue;
      blockedPositions.set(bg.id, {
        ...bg,
        maxPrice:     bg.maxPrice ?? bg.entry,
        maxRR:        bg.maxRR ?? 0,
        maxSlPctUsed: bg.maxSlPctUsed ?? 0,
        slMilestones: bg.slMilestones ?? {},
        rrMilestones: bg.rrMilestones ?? {},
        phantomSLHit: false, stopReason: null, closedAt: null,
      });
    }
    console.log(`[DB] Restored ${blockedPositions.size} blocked ghost trackers`);
  } catch (e) { console.error("[DB] restoreBlockedGhosts failed:", e.message); }

  // ── v13.5: Adopteer MT5 posities die niet via ghost_state hersteld werden ──
  // Dit vangt trades op die open stonden vóór een deploy en waarvan de
  // ghost_state verloren ging (bv. eerste deploy, of DB reset).
  if (META_API_TOKEN && META_ACCOUNT) {
    try {
      const livePosAtBoot = await Promise.race([
        getPositions(),
        new Promise(r => setTimeout(() => r([]), 10000)),
      ]);
      let adopted = 0;
      for (const lp of livePosAtBoot) {
        const id = String(lp.id);
        if (!openPositions.has(id)) {
          await adoptPosition(lp);
          adopted++;
        }
      }
      if (adopted > 0) console.log(`[DB] Adopted ${adopted} MT5 positions not found in ghost_state`);
      else console.log(`[DB] All MT5 positions already in ghost_state \-- no adoption needed`);
    } catch (e) { console.warn(`[DB] MT5 adoption check failed: ${e.message}`); }
  }

  // Sync trade number sequence
  db.syncTradeNumberSequence().catch(() => {});

  // Mark DB as ready
  dbReady = true;
  console.log("[PRONTO-AI] ✅ DB ready \-- all systems operational");

  // MetaAPI connectivity check + auto-deploy
  if (META_API_TOKEN && META_ACCOUNT) {
    console.log(`[MetaAPI] Checking connectivity \-- account ${META_ACCOUNT.slice(0,8)}...`);
    try {
      // Step 1: Try to deploy the account (idempotent \-- safe to call even if already deployed)
      try {
        await metaFetch(`/users/current/accounts/${META_ACCOUNT}/deploy`, "POST");
        console.log("[MetaAPI] Deploy request sent \-- waiting 5s for account to come online...");
        await new Promise(r => setTimeout(r, 5000));
      } catch (deployErr) {
        // Deploy may fail if already deployed \-- that's fine
        console.log(`[MetaAPI] Deploy note: ${deployErr.message.slice(0, 80)}`);
      }

      // Step 2: Fetch account info to verify connection
      const acct = await Promise.race([
        metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 20s")), 20000)),
      ]);
      if (acct && acct.balance !== undefined) {
        latestEquity = parseFloat(acct.equity ?? acct.balance ?? 50000);
        _acctCache = acct; _acctCacheTs = Date.now();
        latestAccountCurrency = acct.currency ?? 'USD';
        console.log(`[MetaAPI] ✅ Connected \-- balance: ${acct.balance} ${acct.currency} (display currency: ${latestAccountCurrency})`);
      } else {
        console.warn("[MetaAPI] ⚠️ Response empty \-- account may still be deploying");
      }
    } catch (e) {
      console.error(`[MetaAPI] ❌ Connection failed: ${e.message}`);
      // If 404: wrong region URL \-- log helpful message
      if (e.message.includes("404")) {
        console.error("[MetaAPI] ❌ 404 = wrong region URL. Check META_BASE in Railway Variables.");
        console.error("[MetaAPI] Possible URLs: london / new-york / singapore / us-east");
      }
      recordError(`MetaAPI startup check: ${e.message}`);
    }
  } else {
    console.warn("[MetaAPI] ⚠️ META_API_TOKEN or META_ACCOUNT not set \-- MetaAPI disabled");
  }

  // Start cron jobs
  cron.schedule("*/10 * * * * *", syncPositions); // 10s for responsive P&L + milestones

  // ── Auto-backfill realized P&L for closed trades with NULL/EUR0 ────
  // Runs once after startup, non-blocking
  setTimeout(async () => {
    try {
      const nullTrades = await db.pool.query(`
        SELECT position_id, risk_eur FROM closed_trades
        WHERE (realized_pnl_eur IS NULL OR realized_pnl_eur = 0)
          AND closed_at IS NOT NULL
          AND position_id IS NOT NULL
        LIMIT 200
      `);
      if (!nullTrades.rows.length) {
        console.log('[Backfill] No trades need realized P&L backfill');
        return;
      }
      console.log(`[Backfill] Backfilling realized P&L for ${nullTrades.rows.length} trades...`);
      let updated = 0;
      for (const row of nullTrades.rows) {
        try {
          const deals = await fetchHistoryDeals(row.position_id);
          const closing = deals.filter(d => d.entryType === 'DEAL_ENTRY_OUT' || d.type === 'DEAL_TYPE_SELL' || d.type === 'DEAL_TYPE_BUY');
          const profit = closing.reduce((s, d) => s + parseFloat(d.profit || 0), 0);
          if (profit !== 0) {
            const exRate = latestExchangeRate ?? 1.0;
            const pnlEur = parseFloat((profit * exRate).toFixed(2));
            await db.pool.query(
              'UPDATE closed_trades SET realized_pnl_eur = $1 WHERE position_id = $2',
              [pnlEur, row.position_id]
            );
            updated++;
          } else if (row.risk_eur && profit === 0) {
            // Fallback: SL hit = -riskEUR approximately
            const stopTrade = await db.pool.query(
              'SELECT ghost_stop_reason, close_reason FROM closed_trades WHERE position_id = $1', 
              [row.position_id]
            );
            const st = stopTrade.rows[0];
            if (st && (st.ghost_stop_reason?.includes('sl') || st.close_reason === 'sl')) {
              const fallback = -Math.abs(parseFloat(row.risk_eur));
              await db.pool.query(
                'UPDATE closed_trades SET realized_pnl_eur = $1 WHERE position_id = $2',
                [fallback, row.position_id]
              );
              updated++;
            }
          }
          await new Promise(r => setTimeout(r, 200)); // rate limit
        } catch (e) { /* skip this trade */ }
      }
      console.log(`[Backfill] Done \-- updated ${updated}/${nullTrades.rows.length} trades`);
    } catch (e) {
      console.warn('[Backfill] Error:', e.message);
    }
  }, 30000); // 30s after startup
  cron.schedule("*/5 * * * *",    runShadowSnapshots);
  cron.schedule("0 * * * *",      runTPOptimizer);
  console.log("[PRONTO-AI] Cron jobs active");
}

// Start background init (non-blocking)
initBackground().catch(e => console.error("[FATAL] initBackground:", e.message));
