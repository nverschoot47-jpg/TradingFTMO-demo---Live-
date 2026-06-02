"use strict";
// ================================================================
// session.js  v2.0.0  |  PRONTO-AI
// Only XAUUSD and US100.cash — all other symbols blocked
// ================================================================

const TIMEZONE = "Europe/Brussels";

// Risk: 0.0375% of equity per trade
const DEFAULT_RISK_PCT = 0.000375;

// SL buffer: webhook gives sl_pct (e.g. 0.003 = 0.3%)
// We multiply by 1.5 to account for spread + timing lag
const SL_BUFFER_MULT = 1.5;

// Symbol catalog — only 2 pairs
const SYMBOL_CATALOG = {
  "XAUUSD":      { type: "commodity", mt5: "XAUUSD",     pip: 0.01  },
  "US100.cash":  { type: "index",     mt5: "US100.cash", pip: 0.10  },
};

// All TradingView aliases that map to our 2 pairs
const SYMBOL_ALIASES = {
  "GOLD":        "XAUUSD",
  "XAUUSD":      "XAUUSD",
  "XAU/USD":     "XAUUSD",
  "XAUUSD.":     "XAUUSD",
  "US100":       "US100.cash",
  "US100.CASH":  "US100.cash",
  "NAS100":      "US100.cash",
  "NAS100USD":   "US100.cash",
  "NASDAQ":      "US100.cash",
  "NDX":         "US100.cash",
  "USTEC":       "US100.cash",
  "US100USD":    "US100.cash",
  "NASDAQ100":   "US100.cash",
};

// Brussels time helpers
function getBrusselsComponents(date = null) {
  const d = date ? new Date(date) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value;
  const dayName = get("weekday");
  const dayMap  = { Sunday:0, Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6 };
  const day     = dayMap[dayName] ?? 0;
  const hour    = parseInt(get("hour")) % 24;
  const minute  = parseInt(get("minute"));
  const second  = parseInt(get("second"));
  const hhmm    = hour * 100 + minute;
  return { day, hour, minute, second, hhmm };
}

function getBrusselsDateStr(date = null) {
  const d = date ? new Date(date) : new Date();
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TIMEZONE }).format(d);
}

// Session based on Brussels time
// Asia:   02:00–08:00
// London: 08:00–15:30
// NY:     15:30–02:00
function getSession(date = null) {
  const { hhmm } = getBrusselsComponents(date);
  if (hhmm >= 200  && hhmm < 800)  return "asia";
  if (hhmm >= 800  && hhmm < 1530) return "london";
  return "ny";
}

function isWeekend(date = null) {
  const { day } = getBrusselsComponents(date);
  return day === 0 || day === 6;
}

// Normalize raw symbol from TradingView to our catalog key
function normalizeSymbol(raw) {
  if (!raw) return null;
  const upper = raw.toString().toUpperCase().trim().replace(/[^A-Z0-9./]/g, "");
  if (SYMBOL_ALIASES[upper]) return SYMBOL_ALIASES[upper];
  // Also try without dot
  const noDot = upper.replace(/\./g, "");
  for (const [alias, target] of Object.entries(SYMBOL_ALIASES)) {
    if (alias.replace(/[./]/g, "") === noDot) return target;
  }
  return null;
}

function getSymbolInfo(raw) {
  const key = normalizeSymbol(raw);
  if (!key) return null;
  return { ...SYMBOL_CATALOG[key], key };
}

function getVwapPosition(price, vwapMid) {
  if (price == null || vwapMid == null || vwapMid === 0) return "unknown";
  return parseFloat(price) >= parseFloat(vwapMid) ? "above" : "below";
}

// Optimizer key: "XAUUSD_london_buy_above"
function buildOptimizerKey(symbol, session, direction, vwapPos) {
  return `${symbol}_${session}_${direction}_${vwapPos}`;
}

// Daily trade label: "01/06-#3"
function buildDailyLabel(date, count) {
  const s = getBrusselsDateStr(date);
  const dd = s.slice(8, 10);
  const mm = s.slice(5, 7);
  return `${dd}/${mm}-#${count}`;
}

// canOpen: only blocked on weekends or unknown symbol
// Also explicitly block index signals we don't trade
const BLOCKED_SYMBOLS = new Set([
  "US30USD","US30","DOW","DJI","DJIA",
  "DE30EUR","DE30","DAX","GER30","GER40",
  "UK100GBP","UK100","FTSE","FTSE100",
  "SP500","SPX","US500","SPX500",
  "JP225","JPN225","NIKKEI",
]);

function canOpenNewTrade(rawSymbol, date = null) {
  if (isWeekend(date)) return { allowed: false, reason: "WEEKEND" };
  const upper = (rawSymbol || "").toString().toUpperCase().trim().replace(/[^A-Z0-9./]/g,"");
  if (BLOCKED_SYMBOLS.has(upper)) return { allowed: false, reason: `SYMBOL_NOT_ALLOWED: "${rawSymbol}" — explicitly blocked` };
  const sym = normalizeSymbol(rawSymbol);
  if (!sym) return { allowed: false, reason: `SYMBOL_NOT_ALLOWED: "${rawSymbol}" — only XAUUSD and US100.cash` };
  return { allowed: true, reason: null };
}

module.exports = {
  TIMEZONE, DEFAULT_RISK_PCT, SL_BUFFER_MULT,
  SYMBOL_CATALOG, SYMBOL_ALIASES,
  getBrusselsComponents, getBrusselsDateStr,
  getSession, isWeekend,
  normalizeSymbol, getSymbolInfo,
  getVwapPosition, buildOptimizerKey,
  buildDailyLabel, canOpenNewTrade,
};
