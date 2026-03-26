// ═══════════════════════════════════════════════════════════════
// TradingView → MetaApi → MT5  |  FTMO Webhook Server v2
// Account: Nick Verschoot FTMO Demo
// MetaApi ID: 7cb566c1-be02-415b-ab95-495368f3885c
// ─────────────────────────────────────────────────────────────
// TradingView symbolen (OANDA feed) → FTMO MT5 mapping:
//
//  TradingView        FTMO MT5
//  ─────────────────────────────────────────────────────────────
//  DE30EUR      →     GER40.cash
//  UK100GBP     →     UK100.cash
//  NAS100USD    →     US100.cash
//  US30USD      →     US30.cash
//  SPX500USD    →     US500.cash
//  JP225USD     →     JP225.cash
//  AU200AUD     →     AUS200.cash
//  EU50EUR      →     EU50.cash
//  FR40EUR      →     FRA40.cash
//  XAUUSD       →     XAUUSD        (gold — zelfde)
//  BTCUSD       →     BTCUSD        (zelfde)
//  ETHUSD       →     ETHUSD        (zelfde)
//  AAPL         →     AAPL          (zelfde)
//  TSLA         →     TSLA          (zelfde)
//  NVDA         →     NVDA          (zelfde)
//  MSFT         →     MSFT          (zelfde)
//  PLTR         →     PLTR          (zelfde)
//  AMZN         →     AMZN          (zelfde)
// ─────────────────────────────────────────────────────────────
// FTMO REGELS INGEBOUWD:
//  ✅ 5% dagelijks verlies guard → orders geblokkeerd
//  ✅ Weekend auto-close (vrijdag 22:50 CET) — ALLES
//  ✅ Geen weekend orders (ook geen crypto)
//  ✅ Self-healing symbool/lot errors
//  ✅ Anti-consolidation risk halving
//  ✅ Max profit tracker + what-if RR analyse
//  ✅ Equity curve snapshots (30s)
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const app = express();
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────
const META_API_TOKEN  = process.env.META_API_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || "FtmoNV2025";

// Pas ACCOUNT_BALANCE aan via env var als je challenge account grootte verandert
// Free Trial = €10.000 | Challenge €25k/50k/100k/200k
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || "10000");

// ── FIXED RISK IN EUR ─────────────────────────────────────────
// Normaal risico per trade : €25 (harde cap)
// Min-lot fallback cap     : €50 — enkel wanneer SL zo groot is dat
//                            zelfs 1 min-lot meer kost dan €25
//                            → dan accepteren we tot €50, anders skip
// MIN SL + risk-per-min-lot berekening volgt later
const RISK_EUR_BASE   = parseFloat(process.env.RISK_EUR_BASE   || "25"); // target + cap normaal
const RISK_EUR_MAX    = parseFloat(process.env.RISK_EUR_MAX    || "25"); // cap normaal €25
const RISK_EUR_MINLOT = parseFloat(process.env.RISK_EUR_MINLOT || "50"); // cap bij min-lot fallback

// ── FTMO DRAWDOWN GUARDS ──────────────────────────────────────
const FTMO_DAILY_LOSS_PCT = 0.05;  // 5% dagelijks verlies limiet
const FTMO_TOTAL_LOSS_PCT = 0.10;  // 10% totaal verlies limiet
let   ftmoDailyLossUsed   = 0;
let   ftmoStartBalance     = ACCOUNT_BALANCE;
let   ftmoLastDayReset     = new Date().toDateString();

function resetDailyLossIfNewDay() {
  const today = new Date().toDateString();
  if (today !== ftmoLastDayReset) {
    console.log(`🔄 Nieuwe dag — dagelijks verlies reset (was €${ftmoDailyLossUsed.toFixed(2)})`);
    ftmoDailyLossUsed = 0;
    ftmoLastDayReset  = today;
  }
}

function ftmoSafetyCheck(riskEUR) {
  resetDailyLossIfNewDay();
  const dailyLimit = ftmoStartBalance * FTMO_DAILY_LOSS_PCT;
  if (ftmoDailyLossUsed + riskEUR > dailyLimit) {
    return {
      ok: false,
      reason: `🚫 FTMO dagelijkse verliesgrens: €${ftmoDailyLossUsed.toFixed(2)} gebruikt van €${dailyLimit.toFixed(2)} — order geweigerd`,
    };
  }
  return { ok: true };
}

function registerFtmoLoss(riskEUR) {
  ftmoDailyLossUsed += riskEUR;
  console.log(`📉 FTMO dagelijks verlies bijgewerkt: €${ftmoDailyLossUsed.toFixed(2)}`);
}

// ── IN-MEMORY STORES ──────────────────────────────────────────
const openTradeTracker = {};
const openPositions    = {};
const closedTrades     = [];
const accountSnapshots = [];
const webhookHistory   = [];
const MAX_SNAPSHOTS    = 86400;
const MAX_HISTORY      = 200;

function addWebhookHistory(entry) {
  webhookHistory.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookHistory.length > MAX_HISTORY) webhookHistory.length = MAX_HISTORY;
}

// ── LEARNED PATCHES ───────────────────────────────────────────
const learnedPatches = {};

// ══════════════════════════════════════════════════════════════
// SYMBOL MAP — TradingView (OANDA feed) → FTMO MT5
// ══════════════════════════════════════════════════════════════
const SYMBOL_MAP = {

  // ── INDICES: OANDA namen → FTMO .cash namen ───────────────────
  "DE30EUR":    { mt5: "GER40.cash",  type: "index"  },
  "UK100GBP":   { mt5: "UK100.cash",  type: "index"  },
  "NAS100USD":  { mt5: "US100.cash",  type: "index"  },
  "US30USD":    { mt5: "US30.cash",   type: "index"  },
  "SPX500USD":  { mt5: "US500.cash",  type: "index"  },
  "JP225USD":   { mt5: "JP225.cash",  type: "index"  },
  "AU200AUD":   { mt5: "AUS200.cash", type: "index"  },
  "EU50EUR":    { mt5: "EU50.cash",   type: "index"  },
  "FR40EUR":    { mt5: "FRA40.cash",  type: "index"  },

  // Extra aliassen (voor als chart op andere feed staat)
  "GER40":      { mt5: "GER40.cash",  type: "index"  },
  "GER40.cash": { mt5: "GER40.cash",  type: "index"  },
  "UK100":      { mt5: "UK100.cash",  type: "index"  },
  "UK100.cash": { mt5: "UK100.cash",  type: "index"  },
  "NAS100":     { mt5: "US100.cash",  type: "index"  },
  "US100":      { mt5: "US100.cash",  type: "index"  },
  "US100.cash": { mt5: "US100.cash",  type: "index"  },
  "US30":       { mt5: "US30.cash",   type: "index"  },
  "US30.cash":  { mt5: "US30.cash",   type: "index"  },
  "SPX500":     { mt5: "US500.cash",  type: "index"  },
  "US500":      { mt5: "US500.cash",  type: "index"  },
  "US500.cash": { mt5: "US500.cash",  type: "index"  },
  "JP225":      { mt5: "JP225.cash",  type: "index"  },
  "JP225.cash": { mt5: "JP225.cash",  type: "index"  },
  "AU200":      { mt5: "AUS200.cash", type: "index"  },
  "AUS200":     { mt5: "AUS200.cash", type: "index"  },
  "AUS200.cash":{ mt5: "AUS200.cash", type: "index"  },
  "EU50":       { mt5: "EU50.cash",   type: "index"  },
  "EU50.cash":  { mt5: "EU50.cash",   type: "index"  },
  "FR40":       { mt5: "FRA40.cash",  type: "index"  },
  "FRA40":      { mt5: "FRA40.cash",  type: "index"  },
  "FRA40.cash": { mt5: "FRA40.cash",  type: "index"  },

  // ── GOLD ──────────────────────────────────────────────────────
  "XAUUSD":     { mt5: "XAUUSD",      type: "gold"   },
  "GOLD":       { mt5: "XAUUSD",      type: "gold"   },

  // ── COMMODITIES ───────────────────────────────────────────────
  "UKOIL":      { mt5: "UKOIL.cash",  type: "brent"  },
  "UKOIL.cash": { mt5: "UKOIL.cash",  type: "brent"  },
  "USOIL":      { mt5: "USOIL.cash",  type: "wti"    },
  "USOIL.cash": { mt5: "USOIL.cash",  type: "wti"    },

  // ── CRYPTO (24/5 op werkdagen bij FTMO) ──────────────────────
  "BTCUSD":     { mt5: "BTCUSD",      type: "crypto" },
  "ETHUSD":     { mt5: "ETHUSD",      type: "crypto" },

  // ── US STOCKS (FTMO: geen suffix nodig) ───────────────────────
  "AAPL":       { mt5: "AAPL",        type: "stock"  },
  "TSLA":       { mt5: "TSLA",        type: "stock"  },
  "NVDA":       { mt5: "NVDA",        type: "stock"  },
  "MSFT":       { mt5: "MSFT",        type: "stock"  },
  "PLTR":       { mt5: "PLTR",        type: "stock"  },
  "AMZN":       { mt5: "AMZN",        type: "stock"  },
  "AMD":        { mt5: "AMD",         type: "stock"  },
};

// ── LOT VALUE PER PUNT PER LOT (EUR) ─────────────────────────
// !! Verifieer in MT5 → rechtermuisknop op symbool → Specificaties !!
const LOT_VALUE = {
  "index":  20.00,  // indices CFD: €20/punt/lot
  "gold":   10.00,  // XAUUSD: €10/punt/lot (1 lot = 100oz)
  "brent":  10.00,  // UKOIL: €10/punt/lot
  "wti":    10.00,  // USOIL: €10/punt/lot
  "crypto":  1.00,  // variabel
  "stock":   1.00,  // 1 lot = 1 share
};

// ── MIN STOP DISTANCE ─────────────────────────────────────────
const MIN_STOP = {
  "GER40.cash":    5.0,
  "UK100.cash":    5.0,
  "US100.cash":    5.0,
  "US30.cash":     5.0,
  "US500.cash":    2.0,
  "JP225.cash":   10.0,
  "AUS200.cash":   3.0,
  "EU50.cash":     5.0,
  "FRA40.cash":    5.0,
  "XAUUSD":        0.5,
  "UKOIL.cash":    0.05,
  "USOIL.cash":    0.05,
  "BTCUSD":      100.0,
  "ETHUSD":        5.0,
  "default_stock": 0.5,
};

// ── MAX LOTS ──────────────────────────────────────────────────
const MAX_LOTS = {
  "index":   5.0,
  "gold":    2.0,
  "brent":   5.0,
  "wti":     5.0,
  "crypto":  1.0,
  "stock":  50.0,
};

// ── SYMBOL HELPERS ────────────────────────────────────────────
function getMT5Symbol(symbol) {
  if (learnedPatches[symbol]?.mt5Override) return learnedPatches[symbol].mt5Override;
  if (SYMBOL_MAP[symbol]) return SYMBOL_MAP[symbol].mt5;
  return symbol; // geef onbekende symbolen ongewijzigd terug
}

function getSymbolType(symbol) {
  if (SYMBOL_MAP[symbol]) return SYMBOL_MAP[symbol].type;
  if (["BTC","ETH"].some(c => symbol.startsWith(c))) return "crypto";
  return "stock";
}

// ── MARKET HOURS (CET) ────────────────────────────────────────
function getCETTime() {
  const now   = new Date();
  const month = now.getUTCMonth() + 1;
  const dst   = (month > 3 && month < 10) ||
    (month === 3 && now.getUTCDate() >= 25) ||
    (month === 10 && now.getUTCDate() < 25);
  return new Date(now.getTime() + (dst ? 2 : 1) * 3600 * 1000);
}

function isCETMarketOpen(type) {
  const cet       = getCETTime();
  const dayOfWeek = cet.getUTCDay();
  const timeHHMM  = cet.getUTCHours() * 100 + cet.getUTCMinutes();

  // FTMO: GEEN weekend trading — ook geen crypto
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.warn(`🚫 FTMO: geen weekend trading (dag ${dayOfWeek})`);
    return false;
  }

  if (type === "crypto") return true; // crypto: ma–vr doorlopend

  if (type === "stock") {
    return timeHHMM >= 1530 && timeHHMM < 2200; // US stocks 15:30–22:00 CET
  }

  // Indices / gold / olie: sluit vrijdag 22:50
  if (dayOfWeek === 5 && timeHHMM >= 2250) return false;
  return true;
}

// ── FRIDAY AUTO-CLOSE ─────────────────────────────────────────
async function checkFridayClose() {
  const cet       = getCETTime();
  const dayOfWeek = cet.getUTCDay();
  const hour      = cet.getUTCHours();
  const minute    = cet.getUTCMinutes();

  if (dayOfWeek === 5 && hour === 22 && minute === 50) {
    console.log("🔔 Vrijdag 22:50 CET — FTMO: sluit ALLE posities voor weekend...");
    try {
      const positions = await fetchOpenPositions();
      for (const pos of (positions || [])) {
        await closePosition(pos.id);
        console.log(`🔒 Weekend-close: ${pos.symbol}`);
      }
    } catch (e) {
      console.error("❌ Weekend auto-close fout:", e.message);
    }
  }
}
setInterval(checkFridayClose, 60 * 1000);

// ── CLOSE POSITION ────────────────────────────────────────────
async function closePosition(positionId) {
  const url = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT_ID}/positions/${positionId}/close`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "auth-token": META_API_TOKEN },
  });
  const data = await res.json();
  console.log(`🔒 Positie ${positionId} gesloten:`, JSON.stringify(data));
  return data;
}

// ── ANTI-CONSOLIDATION ────────────────────────────────────────
function getEffectiveRisk(symbol, direction) {
  const key   = `${symbol}_${direction}`;
  const count = openTradeTracker[key] || 0;
  return Math.max(1, RISK_EUR_BASE / Math.pow(2, count));
}

function incrementTradeTracker(symbol, direction) {
  const key = `${symbol}_${direction}`;
  openTradeTracker[key] = (openTradeTracker[key] || 0) + 1;
}

function decrementTradeTracker(symbol, direction) {
  const key = `${symbol}_${direction}`;
  if (openTradeTracker[key] > 0) openTradeTracker[key]--;
}

// ── LOT BEREKENING ────────────────────────────────────────────
function calcLots(symbol, entry, sl, effectiveRisk) {
  const type     = getSymbolType(symbol);
  const lotValue = LOT_VALUE[type] || 1.0;
  const maxLots  = MAX_LOTS[type]  || 50.0;
  const lotStep  = learnedPatches[symbol]?.lotStepOverride || (type === "stock" ? 1 : 0.01);
  const slDist   = Math.abs(entry - sl);
  if (slDist <= 0) return lotStep;

  let lots = effectiveRisk / (slDist * lotValue);

  if (type === "stock") {
    lots = Math.floor(lots);
    if (lots < 1) {
      const riskWith1 = 1 * slDist * lotValue;
      if (riskWith1 <= RISK_EUR_MINLOT) {
        console.log(`⬆️ 1 share (min-lot fallback) = €${riskWith1.toFixed(2)} ≤ €${RISK_EUR_MINLOT.toFixed(2)} — doorgaan`);
        lots = 1;
      } else {
        console.warn(`❌ 1 share = €${riskWith1.toFixed(2)} > €${RISK_EUR_MINLOT.toFixed(2)} — geannuleerd`);
        return null;
      }
    }
    lots = Math.min(maxLots, lots);
  } else {
    lots = Math.round(lots / lotStep) * lotStep;
    lots = parseFloat(lots.toFixed(2));
    if (lots < lotStep) {
      const riskWithMin = lotStep * slDist * lotValue;
      if (riskWithMin <= RISK_EUR_MINLOT) {
        console.log(`⬆️ Min-lot fallback: SL groot, €${riskWithMin.toFixed(2)} ≤ €${RISK_EUR_MINLOT.toFixed(2)} — doorgaan op 1 min-lot`);
        lots = lotStep;
      } else {
        console.warn(`❌ Min lot = €${riskWithMin.toFixed(2)} > €${RISK_EUR_MINLOT.toFixed(2)} (max min-lot cap) — geannuleerd`);
        return null;
      }
    }
    lots = Math.min(maxLots, lots);
  }

  const actualRisk = lots * slDist * lotValue;
  console.log(`💶 Risico: ${lots} lots × ${slDist.toFixed(4)} pts × €${lotValue} = €${actualRisk.toFixed(2)}`);
  return lots;
}

// ── SL VALIDATIE ──────────────────────────────────────────────
function validateSL(direction, entry, sl, mt5Symbol) {
  const minDist = MIN_STOP[mt5Symbol] || MIN_STOP["default_stock"] || 0.01;
  const slDist  = Math.abs(entry - sl);
  if (slDist < minDist) {
    const adjusted = direction === "buy" ? entry - minDist : entry + minDist;
    console.warn(`⚠️ SL te dicht (${slDist} < ${minDist}) → aangepast naar ${adjusted}`);
    return adjusted;
  }
  return sl;
}

// ── ORDER PLAATSEN ────────────────────────────────────────────
async function placeOrder(direction, symbol, entry, sl, lots) {
  const mt5Symbol = getMT5Symbol(symbol);
  const orderType = direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";
  const slPrice   = validateSL(direction, parseFloat(entry), parseFloat(sl), mt5Symbol);

  const body = {
    symbol:     mt5Symbol,
    volume:     lots,
    actionType: orderType,
    stopLoss:   slPrice,
    comment:    `FTMO-NV-${direction.toUpperCase()}-${symbol}`,
  };

  const url = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT_ID}/trade`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "auth-token": META_API_TOKEN },
    body:    JSON.stringify(body),
  });

  const result = await res.json();
  return { result, mt5Symbol, slPrice, body };
}

// ── SELF-HEALING ──────────────────────────────────────────────
function learnFromError(symbol, errorCode, errorMessage, requestBody) {
  const msg = (errorMessage || "").toLowerCase();
  if (!learnedPatches[symbol]) learnedPatches[symbol] = {};

  if (errorCode === "TRADE_RETCODE_INVALID" && msg.includes("symbol")) {
    const current   = getMT5Symbol(symbol);
    const fallbacks = [
      current.replace(".cash", ""),
      current + ".cash",
      current + ".US",
      current.replace(".US", ""),
    ].filter(s => s !== current);
    const alreadyTried = learnedPatches[symbol]._triedMt5 || [];
    const next = fallbacks.find(f => !alreadyTried.includes(f));
    if (next) {
      learnedPatches[symbol].mt5Override = next;
      learnedPatches[symbol]._triedMt5 = [...alreadyTried, next];
      console.log(`🧠 LEARN: ${symbol} → probeer "${next}"`);
    }
  }

  if (msg.includes("volume") || msg.includes("lot")) {
    const cur = learnedPatches[symbol]?.lotStepOverride || 0.01;
    learnedPatches[symbol].lotStepOverride = cur * 10;
    console.log(`🧠 LEARN: ${symbol} lot step → ${learnedPatches[symbol].lotStepOverride}`);
  }

  if (msg.includes("stop") || errorCode === "TRADE_RETCODE_INVALID_STOPS") {
    const mt5Sym = getMT5Symbol(symbol);
    MIN_STOP[mt5Sym] = (MIN_STOP[mt5Sym] || 0.01) * 2;
    console.log(`🧠 LEARN: Min stop ${mt5Sym} → ${MIN_STOP[mt5Sym]}`);
  }

  console.log("🔧 Patches:", JSON.stringify(learnedPatches));
}

// ── WHAT-IF RR ────────────────────────────────────────────────
function calcWhatIfRR(trade) {
  const { direction, entry, sl, lots, maxPrice, symbol } = trade;
  const slDist   = Math.abs(entry - sl);
  const lotValue = LOT_VALUE[getSymbolType(symbol)] || 1.0;
  const results  = {};
  for (const rr of [2, 3, 4]) {
    const tpDist    = slDist * rr;
    const tp        = direction === "buy" ? entry + tpDist : entry - tpDist;
    const potential = lots * tpDist * lotValue;
    const wouldHit  = direction === "buy" ? maxPrice >= tp : maxPrice <= tp;
    results[`${rr}:1`] = {
      tp: parseFloat(tp.toFixed(5)),
      potential: parseFloat(potential.toFixed(2)),
      wouldHit,
    };
  }
  return results;
}

// ── METAAPI HELPERS ───────────────────────────────────────────
const META_BASE = `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT_ID}`;

async function fetchOpenPositions() {
  const res = await fetch(`${META_BASE}/positions`, { headers: { "auth-token": META_API_TOKEN } });
  if (!res.ok) throw new Error(`MetaApi positions ${res.status}`);
  return res.json();
}

async function fetchAccountInfo() {
  const res = await fetch(`${META_BASE}/accountInformation`, { headers: { "auth-token": META_API_TOKEN } });
  if (!res.ok) throw new Error(`MetaApi accountInfo ${res.status}`);
  return res.json();
}

// ── POSITION SYNC (30s) ───────────────────────────────────────
async function syncPositions() {
  try {
    const livePositions = await fetchOpenPositions();
    const liveIds = new Set((livePositions || []).map(p => String(p.id)));

    for (const pos of (livePositions || [])) {
      const id = String(pos.id);
      if (!openPositions[id]) continue;
      const cur   = pos.currentPrice ?? pos.openPrice ?? 0;
      const trade = openPositions[id];
      const lotV  = LOT_VALUE[getSymbolType(trade.symbol)] || 1.0;
      const pnl   = trade.direction === "buy"
        ? (cur - trade.entry) * trade.lots * lotV
        : (trade.entry - cur) * trade.lots * lotV;
      const isBetter = trade.direction === "buy"
        ? cur > (trade.maxPrice ?? trade.entry)
        : cur < (trade.maxPrice ?? trade.entry);
      if (isBetter) { trade.maxPrice = cur; trade.maxProfit = parseFloat(pnl.toFixed(2)); }
      trade.currentPrice = cur;
      trade.currentPnL   = parseFloat(pnl.toFixed(2));
      trade.lastSync     = new Date().toISOString();
    }

    for (const [id, trade] of Object.entries(openPositions)) {
      if (!liveIds.has(id)) {
        closedTrades.push({
          ...trade,
          closedAt: new Date().toISOString(),
          whatIfRR: calcWhatIfRR(trade),
        });
        if (trade.symbol && trade.direction) decrementTradeTracker(trade.symbol, trade.direction);
        delete openPositions[id];
        console.log(`📦 Positie ${id} (${trade.symbol}) gearchiveerd | maxProfit: €${trade.maxProfit ?? 0}`);
      }
    }

    try {
      const info = await fetchAccountInfo();
      if (accountSnapshots.length === 0 && info.balance) {
        ftmoStartBalance = info.balance;
        console.log(`📊 FTMO startbalans ingesteld op €${ftmoStartBalance}`);
      }
      accountSnapshots.push({
        ts:              new Date().toISOString(),
        balance:         info.balance    ?? null,
        equity:          info.equity     ?? null,
        floatingPL:      parseFloat(((info.equity ?? 0) - (info.balance ?? 0)).toFixed(2)),
        margin:          info.margin     ?? null,
        freeMargin:      info.freeMargin ?? null,
        ftmoDailyLossUsed,
        ftmoDailyLimit:  ftmoStartBalance * FTMO_DAILY_LOSS_PCT,
      });
      if (accountSnapshots.length > MAX_SNAPSHOTS) accountSnapshots.shift();
    } catch (e) { console.warn("⚠️ Equity snapshot mislukt:", e.message); }

  } catch (e) { console.warn("⚠️ syncPositions fout:", e.message); }
}
setInterval(syncPositions, 30 * 1000);

// ══════════════════════════════════════════════════════════════
// WEBHOOK ENDPOINT
// ══════════════════════════════════════════════════════════════
app.post("/webhook", async (req, res) => {
  try {
    console.log("📨 Webhook ontvangen:", JSON.stringify(req.body));
    addWebhookHistory({ type: "RECEIVED", body: req.body });

    const secret = req.query.secret || req.headers["x-secret"];
    if (secret !== WEBHOOK_SECRET) {
      console.warn("⚠️ Ongeldige secret");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { action, entry, sl } = req.body;

    // {{ticker}} vangnet
    const symbol = (req.body.symbol === "{{ticker}}" || !req.body.symbol)
      ? null : req.body.symbol;

    if (!symbol) {
      return res.status(400).json({
        error: "Symbool ontbreekt of is letterlijk {{ticker}} — verwijder de TradingView alert en maak hem opnieuw aan.",
      });
    }

    if (!action || !entry || !sl) {
      return res.status(400).json({ error: "Vereist: action, symbol, entry, sl" });
    }

    const direction = ["buy","bull","long"].includes(action.toLowerCase()) ? "buy" : "sell";
    const entryNum  = parseFloat(entry);
    const slNum     = parseFloat(sl);

    if (isNaN(entryNum) || isNaN(slNum)) {
      return res.status(400).json({ error: "entry en sl moeten geldige getallen zijn" });
    }
    if (direction === "buy"  && slNum >= entryNum) return res.status(400).json({ error: "SL moet onder entry voor BUY" });
    if (direction === "sell" && slNum <= entryNum) return res.status(400).json({ error: "SL moet boven entry voor SELL" });

    const symType = getSymbolType(symbol);
    const mt5Sym  = getMT5Symbol(symbol);

    if (!SYMBOL_MAP[symbol]) {
      console.warn(`⚠️ Onbekend symbool: "${symbol}" — wordt doorgestuurd als "${mt5Sym}"`);
    }

    // Markturen check
    if (!isCETMarketOpen(symType)) {
      const msg = `🕐 Markt gesloten voor ${symbol} (${symType}) — order genegeerd`;
      console.warn(msg);
      addWebhookHistory({ type: "MARKET_CLOSED", symbol, symType });
      return res.status(200).json({ status: "SKIP", reason: msg });
    }

    // FTMO dagelijks verlies check
    const effectiveRisk = getEffectiveRisk(symbol, direction);
    const ftmoCheck = ftmoSafetyCheck(effectiveRisk);
    if (!ftmoCheck.ok) {
      console.warn(ftmoCheck.reason);
      addWebhookHistory({ type: "FTMO_BLOCKED", symbol, reason: ftmoCheck.reason });
      return res.status(200).json({ status: "FTMO_BLOCKED", reason: ftmoCheck.reason });
    }

    const tradeCount = openTradeTracker[`${symbol}_${direction}`] || 0;
    if (tradeCount > 0) {
      console.log(`⚖️ Consolidatie guard: ${tradeCount} open ${direction} op ${symbol} → €${effectiveRisk.toFixed(2)}`);
    }

    const lots = calcLots(symbol, entryNum, slNum, effectiveRisk);
    if (lots === null) {
      return res.status(200).json({
        status: "SKIP",
        reason: `Minimale lot kost meer dan max risico €${RISK_EUR_MAX.toFixed(2)}`,
      });
    }

    const slAfstand = Math.abs(entryNum - slNum).toFixed(4);
    console.log(`📊 ${direction.toUpperCase()} ${symbol} → ${mt5Sym} [${symType}] | Entry: ${entryNum} | SL: ${slNum} | Afstand: ${slAfstand} | Lots: ${lots} | Risico: €${effectiveRisk.toFixed(2)}`);

    let { result, mt5Symbol, slPrice, body } = await placeOrder(direction, symbol, entryNum, slNum, lots);
    console.log("📬 MetaApi resultaat:", JSON.stringify(result));

    const errCode = result?.error?.code || result?.retcode;
    const errMsg  = result?.error?.message || result?.comment || "";
    const isError = result?.error || (errCode && errCode !== 10009 && errCode !== "TRADE_RETCODE_DONE");

    if (isError) {
      console.warn(`⚠️ Order fout (${errCode}): ${errMsg}`);
      learnFromError(symbol, errCode, errMsg, body);
      console.log("🔄 Self-healing retry...");
      const retryLots = calcLots(symbol, entryNum, slNum, effectiveRisk);
      if (retryLots !== null) {
        const retry = await placeOrder(direction, symbol, entryNum, slNum, retryLots);
        result = retry.result;
        console.log("🔄 Retry resultaat:", JSON.stringify(result));
        const retryErr = result?.error ||
          (result?.retcode && result?.retcode !== 10009 && result?.retcode !== "TRADE_RETCODE_DONE");
        if (retryErr) {
          learnFromError(symbol, result?.error?.code || result?.retcode, result?.error?.message || result?.comment, retry.body);
          addWebhookHistory({ type: "ERROR", symbol, errCode, errMsg });
          return res.status(200).json({ status: "ERROR_LEARNED", errCode, errMsg, learnedPatches });
        }
      }
    }

    registerFtmoLoss(effectiveRisk);
    incrementTradeTracker(symbol, direction);

    const posId = String(result?.positionId || result?.orderId || Date.now());
    openPositions[posId] = {
      id: posId, symbol, mt5Symbol, direction,
      entry: entryNum, sl: slPrice, lots,
      riskEUR:    effectiveRisk,
      openedAt:   new Date().toISOString(),
      maxPrice:   entryNum,
      maxProfit:  0,
      currentPnL: 0,
      lastSync:   null,
    };

    const responseBody = {
      status: "OK", direction,
      tvSymbol:           symbol,
      mt5Symbol:          mt5Symbol,
      entry: entryNum, sl: slPrice, slAfstand, lots,
      risicoEUR:          effectiveRisk.toFixed(2),
      maxRisicoEUR:       RISK_EUR_MAX.toFixed(2),
      ftmoDailyUsed:      ftmoDailyLossUsed.toFixed(2),
      ftmoDailyLimit:     (ftmoStartBalance * FTMO_DAILY_LOSS_PCT).toFixed(2),
      ftmoDailyRemaining: (ftmoStartBalance * FTMO_DAILY_LOSS_PCT - ftmoDailyLossUsed).toFixed(2),
      tradeNummer:        openTradeTracker[`${symbol}_${direction}`] || 1,
      positionId:         posId,
      metaApi:            result,
      learnedPatches:     Object.keys(learnedPatches).length ? learnedPatches : undefined,
    };

    addWebhookHistory({ type: "SUCCESS", symbol, mt5Symbol, direction, lots, posId });
    res.json(responseBody);

  } catch (err) {
    console.error("❌ Fout:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── MANUAL CLOSE ──────────────────────────────────────────────
app.post("/close", async (req, res) => {
  const secret = req.query.secret || req.headers["x-secret"];
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  const { positionId, symbol, direction } = req.body;
  if (!positionId) return res.status(400).json({ error: "Vereist: positionId" });
  try {
    const result = await closePosition(positionId);
    if (symbol && direction) decrementTradeTracker(symbol, direction);
    res.json({ status: "OK", result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH ────────────────────────────────────────────────────
app.get("/", (req, res) => {
  resetDailyLossIfNewDay();
  res.json({
    status: "online", versie: "ftmo-v2", broker: "FTMO-Demo",
    accountBalance: ACCOUNT_BALANCE,
    risicoEUR: RISK_EUR_BASE, maxRisico: RISK_EUR_MAX,
    ftmo: {
      startBalance:       ftmoStartBalance,
      dailyLossUsed:      parseFloat(ftmoDailyLossUsed.toFixed(2)),
      dailyLossLimit:     parseFloat((ftmoStartBalance * FTMO_DAILY_LOSS_PCT).toFixed(2)),
      totalLossLimit:     parseFloat((ftmoStartBalance * FTMO_TOTAL_LOSS_PCT).toFixed(2)),
      dailyLossRemaining: parseFloat((ftmoStartBalance * FTMO_DAILY_LOSS_PCT - ftmoDailyLossUsed).toFixed(2)),
    },
    symbolMap: Object.fromEntries(Object.entries(SYMBOL_MAP).map(([tv, v]) => [tv, v.mt5])),
    endpoints: {
      "POST /webhook":               "TradingView → FTMO MT5",
      "POST /close":                 "Manueel positie sluiten",
      "GET  /status":                "Open trades + FTMO limieten",
      "GET  /live/positions":        "Live posities met P&L",
      "GET  /analysis/closed":       "Gesloten trades + what-if RR",
      "GET  /analysis/equity-curve": "Equity history",
      "GET  /history":               "Webhook log",
    },
    tracking: {
      openPositions:   Object.keys(openPositions).length,
      closedTrades:    closedTrades.length,
      equitySnapshots: accountSnapshots.length,
      webhookHistory:  webhookHistory.length,
    },
  });
});

// ── STATUS ────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  resetDailyLossIfNewDay();
  res.json({
    openTrades: openTradeTracker, learnedPatches,
    risicoBase: RISK_EUR_BASE, risicoMax: RISK_EUR_MAX,
    ftmoDailyUsed:      parseFloat(ftmoDailyLossUsed.toFixed(2)),
    ftmoDailyLimit:     parseFloat((ftmoStartBalance * FTMO_DAILY_LOSS_PCT).toFixed(2)),
    ftmoDailyRemaining: parseFloat((ftmoStartBalance * FTMO_DAILY_LOSS_PCT - ftmoDailyLossUsed).toFixed(2)),
  });
});

// ── LIVE POSITIONS ────────────────────────────────────────────
app.get("/live/positions", (req, res) => {
  const positions = Object.values(openPositions).map(p => ({
    id: p.id, symbol: p.symbol, mt5Symbol: p.mt5Symbol, direction: p.direction,
    entry: p.entry, sl: p.sl, lots: p.lots, riskEUR: p.riskEUR,
    openedAt: p.openedAt, currentPrice: p.currentPrice ?? null,
    currentPnL: p.currentPnL ?? 0, maxPrice: p.maxPrice,
    maxProfit: p.maxProfit, lastSync: p.lastSync,
  }));
  res.json({ count: positions.length, positions });
});

// ── CLOSED ANALYSIS ───────────────────────────────────────────
app.get("/analysis/closed", (req, res) => {
  const { symbol } = req.query;
  const trades = symbol
    ? closedTrades.filter(t => t.symbol?.toUpperCase() === symbol.toUpperCase())
    : closedTrades;
  const bySymbol = {};
  for (const t of trades) {
    const s = t.symbol || "UNKNOWN";
    if (!bySymbol[s]) bySymbol[s] = { trades: [], totalActual: 0 };
    bySymbol[s].trades.push(t);
    bySymbol[s].totalActual += t.maxProfit ?? 0;
  }
  const summary = Object.entries(bySymbol).map(([sym, g]) => {
    const rrSummary = {};
    for (const rr of ["2:1","3:1","4:1"]) {
      const possible = g.trades.filter(t => t.whatIfRR?.[rr]?.wouldHit).length;
      const totalPot = g.trades.reduce((sum, t) => sum + (t.whatIfRR?.[rr]?.potential ?? 0), 0);
      rrSummary[rr] = { wouldHave: possible, totalPotential: parseFloat(totalPot.toFixed(2)) };
    }
    return { symbol: sym, tradeCount: g.trades.length, whatIfRR: rrSummary, trades: g.trades };
  });
  res.json({ total: trades.length, bySymbol: summary });
});

// ── EQUITY CURVE ──────────────────────────────────────────────
app.get("/analysis/equity-curve", (req, res) => {
  const hours  = parseInt(req.query.hours) || 24;
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const snaps  = accountSnapshots.filter(s => s.ts >= cutoff);
  res.json({ hours, count: snaps.length, snapshots: snaps });
});

// ── WEBHOOK HISTORY ───────────────────────────────────────────
app.get("/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_HISTORY);
  res.json({ count: webhookHistory.length, history: webhookHistory.slice(0, limit) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 FTMO Webhook v2 | Balance: €${ACCOUNT_BALANCE} | Risico: €${RISK_EUR_BASE}/trade | Daily limit: €${(ACCOUNT_BALANCE * FTMO_DAILY_LOSS_PCT).toFixed(0)} | Symbolen: ${Object.keys(SYMBOL_MAP).length}`)
);
