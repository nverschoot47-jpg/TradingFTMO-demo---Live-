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
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO-AI v14.4 — Live Dashboard</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#080c12;--bg2:#0d1117;--bg3:#161b22;--bg4:#1c2128;--bdr:#21262d;--bdr2:#30363d;--ink:#e6edf3;--ink2:#c9d1d9;--ink3:#8b949e;--b:#58a6ff;--g:#3fb950;--r:#f85149;--y:#d29922;--p:#bc8cff;--c:#39d0d8;--o:#f0883e;--b2:rgba(88,166,255,.12);--g2:rgba(63,185,80,.12);--r2:rgba(248,81,73,.12);--y2:rgba(210,153,34,.12);--p2:rgba(188,140,255,.12)}
html,body{min-height:100%;background:var(--bg);color:var(--ink2);font:11px/1.5 'SF Mono',Consolas,monospace}
header{background:var(--bg2);border-bottom:1px solid var(--bdr2);padding:0 10px;display:flex;align-items:center;height:40px;position:sticky;top:0;z-index:100}
.brand{font-size:13px;font-weight:700;color:var(--b);margin-right:10px}
.kpis{display:flex;align-items:stretch;flex:1;overflow:hidden;height:100%}
.kpi{display:flex;flex-direction:column;justify-content:center;padding:0 8px;border-right:1px solid var(--bdr);flex-shrink:0}
.kl{font-size:6.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--ink3);margin-bottom:1px}
.kv{font-size:11px;font-weight:700}
.hr{display:flex;align-items:center;gap:5px;margin-left:auto;padding-left:8px}
.ldot{width:6px;height:6px;border-radius:50%;background:var(--g);box-shadow:0 0 5px var(--g);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.sbdg{padding:2px 6px;border-radius:3px;font-size:8px;font-weight:700;background:var(--b2);color:var(--b)}
nav{display:flex;border-bottom:1px solid var(--bdr2);background:var(--bg2);overflow-x:auto;position:sticky;top:40px;z-index:99}
.ntab{padding:7px 12px;cursor:pointer;color:var(--ink3);white-space:nowrap;border-bottom:2px solid transparent;font-size:10px;user-select:none}
.ntab:hover{color:var(--ink)}.ntab.on{color:var(--b);border-bottom-color:var(--b)}
.nbdg{display:inline-flex;align-items:center;justify-content:center;min-width:14px;height:12px;border-radius:6px;font-size:7px;font-weight:700;padding:0 3px;margin-left:2px;background:var(--r2);color:var(--r)}
.page{display:none}.page.on{display:block}
.pg{padding:8px;display:flex;flex-direction:column;gap:6px}
.card{background:var(--bg2);border:1px solid var(--bdr);border-radius:6px;overflow:hidden}
.chdr{display:flex;align-items:center;justify-content:space-between;padding:6px 11px;border-bottom:1px solid var(--bdr);background:var(--bg3)}
.ctitle{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;display:flex;align-items:center;gap:5px;flex-wrap:wrap;color:var(--ink2)}
.dot{width:5px;height:5px;border-radius:50%;background:var(--g);display:inline-block;flex-shrink:0}
.dot.r{background:var(--r)}.dot.p{background:var(--p)}.dot.y{background:var(--y)}.dot.b{background:var(--b)}
.cm{font-size:7.5px;color:var(--ink3);white-space:nowrap}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse}
th{color:var(--ink3);font-size:6.5px;text-transform:uppercase;letter-spacing:.3px;padding:3px 4px;border-bottom:1px solid var(--bdr);text-align:left;white-space:nowrap;background:var(--bg3)}
td{padding:3px 4px;border-bottom:1px solid var(--bdr);white-space:nowrap;font-size:9px;vertical-align:middle}
tr:last-child td{border-bottom:none}tr:hover td{background:var(--bg4)}
.nd{text-align:center;color:var(--ink3);padding:10px;font-size:9px}
.cb{color:var(--b)}.cg{color:var(--g)}.cr{color:var(--r)}.cy{color:var(--y)}.cp{color:var(--p)}.cc{color:var(--c)}.co{color:var(--o)}.cd{color:var(--ink3)}.fw{font-weight:700}
.bd{display:inline-flex;align-items:center;padding:1px 4px;border-radius:2px;font-size:7.5px;font-weight:700}
.bd-buy{background:var(--g2);color:var(--g)}.bd-sell{background:var(--r2);color:var(--r)}
.bd-ab{background:var(--b2);color:var(--b)}.bd-bw{background:var(--p2);color:var(--p)}
.bd-lon{background:rgba(63,185,80,.08);color:var(--g)}.bd-ny{background:rgba(240,136,62,.08);color:var(--o)}.bd-asia{background:rgba(57,208,216,.08);color:var(--c)}
.bd-fx{background:rgba(88,166,255,.08);color:var(--b)}.bd-ix{background:rgba(57,208,216,.08);color:var(--c)}.bd-cm{background:rgba(210,153,34,.08);color:var(--y)}.bd-sk{background:rgba(188,140,255,.08);color:var(--p)}
.adv-th{background:rgba(248,81,73,.06)!important}.adv-hit{background:rgba(248,81,73,.25)!important;border-left:1px solid rgba(248,81,73,.3)!important}
.fav-th{background:rgba(63,185,80,.06)!important}.fav-hit{background:rgba(63,185,80,.25)!important;border-left:1px solid rgba(63,185,80,.3)!important}
.sl-row{background:rgba(248,81,73,.04)!important}
.sl-badge{font-size:7px;font-weight:700;color:var(--r);margin-left:3px}
.dg-stop{background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.35);padding:1px 5px;border-radius:2px;font-size:7.5px;font-weight:700}
.dg-live{background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.35);padding:1px 5px;border-radius:2px;font-size:7.5px;font-weight:700}
.ov-grid{display:grid;grid-template-columns:repeat(5,1fr);background:var(--bdr);gap:1px}
.ovc{background:var(--bg2);padding:9px 12px}
.ovl{font-size:7px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.ovv{font-size:18px;font-weight:700;line-height:1}.ovs{font-size:7px;color:var(--ink3);margin-top:2px}
.ks4{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}
.ks4c{background:var(--bg2);padding:9px 12px}
.ks4l{font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px}
.ks4v{font-size:20px;font-weight:700}.ks4s{display:flex;gap:7px;margin-top:4px;font-size:8px;flex-wrap:wrap}
.kstrip{display:flex;border-bottom:1px solid var(--bdr);flex-wrap:wrap}
.ks{flex:1;padding:6px 9px;border-right:1px solid var(--bdr);min-width:65px}.ks:last-child{border-right:none}
.ksl{font-size:6.5px;color:var(--ink3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:1px}
.ksv{font-size:12px;font-weight:700}
.fbar{display:flex;align-items:center;gap:3px;padding:3px 9px;border-bottom:1px solid var(--bdr);flex-wrap:wrap}
.fl{font-size:7px;color:var(--ink3);text-transform:uppercase;letter-spacing:.3px}
.fb{padding:2px 6px;border-radius:2px;border:1px solid var(--bdr2);background:transparent;color:var(--ink3);font:8px monospace;cursor:pointer}
.fb.on{background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)}
.sechdr{background:var(--bg3);border-top:2px solid var(--bdr2);border-bottom:1px solid var(--bdr);padding:4px 11px;font-size:7.5px;font-weight:700;color:var(--ink3);text-transform:uppercase;display:flex;align-items:center;gap:5px;margin-top:5px}
.ib{background:rgba(88,166,255,.05);border:1px solid rgba(88,166,255,.15);border-radius:4px;padding:7px 11px;font-size:8px;color:var(--ink3);line-height:1.7}
.ibb{background:rgba(188,140,255,.05);border:1px solid rgba(188,140,255,.15);border-radius:4px;padding:7px 11px;font-size:8px;color:var(--ink3);line-height:1.7}
.key-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:16px;border-radius:3px;font-size:8px;font-weight:700;padding:0 4px}
.key-1{background:rgba(57,208,216,.12);color:var(--c)}.key-2{background:rgba(248,81,73,.15);color:var(--r)}
.bt-ny{background:#e65100;color:#fff;padding:1px 5px;border-radius:2px;font-size:7px;font-weight:700;white-space:nowrap}
.bt-vx{background:#4a148c;color:#fff;padding:1px 5px;border-radius:2px;font-size:7px;font-weight:700;white-space:nowrap}
.bt-dp{background:#f57f17;color:#fff;padding:1px 5px;border-radius:2px;font-size:7px;font-weight:700;white-space:nowrap}
.sig-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(82px,1fr));gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}
.sig-cell{background:var(--bg2);padding:6px 9px}
.sig-lbl{font-size:6.5px;color:var(--ink3);text-transform:uppercase;margin-bottom:2px}
.sig-val{font-size:15px;font-weight:700}
.blk-hdr{border-left:3px solid;padding:3px 11px;font-size:7.5px;font-weight:700;text-transform:uppercase;display:flex;align-items:center;gap:6px}
.compliance-note{font-size:7px;color:var(--ink3);line-height:1.5;margin-top:3px}
.dg-live{background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.35);padding:1px 5px;border-radius:2px;font-size:7.5px;font-weight:700}
.dg-stop{background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.35);padding:1px 5px;border-radius:2px;font-size:7.5px;font-weight:700}
.dg-slgap{background:rgba(248,81,73,.25);color:#ff9090;border:1px solid rgba(248,81,73,.5);padding:1px 5px;border-radius:2px;font-size:7.5px;font-weight:700}
.dg-tp{background:rgba(63,185,80,.25);color:#90ff90;border:1px solid rgba(63,185,80,.5);padding:1px 5px;border-radius:2px;font-size:7.5px;font-weight:700}
.dg-man{background:rgba(139,148,158,.15);color:var(--ink3);border:1px solid rgba(139,148,158,.3);padding:1px 5px;border-radius:2px;font-size:7.5px;font-weight:700}
.sl-row td{background:rgba(248,81,73,.05)!important}
.key-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:16px;border-radius:3px;font-size:8px;font-weight:700;padding:0 4px}
.key-1{background:rgba(57,208,216,.12);color:var(--c)}.key-2{background:rgba(248,81,73,.15);color:var(--r)}.key-3{background:rgba(210,153,34,.15);color:var(--y)}
.sig-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(82px,1fr));gap:1px;background:var(--bdr);border-bottom:1px solid var(--bdr)}
.sig-cell{background:var(--bg2);padding:6px 9px}
.sig-lbl{font-size:6.5px;color:var(--ink3);text-transform:uppercase;margin-bottom:2px}
.sig-val{font-size:15px;font-weight:700}
.bt-ny{background:#e65100;color:#fff;padding:1px 5px;border-radius:2px;font-size:7px;font-weight:700;white-space:nowrap}
.bt-vx{background:#4a148c;color:#fff;padding:1px 5px;border-radius:2px;font-size:7px;font-weight:700;white-space:nowrap}
.bt-dp{background:#f57f17;color:#fff;padding:1px 5px;border-radius:2px;font-size:7px;font-weight:700;white-space:nowrap}
.ovl{font-size:7px;color:var(--ink3);text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px}
.ovv{font-size:18px;font-weight:700}
.ovs{font-size:7px;color:var(--ink3);margin-top:2px}
.sechdr{background:var(--bg3);border-top:2px solid var(--bdr2);border-bottom:1px solid var(--bdr);padding:4px 11px;font-size:7.5px;font-weight:700;color:var(--ink3);text-transform:uppercase;display:flex;align-items:center;gap:5px}
.fbar{display:flex;align-items:center;gap:3px;padding:3px 9px;border-bottom:1px solid var(--bdr);flex-wrap:wrap}
.hbtn{padding:2px 7px;border-radius:3px;border:1px solid var(--bdr2);background:var(--bg3);color:var(--ink3);font:8px monospace;cursor:pointer}
.hbtn:hover{color:var(--ink);border-color:var(--b)}
.waiting{color:var(--y);font-style:italic}
</style>
</head>
<body>

<header>
  <div class="brand">PRONTO·AI <span id="ver" style="font-size:7px;color:var(--ink3);font-weight:400">v14.4</span></div>
  <div class="kpis">
    <div class="kpi"><div class="kl">Balance</div><div class="kv cb" id="h-bal">—</div></div>
    <div class="kpi"><div class="kl">Unrealized P&L</div><div class="kv" id="h-upnl">—</div></div>
    <div class="kpi"><div class="kl">Realized</div><div class="kv" id="h-rpnl">—</div></div>
    <div class="kpi"><div class="kl">Open MT5</div><div class="kv" id="h-open">—</div></div>
    <div class="kpi"><div class="kl">Active Ghost</div><div class="kv cp" id="h-ghost">—</div></div>
    <div class="kpi"><div class="kl">Finalized</div><div class="kv cc" id="h-fin">—</div></div>
    <div class="kpi"><div class="kl">Shadow</div><div class="kv cp" id="h-shadow">—</div></div>
    <div class="kpi"><div class="kl">TP Locked</div><div class="kv cy" id="h-tp">—</div></div>
    <div class="kpi"><div class="kl">Errors/h</div><div class="kv" id="h-err">—</div></div>
    <div class="kpi"><div class="kl">DB</div><div class="kv" id="h-dbstatus" style="font-size:9px">—</div></div>
  </div>
  <div class="hr"><div class="ldot"></div><div class="sbdg" id="sess-b">—</div><div id="clk" style="font-size:9px;color:var(--ink3)">—</div></div>
</header>

<nav>
  <div class="ntab on" onclick="go('ov',this)">Overview</div>
  <div class="ntab" onclick="go('sig',this)">Signals &amp; Blocked<span class="nbdg" id="nb-sig">0</span></div>
  <div class="ntab" onclick="go('gh',this)">Ghost Tracker<span class="nbdg" id="nb-gh" style="background:var(--p2);color:var(--p)">0</span></div>
  <div class="ntab" onclick="go('sh',this)" style="color:var(--p)">Shadow Tracker<span class="nbdg" id="nb-sh" style="background:var(--p2);color:var(--p)">0</span></div>
  <div class="ntab" onclick="go('ev',this)">EV + Optimizer</div>
</nav>

<div class="page on" id="p-ov"><div class="pg">

  <div class="card" style="overflow:hidden">
    <div class="chdr"><div class="ctitle"><div class="dot b"></div>Account Balance</div></div>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--bdr)">
      <div style="background:var(--bg2);padding:9px 12px">
        <div class="ovl">Start Balance</div><div class="ovv cd" id="ov-startbal">—</div>
        <div class="ovs">bij start van trading</div>
      </div>
      <div style="background:var(--bg2);padding:9px 12px">
        <div class="ovl">+ Realized P&L</div><div class="ovv cg" id="ov-realbal">—</div>
        <div class="ovs" id="ov-tradecount">— gesloten trades</div>
      </div>
      <div style="background:var(--bg2);padding:9px 12px">
        <div class="ovl">= Cash Balance</div><div class="ovv cb" id="ov-cashbal">—</div>
        <div class="ovs">start + gesloten · no open</div>
      </div>
      <div style="background:var(--bg2);padding:9px 12px">
        <div class="ovl">+ Unrealized P&L</div><div class="ovv" id="ov-upnl">—</div>
        <div class="ovs" id="ov-opencount">— open posities</div>
      </div>
      <div style="background:var(--bg2);padding:9px 12px;border-left:2px solid var(--b)">
        <div class="ovl" style="color:var(--b)">= Equity (Balance MT5)</div>
        <div class="ovv cb fw" id="ov-equity">—</div>
        <div class="ovs" id="ov-equitycheck" style="color:var(--b)">—</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="chdr">
      <div class="ctitle"><div class="dot y"></div>Open Trades Performance — MT5 Open Posities</div>
      <div class="cm">WR = P&L &gt; 0</div>
    </div>
    <div class="kstrip">
      <div class="ks"><div class="ksl">Open MT5</div><div class="ksv" id="ov-open">—</div></div>
      <div class="ks"><div class="ksl">Wins (P&L&gt;0)</div><div class="ksv cg fw" id="ov-wins">—</div></div>
      <div class="ks"><div class="ksl">Losses</div><div class="ksv cr fw" id="ov-losses">—</div></div>
      <div class="ks"><div class="ksl">Win Rate</div><div class="ksv cy" id="ov-wr">—</div></div>
      <div class="ks"><div class="ksl">Best Peak+RR</div><div class="ksv cg fw" id="ov-bestpeak">—</div></div>
      <div class="ks"><div class="ksl">Worst Peak−RR</div><div class="ksv cr fw" id="ov-worstpeak">—</div></div>
      <div class="ks"><div class="ksl">Max Possible +RR</div><div class="ksv cy" id="ov-maxrr">—</div></div>
      <div class="ks"><div class="ksl">Unrealized P&L</div><div class="ksv" id="ov-upnl2">—</div></div>
      <div class="ks"><div class="ksl">Lots (open+closed)</div><div class="ksv cd" id="ov-lots">—</div></div>
    </div>
  </div>

  <div class="card">
    <div class="chdr">
      <div class="ctitle"><div class="dot b"></div>Open Trades — Daily Log</div>
      <div class="cm">per dag · peak+/− · DD%</div>
    </div>
    <div class="tw"><table>
      <thead><tr>
        <th>Datum</th><th>Open</th><th>Win</th><th>Loss</th><th>WR</th>
        <th style="color:var(--g)">Peak+RR</th><th style="color:var(--g)">Tijd</th>
        <th style="color:var(--r)">Peak−RR</th><th style="color:var(--r)">Tijd</th>
        <th style="color:var(--r)">Max DD%</th><th>Lots</th><th>P&L</th>
      </tr></thead>
      <tbody id="ov-daily"><tr><td colspan="12" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

  <div class="card">
    <div class="chdr">
      <div class="ctitle"><div class="dot r"></div>Gesloten Trades</div>
      <div class="cm" id="ov-trades-cm">—</div>
    </div>
    <div class="tw" style="max-height:300px;overflow-y:auto"><table>
      <thead><tr>
        <th>Close</th><th>Symbol</th><th>Type</th><th>Dir</th><th>VWAP</th><th>Sess</th>
        <th>Entry</th><th>SL</th><th>TP</th><th>Exit</th>
        <th>Realized €</th><th>Lots</th><th>Ghost Stop</th><th>Opened</th><th>Closed</th>
      </tr></thead>
      <tbody id="ov-trades"><tr><td colspan="15" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

</div></div>
<div class="page" id="p-sig"><div class="pg">

  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot r"></div>Signal Intelligence</div><div class="cm" id="sig-period">laatste 7 dagen</div></div>
    <div class="sig-grid">
      <div class="sig-cell"><div class="sig-lbl">Total Signals</div><div class="sig-val cb" id="sg-total">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">→ Placed (Ghost)</div><div class="sig-val cg" id="sg-placed">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">Conv%</div><div class="sig-val cy" id="sg-conv">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">→ Shadow</div><div class="sig-val cp" id="sg-shadow">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">⏰ NY Dead 15:30–18h</div><div class="sig-val co" id="sg-nydead">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">⏰ NY Night 21–02h</div><div class="sig-val co" id="sg-nynight">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">⏰ Asia Morning 0–2h</div><div class="sig-val co" id="sg-asia">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">📊 VWAP Exhaustion</div><div class="sig-val cp" id="sg-vwap">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">📌 Duplicate</div><div class="sig-val cy" id="sg-dup">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">🏖 Weekend</div><div class="sig-val cd" id="sg-wknd">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">📈 Stk OOH</div><div class="sig-val cd" id="sg-ooh">—</div></div>
      <div class="sig-cell"><div class="sig-lbl">❓ Unk Sym</div><div class="sig-val cr" id="sg-unk">—</div></div>
      <div class="sig-cell" style="background:rgba(248,81,73,.06)"><div class="sig-lbl" style="color:var(--r)">⚠ Errors</div><div class="sig-val cr fw" id="sg-err">—</div></div>
    </div>
  </div>

  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot g"></div>Signal Log — Alle Outcomes</div><div class="cm">meest recent eerst</div></div>
    <div class="tw" style="max-height:340px;overflow-y:auto"><table>
      <thead><tr>
        <th>Tijd</th><th>Symbol</th><th>Type</th><th>Dir</th><th>Sess</th><th>VWAP</th>
        <th>Entry</th><th>Band%</th><th>#Key</th><th>Outcome</th><th>Bestemming</th><th>Latency</th>
      </tr></thead>
      <tbody id="sig-log"><tr><td colspan="12" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

  <div style="padding:2px 9px;background:rgba(248,81,73,.06);border:1px solid var(--bdr);border-radius:0;font-size:7px;color:var(--r);font-weight:600">⚠ ERRORS — DID NOT REACH GHOST OR SHADOW</div>
  <div class="card">
    <div class="tw" style="max-height:200px;overflow-y:auto"><table>
      <thead><tr>
        <th>Tijd</th><th>Symbol</th><th>Dir</th><th>Error Type</th><th>Detail</th><th>Retried</th>
      </tr></thead>
      <tbody id="sig-errors"><tr><td colspan="6" class="nd">Geen errors</td></tr></tbody>
    </table></div>
  </div>

</div></div>
<div class="page" id="p-gh"><div class="pg">

  <div class="card">
    <div class="kstrip">
      <div class="ks"><div class="ksl">Active</div><div class="ksv cp" id="gh-active-cnt">—</div></div>
      <div class="ks"><div class="ksl">● SL Today</div><div class="ksv cr fw" id="gh-sl-today">—</div></div>
      <div class="ks"><div class="ksl">Best Peak+</div><div class="ksv cg fw" id="gh-best-peak">—</div></div>
      <div class="ks"><div class="ksl">Avg Peak+</div><div class="ksv cy" id="gh-avg-peak">—</div></div>
      <div class="ks"><div class="ksl">Buy</div><div class="ksv cg" id="gh-buy">—</div></div>
      <div class="ks"><div class="ksl">Sell</div><div class="ksv cr" id="gh-sell">—</div></div>
      <div class="ks"><div class="ksl">TP Geschat</div><div class="ksv cy" id="gh-tp-est">—</div></div>
      <div class="ks"><div class="ksl">Finalized Total</div><div class="ksv cc" id="gh-fin-cnt">—</div></div>
    </div>
  </div>

  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot p"></div>Active Ghost Tracker — Live Milestones</div><div class="cm">scroll →</div></div>
    <div class="tw"><table>
      <thead><tr>
        <th>Status</th><th>Symbol</th><th>Type</th><th>Dir</th><th>VWAP</th><th>Sess</th><th>#Key</th>
        <th style="color:var(--b)">RR Now</th><th style="color:var(--g)">Peak+RR</th><th style="color:var(--r)">Peak−%</th>
        <th>→TP</th><th>Band%</th>
        <th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-1.0</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.9</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.8</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.7</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.6</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.5</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.4</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.3</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.2</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.5</th>
        <th>Entry</th><th>SL</th><th>TP</th><th>P&amp;L €</th><th>Lots</th><th>Opened</th>
      </tr></thead>
      <tbody id="gh-active-body"><tr><td colspan="90" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

  <div class="sechdr"><div class="dot r"></div>Ghost Finalized — Stop Reasons: phantom_sl · gap_stop · tp_hit · manual</div>
  <div class="card">
    <div class="tw" style="max-height:340px;overflow-y:auto"><table>
      <thead><tr>
        <th>#</th><th>Symbol</th><th>Type</th><th>Sess</th><th>Dir</th><th>VWAP</th>
        <th style="color:var(--r)">Stop Reason</th><th>TP used</th>
        <th style="color:var(--g)">Peak+</th><th style="color:var(--r)">Peak−%</th>
        <th>Band%</th><th>#Key</th><th>P&amp;L €</th><th>Lots</th><th>Opened</th><th>Elapsed</th>
        <th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-1.0</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.9</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.8</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.7</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.6</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.5</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.4</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.3</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.2</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.5</th>
      </tr></thead>
      <tbody id="gh-fin-body"><tr><td colspan="90" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

</div></div>
<div class="page" id="p-sh"><div class="pg">

  <div class="sechdr" style="margin-top:0"><div class="dot o"></div>⏰ Timezone Blocks — NY Dead · NY Night · Asia Morning</div>
  <div class="card">
    <div class="tw" style="max-height:280px;overflow-y:auto"><table>
      <thead><tr>
        <th>Block</th><th>Symbol</th><th>Type</th><th>#Key</th><th>Dir</th><th>VWAP</th><th>Sess</th>
        <th style="color:var(--g)">Peak+</th><th style="color:var(--r)">Peak−%</th><th>Band%</th>
        <th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-1.0</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.9</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.8</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.7</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.6</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.5</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.4</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.3</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.2</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.5</th>
        <th>Entry</th><th>Blocked At</th><th>Elapsed</th>
      </tr></thead>
      <tbody id="sh-tz-body"><tr><td colspan="90" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

  <div class="sechdr"><div class="dot p"></div>📊 VWAP Exhaustion Blocks</div>
  <div class="card">
    <div class="tw" style="max-height:220px;overflow-y:auto"><table>
      <thead><tr>
        <th>Block</th><th>Symbol</th><th>Type</th><th>#Key</th><th>Dir</th><th>VWAP</th>
        <th style="color:var(--g)">Peak+</th><th style="color:var(--r)">Peak−%</th><th>Band%</th>
        <th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-1.0</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.9</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.8</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.7</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.6</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.5</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.4</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.3</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.2</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.5</th>
        <th>Entry</th><th>Blocked At</th>
      </tr></thead>
      <tbody id="sh-vwap-body"><tr><td colspan="90" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

  <div class="sechdr"><div class="dot y"></div>📌 Duplicate Position Blocks (#Key ≥ 2)</div>
  <div class="card">
    <div class="tw" style="max-height:220px;overflow-y:auto"><table>
      <thead><tr>
        <th>Block</th><th>Symbol</th><th>Type</th><th>#Key</th><th>Dir</th><th>VWAP</th>
        <th style="color:var(--g)">Peak+</th><th style="color:var(--r)">Peak−%</th><th>Band%</th>
        <th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-1.0</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.9</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.8</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.7</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.6</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.5</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.4</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.3</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.2</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.5</th>
        <th>Entry</th><th>Blocked At</th>
      </tr></thead>
      <tbody id="sh-dup-body"><tr><td colspan="90" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

  <div class="sechdr"><div class="dot r"></div>Shadow Finalized — History</div>
  <div class="card">
    <div class="tw" style="max-height:280px;overflow-y:auto"><table>
      <thead><tr>
        <th>Block</th><th>Symbol</th><th>Type</th><th>#Key</th><th>Dir</th><th>VWAP</th>
        <th style="color:var(--r)">Stop</th>
        <th style="color:var(--g)">Peak+</th><th style="color:var(--r)">Peak−%</th><th>Band%</th>
        <th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-1.0</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.9</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.8</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.7</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.6</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.5</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.4</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.3</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.2</th><th class="adv-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">-0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+0.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+1.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+2.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+3.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+4.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.5</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.6</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.7</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.8</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+5.9</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.0</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.1</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.2</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.3</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.4</th><th class="fav-th" style="min-width:22px;font-size:6.5px;text-align:center;padding:2px">+6.5</th>
        <th>Entry</th><th>Blocked</th><th>Elapsed</th>
      </tr></thead>
      <tbody id="sh-fin-body"><tr><td colspan="90" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

</div></div>
<div class="page" id="p-ev"><div class="pg">

  <div class="card">
    <div class="chdr"><div class="ctitle"><div class="dot b"></div>EV TP Optimizer — per symbol+sess+dir+vwap combo · ≥20 ghosts voor TP lock</div></div>
    <div class="tw" style="max-height:340px;overflow-y:auto"><table>
      <thead><tr>
        <th>Symbol</th><th>Type</th><th>Sess</th><th>Dir</th><th>VWAP</th>
        <th>#Key Max</th><th>#Ghosts</th>
        <th style="color:var(--y)">Win%&gt;1R</th><th style="color:var(--g)">Win%&gt;2R</th>
        <th>EV Score</th><th>Best TP</th><th>TP Status</th><th>TP Lock</th>
        <th>Avg T→SL</th><th>Risk Mult</th><th>P&L €</th>
      </tr></thead>
      <tbody id="ev-body"><tr><td colspan="16" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

  <div class="card" style="margin-top:4px">
    <div class="chdr"><div class="ctitle"><div class="dot r"></div>SL Advisor — Avg T→−1.0R per combo</div></div>
    <div class="tw"><table>
      <thead><tr>
        <th>Symbol</th><th>Type</th><th>Sess</th><th>Dir</th><th>VWAP</th>
        <th>#Ghosts</th>
        <th style="color:var(--r)">Avg T→-1.0R</th>
        <th style="color:var(--r)">Min T→-1.0R</th>
        <th style="color:var(--r)">Max T→-1.0R</th>
        <th>SL Advice</th>
      </tr></thead>
      <tbody id="ev-sl-body"><tr><td colspan="10" class="nd waiting">⏳ Laden…</td></tr></tbody>
    </table></div>
  </div>

</div></div>

<script>

const $ = id => document.getElementById(id);
const fmt  = (v,d=2) => v==null?'—':Number(v).toFixed(d);
const fmtE = v => v==null?'—':(v>=0?'+':'')+'\\u20ac'+Math.abs(Number(v)).toFixed(0);
const fmtR = v => v==null?'—':(v>=0?'+':'')+Number(v).toFixed(2)+'R';
const fmtP = v => v==null?'—':Number(v).toFixed(1)+'%';
const fmtTs = s => !s?'—':new Date(s).toLocaleString('nl-BE',{timeZone:'Europe/Brussels',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const fmtT  = s => !s?'—':new Date(s).toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour12:false});
const fmtEl = (s,e) => {
  if(!s) return '—';
  const ms=(e?new Date(e):new Date())-new Date(s);
  const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000);
  return h>0?h+'h'+m+'m':m+'m';
};
const cRR = v => v==null?'cd':v>0?'cg':v<0?'cr':'cd';
const cE  = v => v==null?'cd':v>0?'cg':v<0?'cr':'cd';
const nd  = (cols,msg='Geen data') => \`<tr><td colspan="\${cols}" class="nd">\${msg}</td></tr>\`;
const nw  = (cols,msg='Geen data') => \`<tr><td colspan="\${cols}" class="nd waiting">⏳ \${msg}</td></tr>\`;

function bdDir(d){return d==='BUY'?'<span class="bd bd-buy">BUY</span>':'<span class="bd bd-sell">SELL</span>';}
function bdVwap(v){return v==='ABOVE'?'<span class="bd bd-ab">ABOVE</span>':'<span class="bd bd-bw">BELOW</span>';}
function bdSess(s){const cls={LON:'bd-lon',LONDON:'bd-lon',NY:'bd-ny','NEW YORK':'bd-ny',ASIA:'bd-asia'}; return \`<span class="bd \${cls[s]||'bd-lon'}">\${s||'—'}</span>\`;}
function bdType(t){const cls={forex:'bd-fx',index:'bd-ix',stock:'bd-sk',commodity:'bd-cm'}; const k=(t||'').toLowerCase(); return \`<span class="bd \${cls[k]||'bd-fx'}">\${(t||'?').slice(0,3).toUpperCase()}</span>\`;}
function keyBdg(k){const n=parseInt(k)||1; return \`<span class="key-badge key-\${Math.min(n,3)}">\${n}</span>\`;}
function stopBdg(r){
  const m={phantom_sl:'dg-stop',sl:'dg-stop',sl_gap:'dg-slgap',gap_stop:'dg-slgap',tp_hit:'dg-tp',tp:'dg-tp',manual:'dg-man'};
  return r?\`<span class="\${m[r]||'dg-man'}">\${r}</span>\`:'—';
}
function blockBdg(bt){
  if(!bt) return '—';
  if(bt.includes('NY_DEAD'))  return '<span class="bt-ny">⏰ NY Dead</span>';
  if(bt.includes('NY_NIGHT')) return '<span class="bt-ny">⏰ NY Night</span>';
  if(bt.includes('ASIA'))     return '<span class="bt-ny">⏰ Asia Morning</span>';
  if(bt.includes('VWAP'))     return '<span class="bt-vx">📊 VWAP</span>';
  if(bt.includes('DUPLIC')||bt.includes('DUP')) return '<span class="bt-dp">📌 Duplicate</span>';
  return \`<span style="font-size:8px;color:var(--ink3)">\${bt}</span>\`;
}
function outcomeBdg(o){
  if(!o) return '—';
  if(o==='PLACED') return '<span style="background:var(--g2);color:var(--g);padding:1px 5px;border-radius:2px;font-size:8px;font-weight:700">PLACED</span>';
  if(o.includes('NY_DEAD'))  return '<span class="bt-ny">⏰ NY Dead</span>';
  if(o.includes('NY_NIGHT')) return '<span class="bt-ny">⏰ NY Night</span>';
  if(o.includes('ASIA'))     return '<span class="bt-ny">⏰ Asia Morning</span>';
  if(o.includes('VWAP'))     return '<span class="bt-vx">📊 VWAP Exh</span>';
  if(o.includes('DUPLIC')||o.includes('DUP')) return '<span class="bt-dp">📌 Duplicate</span>';
  if(o.includes('WEEKEND'))  return '<span style="color:var(--ink3);font-size:8px">🏖 Weekend</span>';
  if(o.includes('STOCK_OUTSIDE')||o.includes('OOH')) return '<span style="color:var(--r);font-size:8px">📈 Stk OOH</span>';
  if(o.includes('UNKNOWN'))  return '<span style="color:var(--r);font-size:8px">❓ Unk Sym</span>';
  if(o.includes('MAX_POS'))  return '<span style="color:var(--r);font-size:8px">🚫 Max Pos</span>';
  if(o.includes('DB_WAIT'))  return '<span style="color:var(--r);font-size:8px">🔴 DB Wait</span>';
  return \`<span style="color:var(--r);font-size:8px">\${o}</span>\`;
}

// Milestone cells — exact match to original table structure
const ADV = ['-1.0','-0.9','-0.8','-0.7','-0.6','-0.5','-0.4','-0.3','-0.2','-0.1'];
const FAV = Array.from({length:65},(_,i)=>'+'+(((i+1)/10).toFixed(1)));
function msCells(ms){
  ms = ms||{};
  let h='';
  for(const k of ADV){
    const v=ms[k];
    h += v!=null
      ? \`<td class="adv-hit" style="min-width:22px;text-align:center;padding:2px 3px"><b style="color:#f85149;font-size:8px">\${typeof v==='number'?Math.round(v)+'m':v}</b></td>\`
      : \`<td class="adv-th" style="min-width:22px;text-align:center;padding:2px 3px;opacity:.3;font-size:9px">·</td>\`;
  }
  for(const k of FAV){
    const v=ms[k];
    h += v!=null
      ? \`<td class="fav-hit" style="min-width:22px;text-align:center;padding:2px 3px"><b style="color:#3fb950;font-size:8px">\${typeof v==='number'?Math.round(v)+'m':v}</b></td>\`
      : \`<td class="fav-th" style="min-width:22px;text-align:center;padding:2px 3px;opacity:.3;font-size:9px">·</td>\`;
  }
  return h;
}

// NAV
function go(n,el){
  ['ov','sig','gh','sh','ev'].forEach(p=>{const d=$('p-'+p);if(d)d.classList.remove('on');});
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('on'));
  const pg=$('p-'+n);if(pg)pg.classList.add('on');el.classList.add('on');
  if(n==='sig')loadSignals();
  if(n==='gh') loadGhost();
  if(n==='sh') loadShadow();
  if(n==='ev') loadEV();
}
function ex(id,tr){const s=$('sub-'+id);if(!s)return;const o=s.style.display!=='none';s.style.display=o?'none':'table-row';tr.cells[0].textContent=o?'▶':'▼';}

// Clock + Session badge
setInterval(()=>{
  const el=$('clk');if(el)el.textContent=new Date().toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour12:false});
  const b=$('sess-b');if(!b)return;
  const t=new Date().toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour12:false});
  const h=parseInt(t),m=parseInt(t.split(':')[1]),v=h*100+m;
  if(v>=200&&v<800)      {b.textContent='ASIA';     b.style.color='var(--c)';b.style.background='rgba(57,208,216,.12)';}
  else if(v>=800&&v<1530){b.textContent='LONDON';   b.style.color='var(--g)';b.style.background='rgba(63,185,80,.12)';}
  else if(v>=1530&&v<1800){b.textContent='NY DEAD'; b.style.color='var(--o)';b.style.background='rgba(240,136,62,.12)';}
  else if(v>=1800&&v<2100){b.textContent='NEW YORK';b.style.color='var(--o)';b.style.background='rgba(240,136,62,.12)';}
  else                   {b.textContent='NY NIGHT'; b.style.color='var(--ink3)';b.style.background='rgba(139,148,158,.12)';}
},1000);

// API helper
async function api(url){try{const r=await fetch(url);if(!r.ok)return null;return await r.json();}catch{return null;}}

// ── HEADER + STATUS ──
async function loadHeader(){
  const [status,openPos,perf] = await Promise.all([
    api('/status'),
    api('/api/open-positions'),
    api('/api/performance'),
  ]);

  if(status){
    const v=$('ver');if(v)v.textContent='v'+(status.version||'14.4');
    const ec=$('h-err');if(ec){ec.textContent=status.errorCount||0;ec.className='kv '+((status.errorCount||0)>0?'cr fw':'cg');}
    const s=$('h-dbstatus');if(s){s.textContent=status.dbReady?'DB ready':'DB init…';s.style.color=status.dbReady?'var(--g)':'var(--y)';}
  }

  const positions=openPos||[];
  const upnl=positions.reduce((a,p)=>a+(p.unrealizedPnl||0),0);
  const el=e=>$(e);
  if(el('h-open')){el('h-open').textContent=positions.length;el('h-open').className='kv '+(positions.length>0?'cg':'cd');}
  if(el('h-upnl')){el('h-upnl').textContent=fmtE(upnl);el('h-upnl').className='kv '+(upnl>0?'cg':upnl<0?'cr':'cd');}

  if(perf){
    if(el('h-bal')){el('h-bal').textContent=perf.balance?'\\u20ac'+Math.round(perf.balance):'—';}
    if(el('h-eq')){el('h-eq').textContent=perf.equity?'\\u20ac'+Math.round(perf.equity):'—';}
    if(el('h-rpnl')){
      const rp=perf.totalPnl||perf.realizedPnl||0;
      el('h-rpnl').textContent=fmtE(rp);el('h-rpnl').className='kv '+(rp>=0?'cg':'cr');
    }
  }

  // Ghost/Shadow counts from API
  const [ghostG,blockedA] = await Promise.all([
    api('/api/ghost-grouped'),
    api('/api/blocked-ghosts/active'),
  ]);
  const ghosts=ghostG||[];
  const active=ghosts.filter(g=>!g.stopReason&&!g.stop_reason);
  const fin=ghosts.filter(g=>g.stopReason||g.stop_reason);
  if(el('h-ghost')){el('h-ghost').textContent=active.length;}
  if(el('h-fin')){el('h-fin').textContent=fin.length;}
  if(el('nb-gh')) el('nb-gh').textContent=active.length;
  if(el('nb-sh')) el('nb-sh').textContent=(blockedA||[]).length;
  if(el('h-shadow')) el('h-shadow').textContent=(blockedA||[]).length;

  const tpCfg=await api('/api/tp-config');
  if(el('h-tp')&&tpCfg) el('h-tp').textContent=Object.keys(tpCfg).length;
}

// ── OVERVIEW ──
async function loadOverview(){
  const [openPos,daily,trades,perf] = await Promise.all([
    api('/api/open-positions'),
    api('/api/daily-breakdown'),
    api('/api/trades'),
    api('/api/performance'),
  ]);

  const pos=openPos||[];
  const upnl=pos.reduce((a,p)=>a+(p.unrealizedPnl||0),0);
  const wins=pos.filter(p=>(p.unrealizedPnl||0)>0).length;
  const losses=pos.filter(p=>(p.unrealizedPnl||0)<0).length;
  const wr=pos.length?((wins/pos.length)*100).toFixed(1)+'%':'—';

  // KPI strip
  const s=e=>$(e);
  if(s('ov-open')){s('ov-open').textContent=pos.length;s('ov-open').className='ksv '+(pos.length>0?'cg':'cd');}
  if(s('ov-wins'))s('ov-wins').textContent=wins;
  if(s('ov-losses'))s('ov-losses').textContent=losses;
  if(s('ov-wr')){s('ov-wr').textContent=wr;s('ov-wr').className='ksv '+((wins/Math.max(pos.length,1))>=0.6?'cg fw':'cy');}
  if(s('ov-upnl')){s('ov-upnl').textContent=fmtE(upnl);s('ov-upnl').className='ovv '+(upnl>0?'cg':upnl<0?'cr':'cd');}
  if(s('ov-upnl2')){s('ov-upnl2').textContent=fmtE(upnl);s('ov-upnl2').className='ksv '+(upnl>0?'cg':upnl<0?'cr':'cd');}
  if(s('ov-opencount'))s('ov-opencount').textContent=pos.length+' open posities';

  // Peak stats from ghosts
  let bestP=null,worstP=null,maxRR=null,totLots=0;
  for(const p of pos){
    const g=p.ghost||{};
    if(g.peakRRPos!=null&&(bestP===null||g.peakRRPos>bestP))bestP=g.peakRRPos;
    if(g.peakRRNeg!=null&&(worstP===null||g.peakRRNeg<worstP))worstP=g.peakRRNeg;
    if(g.tpRRUsed!=null&&(maxRR===null||g.tpRRUsed>maxRR))maxRR=g.tpRRUsed;
    totLots+=parseFloat(p.lots||g.lots||0);
  }
  if(s('ov-bestpeak')){s('ov-bestpeak').textContent=bestP!=null?fmtR(bestP):'—';if(bestP!=null)s('ov-bestpeak').className='ksv cg fw';}
  if(s('ov-worstpeak')){s('ov-worstpeak').textContent=worstP!=null?fmtR(worstP):'—';if(worstP!=null)s('ov-worstpeak').className='ksv cr fw';}
  if(s('ov-maxrr')){s('ov-maxrr').textContent=maxRR!=null?fmtR(maxRR):'—';}
  if(s('ov-lots'))s('ov-lots').textContent=fmt(totLots,2);

  // Balance card
  if(perf){
    const bal=perf.balance||0,eq=perf.equity||0,rp=perf.totalPnl||perf.realizedPnl||0;
    const startBal=bal-rp;
    const cashBal=startBal+rp;
    if(s('ov-startbal'))s('ov-startbal').textContent='\\u20ac'+Math.round(startBal);
    if(s('ov-realbal')){s('ov-realbal').textContent=fmtE(rp);s('ov-realbal').className='ovv '+(rp>=0?'cg':'cr');}
    if(s('ov-tradecount'))s('ov-tradecount').textContent=(trades||[]).length+' gesloten trades';
    if(s('ov-cashbal'))s('ov-cashbal').textContent='\\u20ac'+Math.round(cashBal);
    if(s('ov-equity'))s('ov-equity').textContent='\\u20ac'+Math.round(eq);
    if(s('ov-equitycheck'))s('ov-equitycheck').textContent='\\u20ac'+Math.round(startBal)+' + \\u20ac'+Math.round(rp)+' + \\u20ac'+Math.round(upnl)+' = \\u20ac'+Math.round(eq)+' \\u2713';
  }

  // Daily log
  const dEl=$('ov-daily');
  const days=(daily&&daily.days)||[];
  if(!days.length){dEl.innerHTML=nd(12,'Geen data — wacht op eerste trades');}
  else {
    dEl.innerHTML=days.slice(0,14).map(d=>{
      const total=d.total||0,wins2=d.wins||0,loss2=d.losses||0;
      const wr2=total?((wins2/total)*100).toFixed(0)+'%':'—';
      const wrC=total&&wins2/total>=0.6?'cg fw':'cy';
      const bpC=d.peakRRPos>1?'cg fw':d.peakRRPos>0?'cg':'cd';
      const wpC=d.peakRRNeg<-0.5?'cr fw':'cr';
      const pnl=d.pnl||d.totalPnl||0;
      return \`<tr>
        <td class="cd fw">\${d.date||'—'}</td>
        <td class="cb">\${total}</td><td class="cg">\${wins2}</td><td class="cr">\${loss2}</td>
        <td class="\${wrC}">\${wr2}</td>
        <td class="\${bpC}">\${d.peakRRPos!=null?fmtR(d.peakRRPos):'—'}</td>
        <td class="cd" style="font-size:8px">\${d.peakPosTime||'—'}</td>
        <td class="\${wpC}">\${d.peakRRNeg!=null?fmtR(d.peakRRNeg):'—'}</td>
        <td class="cd" style="font-size:8px">\${d.peakNegTime||'—'}</td>
        <td class="\${(d.maxDD||0)>0.4?'cr fw':'cr'}">\${d.maxDD!=null?'-'+fmtP(d.maxDD):'—'}</td>
        <td class="cd">\${fmt(d.lots||0,2)}</td>
        <td class="\${cE(pnl)} fw">\${fmtE(pnl)}</td>
      </tr>\`;
    }).join('');
  }

  // Closed trades table
  const tEl=$('ov-trades');
  const trList=trades||[];
  if(s('ov-trades-cm'))s('ov-trades-cm').textContent=trList.length+' trades';
  if(!trList.length){tEl.innerHTML=nd(15,'Geen gesloten trades');}
  else {
    tEl.innerHTML=trList.slice(0,100).map(t=>{
      const cr=t.closeReason||t.close_reason;
      const gr=t.ghostStopReason||t.ghost_stop_reason;
      const pnl=t.realizedPnl||t.realized_pnl;
      return \`<tr>
        <td>\${stopBdg(cr)}</td>
        <td class="cb fw">\${t.symbol||'—'}</td>
        <td>\${bdType(t.assetType||t.asset_type)}</td>
        <td>\${bdDir(t.direction)}</td>
        <td>\${bdVwap(t.vwapPosition||t.vwap_position)}</td>
        <td>\${bdSess(t.session)}</td>
        <td class="cd" style="font-size:8.5px">\${fmt(t.entry,5)}</td>
        <td class="cr" style="font-size:8.5px">\${fmt(t.sl,5)}</td>
        <td class="cg" style="font-size:8.5px">\${t.tp?fmt(t.tp,5):'—'}</td>
        <td class="cy" style="font-size:8.5px">\${fmt(t.exitPrice||t.exit_price,5)}</td>
        <td class="\${cE(pnl)} fw">\${fmtE(pnl)}</td>
        <td class="cd">\${fmt(t.lots,2)}</td>
        <td style="font-size:8px">\${stopBdg(gr)}</td>
        <td class="cd" style="font-size:8px">\${fmtTs(t.openedAt||t.opened_at)}</td>
        <td class="cd" style="font-size:8px">\${fmtTs(t.closedAt||t.closed_at)}</td>
      </tr>\`;
    }).join('');
  }
}

// ── SIGNALS ──
async function loadSignals(){
  const [stats,log,rejects] = await Promise.all([
    api('/api/signal-stats'),
    api('/api/signal-log'),
    api('/api/signal-rejects'),
  ]);

  if(stats){
    const f=(id,val)=>{const e=$(id);if(e)e.textContent=val!=null?val:'—';};
    f('sg-total',   stats.total||0);
    f('sg-placed',  stats.placed||0);
    f('sg-conv',    stats.conversionPct!=null?fmtP(stats.conversionPct):'—');
    f('sg-shadow',  stats.shadow||stats.blocked||0);
    f('sg-nydead',  stats.nyDead||stats.ny_dead||0);
    f('sg-nynight', stats.nyNight||stats.ny_night||0);
    f('sg-asia',    stats.asiaMorning||stats.asia_morning||0);
    f('sg-vwap',    stats.vwapExhaustion||stats.vwap_exhaustion||0);
    f('sg-dup',     stats.duplicate||0);
    f('sg-wknd',    stats.weekend||0);
    f('sg-ooh',     stats.stockOOH||stats.stock_ooh||0);
    f('sg-unk',     stats.unknownSymbol||stats.unknown_symbol||0);
    f('sg-err',     stats.errors||0);
    if($('nb-sig'))$('nb-sig').textContent=stats.total||0;
  }

  const lb=$('sig-log');
  const logs=log||[];
  if(!logs.length){lb.innerHTML=nd(12,'Geen signalen gelogd');}
  else {
    lb.innerHTML=logs.slice(0,100).map(s=>{
      const outcome=s.outcome||s.blockReason||s.block_reason||'PLACED';
      const dest=s.ghostId||s.ghost_id
        ?\`<span style="background:var(--g2);color:var(--g);padding:1px 5px;border-radius:2px;font-size:8px;font-weight:700">→ Ghost #\${s.ghostId||s.ghost_id}</span>\`
        :outcomeBdg(outcome);
      const lat=s.latencyMs||s.latency_ms;
      const band=s.vwapBandPct||s.vwap_band_pct;
      return \`<tr>
        <td class="cd">\${fmtT(s.receivedAt||s.received_at||s.createdAt||s.created_at)}</td>
        <td class="cb fw">\${s.symbol||'—'}</td>
        <td>\${bdType(s.assetType||s.asset_type)}</td>
        <td>\${bdDir(s.direction)}</td>
        <td>\${bdSess(s.session)}</td>
        <td>\${bdVwap(s.vwapPosition||s.vwap_position)}</td>
        <td class="cd">\${fmt(s.entry,5)}</td>
        <td class="\${(band||0)>150?'cr fw':'cd'}">\${band!=null?fmtP(band):'—'}</td>
        <td>\${keyBdg(s.keyCount||s.key_count||1)}</td>
        <td class="\${outcome==='PLACED'?'cg fw':'co fw'}">\${outcomeBdg(outcome)}</td>
        <td>\${dest}</td>
        <td class="\${(lat||0)>1000?'cy':'cg'}">\${lat!=null?lat+'ms':'—'}</td>
      </tr>\`;
    }).join('');
  }

  const eb=$('sig-errors');
  const errs=(rejects||[]).filter(e=>e.outcome&&(e.outcome.includes('ERROR')||e.outcome.includes('FAIL')||e.outcome.includes('NO_POS')||e.outcome.includes('TIMEOUT')||e.outcome.includes('CIRCUIT')||e.outcome.includes('BAD_')));
  if(!errs.length){eb.innerHTML=nd(6,'Geen errors');}
  else {
    eb.innerHTML=errs.slice(0,20).map(e=>\`<tr>
      <td class="cd">\${fmtT(e.receivedAt||e.received_at)}</td>
      <td class="cb fw">\${e.symbol||'—'}</td>
      <td>\${bdDir(e.direction||'BUY')}</td>
      <td class="cr fw">\${e.outcome||'ERROR'}</td>
      <td class="cr" style="font-size:8px">\${e.detail||e.blockReason||e.block_reason||'—'}</td>
      <td class="cd">—</td>
    </tr>\`).join('');
  }
}

// ── GHOST ──
async function loadGhost(){
  const [openPos,ghostG] = await Promise.all([
    api('/api/open-positions'),
    api('/api/ghost-grouped'),
  ]);

  const pos=openPos||[];
  const ghosts=ghostG||[];
  const active=ghosts.filter(g=>!g.stopReason&&!g.stop_reason);
  const fin=ghosts.filter(g=>g.stopReason||g.stop_reason);

  // KPI strip
  const slToday=active.filter(g=>g.phantomSLHit||g.phantom_sl_hit).length;
  let bestP=null,sumP=0,buyCnt=0,sellCnt=0,tpCnt=0;
  for(const g of active){
    if(bestP===null||(g.peakRRPos||0)>bestP)bestP=g.peakRRPos;
    sumP+=g.peakRRPos||0;
    if(g.direction==='BUY')buyCnt++;else sellCnt++;
    if(g.tpRRUsed&&(g.peakRRPos||0)>=g.tpRRUsed)tpCnt++;
  }
  const f=(id,v,cls)=>{const e=$(id);if(!e)return;e.textContent=v;if(cls)e.className=cls;};
  f('gh-active-cnt', active.length, 'ksv cp');
  f('gh-sl-today',   slToday,       'ksv cr fw');
  f('gh-best-peak',  bestP!=null?fmtR(bestP):'—', 'ksv cg fw');
  f('gh-avg-peak',   active.length?fmtR(sumP/active.length):'—', 'ksv cy');
  f('gh-buy',        buyCnt, 'ksv cg');
  f('gh-sell',       sellCnt,'ksv cr');
  f('gh-tp-est',     tpCnt,  'ksv cy');
  f('gh-fin-cnt',    fin.length,'ksv cc');

  // Active ghost table — from open positions (has live milestone data)
  const aBody=$('gh-active-body');
  if(!pos.length){aBody.innerHTML=nd(90,'Geen open posities');}
  else {
    aBody.innerHTML=pos.map(p=>{
      const g=p.ghost||{};
      const slD=Math.abs((p.entry||0)-(p.sl||0));
      const cur=p.currentPrice||p.entry||0;
      const rrNow=slD>0?((p.direction==='BUY'?(cur-p.entry):(p.entry-cur))/slD):null;
      const slHit=g.phantomSLHit||g.phantom_sl_hit;
      const stateBdg=slHit?'<span class="dg-stop">SL HIT</span>':'<span class="dg-live">● LIVE</span>';
      const slMs=g.slMilestones||g.sl_milestones||{};
      const rrMs=g.rrMilestones||g.rr_milestones||{};
      const allMs={...slMs,...rrMs};
      return \`<tr class="\${slHit?'sl-row':''}">
        <td>\${stateBdg}</td>
        <td class="cb fw">\${p.symbol||'—'}</td>
        <td>\${bdType(p.assetType||p.type)}</td>
        <td>\${bdDir(p.direction)}</td>
        <td>\${bdVwap(p.vwapPosition||p.vwap_position)}</td>
        <td>\${bdSess(p.session)}</td>
        <td>\${keyBdg(p.keyCount||g.keyCount||1)}</td>
        <td class="\${cRR(rrNow)}">\${rrNow!=null?fmtR(rrNow):'—'}</td>
        <td class="\${cRR(g.peakRRPos)}">\${fmtR(g.peakRRPos)}</td>
        <td class="\${(g.peakRRNeg||0)<-50?'cr fw':'cr'}">\${g.peakRRNeg!=null?fmtP(g.peakRRNeg):'—'}</td>
        <td class="cy">\${g.tpRRUsed!=null?fmtR(g.tpRRUsed):'—'}</td>
        <td class="\${(p.vwapBandPct||0)>150?'co fw':'cd'}">\${p.vwapBandPct!=null?fmtP(p.vwapBandPct):'—'}</td>
        \${msCells(allMs)}
        <td class="cd" style="font-size:8.5px">\${fmt(p.entry,5)}</td>
        <td class="cr" style="font-size:8.5px">\${fmt(p.sl,5)}</td>
        <td class="cg" style="font-size:8.5px">\${p.tp?fmt(p.tp,5):'—'}</td>
        <td class="\${cE(p.unrealizedPnl)} fw">\${fmtE(p.unrealizedPnl)}</td>
        <td class="cd">\${fmt(p.lots||g.lots,2)}</td>
        <td class="cd" style="font-size:8px">\${fmtTs(p.openedAt||g.openedAt)}</td>
      </tr>\`;
    }).join('');
  }

  // Finalized ghost history
  const fBody=$('gh-fin-body');
  if(!fin.length){fBody.innerHTML=nd(90,'Geen gefinaliseerde ghosts');}
  else {
    fBody.innerHTML=fin.slice(0,300).map((g,i)=>{
      const slMs=g.slMilestones||g.sl_milestones||{};
      const rrMs=g.rrMilestones||g.rr_milestones||{};
      return \`<tr>
        <td class="cd">\${i+1}</td>
        <td class="cb fw">\${g.symbol||'—'}</td>
        <td>\${bdType(g.assetType||g.type)}</td>
        <td>\${bdSess(g.session)}</td>
        <td>\${bdDir(g.direction)}</td>
        <td>\${bdVwap(g.vwapPosition||g.vwap_position)}</td>
        <td>\${stopBdg(g.stopReason||g.stop_reason)}</td>
        <td class="cd">\${g.tpRRUsed!=null?fmtR(g.tpRRUsed):'—'}</td>
        <td class="\${cRR(g.peakRRPos)}">\${fmtR(g.peakRRPos)}</td>
        <td class="\${(g.peakRRNeg||0)<-50?'cr fw':'cr'}">\${g.peakRRNeg!=null?fmtP(g.peakRRNeg):'—'}</td>
        <td class="\${(g.vwapBandPct||0)>150?'co fw':'cd'}">\${g.vwapBandPct!=null?fmtP(g.vwapBandPct):'—'}</td>
        <td>\${keyBdg(g.keyCount||1)}</td>
        <td class="\${cE(g.realizedPnl||g.realized_pnl)} fw">\${fmtE(g.realizedPnl||g.realized_pnl)}</td>
        <td class="cd">\${fmt(g.lots,2)}</td>
        <td class="cd" style="font-size:8px">\${fmtTs(g.openedAt||g.opened_at)}</td>
        <td class="cd">\${fmtEl(g.openedAt||g.opened_at,g.finalizedAt||g.finalized_at)}</td>
        \${msCells({...slMs,...rrMs})}
      </tr>\`;
    }).join('');
  }
}

// ── SHADOW ──
async function loadShadow(){
  const [active,history] = await Promise.all([
    api('/api/blocked-ghosts/active'),
    api('/api/blocked-ghosts/history'),
  ]);

  function shadowRow(b, showStop=false){
    const bt=b.blockType||b.block_type||'';
    const slMs=b.slMilestones||b.sl_milestones||{};
    const rrMs=b.rrMilestones||b.rr_milestones||{};
    const base = \`
      <td>\${blockBdg(bt)}</td>
      <td class="cb fw">\${b.symbol||'—'}</td>
      <td>\${bdType(b.assetType||b.type)}</td>
      <td>\${keyBdg(b.keyCount||b.key_count||1)}</td>
      <td>\${bdDir(b.direction)}</td>
      <td>\${bdVwap(b.vwapPosition||b.vwap_position)}</td>
      \${showStop?\`<td>\${stopBdg(b.stopReason||b.stop_reason)}</td>\`:'<td>\${bdSess(b.session)}</td>'}
      <td class="\${cRR(b.peakRRPos)}">\${fmtR(b.peakRRPos)}</td>
      <td class="\${(b.peakRRNeg||0)<-50?'cr fw':'cr'}">\${b.peakRRNeg!=null?fmtP(b.peakRRNeg):'—'}</td>
      <td class="\${(b.vwapBandPct||0)>150?'co fw':'cd'}">\${b.vwapBandPct!=null?fmtP(b.vwapBandPct):'—'}</td>
      \${msCells({...slMs,...rrMs})}
      <td class="cd" style="font-size:8.5px">\${fmt(b.entry,5)}</td>
      <td class="cd" style="font-size:8px">\${fmtTs(b.openedAt||b.opened_at)}</td>
      <td class="cd">\${fmtEl(b.openedAt||b.opened_at,b.finalizedAt||b.finalized_at||null)}</td>\`;
    return base;
  }

  const actList=active||[];
  const tz=actList.filter(b=>{const bt=(b.blockType||b.block_type||'');return bt.includes('NY')||bt.includes('ASIA');});
  const vw=actList.filter(b=>(b.blockType||b.block_type||'').includes('VWAP'));
  const dp=actList.filter(b=>{const bt=(b.blockType||b.block_type||'');return bt.includes('DUPLIC')||bt.includes('DUP');});

  const render=(id,list,cols,emptyMsg,showStop=false)=>{
    const el=$(id); if(!el) return;
    if(!list.length){el.innerHTML=nd(cols,emptyMsg);}
    else el.innerHTML=list.map(b=>\`<tr>\${shadowRow(b,showStop)}</tr>\`).join('');
  };
  render('sh-tz-body',  tz, 90, 'Geen timezone blocks actief');
  render('sh-vwap-body',vw, 90, 'Geen VWAP blocks actief');
  render('sh-dup-body', dp, 90, 'Geen duplicate blocks actief');
  render('sh-fin-body', history||[], 90, 'Geen shadow history', true);
}

// ── EV OPTIMIZER ──
async function loadEV(){
  const [combo,tpCfg,shadowAn] = await Promise.all([
    api('/api/ghost-combo-analysis'),
    api('/api/tp-config'),
    api('/api/shadow-analysis'),
  ]);

  const evEl=$('ev-body');
  const combos=combo||[];
  if(!combos.length){evEl.innerHTML=nd(16,'Geen data — wacht op ≥5 gefinaliseerde ghosts');}
  else {
    evEl.innerHTML=combos.map(c=>{
      const cnt=c.count||c.total||0;
      const locked=tpCfg&&tpCfg[c.optimizerKey]!=null;
      const tp=tpCfg&&tpCfg[c.optimizerKey];
      const bestTP=c.bestTP||c.best_tp;
      const ev=c.evScore||c.ev_score;
      const win1=c.winPct1R||c.win_pct_1r;
      const win2=c.winPct2R||c.win_pct_2r;
      let statusHtml,lockHtml;
      if(cnt>=20&&locked){
        statusHtml='<span style="background:var(--g2);color:var(--g);border:1px solid rgba(63,185,80,.3);padding:1px 5px;border-radius:2px;font-size:8px;font-weight:700">\\u2713 LOCKED</span>';
        lockHtml=\`<span class="cg fw">\${bestTP!=null?fmtR(bestTP):'—'}</span>\`;
      }else if(cnt>=5){
        statusHtml=\`<span style="background:var(--y2);color:var(--y);border:1px solid rgba(210,153,34,.3);padding:1px 5px;border-radius:2px;font-size:8px;font-weight:700">PENDING \${cnt}/20</span>\`;
        lockHtml='<span class="cd">—</span>';
      }else{
        statusHtml=\`<span style="background:rgba(139,148,158,.1);color:var(--ink3);border:1px solid var(--bdr2);padding:1px 5px;border-radius:2px;font-size:8px;font-weight:700">NEED DATA \${cnt}/5</span>\`;
        lockHtml='<span class="cd">—</span>';
      }
      const evC=ev>0?'cg fw':ev<0?'cr fw':'cd';
      return \`<tr>
        <td class="cb fw">\${c.symbol||'—'}</td>
        <td>\${bdType(c.assetType||c.type)}</td>
        <td>\${bdSess(c.session)}</td>
        <td>\${bdDir(c.direction)}</td>
        <td>\${bdVwap(c.vwapPosition||c.vwap_position)}</td>
        <td class="cb">\${c.maxKeyCount||c.max_key_count||1}</td>
        <td class="\${cnt>=20?'cg fw':cnt>=5?'cy fw':'cr fw'}">\${cnt}</td>
        <td class="\${(win1||0)>50?'cg':(win1||0)>35?'cy':'cr'}">\${win1!=null?fmtP(win1):'—'}</td>
        <td class="\${(win2||0)>50?'cg':(win2||0)>35?'cy':'cr'}">\${win2!=null?fmtP(win2):'—'}</td>
        <td class="\${evC}">\${ev!=null?fmt(ev,2):'—'}</td>
        <td class="cc fw">\${bestTP!=null?fmtR(bestTP):'—'}</td>
        <td>\${statusHtml}</td>
        <td>\${lockHtml}</td>
        <td class="cd">\${c.avgTimeToSL||c.avg_time_to_sl||'—'}</td>
        <td class="\${(c.riskMult||1)>1?'cg':(c.riskMult||1)<1?'cr':'cd'}">x\${fmt(c.riskMult||c.risk_mult||1,2)}</td>
        <td class="\${cE(c.totalPnl||c.total_pnl)}">\${fmtE(c.totalPnl||c.total_pnl)}</td>
      </tr>\`;
    }).join('');
  }

  const slEl=$('ev-sl-body');
  const san=shadowAn||[];
  if(!san.length){slEl.innerHTML=nd(10,'Geen shadow data');}
  else {
    slEl.innerHTML=san.slice(0,20).map(s=>{
      const cnt=s.count||s.total||0;
      const avg=s.avgTimeToSL||s.avg_time_to_sl_min;
      const mn=s.minTimeToSL||s.min_time_to_sl_min;
      const mx=s.maxTimeToSL||s.max_time_to_sl_min;
      let advice,aC;
      if(cnt<5){advice='Need \\u22655 data';aC='cd';}
      else if(avg>360){advice='TIGHTEN \\u2014 lang T\\u2192SL';aC='cg fw';}
      else if(avg>120){advice='MONITOR';aC='cy fw';}
      else{advice='KEEP SL \\u2014 snel adverse';aC='cr fw';}
      return \`<tr>
        <td class="cb fw">\${s.symbol||'—'}</td>
        <td>\${bdType(s.assetType||s.type)}</td>
        <td>\${bdSess(s.session)}</td>
        <td>\${bdDir(s.direction)}</td>
        <td>\${bdVwap(s.vwapPosition||s.vwap_position)}</td>
        <td class="\${cnt>=20?'cg fw':cnt>=5?'cy fw':'cr fw'}">\${cnt}</td>
        <td class="\${avg>360?'cg':avg>120?'cy':'cr'} fw">\${avg!=null?Math.round(avg)+'min':'—'}</td>
        <td class="cr">\${mn!=null?Math.round(mn)+'min':'—'}</td>
        <td class="cd">\${mx!=null?Math.round(mx)+'min':'—'}</td>
        <td class="\${aC}">\${advice}</td>
      </tr>\`;
    }).join('');
  }
}

// ── BOOT ──
async function loadAll(){
  await Promise.all([loadHeader(), loadOverview()]);
}

async function waitForDBAndLoad(){
  const s=await api('/status');
  if(s&&s.dbReady){
    await loadAll();
  }else{
    ['ov-daily','ov-trades','gh-active-body','gh-fin-body','sh-tz-body','sh-vwap-body','sh-dup-body','sh-fin-body','ev-body','sig-log'].forEach(id=>{
      const el=$(id);if(el)el.innerHTML=nw(90,'Wacht op database…');
    });
    setTimeout(waitForDBAndLoad,3000);
  }
}

waitForDBAndLoad();
setInterval(loadHeader,   10000);  // header every 10s
setInterval(loadOverview, 30000);  // overview every 30s

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
