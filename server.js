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
  getSession, isMarketOpen, canOpenNewTrade,
  isMonitoringActive, isGhostActive, isShadowActive,
  normalizeSymbol, getSymbolInfo, getVwapPosition, buildOptimizerKey,
} = require("./session");

// ── Version ──────────────────────────────────────────────────────
const VERSION = "14.1.0"; // weekend sync + ghost history combined + stock fix

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
  // Don't update after ghost is finalized (phantom SL hit or TP reached)
  if (ghost.phantomSLHit || ghost.stopReason === 'max_rr_15') return;
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
    ghost.timeToSLMin  = Math.round((Date.now() - new Date(ghost.openedAt).getTime()) / 60000);
  }
  if (rr >= 15 && !ghost.stopReason) ghost.stopReason = "max_rr_15";
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
  // Store for gap detection reuse (avoids second fetchHistoryDeals call)
  const dealsForGap = reason === 'sl' && dbReady
    ? await fetchHistoryDeals(positionId).catch(() => [])
    : [];

  // v14.2: Gap detection — reuses dealsForGap (fetched once above, no duplicate call)
  let gapStop = false;
  if (reason === 'sl' && pos) {
    try {
      const slDist = Math.abs(pos.entry - pos.sl);
      // dealsForGap passed from the deals already fetched in closePosition above
      const deals = dealsForGap || [];
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
function initBlockedGhost({ blockType, symbol, mt5Symbol, session, direction,
    vwapPosition, entry, sl, slPct, tpRRUsed, optimizerKey, vwapBandPct, blockReason }) {
  const id = `BGT_${Date.now()}_${optimizerKey}`.replace(/[^a-z0-9_]/gi, '_');
  return {
    id, blockType, optimizerKey, symbol, mt5Symbol: mt5Symbol ?? symbol,
    session, direction, vwapPosition: vwapPosition ?? 'unknown',
    entry: parseFloat(entry), sl: parseFloat(sl),
    slPct: slPct ?? null, tpRRUsed: tpRRUsed ?? null,
    maxPrice: parseFloat(entry), maxRR: 0, maxSlPctUsed: 0,
    peakRRPos: 0, peakRRNeg: 0,
    slMilestones: {}, rrMilestones: {},
    phantomSLHit: false, stopReason: null, timeToSLMin: null,
    vwapBandPct: vwapBandPct ?? null, blockReason: blockReason ?? null,
    duplicateCount: null,
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
  // Comment format: "B-LD-ABV #42"  →  dir=buy, sess=london, vwap=above, trade#=42
  // Parts: [dir]-[sess]-[vwap] #[n]
  const dirMap  = { B: 'buy',  S: 'sell' };
  const sessMap = { NY: 'ny',  LD: 'london', AS: 'asia', LOND: 'london' };
  const vwapMap = { ABV: 'above', BLW: 'below', UNK: 'unknown' };
  const parts   = comment.trim().toUpperCase().split(/[\s#]+/);
  const core    = parts[0] || '';
  const segs    = core.split('-');
  return {
    direction:    dirMap[segs[0]]  ?? null,
    session:      sessMap[segs[1]] ?? null,
    vwapPosition: vwapMap[segs[2]] ?? 'unknown',
    tradeNumber:  parts[1] ? parseInt(parts[1]) : null,
  };
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
  const entry     = parseFloat(lp.openPrice ?? lp.currentPrice ?? 0);
  const sl        = parseFloat(lp.stopLoss  ?? 0);
  const tp        = parseFloat(lp.takeProfit ?? 0) || null;
  const lots      = parseFloat(lp.volume ?? 0);
  const openedAt  = lp.openTime ? new Date(lp.openTime).toISOString() : new Date().toISOString();
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
    else if (assetTypeA === 'stock')riskEURAdopted = lots * slDistA;
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
        else if (assetTypeSync === 'stock') riskEURSync = pos.lots * slDistSync;
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
          updateGhost(pos.ghost, priceForGhost);
          pos.ghost.lastPriceTs = Date.now();
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
    // Auto-close na: phantom SL geraakt OF 15R bereikt OF 14 dagen oud
    const ageDays = (now - new Date(bg.openedAt).getTime()) / 86_400_000;
    if (bg.phantomSLHit || bg.stopReason === 'max_rr_15' || ageDays > 14) {
      if (!bg.stopReason) bg.stopReason = ageDays > 14 ? 'timeout_14d' : bg.stopReason;
      await closeBlockedGhost(id, bg.stopReason ?? 'auto');
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
// Debug: show raw MetaAPI data for a position
app.get("/api/debug/positions", async (req, res) => {
  try {
    const d = await metaFetch(`/users/current/accounts/${META_ACCOUNT}/positions`);
    res.json({ count: Array.isArray(d) ? d.length : 0, positions: d });
  } catch(e) { res.json({ error: e.message }); }
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
      mktReason.includes('OUTSIDE_WINDOW') ||
      mktReason.includes('STOCK_OUTSIDE_MARKET')
    );

    if (dbReady && isTrackableBlock) {
      const tvEntryB = parseFloat(req.body?.entry ?? req.body?.close ?? 0) || null;
      const slPctB   = parseFloat(req.body?.sl_pct ?? 0.003);
      if (tvEntryB && slPctB && direction) {
        const symInfoB = getSymbolInfo(symbol);
        const mt5B     = symInfoB?.mt5 ?? symbol;
        const sesB     = sesForLog;
        const vwapB    = req.body?.vwap ? parseFloat(req.body.vwap) : null;
        const vwapPosB = getVwapPosition(tvEntryB, vwapB);
        const optKeyB  = buildOptimizerKey(symbol, sesB, direction, vwapPosB);
        const slBuf    = symInfoB?.type === 'stock' ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;
        const slDistB  = slPctB * slBuf * tvEntryB;
        const slPriceB = direction === 'buy' ? tvEntryB - slDistB : tvEntryB + slDistB;

        // Determine block type
        let blockType = 'NY_DEAD_ZONE';
        if (mktReason.includes('OUTSIDE_WINDOW'))      blockType = 'OUTSIDE_WINDOW';
        if (mktReason.includes('STOCK_OUTSIDE_MARKET'))blockType = 'OUTSIDE_WINDOW';

        const bg = initBlockedGhost({
          blockType, symbol, mt5Symbol: mt5B,
          session: sesB, direction, vwapPosition: vwapPosB,
          entry: tvEntryB, sl: slPriceB, slPct: slPctB,
          tpRRUsed: tpConfigs[optKeyB]?.lockedRR ?? 2.0,
          optimizerKey: optKeyB, blockReason: mktReason,
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
  const vwapThreshold = assetType === 'stock' ? 200 : assetType === 'index' ? 130 : 150;
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
        blockType: 'VWAP_EXHAUSTION', symbol, mt5Symbol: mt5Sym,
        session, direction, vwapPosition: vwapPos,
        entry: tvEntry, sl: slPriceVE, slPct,
        tpRRUsed: tpConfigs[optKey]?.lockedRR ?? 2.0,
        optimizerKey: optKey, vwapBandPct, blockReason: rejectReason,
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
        const bg = initBlockedGhost({
          blockType: 'DUPLICATE', symbol, mt5Symbol: mt5Sym,
          session, direction, vwapPosition: vwapPos,
          entry: tvEntry, sl: slPriceD, slPct,
          tpRRUsed: tpConfigs[optKey]?.lockedRR ?? 2.0,
          optimizerKey: optKey, blockReason: rejectReason,
          vwapBandPct,
          duplicateCount: [...blockedPositions.values()].filter(b=>b.optimizerKey===optKey&&b.blockType==='DUPLICATE').length + 1,
        });
        blockedPositions.set(bg.id, bg);
        db.saveBlockedGhostState(bg).catch(() => {});
        console.log(`[BlockedGhost] DUPLICATE tracker created: ${bg.id} ${symbol} ${direction}`);
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
    // Stocks: lot = 1 share (CFD). No decimals — FTMO stock CFDs trade in whole shares.
    // Keep existing formula (lotNom / execPrice) per user preference, but round to integer.
    const rawLots = lotNom / execPrice;
    lots = Math.max(1, Math.round(rawLots));  // min 1 share, no decimals
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
    const sessMap = { ny: 'NY', london: 'LD', asia: 'AS', outside: 'EXT' };
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
            const openMs = lp.openTime ? new Date(lp.openTime).getTime() : 0;
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
        stopReason:   pos.ghost.stopReason   ?? null,
        openedAt:     pos.ghost.openedAt     ?? pos.openedAt,
        entry:        pos.ghost.entry        ?? pos.entry,
        sl:           pos.ghost.sl           ?? pos.sl,
        tpRRUsed:     pos.ghost.tpRRUsed     ?? null,
        lots:         pos.ghost.lots         ?? pos.lots ?? null,
        optimizerKey: pos.ghost.optimizerKey ?? pos.optimizerKey,
        maxPrice:     pos.ghost.maxPrice     ?? pos.entry,
      } : null,
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
  <div class="ntab"     data-page="positions">Open Positions<span class="nbadge" id="nb-pos" style="pointer-events:none">—</span></div>
  <div class="ntab"     data-page="ghosts">Ghost Tracker<span class="nbadge" id="nb-gh" style="pointer-events:none">—</span></div>
  <div class="ntab"     data-page="history">Ghost History</div>
  <div class="ntab"     data-page="ev">EV TP Optimizer</div>
  <div class="ntab"     data-page="evsl">EV SL Optimizer</div>
  <div class="ntab"     data-page="signals">Signals &amp; Blocked<span class="nbadge" id="nb-sig" style="pointer-events:none;display:none"></span></div>
  <div class="ntab"     data-page="shadow-playbook" style="color:var(--p)">🔮 Shadow Playbook<span class="nbadge" id="nb-bgt" style="pointer-events:none;display:none;background:var(--p2);color:var(--p)"></span></div>
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
    <span id="ov-df-active" style="display:none;font-size:9px;color:var(--y);font-weight:700;margin-left:4px">⚠ Gefilterd</span>
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
          <th>Session</th><th>Direction</th><th>VWAP</th><th>Asset Type</th><th>Trades</th>
        </tr></thead><tbody id="wr-body"><tr><td colspan="5" class="nd"><span class="spin">⟳</span></td></tr></tbody></table>
      </div>
    </div>

    <!-- Trade Distribution by asset type -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="dist-dot"></div>Trade Distribution — by Asset Type</div>
        <div class="cmeta" id="dist-meta">loading…</div>
      </div>
      <div class="kstrip">
        <div class="ks"><div class="ksl">Total Closed</div><div class="ksv cb" id="d-tot">—</div></div>
        <div class="ks"><div class="ksl">Forex</div><div class="ksv" style="color:var(--b)" id="d-fx">—</div></div>
        <div class="ks"><div class="ksl">Stock</div><div class="ksv cp" id="d-sk">—</div></div>
        <div class="ks"><div class="ksl">Index</div><div class="ksv cc" id="d-ix">—</div></div>
        <div class="ks"><div class="ksl">Commodity</div><div class="ksv cy" id="d-cm">—</div></div>
        <div class="ks"><div class="ksl">Buy</div><div class="ksv cg" id="d-buy">—</div></div>
        <div class="ks"><div class="ksl">Sell</div><div class="ksv cr" id="d-sell">—</div></div>
      </div>
      <div class="tw">
        <table><thead><tr>
          <th>Asset Type</th><th>Session</th>
          <th class="cg">Buy / Above</th><th class="cg">Buy / Below</th>
          <th class="cr">Sell / Above</th><th class="cr">Sell / Below</th>
          <th>Total</th>
        </tr></thead>
        <tbody id="dist-body"><tr><td colspan="7" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        <tfoot><tr style="background:var(--bg3);font-weight:700">
          <td class="cy" colspan="2">TOTAL</td>
          <td id="ft-ba" class="cg">—</td><td id="ft-bb" class="cg">—</td>
          <td id="ft-sa" class="cr">—</td><td id="ft-sb" class="cr">—</td>
          <td id="ft-t" class="cb">—</td>
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
          <th>Date</th><th># Trades</th><th>Total Lots</th>
          <th>Day P&amp;L</th><th>Best Peak+RR</th><th>Max Win</th><th>Max Loss</th>
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
            <th title="Best favorable RR reached">Peak+RR</th>
            <th title="Worst adverse % of SL used">Peak−RR%</th>
            <th title="Distance to TP in RR">→TP</th>
            <th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+0.1</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+0.2</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+0.3</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+0.4</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+0.5</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+0.6</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+0.7</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+0.8</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+0.9</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+1.0</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+1.5</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+2.0</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--g)">+3.0</th>
            <th class="pos-ms-col" style="display:none;font-size:8px;color:var(--r)">-1.0</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--r)">-0.9</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--r)">-0.8</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--r)">-0.7</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--r)">-0.6</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--r)">-0.5</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--r)">-0.4</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--r)">-0.3</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--r)">-0.2</th><th class="pos-ms-col" style="display:none;font-size:8px;color:var(--r)">-0.1</th>
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

<!-- ══════════════ PAGE: GHOST TRACKER ═════════════════════════ -->
<div class="npage" id="page-ghosts">
  <div class="pg">
<!-- Ghost Tracker: no date filter — always shows ACTIVE ghosts (same as Open Positions) -->
  <div id="gh-dfbar" style="background:var(--bg3);border-bottom:1px solid var(--bdr);padding:5px 14px;display:flex;align-items:center;gap:6px">
    <span style="font-size:9px;color:var(--p);font-weight:700">● ACTIEF</span>
    <span style="font-size:9px;color:var(--ink3)">Toont alle actieve ghost trackers · sluit automatisch bij −1R SL / +15R TP / 14 dagen · ververst elke 30s</span>
  </div>
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="gh-dot"></div>Ghost Tracker — Active (until SL hit | 15R | timeout)</div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="fb" onclick="toggleMsCols()">± Milestones</button>
          <div class="cmeta" id="gh-meta">Phantom SL = real SL at open · runs until closed</div>
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
            <th title="Best favorable RR">Peak+RR</th><th title="Worst adverse RR%">Peak−RR%</th>
            <th colspan="${ADV_STEPS.length}" class="adv-th" style="text-align:center">← Adverse</th>
            <th colspan="${FAV_STEPS.length}" class="fav-th" style="text-align:center">Favorable →</th>
            <th>Elapsed</th><th>Opened</th>
          </tr>
          <tr>
            <th colspan="7"></th>
            ${ADV_STEPS.map(v=>'<th class="adv-th">-'+v.toFixed(1)+'</th>').join('')}
            ${FAV_STEPS.map(v=>'<th class="fav-th">+'+v.toFixed(1)+'</th>').join('')}
            <th colspan="2"></th>
          </tr></thead>
          <tbody id="gh-body"><tr><td colspan="100" class="nd">No active ghost trackers</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: GHOST HISTORY ═════════════════════════ -->
<div class="npage" id="page-history">
  <div class="pg">
<!-- Date filter: history -->
  <div id="hist-dfbar" style="background:var(--bg3);border-bottom:1px solid var(--bdr);padding:5px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <span style="font-size:9px;font-weight:700;color:var(--b);text-transform:uppercase;letter-spacing:.5px">📅</span>
    <span class="fl">Closed:</span>
    <input type="date" id="hist-open-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span style="color:var(--ink3);font-size:10px">→</span>
    <input type="date" id="hist-open-to"   style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span style="font-size:9px;color:var(--ink3);margin-left:4px">Filter op CLOSED datum (wanneer ghost gesloten werd)</span>
    <button class="fb" onclick="applyHISTFilter()" style="margin-left:4px;background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)">Apply</button>
    <button class="fb" onclick="resetHISTFilter()" style="margin-left:2px">Reset</button>
    <span id="hist-df-active" style="display:none;font-size:9px;color:var(--y);font-weight:700;margin-left:4px">⚠ Gefilterd</span>
  </div>
    <!-- Grouped by pair - expandable -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="ghh-dot"></div>Ghost History — Grouped per Pair · Click row for detail</div>
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
            <th title="Total finished ghost trades"># Ghosts</th>
            <th class="cr" title="Phantom SL hit">SL Hits</th>
            <th class="cg" title="Reached +15R">15R</th>
            <th class="cy" title="Timeout 14 days">T/O</th>
            <th class="cg" title="Average best RR reached">Avg Peak+</th>
            <th class="cr" title="Average worst adverse RR">Avg Peak−</th>
            <th class="cg" title="Best single trade peak RR">Max Peak+</th>
            <th class="cy" title="EV estimate: (WR × avgPeak) − (1−WR)">EV Est.</th>
            <th class="cd" title="Total realized P&L">P&amp;L</th>
            <th title="Most common stop reason">Stop</th>
          </tr></thead>
          <tbody id="ghh-body"><tr><td colspan="16" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- Signal combo grouped — only completed ghosts -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="ghc-dot"></div>Ghost History — By Signal Combo · EV Data Source</div>
        <div class="cmeta" id="ghc-meta">Only finalized ghosts · used for EV optimizer</div>
      </div>
      <div style="padding:6px 14px;background:rgba(88,166,255,.04);border-bottom:1px solid rgba(88,166,255,.1);font-size:10px;color:var(--ink3)">
        ℹ Each row = one signal combo (Symbol + Session + Dir + VWAP). Milestone columns show avg time to reach each RR level. Min 5 ghosts for EV lock.
      </div>
      <div class="tw">
        <table id="ghc-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Ghosts</th><th># EV</th><th>Peak+RR</th><th>Avg RR</th>
            <th class="adv-th">T-¼R</th><th class="adv-th">T-½R</th>
            <th class="adv-th">T-¾R</th><th class="adv-th">T-1R</th>
            <th class="fav-th">T+½R</th><th class="fav-th">T+1R</th>
            <th class="fav-th">T+2R</th><th class="fav-th">T+3R</th>
            <th class="fav-th">T+5R</th><th class="fav-th">T+10R</th>
            <th class="fav-th">T+15R</th>
            <th>Stop Reason</th><th>MAE p50</th><th>MAE p75</th><th>MAE p90</th>
            <th>EV SL</th><th>EV TP</th>
          </tr></thead>
          <tbody id="ghc-body"><tr><td colspan="26" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: EV TP OPTIMIZER ═══════════════════════ -->
<div class="npage" id="page-ev">
  <div class="pg">
<!-- Date filter: ev -->
  <div id="ev-dfbar" style="background:var(--bg3);border-bottom:1px solid var(--bdr);padding:5px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <span style="font-size:9px;font-weight:700;color:var(--b);text-transform:uppercase;letter-spacing:.5px">📅</span>
    <span class="fl">Open:</span>
    <input type="date" id="ev-open-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span style="color:var(--ink3);font-size:10px">→</span>
    <input type="date" id="ev-open-to"   style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
        <span class="fl" style="margin-left:8px">Closed:</span>
        <input type="date" id="ev-close-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
        <span style="color:var(--ink3);font-size:10px">→</span>
        <input type="date" id="ev-close-to"   style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <button class="fb" onclick="applyEVFilter()" style="margin-left:4px;background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)">Apply</button>
    <button class="fb" onclick="resetEVFilter()" style="margin-left:2px">Reset</button>
    <span id="ev-df-active" style="display:none;font-size:9px;color:var(--y);font-weight:700;margin-left:4px">⚠ Gefilterd</span>
  </div>
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot r" id="ev-dot"></div>EV / TP Optimizer — All Signal Combos</div>
        <div class="cmeta" id="ev-meta">EV data from ≥5 ghosts · TP auto-locked by server at ≥10 ghosts</div>
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
        <div class="ks"><div class="ksl">Total P&amp;L (compliance+)</div><div class="ksv cy" id="ev-pnl">+€0.00</div></div>
      </div>
      <div class="tw">
        <table id="ev-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Ghosts</th><th># Trades</th><th>Best TP RR</th><th>Avg RR</th>
            <th>EV Score</th><th>Status</th><th>TP Lock</th>
            <th>Avg T→SL</th><th>Avg MAE%</th><th>P&amp;L€</th>
          </tr></thead>
          <tbody id="ev-body"><tr><td colspan="15" class="nd">No combos match current filters</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════ PAGE: EV SL OPTIMIZER ══════════════════════ -->
<div class="npage" id="page-evsl">
  <div class="pg">
<!-- Date filter: evsl -->
  <div id="evsl-dfbar" style="background:var(--bg3);border-bottom:1px solid var(--bdr);padding:5px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
    <span style="font-size:9px;font-weight:700;color:var(--b);text-transform:uppercase;letter-spacing:.5px">📅</span>
    <span class="fl">Open:</span>
    <input type="date" id="evsl-open-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <span style="color:var(--ink3);font-size:10px">→</span>
    <input type="date" id="evsl-open-to"   style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
        <span class="fl" style="margin-left:8px">Closed:</span>
        <input type="date" id="evsl-close-from" style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
        <span style="color:var(--ink3);font-size:10px">→</span>
        <input type="date" id="evsl-close-to"   style="background:var(--bg2);border:1px solid var(--bdr2);color:var(--ink2);padding:2px 7px;border-radius:3px;font:10px 'SF Mono',monospace;cursor:pointer">
    <button class="fb" onclick="applyEVSLFilter()" style="margin-left:4px;background:var(--b2);color:var(--b);border-color:rgba(88,166,255,.4)">Apply</button>
    <button class="fb" onclick="resetEVSLFilter()" style="margin-left:2px">Reset</button>
    <span id="evsl-df-active" style="display:none;font-size:9px;color:var(--y);font-weight:700;margin-left:4px">⚠ Gefilterd</span>
  </div>
    <div class="card">
      <div class="card-hdr">
        <div class="card-title"><div class="dot" id="evsl-dot"></div>EV SL Optimizer — MAE-based SL Reduction · Read Only</div>
        <div class="cmeta">Never auto-applied · min 5 ghost trades required per combo</div>
      </div>
      <div class="explain-grid">
        <div class="explain-cell">
          <div class="explain-step">Step 1 — Ghost MAE data</div>
          <div class="explain-body">Every ghost trade records the <span class="cy fw">Max Adverse Excursion (MAE)</span> — how deep price went against the position before recovery or SL hit. Expressed as % of full SL distance (0–100%).</div>
        </div>
        <div class="explain-cell">
          <div class="explain-step">Step 2 — Percentile analysis</div>
          <div class="explain-body"><span class="cg fw">MAE p50</span> = median trade went no deeper than this. <span class="cy fw">MAE p90</span> = 90% of trades stayed within this level. Smaller p90 = more room to tighten the SL safely.</div>
        </div>
        <div class="explain-cell">
          <div class="explain-step">Step 3 — What to do</div>
          <div class="explain-body"><span class="cg fw">Green (p90 &lt;50%)</span>: strong tightening possible. <span class="cy fw">Yellow (50–75%)</span>: moderate. <span class="cr fw">Red (&gt;75%)</span>: keep SL as-is. Always verify with risk manager before applying.</div>
        </div>
      </div>
      <div class="tw">
        <table id="evsl-tbl">
          <thead><tr>
            <th>Symbol</th><th>Type</th><th>Session</th><th>Dir</th><th>VWAP</th>
            <th># Ghosts</th><th>MAE p50</th><th>MAE p75</th><th>MAE p90</th>
            <th>SL Advice</th><th>Best SL%</th><th>Potential Reduction</th>
            <th>Shadow p50</th><th>Shadow p90</th>
          </tr></thead>
          <tbody id="evsl-body"><tr><td colspan="14" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table>
      </div>
    </div>
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
    <span id="sig-df-active" style="display:none;font-size:9px;color:var(--y);font-weight:700;margin-left:4px">⚠ Gefilterd</span>
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

      <!-- v14.0: Full signal log — shows where each signal went: Ghost Tracker OR Shadow Playbook -->
      <div class="col-hdr" style="border-top:1px solid var(--bdr)">
        <div style="width:6px;height:6px;border-radius:50%;background:var(--b)"></div>
        <span class="col-hdr-title" style="color:var(--b)">All Signals — Where did each signal go?</span>
        <span class="cmeta" style="margin-left:auto">PLACED → Ghost Tracker · BLOCKED → Shadow Playbook · ERRORS excluded</span>
      </div>
      <div class="tw" style="max-height:500px;overflow-y:auto">
        <table id="placed-tbl"><thead><tr>
          <th>Time</th><th>Symbol</th><th>Dir</th><th>Session</th><th>VWAP</th>
          <th>Entry</th><th>SL%</th><th>Band%</th><th>Outcome</th><th>Destination</th><th>Latency</th>
        </tr></thead><tbody id="placed-body"><tr><td colspan="11" class="nd">—</td></tr></tbody></table>
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
      <strong style="color:var(--p)">🔮 Shadow Playbook</strong> — Invisible ghost trackers voor geblokkeerde signalen.
      Elk signaal dat geblokkeerd wordt door <span style="color:var(--o)">NY Dead Zone</span>, <span style="color:var(--y)">Duplicate Position</span> of <span style="color:var(--r)">VWAP Exhaustion</span>
      wordt bijgehouden als een echte ghost — inclusief RR milestones, peak RR en SL tracking.
      Gebruik deze data om te beslissen welke setups je aan je playbook wil toevoegen.
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
          <button class="fb" id="bgt-ms-btn" onclick="toggleBGTMilestones()">± Milestones</button>
          <div class="cmeta" id="bgt-active-meta">loading…</div>
        </div>
      </div>
      <div class="tw">
        <table>
          <thead><tr>
            <th style="position:sticky;left:0;background:var(--bg3)">Symbol</th>
            <th>Type</th><th>Block</th><th>Dir</th><th>VWAP</th><th>Sess</th>
            <th>Entry</th><th>Peak+RR</th><th title="MAE: % of SL used">Peak−MAE</th>
            <th title="VWAP band% at block">Band%</th>
            <th title="When signal was blocked">Blocked At</th><th>Elapsed</th>
            <th class="adv-th bgt-ms-col" style="display:none" colspan="10">← Adverse</th>
            <th class="fav-th bgt-ms-col" style="display:none" colspan="150">Favorable →</th>
          </tr><tr>
            <th colspan="12"></th>
            ${[1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>'<th class="adv-th bgt-ms-col" style="display:none;font-size:7px">-'+v.toFixed(1)+'</th>').join('')}
            ${(()=>{let s='';for(let v=0.1;v<=15.0+1e-9;v=Math.round((v+0.1)*10)/10)s+='<th class="fav-th bgt-ms-col" style="display:none;font-size:7px">+'+v.toFixed(1)+'</th>';return s;})()}
          </tr></thead>
          <tbody id="bgt-active-body"><tr><td colspan="170" class="nd">Geen actieve blocked ghosts</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- Sub-tabs voor 3 block types -->
    <div class="card">
      <div style="display:flex;border-bottom:1px solid var(--bdr);background:var(--bg3)">
        <div id="bgt-tab-ny"   class="ntab on" onclick="setBGTTab('ny')"  style="color:var(--o);border-bottom:2px solid var(--o)">⏰ NY Dead Zone</div>
        <div id="bgt-tab-ow"   class="ntab"    onclick="setBGTTab('ow')"  style="">🌙 Outside Hours (21–02)</div>
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
            <th># Blocked</th><th>SL Hits</th><th>15R Hits</th>
            <th>Avg Peak+RR</th><th>Max Peak+RR</th><th>Avg Peak−RR%</th>
            <th>Verdict</th>
          </tr></thead>
          <tbody id="bgt-ny-body"><tr><td colspan="13" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table></div>
      </div>

      <!-- OUTSIDE HOURS (21:00–02:00) -->
      <div id="bgt-pane-ow" style="display:none">
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
          <th># Blocked</th><th>SL Hits</th><th>15R Hits</th><th>Avg Peak+RR</th><th>Max Peak+RR</th><th>Avg Peak−RR%</th><th>Verdict</th>
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
            <th># Blocked</th><th>SL Hits</th><th>15R Hits</th>
            <th>Avg Peak+RR</th><th>Max Peak+RR</th><th>Avg Peak−RR%</th>
            <th>Verdict</th>
          </tr></thead>
          <tbody id="bgt-dup-body"><tr><td colspan="13" class="nd"><span class="spin">⟳</span></td></tr></tbody>
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
            <th># Blocked</th><th>SL Hits</th><th>15R Hits</th>
            <th>Avg Peak+RR</th><th>Max Peak+RR</th><th>Avg Peak−RR%</th>
            <th>Avg Band%</th><th>Verdict</th>
          </tr></thead>
          <tbody id="bgt-vwap-body"><tr><td colspan="14" class="nd"><span class="spin">⟳</span></td></tr></tbody>
        </table></div>
      </div>
    </div>
  </div>
</div>

<script>
'use strict';

// ── Symbol type lookup ────────────────────────────────────────────
const FOREX_S = new Set(['AUDCAD','AUDCHF','AUDNZD','AUDUSD','CADCHF','EURAUD','EURCHF','EURUSD','GBPAUD','GBPNZD','GBPUSD','NZDCAD','NZDCHF','NZDUSD','USDCAD','USDCHF',
  // include common aliases stored in older DB records
  'EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','NZDUSD','USDCAD']);
const INDEX_S = new Set([
  // Canonical names
  'DE30EUR','NAS100USD','UK100GBP','US30USD',
  // MT5 broker names (stored in older closed_trades records)
  'GER40.cash','US100.cash','UK100.cash','US30.cash',
  // TradingView aliases people may have used
  'NAS100','US100','UK100','US30','GER40','DE30',
  // Additional common broker names
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
const sBadge = s => ({asia:'<span class="bd bd-asia">ASIA</span>',london:'<span class="bd bd-lon">LON</span>',ny:'<span class="bd bd-ny">NY</span>'}[s])||'<span class="bd cd">'+s+'</span>';
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
  PAGES.forEach(p=>{ const pg=document.getElementById('page-'+p); if(pg) pg.classList.remove('on'); });
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('on'));
  const pg=document.getElementById('page-'+name); if(pg) pg.classList.add('on');
  const tab=document.querySelector('.ntab[data-page="'+name+'"]'); if(tab) tab.classList.add('on');
  if(!_loaded[name]){
    _loaded[name]=true;
    if(name==='history')         { loadGhostHistory(); loadGhostCombo(); }
    if(name==='evsl')            loadEVSL();
    if(name==='signals')         { loadSignals(); loadBlockedRaw(); loadBand(); }
    if(name==='ev')              loadEV();
    if(name==='shadow-playbook') loadShadowPlaybook();
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
        (peakNeg>0?'-'+f1(peakNeg)+'% ('+f2(peakNeg/100)+'R)':'—')+'</td>'+
      '<td class="cy" title="Distance to TP in RR multiples">'+(tpRR!=null?f2(tpRR)+'R':'—')+'</td>'+
      '<td class="cd" style="font-size:9px">'+fPrice(p.entry,p.symbol)+'</td>'+
      '<td class="cr" style="font-size:9px">'+fPrice(p.sl,p.symbol)+'</td>'+
      '<td class="cg" style="font-size:9px">'+(p.tp?fPrice(p.tp,p.symbol):'—')+'</td>'+
      '<td class="'+(livePnl!=null?(livePnl>=0?'cg':'cr'):'cd')+' fw">'+(livePnl!=null?(livePnl>=0?'+':'')+eu(livePnl):'—')+'</td>'+
      '<td class="cd">'+(lots!=null?f2(lots):'—')+'</td>'+
      '<td class="'+(rPct&&+rPct>0.04?'cr fw':rPct&&+rPct>0.025?'co':'cg')+'">'+(rPct!=null?rPct+'%':'—')+'</td>'+
      '<td class="cd" style="font-size:9px">'+dt(p.openedAt)+'</td>'+
    // Milestone cells — hidden by default, shown when ± Milestones clicked
    (()=>{
      const rrMs = p.ghost?.rrMilestones ?? {};
      const openedTs = p.openedAt ? new Date(p.openedAt).getTime() : null;
      const favSteps=[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0,1.5,2.0,3.0];
      const advSteps=[1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1];
      const fmtMs = ts => {
        if(!ts||!openedTs) return '—';
        // Handle both ms timestamp (number) and ISO string
        const tsMs = typeof ts === 'number' ? ts : new Date(ts).getTime();
        if(!tsMs || isNaN(tsMs)) return '—';
        const mins = Math.round((tsMs - openedTs) / 60000);
        if(mins < 0) return '—';
        return mins < 60 ? mins+'m' : Math.floor(mins/60)+'h'+(mins%60 ? String(mins%60).padStart(2,'0')+'m' : '');
      };
      const f=favSteps.map(v=>'<td class="pos-ms-col" style="display:none;text-align:center;font-size:8px">'+(rrMs['+'+v.toFixed(1)]?'<span style="color:var(--g)">'+fmtMs(rrMs['+'+v.toFixed(1)])+'</span>':'<span style="color:var(--ink3)">—</span>')+'</td>').join('');
      const a=advSteps.map(v=>'<td class="pos-ms-col" style="display:none;text-align:center;font-size:8px">'+(rrMs['-'+v.toFixed(1)]?'<span style="color:var(--r)">'+fmtMs(rrMs['-'+v.toFixed(1)])+'</span>':'<span style="color:var(--ink3)">—</span>')+'</td>').join('');
      return f+a;
    })()+
    '</tr>';
  }).join('');
}


// ── loadGhostTrackers — reuses /api/open-positions ghost data ─────
async function loadGhostTrackers(){
  const d=await api('/api/open-positions')||[];
  const ghosts=d.filter(p=>p.ghost!=null);
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
  tbody.innerHTML=ghosts.map(g=>{
    const peakPos=g.ghost?.peakRRPos??g.ghost?.maxRR??0;
    const peakNeg=g.ghost?.peakRRNeg??g.ghost?.maxSlPctUsed??0;
    const advMs=g.ghost?.slMilestones||{};
    const favMs=g.ghost?.rrMilestones||{};
    const advKeys=Object.keys(advMs).map(Number);
    const favKeys=Object.keys(favMs).map(Number);
    const elapsed=g.openedAt?Math.round((Date.now()-new Date(g.openedAt))/60000):null;
    return '<tr>'+
      '<td class="cb fw" style="font-size:11px">'+g.symbol+'</td>'+
      '<td>'+tBadge(symType(g.symbol))+'</td>'+
      '<td>'+sBadge(g.session)+'</td>'+
      '<td>'+dBadge(g.direction)+'</td>'+
      '<td>'+vBadge(g.vwapPosition)+'</td>'+
      '<td class="'+(peakPos>=2?'cg fw':peakPos>=1?'cg':peakPos>0?'cy':'cd')+'">'+f2(peakPos)+'R</td>'+
      '<td class="'+(peakNeg>80?'cr fw':peakNeg>50?'cr':peakNeg>25?'co':'cd')+'">'+
        (peakNeg>0?'-'+f1(peakNeg)+'% ('+f2(peakNeg/100)+'R)':'—')+'</td>'+
      ADV_STEPS.map(v=>{
        // ADV keys stored as "-0.1", "-0.2" ... "-1.0" in rrMilestones
        return msT(favMs['-'+v.toFixed(1)]||null, g.openedAt, false);
      }).join('')+
      FAV_STEPS.map(v=>{
        // Support both old format ('0.1') and new format ('+0.1')
        const key = v.toFixed(1);
        return msT(favMs['+'+key] ?? favMs[key] ?? null, g.openedAt, true);
      }).join('')+
      '<td class="cd">'+msFmt(elapsed)+'</td>'+
      '<td class="cd" style="font-size:9px">'+
        (g.tradeNumber?'<span style="color:var(--ink3);font-size:8px">#'+g.tradeNumber+'</span> ':'')+
        dt(g.openedAt)+'</td>'+
    '</tr>';
  }).join('');
}

// ── renderOverview — called after trades+daily+ghGrouped load ────
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
  setText('d-tot',total); setText('d-fx',fxT.length); setText('d-sk',skT.length);
  // Note: skT may include old trades from before stock session restriction (pre-v13)
  // These were placed in London/Asia before the 16:00-21:00 Brussels rule was added
  setText('d-ix',ixT.length); setText('d-cm',cmT.length);
  setText('d-buy',buys); setText('d-sell',total-buys);

  let ba_t=0,bb_t=0,sa_t=0,sb_t=0;
  const typeGroups=[
    {label:'Forex',    arr:fxT, cls:'bd-fx', sessions:['asia','london','ny','outside']},
    {label:'Stock',    arr:skT, cls:'bd-sk', sessions:['ny'], anomalyCheck: true,
      note:'Stocks only tradeable 16:00–21:00 Brussels (NY session). Asia/London entries = historical data before session restriction.'},
    {label:'Index',    arr:ixT, cls:'bd-ix', sessions:['asia','london','ny','outside']},
    {label:'Commodity',arr:cmT, cls:'bd-cm', sessions:['asia','london','ny','outside']},
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
      dRows.push('<tr><td><span class="bd '+tg.cls+'">'+tg.label+'</span></td><td>'+sessLabel+'</td><td class="cg fw">'+ba+'</td><td class="cg">'+bb+'</td><td class="cr fw">'+sa+'</td><td class="cr">'+sb+'</td><td class="cb fw">'+(ba+bb+sa+sb)+'</td></tr>');
    }
  }
  setHtml('dist-body',dRows.join('')||emptyRow(7,'No trades after compliance date'));
  setText('ft-ba',ba_t); setText('ft-bb',bb_t); setText('ft-sa',sa_t); setText('ft-sb',sb_t); setText('ft-t',total);

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
    // Skip stock trades in Asia/London (historical anomaly pre-session-restriction)
    const tp = symType(t.symbol);
    if(tp==='stock' && t.session !== 'ny') continue;
    const k=(t.session||'?')+'|'+(t.direction||'?')+'|'+(t.vwapPosition||'?')+'|'+tp;
    combos[k]=(combos[k]||0)+1;
  }
  const rows=Object.entries(combos).sort((a,b)=>b[1]-a[1]).map(([k,n])=>{
    const [sess,dir,vwap,type]=k.split('|');
    return '<tr><td>'+sBadge(sess)+'</td><td>'+dBadge(dir)+'</td><td>'+vBadge(vwap)+'</td><td>'+tBadge(type)+'</td><td class="cb fw">'+n+'</td></tr>';
  }).join('');
  setHtml('wr-body',rows||emptyRow(5,'No trades'));
  setText('wr-meta',(filtered.length)+' trades · compliance+');
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
    const avgRRLabel = g.nWithPeakRR > 0
      ? f2(g.avgPeakPos)+'R'
      : (g.trades.some(t=>(t.peakRRPos||0)>0) ? f2(g.avgPeakPos)+'R' : '—');
    const pnlLabel = g.totalPnl != null
      ? '<span class="'+(g.totalPnl>=0?'cg':'cr')+'">'+eu(g.totalPnl)+'</span>'
      : '—';
    // EV estimate from DB (computed in loadGhostHistoryByPair)
    const ev = g.evEstimate;
    const evLabel = ev!=null
      ? '<span class="'+(ev>0.2?'cg fw':ev>0?'cy':'cr')+'">'+(ev>0?'+':'')+ev.toFixed(2)+'</span>'
      : (g.n>=3?'<span class="cd">calc…</span>':'<span class="cd">need≥3</span>');
    return '<tr style="cursor:pointer;border-left:3px solid '+(g.direction==='buy'?'var(--g)':'var(--r)')+'" onclick="toggleGHHRow('+Q+safeKey+Q+')">'+
      '<td class="cd" style="font-size:9px">▶</td>'+
      '<td class="cb fw" style="white-space:nowrap">'+g.symbol+activeBadge+complBadge+'</td>'+
      '<td style="min-width:40px">'+tBadge(symType(g.symbol))+'</td>'+
      '<td>'+(g.session?sBadge(g.session):'<span class="cd">—</span>')+'</td>'+
      '<td>'+(g.direction?dBadge(g.direction):'<span class="cd">—</span>')+'</td>'+
      '<td>'+(g.vwapPosition?vBadge(g.vwapPosition):'<span class="cd">—</span>')+'</td>'+
      '<td class="'+(g.n>=5?'cy fw':'cc')+'">'+g.n+'</td>'+
      '<td class="cr">'+(g.nSLHit||0)+'</td>'+
      '<td class="cg">'+(g.nMaxRR15||0)+'</td>'+
      '<td class="cy">'+(g.nMaxDays||0)+'</td>'+
      '<td class="cg fw">'+avgRRLabel+'</td>'+
      '<td class="cr">'+(g.avgPeakNeg>0?f1(g.avgPeakNeg)+'%':'—')+'</td>'+
      '<td class="cg fw">'+( g.maxPeakPos>0?f2(g.maxPeakPos)+'R':'—')+'</td>'+
      '<td style="font-size:9px">'+evLabel+'</td>'+
      '<td>'+pnlLabel+'</td>'+
      '<td class="cd" style="font-size:9px">'+(topReason||'—')+'</td>'+
    '</tr>'+
    '<tr id="ghh-d-'+safeKey+'" style="display:none">'+
      '<td colspan="16" style="padding:0;background:var(--bg3)">'+
        '<div style="overflow-x:auto"><table style="font-size:9px;min-width:900px">'+
          '<thead><tr>'+
            '<th>#</th><th>Geopend</th><th>Gesloten</th><th>Stop</th><th>TP RR</th>'+
            '<th>Peak+RR</th><th class="cd">P&L</th>'+
            '<th class="ghh-ms-col" style="display:none;text-align:center" colspan="10">← Adverse (tijd) →</th>'+
            '<th class="ghh-ms-col" style="display:none;text-align:center" colspan="150">Favorable (tijd) →</th>'+
          '</tr>'+
          '<tr>'+
            '<th colspan="5"></th>'+
            [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>'<th class="adv-th ghh-ms-col" style="display:none;font-size:8px">-'+v.toFixed(1)+'</th>').join('')+
            (()=>{let s='';for(let v=0.1;v<=15.0+1e-9;v=Math.round((v+0.1)*10)/10)s+='<th class="fav-th ghh-ms-col" style="display:none;font-size:8px">+'+v.toFixed(1)+'</th>';return s;})()
          +'</tr></thead><tbody>'+
          (g.trades||[]).map((t,i)=>{
            const sr=t.stopReason;
            // v13.3: SL HIT = peak -RR altijd 100% (= 1.0R adverse)
            const isSLHit = sr==='phantom_sl'||t.phantomSLHit;
            const srCls=sr==='phantom_sl'||sr==='gap_stop'?'cr':sr==='max_rr_15'?'cg':'cy';
            const rrMs  = t.rrMilestones || {};
            const slMs  = t.slMilestones || {};
            // Milestone cell helper: toont elapsed tijd in minuten
            const msCell=(iso,opened,isFav)=>{
              const cls=isFav?'ms-fav cg':'ms-adv cr';
              if(!iso||!opened) return '<td class="'+cls+'" style="font-size:8px;min-width:28px">—</td>';
              const mins=Math.round((new Date(iso)-new Date(opened))/60000);
              const h=Math.floor(mins/60),m=mins%60;
              return '<td class="'+cls+'" style="font-size:8px;min-width:28px">'+(h>0?h+'h'+m+'m':m+'m')+'</td>';
            };
            return '<tr style="border-bottom:1px solid var(--bdr)">'+
              '<td class="cd">'+(i+1)+'</td>'+
              '<td class="cd" style="font-size:8px">'+dt(t.openedAt)+'</td>'+
              '<td class="cd" style="font-size:8px">'+(t.closedAt?dt(t.closedAt):t._active?'<span class="cg fw">● RUNNING</span>':'<span class="cy">—</span>')+'</td>'+
              '<td class="'+srCls+'" style="font-size:8px">'+
                (sr==='gap_stop'?'⚡ GAP SL':sr==='phantom_sl'?'SL HIT':sr==='max_rr_15'?'TP 15R':
                 sr==='timeout_14d'?'TIMEOUT':t._active?'<span style="color:var(--g)">● LIVE</span>':
                 sr?sr:'<span class="cd">—</span>')+'</td>'+
              '<td class="cy">'+(t.tpRRUsed!=null?f2(t.tpRRUsed)+'R':'—')+'</td>'+
              '<td class="cg fw">'+(t.peakRRPos>0?f2(t.peakRRPos)+'R':t._active&&(t.peakRRPos||0)===0?'<span class="cd">0.00R</span>':'—')+'</td>'+
              '<td class="'+(t.realizedPnlEUR!=null?(t.realizedPnlEUR>=0?'cg':'cr'):'cd')+'" style="font-size:9px">'+
                (t.realizedPnlEUR!=null?eu(t.realizedPnlEUR):'—')+'</td>'+
              // ADV milestones -0.1 to -1.0 (hidden until ± Milestones clicked)
              [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>{
                const key='-'+v.toFixed(1);
                let iso=rrMs[key]||null;
                if(!iso&&isSLHit&&Math.abs(v-1.0)<1e-9) iso=t.closedAt||null;
                const cls='adv-cr ghh-ms-col'; const d=_ghhMsVisible?'':'none';
                if(!iso||!t.openedAt) return '<td class="'+cls+'" style="display:'+d+';font-size:8px">—</td>';
                const mins=Math.round((new Date(iso)-new Date(t.openedAt))/60000);
                const hh=Math.floor(mins/60),mm=mins%60;
                return '<td class="'+cls+'" style="display:'+d+';font-size:8px">'+(hh>0?hh+'h'+mm+'m':mm+'m')+'</td>';
              }).join('')+
              // FAV milestones +0.1 to +15.0 (hidden until ± Milestones clicked)
              (()=>{let s='';for(let v=0.1;v<=15.0+1e-9;v=Math.round((v+0.1)*10)/10){
                const key=v.toFixed(1);
                const iso=rrMs[key]||null;
                const cls='fav-cg ghh-ms-col'; const d=_ghhMsVisible?'':'none';
                if(!iso||!t.openedAt){ s+='<td class="'+cls+'" style="display:'+d+';font-size:8px">—</td>'; continue; }
                const mins=Math.round((new Date(iso)-new Date(t.openedAt))/60000);
                const hh=Math.floor(mins/60),mm=mins%60;
                s+='<td class="'+cls+'" style="display:'+d+';font-size:8px">'+(hh>0?hh+'h'+mm+'m':mm+'m')+'</td>';
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
  document.querySelectorAll('.bgt-ms-col').forEach(el=>el.style.display=_bgtMsVisible?'':'none');
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
  setText('ev-meta',rows.length+' combos shown · ≥'+minN+' ghosts required for EV lock');
  // Compute total realized P&L
  const totalPnl = (_allTrades||[]).reduce((s,t)=>s+(t.realizedPnlEUR||0),0);
  // Show avg latency from recent signals
  const recentSigs = (_allTrades||[]).filter(t=>t.latencyMs>0).slice(0,50);
  const avgLat = recentSigs.length ? Math.round(recentSigs.reduce((s,t)=>s+(t.latencyMs||0),0)/recentSigs.length) : null;
  const latEl = document.getElementById('ev-latency');
  if(latEl && avgLat!=null) latEl.textContent = avgLat+'ms avg';
  const pnlEl = document.getElementById('ev-pnl');
  if(pnlEl){ pnlEl.textContent=(totalPnl>=0?'+':'')+'\u20AC'+totalPnl.toFixed(2); pnlEl.className='ksv '+(totalPnl>=0?'cg':'cr'); }
  const tbody=document.getElementById('ev-body'); if(!tbody) return;
  if(!rows.length){ tbody.innerHTML=emptyRow(15,'No combos match filters'); return; }
  tbody.innerHTML=rows.map(r=>{
    const tp=r.tpLocked;
    return '<tr>'+
      '<td class="cb fw">'+r.symbol+'</td>'+
      '<td>'+tBadge(symType(r.symbol))+'</td>'+
      '<td>'+sBadge(r.session)+'</td>'+
      '<td>'+dBadge(r.direction)+'</td>'+
      '<td>'+vBadge(r.vwapPosition)+'</td>'+
      '<td class="'+(r.n>=5?'cy fw':'cc')+'">'+r.n+'</td>'+
      '<td class="cd">'+r.n+'</td>'+
      '<td class="cg fw">'+f2(r.bestMaxRR)+'R</td>'+
      '<td class="cd">'+f2(r.avgMaxRR)+'R</td>'+
      '<td class="cd">—</td>'+
      '<td class="'+(tp?.lockedRR?'cg':'cy')+'" style="font-size:9px">'+(tp?.lockedRR?'✓ EV+ Locked':'need≥5')+'</td>'+
      '<td class="'+(tp?.lockedRR?'cg fw':'cd')+'">'+( tp?.lockedRR?tp.lockedRR+'R':'—')+'</td>'+
      '<td class="cd">'+f1(r.avgSlPct)+'% avg SL</td>'+
      '<td class="cd">—</td>'+
      '<td class="cd">—</td>'+
    '</tr>';
  }).join('');
}

// ── EV SL Optimizer ───────────────────────────────────────────────
async function loadEVSL(){
  // /api/mae-stats returns: {optimizerKey,nTotal,nSurvivors,nSLHit,maeP50,maeP75,maeP90,maeAvg,slReduction}
  const d=await api('/api/mae-stats')||[];
  const tbody=document.getElementById('evsl-body'); if(!tbody) return;
  if(!d.length){ tbody.innerHTML=emptyRow(14,'Min 3 ghost trades required per combo · waiting for ghost data'); return; }
  tbody.innerHTML=d.map(r=>{
    const parts=(r.optimizerKey||'').split('_');
    const sym=parts[0]||'—',sess=parts[1]||'—',dir=parts[2]||'—',vwap=parts[3]||'—';
    const p90=r.maeP90; const slRec=r.slReduction;
    const cls=slRec?.color==='g'?'cg':slRec?.color==='y'?'cy':slRec?.color==='r'?'cr':'cd';
    const pot=p90!=null&&p90<100?(100-p90).toFixed(1)+'% possible':'—';
    return '<tr>'+
      '<td class="cb fw">'+sym+'</td>'+
      '<td>'+tBadge(symType(sym))+'</td>'+
      '<td>'+sBadge(sess)+'</td>'+
      '<td>'+dBadge(dir)+'</td>'+
      '<td>'+vBadge(vwap)+'</td>'+
      '<td class="'+(r.nTotal>=5?'cy':'cc')+'">'+r.nTotal+' <span class="cd" style="font-size:9px">('+r.nSurvivors+' surv/'+r.nSLHit+' SL)</span></td>'+
      '<td class="cg">'+f1(r.maeP50)+'%</td>'+
      '<td class="cy">'+f1(r.maeP75)+'%</td>'+
      '<td class="'+cls+' fw">'+f1(r.maeP90)+'%</td>'+
      '<td class="'+cls+' fw" style="font-size:9px">'+(slRec?.label||'—')+'</td>'+
      '<td class="cd">'+f1(r.maeAvg)+'%</td>'+
      '<td class="'+(pot!=='—'?'cg':'cd')+'" style="font-size:9px">'+pot+'</td>'+
      '<td class="cd">—</td><td class="cd">—</td>'+
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
  setText('blk-win', byReason['outside_window']||byReason['outside_trading_window']||0);
  setText('blk-cur', byReason['currency_budget']||byReason['budget']||0);
  setText('blk-ny',  byReason['ny_dead_zone']||byReason['ny_dz']||0);
  const nbSig=document.getElementById('nb-sig');
  if(nbSig){ nbSig.textContent=shadowCount||''; nbSig.style.display=shadowCount?'':'none'; }

  // Full signal log — one row per signal, shows exact destination
  const outcomeDestination = r => {
    const oc = (r.outcome||'').toUpperCase();
    const bandPct = r.band_pct ? f1(r.band_pct)+'%' : '';
    if(oc==='PLACED')
      return {label:'✓ Ghost Tracker', cls:'cg fw',
              badge:'<span style="background:#1b5e20;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">PLACED</span>'};
    if(oc==='NY_DEAD_ZONE')
      return {label:'⏰ Shadow (NY Dead Zone)', cls:'co fw',
              badge:'<span style="background:#e65100;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">NY ZONE</span>'};
    if(oc==='DUPLICATE_POSITION')
      return {label:'📌 Shadow (Duplicate)', cls:'cy fw',
              badge:'<span style="background:#f57f17;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">DUPL</span>'};
    if(oc==='VWAP_EXHAUSTION')
      return {label:'📊 Shadow (VWAP '+(bandPct||'>')+' 150%)', cls:'cp fw',
              badge:'<span style="background:#4a148c;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">VWAP</span>'};
    if(oc==='ORDER_NOT_CONFIRMED')
      return {label:'⚠ Niet bevestigd', cls:'cy',
              badge:'<span style="color:var(--y)">UNCONF</span>'};
    // Outside window / stock outside market
    if((r.reason||'').includes('OUTSIDE_WINDOW')||(r.reason||'').includes('OUTSIDE_MARKET'))
      return {label:'🌙 Outside Hours', cls:'co',
              badge:'<span style="background:#e65100;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">OUTSIDE</span>'};
    return {label:'✗ '+(r.reason||oc).slice(0,25), cls:'cr',
            badge:'<span style="background:#b71c1c;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px">REJECT</span>'};
  };
  setHtml('placed-body', allSig.length ? allSig.map(r=>{
    const dest = outcomeDestination(r);
    return '<tr>'+
      '<td class="cd" style="font-size:9px">'+dt(r.ts)+'</td>'+
      '<td class="cb fw">'+( r.symbol||'—')+'</td>'+
      '<td>'+(r.direction?dBadge(r.direction):'—')+'</td>'+
      '<td>'+(r.session?sBadge(r.session):'—')+'</td>'+
      '<td>'+(r.vwap_position?vBadge(r.vwap_position):'—')+'</td>'+
      '<td class="cd">'+f2(r.entry)+'</td>'+
      '<td class="cd">'+(r.sl_pct!=null?pct(r.sl_pct*100):'—')+'</td>'+
      '<td class="cd">'+(r.band_pct!=null?pct(r.band_pct):'—')+'</td>'+
      '<td>'+dest.badge+'</td>'+
      '<td class="'+dest.cls+'" style="font-size:9px">'+dest.label+'</td>'+
      (()=>{ const lms=r.latency_ms; const lc=lms==null?'cd':lms<500?'cg':lms<2000?'cy':'cr';
        return '<td class="'+lc+'">'+( lms!=null?lms+'ms':'—')+'</td>'; })()+
    '</tr>';
  }).join('') : emptyRow(11,'Geen signalen gevonden · pas filter aan of wacht op nieuwe webhooks'));
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
  ['ny','ow','dup','vwap'].forEach(t => {
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
    const avgBand = tab === 'vwap'
      ? ((g.trades||[]).reduce((s,t)=>s+(t.vwapBandPct||0),0) / (g.trades?.length||1)).toFixed(0)+'%'
      : null;
    const rowId = safeKey+'_'+tab;
    const mainRow = '<tr style="cursor:pointer" onclick="toggleBGTRow('+Q+rowId+Q+')">'+
      '<td class="cd" style="font-size:9px">▶</td>'+
      '<td class="cb fw">'+g.symbol+'</td>'+
      '<td>'+tBadge(symType(g.symbol))+'</td>'+
      '<td>'+sBadge(g.session)+'</td>'+
      '<td>'+dBadge(g.direction)+'</td>'+
      '<td>'+vBadge(g.vwapPosition)+'</td>'+
      '<td class="cy fw">'+g.n+'</td>'+
      '<td class="cr">'+g.nSLHit+'</td>'+
      '<td class="cg">'+g.nMaxRR15+'</td>'+
      '<td class="cg fw">'+f2(g.avgPeakPos)+'R</td>'+
      '<td class="cg fw">'+f2(g.maxPeakPos)+'R</td>'+
      '<td class="cr">'+f1(g.avgPeakNeg)+'%</td>'+
      (avgBand ? '<td class="cr fw">'+avgBand+'</td>' : '')+
      '<td>'+bgtVerdict(g)+'</td>'+
    '</tr>';

    // Detail sub-tabel
    const detailRow = '<tr id="bgt-d-'+safeKey+'_'+tab+'" style="display:none">'+
      '<td colspan="'+cols+'" style="padding:0;background:var(--bg3)">'+
        '<div style="overflow-x:auto"><table style="font-size:9px;min-width:700px">'+
          '<thead><tr>'+
            '<th>#</th><th>Geopend</th>'+
            (tab==='ny'  ? '<th style="color:var(--o)">⏰ Open Tijd (Brussel)</th>' : '')+
            (tab==='dup' ? '<th style="color:var(--y)">📌 Trade # / Totaal</th>' : '')+
            (tab==='vwap'? '<th style="color:var(--r)">📊 Band%</th>' : '')+
            '<th>Stop</th><th>Peak+RR</th><th>Peak−RR%</th>'+
            '<th>Elapsed</th>'+
            // ADV milestones -0.1 to -1.0
            [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>'<th class="adv-th" style="font-size:8px">-'+v.toFixed(1)+'</th>').join('')+
            // FAV milestones +0.1 to +5.0 (beperkt voor leesbaarheid)
            (()=>{let s='';for(let v=0.1;v<=5.0+1e-9;v=Math.round((v+0.1)*10)/10)s+='<th class="fav-th" style="font-size:8px">+'+v.toFixed(1)+'</th>';return s;})()
          +'</tr></thead><tbody>'+
          (g.trades||[]).map((t,i) => {
            const sr = t.stopReason;
            const srCls = sr==='phantom_sl'||sr==='gap_stop'?'cr':sr==='max_rr_15'?'cg':'cy';
            const isSLHit = sr==='phantom_sl'||t.phantomSLHit;
            const rrMs = t.rrMilestones || {};
            const msC = (iso, opened, isFav) => {
              const cls = isFav ? 'ms-fav cg' : 'ms-adv cr';
              if(!iso||!opened) return '<td class="'+cls+'" style="font-size:8px">—</td>';
              const mins = Math.round((new Date(iso)-new Date(opened))/60000);
              const h=Math.floor(mins/60),m=mins%60;
              return '<td class="'+cls+'" style="font-size:8px">'+(h>0?h+'h'+m+'m':m+'m')+'</td>';
            };
            const elapsed = t.openedAt && t.closedAt
              ? Math.round((new Date(t.closedAt)-new Date(t.openedAt))/60000) : null;
            // v14.1: per-trade extra context based on block type
            const nyTime = tab==='ny' ? '<td class="co" style="font-size:8px;font-weight:700">'+dt(t.openedAt)+'</td>' : '';
            const dupNum = tab==='dup' ? '<td class="cy" style="font-size:8px">#'+(i+1)+' ('+g.n+' total)</td>' : '';
            const vwapBand = tab==='vwap' ? '<td class="cr fw" style="font-size:9px">'+(t.vwapBandPct?f1(t.vwapBandPct)+'%':'—')+'</td>' : '';
            return '<tr style="border-bottom:1px solid var(--bdr)">'+
              '<td class="cd">'+(i+1)+'</td>'+
              '<td class="cd" style="font-size:8px">'+dt(t.openedAt)+'</td>'+
              (tab==='ny'  ? nyTime   : '')+
              (tab==='dup' ? dupNum   : '')+
              (tab==='vwap'? vwapBand : '')+
              '<td class="'+srCls+'" style="font-size:8px">'+(sr==='gap_stop'?'⚡ GAP SL':sr==='phantom_sl'?'SL HIT':sr==='max_rr_15'?'TP 15R':sr||'—')+'</td>'+
              '<td class="cg fw">'+f2(t.peakRRPos)+'R</td>'+
              '<td class="cr">'+(isSLHit?'100%':f1(t.peakRRNeg)+'%')+'</td>'+
              '<td class="cd">'+msFmt(elapsed)+'</td>'+
              [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>{
                const key='-'+v.toFixed(1);
                let iso=rrMs[key]||null;
                if(!iso&&isSLHit&&Math.abs(v-1.0)<1e-9) iso=t.closedAt||null;
                return msC(iso,t.openedAt,false);
              }).join('')+
              (()=>{let s='';for(let v=0.1;v<=5.0+1e-9;v=Math.round((v+0.1)*10)/10){
                s+=msC(rrMs[v.toFixed(1)]||null,t.openedAt,true);
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
  if(meta) meta.textContent = (from||to) ? (from||'begin')+' → '+(to||'nu') : 'Alle blocked ghosts';

  // Laad actieve blocked ghosts
  const active = await api('/api/blocked-ghosts/active') || [];
  const nbBgt  = document.getElementById('nb-bgt');
  if(nbBgt&&active.length) { nbBgt.textContent=active.length; nbBgt.style.display=''; }
  setText('bgt-active-meta', active.length + ' actieve blocked ghosts live');
  const now = Date.now();
  setHtml('bgt-active-body', active.length ? active.map(bg => {
    const elapsed = bg.openedAt ? Math.round((now - new Date(bg.openedAt))/60000) : null;
    const bt = bg.blockType||'';
    const btBadge = bt==='NY_DEAD_ZONE'
      ? '<span style="background:#e65100;color:#fff;padding:1px 4px;border-radius:3px;font-size:8px">⏰ NY ZONE</span>'
      : bt==='DUPLICATE'
      ? '<span style="background:#f57f17;color:#fff;padding:1px 4px;border-radius:3px;font-size:8px">📌 DUPL</span>'
      : '<span style="background:#4a148c;color:#fff;padding:1px 4px;border-radius:3px;font-size:8px">📊 VWAP</span>';
    const rrMs = bg.rrMilestones||{};
    const msBgt=(iso,isFav)=>{
      const d=_bgtMsVisible?'':'none';
      const cls=(isFav?'ms-fav cg':'ms-adv cr')+' bgt-ms-col';
      if(!iso||!bg.openedAt) return '<td class="'+cls+'" style="display:'+d+';font-size:7px">—</td>';
      const mins=Math.round((new Date(iso)-new Date(bg.openedAt))/60000);
      const h=Math.floor(mins/60),m=mins%60;
      return '<td class="'+cls+'" style="display:'+d+';font-size:7px">'+(h>0?h+'h'+m+'m':m+'m')+'</td>';
    };
    const extraCell = bt==='VWAP_EXHAUSTION'
      ? '<td class="cp fw" style="font-size:9px">📊 '+(bg.vwapBandPct?f1(bg.vwapBandPct)+'%':'—')+'</td>'
      : bt==='DUPLICATE'
      ? '<td class="cp fw" style="font-size:9px">📌 Dup #'+(bg.duplicateCount??'?')+'</td>'
      : '<td class="co fw" style="font-size:9px">⏰ '+(bg.openedAt?dt(bg.openedAt):'—')+'</td>';
    return '<tr>'+
      '<td class="cb fw" style="position:sticky;left:0;background:var(--bg3);font-size:10px">'+bg.symbol+'</td>'+
      '<td>'+tBadge(symType(bg.symbol))+'</td>'+
      '<td>'+btBadge+'</td>'+
      '<td>'+dBadge(bg.direction)+'</td>'+
      '<td>'+vBadge(bg.vwapPosition)+'</td>'+
      '<td>'+sBadge(bg.session)+'</td>'+
      '<td class="cd">'+f2(bg.entry)+'</td>'+
      '<td class="cg fw">'+f2(bg.peakRRPos)+'R</td>'+
      '<td class="cr">'+(bg.peakRRNeg>0?'-'+f1(bg.peakRRNeg)+'% ('+f2(bg.peakRRNeg/100)+'R)':'—')+'</td>'+
      extraCell+
      '<td class="cd" style="font-size:9px">'+dt(bg.openedAt)+'</td>'+
      '<td class="cd">'+msFmt(elapsed)+'</td>'+
      [1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3,0.2,0.1].map(v=>msBgt(rrMs['-'+v.toFixed(1)]||null,false)).join('')+
      (()=>{let s='';for(let v=0.1;v<=15.0+1e-9;v=Math.round((v+0.1)*10)/10){
        const k=v.toFixed(1);
        s+=msBgt(rrMs['+'+k]??rrMs[k]??null,true);
      }return s;})()
    +'</tr>';
  }).join('') : emptyRow(170, 'Geen actieve blocked ghosts'));

  // Laad history voor de 3 types parallel
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
  cron.schedule("*/30 * * * * *", syncPositions);
  cron.schedule("*/5 * * * *",    runShadowSnapshots);
  cron.schedule("0 * * * *",      runTPOptimizer);
  console.log("[PRONTO-AI] Cron jobs active");
}

// Start background init (non-blocking)
initBackground().catch(e => console.error("[FATAL] initBackground:", e.message));
