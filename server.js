"use strict";
// ═══════════════════════════════════════════════════════════════
//  PRONTO-AI  v12.7.1  server.js
//  KEY FIX: app.listen() fires BEFORE any DB/MetaAPI call.
//  The server is always reachable. DB init runs in background.
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

// ── Config ───────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const META_API_TOKEN = process.env.META_API_TOKEN || "";
const META_ACCOUNT   = process.env.META_ACCOUNT   || "";
const META_BASE      = "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";

// ── App state ────────────────────────────────────────────────────
let dbReady          = false;   // true once initDB() succeeds
let openPositions    = new Map();
let tpConfigs        = {};
let symbolRiskMap    = {};
let keyRiskMults     = {};
let liveComplianceDate = COMPLIANCE_DATE;

// Rolling error log (1 h window)
let errorLog = [];
function recordError(msg) {
  const now = Date.now();
  errorLog.push({ ts: now, msg: String(msg) });
  errorLog = errorLog.filter(e => now - e.ts < 3_600_000);
  console.error("[ERR]", msg);
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
  console.log(`[PRONTO-AI] Listening on port ${PORT} — DB init starting…`);
});

// ── Webhook secret check ──────────────────────────────────────────
function checkSecret(req, res) {
  if (!WEBHOOK_SECRET) {
    res.status(503).json({ error: "WEBHOOK_SECRET not configured" });
    return false;
  }
  const provided = req.headers["x-webhook-secret"] || req.body?.secret || req.query?.secret;
  if (provided !== WEBHOOK_SECRET) {
    const ip = req.ip || "?";
    recordError(`Bad webhook secret from ${ip}`);
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ── MetaAPI helpers ───────────────────────────────────────────────
async function metaFetch(path, method = "GET", body = null) {
  const url = `${META_BASE}${path}`;
  const opts = {
    method,
    headers: { "auth-token": META_API_TOKEN, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`MetaAPI ${method} ${path} → ${res.status}`);
  return res.json().catch(() => null);
}

async function getAccountInfo() {
  if (!META_API_TOKEN || !META_ACCOUNT) return null;
  try {
    return await metaFetch(`/users/current/accounts/${META_ACCOUNT}/account-information`);
  } catch (e) { return null; }
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
  for (const r of [1, 2, 3, 5, 10])
    if (rr >= r && !ghost.rrMilestones[r]) ghost.rrMilestones[r] = new Date().toISOString();
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

  if (ghost && dbReady) {
    ghost.closedAt   = now;
    ghost.stopReason = ghost.stopReason ?? reason;
    await db.saveGhostTrade({ ...ghost, maxRRBeforeSL: ghost.maxRR }).catch(e => recordError(e.message));
    db.computeAndSaveGhostComboAnalysis(ghost.optimizerKey).catch(() => {});
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
      realizedPnlEUR: realPnl, hitTP: reason === "tp", closeReason: reason,
      spreadAtEntry: pos.spreadAtEntry, vwapBandPct: pos.vwapBandPct,
      executionPrice: pos.executionPrice, tvEntry: pos.tvEntry, slippage: pos.slippage,
    }).catch(e => recordError(e.message));
    db.deleteGhostState(positionId).catch(() => {});
  }
  console.log(`[Pos] Closed ${positionId} ${pos.symbol} ${pos.direction} reason=${reason} pnl=${realPnl}`);
}

// ── Position sync (cron) ─────────────────────────────────────────
async function syncPositions() {
  if (!isMonitoringActive() || !dbReady) return;
  const live = await getPositions();
  const liveIds = new Set(live.map(p => String(p.id)));
  for (const [id] of openPositions) {
    if (!liveIds.has(id)) await closePosition(id, "manual", null);
  }
  for (const lp of live) {
    const pos = openPositions.get(String(lp.id));
    if (pos?.ghost && lp.currentPrice) {
      updateGhost(pos.ghost, lp.currentPrice);
      if (dbReady) db.saveGhostState(pos.ghost).catch(() => {});
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
    const slDist  = Math.abs(pos.entry - pos.sl);
    if (slDist <= 0) continue;
    const adv     = pos.direction === "buy" ? pos.entry - price : price - pos.entry;
    const pctUsed = Math.max(0, parseFloat(((adv / slDist) * 100).toFixed(2)));
    db.saveShadowSnapshot({ positionId: id, optimizerKey: pos.optimizerKey,
      symbol: pos.symbol, session: pos.session, direction: pos.direction,
      vwapPosition: pos.vwapPosition, entry: pos.entry, sl: pos.sl,
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
      const mul = ev.bestEV > 0 ? Math.min(1.5, 1 + ev.bestEV) : Math.max(0.5, 1 + ev.bestEV);
      keyRiskMults[g.optimizerKey] = { streak: km.streak, evMult: parseFloat(mul.toFixed(4)), dayMult: km.dayMult ?? 1.0 };
      db.saveKeyRiskMult(g.optimizerKey, keyRiskMults[g.optimizerKey]).catch(() => {});
      const existing = tpConfigs[g.optimizerKey];
      if (!existing || g.n >= (existing.lockedGhosts ?? 0) * 2) {
        await db.saveTPConfig(g.optimizerKey, g.symbol, g.session, g.direction,
          g.vwapPosition, ev.bestRR, g.n, ev.bestEV, existing?.lockedRR ?? null).catch(() => {});
        tpConfigs[g.optimizerKey] = { ...existing, lockedRR: ev.bestRR, lockedGhosts: g.n };
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

// ── Health ────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ ok: true, version: "12.7.1", dbReady, ts: new Date().toISOString() });
});

// ── Status (always fast) ──────────────────────────────────────────
app.get("/status", async (req, res) => {
  const base = {
    version:        "12.7.1",
    dbReady,
    openPositions:  openPositions.size,
    complianceDate: liveComplianceDate,
    errorCount:     getErrorCount(),
    ts:             new Date().toISOString(),
  };
  // Account info: try with 2.5 s timeout — never block
  const acct = await Promise.race([
    getAccountInfo(),
    new Promise(r => setTimeout(() => r(null), 2500)),
  ]);
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

  const { symbol: rawSym, direction, sl_pct, vwap, vwap_upper, vwap_upper2,
          vwap_lower, vwap_lower2, close: tvClose } = req.body ?? {};

  const symbol = normalizeSymbol(rawSym);
  if (!symbol) return res.status(400).json({ error: `Unknown symbol: ${rawSym}` });

  const symInfo   = getSymbolInfo(symbol);
  const mt5Sym    = symInfo?.mt5 ?? symbol;
  const assetType = symInfo?.type ?? "forex";

  const { allowed, reason: mktReason } = canOpenNewTrade(symbol);
  if (!allowed) {
    db.logSignal({ symbol, direction, outcome: "REJECTED", rejectReason: mktReason,
      session: getSession(), latencyMs: Date.now() - t0 }).catch(() => {});
    return res.json({ ok: false, reason: mktReason });
  }

  const tvEntry  = tvClose ? parseFloat(tvClose) : null;
  const vwapMid  = vwap    ? parseFloat(vwap)    : null;
  const session  = getSession();
  const vwapPos  = getVwapPosition(tvEntry, vwapMid);
  const optKey   = buildOptimizerKey(symbol, session, direction, vwapPos);
  const slPct    = sl_pct ? parseFloat(sl_pct) : 0.003;

  let equity = 10000;
  const acct = await Promise.race([getAccountInfo(), new Promise(r => setTimeout(() => r(null), 3000))]);
  if (acct?.equity) equity = parseFloat(acct.equity);

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
  const slPrice     = direction === "buy"
    ? parseFloat((execPrice - slDist).toFixed(6))
    : parseFloat((execPrice + slDist).toFixed(6));
  const tpRR        = tpConfigs[optKey]?.lockedRR ?? 2.0;
  const tpPrice     = direction === "buy"
    ? parseFloat((execPrice + slDist * tpRR).toFixed(6))
    : parseFloat((execPrice - slDist * tpRR).toFixed(6));

  let lots;
  const lotNom = slDist > 0 ? riskEUR / slDist : 0.01;
  if (assetType === "forex")     lots = Math.max(0.01, parseFloat((lotNom / 100000).toFixed(2)));
  else if (assetType === "index") lots = Math.max(0.01, parseFloat(lotNom.toFixed(2)));
  else if (assetType === "stock") lots = Math.max(0.01, parseFloat((lotNom / execPrice).toFixed(2)));
  else lots = Math.max(0.01, parseFloat((lotNom / 100).toFixed(2)));

  let tradeNumber = null;
  if (dbReady) tradeNumber = await db.getNextTradeNumber().catch(() => null);

  // Place order
  let positionId;
  try {
    const r  = await placeOrder({
      symbol: mt5Sym,
      actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      volume: lots, stopLoss: slPrice, takeProfit: tpPrice,
      comment: `PRONTO-AI #${tradeNumber ?? "?"}`,
    });
    positionId = r?.positionId ?? r?.orderId ?? String(Date.now());
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
    slippage, spreadAtEntry, vwapBandPct: null, tradeNumber, ghost: null };
  pos.ghost = initGhost({ ...pos, slPct, evMult: km.evMult, dayMult: km.dayMult });
  openPositions.set(positionId, pos);

  if (dbReady) {
    db.saveGhostState(pos.ghost).catch(() => {});
    db.logSignal({ symbol, direction, session, vwapPosition: vwapPos, optimizerKey: optKey,
      tvEntry, slPct, outcome: "PLACED", latencyMs: Date.now() - t0, positionId }).catch(() => {});
    db.logWebhook({ symbol, direction, session, vwapPos, action: "place", status: "OK",
      positionId, entry: execPrice, sl: slPrice, tp: tpPrice, lots, riskPct, optimizerKey: optKey,
      latencyMs: Date.now() - t0, tvEntry, executionPrice: execPrice, slippage }).catch(() => {});
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

apiGet("/api/trades",              () => db.loadAllTrades(),                   []);
apiGet("/api/ghost-trades",        r  => db.loadGhostTrades(r.query.key??null, parseInt(r.query.limit)||200), []);
apiGet("/api/ghost-grouped",       () => db.loadGhostGrouped(),                []);
apiGet("/api/ghost-history-by-pair",() => db.loadGhostHistoryByPair(),         []);
apiGet("/api/ghost-combo-analysis",r  => db.loadGhostComboAnalysis(r.query.key??null), []);
apiGet("/api/shadow-analysis",     () => db.loadAllShadowAnalysis(),           []);
apiGet("/api/shadow-winners",      () => db.loadShadowWinners(),               {});
apiGet("/api/mae-stats",           r  => db.loadMAEStats(r.query.since??null), []);
apiGet("/api/signal-stats",        () => db.loadSignalStats(),                 { total:0, placed:0, conversionPct:0 });
apiGet("/api/signal-rejects",      r  => db.loadSignalRejects({ since: r.query.since }), []);
apiGet("/api/blocked-raw",         r  => db.loadBlockedRaw(r.query.since??null), []);
apiGet("/api/webhook-history",     r  => db.loadWebhookHistory(parseInt(r.query.limit)||100), []);
apiGet("/api/spread-stats",        r  => db.loadSpreadStats(r.query),          []);
apiGet("/api/spread-log",          r  => db.loadSpreadLog({ symbol: r.query.symbol, session: r.query.session, limit: parseInt(r.query.limit)||500 }), []);
apiGet("/api/band-ghosts",         r  => db.loadBandGhosts(r.query),           []);
apiGet("/api/symbol-risk",         () => db.loadSymbolRiskConfig(),            {});

app.get("/api/open-positions", (req, res) => {
  const out = [];
  for (const [id, pos] of openPositions) {
    out.push({ positionId: id, symbol: pos.symbol, direction: pos.direction,
      session: pos.session, vwapPosition: pos.vwapPosition, optimizerKey: pos.optimizerKey,
      entry: pos.entry, sl: pos.sl, tp: pos.tp, lots: pos.lots,
      riskPct: pos.riskPct, riskEUR: pos.riskEUR, openedAt: pos.openedAt,
      tradeNumber: pos.tradeNumber,
      ghost: pos.ghost ? { maxRR: pos.ghost.maxRR, maxSlPctUsed: pos.ghost.maxSlPctUsed,
        peakRRPos: pos.ghost.peakRRPos, peakRRNeg: pos.ghost.peakRRNeg,
        slMilestones: pos.ghost.slMilestones, rrMilestones: pos.ghost.rrMilestones } : null });
  }
  res.json(out);
});

app.get("/api/tp-config", (req, res) => res.json(tpConfigs));

app.get("/api/performance", async (req, res) => {
  const empty = { total: 0, tpCount: 0, slCount: 0, winRate: 0, avgWinner: 0,
    avgLoser: 0, grossWins: 0, grossLosses: 0, profitFactor: null,
    totalPnl: 0, avgPnlPerTrade: 0, maxDrawdown: 0, pnlCurve: [] };
  if (!dbReady) return res.json(empty);
  res.json(await dbCall(db.loadPerformanceSummary(), empty));
});

app.get("/api/daily-breakdown", async (req, res) => {
  const empty = { days: [], maxWinStreak: 0, maxLossStreak: 0, maxDrawdownDay: 0 };
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
//  DASHBOARD HTML  (self-contained — all JS inline)
// ══════════════════════════════════════════════════════════════════
function dashboardHTML() {
return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO-AI v12.7.1</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--sur:#161b22;--bor:#30363d;--tx:#c9d1d9;--mt:#8b949e;
  --gr:#3fb950;--rd:#f85149;--yl:#d29922;--bl:#58a6ff}
body{background:var(--bg);color:var(--tx);font:13px/1.5 'SF Mono',Consolas,monospace;min-height:100vh}
a{color:var(--bl)}
/* header */
header{background:var(--sur);border-bottom:1px solid var(--bor);
  padding:8px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
header h1{font-size:14px;color:var(--bl)}
.chip{padding:2px 8px;border-radius:4px;font-size:11px;background:var(--bor);white-space:nowrap}
.chip.ok {background:#0f2d0f;color:var(--gr);border:1px solid #2a5a2a}
.chip.err{background:#2d0f0f;color:var(--rd);border:1px solid #5a2a2a}
.chip.yl {background:#2d200f;color:var(--yl);border:1px solid #5a4a1a}
#clock{margin-left:auto;color:var(--mt);font-size:11px}
/* banner */
#banner{background:#0d1830;border-bottom:1px solid var(--bor);
  padding:4px 14px;color:var(--mt);font-size:11px}
/* tabs */
nav{display:flex;border-bottom:1px solid var(--bor);overflow-x:auto}
.tab{padding:8px 13px;cursor:pointer;color:var(--mt);white-space:nowrap;
  border-bottom:2px solid transparent;font-size:13px;transition:color .1s}
.tab:hover{color:var(--tx)}
.tab.on{color:var(--bl);border-bottom-color:var(--bl)}
/* panels */
.panel{display:none;padding:14px}
.panel.on{display:block}
/* kpi grid */
.kgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:16px}
.kpi{background:var(--sur);border:1px solid var(--bor);border-radius:6px;padding:10px}
.kl{font-size:10px;color:var(--mt);text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px}
.kv{font-size:20px;font-weight:700}
/* table */
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px;min-width:500px}
th{color:var(--mt);font-weight:400;font-size:10px;text-transform:uppercase;
  padding:5px 8px;border-bottom:1px solid var(--bor);text-align:left;white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid #1c2128;white-space:nowrap}
tr:hover td{background:#1c2128}
/* colors */
.gr{color:var(--gr)}.rd{color:var(--rd)}.yl{color:var(--yl)}.bl{color:var(--bl)}.mt{color:var(--mt)}
/* misc */
h3{font-size:11px;color:var(--mt);text-transform:uppercase;letter-spacing:.4px;margin:14px 0 7px}
.empty{color:var(--mt);padding:30px 0;text-align:center}
.spin{display:inline-block;animation:sp 1s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<header>
  <h1>🤖 PRONTO-AI</h1>
  <span class="chip" id="ver">v12.7.1</span>
  <span class="chip" id="sb"><span class="spin">⟳</span>&nbsp;verbinden…</span>
  <span class="chip yl" id="db-chip" style="display:none">⚠ DB init…</span>
  <span class="chip err" id="err-chip" style="display:none"></span>
  <span id="clock"></span>
</header>
<div id="banner">📅 Data van: laden…</div>

<nav>
  <div class="tab on"  onclick="tab('ov',this)">Overview</div>
  <div class="tab"     onclick="tab('pos',this)">Posities</div>
  <div class="tab"     onclick="tab('tr',this)">Trades</div>
  <div class="tab"     onclick="tab('gh',this)">Ghost</div>
  <div class="tab"     onclick="tab('ev',this)">EV</div>
  <div class="tab"     onclick="tab('sig',this)">Signalen</div>
  <div class="tab"     onclick="tab('spr',this)">Spreads</div>
</nav>

<!-- OVERVIEW -->
<div class="panel on" id="pov">
  <div class="kgrid" id="kg"></div>
  <h3>Dagelijkse P&amp;L</h3>
  <div id="dw" class="tbl-wrap"><div class="empty"><span class="spin">⟳</span></div></div>
</div>

<!-- POSITIES -->
<div class="panel" id="ppos">
  <div id="posw" class="tbl-wrap"><div class="empty"><span class="spin">⟳</span></div></div>
</div>

<!-- TRADES -->
<div class="panel" id="ptr">
  <div id="trw" class="tbl-wrap"><div class="empty"><span class="spin">⟳</span></div></div>
</div>

<!-- GHOST -->
<div class="panel" id="pgh">
  <div id="ghw" class="tbl-wrap"><div class="empty"><span class="spin">⟳</span></div></div>
</div>

<!-- EV -->
<div class="panel" id="pev">
  <div id="evw" class="tbl-wrap"><div class="empty"><span class="spin">⟳</span></div></div>
</div>

<!-- SIGNALEN -->
<div class="panel" id="psig">
  <div class="kgrid" id="sigkg"></div>
  <h3>Webhook History</h3>
  <div id="sigw" class="tbl-wrap"><div class="empty"><span class="spin">⟳</span></div></div>
</div>

<!-- SPREADS -->
<div class="panel" id="pspr">
  <div id="sprw" class="tbl-wrap"><div class="empty"><span class="spin">⟳</span></div></div>
</div>

<script>
'use strict';
// ── utils ────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const n2 = v => v == null ? '—' : (+v).toFixed(2);
const n1 = v => v == null ? '—' : (+v).toFixed(1);
const n0 = v => v == null ? '—' : (+v).toFixed(0);
const eu = v => v == null ? '—' : '€' + (+v).toFixed(2);
const pc = v => v == null ? '—' : (+v).toFixed(1) + '%';
const cc = v => +v >= 0 ? 'gr' : 'rd';
const dt = s => { try { return new Date(s).toLocaleString('nl-BE',{timeZone:'Europe/Brussels',hour12:false,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); } catch { return s||'—'; }};

// ── safe fetch (never throws, always returns null on error) ───────
async function api(url, ms=9000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) throw 0;
    return await r.json();
  } catch { clearTimeout(tid); return null; }
}

// ── tab switching ────────────────────────────────────────────────
const panels = ['ov','pos','tr','gh','ev','sig','spr'];
function tab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
  panels.forEach(p => $('p'+p).classList.remove('on'));
  el.classList.add('on');
  $('p'+name).classList.add('on');
  if (name==='pos') loadPos();
  if (name==='tr')  loadTr();
  if (name==='gh')  loadGh();
  if (name==='ev')  loadEV();
  if (name==='sig') loadSig();
  if (name==='spr') loadSpr();
}

// ── clock ────────────────────────────────────────────────────────
setInterval(() => {
  try { $('clock').textContent = new Date().toLocaleString('nl-BE',{timeZone:'Europe/Brussels',hour12:false}); } catch{}
}, 1000);

// ── status ───────────────────────────────────────────────────────
async function pollStatus() {
  const d = await api('/status', 5000);
  const sb = $('sb');
  if (!d) { sb.textContent = '✖ offline'; sb.className = 'chip err'; return; }
  const eq = d.account?.equity;
  sb.textContent = (eq != null ? '€'+n0(eq)+' | ' : '') + (d.openPositions||0) + ' pos';
  sb.className = 'chip ok';
  if (d.complianceDate) $('banner').textContent = '📅 Data vanaf: ' + d.complianceDate + ' UTC';
  // DB status chip
  const dc = $('db-chip');
  dc.style.display = d.dbReady ? 'none' : '';
  // Error chip
  const ec = $('err-chip');
  if ((d.errorCount||0) > 0) { ec.textContent = '⚠ ' + d.errorCount + ' fout(en)/1u'; ec.style.display=''; }
  else ec.style.display = 'none';
}

// ── kpi box ──────────────────────────────────────────────────────
const kpi = (l,v,c='') => '<div class="kpi"><div class="kl">'+l+'</div><div class="kv '+c+'">'+v+'</div></div>';

// ── overview ─────────────────────────────────────────────────────
async function loadOv() {
  // Show skeleton immediately
  $('kg').innerHTML = ['Trades','Win Rate','Profit Factor','Totaal PnL',
    'Gem. Winner','Gem. Loser','Max DD','TP','SL'].map(l=>kpi(l,'…','mt')).join('');

  const [p, d] = await Promise.all([api('/api/performance'), api('/api/daily-breakdown')]);

  // KPIs
  const perf = p || {};
  const tot  = parseInt(perf.total)||0;
  if (!tot) {
    $('kg').innerHTML = kpi('Systeem','✓ Online','gr') + kpi('Trades','0 nog','mt');
  } else {
    $('kg').innerHTML = [
      kpi('Trades',       n0(perf.total),                                  ''),
      kpi('Win Rate',     pc(perf.winRate),                                (perf.winRate||0)>=50?'gr':'rd'),
      kpi('Profit Factor',perf.profitFactor!=null?n2(perf.profitFactor):'—',(perf.profitFactor||0)>=1?'gr':'rd'),
      kpi('Totaal PnL',   eu(perf.totalPnl),                               cc(perf.totalPnl||0)),
      kpi('Gem. Winner',  eu(perf.avgWinner),                              'gr'),
      kpi('Gem. Loser',   eu(perf.avgLoser),                               'rd'),
      kpi('Max Drawdown', eu(perf.maxDrawdown),                            'rd'),
      kpi('TP',           n0(perf.tpCount),                                'gr'),
      kpi('SL',           n0(perf.slCount),                                'rd'),
    ].join('');
  }

  // Daily table
  const days = d?.days || [];
  if (!days.length) { $('dw').innerHTML = '<div class="empty">Geen dagdata</div>'; return; }
  $('dw').innerHTML = '<table><thead><tr>'+
    '<th>Datum</th><th>Trades</th><th>W</th><th>L</th><th>PnL</th><th>Cum</th><th>Gem RR</th>'+
    '</tr></thead><tbody>'+
    days.slice(0,30).map(r =>
      '<tr>'+
      '<td class="mt">'+(r.trade_date||'—')+'</td>'+
      '<td>'+(r.trades||0)+'</td>'+
      '<td class="gr">'+(r.wins||0)+'</td>'+
      '<td class="rd">'+(r.losses||0)+'</td>'+
      '<td class="'+cc(r.day_pnl||0)+'">'+eu(r.day_pnl)+'</td>'+
      '<td class="'+cc(r.cum_pnl||0)+'">'+eu(r.cum_pnl)+'</td>'+
      '<td>'+n2(r.avg_rr)+'</td>'+
      '</tr>'
    ).join('') + '</tbody></table>';
}

// ── posities ─────────────────────────────────────────────────────
async function loadPos() {
  $('posw').innerHTML = '<div class="empty"><span class="spin">⟳</span></div>';
  const d = await api('/api/open-positions') || [];
  if (!d.length) { $('posw').innerHTML = '<div class="empty">Geen open posities</div>'; return; }
  $('posw').innerHTML = '<table><thead><tr>'+
    '<th>#</th><th>Symbol</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP</th>'+
    '<th>Lots</th><th>Risk</th><th>MaxRR</th><th>SL%</th><th>Open</th>'+
    '</tr></thead><tbody>'+
    d.map(p => '<tr>'+
      '<td class="mt">'+(p.tradeNumber||'—')+'</td>'+
      '<td class="bl">'+p.symbol+'</td>'+
      '<td class="'+(p.direction==='buy'?'gr':'rd')+'">'+p.direction+'</td>'+
      '<td>'+n2(p.entry)+'</td>'+
      '<td class="rd">'+n2(p.sl)+'</td>'+
      '<td class="gr">'+n2(p.tp)+'</td>'+
      '<td>'+n2(p.lots)+'</td>'+
      '<td>'+eu(p.riskEUR)+'</td>'+
      '<td class="'+(+(p.ghost?.maxRR||0)>0?'gr':'')+'">'+n2(p.ghost?.maxRR)+'</td>'+
      '<td>'+n1(p.ghost?.maxSlPctUsed)+'%</td>'+
      '<td class="mt">'+dt(p.openedAt)+'</td>'+
      '</tr>'
    ).join('') + '</tbody></table>';
}

// ── trades ───────────────────────────────────────────────────────
async function loadTr() {
  $('trw').innerHTML = '<div class="empty"><span class="spin">⟳</span></div>';
  const d = await api('/api/trades') || [];
  if (!d.length) { $('trw').innerHTML = '<div class="empty">Geen gesloten trades</div>'; return; }
  $('trw').innerHTML = '<table><thead><tr>'+
    '<th>#</th><th>Symbol</th><th>Dir</th><th>Uitkomst</th><th>PnL</th>'+
    '<th>MaxRR</th><th>Lots</th><th>Sessie</th><th>Gesloten</th>'+
    '</tr></thead><tbody>'+
    d.slice(0,200).map((t,i) => '<tr>'+
      '<td class="mt">'+(d.length-i)+'</td>'+
      '<td class="bl">'+t.symbol+'</td>'+
      '<td class="'+(t.direction==='buy'?'gr':'rd')+'">'+t.direction+'</td>'+
      '<td class="'+(t.hitTP?'gr':'rd')+'">'+(t.hitTP?'TP':'SL')+' <span class="mt">('+( t.closeReason||'?')+')</span></td>'+
      '<td class="'+cc(t.realizedPnlEUR||0)+'">'+eu(t.realizedPnlEUR)+'</td>'+
      '<td>'+n2(t.maxRR)+'</td>'+
      '<td>'+n2(t.lots)+'</td>'+
      '<td class="mt">'+(t.session||'—')+'</td>'+
      '<td class="mt">'+dt(t.closedAt)+'</td>'+
      '</tr>'
    ).join('') + '</tbody></table>';
}

// ── ghost ────────────────────────────────────────────────────────
async function loadGh() {
  $('ghw').innerHTML = '<div class="empty"><span class="spin">⟳</span></div>';
  const d = await api('/api/ghost-grouped') || [];
  if (!d.length) { $('ghw').innerHTML = '<div class="empty">Nog geen ghost data</div>'; return; }
  $('ghw').innerHTML = '<table><thead><tr>'+
    '<th>Key</th><th>N</th><th>SL Hits</th><th>Gem MaxRR</th><th>Best MaxRR</th><th>Gem SL%</th><th>Laatste</th>'+
    '</tr></thead><tbody>'+
    d.map(g => '<tr>'+
      '<td class="bl">'+(g.optimizerKey||'—')+'</td>'+
      '<td>'+(g.n||0)+'</td>'+
      '<td class="rd">'+(g.slHits||0)+'</td>'+
      '<td>'+n2(g.avgMaxRR)+'</td>'+
      '<td class="gr">'+n2(g.bestMaxRR)+'</td>'+
      '<td>'+n1(g.avgSlPct)+'%</td>'+
      '<td class="mt">'+dt(g.lastOpened)+'</td>'+
      '</tr>'
    ).join('') + '</tbody></table>';
}

// ── ev optimizer ─────────────────────────────────────────────────
async function loadEV() {
  $('evw').innerHTML = '<div class="empty"><span class="spin">⟳</span></div>';
  const [g, tp, combo] = await Promise.all([
    api('/api/ghost-grouped'), api('/api/tp-config'), api('/api/ghost-combo-analysis')
  ]);
  const rows  = (g||[]).filter(r => (r.n||0)>=5);
  const tpMap = tp || {};
  const cmap  = {};
  (combo||[]).forEach(c => cmap[c.optimizerKey]=c);
  if (!rows.length) { $('evw').innerHTML = '<div class="empty">Nog geen EV data (min. 5 ghost trades)</div>'; return; }
  $('evw').innerHTML = '<table><thead><tr>'+
    '<th>Key</th><th>N</th><th>Locked TP</th><th>Best EV</th><th>Win Rate</th><th>Gem RR</th>'+
    '</tr></thead><tbody>'+
    rows.map(r => {
      const c = cmap[r.optimizerKey]; const t = tpMap[r.optimizerKey];
      return '<tr>'+
        '<td class="bl">'+(r.optimizerKey||'—')+'</td>'+
        '<td>'+(r.n||0)+'</td>'+
        '<td class="'+((t?.lockedRR||0)>=2?'gr':'yl')+'">'+(t?.lockedRR!=null?t.lockedRR+'R':'—')+'</td>'+
        '<td class="'+((c?.evScore||0)>0?'gr':'rd')+'">'+(c?.evScore!=null?n2(c.evScore):'—')+'</td>'+
        '<td>'+(c?.winRate!=null?pc(c.winRate):'—')+'</td>'+
        '<td>'+n2(r.avgMaxRR)+'</td>'+
        '</tr>';
    }).join('') + '</tbody></table>';
}

// ── signalen ─────────────────────────────────────────────────────
async function loadSig() {
  $('sigw').innerHTML = '<div class="empty"><span class="spin">⟳</span></div>';
  const [stats, hist] = await Promise.all([
    api('/api/signal-stats'), api('/api/webhook-history?limit=50')
  ]);
  const s = stats||{};
  $('sigkg').innerHTML = [
    kpi('Signalen',  n0(s.total),          ''),
    kpi('Geplaatst', n0(s.placed),         'gr'),
    kpi('Conversie', pc(s.conversionPct),  (s.conversionPct||0)>=15?'gr':'yl'),
  ].join('');
  const h = hist||[];
  if (!h.length) { $('sigw').innerHTML = '<div class="empty">Geen webhook history</div>'; return; }
  $('sigw').innerHTML = '<table><thead><tr>'+
    '<th>Tijd</th><th>Symbol</th><th>Dir</th><th>Status</th><th>Reden</th><th>Latency</th>'+
    '</tr></thead><tbody>'+
    h.map(r => '<tr>'+
      '<td class="mt">'+dt(r.ts)+'</td>'+
      '<td class="bl">'+(r.symbol||'—')+'</td>'+
      '<td class="'+(r.direction==='buy'?'gr':'rd')+'">'+(r.direction||'—')+'</td>'+
      '<td class="'+(r.status==='OK'?'gr':'rd')+'">'+(r.status||'—')+'</td>'+
      '<td class="mt">'+(r.reason||'')+'</td>'+
      '<td>'+(r.latency_ms!=null?r.latency_ms+'ms':'—')+'</td>'+
      '</tr>'
    ).join('') + '</tbody></table>';
}

// ── spreads ──────────────────────────────────────────────────────
async function loadSpr() {
  $('sprw').innerHTML = '<div class="empty"><span class="spin">⟳</span></div>';
  const d = await api('/api/spread-stats') || [];
  if (!d.length) { $('sprw').innerHTML = '<div class="empty">Geen spread data</div>'; return; }
  $('sprw').innerHTML = '<table><thead><tr>'+
    '<th>Symbol</th><th>Sessie</th><th>Uur</th><th>N</th><th>Gem</th><th>P50</th><th>P90</th><th>Max</th>'+
    '</tr></thead><tbody>'+
    d.slice(0,100).map(r => '<tr>'+
      '<td class="bl">'+(r.symbol||'—')+'</td>'+
      '<td>'+(r.session||'—')+'</td>'+
      '<td>'+(r.hour_brussels!=null?r.hour_brussels+':00':'—')+'</td>'+
      '<td class="mt">'+(r.samples||0)+'</td>'+
      '<td>'+(r.avg_spread_abs!=null?(+r.avg_spread_abs).toFixed(6):'—')+'</td>'+
      '<td>'+(r.p50_spread!=null?(+r.p50_spread).toFixed(6):'—')+'</td>'+
      '<td>'+(r.p90_spread!=null?(+r.p90_spread).toFixed(6):'—')+'</td>'+
      '<td class="rd">'+(r.max_spread!=null?(+r.max_spread).toFixed(6):'—')+'</td>'+
      '</tr>'
    ).join('') + '</tbody></table>';
}

// ── boot ────────────────────────────────────────────────────────
// Fire everything in parallel — no sequential awaits
pollStatus();
loadOv();

setInterval(pollStatus, 15000);
setInterval(loadOv,     60000);
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
      const ghost = { ...gs, maxPrice: gs.maxPrice??gs.entry, maxRR: gs.maxRR??0,
        maxSlPctUsed: gs.maxSlPctUsed??0, slMilestones: gs.slMilestones??{},
        rrMilestones: gs.rrMilestones??{}, phantomSLHit: false, stopReason: null, closedAt: null };
      openPositions.set(gs.positionId, {
        positionId: gs.positionId, symbol: gs.symbol, mt5Symbol: gs.mt5Symbol??gs.symbol,
        direction: gs.direction, vwapPosition: gs.vwapPosition,
        session: gs.session, entry: gs.entry, sl: gs.sl, tp: null, lots: null,
        riskPct: gs.riskPct, riskEUR: gs.riskEUR, openedAt: gs.openedAt,
        optimizerKey: gs.optimizerKey, ghost });
    }
    console.log(`[DB] Restored ${openPositions.size} open positions`);
  } catch (e) { console.error("[DB] restorePositions failed:", e.message); }

  // Sync trade number sequence
  db.syncTradeNumberSequence().catch(() => {});

  // Mark DB as ready
  dbReady = true;
  console.log("[PRONTO-AI] ✅ DB ready — all systems operational");

  // Start cron jobs
  cron.schedule("*/30 * * * * *", syncPositions);
  cron.schedule("*/5 * * * *",    runShadowSnapshots);
  cron.schedule("0 * * * *",      runTPOptimizer);
  console.log("[PRONTO-AI] Cron jobs active");
}

// Start background init (non-blocking)
initBackground().catch(e => console.error("[FATAL] initBackground:", e.message));
