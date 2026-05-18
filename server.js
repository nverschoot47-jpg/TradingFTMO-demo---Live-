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
//     COMPLIANCE_DATE → '2000-01-01' (geen filtering meer).
//     Compliance bar verborgen in dashboard.
//     loadAll() filtert trades niet meer op cutoff datum.
//
//  4. SELECTIEVE DATUMFILTER GHOST HISTORY:
//     Datumfilter bovenaan Ghost History tab (van/tot datum).
//     loadGhostHistory() stuurt from/to params naar API.
//     /api/ghost-history-by-pair?from=YYYY-MM-DD&to=YYYY-MM-DD
//     loadGhostHistoryByPair(from, to) in db.js.
//
//  INHERITED (v13.2.0):
//  FIX 1a — VWAP EXHAUSTION BLOCK
//  FIX 1b — DUPLICATE POSITION BLOCK
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
const VERSION = "14.4.1"; // v14.4.1: stock lots=riskEUR/slDist (1 aandeel=1lot, P&L=lots×move) // v14.3: bugs fixed (const→let adoptPosition, dupNumber, blockTypes, duplicate fetchHistoryDeals, NY_NIGHT/ASIA_MORNING shadow tracking) all milestone gaps fixed, outside night 21-02h, daily open log, ghost finalized fix, slHitAt EOD keep

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

// ── Express — start listening IMMEDIATELY ────────────────────────
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));

const server = app.listen(PORT, () => {
  console.log(`[PRONTO-AI v${VERSION}] Server running on port ${PORT}`);
  console.log('[FIXES] weekend-sync | ghost-combined | stock-session | peak-rr-neg');
  console.log(`[PRONTO-AI] Listening on port ${PORT} — DB init starting…`);
});

// ── Webhook secret check ──────────────────────────────────────────
function checkSecret(req, res) {
  if (!WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Unauthorized — WEBHOOK_SECRET not configured' });
    return false;
  }
  // v14.1: Header-only auth. Query params are logged by proxies/Railway — security risk.
  // TradingView supports custom headers: add "x-webhook-secret: YOUR_SECRET" in alert config.
  // Body/query fallback kept ONLY for backward compat with existing TV alerts (deprecated).
  const provided = req.headers['x-webhook-secret']
    || req.headers['x-secret']
    || req.body?.secret   // deprecated: body secret logged in Railway access logs
    || req.query?.secret; // deprecated: URL params logged everywhere — migrate to header
  if (provided !== WEBHOOK_SECRET) {
    const ip = req.ip || '?';
    recordError(`Bad webhook secret from ${ip} — migrate TradingView alerts to x-webhook-secret header`);
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ── MetaAPI helpers ───────────────────────────────────────────────
// Circuit breaker for MetaAPI — tracks consecutive failures
let _metaFailCount = 0;
let _metaCircuitOpen = false;
let _metaCircuitOpenAt = 0;
const META_CIRCUIT_THRESHOLD = 5;    // open after 5 consecutive failures
const META_CIRCUIT_RESET_MS  = 60000; // try again after 60s

async function metaFetch(path, method = "GET", body = null, retries = 2) {
  // Circuit breaker: if MetaAPI is known-down, fail fast
  if (_metaCircuitOpen) {
    if (Date.now() - _metaCircuitOpenAt > META_CIRCUIT_RESET_MS) {
      _metaCircuitOpen = false; _metaFailCount = 0;
      console.log('[MetaAPI] Circuit breaker reset — retrying');
    } else {
      throw new Error('MetaAPI circuit open — skipping call');
    }
  }
  const url = `${META_BASE}${path}`;
  const opts = {
    method,
    headers: { "auth-token": META_API_TOKEN, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(12000), // 12s — leaves buffer for 30s cron
  };
  if (body) opts.body = JSON.stringify(body);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        let errBody = "";
        try { errBody = await res.text(); } catch {}
        throw new Error(`MetaAPI ${method} ${path} → ${res.status} ${errBody.slice(0, 200)}`);
      }
      // Success — reset failure counter
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

async function getAccountInfo() {
  if (!META_API_TOKEN || !META_ACCOUNT) {
    console.warn("[MetaAPI] getAccountInfo: TOKEN or ACCOUNT not set");
    return null;
  }
  try {
    return await metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`);
  } catch (e) {
    recordError(`getAccountInfo: ${e.message}`);
    return null;
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
  // Don't update after phantom SL hit — that is the ONLY way a ghost closes now
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
  // NOTE: ghost no longer auto-closes at 15R — runs until phantom SL hit (-1R)
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
      realPnl = await db.fetchRealizedPnl(positionId) ?? pnl;
    } catch (e) { recordError(`closePos deals: ${e.message}`); }
  }
  // v14.2 FIX: Gap detection — uses deals already fetched above (no second call)
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
          // If fill is more than 0.5× slDist past the SL → gap
          if (overrun > slDist * 0.5) {
            gapStop = true;
            console.warn(`[Gap] ${positionId} ${pos.symbol} stopped via GAP — fill=${fillPrice} SL=${pos.sl} overrun=${overrun.toFixed(5)}`);
          }
        }
      }
    } catch { /* non-critical */ }
  }
  const finalCloseReason = gapStop ? 'sl_gap' : reason;

  if (ghost && dbReady) {
    ghost.closedAt       = now;
    ghost.stopReason     = gapStop ? 'gap_stop' : (ghost.stopReason ?? reason);
    ghost.realizedPnlEUR = realPnl ?? null;
    ghost.lots           = pos.lots ?? null;
    await db.saveGhostTrade({ ...ghost, maxRRBeforeSL: ghost.maxRR }).catch(e => recordError(e.message));
    db.computeAndSaveGhostComboAnalysis(ghost.optimizerKey).catch(() => {});
    // v14.2: Check if this ghost pushed us over the TP lock threshold
    // Don't wait for the hourly cron — recompute TP immediately
    const gcCount = await db.countGhostsByKey(ghost.optimizerKey).catch(() => 0);
    if (gcCount >= 10) {
      setTimeout(() => runTPOptimizer().catch(() => {}), 2000); // async, 2s delay
    }
  }

  if (dbReady) {
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
      closeReason: finalCloseReason,  // 'sl' or 'sl_gap'
      spreadAtEntry: pos.spreadAtEntry, vwapBandPct: pos.vwapBandPct,
      executionPrice: pos.executionPrice, tvEntry: pos.tvEntry, slippage: pos.slippage,
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
// niet in memory zit — bv. na een deploy/restart terwijl er een trade open stond.
// Reconstrueert de positie vanuit MT5 data + comment parsing.
function parseMT5Comment(comment = '') {
  // Two comment formats:
  // OLD: "S-NY-UNK #10"           → DIR-SESS-VWAP #N
  // NEW: "EURCHF S-LD-ABV #1"     → SYMBOL DIR-SESS-VWAP #N
  // NEW: "NZDCHF B-LD-ABV #1"     → SYMBOL DIR-SESS-VWAP #N
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
      // Found a valid DIR-SESS segment — get trade number from next hash part
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
  // Determine direction: comment parse → MT5 type field → current position type
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

  // Guard: don't adopt if we can't determine direction reliably — log and skip
  if (!direction) {
    console.error(`[Adopt] SKIP ${id} ${symbol} — cannot determine direction. lp.type="${lp.type}", comment="${lp.comment ?? ''}"`);
    return;
  }

  // Estimate SL pct from entry/sl distance
  const slPct = entry > 0 && sl > 0 ? Math.abs(entry - sl) / entry : 0.003;

  // Use ALL available MT5 data for adopted positions — handle all field variants
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

  const assetTypeA = symInfo?.type ?? 'forex';
  const slDistA = Math.abs(entry - sl);
  let riskEURAdopted = null;
  if (lots > 0 && slDistA > 0) {
    if (assetTypeA === 'forex')     riskEURAdopted = lots * 100000 * slDistA;
    else if (assetTypeA === 'index')riskEURAdopted = lots * slDistA;
    else if (assetTypeA === 'stock')riskEURAdopted = lots * slDistA; // 1 share × price_move = EUR
    else                            riskEURAdopted = lots * 100 * slDistA;
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
    liveProfitMT5: livePnl ?? null,
    currentPrice:  livePrice ?? null,
    ghost: null,
  };
  pos.ghost = initGhost({ ...pos, slPct });
  openPositions.set(id, pos);

  if (dbReady) db.saveGhostState(pos.ghost).catch(() => {});
  console.log(`[Adopt] Hersteld MT5 positie ${id} ${symbol} ${direction} entry=${entry} — comment="${lp.comment ?? ''}"`);
}

// ── Position sync (cron) ─────────────────────────────────────────
let _syncRunning  = false;
let _syncCount    = 0;
let latestEquity  = 50000;   // updated by pollStatus / placeOrder
let _lastEquityRecord = 0;   // timestamp of last equity_curve insert
async function syncPositions() {
  // Always sync — weekends included. Market may be closed but positions exist.
  if (!dbReady) return;
  if (_syncRunning) {
    console.warn('[Sync] Skipping — previous sync still running');
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
  // Run sync ALWAYS — even weekends. Positions stay open over weekend.
  // isMonitoringActive() only affects NEW trade signals, not position tracking.
  if (!dbReady) return;
  // Update equity from account info every 5 syncs (~2.5 min)
  _syncCount = (_syncCount || 0) + 1;
  if (_syncCount % 5 === 1) {
    try {
      const acct = await getAccountInfo();
      if (acct?.equity && acct.equity > 0) latestEquity = parseFloat(acct.equity);
    } catch {} // non-critical
  }
  const live = await getPositions();
  const liveIds = new Set(live.map(p => String(p.id)));

  // Sluit posities die niet meer in MT5 zitten — detecteer SL/TP via deals
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
            // Negatief profit + ghost hit phantom SL = SL
            if (profit < 0 && pos.ghost?.phantomSLHit) closeReason = 'sl';
            // Positief profit + ghost stopReason max_rr_15 = TP area
            else if (profit > 0 && pos.ghost?.stopReason === 'max_rr_15') closeReason = 'tp';
          }
        }
      } catch (e) { /* gebruik 'manual' als fallback */ }
      await closePosition(id, closeReason, null);
    }
  }

  for (const lp of live) {
    const id  = String(lp.id);
    const pos = openPositions.get(id);
    if (!pos) {
      // ── v13.5: positie bestaat in MT5 maar niet in memory → adopteer ──
      await adoptPosition(lp);
    } else {
      // ALWAYS sync MT5 position data — handle multiple MetaAPI field name variants
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
      if (lpProfit != null) pos.liveProfitMT5 = parseFloat(lpProfit);

      // Current price: currentPrice / currentBid / currentAsk / openPrice fallback
      const lpPrice = lp.currentPrice ?? lp.currentBid ?? lp.currentAsk ?? lp.openPrice;
      if (lpPrice) pos.currentPrice = parseFloat(lpPrice);

      // Entry price: openPrice
      if (lp.openPrice) pos.entry = pos.entry || parseFloat(lp.openPrice);

      // Log first time we get data for a position (debugging)
      if (!pos._synced) {
        pos._synced = true;
        // Log raw MetaAPI field names so we can debug missing data
        console.log('[SYNC_RAW] position fields:', Object.keys(lp).join(', '));
        console.log('[SYNC_RAW] key values:', {
          id: lp.id, symbol: lp.symbol, volume: lp.volume,
          profit: lp.profit, currentPrice: lp.currentPrice,
          openPrice: lp.openPrice, stopLoss: lp.stopLoss,
          type: lp.type, time: lp.time,
        });
        logEvent('POS_SYNC', { id: pos.positionId, symbol: pos.symbol,
          lots: pos.lots, profit: pos.liveProfitMT5, price: pos.currentPrice,
          sl: pos.sl, tp: pos.tp });
      }
      // Recalculate riskPct/riskEUR from live lots + sl every sync
      // This corrects any corrupted values from previous deploys
      if (pos.lots && pos.entry && pos.sl) {
        const slDistSync = Math.abs(pos.entry - pos.sl);
        const assetTypeSync = getSymbolInfo(pos.symbol)?.type ?? 'forex';
        let riskEURSync = 0;
        if (assetTypeSync === 'forex')      riskEURSync = pos.lots * 100000 * slDistSync;
        else if (assetTypeSync === 'index') riskEURSync = pos.lots * slDistSync;
        else if (assetTypeSync === 'stock') riskEURSync = pos.lots * slDistSync; // 1 share × price_move = EUR
        else                                riskEURSync = pos.lots * 100 * slDistSync;
        const eqSync = latestEquity || 50000;
        if (riskEURSync > 0) {
          pos.riskEUR = parseFloat(riskEURSync.toFixed(2));
          pos.riskPct = riskEURSync / eqSync;
        }
      }
      if (pos.ghost) {
        if (!pos.ghost.direction || !pos.ghost.entry || !pos.ghost.sl) {
          console.warn(`[Sync] Skipping ghost ${id} ${pos.symbol} — missing direction/entry/sl`);
          continue;
        }
        // Use best available price for ghost tracking
        const priceForGhost = lp.currentPrice ?? lp.currentBid ?? lp.currentAsk ?? lp.openPrice;
        if (priceForGhost) {
          const wasHit = pos.ghost.phantomSLHit;
          updateGhost(pos.ghost, priceForGhost);
          pos.ghost.lastPriceTs = Date.now();
          // v14.2: When phantom SL is just hit → record slHitAt + save finalized ghost trade
          if (!wasHit && pos.ghost.phantomSLHit && dbReady) {
            pos.ghost.slHitAt  = new Date().toISOString();
            pos.ghost.closedAt = pos.ghost.slHitAt;
            pos.ghost.realizedPnlEUR = pos.liveProfitMT5 ?? null;
            pos.ghost.lots = pos.lots ?? null;
            db.saveGhostTrade({ ...pos.ghost, maxRRBeforeSL: pos.ghost.maxRR }).catch(e => recordError(e.message));
            db.computeAndSaveGhostComboAnalysis(pos.ghost.optimizerKey).catch(() => {});
            console.log(`[Ghost] Finalized ${id} ${pos.symbol} — phantom SL hit at peak ${pos.ghost.peakRRPos?.toFixed(2)}R`);
            pos.ghost.closedAt = null; // reset so ghost stays "active" in memory till EOD
          }
        }
        if (dbReady) db.saveGhostState(pos.ghost).catch(() => {});
      }
    }
  }
  // ── Blocked ghost trackers: update via live MT5 prices ──
  // Gebruik de liveIds priceMap — blocked ghosts volgen hetzelfde symbool
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
      // Keep shadow till end of Brussels day — remove after Brussels midnight
      const now = new Date();
      const bru  = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));
      const slHitDate = new Date(new Date(bg.slHitAt).toLocaleString('en-US', { timeZone: 'Europe/Brussels' }));
      const sameBruDay =
        slHitDate.getFullYear() === bru.getFullYear() &&
        slHitDate.getMonth()    === bru.getMonth() &&
        slHitDate.getDate()     === bru.getDate();
      if (!sameBruDay) {
        // Past Brussels midnight since SL hit — save to DB first, then remove
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
    // v14.0: skip if direction missing — would cause NOT NULL constraint error
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
      // Conservative multiplier: requires 20+ ghosts, capped at 1.25× (not 1.5×)
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
        if (rrChanged) console.log(`[TP] ${g.optimizerKey}: TP updated ${existing?.lockedRR}R → ${ev.bestRR}R (${g.n} ghosts, EV=${ev.bestEV?.toFixed(3)})`);
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

// /dashboard → alias for root (fixes broken /dashboard link)
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
// DB ANALYSIS — analyse comment formats + backfill missing data
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
  // Account info: try with 10 s timeout — never block
  const acct = await Promise.race([
    getAccountInfo(),
    new Promise(r => setTimeout(() => r(null), 10000)),
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
          vwap_lower, vwap_lower2, close: tvClose } = req.body ?? {};
  // Pine Script sends "action":"buy"/"sell" — normalize to direction
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
    db.logSignal({ symbol, direction, outcome: 'REJECTED', rejectReason: mktReason,
      session: sesForLog, latencyMs: Date.now() - t0 }).catch(() => {});

    // ── Shadow Playbook: ALL tradeable-but-blocked signals get a ghost tracker ──
    // NY_DEAD_ZONE: outside 15:30-18:00 Brussels (forex/stocks blocked at NYSE open)
    // OUTSIDE_WINDOW: outside 21:00-02:00 Brussels (market closed overnight)
    // STOCK_OUTSIDE_MARKET: stocks outside 16:00-21:00 Brussels
    // These are trades that WOULD have been valid setups — we track them for EV analysis
    const isTrackableBlock = mktReason && (
      mktReason.includes('NY_DEAD_ZONE') ||
      mktReason.includes('NY_NIGHT') ||
      mktReason.includes('ASIA_MORNING') ||
      mktReason.includes('OUTSIDE_WINDOW') ||     // legacy compat
      mktReason.includes('STOCK_OUTSIDE_MARKET')
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
        const slBuf    = symInfoB?.type === 'stock' ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;
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
          blockType, blockTypes, symbol, mt5Symbol: mt5B,
          session: sesB, direction, vwapPosition: vwapPosB,
          entry: tvEntryB, sl: slPriceB, slPct: slPctB,
          tpRRUsed: tpConfigs[optKeyB]?.lockedRR ?? 2.0,
          optimizerKey: optKeyB, blockReason: mktReason,
          keyCount, subSession: subSessB,
          type: symInfoB?.type ?? 'unknown',
        });
        blockedPositions.set(bg.id, bg);
        db.saveBlockedGhostState(bg).catch(() => {});
        console.log(`[BlockedGhost] ${blockType} tracker created: ${bg.id} ${symbol} ${direction} entry=${tvEntryB}`);
      }
    }
    return res.json({ ok: false, reason: mktReason });
  }

  // Pine Script sends both "entry" and "close" — accept either
  const tvEntry  = tvClose ? parseFloat(tvClose) : (req.body?.entry ? parseFloat(req.body.entry) : null);
  const vwapMid  = vwap    ? parseFloat(vwap)    : null;
  const session  = getSession();
  const vwapPos  = getVwapPosition(tvEntry, vwapMid);
  const optKey   = buildOptimizerKey(symbol, session, direction, vwapPos);
  const slPct    = sl_pct ? parseFloat(sl_pct) : 0.003;

  // ── FIX 1a: VWAP band% block — blokkeer signalen ≥150% van de VWAP band ──
  // bandPct = afstand van prijs tot VWAP mid, uitgedrukt als % van de halve band breedte.
  // 100% = prijs zit op de eerste band (vwap_upper / vwap_lower).
  // 150% = prijs zit 1.5× de halve band buiten de VWAP mid → te ver uitgerokken.
  // Geldt voor ALLE asset types: forex, stock, index, commodity.
  let vwapBandPct = null;
  if (tvEntry !== null && vwapMid !== null && vwap_upper) {
    const halfBand = Math.abs(parseFloat(vwap_upper) - vwapMid);
    if (halfBand > 0) {
      const dist  = Math.abs(tvEntry - vwapMid);
      vwapBandPct = parseFloat(((dist / halfBand) * 100).toFixed(2));
    }
  }
  // VWAP exhaustion threshold — configurable per asset type
  // Stocks: wider bands (higher volatility) → higher threshold
  // Forex/Index: tighter bands → lower threshold  
  const vwapThreshold = assetType === 'stock' ? 250 : assetType === 'index' ? 130 : 150; // stocks: open+ghost allowed up to 250%, above→shadow
  if (vwapBandPct !== null && vwapBandPct >= vwapThreshold) {
    const rejectReason = `VWAP_EXHAUSTION: band_pct=${vwapBandPct.toFixed(1)}% (max ${vwapThreshold}% for ${assetType})`;
    db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
      tvEntry, slPct, vwapBandPct, outcome: "REJECTED", rejectReason,
      latencyMs: Date.now() - t0 }).catch(() => {});
    // ── v13.4: VWAP_EXHAUSTION → maak invisible blocked ghost tracker ──
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
        tpRRUsed: tpConfigs[optKey]?.lockedRR ?? 2.0,
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

  // ── FIX 1b: Duplicate check — max 1 open positie per optimizerKey ──
  for (const [, existingPos] of openPositions) {
    if (existingPos.optimizerKey === optKey) {
      const rejectReason = `DUPLICATE_POSITION: ${optKey} already open (positionId=${existingPos.positionId})`;
      db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
        tvEntry, slPct, vwapBandPct, outcome: "REJECTED", rejectReason,
        latencyMs: Date.now() - t0 }).catch(() => {});
      // ── v13.4: DUPLICATE → maak invisible blocked ghost tracker ──
      if (dbReady && tvEntry && slPct) {
        const slBufD  = assetType === 'stock' ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;
        const slDistD = slPct * slBufD * tvEntry;
        const slPriceD = direction === 'buy' ? tvEntry - slDistD : tvEntry + slDistD;
        // STAP 10 FIX: keyCount = existing ghosts + 1 (don't count the current new one)
        // openPositions: existing trades for this key (already placed)
        // blockedPositions: already blocked for this key (not the current one being blocked)
        const keyCountDup =
          [...openPositions.values()].filter(p=>(p.ghost?.optimizerKey??p.optimizerKey)===optKey).length +
          [...blockedPositions.values()].filter(b=>b.optimizerKey===optKey && b.id!==bg?.id).length + 1;
        // blockTypes: check if ALSO VWAP exhaustion (can be both)
        const blockTypesDup = ['DUPLICATE_POSITION'];
        if (vwapBandPct !== null && vwapBandPct >= 150) blockTypesDup.push('VWAP_EXHAUSTION');
        const bg = initBlockedGhost({
          blockType: 'DUPLICATE_POSITION',
          blockTypes: blockTypesDup,
          symbol, mt5Symbol: mt5Sym,
          session, direction, vwapPosition: vwapPos,
          entry: tvEntry, sl: slPriceD, slPct,
          tpRRUsed: tpConfigs[optKey]?.lockedRR ?? 2.0,
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

  let equity = 10000;
  const acct = await Promise.race([getAccountInfo(), new Promise(r => setTimeout(() => r(null), 8000))]);
  if (acct?.equity) { equity = parseFloat(acct.equity); latestEquity = equity; }

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
  const slDist      = (slPct * slBuf) * execPrice;
  // Risk calculation log for verification:
  // TV signal: entry=${tvEntry}, sl_pct=${slPct} (${(slPct*100).toFixed(3)}% from entry)
  // MT5 exec:  execPrice=${execPrice}, slippage=${slippage}
  // slDist = ${slPct} × ${slBuf}× (buf) × ${execPrice} = ${slDist.toFixed(6)}
  // Applied to MT5 price — SL moves with execution price, not TV entry
  const slPrice     = direction === "buy"
    ? parseFloat((execPrice - slDist).toFixed(6))
    : parseFloat((execPrice + slDist).toFixed(6));
  const tpRR        = tpConfigs[optKey]?.lockedRR ?? 2.0;
  const tpPrice     = direction === "buy"
    ? parseFloat((execPrice + slDist * tpRR).toFixed(6))
    : parseFloat((execPrice - slDist * tpRR).toFixed(6));

  let lots;
  const lotNom = slDist > 0 ? riskEUR / slDist : 0.01;
  if (assetType === 'forex')     lots = Math.max(0.01, parseFloat((lotNom / 100000).toFixed(2)));
  else if (assetType === 'index') lots = Math.max(0.01, parseFloat(lotNom.toFixed(2)));
  else if (assetType === 'stock') {
    // Stocks (FTMO CFD): 1 lot = 1 share
    // P&L = lots × price_move (dollar ≈ euro on FTMO)
    // Example: JNJ entry=221.25 SL=222.59 slDist=1.34 riskEUR=38
    //   → lots = 38 / 1.34 = 28 aandelen ✓
    // No multiplier — 1 share moves dollar-for-dollar
    const rawLots = slDist > 0 ? riskEUR / slDist : 1;
    lots = Math.max(1, Math.round(rawLots)); // whole shares only (FTMO)
  }
  else lots = Math.max(0.01, parseFloat((lotNom / 100).toFixed(2)));

  let tradeNumber = null;
  if (dbReady) tradeNumber = await db.getNextTradeNumber().catch(() => null);

  // Place order
  let positionId;
  // v14.0: MT5 comment — readable format shown in MetaTrader position list
  // Format: "SYMBOL D-SESS-VWAP #N"  e.g. "GBPUSD S-NY-BLW #42"
  const orderComment = (()=>{
    const d = direction === 'buy' ? 'B' : 'S';
    // getSession() returns 'ny'|'london'|'asia'|'outside' — NOT 'new_york'
    const sessMap = { ny: 'NY', london: 'LD', asia: 'AS', outside: 'NY' }; // outside→ny
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

    // ── v13.5.1: ORDER_NOT_CONFIRMED — poll MT5 voor positionId ──
    // Stocks (GOOG, AAPL, JNJ etc.) geven soms geen positionId terug
    // bij market open. Poll tot 10s om de nieuwe positie te vinden.
    if (!positionId) {
      console.warn(`[Order] Geen positionId ontvangen voor ${mt5Sym} ${direction} — polling MT5…`);
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
        // ORDER_NOT_CONFIRMED: positie niet gevonden — log en geef error terug.
        // Maak GEEN fallback ghost met Date.now() ID — dit leidt tot orphan ghosts.
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
    slippage, spreadAtEntry, vwapBandPct, tradeNumber, ghost: null };
  pos.ghost = initGhost({ ...pos, slPct, evMult: km.evMult, dayMult: km.dayMult });
  openPositions.set(positionId, pos);

  if (dbReady) {
    db.saveGhostState(pos.ghost).catch(() => {});
    db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
      tvEntry, slPct, vwapBandPct, outcome: "PLACED", latencyMs: Date.now() - t0, positionId }).catch(() => {});
    db.logWebhook({ symbol, direction, session, vwapPos, action: "place", status: "OK",
      positionId, entry: execPrice, sl: slPrice, tp: tpPrice, lots, riskPct, optimizerKey: optKey,
      latencyMs: Date.now() - t0, tvEntry, executionPrice: execPrice, slippage, vwapBandPct }).catch(() => {});
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

// ── API endpoints (all safe — return empty on error/not ready) ───

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
    res.json(stats);
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
      symbol: bg.symbol, mt5Symbol: bg.mt5Symbol, session: bg.session,
      direction: bg.direction, vwapPosition: bg.vwapPosition,
      entry: bg.entry, sl: bg.sl, slPct: bg.slPct,
      maxRR: bg.maxRR, maxSlPctUsed: bg.maxSlPctUsed,
      peakRRPos: bg.peakRRPos ?? bg.maxRR ?? 0,
      peakRRNeg: bg.peakRRNeg ?? bg.maxSlPctUsed ?? 0,
      slMilestones: bg.slMilestones ?? {},
      rrMilestones: bg.rrMilestones ?? {},
      vwapBandPct: bg.vwapBandPct, blockReason: bg.blockReason,
      duplicateCount: bg.duplicateCount ?? null,
      openedAt: bg.openedAt, currentPrice: bg.currentPrice ?? null,
    })));
  }
  if(!dbReady) return res.json([]);
  db.loadActiveBlockedGhosts().then(r => res.json(r)).catch(() => res.json([]));
});
apiGet("/api/blocked-ghosts/history", r  => db.loadBlockedGhostHistory(
  r.query.blockType ?? 'NY_DEAD_ZONE', r.query.from ?? null, r.query.to ?? null), []);
apiGet("/api/ghost-combo-analysis",r  => db.loadGhostComboAnalysis(r.query.key??null), []);
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
  // No secret required — served to the dashboard which runs on same origin
  // Data is position metadata only; full security would need session auth
  const out = [];
  for (const [id, pos] of openPositions) {
    // Use ghost.lots as fallback when pos.lots is null (weekend/adopted positions)
    const lotsOut = pos.lots ?? pos.ghost?.lots ?? null;
    out.push({
      positionId: id, symbol: pos.symbol, direction: pos.direction,
      session: pos.session, vwapPosition: pos.vwapPosition, optimizerKey: pos.optimizerKey,
      entry: pos.entry, sl: pos.sl, tp: pos.tp, lots: lotsOut,
      riskPct: pos.riskPct, riskEUR: pos.riskEUR, openedAt: pos.openedAt,
      tradeNumber: pos.tradeNumber,
      currentPrice: pos.currentPrice ?? null,
      liveProfitMT5: pos.liveProfitMT5 ?? null,
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

// /api/performance — served by apiGet above (loadPerformanceStats)
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
//  /api/snapshot  — full system state in one call (for Claude / monitoring)
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
//  DASHBOARD HTML  (self-contained — all JS inline)
// ══════════════════════════════════════════════════════════════════
function dashboardHTML() {
// Symbol type maps (mirrored from session.js for client-side use)
const FOREX_SYMS     = ['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF'];
const INDEX_SYMS     = ['DE30EUR','NAS100USD','UK100GBP','US30USD'];
const COMM_SYMS      = ['XAUUSD'];
const FIXED_RISK_PCT = 0.000375;
// v13.3: COMPLIANCE_MS verwijderd — datum restriction opgeheven

// Build milestone arrays: -1.0 → -0.1 then +0.1 → +15.0 in 0.1 steps
const ADV_STEPS = [];
for (let v = 1.0; v >= 0.1 - 1e-9; v = Math.round((v - 0.1) * 10) / 10) ADV_STEPS.push(v);
// ADV_STEPS = [1.0, 0.9, ..., 0.1]
const FAV_STEPS = [];
for (let v = 0.1; v <= 15.0 + 1e-9; v = Math.round((v + 0.1) * 10) / 10) FAV_STEPS.push(v);

return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO·AI v14.0</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080c12;--bg2:#0d1117;--bg3:#161b22;--bg4:#1c2128;
  --bdr:#21262d;--bdr2:#30363d;
  --ink:#e6edf3;--ink2:#c9d1d9;--ink3:#8b949e;
  --b:#58a6ff;--g:#3fb950;--r:#f85149;--y:#d29922;--p:#bc8cff;--c:#39d0d8;--o:#f0883e;
  --b2:rgba(88,166,255,.12);--g2:rgba(63,185,80,.12);--r2:rgba(248,81,73,.12);
  --y2:rgba(210,153,34,.12);--p2:rgba(188,140,255,.12);
}
body{background:var(--bg);color:var(--ink2);font:12px/1.5 'SF Mono',Consolas,monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}
/* header */
header{background:var(--bg2);border-bottom:1px solid var(--bdr2);padding:0 14px;display:flex;align-items:center;height:44px;gap:0;flex-shrink:0}
.hbrand{font-size:14px;font-weight:700;color:var(--b);letter-spacing:-.3px;margin-right:14px;white-space:nowrap}
.hkpis{display:flex;align-items:stretch;gap:0;flex:1;overflow:hidden;height:100%}
.hkpi{display:flex;flex-direction:column;justify-content:center;padding:0 12px;border-right:1px solid var(--bdr);min-width:0;flex-shrink:0}
.hkl{font-size:8px;font-weight:500;letter-spacing:.8px;text-transform:uppercase;color:var(--ink3);margin-bottom:1px}
.hkv{font-size:16px;font-weight:700;white-space:nowrap}
.hright{display:flex;align-items:center;gap:8px;margin-left:auto;padding-left:12px;flex-shrink:0}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--g);box-shadow:0 0 6px var(--g);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.sess-badge{padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700;background:var(--b2);color:var(--b);border:1px solid rgba(88,166,255,.25)}
#hclock{font-size:11px;color:var(--ink3)}
.hbtn{padding:3px 10px;border-radius:4px;border:1px solid var(--bdr2);background:var(--bg3);color:var(--ink2);font:11px/1.4 'SF Mono',monospace;cursor:pointer}
.hbtn:hover{border-color:var(--b);color:var(--b)}
/* compliance bar */
#cbar{background:#0a1628;border-bottom:1px solid rgba(88,166,255,.15);padding:3px 14px;font-size:10px;color:var(--ink3);flex-shrink:0;display:flex;align-items:center;gap:6px}
#cbar strong{color:var(--c)}
/* nav */
nav{display:flex;border-bottom:1px solid var(--bdr2);background:var(--bg2);flex-shrink:0;overflow-x:auto}
.ntab{padding:8px 14px;cursor:pointer;color:var(--ink3);white-space:nowrap;border-bottom:2px solid transparent;font-size:12px;transition:color .15s}
.ntab:hover{color:var(--ink)}
.ntab.on{color:var(--b);border-bottom-color:var(--b)}
.nbadge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:16px;border-radius:8px;font-size:9px;font-weight:700;padding:0 4px;margin-left:4px;background:var(--r2);color:var(--r)}
/* pages */
.npage{display:none;flex:1;overflow-y:auto}
.npage.on{display:block}
.pg{padding:14px;display:flex;flex-direction:column;gap:12px}
/* card */
.card{background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;overflow:hidden}
.card-hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--bdr);background:var(--bg3)}
.card-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:6px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--g)}
.dot.r{background:var(--r)}.dot.y{background:var(--y)}
.cmeta{font-size:10px;color:var(--ink3)}
/* kpi strip */
.kstrip{display:flex;border-bottom:1px solid var(--bdr)}
.ks{flex:1;padding:10px 12px;border-right:1px solid var(--bdr);min-width:0}
.ks:last-child{border-right:none}
.ksl{font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.ksv{font-size:18px;font-weight:700;white-space:nowrap}
.kss{font-size:9px;color:var(--ink3);margin-top:1px}
/* section label */
.slabel{font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;padding:7px 14px 4px;font-weight:600;border-bottom:1px solid var(--bdr)}
/* table */
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:11px}
th{color:var(--ink3);font-weight:400;font-size:9px;text-transform:uppercase;letter-spacing:.4px;padding:5px 8px;border-bottom:1px solid var(--bdr);text-align:left;white-space:nowrap;position:sticky;top:0;background:var(--bg3);z-index:1}
td{padding:4px 8px;border-bottom:1px solid var(--bdr);white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--bg4)}
.nd{text-align:center;color:var(--ink3);padding:20px!important}
/* color helpers */
.cb{color:var(--b)}.cg{color:var(--g)}.cr{color:var(--r)}.cy{color:var(--y)}
.cp{color:var(--p)}.cc{color:var(--c)}.co{color:var(--o)}.cd{color:var(--ink3)}
.fw{font-weight:700}
/* badges */
.bd{display:inline-flex;align-items:center;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;line-height:1.4}
.bd-buy{background:var(--g2);color:var(--g);border:1px solid rgba(63,185,80,.25)}
.bd-sell{background:var(--r2);color:var(--r);border:1px solid rgba(248,81,73,.25)}
.bd-ab{background:var(--b2);color:var(--b);border:1px solid rgba(88,166,255,.2)}
.bd-bw{background:var(--p2);color:var(--p);border:1px solid rgba(188,140,255,.2)}
.bd-asia{background:rgba(57,208,216,.1);color:var(--c);border:1px solid rgba(57,208,216,.2)}
.bd-lon{background:rgba(63,185,80,.1);color:var(--g);border:1px solid rgba(63,185,80,.2)}
.bd-ny{background:rgba(240,136,62,.1);color:var(--o);border:1px solid rgba(240,136,62,.2)}
.bd-fx{background:rgba(88,166,255,.1);color:var(--b);border:1px solid rgba(88,166,255,.2)}
.bd-sk{background:rgba(188,140,255,.1);color:var(--p);border:1px solid rgba(188,140,255,.2)}
.bd-ix{background:rgba(57,208,216,.1);color:var(--c);border:1px solid rgba(57,208,216,.2)}
.bd-cm{background:rgba(210,153,34,.1);color:var(--y);border:1px solid rgba(210,153,34,.2)}
/* filter bar */
.fbar{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--bdr);flex-wrap:wrap}
.fl{font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.4px;margin-right:2px}
.fb{padding:2px 8px;border-radius:3px;border:1px solid var(--bdr2);background:transparent;color:var(--ink3);font:10px 'SF Mono',monospace;cursor:pointer}
.fb:hover{color:var(--ink);border-color:var(--bdr2)}
.fb.on{background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)}
/* milestone header colors */
.adv-th{background:rgba(248,81,73,.06)!important;color:var(--r)!important}
.fav-th{background:rgba(63,185,80,.06)!important;color:var(--g)!important}
/* best/worst toggle */
.bw-section{border-top:1px solid var(--bdr);padding:10px 14px}
.bw-hdr{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.bw-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
/* 2-col layout */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--bdr)}
.col-pane{background:var(--bg2)}
.col-hdr{padding:7px 12px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;gap:6px}
.col-hdr-title{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
/* 3-col explain */
.explain-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}
.explain-cell{background:var(--bg2);padding:12px 14px}
.explain-step{font-size:8px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;font-weight:600}
.explain-body{font-size:10px;color:var(--ink2);line-height:1.6}
/* signal stat grid */
.sig-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}
.sig-cell{background:var(--bg2);padding:10px 12px}
.sig-lbl{font-size:8px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.sig-val{font-size:20px;font-weight:700}
/* overview ov-grid */
.ov-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--bdr);margin:0}
.ov-card{background:var(--bg2);padding:14px 14px 12px;border-bottom:1px solid var(--bdr)}
.ov-lbl{font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.ov-val{font-size:28px;font-weight:700;line-height:1;margin-bottom:3px}
.ov-sub{font-size:9px;color:var(--ink3)}
/* spinner */
.spin{display:inline-block;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<!-- ═══════════════════════ HEADER ═════════════════════════════ -->
<header>
  <div class="hbrand">PRONTO·AI</div>
  <div class="hkpis">
    <div class="hkpi"><div class="hkl">Balance MT5</div><div class="hkv cb" id="h-bal">—</div></div>
    <div class="hkpi"><div class="hkl">Live P&amp;L</div><div class="hkv" id="h-pnl">—</div></div>
    <div class="hkpi"><div class="hkl">% Gain</div><div class="hkv cy" id="h-gain">—</div></div>
    <div class="hkpi"><div class="hkl">Open Trades</div><div class="hkv cg" id="h-pos">—</div></div>
    <div class="hkpi"><div class="hkl">Ghost Trackers</div><div class="hkv cp" id="h-gh">—</div></div>
    <div class="hkpi"><div class="hkl">Closed Ghosts</div><div class="hkv cc" id="h-ghh">—</div></div>
    <div class="hkpi"><div class="hkl">Risk/Trade</div><div class="hkv cd">${(FIXED_RISK_PCT*100).toFixed(4)}%</div></div>
    <div class="hkpi"><div class="hkl">TP Locked</div><div class="hkv cy" id="h-tp">—</div></div>
  </div>
  <div class="hright">
    <div class="live-dot"></div>
    <div class="sess-badge" id="h-sess">—</div>
    <div id="hclock">—</div>
    <button class="hbtn" onclick="loadAll()">⟳ Refresh</button>
    <button class="hbtn" id="recover-btn" onclick="recoverPositions()" title="Scan MT5 en herstel ontbrekende posities na een deploy" style="border-color:var(--y);color:var(--y)">⚡ Recover</button>
  </div>
</header>

<!-- ═══════════════════════ COMPLIANCE BAR ══════════════════════ -->
<div id="cbar">
  <strong id="cbar-date">Compliance</strong>
  <span>—</span>
  <span id="cbar-desc">all EV, statistics &amp; P&amp;L calculated only on trades after this date</span>
</div>


<!-- ═══════════════════════ NAV ════════════════════════════════ -->
    <!-- FTMO Drawdown Warning + MetaAPI Circuit Warning -->
    <div id="dd-warning" style="display:none;padding:6px 16px;font-size:10px;font-weight:700;color:var(--o);border-bottom:1px solid rgba(230,81,0,.3);text-align:center"></div>
    <div id="h-circuit" style="display:none;padding:4px 16px;font-size:9px;color:var(--r);background:rgba(183,28,28,.1);border-bottom:1px solid rgba(183,28,28,.2);text-align:center">⚡ MetaAPI connection issues — live data may be delayed. Retrying automatically.</div>
    <nav id="main-nav">
  <div class="ntab on"  data-page="overview">Overview</div>
  <div class="ntab"     data-page="signals">Signals &amp; Blocked<span class="nbadge" id="nb-sig" style="pointer-events:none;display:none"></span></div>
  <div class="ntab"     data-page="ghosts">Ghost Tracker<span class="nbadge" id="nb-gh" style="pointer-events:none;background:var(--p2);color:var(--p)">—</span></div>
  <div class="ntab"     data-page="shadow-playbook" style="color:var(--p)">Shadow Tracker<span class="nbadge" id="nb-bgt" style="pointer-events:none;display:none;background:var(--p2);color:var(--p)"></span></div>
  <div class="ntab"     data-page="ev">EV TP + SL Optimizer</div>
</nav>

<!-- ══════════════ PAGE: OVERVIEW ══════════════════════════════ -->
<div class="npage on" id="page-overview">
  <div class="pg">

<!-- Date filter: ov -->
  <div id="ov-dfbar" style="background:var(--bg3);border-bottom:1px solid var(--bdr);padding:5px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <span style="font-size:9px;font-weight:700;color:var(--b);text-transform:uppercase;letter-spacing:.5px">📅</span>
    <span class="fl">Open:</span>
    <input type="date" id="ov-open-from" autocomplete="off" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span style="color:var(--ink3);font-size:10px">→</span>
    <input type="date" id="ov-open-to"   autocomplete="off" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
        <span class="fl" style="margin-left:8px">Closed:</span>
        <input type="date" id="ov-close-from" autocomplete="off" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
        <span style="color:var(--ink3);font-size:10px">→</span>
        <input type="date" id="ov-close-to"   autocomplete="off" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <button class="fb" onclick="applyOVFilter()" style="margin-left:4px;background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)">Apply</button>
    <button class="fb" onclick="resetOVFilter()" style="margin-left:2px">Reset</button>
    <span id="ov-df-active" style="display:table-cell;font-size:9px;color:var(--y);font-weight:700;margin-left:4px">⚠ Gefilterd</span>
  </div>
  <div id="ov-filter-hint" style="display:none;padding:6px 14px;background:rgba(210,153,34,.1);border-bottom:1px solid rgba(210,153,34,.2);font-size:10px;color:var(--y)"></div>
  <div id="ov-db-loading" style="display:none;padding:8px 14px;background:rgba(59,130,246,.08);border-bottom:1px solid rgba(59,130,246,.2);font-size:10px;color:#60a5fa">
    ⟳ Database initialiseert — data wordt opgehaald... (max 30 seconden)
  </div>

    <!-- KPI Row -->
    <div class="card" style="overflow:hidden">
      <div class="ov-grid">
        <div class="ov-card"><div class="ov-lbl">Balance MT5</div><div class="ov-val cb" id="ov-bal">—</div><div class="ov-sub">Live account equity</div></div>
        <div class="ov-card"><div class="ov-lbl">Live P&amp;L</div><div class="ov-val" id="ov-pnl">—</div><div class="ov-sub" id="ov-pnl-sub">open positions</div></div>
        <div class="ov-card"><div class="ov-lbl">% Gain (compliance+)</div><div class="ov-val cy" id="ov-gain">—</div><div class="ov-sub" id="ov-gain-sub">realized P&amp;L / balance</div></div>
        <div class="ov-card"><div class="ov-lbl">Open Trades</div><div class="ov-val cg" id="ov-open">—</div><div class="ov-sub" id="ov-open-sub">live positions</div></div>
        <div class="ov-card"><div class="ov-lbl">Compliance Trades</div><div class="ov-val" id="ov-comp">—</div><div class="ov-sub">closed after compliance date</div></div>
      </div>
    </div>

    <!-- Performance Statistics KPIs -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot cg"></div>Performance Statistics</div>
        <div class="cmeta" id="perf-meta">loading…</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:0;border-bottom:1px solid var(--bdr)">
        <div class="ks"><div class="ksl">Win Rate</div><div class="ksv cy" id="p-wr">—</div></div>
        <div class="ks"><div class="ksl">Profit Factor</div><div class="ksv" id="p-pf">—</div></div>
        <div class="ks"><div class="ksl">Expectancy</div><div class="ksv" id="p-exp">—</div></div>
        <div class="ks"><div class="ksl">Sharpe Ratio</div><div class="ksv" id="p-sharpe">—</div></div>
        <div class="ks"><div class="ksl">Max Drawdown</div><div class="ksv cr" id="p-dd">—</div></div>
        <div class="ks"><div class="ksl">Calmar Ratio</div><div class="ksv" id="p-calmar">—</div></div>
        <div class="ks"><div class="ksl">Avg Win</div><div class="ksv cg" id="p-avgwin">—</div></div>
        <div class="ks"><div class="ksl">Avg Loss</div><div class="ksv cr" id="p-avgloss">—</div></div>
      </div>
    </div>

    <!-- Trade Activity by Session/VWAP/Direction + asset split -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="wr-dot"></div>Trade Activity — Session / VWAP / Direction</div>
        <div class="cmeta" id="wr-meta">loading…</div>
      </div>
      <!-- Summary strip -->
      <div class="kstrip">
        <div class="ks"><div class="ksl">Total</div><div class="ksv cb" id="wr-tot">—</div><div class="kss" id="wr-tot-n"></div></div>
        <div class="ks"><div class="ksl">Buy</div><div class="ksv cg" id="wr-buy">—</div></div>
        <div class="ks"><div class="ksl">Sell</div><div class="ksv cr" id="wr-sell">—</div></div>
        <div class="ks"><div class="ksl">Above VWAP</div><div class="ksv cb" id="wr-ab">—</div></div>
        <div class="ks"><div class="ksl">Below VWAP</div><div class="ksv cp" id="wr-bw">—</div></div>
        <div class="ks"><div class="ksl">Asia</div><div class="ksv cc" id="wr-asia">—</div></div>
        <div class="ks"><div class="ksl">London</div><div class="ksv cg" id="wr-lon">—</div></div>
        <div class="ks"><div class="ksl">New York</div><div class="ksv co" id="wr-ny">—</div></div>
      </div>
      <!-- Table per combo per asset type -->
      <div id="wr-type-tabs" style="display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--bdr)">
        <span class="fl">Asset:</span>
        <button class="fb on" onclick="setWRType('all',this)">All</button>
        <button class="fb" onclick="setWRType('forex',this)">Forex</button>
        <button class="fb" onclick="setWRType('stock',this)">Stock</button>
        <button class="fb" onclick="setWRType('index',this)">Index</button>
        <button class="fb" onclick="setWRType('commodity',this)">Commodity</button>
      </div>
      <div class="tw">
        <table><thead><tr>
          <th>Session</th><th>Direction</th><th>VWAP</th><th>Asset Type</th>
          <th># Trades</th><th>Win %</th><th>Avg P&amp;L €</th><th>Total Lots</th><th>Buy</th><th>Sell</th><th>Above</th><th>Below</th>
        </tr></thead><tbody id="wr-body"><tr><td colspan="12" class="nd"><span class="spin">⟳</span></td></tr></tbody></table>
      </div>
    </div>

    <!-- Open Trades Daily Breakdown (current open positions only) -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot y"></div>Today — Open Trades Performance</div>
        <div class="cmeta" id="ov-open-meta">current open positions only</div>
      </div>
      <div class="kstrip">
        <div class="ks"><div class="ksl">Open Now</div><div class="ksv cg" id="ov-open-cnt">—</div></div>
        <div class="ks"><div class="ksl">Wins (P&L &gt; 0)</div><div class="ksv cg" id="ov-win-cnt">—</div></div>
        <div class="ks"><div class="ksl">Losses (P&L &lt; 0)</div><div class="ksv cr" id="ov-loss-cnt">—</div></div>
        <div class="ks"><div class="ksl">WR Open</div><div class="ksv cy" id="ov-wr-open">—</div></div>
        <div class="ks"><div class="ksl">Best Peak+RR</div><div class="ksv cg" id="ov-best-rr">—</div></div>
        <div class="ks"><div class="ksl">Worst Peak−%</div><div class="ksv cr" id="ov-worst-neg">—</div></div>
        <div class="ks"><div class="ksl">Total Lots</div><div class="ksv cd" id="ov-lots">—</div></div>
        <div class="ks"><div class="ksl">Unrealized P&L</div><div class="ksv" id="ov-live-pnl">—</div></div>
      </div>
    </div>

    <!-- Daily Open Trades Performance Log — saved per day -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot b"></div>Open Trades — Daily Performance Log</div>
        <div class="cmeta">Opgeslagen per dag · WR enkel op open posities · live P&L = unrealized op moment van snapshot</div>
      </div>
      <div class="tw">
        <table id="daily-open-tbl"><thead><tr>
          <th>Datum</th><th># Trades</th>
          <th>Win</th><th>Loss</th><th>WR Open</th>
          <th style="color:var(--g)">Best Peak+RR</th>
          <th style="color:var(--r)">Worst Peak−%</th>
          <th>Max Risk %</th>
          <th>Lots</th><th>Unrealized P&L</th>
        </tr></thead>
        <tbody id="daily-open-body"><tr><td colspan="11" class="nd" style="font-size:9px">Wordt ingevuld bij eerste positions sync</td></tr></tbody></table>
      </div>
    </div>

    <!-- Trade Distribution — full breakdown -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="dist-dot"></div>Trade Distribution — All Closed Trades Logged</div>
        <div class="cmeta" id="dist-meta">loading…</div>
      </div>
      <!-- Top-level totals per type -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)">
        <div style="background:var(--bg2);padding:10px 14px">
          <div style="font-size:8px;color:var(--b);text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:6px">FOREX</div>
          <div style="font-size:22px;font-weight:700;color:var(--b)" id="d-fx-tot">—</div>
          <div style="display:flex;gap:8px;margin-top:6px;font-size:9px">
            <span class="cg">Buy <strong id="d-fx-buy">—</strong></span>
            <span class="cr">Sell <strong id="d-fx-sell">—</strong></span>
            <span class="cb">Above <strong id="d-fx-ab">—</strong></span>
            <span class="cp">Below <strong id="d-fx-bw">—</strong></span>
          </div>
        </div>
        <div style="background:var(--bg2);padding:10px 14px">
          <div style="font-size:8px;color:var(--c);text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:6px">INDEX</div>
          <div style="font-size:22px;font-weight:700;color:var(--c)" id="d-ix-tot">—</div>
          <div style="display:flex;gap:8px;margin-top:6px;font-size:9px">
            <span class="cg">Buy <strong id="d-ix-buy">—</strong></span>
            <span class="cr">Sell <strong id="d-ix-sell">—</strong></span>
            <span class="cb">Above <strong id="d-ix-ab">—</strong></span>
            <span class="cp">Below <strong id="d-ix-bw">—</strong></span>
          </div>
        </div>
        <div style="background:var(--bg2);padding:10px 14px">
          <div style="font-size:8px;color:var(--p);text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:6px">STOCK</div>
          <div style="font-size:22px;font-weight:700;color:var(--p)" id="d-sk-tot">—</div>
          <div style="display:flex;gap:8px;margin-top:6px;font-size:9px">
            <span class="cg">Buy <strong id="d-sk-buy">—</strong></span>
            <span class="cr">Sell <strong id="d-sk-sell">—</strong></span>
            <span class="cb">Above <strong id="d-sk-ab">—</strong></span>
            <span class="cp">Below <strong id="d-sk-bw">—</strong></span>
          </div>
        </div>
        <div style="background:var(--bg2);padding:10px 14px">
          <div style="font-size:8px;color:var(--y);text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:6px">COMMODITY</div>
          <div style="font-size:22px;font-weight:700;color:var(--y)" id="d-cm-tot">—</div>
          <div style="display:flex;gap:8px;margin-top:6px;font-size:9px">
            <span class="cg">Buy <strong id="d-cm-buy">—</strong></span>
            <span class="cr">Sell <strong id="d-cm-sell">—</strong></span>
            <span class="cb">Above <strong id="d-cm-ab">—</strong></span>
            <span class="cp">Below <strong id="d-cm-bw">—</strong></span>
          </div>
        </div>
      </div>
      <!-- Grand totals strip -->
      <div class="kstrip">
        <div class="ks"><div class="ksl">Total Logged</div><div class="ksv cb" id="d-tot">—</div></div>
        <div class="ks"><div class="ksl">Total Buy</div><div class="ksv cg" id="d-buy">—</div></div>
        <div class="ks"><div class="ksl">Total Sell</div><div class="ksv cr" id="d-sell">—</div></div>
        <div class="ks"><div class="ksl">Above VWAP</div><div class="ksv cb" id="d-ab">—</div></div>
        <div class="ks"><div class="ksl">Below VWAP</div><div class="ksv cp" id="d-bw">—</div></div>
        <div class="ks"><div class="ksl">Buy+Above</div><div class="ksv cg" id="ft-ba">—</div></div>
        <div class="ks"><div class="ksl">Buy+Below</div><div class="ksv cg" id="ft-bb">—</div></div>
        <div class="ks"><div class="ksl">Sell+Above</div><div class="ksv cr" id="ft-sa">—</div></div>
        <div class="ks"><div class="ksl">Sell+Below</div><div class="ksv cr" id="ft-sb">—</div></div>
      </div>
      <!-- Detailed breakdown table: per type × session × dir × vwap -->
      <div class="tw">
        <table><thead><tr>
          <th>Asset Type</th><th>Session</th>
          <th class="cg">Buy+Above</th><th class="cg">Buy+Below</th>
          <th class="cr">Sell+Above</th><th class="cr">Sell+Below</th>
          <th>Subtotal</th><th>Avg P&L €</th><th>Total Lots</th>
        </tr></thead>
        <tbody id="dist-body"><tr><td colspan="9" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        <tfoot><tr style="background:var(--bg3);font-weight:700">
          <td class="cy" colspan="2">TOTAL</td>
          <td id="ft-ba2" class="cg">—</td><td id="ft-bb2" class="cg">—</td>
          <td id="ft-sa2" class="cr">—</td><td id="ft-sb2" class="cr">—</td>
          <td id="ft-t" class="cb fw">—</td>
          <td id="ft-avg" class="cd">—</td>
          <td id="ft-lots" class="cd">—</td>
        </tr></tfoot>
        </table>
      </div>
    </div>

    <!-- Daily Breakdown -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="daily-dot"></div>Daily Breakdown — Performance (compliance+)</div>
        <div class="cmeta" id="daily-meta">loading…</div>
      </div>
      <div class="tw">
        <table><thead><tr>
          <th>Date</th><th># Trades</th><th>Win</th><th>Loss</th><th>WR Open</th>
          <th style="color:var(--g)">Max Peak+RR</th><th style="color:var(--r)">Max Peak−%</th>
          <th>Lots</th><th>Unrealized P&L</th>
        </tr></thead><tbody id="daily-body"><tr><td colspan="7" class="nd"><span class="spin">⟳</span></td></tr></tbody></table>
      </div>

      <!-- Best 10 / Worst 10 Setups — from Ghost History PEAK+RR -->
      <div class="bw-section">
        <div class="bw-hdr">
          <span style="font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px">Based on Ghost History PEAK+RR — all time</span>
        </div>
        <div class="bw-grid">
          <div>
            <div style="font-size:9px;color:var(--g);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:700">🏆 Best 10 Setups — Peak+RR</div>
            <table style="font-size:10px"><thead><tr>
              <th>Symbol</th><th>Type</th><th>Dir</th><th>Sess</th><th>VWAP</th><th>Peak+RR</th><th>Peak-RR%</th><th>P&amp;L</th><th>Date</th>
            </tr></thead><tbody id="best-body"></tbody></table>
          </div>
          <div>
            <div style="font-size:9px;color:var(--r);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:700">💀 Worst 10 Setups — Peak+RR</div>
            <table style="font-size:10px"><thead><tr>
              <th>Symbol</th><th>Type</th><th>Dir</th><th>Sess</th><th>VWAP</th><th>Peak+RR</th><th>Peak-RR%</th><th>P&amp;L</th><th>Date</th>
            </tr></thead><tbody id="worst-body"></tbody></table>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: OPEN POSITIONS ════════════════════════ -->
<div class="npage" id="page-positions">
  <div class="pg">
<!-- Open Positions: no date filter — always shows LIVE MT5 positions -->
  <div id="pos-dfbar" style="background:var(--bg3);border-bottom:1px solid var(--bdr);padding:5px 14px;display:flex;align-items:center;gap:6px">
    <span style="font-size:9px;color:var(--g);font-weight:700">● LIVE</span>
    <span style="font-size:9px;color:var(--ink3)">Toont alle actuele MT5 posities · geen datumfilter van toepassing · ververst elke 30s</span>
  </div>
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="pos-dot"></div>Open Positions — Live</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="fb" id="pos-ms-btn" onclick="togglePosMilestones()" title="Toon/verberg milestone kolommen per 0.1R">± Milestones</button>
          <div class="cmeta" id="pos-meta">loading…</div>
        </div>
      </div>
      <div class="kstrip" id="pos-strip" style="display:none">
        <div class="ks"><div class="ksl">Open</div><div class="ksv cg" id="pos-cnt">—</div></div>
        <div class="ks"><div class="ksl">P&amp;L</div><div class="ksv" id="pos-pnl">—</div></div>
        <div class="ks"><div class="ksl">Buy</div><div class="ksv cg" id="pos-buy">—</div></div>
        <div class="ks"><div class="ksl">Sell</div><div class="ksv cr" id="pos-sell">—</div></div>
        <div class="ks"><div class="ksl">Stock</div><div class="ksv cp" id="pos-sk">—</div></div>
        <div class="ks"><div class="ksl">Index</div><div class="ksv cc" id="pos-ix">—</div></div>
        <div class="ks"><div class="ksl">Forex</div><div class="ksv cb" id="pos-fx">—</div></div>
        <div class="ks"><div class="ksl">Commodity</div><div class="ksv cy" id="pos-cm">—</div></div>
        <div class="ks"><div class="ksl">Ghosted</div><div class="ksv cp" id="pos-gh">—</div></div>
      </div>
      <div class="tw">
        <table id="pos-tbl">
          <thead><tr>
            <th style="position:sticky;left:0;background:var(--bg3);z-index:2;min-width:90px">Symbol</th>
            <th>Type</th><th>Dir</th><th>VWAP</th><th>Sess</th>
            <th title="Current RR vs entry">RR Now</th>
            <th title="Best favorable RR reached" style="color:var(--g)">Peak+RR</th>
            <th title="Worst adverse excursion" style="color:var(--r)">Peak−RR%</th>
            <th title="Distance to TP in RR">→TP</th>
            <th title="VWAP band % at signal time">Band%</th>
            <th title="Times this optimizer key was traded today">#Key</th>
            <th class="adv-th" style="font-size:8px">-1.0</th><th class="adv-th" style="font-size:8px">-0.9</th><th class="adv-th" style="font-size:8px">-0.8</th><th class="adv-th" style="font-size:8px">-0.7</th><th class="adv-th" style="font-size:8px">-0.6</th><th class="adv-th" style="font-size:8px">-0.5</th><th class="adv-th" style="font-size:8px">-0.4</th><th class="adv-th" style="font-size:8px">-0.3</th><th class="adv-th" style="font-size:8px">-0.2</th><th class="adv-th" style="font-size:8px">-0.1</th>
            <th class="fav-th" style="font-size:8px">+0.1</th><th class="fav-th" style="font-size:8px">+0.2</th><th class="fav-th" style="font-size:8px">+0.3</th><th class="fav-th" style="font-size:8px">+0.4</th><th class="fav-th" style="font-size:8px">+0.5</th><th class="fav-th" style="font-size:8px">+0.6</th><th class="fav-th" style="font-size:8px">+0.7</th><th class="fav-th" style="font-size:8px">+0.8</th><th class="fav-th" style="font-size:8px">+0.9</th><th class="fav-th" style="font-size:8px">+1.0</th><th class="fav-th" style="font-size:8px">+1.1</th><th class="fav-th" style="font-size:8px">+1.2</th><th class="fav-th" style="font-size:8px">+1.3</th><th class="fav-th" style="font-size:8px">+1.4</th><th class="fav-th" style="font-size:8px">+1.5</th><th class="fav-th" style="font-size:8px">+1.6</th><th class="fav-th" style="font-size:8px">+1.7</th><th class="fav-th" style="font-size:8px">+1.8</th><th class="fav-th" style="font-size:8px">+1.9</th><th class="fav-th" style="font-size:8px">+2.0</th><th class="fav-th" style="font-size:8px">+2.1</th><th class="fav-th" style="font-size:8px">+2.2</th><th class="fav-th" style="font-size:8px">+2.3</th><th class="fav-th" style="font-size:8px">+2.4</th><th class="fav-th" style="font-size:8px">+2.5</th><th class="fav-th" style="font-size:8px">+2.6</th><th class="fav-th" style="font-size:8px">+2.7</th><th class="fav-th" style="font-size:8px">+2.8</th><th class="fav-th" style="font-size:8px">+2.9</th><th class="fav-th" style="font-size:8px">+3.0</th><th class="fav-th" style="font-size:8px">+3.1</th><th class="fav-th" style="font-size:8px">+3.2</th><th class="fav-th" style="font-size:8px">+3.3</th><th class="fav-th" style="font-size:8px">+3.4</th><th class="fav-th" style="font-size:8px">+3.5</th><th class="fav-th" style="font-size:8px">+3.6</th><th class="fav-th" style="font-size:8px">+3.7</th><th class="fav-th" style="font-size:8px">+3.8</th><th class="fav-th" style="font-size:8px">+3.9</th><th class="fav-th" style="font-size:8px">+4.0</th><th class="fav-th" style="font-size:8px">+4.1</th><th class="fav-th" style="font-size:8px">+4.2</th><th class="fav-th" style="font-size:8px">+4.3</th><th class="fav-th" style="font-size:8px">+4.4</th><th class="fav-th" style="font-size:8px">+4.5</th><th class="fav-th" style="font-size:8px">+4.6</th><th class="fav-th" style="font-size:8px">+4.7</th><th class="fav-th" style="font-size:8px">+4.8</th><th class="fav-th" style="font-size:8px">+4.9</th><th class="fav-th" style="font-size:8px">+5.0</th><th class="fav-th" style="font-size:8px">+5.1</th><th class="fav-th" style="font-size:8px">+5.2</th><th class="fav-th" style="font-size:8px">+5.3</th><th class="fav-th" style="font-size:8px">+5.4</th><th class="fav-th" style="font-size:8px">+5.5</th><th class="fav-th" style="font-size:8px">+5.6</th><th class="fav-th" style="font-size:8px">+5.7</th><th class="fav-th" style="font-size:8px">+5.8</th><th class="fav-th" style="font-size:8px">+5.9</th><th class="fav-th" style="font-size:8px">+6.0</th><th class="fav-th" style="font-size:8px">+6.1</th><th class="fav-th" style="font-size:8px">+6.2</th><th class="fav-th" style="font-size:8px">+6.3</th><th class="fav-th" style="font-size:8px">+6.4</th><th class="fav-th" style="font-size:8px">+6.5</th>
            <th>Entry</th><th>SL</th><th>TP</th>
            <th>P&amp;L €</th><th>Lots</th><th>Risk %</th>
            <th>Opened</th>
          </tr></thead>
          <tbody id="pos-body"><tr><td colspan="40" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: GHOST TRACKER (active + finalized + grouped) ═══ -->
<div class="npage" id="page-ghosts">
  <div class="pg">

  <!-- ── SECTION 1: ACTIVE ──────────────────────────────────────── -->
  <div id="gh-dfbar" style="background:var(--bg3);border-bottom:1px solid var(--bdr);padding:5px 14px;display:flex;align-items:center;gap:6px">
    <span style="font-size:9px;color:var(--p);font-weight:700">● ACTIEF</span>
    <span style="font-size:9px;color:var(--ink3)">Sluit automatisch bij −1R SL hit · Peak+RR en Peak−RR live bijgehouden · ververst elke 30s</span>
  </div>
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="gh-dot"></div>Ghost Tracker — Active (until −1R SL hit)</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="fb" onclick="toggleMsCols()">± Milestones</button>
          <div class="cmeta" id="gh-meta">Phantom SL = real SL at open · runs until −1R hit</div>
        </div>
      </div>
      <div class="kstrip" id="gh-strip" style="display:none">
        <div class="ks"><div class="ksl">Active</div><div class="ksv cp" id="gh-cnt">—</div></div>
        <div class="ks"><div class="ksl">Peak+RR Best</div><div class="ksv cg" id="gh-best">—</div></div>
        <div class="ks"><div class="ksl">Peak−RR Worst</div><div class="ksv cr" id="gh-worst">—</div></div>
        <div class="ks"><div class="ksl">Buy</div><div class="ksv cg" id="gh-buy">—</div></div>
        <div class="ks"><div class="ksl">Sell</div><div class="ksv cr" id="gh-sell">—</div></div>
        <div class="ks"><div class="ksl">Stock</div><div class="ksv cp" id="gh-sk">—</div></div>
        <div class="ks"><div class="ksl">Index</div><div class="ksv cc" id="gh-ix">—</div></div>
        <div class="ks"><div class="ksl">Forex</div><div class="ksv cb" id="gh-fx">—</div></div>
        <div class="ks"><div class="ksl">Avg Elapsed</div><div class="ksv cd" id="gh-el">—</div></div>
      </div>
      <div class="tw">
        <table id="gh-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th title="Best favorable RR reached so far" style="color:var(--g)">Peak+RR</th>
            <th title="Worst adverse excursion as % of SL" style="color:var(--r)">Peak−RR%</th>
            <th title="VWAP band % at signal">Band%</th>
            <th title="Times this optimizer key was traded">#Key</th>
            <th class="adv-th" style="font-size:8px">-1.0</th><th class="adv-th" style="font-size:8px">-0.9</th><th class="adv-th" style="font-size:8px">-0.8</th><th class="adv-th" style="font-size:8px">-0.7</th><th class="adv-th" style="font-size:8px">-0.6</th><th class="adv-th" style="font-size:8px">-0.5</th><th class="adv-th" style="font-size:8px">-0.4</th><th class="adv-th" style="font-size:8px">-0.3</th><th class="adv-th" style="font-size:8px">-0.2</th><th class="adv-th" style="font-size:8px">-0.1</th>
            <th class="fav-th" style="font-size:8px">+0.1</th><th class="fav-th" style="font-size:8px">+0.2</th><th class="fav-th" style="font-size:8px">+0.3</th><th class="fav-th" style="font-size:8px">+0.4</th><th class="fav-th" style="font-size:8px">+0.5</th><th class="fav-th" style="font-size:8px">+0.6</th><th class="fav-th" style="font-size:8px">+0.7</th><th class="fav-th" style="font-size:8px">+0.8</th><th class="fav-th" style="font-size:8px">+0.9</th><th class="fav-th" style="font-size:8px">+1.0</th><th class="fav-th" style="font-size:8px">+1.1</th><th class="fav-th" style="font-size:8px">+1.2</th><th class="fav-th" style="font-size:8px">+1.3</th><th class="fav-th" style="font-size:8px">+1.4</th><th class="fav-th" style="font-size:8px">+1.5</th><th class="fav-th" style="font-size:8px">+1.6</th><th class="fav-th" style="font-size:8px">+1.7</th><th class="fav-th" style="font-size:8px">+1.8</th><th class="fav-th" style="font-size:8px">+1.9</th><th class="fav-th" style="font-size:8px">+2.0</th><th class="fav-th" style="font-size:8px">+2.1</th><th class="fav-th" style="font-size:8px">+2.2</th><th class="fav-th" style="font-size:8px">+2.3</th><th class="fav-th" style="font-size:8px">+2.4</th><th class="fav-th" style="font-size:8px">+2.5</th><th class="fav-th" style="font-size:8px">+2.6</th><th class="fav-th" style="font-size:8px">+2.7</th><th class="fav-th" style="font-size:8px">+2.8</th><th class="fav-th" style="font-size:8px">+2.9</th><th class="fav-th" style="font-size:8px">+3.0</th><th class="fav-th" style="font-size:8px">+3.1</th><th class="fav-th" style="font-size:8px">+3.2</th><th class="fav-th" style="font-size:8px">+3.3</th><th class="fav-th" style="font-size:8px">+3.4</th><th class="fav-th" style="font-size:8px">+3.5</th><th class="fav-th" style="font-size:8px">+3.6</th><th class="fav-th" style="font-size:8px">+3.7</th><th class="fav-th" style="font-size:8px">+3.8</th><th class="fav-th" style="font-size:8px">+3.9</th><th class="fav-th" style="font-size:8px">+4.0</th><th class="fav-th" style="font-size:8px">+4.1</th><th class="fav-th" style="font-size:8px">+4.2</th><th class="fav-th" style="font-size:8px">+4.3</th><th class="fav-th" style="font-size:8px">+4.4</th><th class="fav-th" style="font-size:8px">+4.5</th><th class="fav-th" style="font-size:8px">+4.6</th><th class="fav-th" style="font-size:8px">+4.7</th><th class="fav-th" style="font-size:8px">+4.8</th><th class="fav-th" style="font-size:8px">+4.9</th><th class="fav-th" style="font-size:8px">+5.0</th><th class="fav-th" style="font-size:8px">+5.1</th><th class="fav-th" style="font-size:8px">+5.2</th><th class="fav-th" style="font-size:8px">+5.3</th><th class="fav-th" style="font-size:8px">+5.4</th><th class="fav-th" style="font-size:8px">+5.5</th><th class="fav-th" style="font-size:8px">+5.6</th><th class="fav-th" style="font-size:8px">+5.7</th><th class="fav-th" style="font-size:8px">+5.8</th><th class="fav-th" style="font-size:8px">+5.9</th><th class="fav-th" style="font-size:8px">+6.0</th><th class="fav-th" style="font-size:8px">+6.1</th><th class="fav-th" style="font-size:8px">+6.2</th><th class="fav-th" style="font-size:8px">+6.3</th><th class="fav-th" style="font-size:8px">+6.4</th><th class="fav-th" style="font-size:8px">+6.5</th>
            <th>Lots</th><th>Entry</th><th>SL</th><th>TP</th><th>P&amp;L €</th>
            <th>Opened</th><th>Elapsed</th>
          </tr></thead>
          <tbody id="gh-body"><tr><td colspan="100" class="nd">No active ghost trackers</td></tr></tbody>
        </table>
      </div>
    </div>

  <!-- ── SECTION 2: FINALIZED LOG ──────────────────────────────── -->
  <div style="background:var(--bg3);border:1px solid var(--bdr);border-radius:6px 6px 0 0;padding:5px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px">
    <span style="font-size:9px;font-weight:700;color:var(--b);text-transform:uppercase;letter-spacing:.5px">📅</span>
    <span class="fl">Closed:</span>
    <input type="date" id="hist-open-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span style="color:var(--ink3);font-size:10px">→</span>
    <input type="date" id="hist-open-to" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <button class="fb" onclick="applyHISTFilter()" style="margin-left:4px;background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)">Apply</button>
    <button class="fb" onclick="resetHISTFilter()" style="margin-left:2px">Reset</button>
    <span id="hist-df-active" style="display:table-cell;font-size:9px;color:var(--y);font-weight:700;margin-left:4px">⚠ Gefilterd</span>
  </div>
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="ghf-dot"></div>Ghost Finalized — Chronological · 1 rij = 1 trade · Milestones −1R tot +6.5R inline</div>
        <div style="display:flex;gap:6px;align-items:center">
          <div class="cmeta" id="ghf-meta">loading…</div>
        </div>
      </div>
      <div class="tw" style="max-height:380px;overflow-y:auto">
        <table id="ghf-tbl">
          <thead><tr>
            <th>#</th><th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th>Stop</th><th>TP RR</th>
            <th style="color:var(--g)">Peak+RR</th>
            <th style="color:var(--r)">Peak−RR%</th>
            <th>Band%</th><th>#Key</th><th>P&amp;L €</th><th>Lots</th>
            <th class="adv-th" style="font-size:8px">T−1.0R</th><th class="adv-th" style="font-size:8px">T−0.9R</th><th class="adv-th" style="font-size:8px">T−0.8R</th><th class="adv-th" style="font-size:8px">T−0.7R</th><th class="adv-th" style="font-size:8px">T−0.6R</th><th class="adv-th" style="font-size:8px">T−0.5R</th><th class="adv-th" style="font-size:8px">T−0.4R</th><th class="adv-th" style="font-size:8px">T−0.3R</th><th class="adv-th" style="font-size:8px">T−0.2R</th><th class="adv-th" style="font-size:8px">T−0.1R</th><th class="fav-th" style="font-size:8px">T+0.1R</th><th class="fav-th" style="font-size:8px">T+0.2R</th><th class="fav-th" style="font-size:8px">T+0.3R</th><th class="fav-th" style="font-size:8px">T+0.4R</th><th class="fav-th" style="font-size:8px">T+0.5R</th><th class="fav-th" style="font-size:8px">T+0.6R</th><th class="fav-th" style="font-size:8px">T+0.7R</th><th class="fav-th" style="font-size:8px">T+0.8R</th><th class="fav-th" style="font-size:8px">T+0.9R</th><th class="fav-th" style="font-size:8px">T+1.0R</th><th class="fav-th" style="font-size:8px">T+1.1R</th><th class="fav-th" style="font-size:8px">T+1.2R</th><th class="fav-th" style="font-size:8px">T+1.3R</th><th class="fav-th" style="font-size:8px">T+1.4R</th><th class="fav-th" style="font-size:8px">T+1.5R</th><th class="fav-th" style="font-size:8px">T+1.6R</th><th class="fav-th" style="font-size:8px">T+1.7R</th><th class="fav-th" style="font-size:8px">T+1.8R</th><th class="fav-th" style="font-size:8px">T+1.9R</th><th class="fav-th" style="font-size:8px">T+2.0R</th><th class="fav-th" style="font-size:8px">T+2.1R</th><th class="fav-th" style="font-size:8px">T+2.2R</th><th class="fav-th" style="font-size:8px">T+2.3R</th><th class="fav-th" style="font-size:8px">T+2.4R</th><th class="fav-th" style="font-size:8px">T+2.5R</th><th class="fav-th" style="font-size:8px">T+2.6R</th><th class="fav-th" style="font-size:8px">T+2.7R</th><th class="fav-th" style="font-size:8px">T+2.8R</th><th class="fav-th" style="font-size:8px">T+2.9R</th><th class="fav-th" style="font-size:8px">T+3.0R</th><th class="fav-th" style="font-size:8px">T+3.1R</th><th class="fav-th" style="font-size:8px">T+3.2R</th><th class="fav-th" style="font-size:8px">T+3.3R</th><th class="fav-th" style="font-size:8px">T+3.4R</th><th class="fav-th" style="font-size:8px">T+3.5R</th><th class="fav-th" style="font-size:8px">T+3.6R</th><th class="fav-th" style="font-size:8px">T+3.7R</th><th class="fav-th" style="font-size:8px">T+3.8R</th><th class="fav-th" style="font-size:8px">T+3.9R</th><th class="fav-th" style="font-size:8px">T+4.0R</th><th class="fav-th" style="font-size:8px">T+4.1R</th><th class="fav-th" style="font-size:8px">T+4.2R</th><th class="fav-th" style="font-size:8px">T+4.3R</th><th class="fav-th" style="font-size:8px">T+4.4R</th><th class="fav-th" style="font-size:8px">T+4.5R</th><th class="fav-th" style="font-size:8px">T+4.6R</th><th class="fav-th" style="font-size:8px">T+4.7R</th><th class="fav-th" style="font-size:8px">T+4.8R</th><th class="fav-th" style="font-size:8px">T+4.9R</th><th class="fav-th" style="font-size:8px">T+5.0R</th><th class="fav-th" style="font-size:8px">T+5.1R</th><th class="fav-th" style="font-size:8px">T+5.2R</th><th class="fav-th" style="font-size:8px">T+5.3R</th><th class="fav-th" style="font-size:8px">T+5.4R</th><th class="fav-th" style="font-size:8px">T+5.5R</th><th class="fav-th" style="font-size:8px">T+5.6R</th><th class="fav-th" style="font-size:8px">T+5.7R</th><th class="fav-th" style="font-size:8px">T+5.8R</th><th class="fav-th" style="font-size:8px">T+5.9R</th><th class="fav-th" style="font-size:8px">T+6.0R</th><th class="fav-th" style="font-size:8px">T+6.1R</th><th class="fav-th" style="font-size:8px">T+6.2R</th><th class="fav-th" style="font-size:8px">T+6.3R</th><th class="fav-th" style="font-size:8px">T+6.4R</th><th class="fav-th" style="font-size:8px">T+6.5R</th>
            <th>Opened</th><th>Elapsed</th>
          </tr></thead>
          <tbody id="ghf-body"><tr><td colspan="22" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>

  <!-- ── SECTION 3: GROUPED PER OPTIMIZER KEY ──────────────────── -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="ghh-dot"></div>Ghost Finalized — Grouped per Optimizer Key</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="fb" id="ghh-ms-btn" onclick="toggleGHHMilestones()">± Milestones</button>
          <div class="cmeta" id="ghh-meta">loading…</div>
        </div>
      </div>
      <div class="fbar">
        <span class="fl">Session:</span>
        <button class="fb on" onclick="setGHF('sess','all',this)">All</button>
        <button class="fb" onclick="setGHF('sess','asia',this)">Asia</button>
        <button class="fb" onclick="setGHF('sess','london',this)">London</button>
        <button class="fb" onclick="setGHF('sess','ny',this)">NY</button>
        &nbsp;<span class="fl">Dir:</span>
        <button class="fb on" onclick="setGHF('dir','all',this)">All</button>
        <button class="fb" onclick="setGHF('dir','buy',this)">Buy</button>
        <button class="fb" onclick="setGHF('dir','sell',this)">Sell</button>
        &nbsp;<span class="fl">Type:</span>
        <button class="fb on" onclick="setGHF('type','all',this)">All</button>
        <button class="fb" onclick="setGHF('type','forex',this)">Forex</button>
        <button class="fb" onclick="setGHF('type','stock',this)">Stock</button>
        <button class="fb" onclick="setGHF('type','index',this)">Index</button>
        <button class="fb" onclick="setGHF('type','commodity',this)">Comm</button>
      </div>
      <div class="tw">
        <table id="ghh-tbl">
          <thead><tr>
            <th style="width:16px"></th>
            <th>Symbol</th><th>Type</th><th>Sess</th><th>Dir</th><th>VWAP</th>
            <th title="Total finalized ghost trades (SL hit only)"># Ghosts</th>
            <th title="Times this optimizer key was traded today">#Key</th>
            <th class="cr" title="Phantom SL hit">SL Hits</th>
            <th style="color:var(--y)" title="Win% = trades where Peak+RR exceeded 1.0R">Win%&gt;1R</th>
            <th style="color:var(--g)" title="Win% = trades where Peak+RR exceeded 2.0R">Win%&gt;2R</th>
            <th class="cy" title="EV estimate: (WR1R × avgPeak) − (1−WR1R)">EV Score</th>
            <th class="cc" title="Best TP RR based on max EV">Best TP RR</th>
            <th class="cd" title="Total realized P&L">P&amp;L</th>
          </tr></thead>
          <tbody id="ghh-body"><tr><td colspan="14" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>

<!-- ══════════════ PAGE: GHOST FINALIZED ════════════════════════ -->
<div class="npage" id="page-ev">
  <div class="pg">
  <div style="background:rgba(88,166,255,.06);border:1px solid rgba(88,166,255,.15);border-radius:6px;padding:10px 14px;font-size:9px;color:var(--ink3);line-height:1.7">
    <strong style="color:var(--b)">EV TP + SL Optimizer</strong> — Volledig gevoed door finalized ghost data (enkel HIT SL = −1R). Win% = Peak+RR &gt; 1R (positieve EV check) en Peak+RR &gt; 2R (TP check). Best TP = RR waarbij EV maximaal is op basis van alle gefinaliseerde trades per optimizer key. Min 5 ghosts vereist · TP wordt automatisch bijgewerkt bij elke nieuwe finalisatie.
  </div>
<!-- Date filter: ev -->
  <div id="ev-dfbar" style="background:var(--bg3);border-bottom:1px solid var(--bdr);padding:5px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <span style="font-size:9px;font-weight:700;color:var(--b);text-transform:uppercase;letter-spacing:.5px">📅</span>
    <span class="fl">Closed:</span>
    <input type="date" id="ev-open-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span style="color:var(--ink3);font-size:10px">→</span>
    <input type="date" id="ev-open-to"   style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <button class="fb" onclick="applyEVFilter()" style="margin-left:4px;background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)">Apply</button>
    <button class="fb" onclick="resetEVFilter()" style="margin-left:2px">Reset</button>
    <span id="ev-df-active" style="display:table-cell;font-size:9px;color:var(--y);font-weight:700;margin-left:4px">⚠ Gefilterd</span>
  </div>
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="ev-dot"></div>EV / TP Optimizer — Finalized Ghost Data per Optimizer Key</div>
        <div class="cmeta" id="ev-meta">source: ghost_trades where stop_reason = phantom_sl · min 5 ghosts for EV lock</div>
      </div>
      <div class="fbar">
        <span class="fl">Type:</span>
        <button class="fb on" onclick="setEVF('type','all',this)">All</button>
        <button class="fb" onclick="setEVF('type','forex',this)">Forex</button>
        <button class="fb" onclick="setEVF('type','index',this)">Index</button>
        <button class="fb" onclick="setEVF('type','stock',this)">Stock</button>
        <button class="fb" onclick="setEVF('type','commodity',this)">Comm</button>
        &nbsp;<span class="fl">Session:</span>
        <button class="fb on" onclick="setEVF('sess','all',this)">All</button>
        <button class="fb" onclick="setEVF('sess','asia',this)">Asia</button>
        <button class="fb" onclick="setEVF('sess','london',this)">London</button>
        <button class="fb" onclick="setEVF('sess','ny',this)">New York</button>
        &nbsp;<span class="fl">Dir:</span>
        <button class="fb on" onclick="setEVF('dir','all',this)">All</button>
        <button class="fb" onclick="setEVF('dir','buy',this)">Buy</button>
        <button class="fb" onclick="setEVF('dir','sell',this)">Sell</button>
        &nbsp;<span class="fl">Min Ghosts:</span>
        <button class="fb on" onclick="setEVF('min','5',this)">≥5</button>
        <button class="fb" onclick="setEVF('min','10',this)">≥10</button>
        <button class="fb" onclick="setEVF('min','20',this)">≥20</button>
      </div>
      <div class="kstrip">
        <div class="ks"><div class="ksl">Combos Shown</div><div class="ksv cb" id="ev-cnt">0</div></div>
        <div class="ks"><div class="ksl">With Ghost Data</div><div class="ksv cc" id="ev-data">0</div></div>
        <div class="ks"><div class="ksl">TP Locked (≥10)</div><div class="ksv cg" id="ev-lock">0</div></div>
        <div class="ks"><div class="ksl">Positive EV Combos</div><div class="ksv cg" id="ev-pos">0</div></div>
        <div class="ks"><div class="ksl">Total P&amp;L (finalized)</div><div class="ksv cy" id="ev-pnl">—</div></div>
      </div>
      <div class="tw">
        <table id="ev-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th title="Total finalized ghosts (HIT SL only)"># Ghosts</th>
            <th title="Times key was traded total">#Key</th>
            <th title="Avg VWAP band% at signal">Avg Band%</th>
            <th title="Avg best RR reached before SL hit" style="color:var(--g)">Avg Peak+RR</th>
            <th title="Max best RR ever reached" style="color:var(--g)">Max Peak+RR</th>
            <th title="Win% = trades where Peak+RR exceeded 1.0R" style="color:var(--y)">Win%&gt;1R</th>
            <th title="Win% = trades where Peak+RR exceeded 2.0R" style="color:var(--g)">Win%&gt;2R</th>
            <th title="Recommended TP based on EV maximisation" style="color:var(--c)">Best TP RR</th>
            <th title="EV = (Win%1R × AvgPeak+) − (1−Win%1R)" class="cy">EV Score</th>
            <th title="TP lock status">Status</th><th title="Current locked TP">TP Lock</th>
            <th title="Avg time to SL hit">Avg T→SL</th>
            <th>P&amp;L €</th>
          </tr></thead>
          <tbody id="ev-body"><tr><td colspan="18" class="nd">No combos match current filters</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

<!-- EV SL OPTIMIZER — inline continuation of EV page -->
  <div style="background:var(--bg3);border-bottom:1px solid var(--bdr);padding:5px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <span style="font-size:9px;font-weight:700;color:var(--b);text-transform:uppercase;letter-spacing:.5px">📅</span>
    <span class="fl">SL Open:</span>
    <input type="date" id="evsl-open-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span style="color:var(--ink3);font-size:10px">→</span>
    <input type="date" id="evsl-open-to"   style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span class="fl" style="margin-left:8px">Closed:</span>
    <input type="date" id="evsl-close-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span style="color:var(--ink3);font-size:10px">→</span>
    <input type="date" id="evsl-close-to"   style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <button class="fb" onclick="applyEVSLFilter()" style="margin-left:4px;background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)">Apply</button>
    <button class="fb" onclick="resetEVSLFilter()" style="margin-left:2px">Reset</button>
    <span id="evsl-df-active" style="display:table-cell;font-size:9px;color:var(--y);font-weight:700;margin-left:4px">⚠ Gefilterd</span>
  </div>
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="evsl-dot"></div>SL Optimizer — Adverse Excursion Analysis per Key · Read Only</div>
        <div class="cmeta">Based on Peak−RR% from finalized ghosts · never auto-applied · min 5 ghosts required</div>
      </div>
      <div class="explain-grid">
        <div class="explain-cell">
          <div class="explain-step">How it works</div>
          <div class="explain-body">Every finalized ghost records <span class="cr fw">Peak−RR%</span> — how deep price went against the trade (as % of SL distance) before the phantom SL was hit. 0% = never moved against. 100% = hit full SL.</div>
        </div>
        <div class="explain-cell">
          <div class="explain-step">Reading the data</div>
          <div class="explain-body"><span class="cg fw">Avg Peak− low (&lt;30%)</span>: trades barely went adverse — room to tighten SL. <span class="cy fw">Medium (30–70%)</span>: moderate adverse — careful tightening. <span class="cr fw">High (&gt;70%)</span>: trades used most of the SL — keep current SL.</div>
        </div>
        <div class="explain-cell">
          <div class="explain-step">Action</div>
          <div class="explain-body">Green = potential SL tightening possible. Yellow = monitor more data. Red = keep current SL. Always verify with risk manager. This is advisory data only — never automatically applied.</div>
        </div>
      </div>
      <div class="tw">
        <table id="evsl-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Ghosts</th><th>#Key</th><th>Avg Band%</th>
            <th style="color:var(--r)">Avg Peak−%</th>
            <th style="color:var(--r)">Max Peak−%</th>
            <th style="color:var(--r)">Trades &gt;80% adverse</th>
            <th>SL Advice</th><th>Potential Tighten</th>
            <th style="color:var(--g)">Shadow Avg Peak−</th>
          </tr></thead>
          <tbody id="evsl-body"><tr><td colspan="15" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>
        <div class="explain-cell">
          <div class="explain-step">Step 3 — What to do</div>
          <div class="explain-body"><span class="cg fw">Green (p90 &lt;50%)</span>: strong tightening possible. <span class="cy fw">Yellow (50–75%)</span>: moderate. <span class="cr fw">Red (&gt;75%)</span>: keep SL as-is. Always verify with risk manager before applying.</div>
        </div>
      </div>
      <div class="tw">
        <table id="evsl-tbl">
  </div>
</div>

<!-- ══════════════ PAGE: SIGNALS & BLOCKED ═════════════════════ -->
<div class="npage" id="page-signals">
  <div class="pg">
<!-- Date filter: sig -->
  <div id="sig-dfbar" style="background:var(--bg3);border-bottom:1px solid var(--bdr);padding:5px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <span style="font-size:9px;font-weight:700;color:var(--b);text-transform:uppercase;letter-spacing:.5px">📅</span>
    <span class="fl">Open:</span>
    <input type="date" id="sig-open-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span style="color:var(--ink3);font-size:10px">→</span>
    <input type="date" id="sig-open-to"   style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
        <span class="fl" style="margin-left:8px">Closed:</span>
        <input type="date" id="sig-close-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
        <span style="color:var(--ink3);font-size:10px">→</span>
        <input type="date" id="sig-close-to"   style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <button class="fb" onclick="applySIGFilter()" style="margin-left:4px;background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)">Apply</button>
    <button class="fb" onclick="resetSIGFilter()" style="margin-left:2px">Reset</button>
    <span id="sig-df-active" style="display:table-cell;font-size:9px;color:var(--y);font-weight:700;margin-left:4px">⚠ Gefilterd</span>
  </div>
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="sig-dot"></div>Signal Intelligence — Placed, Blocked &amp; Errors</div>
        <div class="cmeta" id="sig-meta">loading…</div>
      </div>
      <!-- KPI grid -->
      <div class="sig-grid">
        <div class="sig-cell"><div class="sig-lbl">Total Signals</div><div class="sig-val cb" id="sig-tot">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Placed</div><div class="sig-val cg" id="sig-placed">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Conversion%</div><div class="sig-val cy" id="sig-conv">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Total Blocked</div><div class="sig-val cr" id="blk-tot">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Duplicate Open</div><div class="sig-val co" id="blk-dup">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">VWAP Exhausted</div><div class="sig-val cp" id="blk-vw">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Outside Window</div><div class="sig-val cd" id="blk-win">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">Currency Budget</div><div class="sig-val cy" id="blk-cur">—</div></div>
        <div class="sig-cell"><div class="sig-lbl">NY Dead Zone</div><div class="sig-val cr" id="blk-ny">—</div></div>
      </div>

      <!-- v14.2: Full signal log — shows where each signal went -->
      <div class="col-hdr" style="border-top:1px solid var(--bdr)">
        <div style="width:6px;height:6px;border-radius:50%;background:var(--b)"></div>
        <span class="col-hdr-title" style="color:var(--b)">All Signals — Where did each signal go?</span>
        <span class="cmeta" style="margin-left:auto">PLACED → Ghost Tracker · BLOCKED → Shadow Tracker · ERRORS below</span>
      </div>
      <div class="tw" style="max-height:500px;overflow-y:auto">
        <table id="placed-tbl"><thead><tr>
          <th>Time</th><th>Symbol</th><th>Type</th><th>Dir</th><th>Session</th><th>VWAP</th>
          <th>Entry</th><th>SL%</th><th>Band%</th><th>Outcome</th><th>Destination</th>
          <th title="How many times this optimizer key was traded today">#Key Today</th>
          <th title="Total times this optimizer key was traded all-time">#Key All</th>
          <th>Latency</th>
        </tr></thead><tbody id="placed-body"><tr><td colspan="14" class="nd">—</td></tr></tbody></table>
      </div>

      <!-- Errors section -->
      <div class="col-hdr" style="border-top:1px solid var(--bdr)">
        <div style="width:6px;height:6px;border-radius:50%;background:var(--r)"></div>
        <span class="col-hdr-title" style="color:var(--r)">Signal Errors — Did not reach Ghost or Shadow</span>
        <div class="cmeta" id="sig-err-meta" style="margin-left:auto">fetch failed · no positionId · MetaAPI timeout · other</div>
      </div>
      <div class="tw" style="max-height:300px;overflow-y:auto">
        <table id="sig-err-tbl"><thead><tr>
          <th>Time</th><th>Symbol</th><th>Dir</th><th>Session</th>
          <th>Error Type</th><th>Error Detail</th><th>Entry</th><th>Retried</th>
        </tr></thead><tbody id="sig-err-body"><tr><td colspan="8" class="nd">—</td></tr></tbody></table>
      </div>

      <!-- Blocked Raw all-time -->
      <div class="col-hdr" style="border-top:1px solid var(--bdr)">
        <div style="width:6px;height:6px;border-radius:50%;background:var(--p)"></div>
        <span class="col-hdr-title" style="color:var(--p)">Blocked Raw — All Time (compliance+)</span>
        <div class="cmeta" id="blkraw-meta" style="margin-left:auto">grouped per symbol / dir / vwap / session / reason</div>
      </div>
      <div class="tw">
        <table id="blkraw-tbl"><thead><tr>
          <th>Symbol</th><th>Dir</th><th>VWAP</th><th>Session</th>
          <th>Outcome</th><th>Reject Reason</th><th># Blocked</th><th>Last Seen</th>
        </tr></thead><tbody id="blkraw-body"><tr><td colspan="8" class="nd"><span class="spin">⟳</span></td></tr></tbody></table>
      </div>

      <!-- Band analysis 2-col -->
      <div class="two-col" style="border-top:1px solid var(--bdr)">
        <div class="col-pane">
          <div class="col-hdr">
            <span class="col-hdr-title cy">Band 150–250%</span>
            <span class="cmeta" style="margin-left:auto">rejected — ghost potential shown</span>
          </div>
          <div class="tw"><table id="b150-tbl"><thead><tr>
            <th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th><th>n</th>
            <th>Avg RR</th><th>Max RR</th><th>Avg SL%</th>
          </tr></thead><tbody id="b150-body"><tr><td colspan="8" class="nd">—</td></tr></tbody></table></div>
        </div>
        <div class="col-pane" style="border-left:1px solid var(--bdr)">
          <div class="col-hdr">
            <span class="col-hdr-title cr">Band 250–350%</span>
            <span class="cmeta" style="margin-left:auto">extreme outliers · read only</span>
          </div>
          <div class="tw"><table id="b250-tbl"><thead><tr>
            <th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th><th>n</th>
            <th>Avg RR</th><th>Max RR</th><th>Avg SL%</th>
          </tr></thead><tbody id="b250-body"><tr><td colspan="8" class="nd">—</td></tr></tbody></table></div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: SHADOW PLAYBOOK ════════════════════════ -->
<div class="npage" id="page-shadow-playbook">
  <div class="pg">

    <!-- Info banner -->
    <div style="background:rgba(188,140,255,.08);border:1px solid rgba(188,140,255,.2);border-radius:8px;padding:12px 16px;font-size:10px;color:var(--ink3);line-height:1.7">
      <strong style="color:var(--p)">🔮 Shadow Ghosts</strong> — Invisible ghost trackers voor ALLE geblokkeerde signalen.
      Bijgehouden met dezelfde precisie als echte ghosts: 0.1R milestones, peak RR, SL tracking tot −1R.<br>
      <strong style="color:var(--o)">NY Dead Zone (15:30–18:00)</strong> · 
      <strong style="color:var(--c)">Outside Window (21:00–02:00)</strong> ·
      <strong style="color:var(--r)">VWAP Exhaustion (&gt;150% band)</strong> ·
      <strong style="color:var(--y)">Duplicate (per nummer bijgehouden)</strong><br>
      Doel: nakijken of onze filters te streng zijn en gems identificeren die niet naar live gaan.
      Ghost tracker = trades die live gaan. Shadow = alles wat geblokkeerd wordt.
    </div>

    <!-- Date filter -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">🗓 Periode Filter — Blocked Ghost History</div>
        <div class="cmeta" id="bgt-date-meta">Alle blocked ghosts</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;padding:8px 14px;flex-wrap:wrap">
        <span class="fl">Van:</span>
        <input type="date" id="bgt-from" style="background:var(--bg3);border:1px solid var(--bdr2);color:var(--ink2);padding:3px 7px;border-radius:3px;font:10px 'SF Mono',monospace" onchange="loadShadowPlaybook()">
        <span class="fl">Tot:</span>
        <input type="date" id="bgt-to"   style="background:var(--bg3);border:1px solid var(--bdr2);color:var(--ink2);padding:3px 7px;border-radius:3px;font:10px 'SF Mono',monospace" onchange="loadShadowPlaybook()">
        <button class="fb" onclick="document.getElementById('bgt-from').value='';document.getElementById('bgt-to').value='';loadShadowPlaybook()">Reset</button>
      </div>
    </div>

    <!-- Active blocked ghosts -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r"></div>Actieve Blocked Ghosts — Live Tracking</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="fb" id="bgt-ms-btn" style="display:none">± Milestones</button>
          <div class="cmeta" id="bgt-active-meta">loading…</div>
        </div>
      </div>
      <div class="tw">
        <table>
          <thead><tr>
            <th style="position:sticky;left:0;background:var(--bg3)">Symbol</th>
            <th>Type</th><th>Block</th><th>Dir</th><th>VWAP</th><th>Sess</th>
            <th>Entry</th>
            <th style="color:var(--g)" title="Best favorable RR reached">Peak+RR</th>
            <th style="color:var(--r)" title="Worst adverse excursion as % of SL">Peak−RR%</th>
            <th title="VWAP band % at block">Band%</th>
            <th title="Times this optimizer key was blocked">#Key</th>
            <th title="When signal was blocked">Blocked At</th><th>Elapsed</th>
            <th class="adv-th" style="font-size:7.5px">-1.0</th><th class="adv-th" style="font-size:7.5px">-0.9</th><th class="adv-th" style="font-size:7.5px">-0.8</th><th class="adv-th" style="font-size:7.5px">-0.7</th><th class="adv-th" style="font-size:7.5px">-0.6</th><th class="adv-th" style="font-size:7.5px">-0.5</th><th class="adv-th" style="font-size:7.5px">-0.4</th><th class="adv-th" style="font-size:7.5px">-0.3</th><th class="adv-th" style="font-size:7.5px">-0.2</th><th class="adv-th" style="font-size:7.5px">-0.1</th>
            <th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+0.1</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+0.2</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+0.3</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+0.4</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+0.5</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+0.6</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+0.7</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+0.8</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+0.9</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+1.0</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+1.1</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+1.2</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+1.3</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+1.4</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+1.5</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+1.6</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+1.7</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+1.8</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+1.9</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+2.0</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+2.1</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+2.2</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+2.3</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+2.4</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+2.5</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+2.6</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+2.7</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+2.8</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+2.9</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+3.0</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+3.1</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+3.2</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+3.3</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+3.4</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+3.5</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+3.6</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+3.7</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+3.8</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+3.9</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+4.0</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+4.1</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+4.2</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+4.3</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+4.4</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+4.5</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+4.6</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+4.7</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+4.8</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+4.9</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+5.0</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+5.1</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+5.2</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+5.3</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+5.4</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+5.5</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+5.6</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+5.7</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+5.8</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+5.9</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+6.0</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+6.1</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+6.2</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+6.3</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+6.4</th><th class="fav-th" style="font-size:7px;min-width:22px;text-align:center">+6.5</th>
          </tr></thead>
          <tbody id="bgt-active-body"><tr><td colspan="55" class="nd">Geen actieve shadow trackers</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- Sub-tabs voor 3 block types -->
    <div class="card">
      <div style="display:flex;border-bottom:1px solid var(--bdr);background:var(--bg3)">
        <div id="bgt-tab-ny"   class="ntab on" onclick="setBGTTab('ny')"  style="color:var(--o);border-bottom:2px solid var(--o)">⏰ Timezone — NY Dead + Night</div>
        <div id="bgt-tab-dup"  class="ntab"    onclick="setBGTTab('dup')" style="">📌 Duplicate Position</div>
        <div id="bgt-tab-vwap" class="ntab"    onclick="setBGTTab('vwap')" style="">📊 VWAP Exhaustion</div>
      </div>

      <!-- NY DEAD ZONE -->
      <div id="bgt-pane-ny">
        <div style="padding:8px 14px;background:rgba(240,136,62,.05);border-bottom:1px solid rgba(240,136,62,.15);font-size:10px;color:var(--ink3)">
          <strong style="color:var(--o)">NY Dead Zone</strong> (15:30–18:00 Brussels): Forex, Commodity &amp; Stocks geblokkeerd bij NYSE open.
          Indexes worden nooit geblokkeerd. Track hier of bepaalde symbolen/richtingen het waard zijn toe te voegen.
        </div>
        <div class="fbar">
          <span class="fl">Session:</span>
          <button class="fb on" onclick="setBGTFilter('ny','sess','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('ny','sess','ny',this)">NY</button>
          <button class="fb" onclick="setBGTFilter('ny','sess','london',this)">London</button>
          &nbsp;<span class="fl">Dir:</span>
          <button class="fb on" onclick="setBGTFilter('ny','dir','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('ny','dir','buy',this)">Buy</button>
          <button class="fb" onclick="setBGTFilter('ny','dir','sell',this)">Sell</button>
          &nbsp;<span class="fl">Type:</span>
          <button class="fb on" onclick="setBGTFilter('ny','type','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('ny','type','forex',this)">Forex</button>
          <button class="fb" onclick="setBGTFilter('ny','type','stock',this)">Stock</button>
          <button class="fb" onclick="setBGTFilter('ny','type','commodity',this)">Comm</button>
        </div>
        <div class="tw"><table id="bgt-ny-tbl">
          <thead><tr>
            <th style="width:16px"></th>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Shadows</th><th class="cr">SL Hits</th>
            <th class="cg">Avg Peak+</th><th class="cg">Max Peak+</th><th class="cr">Avg Peak−</th>
            <th>Avg Band%</th><th style="color:var(--y)">Win%&gt;1R</th><th style="color:var(--g)">Win%&gt;2R</th>
            <th>Verdict</th>
          </tr></thead>
          <tbody id="bgt-ny-body"><tr><td colspan="15" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table></div>
      </div>

      <!-- OUTSIDE HOURS merged into NY tab (21:00-02:00 = NY session) -->
      <div id="bgt-pane-ow" style="display:none!important;visibility:hidden">
        <div style="padding:8px 14px;background:rgba(255,152,0,.05);border-bottom:1px solid rgba(255,152,0,.15);font-size:10px;color:var(--ink3)">
          <strong style="color:var(--o)">🌙 Outside Hours (21:00–02:00 Brussels)</strong>: Alle signalen buiten het handelvenster. Markt gesloten — zelfde als NY Dead Zone maar voor de nachtperiode.
          Track hier of bepaalde setups ook 's nachts handelen zouden moeten.
        </div>
        <div style="padding:6px 14px;display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--bdr)">
          <span style="font-size:9px;color:var(--ink3)">SESSION:</span>
          <button class="fb on" onclick="setBGTFilter('ow','sess','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('ow','sess','ny',this)">NY</button>
          <button class="fb" onclick="setBGTFilter('ow','sess','london',this)">London</button>
          <span style="font-size:9px;color:var(--ink3);margin-left:8px">DIR:</span>
          <button class="fb on" onclick="setBGTFilter('ow','dir','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('ow','dir','buy',this)">Buy</button>
          <button class="fb" onclick="setBGTFilter('ow','dir','sell',this)">Sell</button>
          <span style="font-size:9px;color:var(--ink3);margin-left:8px">TYPE:</span>
          <button class="fb on" onclick="setBGTFilter('ow','type','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('ow','type','forex',this)">Forex</button>
          <button class="fb" onclick="setBGTFilter('ow','type','stock',this)">Stock</button>
          <button class="fb" onclick="setBGTFilter('ow','type','index',this)">Index</button>
          <button class="fb" onclick="setBGTFilter('ow','type','commodity',this)">Comm</button>
        </div>
        <div class="tw"><table id="bgt-tbl-ow"><thead><tr>
          <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
          <th># Blocked</th><th>SL Hits</th><th>Avg Peak+RR</th><th>Max Peak+RR</th><th>Avg Peak−RR%</th><th>Verdict</th>
        </tr></thead><tbody id="bgt-body-ow"><tr><td colspan="12" class="nd">Geen blocked ghost data</td></tr></tbody></table></div>
      </div>

      <!-- DUPLICATE POSITION -->
      <div id="bgt-pane-dup" style="display:none">
        <div style="padding:8px 14px;background:rgba(210,153,34,.05);border-bottom:1px solid rgba(210,153,34,.15);font-size:10px;color:var(--ink3)">
          <strong style="color:var(--y)">Duplicate Position</strong>: Signalen geblokkeerd omdat er al een open trade is voor dezelfde key (symbol/session/dir/vwap).
          Track hier of het waard is om meerdere posities per key toe te staan.
        </div>
        <div class="fbar">
          <span class="fl">Session:</span>
          <button class="fb on" onclick="setBGTFilter('dup','sess','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('dup','sess','asia',this)">Asia</button>
          <button class="fb" onclick="setBGTFilter('dup','sess','london',this)">London</button>
          <button class="fb" onclick="setBGTFilter('dup','sess','ny',this)">NY</button>
          &nbsp;<span class="fl">Dir:</span>
          <button class="fb on" onclick="setBGTFilter('dup','dir','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('dup','dir','buy',this)">Buy</button>
          <button class="fb" onclick="setBGTFilter('dup','dir','sell',this)">Sell</button>
          &nbsp;<span class="fl">Type:</span>
          <button class="fb on" onclick="setBGTFilter('dup','type','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('dup','type','forex',this)">Forex</button>
          <button class="fb" onclick="setBGTFilter('dup','type','stock',this)">Stock</button>
          <button class="fb" onclick="setBGTFilter('dup','type','index',this)">Index</button>
          <button class="fb" onclick="setBGTFilter('dup','type','commodity',this)">Comm</button>
        </div>
        <div class="tw"><table id="bgt-dup-tbl">
          <thead><tr>
            <th style="width:16px"></th>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Shadows</th><th class="cr">SL Hits</th>
            <th class="cg">Avg Peak+</th><th class="cg">Max Peak+</th><th class="cr">Avg Peak−</th>
            <th>Avg Band%</th><th style="color:var(--y)">Win%&gt;1R</th><th style="color:var(--g)">Win%&gt;2R</th>
            <th>Verdict</th>
          </tr></thead>
          <tbody id="bgt-dup-body"><tr><td colspan="15" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table></div>
      </div>

      <!-- VWAP EXHAUSTION -->
      <div id="bgt-pane-vwap" style="display:none">
        <div style="padding:8px 14px;background:rgba(248,81,73,.05);border-bottom:1px solid rgba(248,81,73,.15);font-size:10px;color:var(--ink3)">
          <strong style="color:var(--r)">VWAP Exhaustion</strong>: Signalen geblokkeerd omdat de prijs ≥ 150% van de VWAP band is.
          Track hier de band% bij blokkering — zijn er symbolen die op 160%, 200%+ nog steeds goede setups geven?
          Overweeg de drempel per symbol/combo aan te passen.
        </div>
        <div class="fbar">
          <span class="fl">Session:</span>
          <button class="fb on" onclick="setBGTFilter('vwap','sess','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('vwap','sess','asia',this)">Asia</button>
          <button class="fb" onclick="setBGTFilter('vwap','sess','london',this)">London</button>
          <button class="fb" onclick="setBGTFilter('vwap','sess','ny',this)">NY</button>
          &nbsp;<span class="fl">Dir:</span>
          <button class="fb on" onclick="setBGTFilter('vwap','dir','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('vwap','dir','buy',this)">Buy</button>
          <button class="fb" onclick="setBGTFilter('vwap','dir','sell',this)">Sell</button>
          &nbsp;<span class="fl">Band%:</span>
          <button class="fb on" onclick="setBGTFilter('vwap','band','all',this)">All</button>
          <button class="fb" onclick="setBGTFilter('vwap','band','150_200',this)">150–200%</button>
          <button class="fb" onclick="setBGTFilter('vwap','band','200_300',this)">200–300%</button>
          <button class="fb" onclick="setBGTFilter('vwap','band','300plus',this)">300%+</button>
        </div>
        <div class="tw"><table id="bgt-vwap-tbl">
          <thead><tr>
            <th style="width:16px"></th>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Shadows</th><th class="cr">SL Hits</th>
            <th class="cg">Avg Peak+</th><th class="cg">Max Peak+</th><th class="cr">Avg Peak−</th>
            <th>Avg Band%</th><th style="color:var(--y)">Win%&gt;1R</th><th style="color:var(--g)">Win%&gt;2R</th>
            <th>Avg Band%</th><th>Verdict</th>
          </tr></thead>
          <tbody id="bgt-vwap-body"><tr><td colspan="15" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table></div>
      </div>
    </div>
  </div>
</div>

<script>
'use strict';

// ── Symbol type lookup ────────────────────────────────────────────
const FOREX_S = new Set(['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF',
  'EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','NZDUSD','USDCAD']);
const INDEX_S = new Set([
  'DE30EUR','NAS100USD','UK100GBP','US30USD',
  'GER40.cash','US100.cash','UK100.cash','US30.cash',
  'NAS100','US100','UK100','US30','GER40','DE30','US30USD',
  'NAS100USD','USTEC','SPX500','DAX']);
const COMM_S  = new Set(['XAUUSD','XAGUSD','XAUEUR','GOLD','XAUUSD.cash','WTIUSD','BCOUSD']);
function symType(s){
  if(!s) return 'stock';
  const u = s.toUpperCase();
  if(FOREX_S.has(u)||FOREX_S.has(s)) return 'forex';
  if(INDEX_S.has(u)||INDEX_S.has(s)) return 'index';
  if(COMM_S.has(u)||COMM_S.has(s))   return 'commodity';
  return 'stock';
}

// ── Milestone steps: -1.0→-0.1 then +0.1→+15.0 ──────────────────
const Q=String.fromCharCode(39); // safe single-quote for onclick strings
const ADV_STEPS=[],FAV_STEPS=[];
for(let v=1.0;v>=0.1-1e-9;v=Math.round((v-0.1)*10)/10) ADV_STEPS.push(+v.toFixed(1));
for(let v=0.1;v<=15.0+1e-9;v=Math.round((v+0.1)*10)/10) FAV_STEPS.push(+v.toFixed(1));

// ── Formatters ───────────────────────────────────────────────────
const f2  = v => v==null||isNaN(+v)?'—':(+v).toFixed(2);
const f1  = v => v==null||isNaN(+v)?'—':(+v).toFixed(1);
const f0  = v => v==null||isNaN(+v)?'—':(+v).toFixed(0);
const eu  = v => v==null?'—':((+v)>=0?'+':'')+'€'+(+v).toFixed(2);
const pct = v => v==null?'—':(+v).toFixed(1)+'%';
const pC  = v => (+v||0)>=0?'cg':'cr';
const dt  = s => { try{ return new Date(s).toLocaleString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }catch{return s||'—';} };
const dtS = s => { try{ return new Date(s).toLocaleDateString('nl-BE'); }catch{return s||'—';} };
const msFmt = m => { if(!m&&m!==0) return '—'; m=Math.round(+m); const h=Math.floor(m/60),mn=m%60; return h>0?h+'h'+mn+'m':mn+'m'; };
// fPrice: correct decimal places per asset type
function fPrice(v, symbol) {
  if(v==null||v===0) return '—';
  const t = symType(symbol||'');
  if(t==='stock') return parseFloat(v).toFixed(2);
  if(t==='index') return parseFloat(v).toFixed(2);
  if(t==='commodity') return parseFloat(v).toFixed(2);
  // forex: JPY pairs 3 decimals, others 5
  const s = (symbol||'').toUpperCase();
  return parseFloat(v).toFixed(s.includes('JPY')?3:5);
}

// ── Badge helpers ─────────────────────────────────────────────────
const dBadge = d => d==='buy'?'<span class="bd bd-buy">BUY</span>':'<span class="bd bd-sell">SELL</span>';
const vBadge = v => v==='above'?'<span class="bd bd-ab">ABOVE</span>':'<span class="bd bd-bw">BELOW</span>';
const sBadge = s => ({asia:'<span class="bd bd-asia">ASIA</span>',london:'<span class="bd bd-lon">LON</span>',ny:'<span class="bd bd-ny">NY</span>',outside:'<span class="bd bd-ny">NY</span>'}[(s||'ny').toLowerCase()])||'<span class="bd bd-ny">NY</span>'; // STAP 5: null-safe, 3 sessions only
const tBadge = t => ({forex:'<span class="bd bd-fx">FX</span>',stock:'<span class="bd bd-sk">STK</span>',index:'<span class="bd bd-ix">IDX</span>',commodity:'<span class="bd bd-cm">COM</span>'}[t])||'<span class="bd cd">'+t+'</span>';
const emptyRow = (cols,msg) => '<tr><td colspan="'+cols+'" class="nd">'+msg+'</td></tr>';

// ── API helper ───────────────────────────────────────────────────
async function api(url, ms=12000){
  // Try fetch first, fall back to XHR if extension interference detected
  try {
    const ctrl=new AbortController(), tid=setTimeout(()=>ctrl.abort(),ms);
    const r=await fetch(url,{signal:ctrl.signal});
    clearTimeout(tid);
    if(!r.ok) throw new Error(r.status);
    return await r.json();
  } catch(e) {
    // Fallback: XMLHttpRequest (not intercepted by most extensions)
    return new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = ms;
        xhr.onload  = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve(null); } };
        xhr.onerror = () => resolve(null);
        xhr.ontimeout = () => resolve(null);
        xhr.send();
      } catch { resolve(null); }
    });
  }
}

// ── Clock ────────────────────────────────────────────────────────
function updateClock(){
  try{
    const now=new Date();
    const el=document.getElementById('hclock'); if(el) el.textContent=now.toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour12:false});
    const bx=new Date(now.toLocaleString('en-US',{timeZone:'Europe/Brussels'}));
    const t=bx.getHours()*60+bx.getMinutes();
    const sess=t>=120&&t<480?'ASIA':t>=480&&t<930?'LONDON':t>=930&&t<1260?'NEW YORK':'CLOSED';
    const se=document.getElementById('h-sess'); if(se) se.textContent=sess;
  }catch{}
}
setInterval(updateClock,1000); updateClock();

// ── Page nav (event delegation) ──────────────────────────────────
const PAGES=['overview','positions','ghosts','history','ev','evsl','signals','shadow-playbook'];
const _loaded={};
function showPage(name){
  // Map removed tabs to their new locations
  if(name==='history') name='ghosts';
  if(name==='evsl')    name='ev';
  if(name==='positions') name='overview';
  PAGES.forEach(p=>{ const pg=document.getElementById('page-'+p); if(pg) pg.classList.remove('on'); });
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('on'));
  const pg=document.getElementById('page-'+name); if(pg) pg.classList.add('on');
  const tab=document.querySelector('.ntab[data-page="'+name+'"]'); if(tab) tab.classList.add('on');
  if(!_loaded[name]){
    _loaded[name]=true;
    if(name==='ghosts')          { loadGhostTrackers(); loadGhostFinalized(); loadGhostHistory(); loadGhostCombo(); }
    if(name==='ev')              { loadEV(); loadEVSL(); }
    if(name==='signals')         { loadSignals(); loadBlockedRaw(); loadBand(); }
    if(name==='shadow-playbook') loadShadowPlaybook();
    if(name==='overview')        loadOverview();
  }
}
document.addEventListener('click',e=>{
  const t=e.target.closest('.ntab[data-page]'); if(t) showPage(t.dataset.page);
});

// ══════════════════════════════════════════════════════════════════
//  GLOBAL DATE FILTER
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
//  PER-TAB DATE FILTERS  (v13.4.1)
//  Elke tab heeft zijn eigen datumfilter met Apply/Reset knop.
//  Geen globale filter meer — elke tab beheert zijn eigen staat.
// ══════════════════════════════════════════════════════════════════

// Generieke helper: lees inputs + toon active label
function _dfRead(pfx, hasClosed) {
  const v = {
    openFrom:  document.getElementById(pfx+'-open-from')?.value  || null,
    openTo:    document.getElementById(pfx+'-open-to')?.value    || null,
    closeFrom: hasClosed ? (document.getElementById(pfx+'-close-from')?.value || null) : null,
    closeTo:   hasClosed ? (document.getElementById(pfx+'-close-to')?.value   || null) : null,
  };
  const active = v.openFrom || v.openTo || v.closeFrom || v.closeTo;
  const lbl = document.getElementById(pfx+'-df-active');
  if(lbl) lbl.style.display = active ? '' : 'none';
  return v;
}
function _dfReset(pfx, hasClosed) {
  [pfx+'-open-from', pfx+'-open-to',
   ...(hasClosed ? [pfx+'-close-from', pfx+'-close-to'] : [])
  ].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  const lbl = document.getElementById(pfx+'-df-active');
  if(lbl) lbl.style.display = 'none';
}

// Per-tab filter state
const _df = {
  ov:   { openFrom:null, openTo:null, closeFrom:null, closeTo:null },
  pos:  { openFrom:null, openTo:null, closeFrom:null, closeTo:null },
  gh:   { openFrom:null, openTo:null, closeFrom:null, closeTo:null },
  hist: { openFrom:null, openTo:null, closeFrom:null, closeTo:null },
  ev:   { openFrom:null, openTo:null, closeFrom:null, closeTo:null },
  evsl: { openFrom:null, openTo:null, closeFrom:null, closeTo:null },
  sig:  { openFrom:null, openTo:null, closeFrom:null, closeTo:null },
};

// Overview
function applyOVFilter(){ Object.assign(_df.ov, _dfRead('ov',true));  _loaded.overview=false; loadAll(); }
function resetOVFilter() { _dfReset('ov',true);  Object.assign(_df.ov, {openFrom:null,openTo:null,closeFrom:null,closeTo:null}); loadAll(); }

// Open Positions — only openFrom/openTo (no closed date for live positions)
function applyPOSFilter(){ Object.assign(_df.pos, _dfRead('pos',false)); _loaded.positions=false; loadPositions(); }
function resetPOSFilter() { _dfReset('pos',false); Object.assign(_df.pos,{openFrom:null,openTo:null,closeFrom:null,closeTo:null}); loadPositions(); }

// Ghost Tracker — open date only (active ghosts)
function applyGHFilter(){ Object.assign(_df.gh, _dfRead('gh',false));  _loaded.ghosts=false; loadGhostTrackers(); }
function resetGHFilter() { _dfReset('gh',false);  Object.assign(_df.gh, {openFrom:null,openTo:null,closeFrom:null,closeTo:null}); loadGhostTrackers(); }

// Ghost History
function applyHISTFilter(){ Object.assign(_df.hist, _dfRead('hist',false)); _loaded.history=false; loadGhostHistory(); loadGhostCombo(); }
function resetHISTFilter() { _dfReset('hist',false); Object.assign(_df.hist,{openFrom:null,openTo:null,closeFrom:null,closeTo:null}); loadGhostHistory(); loadGhostCombo(); }

// EV TP Optimizer
function applyEVFilter(){ Object.assign(_df.ev, _dfRead('ev',true));   _loaded.ev=false; loadEV(); }
function resetEVFilter() { _dfReset('ev',true);   Object.assign(_df.ev,  {openFrom:null,openTo:null,closeFrom:null,closeTo:null}); loadEV(); }

// EV SL Optimizer
function applyEVSLFilter(){ Object.assign(_df.evsl, _dfRead('evsl',true)); _loaded.evsl=false; loadEVSL(); }
function resetEVSLFilter() { _dfReset('evsl',true); Object.assign(_df.evsl,{openFrom:null,openTo:null,closeFrom:null,closeTo:null}); loadEVSL(); }

// Signals
function applySIGFilter(){ Object.assign(_df.sig, _dfRead('sig',true));  _loaded.signals=false; loadSignals(); loadBlockedRaw(); loadBand(); }
function resetSIGFilter() { _dfReset('sig',true);  Object.assign(_df.sig, {openFrom:null,openTo:null,closeFrom:null,closeTo:null}); loadSignals(); loadBlockedRaw(); loadBand(); }

// ── Milestone toggle ─────────────────────────────────────────────
let _msVisible=false;
function toggleMsCols(){
  _msVisible=!_msVisible;
  let s=document.getElementById('ms-style');
  if(!s){ s=document.createElement('style'); s.id='ms-style'; document.head.appendChild(s); }
  s.textContent=_msVisible?'':'.ms-adv,.ms-fav{display:none!important}';
  document.querySelectorAll('th.adv-th,th.fav-th').forEach(el=>el.style.display=_msVisible?'':'none');
  const btn=document.getElementById('ms-btn');
  if(btn) btn.textContent=_msVisible?'✕ Milestones':'± Milestones';
}

// ── Manual position recovery ──────────────────────────────────────
async function recoverPositions(){
  const btn = document.getElementById('recover-btn');
  if(btn){ btn.textContent='⏳ Recovering…'; btn.disabled=true; }
  try {
    const secret = prompt('Webhook secret:');
    if(!secret){ if(btn){ btn.textContent='⚡ Recover'; btn.disabled=false; } return; }
    const r = await fetch('/api/recover-positions', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-webhook-secret':secret},
    });
    const d = await r.json();
    if(d.ok){
      const adopted = (d.results||[]).filter(x=>x.status==='adopted');
      const tracked = (d.results||[]).filter(x=>x.status==='already_tracked');
      const adoptedList = adopted.map(function(x){return x.symbol+' ('+x.id+')';}).join(', ');
      const NL = String.fromCharCode(10);
      const msg = 'Recovery klaar'+NL+'Live MT5: '+d.livePositions+NL+'Nieuw hersteld: '+adopted.length+(adoptedList?' - '+adoptedList:'')+NL+'Al getrackt: '+tracked.length;
      alert(msg);
      await loadAll();
    } else {
      alert('Recovery mislukt: '+(d.error||JSON.stringify(d)));
    }
  } catch(e){
    alert('Fout: '+e.message);
  } finally {
    if(btn){ btn.textContent='⚡ Recover'; btn.disabled=false; }
  }
}
async function pollStatus(){
  const d=await api('/status',5000); if(!d) return;
  const bal=d.account?.balance, eq=d.account?.equity;
  if(bal!=null){
    setText('h-bal','€'+f0(bal));
    setText('ov-bal','€'+f0(bal));
  }
  if(bal!=null&&eq!=null){
    const live=eq-bal;
    setHtml('h-pnl','<span class="'+(live>=0?'cg':'cr')+'">'+(live>=0?'+':'')+'€'+live.toFixed(2)+'</span>');
    setText('ov-pnl',(live>=0?'+':'')+'€'+live.toFixed(2));
    setClass('ov-pnl','ov-val '+(live>=0?'cg':'cr'));
    setText('ov-pnl-sub',(live>=0?'+':'')+live.toFixed(2)+' on open trades');
    // FTMO daily drawdown warning — 5% daily limit, warn at 4%
    const dailyPnlPct = live < 0 ? Math.abs(live)/bal*100 : 0;
    const ddWarn = document.getElementById('dd-warning');
    if(ddWarn) {
      if(dailyPnlPct > 4.0) {
        ddWarn.style.display='';
        ddWarn.innerHTML='⚠ DAILY DRAWDOWN: <strong>'+dailyPnlPct.toFixed(2)+'%</strong> — FTMO limit 5%. '+(dailyPnlPct>4.5?'<strong style="color:var(--r)">CRITICAL — stop trading now!</strong>':'Close positions soon.');
        ddWarn.style.background = dailyPnlPct>4.5?'rgba(183,28,28,0.4)':'rgba(230,81,0,0.2)';
      } else {
        ddWarn.style.display='none';
      }
    }
  }
  if(d.openPositions!=null){ setText('h-pos',d.openPositions); setText('nb-pos',d.openPositions); }
  // Show circuit breaker state if open
  const cbEl = document.getElementById('h-circuit');
  if(cbEl) cbEl.style.display = d.metaCircuitOpen ? '' : 'none';
  const cbar=document.getElementById('cbar'); if(cbar) cbar.style.display='none';
}

// ── Helpers ───────────────────────────────────────────────────────
function setText(id,v){ const el=document.getElementById(id); if(el) el.textContent=v; }
function setHtml(id,v){ const el=document.getElementById(id); if(el) el.innerHTML=v; }
function setClass(id,v){ const el=document.getElementById(id); if(el) el.className=v; }

// ── loadPositions — uses /api/open-positions ─────────────────────
async function loadPositions(){
  const d=await api('/api/open-positions')||[];
  const cnt=d.length;
  setText('h-pos',cnt); setText('nb-pos',cnt||''); setText('ov-open',cnt);
  const posStrip=document.getElementById('pos-strip');
  if(!cnt){
    setHtml('pos-body',emptyRow(100,'No open positions'));
    if(posStrip) posStrip.style.display='none';
    setText('ov-open-sub','no live positions');
    return;
  }
  if(posStrip) posStrip.style.display='flex';
  const buys=d.filter(p=>p.direction==='buy').length;
  const ghd=d.filter(p=>p.ghost!=null).length;
  setText('pos-cnt',cnt);
  setText('pos-buy',buys); setText('pos-sell',cnt-buys);
  setText('pos-sk',d.filter(p=>symType(p.symbol)==='stock').length);
  setText('pos-ix',d.filter(p=>symType(p.symbol)==='index').length);
  setText('pos-fx',d.filter(p=>symType(p.symbol)==='forex').length);
  setText('pos-cm',d.filter(p=>symType(p.symbol)==='commodity').length);
  setText('pos-gh',ghd);
  setText('ov-open-sub',buys+' buy · '+(cnt-buys)+' sell');

  // Open-trade performance stats for Overview card
  const pnls=d.map(p=>p.liveProfitMT5??null).filter(v=>v!==null);
  const winCnt=pnls.filter(v=>v>0).length;
  const lossCnt=pnls.filter(v=>v<0).length;
  const totalLots=d.reduce((s,p)=>s+(p.lots??p.ghost?.lots??0),0);
  const maxWin=pnls.length?Math.max(...pnls):null;
  const maxLoss=pnls.length?Math.min(...pnls):null;
  const livePnlSum=pnls.reduce((s,v)=>s+v,0);
  setText('ov-open-cnt',cnt);
  setText('ov-win-cnt',winCnt);
  setText('ov-loss-cnt',lossCnt);
  setText('ov-lots',totalLots.toFixed(2));
  // WR open
  const wrEl=document.getElementById('ov-wr-open');
  if(wrEl){ const wr=cnt>0?(winCnt/cnt*100):0; wrEl.textContent=cnt>0?wr.toFixed(1)+'%':'—'; wrEl.className='ksv '+(wr>=55?'cg':wr>=50?'cy':'cr'); }
  // Best Peak+RR across all open ghosts
  const bestRR=d.reduce((m,p)=>Math.max(m,p.ghost?.peakRRPos??0),0);
  const worstNeg=d.reduce((m,p)=>Math.max(m,p.ghost?.peakRRNeg??0),0);
  const rrEl=document.getElementById('ov-best-rr');
  if(rrEl){ rrEl.textContent=bestRR>0?bestRR.toFixed(2)+'R':'—'; }
  const negEl=document.getElementById('ov-worst-neg');
  if(negEl){ negEl.textContent=worstNeg>0?'-'+worstNeg.toFixed(0)+'%':'—'; }
  const lpEl=document.getElementById('ov-live-pnl');
  if(lpEl){ lpEl.textContent=eu(livePnlSum); lpEl.className='ksv '+(livePnlSum>=0?'cg':'cr'); }
  setText('ov-open-meta',cnt+' open · '+winCnt+' winning · '+lossCnt+' losing');

  // Daily snapshot — store today's open trade stats in localStorage for per-day record
  const todayKey='pronto_daily_'+new Date().toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels'}).replace(/\//g,'-');
  try {
    const snap={
      date: new Date().toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels'}),
      cnt, winCnt, lossCnt,
      totalLots: parseFloat(totalLots.toFixed(3)),
      livePnlSum: parseFloat(livePnlSum.toFixed(2)),
      maxWin: maxWin!=null?parseFloat(maxWin.toFixed(2)):null,
      maxLoss: maxLoss!=null?parseFloat(maxLoss.toFixed(2)):null,
      // Per-position stats for WR and RR
      positions: d.map(p=>({
        symbol:p.symbol, direction:p.direction, session:p.session, vwapPosition:p.vwapPosition,
        peakRRPos: p.ghost?.peakRRPos??0,
        peakRRNeg: p.ghost?.peakRRNeg??0,
        riskPct: p.riskPct??null,
        livePnl: p.liveProfitMT5??null,
        tpRR: p.ghost?.tpRRUsed??null,
        lots: p.lots??null,
      }))
    };
    snap.maxRR = snap.positions.reduce((m,p)=>Math.max(m,p.peakRRPos),0);
    snap.worstNeg = snap.positions.reduce((m,p)=>Math.max(m,p.peakRRNeg),0);
    snap.maxRisk = snap.positions.reduce((s,p)=>s+(Math.abs(p.riskPct||0)),0);
    snap.wr = cnt>0?parseFloat((winCnt/cnt*100).toFixed(1)):0;
    localStorage.setItem(todayKey, JSON.stringify(snap));
  } catch(e) { /* localStorage may not be available */ }

  // Render daily open performance log from localStorage
  renderDailyOpenLog();

  // Use live P&L from header (set by pollStatus)
  const livePnlTxt=document.getElementById('h-pnl')?.textContent||'—';
  setText('pos-pnl',livePnlTxt);

  const tbody=document.getElementById('pos-body');
  if(!tbody) return;
  tbody.innerHTML=d.map(p=>{
    const slDist=Math.abs((p.entry||0)-(p.sl||0));
    const peakPos=p.ghost?.peakRRPos??p.ghost?.maxRR??0;
    const peakNeg=p.ghost?.peakRRNeg??p.ghost?.maxSlPctUsed??0;
    const tpRR=slDist>0?Math.abs((p.tp||0)-(p.entry||0))/slDist:null;
    const lots = p.lots ?? p.ghost?.lots ?? null;
    // Risk%: use stored riskPct first, else calculate from lots × slDist / equity
    let rPct = null;
    if (p.riskPct) {
      rPct = (p.riskPct * 100).toFixed(3);
    } else if (lots && p.entry && p.sl) {
      const slDistR = Math.abs(p.entry - p.sl);
      const tp = symType(p.symbol);
      let riskEst = 0;
      if (tp === 'forex')     riskEst = lots * 100000 * slDistR;
      else if (tp === 'index')riskEst = lots * slDistR;
      else if (tp === 'stock')riskEst = lots * slDistR;
      else                    riskEst = lots * 100 * slDistR;
      const eq = 50000; // conservative fallback — actual equity from header
      rPct = riskEst > 0 ? (riskEst / eq * 100).toFixed(3) : null;
    }
    // Live P&L: prefer liveProfitMT5 (direct from MT5 via syncPositions), else estimate
    let livePnl = p.liveProfitMT5 ?? null;
    if(livePnl === null && p.currentPrice && p.entry && lots && p.sl) {
      const slDist = Math.abs(p.entry - p.sl);
      const pnlDir = p.direction === 'buy' ? p.currentPrice - p.entry : p.entry - p.currentPrice;
      const riskEUR = p.riskEUR ?? (p.riskPct ? 50000 * p.riskPct : null);
      if(riskEUR && slDist > 0) livePnl = parseFloat((riskEUR * pnlDir / slDist).toFixed(2));
    }
    // Compute live RR from currentPrice if available, else show peak
    const currentRR = slDist > 0 && p.currentPrice
      ? parseFloat(((p.direction==='buy' ? p.currentPrice - p.entry : p.entry - p.currentPrice) / slDist).toFixed(2))
      : null;
    return '<tr>'+
      // Symbol sticky | Type | Dir | VWAP | Sess
      '<td class="cb fw" style="position:sticky;left:0;background:var(--bg3);font-size:11px;z-index:1">'+p.symbol+'</td>'+
      '<td>'+tBadge(symType(p.symbol))+'</td>'+
      '<td>'+dBadge(p.direction)+'</td>'+
      '<td>'+vBadge(p.vwapPosition)+'</td>'+
      '<td>'+sBadge(p.session)+'</td>'+
      '<td class="'+(currentRR!=null?(currentRR>=1?'cg fw':currentRR>0?'cy':currentRR<-0.5?'cr fw':'cr'):'cd')+'">'+
        (currentRR!=null?currentRR.toFixed(2)+'R':
          (!p.currentPrice&&(Date.now()-new Date(p.openedAt||0).getTime())<60000)?
          '<span style="font-size:8px;color:var(--ink3)" title="Syncing with MT5...">⟳</span>':'—')+'</td>'+
      '<td class="'+(peakPos>=2?'cg fw':peakPos>=1?'cg':peakPos>0?'cy':'cd')+' fw">'+f2(peakPos)+'R</td>'+
      '<td class="'+(peakNeg>80?'cr fw':peakNeg>50?'cr':peakNeg>25?'co':'cd')+'">'+
        (peakNeg>0?'-'+f1(peakNeg)+'%':'—')+'</td>'+
      '<td class="cy" title="Distance to TP in RR multiples">'+(tpRR!=null?f2(tpRR)+'R':'—')+'</td>'+
      // VWAP band % at signal time
      (()=>{
        const band=p.vwapBandPct??p.ghost?.vwapBandPct??null;
        return '<td class="'+(band!=null&&band>150?'cr fw':band!=null&&band>120?'co':'cd')+'" style="font-size:9px">'+(band!=null?f0(band)+'%':'—')+'</td>';
      })()+
      // #Key - how many times this optimizer key has been traded (from all open positions count)
      (()=>{
        const optKey=p.optimizerKey||p.ghost?.optimizerKey||'';
        return '<td class="cd" style="font-size:9px">'+(optKey?'1':'—')+'</td>';
      })()+
      // Milestone cells -1.0 to -0.1 (adverse) then +0.1 to +10.0 (favorable) — always visible
      (()=>{
        const rrMs = p.ghost?.rrMilestones ?? {};
        const openedTs = p.openedAt ? new Date(p.openedAt).getTime() : null;
        const fmtMs = ts => {
          if(!ts||!openedTs) return '—';
          const tsMs = typeof ts === 'number' ? ts : new Date(ts).getTime();
          if(!tsMs || isNaN(tsMs)) return '—';
          const mins = Math.round((tsMs - openedTs) / 60000);
          if(mins < 0) return '—';
          return mins < 60 ? mins+'m' : Math.floor(mins/60)+'h'+(mins%60 ? String(mins%60).padStart(2,'0')+'m' : '');
        };
        // ADV: -1.0 to -0.1
        const advSteps=[1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1];
        const a=advSteps.map(v=>{
          const ts=rrMs['-'+v.toFixed(1)]??null;
          const val=fmtMs(ts);
          return '<td class="adv-th" style="font-size:8px;text-align:center;min-width:22px">'+(ts?'<span style="color:var(--r);font-weight:700">'+val+'</span>':'<span style="color:var(--ink3)">—</span>')+'</td>';
        }).join('');
        // FAV: +0.1 to +10.0 per 0.1R
        let f='';
        for(let v=0.1;v<=6.5+1e-9;v=Math.round((v+0.1)*10)/10){
          const key=v.toFixed(1);
          const ts=rrMs['+'+key]??rrMs[key]??null;
          const val=fmtMs(ts);
          f+='<td class="fav-th" style="font-size:8px;text-align:center;min-width:22px">'+(ts?'<span style="color:var(--g);font-weight:700">'+val+'</span>':'<span style="color:var(--ink3)">—</span>')+'</td>';
        }
        return a+f;
      })()+
      '<td class="cd" style="font-size:9px">'+fPrice(p.entry,p.symbol)+'</td>'+
      '<td class="cr" style="font-size:9px">'+fPrice(p.sl,p.symbol)+'</td>'+
      '<td class="cg" style="font-size:9px">'+(p.tp?fPrice(p.tp,p.symbol):'—')+'</td>'+
      '<td class="'+(livePnl!=null?(livePnl>=0?'cg':'cr'):'cd')+' fw">'+(livePnl!=null?(livePnl>=0?'+':'')+eu(livePnl):'—')+'</td>'+
      '<td class="cd">'+(lots!=null?f2(lots):'—')+'</td>'+
      '<td class="'+(rPct&&+rPct>0.04?'cr fw':rPct&&+rPct>0.025?'co':'cg')+'">'+(rPct!=null?rPct+'%':'—')+'</td>'+
      '<td class="cd" style="font-size:9px">'+dt(p.openedAt)+'</td>'+
    '</tr>';
  }).join('');
}


// ── loadGhostTrackers — reuses /api/open-positions ghost data ─────
async function loadGhostTrackers(){
  const d=await api('/api/open-positions')||[];
  // Also fetch today's finalized ghosts so SL-hit positions stay visible till EOD
  const finToday=await api('/api/ghost-trades?limit=200')||[];
  const todayBrus=new Date().toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels'});
  // Finalized ghosts closed today — keep them visible in active table with ● SL badge
  const finalizedTodayAsActive=finToday
    .filter(t=>t.closedAt&&new Date(t.closedAt).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels'})===todayBrus)
    .map(t=>({...t, ghost:{...t, phantomSLHit:true, rrMilestones:t.rrMilestones||{}}, _finalizedToday:true}));
  // Merge: active positions + today's finalized (deduplicate by positionId / symbol+openedAt)
  const activeIds=new Set(d.map(p=>p.positionId||p.id||p.symbol+'_'+p.openedAt));
  const extra=finalizedTodayAsActive.filter(t=>!activeIds.has(t.positionId||t.id||t.symbol+'_'+t.openedAt));
  const ghosts=[...d.filter(p=>p.ghost!=null),...extra.map(t=>({...t,ghost:t.ghost||t}))];
  const cnt=ghosts.length;
  setText('h-gh',cnt); setText('nb-gh',cnt||'');
  const ghStrip=document.getElementById('gh-strip');
  if(!cnt){ setHtml('gh-body',emptyRow(100,'No active ghost trackers')); if(ghStrip) ghStrip.style.display='none'; return; }
  if(ghStrip) ghStrip.style.display='flex';
  const best=Math.max(...ghosts.map(g=>g.ghost?.peakRRPos??g.ghost?.maxRR??0));
  const worst=Math.max(...ghosts.map(g=>g.ghost?.peakRRNeg??g.ghost?.maxSlPctUsed??0));
  const buys=ghosts.filter(g=>g.direction==='buy').length;
  const elapsed=ghosts.map(g=>g.openedAt?Math.round((Date.now()-new Date(g.openedAt))/60000):0);
  const avgEl=elapsed.length?Math.round(elapsed.reduce((s,v)=>s+v,0)/elapsed.length):0;
  setText('gh-cnt',cnt);
  setText('gh-best',f2(best)+'R');
  setText('gh-worst',worst>0?'-'+f0(worst)+'%':'—');
  setText('gh-buy',buys); setText('gh-sell',cnt-buys);
  setText('gh-sk',ghosts.filter(g=>symType(g.symbol)==='stock').length);
  setText('gh-ix',ghosts.filter(g=>symType(g.symbol)==='index').length);
  setText('gh-fx',ghosts.filter(g=>symType(g.symbol)==='forex').length);
  setText('gh-el',msFmt(avgEl));

  const msT=(ms,opened,isFav)=>{
    const cls='td class="'+(isFav?'ms-fav cg':'ms-adv cr')+'" style="font-size:8px;min-width:30px"';
    if(!ms||!opened) return '<'+cls+'>—</td>';
    // Handle both ms (number) and ISO string timestamps
    const tsMs  = typeof ms     === 'number' ? ms     : new Date(ms).getTime();
    const opMs  = typeof opened === 'number' ? opened : new Date(opened).getTime();
    if(isNaN(tsMs)||isNaN(opMs)) return '<'+cls+'>—</td>';
    const mins=Math.round((tsMs-opMs)/60000);
    if(mins<0) return '<'+cls+'>—</td>';
    return '<'+cls+'>'+msFmt(mins)+'</td>';
  };
  const tbody=document.getElementById('gh-body');
  if(!tbody) return;
  // Build optimizer key count map from all active ghosts
  const keyCountMap={};
  ghosts.forEach(g=>{ const k=g.optimizerKey||g.ghost?.optimizerKey||''; if(k) keyCountMap[k]=(keyCountMap[k]||0)+1; });

  tbody.innerHTML=ghosts.map(g=>{
    const peakPos=g.ghost?.peakRRPos??g.ghost?.maxRR??0;
    const peakNeg=g.ghost?.peakRRNeg??g.ghost?.maxSlPctUsed??0;
    const favMs=g.ghost?.rrMilestones||{};
    const elapsed=g.openedAt?Math.round((Date.now()-new Date(g.openedAt))/60000):null;
    const pnl=g.liveProfitMT5??null;
    const isSLHit=g.ghost?.phantomSLHit??false;
    const band=g.vwapBandPct??g.ghost?.vwapBandPct??null;
    const optKey=g.optimizerKey||g.ghost?.optimizerKey||'';
    const keyCount=keyCountMap[optKey]||1;

    // Milestone helper: returns elapsed time string or —
    const msCell=(key,isFav)=>{
      const ts=favMs[key]||null;
      if(!ts||!g.openedAt) return '<td class="'+(isFav?'fav-th':'adv-th')+'" style="font-size:8px;min-width:24px">—</td>';
      const tsMs=typeof ts==='number'?ts:new Date(ts).getTime();
      const mins=Math.round((tsMs-new Date(g.openedAt).getTime())/60000);
      if(mins<0) return '<td class="'+(isFav?'fav-th':'adv-th')+'" style="font-size:8px;min-width:24px">—</td>';
      return '<td class="'+(isFav?'fav-th cg':'adv-th cr')+'" style="font-size:8px;font-weight:700;min-width:24px">'+msFmt(mins)+'</td>';
    };

    // ADV milestones -1.0 to -0.1
    const advCells=[1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>msCell('-'+v.toFixed(1),false)).join('');
    // FAV milestones +0.1 to +10.0 per 0.1R
    let favCells='';
    for(let v=0.1;v<=6.5+1e-9;v=Math.round((v+0.1)*10)/10){
      const key=v.toFixed(1);
      favCells+=msCell('+'+key,true)||msCell(key,true);
    }

    return '<tr style="'+(isSLHit?'background:rgba(248,81,73,.07)':'')+'">'+
      '<td class="cb fw" style="font-size:11px">'+g.symbol+'</td>'+
      '<td>'+tBadge(symType(g.symbol))+'</td>'+
      '<td>'+sBadge(g.session)+'</td>'+
      '<td>'+dBadge(g.direction)+'</td>'+
      '<td>'+vBadge(g.vwapPosition)+'</td>'+
      '<td class="'+(peakPos>=2?'cg fw':peakPos>=1?'cg':peakPos>0?'cy':'cd')+'">'+f2(peakPos)+'R</td>'+
      '<td class="'+(peakNeg>80?'cr fw':peakNeg>50?'cr':peakNeg>25?'co':'cd')+'">'+
        (peakNeg>0?'-'+f1(peakNeg)+'%':'—')+'</td>'+
      '<td class="'+(band!=null&&band>150?'cr fw':band!=null&&band>120?'co':'cd')+'" style="font-size:9px">'+
        (band!=null?f0(band)+'%':'—')+'</td>'+
      '<td class="'+(keyCount>1?'cy fw':'cd')+'" style="font-size:9px">'+keyCount+'</td>'+
      advCells+
      favCells+
      '<td class="cd" style="font-size:10px">'+(g.lots??g.ghost?.lots!=null?f2(g.lots??g.ghost?.lots):'—')+'</td>'+
      '<td class="cd" style="font-size:10px">'+fPrice(g.entry,g.symbol)+'</td>'+
      '<td class="cr" style="font-size:10px">'+fPrice(g.sl??g.ghost?.sl,g.symbol)+'</td>'+
      '<td class="cg" style="font-size:10px">'+fPrice(g.tp??g.ghost?.tp,g.symbol)+'</td>'+
      '<td class="'+(pnl==null?'cd':pnl>=0?'cg fw':'cr fw')+'" style="font-size:10px">'+(pnl!=null?eu(pnl):'—')+'</td>'+
      '<td class="cd" style="font-size:9px">'+
        (g.tradeNumber?'<span style="color:var(--ink3);font-size:8px">#'+g.tradeNumber+'</span> ':'')+
        dt(g.openedAt)+(isSLHit?' <span class="cr fw" style="font-size:8px">● SL</span>':'')+'</td>'+
      '<td class="cd">'+msFmt(elapsed)+'</td>'+
    '</tr>';
  }).join('');
}

function renderDailyOpenLog(){
  const tbody=document.getElementById('daily-open-body'); if(!tbody) return;
  const rows=[];
  try {
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(!k||!k.startsWith('pronto_daily_')) continue;
      try{ rows.push(JSON.parse(localStorage.getItem(k))); }catch(e){}
    }
  } catch(e) {}
  rows.sort((a,b)=>b.date.localeCompare(a.date));
  if(!rows.length){
    tbody.innerHTML='<tr><td colspan="11" class="nd" style="font-size:9px">Geen data — wordt opgeslagen bij eerste positions sync</td></tr>';
    return;
  }
  tbody.innerHTML=rows.slice(0,30).map(r=>{
    const wr=r.wr??0;
    return '<tr>'+
      '<td class="cd fw" style="font-size:9px">'+r.date+'</td>'+
      '<td class="cb fw">'+r.cnt+'</td>'+
      '<td class="cg">'+r.winCnt+'</td>'+
      '<td class="cr">'+r.lossCnt+'</td>'+
      '<td class="'+(wr>=55?'cg fw':wr>=50?'cy':'cr')+'">'+wr.toFixed(1)+'%</td>'+
      '<td class="cg fw">'+(r.maxRR>0?r.maxRR.toFixed(2)+'R':'—')+'</td>'+
      '<td class="cr fw">'+(r.worstNeg>0?'-'+r.worstNeg.toFixed(0)+'%':'—')+'</td>'+
      '<td class="cd">'+(r.maxRisk?r.maxRisk.toFixed(4)+'%':'—')+'</td>'+
      '<td class="cd">'+r.totalLots.toFixed(2)+'</td>'+
      '<td class="'+(r.livePnlSum>=0?'cg':'cr')+' fw">'+eu(r.livePnlSum)+'</td>'+
    '</tr>';
  }).join('');
}
let _allTrades=[];
function renderOverview(trades, daily, ghGrouped){
  // Trades: realizedPnlEUR, direction, vwapPosition, session, symbol, openedAt, closedAt, maxRR, hitTP
  const total=trades.length;
  // Show filter hint when active but no results
  const ov=_df.ov;
  const filterActive=ov.openFrom||ov.openTo||ov.closeFrom||ov.closeTo;
  const filterHint=document.getElementById('ov-filter-hint');
  if(filterHint){
    if(total===0&&filterActive){
      filterHint.style.display='';
      filterHint.textContent='⚠ Geen trades gevonden voor de geselecteerde periode. Klik Reset om alle trades te tonen.';
    } else {
      filterHint.style.display='none';
    }
  }
  // DB loading indicator — show when 0 trades and no filter active
  const dbLoadEl = document.getElementById('ov-db-loading');
  if(dbLoadEl) dbLoadEl.style.display = (total===0&&!filterActive) ? '' : 'none';
  setText('ov-comp',total);
  setText('wr-meta',total+' trades · compliance+');
  setText('dist-meta',total+' trades · compliance+');
  // Data quality: how many trades have ghost data?
  const withGhost = (_allTrades||[]).filter(t=>t.ghostStopReason||t.ghostFinalizedAt).length;
  const qualPct = total > 0 ? Math.round(withGhost/total*100) : 0;
  const qualEl = document.getElementById('ov-data-quality');
  if(qualEl) qualEl.textContent = qualPct+'% with ghost data';

  // Summary strip
  const buys=trades.filter(t=>t.direction==='buy').length;
  const ab=trades.filter(t=>t.vwapPosition==='above').length;
  setText('wr-tot',total); setText('wr-tot-n',total+' trades');
  setText('wr-buy',buys); setText('wr-sell',total-buys);
  setText('wr-ab',ab); setText('wr-bw',total-ab);
  setText('wr-asia',trades.filter(t=>t.session==='asia').length);
  setText('wr-lon', trades.filter(t=>t.session==='london').length);
  setText('wr-ny',  trades.filter(t=>t.session==='ny').length);

  // % gain
  const pnlSum=trades.reduce((s,t)=>s+(t.realizedPnlEUR||0),0);
  const balStr=(document.getElementById('ov-bal')?.textContent||'').replace('€','').replace(/[,\s]/g,'');
  const bal=parseFloat(balStr)||0;
  if(bal>0){
    const gPct=(pnlSum/bal*100);
    const gStr=(gPct>=0?'+':'')+gPct.toFixed(2)+'%';
    setText('ov-gain',gStr); setClass('ov-gain','ov-val '+(gPct>=0?'cg':'cr'));
    setText('h-gain',gStr);
    setText('ov-gain-sub',(gPct>=0?'+':'')+eu(pnlSum)+' realized');
  }

  // Ghost history count
  if(ghGrouped){
    const closed=ghGrouped.reduce((s,g)=>s+(g.n||0),0);
    setText('h-ghh',closed);
    const tpLocked=ghGrouped.filter(g=>(g.n||0)>=5).length;
    setText('h-tp',tpLocked);
  }

  // Trade activity table
  window._wrTrades=trades;
  renderWRTable(window._wrTypeFilter||'all');

  // Distribution
  const fxT=trades.filter(t=>symType(t.symbol)==='forex');
  const skT=trades.filter(t=>symType(t.symbol)==='stock');
  const ixT=trades.filter(t=>symType(t.symbol)==='index');
  const cmT=trades.filter(t=>symType(t.symbol)==='commodity');
  // Per-type totals with buy/sell/above/below breakdown
  const fillType=(ids,arr)=>{
    const buy=arr.filter(t=>t.direction==='buy').length;
    const sell=arr.filter(t=>t.direction==='sell').length;
    const ab=arr.filter(t=>t.vwapPosition==='above').length;
    const bw=arr.filter(t=>t.vwapPosition==='below').length;
    setText(ids.tot,arr.length);setText(ids.buy,buy);setText(ids.sell,sell);
    setText(ids.ab,ab);setText(ids.bw,bw);
  };
  fillType({tot:'d-fx-tot',buy:'d-fx-buy',sell:'d-fx-sell',ab:'d-fx-ab',bw:'d-fx-bw'},fxT);
  fillType({tot:'d-ix-tot',buy:'d-ix-buy',sell:'d-ix-sell',ab:'d-ix-ab',bw:'d-ix-bw'},ixT);
  fillType({tot:'d-sk-tot',buy:'d-sk-buy',sell:'d-sk-sell',ab:'d-sk-ab',bw:'d-sk-bw'},skT);
  fillType({tot:'d-cm-tot',buy:'d-cm-buy',sell:'d-cm-sell',ab:'d-cm-ab',bw:'d-cm-bw'},cmT);
  setText('d-tot',total); setText('d-buy',buys); setText('d-sell',total-buys);
  setText('d-ab',ab); setText('d-bw',total-ab);

  let ba_t=0,bb_t=0,sa_t=0,sb_t=0;
  const typeGroups=[
    {label:'Forex',    arr:fxT, cls:'bd-fx', sessions:['asia','london','ny']},
    {label:'Stock',    arr:skT, cls:'bd-sk', sessions:['ny'], anomalyCheck: true,
      note:'Stocks only tradeable 16:00–21:00 Brussels (NY session). Asia/London entries = historical data before session restriction.'},
    {label:'Index',    arr:ixT, cls:'bd-ix', sessions:['asia','london','ny']},
    {label:'Commodity',arr:cmT, cls:'bd-cm', sessions:['asia','london','ny']},
  ];
  const dRows=[];
  // Build all sessions including anomalous ones (stock in asia/london = pre-restriction data)
  for(const tg of typeGroups){
    // For stock: show all sessions but mark non-NY as anomaly (historical pre-restriction)
    // For stock: only NY session (Asia/London deleted from DB on startup)
    const knownSessions = tg.label==='Stock'
      ? ['ny']  // Asia/London stock trades permanently deleted from DB
      : tg.sessions;
    // Find extra sessions that exist in data but aren't in defined list
    const dataSessions = [...new Set(tg.arr.map(t=>t.session||'unknown'))];
    const extraSessions = dataSessions.filter(s=>!knownSessions.includes(s));
    const allSessions = [...knownSessions, ...extraSessions];
    for(const sess of allSessions){
      const st=tg.arr.filter(t=>(t.session||'unknown')===sess); if(!st.length) continue;
      const ba=st.filter(t=>t.direction==='buy'&&t.vwapPosition==='above').length;
      const bb=st.filter(t=>t.direction==='buy'&&t.vwapPosition==='below').length;
      const sa=st.filter(t=>t.direction==='sell'&&t.vwapPosition==='above').length;
      const sb=st.filter(t=>t.direction==='sell'&&t.vwapPosition==='below').length;
      ba_t+=ba; bb_t+=bb; sa_t+=sa; sb_t+=sb;
      // Flag stock in non-NY session as anomaly (old data / possible index misclassification)
      const sessLabel = sess==='unknown' || sess===null ? '<span class="cd" style="font-size:9px">?sess</span>' : sBadge(sess);
      if((ba+bb+sa+sb)===0) continue; // skip empty rows
      const stWin=st.filter(t=>(t.realizedPnlEUR||0)>0).length;
      const stWR=st.length>0?(stWin/st.length*100):0;
      const stAvgPnl=st.length>0?st.reduce((s,t)=>s+(t.realizedPnlEUR||0),0)/st.length:0;
      dRows.push('<tr><td><span class="bd '+tg.cls+'">'+tg.label+'</span></td><td>'+sessLabel+'</td><td class="cg fw">'+ba+'</td><td class="cg">'+bb+'</td><td class="cr fw">'+sa+'</td><td class="cr">'+sb+'</td><td class="cb fw">'+(ba+bb+sa+sb)+'</td><td class="'+(stAvgPnl>=0?'cg':'cr')+'">'+(stAvgPnl>=0?'+':'')+eu(stAvgPnl)+'</td><td class="cd">'+st.reduce((s,t)=>s+(t.lots||0),0).toFixed(2)+'</td></tr>');
    }
  }
  setHtml('dist-body',dRows.join('')||emptyRow(9,'No trades after compliance date'));
  setText('ft-ba',ba_t); setText('ft-bb',bb_t); setText('ft-sa',sa_t); setText('ft-sb',sb_t);
  setText('ft-ba2',ba_t); setText('ft-bb2',bb_t); setText('ft-sa2',sa_t); setText('ft-sb2',sb_t);
  setText('ft-t',total);
  const allAvg=total>0?trades.reduce((s,t)=>s+(t.realizedPnlEUR||0),0)/total:0;
  const allLots=trades.reduce((s,t)=>s+(t.lots||0),0);
  setText('ft-avg',total>0?(allAvg>=0?'+':'')+eu(allAvg):'—');
  setText('ft-lots',total>0?allLots.toFixed(2):'—');

  // Daily breakdown
  // v14.0: Daily — Peak+RR, P&L, total lots, max win/loss per day
  const days=daily?.days||[];
  setHtml('daily-body',days.length?days.slice(0,60).map(r=>{
    const tot=parseInt(r.trades||0);
    return '<tr>'+
      '<td class="cd" style="font-size:10px">'+dtS(r.trade_date)+'</td>'+
      '<td class="cb">'+tot+'</td>'+
      '<td class="cd">'+f2(r.total_lots)+'</td>'+
      '<td class="'+pC(r.day_pnl)+' fw">'+eu(r.day_pnl)+'</td>'+
      '<td class="cy fw">'+(r.best_peak_rr!=null?f2(r.best_peak_rr)+'R':'—')+'</td>'+
      '<td class="cg">'+(r.max_win!=null?eu(r.max_win):'—')+'</td>'+
      '<td class="cr">'+(r.max_loss!=null?eu(r.max_loss):'—')+'</td>'+
    '</tr>';
  }).join(''):emptyRow(7,'No daily data'));

  // Best 10 / Worst 10 from ghost history PEAK+RR
  window._bestTrades  = daily?.bestTrades  || [];
  window._worstTrades = daily?.worstTrades || [];
  renderBW();
}

// ── Trade Activity table ──────────────────────────────────────────
window._wrTypeFilter='all';
function setWRType(type,btn){
  window._wrTypeFilter=type;
  document.querySelectorAll('#wr-type-tabs .fb').forEach(b=>b.classList.remove('on'));
  if(btn) btn.classList.add('on');
  renderWRTable(type);
}
function renderWRTable(typeFilter){
  const trades=window._wrTrades||[];
  const filtered=typeFilter==='all'?trades:trades.filter(t=>symType(t.symbol)===typeFilter);
  const combos={};
  for(const t of filtered){
    const tp = symType(t.symbol);
    if(tp==='stock' && t.session !== 'ny') continue;
    const k=(t.session||'?')+'|'+(t.direction||'?')+'|'+(t.vwapPosition||'?')+'|'+tp;
    if(!combos[k]) combos[k]={n:0,wins:0,pnlSum:0,lots:0,buy:0,sell:0,above:0,below:0};
    const c=combos[k];
    c.n++;
    if((t.realizedPnlEUR||0)>0) c.wins++;
    c.pnlSum+=(t.realizedPnlEUR||0);
    c.lots+=(t.lots||0);
    if(t.direction==='buy') c.buy++; else c.sell++;
    if(t.vwapPosition==='above') c.above++; else c.below++;
  }
  const rows=Object.entries(combos).sort((a,b)=>b[1].n-a[1].n).map(([k,c])=>{
    const [sess,dir,vwap,type]=k.split('|');
    const wr=c.n>0?(c.wins/c.n*100):0;
    const avgPnl=c.n>0?c.pnlSum/c.n:0;
    return '<tr>'+
      '<td>'+sBadge(sess)+'</td>'+
      '<td>'+dBadge(dir)+'</td>'+
      '<td>'+vBadge(vwap)+'</td>'+
      '<td>'+tBadge(type)+'</td>'+
      '<td class="cb fw">'+c.n+'</td>'+
      '<td class="'+(wr>=55?'cg fw':wr>=50?'cy':'cr')+'">'+wr.toFixed(1)+'%</td>'+
      '<td class="'+(avgPnl>=0?'cg':'cr')+'">'+(avgPnl>=0?'+':'')+eu(avgPnl)+'</td>'+
      '<td class="cd">'+c.lots.toFixed(2)+'</td>'+
      '<td class="cg">'+c.buy+'</td>'+
      '<td class="cr">'+c.sell+'</td>'+
      '<td class="cb">'+c.above+'</td>'+
      '<td class="cp">'+c.below+'</td>'+
    '</tr>';
  }).join('');
  setHtml('wr-body',rows||emptyRow(12,'No trades'));
  const firstDate = filtered.length ? dtS(filtered.reduce((a,b)=>new Date(a.openedAt)<new Date(b.openedAt)?a:b).openedAt) : '—';
  setText('wr-meta', filtered.length+' trades · compliance+ · since '+firstDate);
}

// ── Best/Worst setups — v14.0: from ghost_trades PEAK+RR (not realized P&L) ──
function renderBW(){
  // From db.loadDailyBreakdown: ghost_trades sorted by peak_rr_pos
  // Fields: symbol, direction, session, vwapPosition, peakRRPos, pnl, stopReason, openedAt
  const best  = window._bestTrades  || [];
  const worst = window._worstTrades || [];
  // peakNegPct: from ghost max_sl_pct_used or peak_rr_neg
  const row = t => {
    const peakNegPct = t.peakRRNeg ?? t.maxSlPct ?? null;
    return '<tr>'+
      '<td class="cb fw" style="font-size:10px">'+t.symbol+'</td>'+
      '<td>'+tBadge(symType(t.symbol))+'</td>'+
      '<td>'+dBadge(t.direction)+'</td>'+
      '<td>'+sBadge(t.session)+'</td>'+
      '<td>'+vBadge(t.vwapPosition)+'</td>'+
      '<td class="'+(t.peakRRPos>0?'cg fw':'cd')+'" style="font-size:10px">'+
        (t.peakRRPos>0 ? f2(t.peakRRPos)+'R' : '—')+'</td>'+
      '<td class="cr" style="font-size:10px">'+
        (peakNegPct>0 ? '-'+f1(peakNegPct)+'%' : '—')+'</td>'+
      '<td class="'+((+(t.pnl||0))>=0?'cg':'cr')+' fw" style="font-size:10px">'+
        (t.pnl!=null ? eu(t.pnl) : '—')+'</td>'+
      '<td class="cd" style="font-size:9px">'+dtS(t.openedAt)+'</td>'+
    '</tr>';
  };
  setHtml('best-body',  (best||[]).map(row).join('')  || emptyRow(9,'No ghost history yet'));
  setHtml('worst-body', (worst||[]).map(row).join('') || emptyRow(9,'No ghost history yet'));
}

// ── Ghost History (by pair, expandable) ──────────────────────────
let _ghhData=[],_ghhF={sess:'all',dir:'all',type:'all'};

function setGHF(k,v,btn){
  _ghhF[k]=v;
  document.querySelectorAll('.fb[onclick*="setGHF"]').forEach(b=>{ if(b.getAttribute('onclick').includes("'"+k+"'")) b.classList.remove('on'); });
  if(btn) btn.classList.add('on');
  renderGhostHistory();
}
async function loadGhostHistory(){
  // Ghost History date filter — filter by opened_at (when ghost tracker started)
  const from = _df.hist.openFrom || null;
  const to   = _df.hist.openTo   || null;
  let url='/api/ghost-history-by-pair';
  const params=[];
  if(from) params.push('from='+encodeURIComponent(from));
  if(to)   params.push('to='  +encodeURIComponent(to+'T23:59:59'));
  if(params.length) url+='?'+params.join('&');
  const d = await api(url) || [];
  console.log('[GhostHistory] Loaded', d.length, 'optimizer key groups, total trades:', d.reduce((s,g)=>s+(g.n||0),0));

  _ghhData = d;
  const total = d.reduce((s,g)=>s+(g.n||0),0);
  setText('h-ghh', total);
  const dateLbl = (from||to) ? (' · '+(from||'begin')+' → '+(to||'nu')) : '';
  setText('ghh-meta', d.length+' combos · '+total+' trades'+dateLbl);
  renderGhostHistory();
}

// ── loadGhostFinalized — chronological finalized ghost list ──────
let _ghfMsVisible=true; // always visible — no toggle
function toggleGHFMilestones(){ _ghfMsVisible=true; } // v14.2: always on
async function loadGhostFinalized(){
  // Load all finalized ghost trades chronologically from /api/ghost-trades
  const d = await api('/api/ghost-trades?limit=500') || [];
  const cnt=d.length;
  setText('ghf-meta', cnt+' finalized ghosts · phantom SL hit only');
  const el=document.getElementById('nb-ghf');
  if(el){ el.style.display=cnt?'':'none'; el.textContent=cnt||''; }
  const tbody=document.getElementById('ghf-body'); if(!tbody) return;
  if(!cnt){ tbody.innerHTML=emptyRow(22,'No finalized ghosts yet — ghosts close only on phantom SL hit (−1R)'); return; }
  // Sort newest first
  const sorted=[...d].sort((a,b)=>new Date(b.closedAt||b.openedAt)-new Date(a.closedAt||a.openedAt));
  let n=0;
  tbody.innerHTML=sorted.map(t=>{
    n++;
    const peakPos=t.peakRRPos??t.peak_rr_pos??0;
    const peakNeg=t.peakRRNeg??t.peak_rr_neg??0;
    const pnl=t.realizedPnlEUR??t.realized_pnl_eur??null;
    const lots=t.lots??null;
    const tpRR=t.tpRRUsed??t.tp_rr_used??null;
    const elapsed=t.openedAt&&t.closedAt?Math.round((new Date(t.closedAt)-new Date(t.openedAt))/60000):null;
    const band=t.vwapBandPct??t.vwap_band_pct??null;
    const keyCount=t.keyCount??t.key_count??null;
    const rrMs=t.rrMilestones||t.rr_milestones||{};
    const openedTs=t.openedAt?new Date(t.openedAt).getTime():null;
    // Single msFn — milestones ALWAYS visible inline (no toggle)
    // v14.2 FIX: phantomSLHit = ALWAYS reached -1.0R → backfill missing ADV milestones
    if((t.phantomSLHit||t.phantom_sl_hit||t.stopReason?.includes?.('phantom_sl')||t.stop_reason?.includes?.('phantom_sl')) && openedTs) {
      const elapsedMs = t.closedAt
        ? new Date(t.closedAt).getTime()-openedTs
        : t.timeToSLMin||t.time_to_sl_min
          ? (t.timeToSLMin||t.time_to_sl_min)*60000
          : null;
      if(elapsedMs) {
        [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].forEach(step=>{
          const key='-'+step.toFixed(1);
          if(!rrMs[key]) rrMs[key]=new Date(openedTs+Math.round(elapsedMs*step)).toISOString();
        });
      }
    }const msFn=(key,isAdv)=>{
      const ts=rrMs[key]||rrMs[key.replace('+','')]||null;
      const cls=(isAdv?'adv-th cr':'fav-th cg');
      if(!ts||!openedTs) return '<td class="'+cls+'" style="font-size:8px;min-width:22px;text-align:center"><span style="opacity:.15">·</span></td>';
      const tsMs=typeof ts==='number'?ts:new Date(ts).getTime();
      const mins=Math.round((tsMs-openedTs)/60000);
      if(mins<0||isNaN(mins)) return '<td class="'+cls+'" style="font-size:8px;min-width:22px;text-align:center"><span style="opacity:.15">·</span></td>';
      return '<td class="'+cls+'" style="font-size:8px;min-width:22px;text-align:center;font-weight:700">'+msFmt(mins)+'</td>';
    };
    // Build all milestone cells -1.0 to -0.1 then +0.1 to +10.0 per 0.1R — NO GAPS
    let msCells='';
    [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].forEach(v=>{ msCells+=msFn('-'+v.toFixed(1),true); });
    for(let v=0.1;v<=6.5+1e-9;v=Math.round((v+0.1)*10)/10){
      const key=v.toFixed(1);
      // Try both '+key' and plain 'key' format
      msCells+=msFn('+'+key,false);
    }
    return '<tr>'+
      '<td class="cd" style="font-size:9px">'+n+'</td>'+
      '<td class="cb fw">'+t.symbol+'</td>'+
      '<td>'+tBadge(symType(t.symbol))+'</td>'+
      '<td>'+sBadge(t.session)+'</td>'+
      '<td>'+dBadge(t.direction)+'</td>'+
      '<td>'+vBadge(t.vwapPosition??t.vwap_position)+'</td>'+
      '<td class="cr fw" style="font-size:9px">STOP SL</td>'+
      '<td class="cd" style="font-size:9px">'+(tpRR!=null?f2(tpRR)+'R':'—')+'</td>'+
      '<td class="'+(peakPos>=2?'cg fw':peakPos>=1?'cg':peakPos>0?'cy':'cd')+'">'+f2(peakPos)+'R</td>'+
      '<td class="cr">'+(peakNeg>0?'-'+f1(peakNeg)+'%':'—')+'</td>'+
      '<td class="'+(band!=null&&band>150?'cr':band!=null&&band>120?'co':'cd')+'" style="font-size:9px">'+(band!=null?f0(band)+'%':'—')+'</td>'+
      '<td class="'+(keyCount>1?'cr fw':'cd')+'" style="font-size:9px" title="#'+keyCount+' = hoeveelste NZDUSD FX SELL BELOW trade vandaag">'+(keyCount!=null?keyCount:'—')+'</td>'+
      '<td class="'+(pnl==null?'cd':pnl>=0?'cg fw':'cr fw')+'">'+(pnl!=null?eu(pnl):'—')+'</td>'+
      '<td class="cd">'+(lots!=null?f2(lots):'—')+'</td>'+
      msCells+
      '<td class="cd" style="font-size:9px">'+dt(t.openedAt)+'</td>'+
      '<td class="cd">'+msFmt(elapsed)+'</td>'+
    '</tr>';
  }).join('');
}
function renderGhostHistory(){
  const data=_ghhData.filter(g=>{
    // null session/direction means unknown — show under 'all' filter only
    if(_ghhF.sess!=='all' && g.session && g.session!==_ghhF.sess) return false;
    if(_ghhF.dir!=='all'  && g.direction && g.direction!==_ghhF.dir) return false;
    if(_ghhF.type!=='all' && symType(g.symbol)!==_ghhF.type) return false;
    return true;
  });
  if(!data.length){
    const total=_ghhData.length;
    const emptyMsg = total>0 ? 'No matches ('+total+' combos hidden by filter)' : 'No ghost history — trades appear here after ghost tracker closes';
    setHtml('ghh-body',emptyRow(16, emptyMsg));
    return;
  }
  const tbody=document.getElementById('ghh-body'); if(!tbody) return;
  tbody.innerHTML=data.map(g=>{
    const safeKey=(g.optimizerKey||'').replace(/[^a-z0-9]/gi,'_');
    const tpRRs=(g.trades||[]).filter(t=>parseFloat(t.peakRRPos||t.maxRR||0)>0).map(t=>parseFloat(t.peakRRPos||t.maxRR));
    const last5=tpRRs.slice(0,5);
    const bestTP=last5.length?'avg '+f2(last5.reduce((s,v)=>s+v,0)/last5.length)+'R':'—';
    const reasons=(g.trades||[]).map(t=>t.stopReason).filter(Boolean);
    const topReason=reasons.length?Object.entries(reasons.reduce((m,r)=>{m[r]=(m[r]||0)+1;return m;},{})).sort((a,b)=>b[1]-a[1])[0][0]:'—';
    // Data completeness: show partial indicator for old trades missing stats
    const pctC = g.pctComplete ?? (g.trades.filter(t=>t.rrMilestones&&Object.keys(t.rrMilestones).length>0).length / Math.max(g.n,1) * 100);
    // Active tracker badge (nActive > 0 = still running in Ghost Tracker)
    const activeBadge = (g.nActive||0) > 0
      ? '<span style="color:var(--g);font-size:8px" title="'+g.nActive+' active ghost tracker(s) voor deze key"> ●</span>'
      : '';
    const complBadge = pctC >= 80 ? '' :
      pctC >= 40 ? '<span title="'+Math.round(pctC)+'% trades with full milestone data" style="font-size:8px;color:var(--y)"> ⚠'+Math.round(pctC)+'%</span>' :
      '<span title="'+Math.round(pctC)+'% trades with full milestone data (older data)" style="font-size:8px;color:var(--ink3)"> ◐'+Math.round(pctC)+'%</span>';
    // EV + Best TP only — no averages
    const ev = g.evEstimate;
    const evLabel = ev!=null
      ? '<span class="'+(ev>0.2?'cg fw':ev>0?'cy':'cr')+'">'+(ev>0?'+':'')+ev.toFixed(2)+'</span>'
      : (g.n>=5?'<span class="cd">calc…</span>':'<span class="cd">need≥5</span>');
    const pnlLabel = g.totalPnl != null
      ? '<span class="'+(g.totalPnl>=0?'cg':'cr')+'">'+eu(g.totalPnl)+'</span>'
      : '—';
    // Best TP = highest RR with Win%>that threshold maximising EV
    const trades=g.trades||[];
    const wr1=trades.filter(t=>(t.peakRRPos||0)>1.0).length;
    const wr2=trades.filter(t=>(t.peakRRPos||0)>2.0).length;
    const pct1=g.n>0?(wr1/g.n*100):0;
    const pct2=g.n>0?(wr2/g.n*100):0;
    // Best TP = locked TP from EV optimizer or computed from peak distribution
    const bestTP = g.lockedTP ?? g.bestTpRR ?? (g.n>=5?(pct2>=40?'2.0R':pct1>=55?'1.5R':'—'):'—');
    const bestTPLabel = typeof bestTP==='number'?bestTP.toFixed(1)+'R':bestTP;
    return '<tr style="cursor:pointer;border-left:3px solid '+(g.direction==='buy'?'var(--g)':'var(--r)')+'" onclick="toggleGHHRow('+Q+safeKey+Q+')">'+
      '<td class="cd" style="font-size:9px">▶</td>'+
      '<td class="cb fw" style="white-space:nowrap">'+g.symbol+activeBadge+complBadge+'</td>'+
      '<td style="min-width:40px">'+tBadge(symType(g.symbol))+'</td>'+
      '<td>'+(g.session?sBadge(g.session):'<span class="cd">—</span>')+'</td>'+
      '<td>'+(g.direction?dBadge(g.direction):'<span class="cd">—</span>')+'</td>'+
      '<td>'+(g.vwapPosition?vBadge(g.vwapPosition):'<span class="cd">—</span>')+'</td>'+
      '<td class="'+(g.n>=5?'cy fw':'cc')+'">'+g.n+'</td>'+
      '<td class="cb">'+(g.nTraded||g.n||0)+'</td>'+
      '<td class="cr">'+(g.nSLHit||0)+'</td>'+
      '<td class="'+(pct1>=55?'cg fw':pct1>=50?'cy':'cr')+'" style="font-size:10px">'+pct1.toFixed(0)+'%</td>'+
      '<td class="'+(pct2>=55?'cg fw':pct2>=40?'cy':'cr')+'" style="font-size:10px">'+pct2.toFixed(0)+'%</td>'+
      '<td style="font-size:9px">'+evLabel+'</td>'+
      '<td class="cc fw">'+bestTPLabel+'</td>'+
      '<td>'+pnlLabel+'</td>'+
    '</tr>'+
    '<tr id="ghh-d-'+safeKey+'" style="display:none">'+
      '<td colspan="14" style="padding:0;background:var(--bg3)">'+
        '<div style="overflow-x:auto"><table style="font-size:9px;min-width:900px">'+
          '<thead><tr>'+
            '<th>#</th><th>Opened</th><th>Closed</th><th>Stop</th><th>TP RR</th>'+
            '<th style="color:var(--g)">Peak+RR</th><th style="color:var(--r)">Peak−%</th><th>Band%</th><th class="cd">P&L</th>'+
            '<th class="adv-th" style="text-align:center" colspan="10">← Adverse (tijd) →</th>'+
            '<th class="fav-th" style="text-align:center" colspan="65">Favorable (tijd) →</th>'+
          '</tr>'+
          '<tr>'+
            '<th colspan="9"></th>'+
            [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>'<th class="adv-th" style="font-size:8px">-'+v.toFixed(1)+'</th>').join('')+
            (()=>{let s='';for(let v=0.1;v<=6.5+1e-9;v=Math.round((v+0.1)*10)/10)s+='<th class="fav-th ghh-ms-col" style="font-size:8px">+'+v.toFixed(1)+'</th>';return s;})()
          +'</tr></thead><tbody>'+
          (g.trades||[]).map((t,i)=>{
            const sr=t.stopReason;
            const isSLHit = sr==='phantom_sl'||t.phantomSLHit;
            const srCls=sr==='phantom_sl'?'cr fw':'cy';
            const rrMs  = t.rrMilestones || {};
            const peakNeg=t.peakRRNeg??t.maxSlPctUsed??0;
            const bandPct=t.vwapBandPct??null;
            const msCellLocal=(key,isFav)=>{
              const iso=rrMs[key]||null;
              const cls=(isFav?'fav-th cg':'adv-th cr');
              // Always visible — no display:none
              if(!iso||!t.openedAt) return '<td class="'+cls+'" style="font-size:8px;min-width:22px;text-align:center;opacity:.2">·</td>';
              const mins=Math.round((new Date(iso)-new Date(t.openedAt))/60000);
              const hh=Math.floor(mins/60),mm=mins%60;
              return '<td class="'+cls+'" style="font-size:8px;min-width:22px;text-align:center;font-weight:700">'+(hh>0?hh+'h'+(mm>0?String(mm).padStart(2,'0')+'m':''):mm+'m')+'</td>';
            };
            return '<tr style="border-bottom:1px solid var(--bdr)">'+
              '<td class="cd">'+(i+1)+'</td>'+
              '<td class="cd" style="font-size:8px">'+dt(t.openedAt)+'</td>'+
              '<td class="cd" style="font-size:8px">'+(t.closedAt?dt(t.closedAt):t._active?'<span class="cg fw">● RUNNING</span>':'<span class="cy">—</span>')+'</td>'+
              '<td class="'+srCls+'" style="font-size:8px">'+
                (sr==='phantom_sl'?'STOP SL':sr==='gap_stop'?'⚡ GAP SL':
                 t._active?'<span style="color:var(--g)">● LIVE</span>':
                 sr?sr:'<span class="cd">—</span>')+'</td>'+
              '<td class="cy">'+(t.tpRRUsed!=null?f2(t.tpRRUsed)+'R':'—')+'</td>'+
              '<td class="cg fw">'+(t.peakRRPos>0?f2(t.peakRRPos)+'R':t._active&&(t.peakRRPos||0)===0?'<span class="cd">0.00R</span>':'—')+'</td>'+
              '<td class="cr">'+(peakNeg>0?'-'+f1(peakNeg)+'%':'—')+'</td>'+
              '<td class="cd" style="font-size:8px">'+(bandPct!=null?f0(bandPct)+'%':'—')+'</td>'+
              '<td class="'+(t.realizedPnlEUR!=null?(t.realizedPnlEUR>=0?'cg':'cr'):'cd')+'" style="font-size:9px">'+
                (t.realizedPnlEUR!=null?eu(t.realizedPnlEUR):'—')+'</td>'+
              [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>{
                let key='-'+v.toFixed(1);
                if(!rrMs[key]&&isSLHit&&Math.abs(v-1.0)<1e-9){
                  const r=Object.assign({},rrMs); r[key]=t.closedAt||null; return msCellLocal.call(null,key,false);
                }
                return msCellLocal(key,false);
              }).join('')+
              (()=>{let s='';for(let v=0.1;v<=6.5+1e-9;v=Math.round((v+0.1)*10)/10){
                s+=msCellLocal(v.toFixed(1),true)||msCellLocal('+'+v.toFixed(1),true);
              }return s;})()
            +'</tr>';
          }).join('')+
        '</tbody></table></div>'+
      '</td>'+
    '</tr>';
  }).join('');
}
function toggleGHHRow(key){ 
  const el=document.getElementById('ghh-d-'+key); 
  if(el) el.style.display=el.style.display==='none'?'':'none'; 
}
let _posMsVisible=false;
function togglePosMilestones(){
  _posMsVisible=!_posMsVisible;
  document.querySelectorAll('.pos-ms-col').forEach(el=>{el.style.display=_posMsVisible?'':'none';});
  const btn=document.getElementById('pos-ms-btn');
  if(btn) btn.textContent=_posMsVisible?'✕ Milestones':'± Milestones';
}
let _ghhMsVisible=false;
let _bgtMsVisible=false;
function toggleBGTMilestones(){
  _bgtMsVisible=!_bgtMsVisible;
  // milestones always visible
  const btn=document.getElementById('bgt-ms-btn');
  if(btn) btn.classList.toggle('on',_bgtMsVisible);
}
function toggleGHHMilestones(){
  _ghhMsVisible=!_ghhMsVisible;
  document.querySelectorAll('.ghh-ms-col').forEach(el=>el.style.display=_ghhMsVisible?'':'none');
  const btn=document.getElementById('ghh-ms-btn');
  if(btn) btn.classList.toggle('on',_ghhMsVisible);
}

// ── Ghost Combo (signal combo grouped) ───────────────────────────
async function loadGhostCombo(){
  // /api/ghost-grouped: {optimizerKey,symbol,session,direction,vwapPosition,n,avgMaxRR,bestMaxRR,avgSlPct,avgTpRR,slHits,lastOpened}
  const d=await api('/api/ghost-grouped')||[];
  setText('ghc-meta',d.length+' combos · compliance+');
  const tbody=document.getElementById('ghc-body'); if(!tbody) return;
  if(!d.length){ tbody.innerHTML=emptyRow(26,'No signal combo data'); return; }
  tbody.innerHTML=d.map(g=>{
    return '<tr>'+
      '<td class="cb fw">'+g.symbol+'</td>'+
      '<td>'+tBadge(symType(g.symbol))+'</td>'+
      '<td>'+sBadge(g.session)+'</td>'+
      '<td>'+dBadge(g.direction)+'</td>'+
      '<td>'+vBadge(g.vwapPosition)+'</td>'+
      '<td class="'+(g.n>=5?'cy fw':'cc')+'">'+g.n+'</td>'+
      '<td class="cc">'+g.n+'</td>'+
      '<td class="cg fw">'+f2(g.bestMaxRR)+'R</td>'+
      '<td class="cd">'+f2(g.avgMaxRR)+'R</td>'+
      '<td class="cd" colspan="4">avg SL used: '+f1(g.avgSlPct)+'%</td>'+
      '<td class="cg" colspan="7">avg TP RR: '+f2(g.avgTpRR)+'R</td>'+
      '<td class="cr" style="font-size:9px">'+g.slHits+' SL hits</td>'+
      '<td class="cd" colspan="3" style="font-size:9px">'+dt(g.lastOpened)+'</td>'+
      '<td class="cd">—</td>'+
      '<td class="'+(g.n>=5?'cg fw':'cd')+'">'+( g.n>=5?f2(g.avgTpRR)+'R':'need≥5')+'</td>'+
    '</tr>';
  }).join('');
}

// ── EV TP Optimizer ───────────────────────────────────────────────
let _evData=[],_evF={type:'all',sess:'all',dir:'all',min:'5'};
function setEVF(k,v,btn){
  _evF[k]=v;
  document.querySelectorAll('.fb[onclick*="setEVF"]').forEach(b=>{ if(b.getAttribute('onclick').includes("'"+k+"'")) b.classList.remove('on'); });
  if(btn) btn.classList.add('on');
  renderEV();
}
async function loadEV(){
  const [g,tp]=await Promise.all([api('/api/ghost-grouped'),api('/api/tp-config')]);
  const grouped=g||[];
  const evKeys=grouped.filter(r=>r.n>=5).map(r=>r.optimizerKey);
  const evResults=await Promise.all(evKeys.map(key=>api('/api/ev-stats?key='+encodeURIComponent(key))));
  const evMap={};
  evKeys.forEach((key,i)=>{ if(evResults[i]) evMap[key]=evResults[i]; });
  _evData=grouped.map(r=>({...r,tpLocked:(tp||{})[r.optimizerKey],evStats:evMap[r.optimizerKey]||null}));
  renderEV();
}
function renderEV(){
  const minN=parseInt(_evF.min)||5;
  const rows=_evData.filter(g=>{
    if(g.n<minN) return false;
    if(_evF.type!=='all'&&symType(g.symbol)!==_evF.type) return false;
    if(_evF.sess!=='all'&&g.session!==_evF.sess) return false;
    if(_evF.dir!=='all'&&g.direction!==_evF.dir) return false;
    return true;
  });
  setText('ev-cnt',rows.length);
  setText('ev-data',rows.filter(r=>r.n>0).length);
  setText('ev-lock',rows.filter(r=>r.tpLocked?.lockedRR).length);
  const posEV=rows.filter(r=>{
    const trades=r.trades||[];
    const wr1=trades.filter(t=>(t.peakRRPos||0)>1.0).length;
    const p1=r.n>0?(wr1/r.n):0;
    const avg=trades.reduce((s,t)=>s+(t.peakRRPos||0),0)/Math.max(r.n,1);
    return p1*avg-(1-p1)>0;
  }).length;
  setText('ev-pos',posEV);
  setText('ev-meta','finalized ghost data (STOP SL only) · ≥'+minN+' ghosts required');
  const totalPnl=rows.reduce((s,r)=>s+(r.trades||[]).reduce((ts,t)=>ts+(t.realizedPnlEUR||0),0),0);
  const pnlEl=document.getElementById('ev-pnl');
  if(pnlEl){ pnlEl.textContent=(totalPnl>=0?'+':'')+'€'+totalPnl.toFixed(2); pnlEl.className='ksv '+(totalPnl>=0?'cg':'cr'); }
  const tbody=document.getElementById('ev-body'); if(!tbody) return;
  if(!rows.length){ tbody.innerHTML=emptyRow(18,'No combos match filters — need finalized ghost data (SL hit)'); return; }
  tbody.innerHTML=rows.map(r=>{
    const tp=r.tpLocked;
    const trades=r.trades||[];
    const wr1=trades.filter(t=>(t.peakRRPos||0)>1.0).length;
    const pct1=r.n>0?(wr1/r.n*100):0;
    const wr2=trades.filter(t=>(t.peakRRPos||0)>2.0).length;
    const pct2=r.n>0?(wr2/r.n*100):0;
    const avgPeak=trades.reduce((s,t)=>s+(t.peakRRPos||0),0)/Math.max(r.n,1);
    const ev=(pct1/100)*avgPeak-(1-pct1/100);
    const bestTP=tp?.lockedRR??r.bestMaxRR??null;
    const avgBand=r.avgBandPct??null;
    const keyCount=r.nTraded||r.n;
    const avgSLMin=trades.filter(t=>t.closedAt&&t.openedAt).reduce((s,t,_,a)=>s+(new Date(t.closedAt)-new Date(t.openedAt))/60000/a.length,0);
    const totalTradePnl=trades.reduce((s,t)=>s+(t.realizedPnlEUR||0),0);
    return '<tr>'+
      '<td class="cb fw">'+r.symbol+'</td>'+
      '<td>'+tBadge(symType(r.symbol))+'</td>'+
      '<td>'+sBadge(r.session)+'</td>'+
      '<td>'+dBadge(r.direction)+'</td>'+
      '<td>'+vBadge(r.vwapPosition)+'</td>'+
      '<td class="'+(r.n>=5?'cy fw':'cc')+'">'+r.n+'</td>'+
      '<td class="cb">'+keyCount+'</td>'+
      '<td class="'+(avgBand!=null&&avgBand>150?'cr':avgBand!=null&&avgBand>120?'co':'cd')+'" style="font-size:9px">'+(avgBand!=null?f0(avgBand)+'%':'—')+'</td>'+
      '<td class="cg fw">'+f2(avgPeak)+'R</td>'+
      '<td class="cg fw">'+f2(r.maxPeakPos??r.bestMaxRR??0)+'R</td>'+
      '<td class="'+(pct1>=55?'cg fw':pct1>=50?'cy':'cr')+'">'+pct1.toFixed(0)+'%</td>'+
      '<td class="'+(pct2>=55?'cg fw':pct2>=45?'cy':'cr')+'">'+pct2.toFixed(0)+'%</td>'+
      '<td class="cc fw" style="font-size:9px">'+(bestTP?f2(bestTP)+'R':'—')+'</td>'+
      '<td class="'+(ev>0.2?'cg fw':ev>0?'cy':'cr')+'">'+(ev>0?'+':'')+ev.toFixed(2)+'</td>'+
      '<td class="'+(tp?.lockedRR?'cg':'cy')+'" style="font-size:9px">'+(tp?.lockedRR?'✓ LOCKED':r.n>=5?'PENDING':'NEED≥5')+'</td>'+
      '<td class="'+(tp?.lockedRR?'cg fw':'cd')+'">'+( tp?.lockedRR?tp.lockedRR+'R':'—')+'</td>'+
      '<td class="cd">'+msFmt(Math.round(avgSLMin))+'</td>'+
      '<td class="'+(totalTradePnl>=0?'cg':'cr')+'" style="font-size:9px">'+eu(totalTradePnl)+'</td>'+
    '</tr>';
  }).join('');
}

// ── EV SL Optimizer ───────────────────────────────────────────────
async function loadEVSL(){
  // Use finalized ghost data (from _evData/loadGhostHistory) — Peak-RR% adverse analysis
  // No MAE — use peakRRNeg as adverse excursion indicator
  const tbody=document.getElementById('evsl-body'); if(!tbody) return;
  const source=_evData||[];
  if(!source.length){ tbody.innerHTML=emptyRow(14,'No finalized ghost data yet — ghosts finalize on SL hit'); return; }
  const rows=source.filter(r=>r.n>=3).map(r=>{
    const trades=r.trades||[];
    const peakNegs=trades.map(t=>t.peakRRNeg||t.maxSlPctUsed||0).filter(v=>v>0);
    const avgNeg=peakNegs.length?peakNegs.reduce((s,v)=>s+v,0)/peakNegs.length:0;
    const maxNeg=peakNegs.length?Math.max(...peakNegs):0;
    const heavyCount=peakNegs.filter(v=>v>80).length;
    const advice=avgNeg<30?{label:'TIGHTEN',cls:'cg'}:avgNeg<60?{label:'MONITOR',cls:'cy'}:{label:'KEEP SL',cls:'cr'};
    const shadowNeg=null; // placeholder for shadow comparison
    return {r,trades,avgNeg,maxNeg,heavyCount,advice,shadowNeg};
  }).filter(x=>x.trades.length>0).sort((a,b)=>a.avgNeg-b.avgNeg);
  tbody.innerHTML=rows.map(({r,avgNeg,maxNeg,heavyCount,advice})=>{
    const avgBand=r.avgBandPct??null;
    const keyCount=r.nTraded||r.n;
    return '<tr>'+
      '<td class="cb fw">'+r.symbol+'</td>'+
      '<td>'+tBadge(symType(r.symbol))+'</td>'+
      '<td>'+sBadge(r.session)+'</td>'+
      '<td>'+dBadge(r.direction)+'</td>'+
      '<td>'+vBadge(r.vwapPosition)+'</td>'+
      '<td class="'+(r.n>=5?'cy fw':'cc')+'">'+r.n+'</td>'+
      '<td class="cb">'+keyCount+'</td>'+
      '<td class="'+(avgBand!=null&&avgBand>150?'cr':avgBand!=null&&avgBand>120?'co':'cd')+'" style="font-size:9px">'+(avgBand!=null?f0(avgBand)+'%':'\u2014')+'</td>'+
      '<td class="'+(avgNeg<30?'cg fw':avgNeg<60?'cy fw':'cr fw')+'">'+f1(avgNeg)+'%</td>'+
      '<td class="'+(maxNeg<50?'cg':maxNeg<80?'cy':'cr fw')+'">'+f1(maxNeg)+'%</td>'+
      '<td class="'+(heavyCount===0?'cg':heavyCount<=2?'cy':'cr fw')+'">'+heavyCount+'</td>'+
      '<td class="'+advice.cls+' fw" style="font-size:9px">'+(advice.label)+'</td>'+
      '<td class="'+advice.cls+'" style="font-size:9px">'+(avgNeg<30?(100-avgNeg).toFixed(0)+'% possible':avgNeg<60?'moderate':'0% — keep'):'\u2014')+'</td>'+
      '<td class="cd" style="font-size:9px">\u2014</td>'+
    '</tr>';
  }).join('');
}

// ── Signals & Blocked ─────────────────────────────────────────────
async function loadSignals(){
  // v13.5.1: gebruik sig date filter voor alle API calls
  const from  = _df.sig.openFrom  || _df.sig.closeFrom || null;
  const to    = _df.sig.openTo    || _df.sig.closeTo   || null;
  const toEnd = to ? to+'T23:59:59' : null;
  const qs    = [from?'since='+encodeURIComponent(from):'', toEnd?'until='+encodeURIComponent(toEnd):''].filter(Boolean).join('&');
  const qStr  = qs ? '?'+qs : '';
  const [stats,sigLog]=await Promise.all([
    api('/api/signal-stats'+qStr),
    api('/api/signal-log'+qStr),
  ]);
  const s=stats||{};
  // KPI counts from signal_log directly
  const allSig = sigLog||[];
  const placedCount   = allSig.filter(r=>(r.outcome||'').toUpperCase()==='PLACED').length;
  const shadowCount   = allSig.filter(r=>['VWAP_EXHAUSTION','DUPLICATE_POSITION','NY_DEAD_ZONE'].includes((r.outcome||'').toUpperCase())).length;
  const blockedCount  = allSig.filter(r=>!['PLACED','VWAP_EXHAUSTION','DUPLICATE_POSITION','NY_DEAD_ZONE'].includes((r.outcome||'').toUpperCase())).length;
  const totalCount    = allSig.length;
  setText('sig-tot',   s.total   || totalCount);
  setText('sig-placed',s.placed  || placedCount);
  setText('sig-conv',  s.conversionPct!=null ? pct(s.conversionPct) : (totalCount>0?pct(placedCount/totalCount*100):'—'));
  setText('blk-tot',   shadowCount + blockedCount);
  // Count by block reason
  const byReason = {};
  allSig.forEach(r=>{ const k=(r.reason||r.outcome||'').toLowerCase(); byReason[k]=(byReason[k]||0)+1; });
  setText('blk-dup', byReason['duplicate_position']||byReason['duplicate_open']||byReason['duplicate']||0);
  setText('blk-vw',  byReason['vwap_exhaustion']||byReason['vwap_exhausted']||byReason['vwap']||0);
  // outside_window is now counted as NY dead zone — no separate counter
  setText('blk-cur', byReason['currency_budget']||byReason['budget']||0);
  setText('blk-ny',  byReason['ny_dead_zone']||byReason['ny_dz']||0);
  const nbSig=document.getElementById('nb-sig');
  if(nbSig){ nbSig.textContent=shadowCount||''; nbSig.style.display=shadowCount?'':'none'; }

  // Build optimizer key frequency maps (today + all-time)
  const todayStr = new Date().toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels'});
  const keyCountToday={}, keyCountAll={};
  allSig.forEach(r=>{
    if(!r.symbol||!r.session||!r.direction||!r.vwap_position) return;
    const k=r.symbol+'_'+r.session+'_'+r.direction+'_'+r.vwap_position;
    keyCountAll[k]=(keyCountAll[k]||0)+1;
    const rDate=r.ts?new Date(r.ts).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels'}):null;
    if(rDate===todayStr) keyCountToday[k]=(keyCountToday[k]||0)+1;
  });

  // Split: valid signals vs errors (no positionId, fetch failed, MetaAPI error)
  const ERROR_OUTCOMES=['FETCH_FAILED','NO_POSITION_ID','METAAPI_ERROR','TIMEOUT','EXCEPTION','UNKNOWN_ERROR','PLACE_FAILED','API_ERROR'];
  const validSigs=allSig.filter(r=>!ERROR_OUTCOMES.includes((r.outcome||'').toUpperCase())&&!(r.error||r.is_error));
  const errorSigs=allSig.filter(r=>ERROR_OUTCOMES.includes((r.outcome||'').toUpperCase())||(r.error||r.is_error));

  // Full signal log — one row per signal, shows exact destination
  const outcomeDestination = r => {
    const oc = (r.outcome||'').toUpperCase();
    const bandPct = r.band_pct ? f1(r.band_pct)+'%' : '';
    if(oc==='PLACED')
      return {label:'→ Ghost Tracker', cls:'cg fw',
              badge:'<span style="background:#1b5e20;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">PLACED</span>'};
    if(oc==='NY_DEAD_ZONE')
      return {label:'→ Shadow (NY Zone 15:30–18:00)', cls:'co fw',
              badge:'<span style="background:#e65100;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">⏰ NY 15:30–18:00</span>'};
    if(oc==='DUPLICATE_POSITION')
      return {label:'→ Shadow (Duplicate)', cls:'cy fw',
              badge:'<span style="background:#f57f17;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">📌 DUP</span>'};
    if(oc==='VWAP_EXHAUSTION')
      return {label:'→ Shadow (VWAP '+(bandPct||'>150%')+')', cls:'cp fw',
              badge:'<span style="background:#4a148c;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">📊 VWAP</span>'};
    // Distinguish outside night (21:00-02:00) from outside window (general)
    if(oc==='OUTSIDE_WINDOW'||(r.reason||'').includes('OUTSIDE')){
      const rStr=r.reason||'';
      const isNight=rStr.includes('2100')||rStr.includes('0200')||rStr.includes('21:')||rStr.includes('02:');
      // 21:00-02:00 = logged as NY (3 sessions only: asia/london/ny)
      if(isNight) return {label:'→ Shadow (NY Late 21:00–02:00)', cls:'co fw',
        badge:'<span style="background:#b34500;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">⏰ NY 21–02h</span>'};
      return {label:'→ Shadow (NY Late)', cls:'co fw',
              badge:'<span style="background:#b34500;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">⏰ NY</span>'};
    }
    if(oc==='ORDER_NOT_CONFIRMED')
      return {label:'⚠ Not confirmed', cls:'cy',
              badge:'<span style="color:var(--y)">UNCONF</span>'};
    return {label:'→ '+( r.reason||oc).slice(0,25), cls:'cr',
            badge:'<span style="background:#b71c1c;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">BLOCK</span>'};
  };

  setHtml('placed-body', validSigs.length ? validSigs.map(r=>{
    const dest = outcomeDestination(r);
    const optKey=(r.symbol||'')+'_'+(r.session||'')+'_'+(r.direction||'')+'_'+(r.vwap_position||'');
    const kToday=keyCountToday[optKey]||0;
    const kAll=keyCountAll[optKey]||0;
    return '<tr>'+
      '<td class="cd" style="font-size:9px">'+dt(r.ts)+'</td>'+
      '<td class="cb fw">'+( r.symbol||'—')+'</td>'+
      '<td>'+tBadge(symType(r.symbol||''))+'</td>'+
      '<td>'+(r.direction?dBadge(r.direction):'—')+'</td>'+
      '<td>'+(r.session?sBadge(r.session):'—')+'</td>'+
      '<td>'+(r.vwap_position?vBadge(r.vwap_position):'—')+'</td>'+
      '<td class="cd">'+fPrice(r.entry,r.symbol)+'</td>'+
      '<td class="cd">'+(r.sl_pct!=null?pct(r.sl_pct*100):'—')+'</td>'+
      '<td class="'+(r.band_pct!=null&&r.band_pct>150?'cr fw':r.band_pct!=null&&r.band_pct>120?'co':'cd')+'">'+(r.band_pct!=null?f0(r.band_pct)+'%':'—')+'</td>'+
      '<td>'+dest.badge+'</td>'+
      '<td class="'+dest.cls+'" style="font-size:9px">'+dest.label+'</td>'+
      '<td class="'+(kToday>1?'cr fw':kToday>0?'cy':'cd')+'" style="font-size:9px">'+kToday+'</td>'+
      '<td class="cb" style="font-size:9px">'+kAll+'</td>'+
      (()=>{ const lms=r.latency_ms; const lc=lms==null?'cd':lms<500?'cg':lms<2000?'cy':'cr';
        return '<td class="'+lc+'">'+( lms!=null?lms+'ms':'—')+'</td>'; })()+
    '</tr>';
  }).join('') : emptyRow(14,'No signals found · adjust filter or wait for new webhooks'));

  // Error signals section
  const errCnt=errorSigs.length;
  setText('sig-err-meta', errCnt+' errors · fetch failed · no positionId · MetaAPI timeout · other');
  setHtml('sig-err-body', errCnt ? errorSigs.map(r=>{
    const errType=(r.outcome||r.error_type||'UNKNOWN').toUpperCase();
    const errDetail=r.error||r.reason||r.detail||'—';
    return '<tr>'+
      '<td class="cd" style="font-size:9px">'+dt(r.ts)+'</td>'+
      '<td class="cb fw">'+( r.symbol||'—')+'</td>'+
      '<td>'+(r.direction?dBadge(r.direction):'—')+'</td>'+
      '<td>'+(r.session?sBadge(r.session):'—')+'</td>'+
      '<td class="cr fw" style="font-size:9px">'+errType+'</td>'+
      '<td class="cr" style="font-size:9px;max-width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis" title="'+errDetail+'">'+errDetail.slice(0,60)+'</td>'+
      '<td class="cd">'+fPrice(r.entry,r.symbol)+'</td>'+
      '<td class="cd" style="font-size:9px">'+(r.retried?'<span class="cg">✓ Retried</span>':'—')+'</td>'+
    '</tr>';
  }).join('') : emptyRow(8,'No signal errors — all signals reached Ghost or Shadow tracker'));
}

async function loadBlockedRaw(){
  // v13.5.1: gebruik sig date filter
  const from = _df.sig.openFrom || _df.sig.closeFrom || null;
  const to   = _df.sig.openTo   || _df.sig.closeTo   || null;
  const qs   = [from?'since='+encodeURIComponent(from):'', to?'until='+encodeURIComponent(to+'T23:59:59'):''].filter(Boolean).join('&');
  const d=await api('/api/blocked-raw'+(qs?'?'+qs:''))||[];
  setText('blkraw-meta',d.length+' entries · compliance+');
  setHtml('blkraw-body',d.length?d.slice(0,200).map(r=>
    '<tr>'+
    '<td class="cb fw">'+r.symbol+'</td>'+
    '<td>'+dBadge(r.direction)+'</td>'+
    '<td>'+vBadge(r.vwapPosition)+'</td>'+
    '<td>'+sBadge(r.session)+'</td>'+
    '<td class="'+(r.outcome==='PLACED'?'cg':'cr')+'" style="font-size:9px">'+(r.outcome||'—')+'</td>'+
    '<td class="cr" style="font-size:9px">'+(r.rejectReason||'—')+'</td>'+
    '<td class="cr fw">'+(r.count||1)+'</td>'+
    '<td class="cd" style="font-size:9px">'+dt(r.lastSeen)+'</td>'+
    '</tr>'
  ).join(''):emptyRow(8,'No blocked raw data'));
}

async function loadBand(){
  const [b1,b2]=await Promise.all([
    api('/api/band-ghost-stats?bandTier=150_250'),
    api('/api/band-ghost-stats?bandTier=250_350'),
  ]);
  const fill=(data,bId)=>{
    const tbody=document.getElementById(bId); if(!tbody) return;
    if(!data?.length){ tbody.innerHTML=emptyRow(8,'No band data'); return; }
    tbody.innerHTML=data.slice(0,30).map(r=>'<tr>'+
      '<td class="cb fw">'+r.symbol+'</td>'+
      '<td>'+sBadge(r.session||'—')+'</td>'+
      '<td>'+dBadge(r.direction||'buy')+'</td>'+
      '<td>'+vBadge(r.vwapPosition||r.vwap_position||'above')+'</td>'+
      '<td class="cc">'+(r.n||0)+'</td>'+
      '<td class="cg">'+f2(r.avgMaxRR||r.avg_max_rr)+'R</td>'+
      '<td class="cg fw">'+f2(r.bestMaxRR||r.best_max_rr)+'R</td>'+
      '<td class="cd">'+f1(r.avgSlPct||r.avg_sl_pct)+'%</td>'+
    '</tr>').join('');
  };
  fill(b1,'b150-body'); fill(b2,'b250-body');
}

// ── Boot ──────────────────────────────────────────────────────────
// Initialise milestone styles
(function(){
  const s=document.createElement('style'); s.id='ms-style';
  s.textContent='.ms-adv,.ms-fav{display:none!important}';
  document.head.appendChild(s);
  // Also hide th columns
  document.addEventListener('DOMContentLoaded',()=>{
    document.querySelectorAll('th.adv-th,th.fav-th').forEach(el=>el.style.display='none');
  });
})();

// ══════════════════════════════════════════════════════════════════
//  SHADOW PLAYBOOK — Blocked Ghost Tracker UI
// ══════════════════════════════════════════════════════════════════
let _bgtTab = 'ny';
let _bgtFilters = {
  ny:   { sess: 'all', dir: 'all', type: 'all' },
  ow:   { sess: 'all', dir: 'all', type: 'all' },
  dup:  { sess: 'all', dir: 'all', type: 'all' },
  vwap: { sess: 'all', dir: 'all', band: 'all' },
};
let _bgtData = { ny: [], ow: [], dup: [], vwap: [] };

function setBGTTab(tab) {
  _bgtTab = tab;
  ['ny','dup','vwap'].forEach(t => {
    const pane = document.getElementById('bgt-pane-'+t);
    const tabEl= document.getElementById('bgt-tab-'+t);
    if(pane) pane.style.display = t === tab ? '' : 'none';
    if(tabEl){
      tabEl.classList.toggle('on', t === tab);
      const col = t==='ny'||t==='ow'?'var(--o)':t==='dup'?'var(--y)':'var(--p)';
      tabEl.style.borderBottomColor = t === tab ? col : 'transparent';
      tabEl.style.color = t === tab ? col : 'var(--ink3)';
    }
  });
}

function setBGTFilter(tab, key, val, btn) {
  _bgtFilters[tab][key] = val;
  // deselect sibling buttons with same key
  if(btn) {
    const par = btn.closest('.fbar');
    if(par) {
      par.querySelectorAll('.fb').forEach(b => {
        const oc = b.getAttribute('onclick') || '';
        if(oc.startsWith('setBGTFilter(') && oc.includes(tab) && oc.includes(key)) b.classList.remove('on');
      });
    }
    btn.classList.add('on');
  }
  renderBGTTable(tab);
}

// Verdict helper: geeft een aanbeveling op basis van win rate + avg RR
function bgtVerdict(g) {
  const slRate = g.n > 0 ? g.nSLHit / g.n : 1;
  const avg    = g.avgPeakPos ?? 0;
  const mx     = g.maxPeakPos ?? 0;
  if(slRate <= 0.3 && avg >= 1.5) return '<span class="cg fw">✅ Playbook worthy</span>';
  if(slRate <= 0.5 && avg >= 1.0) return '<span class="cy">⚠ Mogelijk</span>';
  if(slRate >= 0.7) return '<span class="cr">❌ Te risicovol</span>';
  return '<span class="cd">🔍 Meer data</span>';
}

function renderBGTTable(tab) {
  const raw  = _bgtData[tab] || [];
  const filt = _bgtFilters[tab];
  const data = raw.filter(g => {
    if(filt.sess && filt.sess !== 'all' && g.session !== filt.sess) return false;
    if(filt.dir  && filt.dir  !== 'all' && g.direction !== filt.dir) return false;
    if(filt.type && filt.type !== 'all' && symType(g.symbol) !== filt.type) return false;
    if(filt.band && filt.band !== 'all' && tab === 'vwap') {
      const avgBand = (g.trades||[]).reduce((s,t)=>s+(t.vwapBandPct||0),0) / (g.trades?.length||1);
      if(filt.band === '150_200' && !(avgBand >= 150 && avgBand < 200)) return false;
      if(filt.band === '200_300' && !(avgBand >= 200 && avgBand < 300)) return false;
      if(filt.band === '300plus' && !(avgBand >= 300)) return false;
    }
    return true;
  });

  const tblId = 'bgt-'+tab+'-body';
  const cols  = tab === 'vwap' ? 14 : 13;
  if(!data.length){ setHtml(tblId, emptyRow(cols, 'Geen blocked ghost data')); return; }

  const tbody = document.getElementById(tblId); if(!tbody) return;
  tbody.innerHTML = data.map(g => {
    const safeKey = (g.optimizerKey||'').replace(/[^a-z0-9]/gi,'_');
    const trades = g.trades||[];
    const avgBand = trades.length ? (trades.reduce((s,t)=>s+(t.vwapBandPct||0),0)/trades.length).toFixed(0)+'%' : null;
    const wr1=trades.filter(t=>(t.peakRRPos||0)>1.0).length;
    const pct1=g.n>0?(wr1/g.n*100):0;
    const wr2=trades.filter(t=>(t.peakRRPos||0)>2.0).length;
    const pct2=g.n>0?(wr2/g.n*100):0;
    const rowId = safeKey+'_'+tab;
    const mainRow = '<tr style="cursor:pointer;border-left:3px solid var(--p)" onclick="toggleBGTRow('+Q+rowId+Q+')">'+
      '<td class="cd" style="font-size:9px">▶</td>'+
      '<td class="cp fw">'+g.symbol+'</td>'+
      '<td>'+tBadge(symType(g.symbol))+'</td>'+
      '<td>'+sBadge(g.session)+'</td>'+
      '<td>'+dBadge(g.direction)+'</td>'+
      '<td>'+vBadge(g.vwapPosition)+'</td>'+
      '<td class="cy fw">'+g.n+'</td>'+
      '<td class="cr">'+g.nSLHit+'</td>'+
      '<td class="cg fw">'+f2(g.avgPeakPos??g.avg_peak_pos??0)+'R</td>'+
      '<td class="cg fw">'+f2(g.maxPeakPos??g.max_peak_pos??0)+'R</td>'+
      '<td class="cr">'+(g.avgPeakNeg>0?f1(g.avgPeakNeg)+'%':'—')+'</td>'+
      (avgBand ? '<td class="'+(parseFloat(avgBand)>150?'cr fw':parseFloat(avgBand)>120?'co':'cd')+'">'+avgBand+'</td>' : '<td class="cd">—</td>')+
      '<td class="'+(pct1>=55?'cg fw':pct1>=50?'cy':'cr')+'">'+pct1.toFixed(0)+'%</td>'+
      '<td class="'+(pct2>=55?'cg fw':pct2>=45?'cy':'cr')+'">'+pct2.toFixed(0)+'%</td>'+
      '<td>'+bgtVerdict(g)+'</td>'+
    '</tr>';

    // Detail sub-table — ALL 0.1R milestones, no gaps
    const detailRow = '<tr id="bgt-d-'+safeKey+'_'+tab+'" style="display:none">'+
      '<td colspan="15" style="padding:0;background:var(--bg3)">'+
        '<div style="overflow-x:auto"><table style="font-size:8.5px;min-width:700px">'+
          '<thead><tr>'+
            '<th>#</th><th>Opened</th><th>Closed</th>'+
            (tab==='ny'  ? '<th style="color:var(--o)">⏰ NY Time</th>' : '')+
            (tab==='dup' ? '<th style="color:var(--y)">📌 #Dup</th>' : '')+
            (tab==='vwap'? '<th style="color:var(--r)">📊 Band%</th>' : '')+
            '<th>Stop</th><th style="color:var(--g)">Peak+RR</th><th style="color:var(--r)">Peak−%</th><th>Elapsed</th>'+
            [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>'<th class="adv-th" style="font-size:7.5px">-'+v.toFixed(1)+'</th>').join('')+
            (()=>{let s='';for(let v=0.1;v<=6.5+1e-9;v=Math.round((v+0.1)*10)/10)s+='<th class="fav-th" style="font-size:7.5px">+'+v.toFixed(1)+'</th>';return s;})()
          +'</tr></thead><tbody>'+
          trades.map((t,i) => {
            const sr = t.stopReason||t.stop_reason;
            const isSLHit = sr==='phantom_sl'||t.phantomSLHit;
            const rrMs = t.rrMilestones||t.rr_milestones||{};
            const msC = (key, isFav) => {
              const iso=rrMs[key]||null;
              const cls = isFav ? 'fav-th cg' : 'adv-th cr';
              if(!iso||!t.openedAt) return '<td class="'+cls+'" style="font-size:7.5px;min-width:20px">—</td>';
              const mins = Math.round((new Date(iso)-new Date(t.openedAt))/60000);
              const h=Math.floor(mins/60),m=mins%60;
              return '<td class="'+cls+'" style="font-size:7.5px;font-weight:700;min-width:20px">'+(h>0?h+'h'+m+'m':m+'m')+'</td>';
            };
            const elapsed = t.openedAt && t.closedAt
              ? Math.round((new Date(t.closedAt)-new Date(t.openedAt))/60000) : null;
            return '<tr style="background:'+(isSLHit?'rgba(248,81,73,.05)':'var(--bg3)')+'">'+
              '<td class="cd">'+(i+1)+'</td>'+
              '<td class="cd" style="font-size:8px">'+dt(t.openedAt)+'</td>'+
              '<td class="cd" style="font-size:8px">'+(t.closedAt?dt(t.closedAt):'<span class="cg fw">● LIVE</span>')+'</td>'+
              (tab==='ny'  ? '<td class="co" style="font-size:8px">'+dt(t.openedAt)+'</td>' : '')+
              (tab==='dup' ? '<td class="cy" style="font-size:8px">#'+(i+1)+'/'+g.n+'</td>' : '')+
              (tab==='vwap'? '<td class="cr fw" style="font-size:8px">'+(t.vwapBandPct?f1(t.vwapBandPct)+'%':'—')+'</td>' : '')+
              '<td class="'+(isSLHit?'cr fw':'cy')+'" style="font-size:8px">'+(isSLHit?'STOP SL':sr||'—')+'</td>'+
              '<td class="'+(( t.peakRRPos||0)>=2?'cg fw':(t.peakRRPos||0)>=1?'cg':'cy')+'">'+f2(t.peakRRPos||0)+'R</td>'+
              '<td class="cr">'+(t.peakRRNeg>0?f1(t.peakRRNeg)+'%':'—')+'</td>'+
              '<td class="cd">'+msFmt(elapsed)+'</td>'+
              [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>{
                const key='-'+v.toFixed(1);
                let iso=rrMs[key]||null;
                if(!iso&&isSLHit&&Math.abs(v-1.0)<1e-9) iso=t.closedAt||null;
                return msC(key,false);
              }).join('')+
              (()=>{let s='';for(let v=0.1;v<=6.5+1e-9;v=Math.round((v+0.1)*10)/10){
                const k=v.toFixed(1);
                s+=msC('+'+k,true)||msC(k,true);
              }return s;})()
            +'</tr>';
          }).join('')+
        '</tbody></table></div>'+
      '</td></tr>';

    return mainRow + detailRow;
  }).join('');
}

function toggleBGTRow(key) {
  const el = document.getElementById('bgt-d-'+key);
  if(el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

async function loadShadowPlaybook() {
  const from = document.getElementById('bgt-from')?.value || null;
  const to   = document.getElementById('bgt-to')?.value   || null;
  const toFull = to ? to + 'T23:59:59' : null;
  const meta  = document.getElementById('bgt-date-meta');
  if(meta) meta.textContent = (from||to) ? (from||'begin')+' → '+(to||'nu') : 'All shadow trackers';
  const todayBrus=new Date().toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels'});

  // Active blocked ghosts
  const active = await api('/api/blocked-ghosts/active') || [];
  // Also fetch finalized blocked ghosts closed TODAY — keep them visible till EOD
  const finBgt = await api('/api/blocked-ghosts/history?limit=200') || [];
  const finToday = finBgt.filter(t=>t.closedAt&&
    new Date(t.closedAt).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels'})===todayBrus);
  // Merge, deduplicate by id
  const activeIds=new Set(active.map(b=>b.id||b.positionId));
  const combined=[...active,...finToday.filter(t=>!activeIds.has(t.id||t.positionId))];

  const nbBgt  = document.getElementById('nb-bgt');
  if(nbBgt&&combined.length) { nbBgt.textContent=combined.length; nbBgt.style.display=''; }
  setText('bgt-active-meta', combined.length + ' shadow trackers (active + today SL hit)');
  const now = Date.now();
  setHtml('bgt-active-body', combined.length ? combined.map(bg => {
    const isSLHit = bg.phantomSLHit||bg.phantom_sl_hit||!!bg.closedAt;
    const elapsed = bg.openedAt ? Math.round((now - new Date(bg.openedAt))/60000) : null;
    const bt = bg.blockType||bg.block_type||'';
    const btBadge = bt==='NY_DEAD_ZONE'
      ? '<span style="background:#e65100;color:#fff;padding:1px 4px;border-radius:3px;font-size:8px">⏰ NY ZONE</span>'
      : bt==='OUTSIDE_WINDOW'
      ? '<span style="background:#01579b;color:#fff;padding:1px 4px;border-radius:3px;font-size:8px">🌙 OUT WIN</span>'
      : bt==='DUPLICATE'
      ? '<span style="background:#f57f17;color:#fff;padding:1px 4px;border-radius:3px;font-size:8px">📌 DUP#'+(bg.duplicateCount??bg.duplicate_count??'?')+'</span>'
      : bt==='VWAP_EXHAUSTION'
      ? '<span style="background:#4a148c;color:#fff;padding:1px 4px;border-radius:3px;font-size:8px">📊 VWAP '+(bg.vwapBandPct?f0(bg.vwapBandPct)+'%':'')+'</span>'
      : '<span style="background:#37474f;color:#fff;padding:1px 4px;border-radius:3px;font-size:8px">'+bt+'</span>';
    const rrMs = bg.rrMilestones||bg.rr_milestones||{};
    const peakPos=bg.peakRRPos??bg.peak_rr_pos??0;
    const peakNeg=bg.peakRRNeg??bg.peak_rr_neg??bg.maxSlPctUsed??0;
    const band=bg.vwapBandPct??bg.vwap_band_pct??null;
    const msBgt=(key,isFav)=>{
      const iso=rrMs[key]||null;
      const d=_bgtMsVisible?'':'none';
      const cls=(isFav?'fav-th cg':'adv-th cr')+'';
      if(!iso||!bg.openedAt) return '<td class="'+cls+'" style="display:'+d+';font-size:7.5px;min-width:20px">—</td>';
      const mins=Math.round((new Date(iso)-new Date(bg.openedAt))/60000);
      const h=Math.floor(mins/60),m=mins%60;
      return '<td class="'+cls+'" style="display:'+d+';font-size:7.5px;font-weight:700;min-width:20px">'+(h>0?h+'h'+m+'m':m+'m')+'</td>';
    };
    // Build all 0.1R milestone cells
    let msAdv='',msFav='';
    [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].forEach(v=>{ msAdv+=msBgt('-'+v.toFixed(1),false); });
    for(let v=0.1;v<=6.5+1e-9;v=Math.round((v+0.1)*10)/10){
      const k=v.toFixed(1);
      msFav+=msBgt('+'+k,true)||msBgt(k,true);
    }
    return '<tr style="'+(isSLHit?'background:rgba(248,81,73,.05)':'')+'">'+
      '<td class="cp fw" style="position:sticky;left:0;background:var(--bg3);font-size:10px">'+bg.symbol+(isSLHit?'<span style="color:var(--r);font-size:7.5px;margin-left:3px;font-weight:700">●SL</span>':'')+'</td>'+
      '<td>'+tBadge(symType(bg.symbol))+'</td>'+
      '<td>'+btBadge+'</td>'+
      '<td>'+dBadge(bg.direction||bg.dir)+'</td>'+
      '<td>'+vBadge(bg.vwapPosition||bg.vwap_position)+'</td>'+
      '<td>'+sBadge(bg.session)+'</td>'+
      '<td class="cd">'+fPrice(bg.entry,bg.symbol)+'</td>'+
      '<td class="'+(peakPos>=2?'cg fw':peakPos>=1?'cg':peakPos>0?'cy':'cd')+'">'+f2(peakPos)+'R</td>'+
      '<td class="'+(peakNeg>80?'cr fw':peakNeg>50?'cr':peakNeg>25?'co':'cd')+'">'+
        (peakNeg>0?'-'+f1(peakNeg)+'%':'—')+'</td>'+
      '<td class="'+(band!=null&&band>150?'cr fw':band!=null&&band>120?'co':'cd')+'" style="font-size:9px">'+(band!=null?f0(band)+'%':'—')+'</td>'+
      '<td class="cd" style="font-size:9px">'+dt(bg.openedAt)+'</td>'+
      '<td class="cd">'+msFmt(elapsed)+'</td>'+
      msAdv+msFav+
    '</tr>';
  }).join('') : emptyRow(55,'No active or today-finalized shadow trackers'));

  // Load history for the 3 block types in parallel
  const buildUrl = (type) => {
    let url = '/api/blocked-ghosts/history?blockType='+type;
    if(from) url += '&from='+encodeURIComponent(from);
    if(toFull) url += '&to='+encodeURIComponent(toFull);
    return url;
  };
  const [nyData, owData, dupData, vwapData] = await Promise.all([
    api(buildUrl('NY_DEAD_ZONE'))   || [],
    api(buildUrl('OUTSIDE_WINDOW')) || [],
    api(buildUrl('DUPLICATE'))      || [],
    api(buildUrl('VWAP_EXHAUSTION'))|| [],
  ]);
  _bgtData.ny   = nyData;
  _bgtData.ow   = owData;
  _bgtData.dup  = dupData;
  _bgtData.vwap = vwapData;

  renderBGTTable('ny');
  renderBGTTable('dup');
  renderBGTTable('vwap');
}

async function loadAll(){
  // 1. Status poll + live positions + ghost trackers in parallel
  await Promise.all([pollStatus(), loadPositions(), loadGhostTrackers()]);
  // 2. Trade history + daily breakdown + ghost grouped — respect Overview date filter
  const ov = _df.ov;
  const ovQs = [
    ov.openFrom  ? 'openFrom='  + encodeURIComponent(ov.openFrom)               : '',
    ov.openTo    ? 'openTo='    + encodeURIComponent(ov.openTo + 'T23:59:59')   : '',
    ov.closeFrom ? 'since='     + encodeURIComponent(ov.closeFrom)              : '',
    ov.closeTo   ? 'until='     + encodeURIComponent(ov.closeTo + 'T23:59:59')  : '',
  ].filter(Boolean).join('&');
  const ovQ = ovQs ? '?' + ovQs : '';
  const [trades,daily,ghGrouped,perfStats]=await Promise.all([
    api('/api/trades' + ovQ),
    api('/api/daily-breakdown'),
    api('/api/ghost-grouped'),
    api('/api/performance'),
  ]);
  // Render performance KPIs (perfStats may be null if DB not ready yet)
  if(perfStats && perfStats.total != null) {
    const pf = perfStats.profitFactor;
    setText('p-wr',   (perfStats.winRate||0).toFixed(1)+'%');
    setHtml('p-pf',   pf!=null ? '<span class="'+(pf>=1.5?'cg fw':pf>=1?'cy':'cr')+'">'+(pf||0).toFixed(2)+'</span>' : '—');
    setText('p-exp',  eu(perfStats.expectancy));
    const sh = perfStats.sharpe;
    setHtml('p-sharpe', sh!=null ? '<span class="'+(sh>=1?'cg':sh>=0?'cy':'cr')+'">'+(sh||0).toFixed(2)+'</span>' : '—');
    setText('p-dd',   eu(perfStats.maxDrawdown));
    const cal = perfStats.calmar;
    setHtml('p-calmar', cal!=null ? '<span class="'+(cal>=1?'cg':cal>=0?'cy':'cr')+'">'+(cal||0).toFixed(2)+'</span>' : '—');
    setText('p-avgwin',  eu(perfStats.avgWin));
    setText('p-avgloss', eu(perfStats.avgLoss));
    setText('perf-meta', perfStats.total+' trades · PF: '+(pf??'—')+'· WR: '+perfStats.winRate+'%');
  }
  _allTrades=(trades||[]);
  renderOverview(_allTrades,daily,ghGrouped);
  // Update last-refresh timestamp
  const lrEl = document.getElementById('last-refresh');
  if(lrEl) lrEl.textContent = 'Updated ' + new Date().toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

async function waitForDBAndLoad() {
  // Clear all filters and autofill on load
  _dfReset('ov', true);
  Object.assign(_df.ov, {openFrom:null,openTo:null,closeFrom:null,closeTo:null});
  document.querySelectorAll('input[type="date"]').forEach(el => { el.value = ''; });
  document.querySelectorAll('[id$="-df-active"]').forEach(el => { el.style.display = 'none'; });

  // First load — try immediately
  await loadAll();

  // If DB was not ready yet (trades=0 but server is up), retry with backoff
  // Checks: if we have 0 trades after first load, keep retrying every 3s for up to 30s
  let retries = 0;
  const retryInterval = setInterval(async () => {
    if (retries >= 10) { clearInterval(retryInterval); return; } // give up after 30s
    const s = await api('/status', 3000);
    if (s && s.dbReady && (_allTrades||[]).length === 0) {
      console.log('[Dashboard] DB now ready, reloading data (retry '+(retries+1)+')');
      await loadAll();
    }
    if ((_allTrades||[]).length > 0) clearInterval(retryInterval); // got data, stop
    retries++;
  }, 3000);

  // Normal 30s refresh
  setInterval(loadAll, 30000);
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded', waitForDBAndLoad);
}else{
  waitForDBAndLoad();
}
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
      if (attempt < 5) await new Promise(r => setTimeout(r, 3000 * attempt));
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
        console.warn(`[DB] Skipping incomplete ghost state ${gs.positionId} — missing direction/entry/sl`);
        continue;
      }
      // v14.0: Preserve phantomSLHit/stopReason from ghost_state (don't reset on restart)
      const ghost = { ...gs, maxPrice: gs.maxPrice??gs.entry, maxRR: gs.maxRR??0,
        maxSlPctUsed: gs.maxSlPctUsed??0, slMilestones: gs.slMilestones??{},
        rrMilestones: gs.rrMilestones??{},
        peakRRPos: gs.peakRRPos??0, peakRRNeg: gs.peakRRNeg??0,
        phantomSLHit: gs.phantomSLHit??false,
        stopReason: gs.stopReason??null, closedAt: null };
      // Reconstruct TP from tpRRUsed stored in ghost (sl distance × tpRR)
      const _slDist = Math.abs((gs.entry||0) - (gs.sl||0));
      const _tp = (gs.tpRRUsed && _slDist > 0)
        ? parseFloat((gs.direction === 'buy'
            ? gs.entry + _slDist * gs.tpRRUsed
            : gs.entry - _slDist * gs.tpRRUsed).toFixed(6))
        : null;
      openPositions.set(gs.positionId, {
        positionId: gs.positionId, symbol: gs.symbol, mt5Symbol: gs.mt5Symbol??gs.symbol,
        direction: gs.direction, vwapPosition: gs.vwapPosition,
        session: gs.session, entry: gs.entry, sl: gs.sl, tp: _tp, lots: gs.lots ?? null,
        riskPct: gs.riskPct, riskEUR: gs.riskEUR, openedAt: gs.openedAt,
        optimizerKey: gs.optimizerKey, ghost });
    }
    console.log(`[DB] Restored ${openPositions.size} positions from ghost_state`);
    // Also immediately sync with MT5 to adopt any positions not in ghost_state
    // Don't wait — this runs in background
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
    }, 3000); // wait 3s for MetaAPI connection to stabilize
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
      else console.log(`[DB] All MT5 positions already in ghost_state — no adoption needed`);
    } catch (e) { console.warn(`[DB] MT5 adoption check failed: ${e.message}`); }
  }

  // Sync trade number sequence
  db.syncTradeNumberSequence().catch(() => {});

  // Mark DB as ready
  dbReady = true;
  console.log("[PRONTO-AI] ✅ DB ready — all systems operational");

  // MetaAPI connectivity check
  if (META_API_TOKEN && META_ACCOUNT) {
    console.log(`[MetaAPI] Checking connectivity — account ${META_ACCOUNT.slice(0,8)}…`);
    try {
      const acct = await Promise.race([
        metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 15s")), 15000)),
      ]);
      if (acct) {
        console.log(`[MetaAPI] ✅ Connected — balance: ${acct.balance} ${acct.currency}`);
      } else {
        console.warn("[MetaAPI] ⚠️ Response empty — account may still be deploying");
      }
    } catch (e) {
      console.error(`[MetaAPI] ❌ Connection failed: ${e.message}`);
      recordError(`MetaAPI startup check: ${e.message}`);
    }
  } else {
    console.warn("[MetaAPI] ⚠️ META_API_TOKEN or META_ACCOUNT not set — MetaAPI disabled");
  }

  // Start cron jobs
  cron.schedule("*/10 * * * * *", syncPositions); // 10s for responsive P&L + milestones
  cron.schedule("*/5 * * * *",    runShadowSnapshots);
  cron.schedule("0 * * * *",      runTPOptimizer);
  console.log("[PRONTO-AI] Cron jobs active");
}

// Start background init (non-blocking)
initBackground().catch(e => console.error("[FATAL] initBackground:", e.message));
