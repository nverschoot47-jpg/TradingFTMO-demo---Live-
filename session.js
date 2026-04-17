// ===============================================================
// session.js  v9.0  |  PRONTO-AI
//
// Changes v9.0:
//  - SYMBOL_CATALOG: only approved symbols (stocks/forex/index/commodity/crypto)
//  - Sessions: asia 02:00-08:00 | london 08:00-15:30 | ny 15:30-21:00
//  - isMarketOpen(): all symbols tradeable 02:00-21:00 mon-fri, NO blocking
//  - getVwapPosition(): above | below based on close vs vwap
//  - normalizeSymbol() handles BRK.B → BRKB, GOOGL → GOOGL
// ===============================================================

"use strict";

const TIMEZONE = "Europe/Brussels";

const DAYS_MAP = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

// ── Approved symbol catalog ─────────────────────────────────────
// ONLY these symbols are accepted. type determines lot/risk calc.
// mt5: exact broker symbol string on FTMO MT5.
const SYMBOL_CATALOG = {
  // ── Stocks ──────────────────────────────────────────────────
  AAPL:      { type: "stock",     mt5: "AAPL"      },
  AMD:       { type: "stock",     mt5: "AMD"       },
  AMZN:      { type: "stock",     mt5: "AMZN"      },
  ARM:       { type: "stock",     mt5: "ARM"       },
  ASML:      { type: "stock",     mt5: "ASML"      },
  AVGO:      { type: "stock",     mt5: "AVGO"      },
  AZN:       { type: "stock",     mt5: "AZN"       },
  BA:        { type: "stock",     mt5: "BA"        },
  BABA:      { type: "stock",     mt5: "BABA"      },
  BAC:       { type: "stock",     mt5: "BAC"       },
  BRKB:      { type: "stock",     mt5: "BRK.B"     },
  CSCO:      { type: "stock",     mt5: "CSCO"      },
  CVX:       { type: "stock",     mt5: "CVX"       },
  DIS:       { type: "stock",     mt5: "DIS"       },
  FDX:       { type: "stock",     mt5: "FDX"       },
  GE:        { type: "stock",     mt5: "GE"        },
  GM:        { type: "stock",     mt5: "GM"        },
  GME:       { type: "stock",     mt5: "GME"       },
  GOOGL:     { type: "stock",     mt5: "GOOGL"     },
  IBM:       { type: "stock",     mt5: "IBM"       },
  INTC:      { type: "stock",     mt5: "INTC"      },
  JNJ:       { type: "stock",     mt5: "JNJ"       },
  JPM:       { type: "stock",     mt5: "JPM"       },
  KO:        { type: "stock",     mt5: "KO"        },
  LMT:       { type: "stock",     mt5: "LMT"       },
  MCD:       { type: "stock",     mt5: "MCD"       },
  META:      { type: "stock",     mt5: "META"      },
  MSFT:      { type: "stock",     mt5: "MSFT"      },
  MSTR:      { type: "stock",     mt5: "MSTR"      },
  NFLX:      { type: "stock",     mt5: "NFLX"      },
  NKE:       { type: "stock",     mt5: "NKE"       },
  NVDA:      { type: "stock",     mt5: "NVDA"      },
  PFE:       { type: "stock",     mt5: "PFE"       },
  PLTR:      { type: "stock",     mt5: "PLTR"      },
  QCOM:      { type: "stock",     mt5: "QCOM"      },
  SBUX:      { type: "stock",     mt5: "SBUX"      },
  SNOW:      { type: "stock",     mt5: "SNOW"      },
  T:         { type: "stock",     mt5: "T"         },
  TSLA:      { type: "stock",     mt5: "TSLA"      },
  V:         { type: "stock",     mt5: "V"         },
  WMT:       { type: "stock",     mt5: "WMT"       },
  XOM:       { type: "stock",     mt5: "XOM"       },
  ZM:        { type: "stock",     mt5: "ZM"        },
  // ── Forex ────────────────────────────────────────────────────
  AUDCAD:    { type: "forex",     mt5: "AUDCAD"    },
  AUDCHF:    { type: "forex",     mt5: "AUDCHF"    },
  AUDNZD:    { type: "forex",     mt5: "AUDNZD"    },
  AUDUSD:    { type: "forex",     mt5: "AUDUSD"    },
  CADCHF:    { type: "forex",     mt5: "CADCHF"    },
  EURAUD:    { type: "forex",     mt5: "EURAUD"    },
  EURCHF:    { type: "forex",     mt5: "EURCHF"    },
  EURUSD:    { type: "forex",     mt5: "EURUSD"    },
  GBPAUD:    { type: "forex",     mt5: "GBPAUD"    },
  GBPNZD:    { type: "forex",     mt5: "GBPNZD"    },
  GBPUSD:    { type: "forex",     mt5: "GBPUSD"    },
  NZDCAD:    { type: "forex",     mt5: "NZDCAD"    },
  NZDCHF:    { type: "forex",     mt5: "NZDCHF"    },
  NZDUSD:    { type: "forex",     mt5: "NZDUSD"    },
  USDCAD:    { type: "forex",     mt5: "USDCAD"    },
  USDCHF:    { type: "forex",     mt5: "USDCHF"    },
  // ── Indexes ───────────────────────────────────────────────────
  DE30EUR:   { type: "index",     mt5: "GER40.cash"   },
  NAS100USD: { type: "index",     mt5: "US100.cash"   },
  UK100GBP:  { type: "index",     mt5: "UK100.cash"   },
  US30USD:   { type: "index",     mt5: "US30.cash"    },
  // ── Commodities ───────────────────────────────────────────────
  XAUUSD:    { type: "commodity", mt5: "XAUUSD"    },
  // ── Crypto ────────────────────────────────────────────────────
  BTCUSD:    { type: "crypto",    mt5: "BTCUSD"    },
};

// ── Aliases for TV symbols that differ from catalog key ─────────
// Maps incoming TV ticker → canonical catalog key
const SYMBOL_ALIASES = {
  "BRK.B": "BRKB",
  "BRKB":  "BRKB",
  "GER40":  "DE30EUR",
  "GER40.cash": "DE30EUR",
  "UK100":  "UK100GBP",
  "UK100.cash": "UK100GBP",
  "NAS100": "NAS100USD",
  "US100":  "NAS100USD",
  "US100.cash": "NAS100USD",
  "US30":   "US30USD",
  "US30.cash": "US30USD",
  "GOLD":   "XAUUSD",
  "GOOG":   "GOOGL",
};

// ── Brussels timezone helpers ────────────────────────────────────
function getBrusselsComponents(date) {
  const d = date ? new Date(date) : new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday:  "long",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
  }).formatToParts(d);
  const get    = (type) => parts.find(p => p.type === type)?.value ?? "0";
  let hour     = parseInt(get("hour"),   10);
  const minute = parseInt(get("minute"), 10);
  if (hour === 24) hour = 0;
  const weekday = get("weekday");
  const day     = DAYS_MAP[weekday] ?? 0;
  return { day, hhmm: hour * 100 + minute, hour, minute };
}

function getBrusselsDateStr() {
  return new Intl.DateTimeFormat("nl-BE", {
    timeZone:  TIMEZONE,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date());
}

function getBrusselsDateOnly(date) {
  const d = date ? new Date(date) : new Date();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
  }).format(d);
}

// ── Session detection ────────────────────────────────────────────
// Asia:   02:00 – 08:00  Brussels
// London: 08:00 – 15:30  Brussels
// NY:     15:30 – 21:00  Brussels
function getSession(date) {
  const { hhmm } = getBrusselsComponents(date);
  if (hhmm >= 200  && hhmm < 800)  return "asia";
  if (hhmm >= 800  && hhmm < 1530) return "london";
  if (hhmm >= 1530 && hhmm < 2100) return "ny";
  return "outside";
}

// ── Market open check ────────────────────────────────────────────
// All symbols: 02:00–21:00 mon-fri. NO symbol/direction blocking.
// Crypto follows same window (BTCUSD is in catalog).
function isMarketOpen(date = null) {
  const { day, hhmm } = getBrusselsComponents(date);
  if (day === 0 || day === 6) return false; // weekend
  if (hhmm < 200)             return false; // before 02:00
  if (hhmm >= 2100)           return false; // from 21:00
  return true;
}

// Ghost/shadow may run until 23:00 to finalize after-market data
function isGhostActive(date) {
  const { day, hhmm } = getBrusselsComponents(date ? new Date(date) : new Date());
  if (day === 0 || day === 6) return false;
  if (hhmm < 200)             return false;
  if (hhmm >= 2300)           return false;
  return true;
}

function isShadowActive(date) { return isGhostActive(date); }

// ── Symbol normalization ─────────────────────────────────────────
// Returns canonical catalog key (e.g. "BRKB") or null if not allowed.
function normalizeSymbol(raw) {
  if (!raw) return null;
  const upper = raw.toString().toUpperCase().trim();
  // Check alias first
  if (SYMBOL_ALIASES[upper]) return SYMBOL_ALIASES[upper];
  // Strip non-alphanumeric for comparison (handles BRK.B → BRKB)
  const stripped = upper.replace(/[^A-Z0-9]/g, "");
  if (SYMBOL_ALIASES[stripped]) return SYMBOL_ALIASES[stripped];
  if (SYMBOL_CATALOG[upper])    return upper;
  if (SYMBOL_CATALOG[stripped]) return stripped;
  return null; // not in catalog
}

function getSymbolInfo(raw) {
  const key = normalizeSymbol(raw);
  if (!key) return null;
  return { ...SYMBOL_CATALOG[key], key };
}

// ── VWAP position ────────────────────────────────────────────────
// Determines if close is above or below VWAP mid line.
// Uses vwap field from TradingView payload.
function getVwapPosition(closePrice, vwapMid) {
  if (closePrice == null || vwapMid == null || vwapMid === 0) return "unknown";
  return closePrice >= vwapMid ? "above" : "below";
}

// ── Optimizer key ────────────────────────────────────────────────
// Unique key for ghost/shadow/EV lookups.
// Format: EURUSD_london_buy_above
function buildOptimizerKey(symbol, session, direction, vwapPos) {
  return `${symbol}_${session}_${direction}_${vwapPos}`;
}

const SESSION_LABELS = {
  asia:    "Asia (02:00–08:00)",
  london:  "London (08:00–15:30)",
  ny:      "New York (15:30–21:00)",
  outside: "Outside window",
};

module.exports = {
  SYMBOL_CATALOG,
  SYMBOL_ALIASES,
  SESSION_LABELS,
  TIMEZONE,
  getBrusselsComponents,
  getBrusselsDateStr,
  getBrusselsDateOnly,
  getSession,
  isMarketOpen,
  isGhostActive,
  isShadowActive,
  normalizeSymbol,
  getSymbolInfo,
  getVwapPosition,
  buildOptimizerKey,
};
