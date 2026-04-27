// ===============================================================
// session.js  v10.7  |  PRONTO-AI
//
// Changes v10.6:
//  - No functional changes. Version bump for v10.6 release.
//
// Changes v10.5:
//  - COMPLIANCE_DATE + COMPLIANCE_DATE_MS exported (FIX 8):
//    single source of truth, imported by server.js and db.js.
//
// Changes v10.4:
//  - canOpenNewTrade(symbol): replaces isMarketOpen() for new trades
//    * Stocks: only 16:00–21:00 Brussels (NY market hours)
//    * Forex/Index/Commodity: 02:00–21:00 Brussels mon-fri
//    * isMarketOpen() kept as alias for monitoring/ghost checks
//  - isMonitoringActive(): true mon-fri (allows overnight holding)
//  - Ghost/shadow monitoring continues through night for open pos
// ===============================================================

"use strict";

const TIMEZONE = "Europe/Brussels";

const DAYS_MAP = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

// ================================================================
// ── DEFAULT RISK % PER ASSET TYPE ────────────────────────────────
// Change these values to adjust default risk for all symbols of
// that type. Overrideable per-symbol via env RISK_<SYM>=0.002
// or via the DB symbol_risk_config table.
// ================================================================
const DEFAULT_RISK_BY_TYPE = {
  forex:     0.0015,   // 0.15% per trade
  stock:     0.0015,   // 0.15% per trade
  index:     0.0015,   // 0.15% per trade
  commodity: 0.0015,   // 0.15% per trade
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
  GOOGL:     { type: "stock",     mt5: "GOOG"      }, // broker symbol is GOOG (Alphabet Class C)
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
};

// ── Aliases for TV symbols that differ from catalog key ─────────
const SYMBOL_ALIASES = {
  "BRK.B":         "BRKB",
  "BRKB":          "BRKB",
  "GER40":         "DE30EUR",
  "GER40.cash":    "DE30EUR",
  "UK100":         "UK100GBP",
  "UK100.cash":    "UK100GBP",
  "NAS100":        "NAS100USD",
  "US100":         "NAS100USD",
  "US100.cash":    "NAS100USD",
  "US30":          "US30USD",
  "US30.cash":     "US30USD",
  "GOLD":          "XAUUSD",
  "GOOG":          "GOOGL",
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
function getSession(date) {
  const { hhmm } = getBrusselsComponents(date);
  if (hhmm >= 200  && hhmm < 800)  return "asia";
  if (hhmm >= 800  && hhmm < 1530) return "london";
  if (hhmm >= 1530 && hhmm < 2100) return "ny";
  return "outside";
}

// ── Market open check (kept for backward compat / monitoring) ────
function isMarketOpen(date = null) {
  const { day, hhmm } = getBrusselsComponents(date);
  if (day === 0 || day === 6) return false;
  if (hhmm < 200)             return false;
  if (hhmm >= 2100)           return false;
  return true;
}

// ── Can a NEW trade be opened? ───────────────────────────────────
// Stocks:              16:00–21:00 Brussels only (NYSE/NASDAQ open)
// Forex/Index/Commodity: 02:00–21:00 Brussels mon-fri
// Returns { allowed: boolean, reason: string }
function canOpenNewTrade(rawSymbol, date = null) {
  const { day, hhmm } = getBrusselsComponents(date);
  if (day === 0 || day === 6) return { allowed: false, reason: "WEEKEND" };

  // Resolve asset type
  const upper   = rawSymbol ? rawSymbol.toString().toUpperCase().trim() : "";
  const aliased = SYMBOL_ALIASES[upper] ?? upper;
  const info    = SYMBOL_CATALOG[aliased] ?? null;
  const type    = info?.type ?? "unknown";

  if (type === "stock") {
    // Stocks: only during NY session (16:00–21:00 Brussels)
    if (hhmm < 1600 || hhmm >= 2100) {
      return {
        allowed: false,
        reason:  `STOCK_OUTSIDE_MARKET: ${hhmm} (stocks need 1600–2100 Brussels)`,
      };
    }
  } else {
    // Forex, index, commodity: 02:00–21:00
    if (hhmm < 200 || hhmm >= 2100) {
      return {
        allowed: false,
        reason:  `OUTSIDE_WINDOW: ${hhmm} (need 0200–2100 Brussels)`,
      };
    }
  }

  return { allowed: true, reason: null };
}

// ── Monitoring active? (ghost + shadow + position sync) ──────────
// True on weekdays regardless of time — allows overnight holdings.
function isMonitoringActive(date = null) {
  const { day } = getBrusselsComponents(date);
  return day !== 0 && day !== 6; // pause only on weekend
}

// Kept as alias — ghost tracker uses isMonitoringActive internally now
function isGhostActive(date) { return isMonitoringActive(date); }

function isShadowActive(date) { return isMonitoringActive(date); }

// ── Symbol normalization ─────────────────────────────────────────
function normalizeSymbol(raw) {
  if (!raw) return null;
  const upper    = raw.toString().toUpperCase().trim();
  if (SYMBOL_ALIASES[upper])    return SYMBOL_ALIASES[upper];
  const stripped = upper.replace(/[^A-Z0-9]/g, "");
  if (SYMBOL_ALIASES[stripped]) return SYMBOL_ALIASES[stripped];
  if (SYMBOL_CATALOG[upper])    return upper;
  if (SYMBOL_CATALOG[stripped]) return stripped;
  return null;
}

function getSymbolInfo(raw) {
  const key = normalizeSymbol(raw);
  if (!key) return null;
  return { ...SYMBOL_CATALOG[key], key };
}

// ── VWAP position ────────────────────────────────────────────────
function getVwapPosition(closePrice, vwapMid) {
  if (closePrice == null || vwapMid == null || vwapMid === 0) return "unknown";
  return closePrice >= vwapMid ? "above" : "below";
}

// ── Optimizer key ────────────────────────────────────────────────
function buildOptimizerKey(symbol, session, direction, vwapPos) {
  return `${symbol}_${session}_${direction}_${vwapPos}`;
}

const SESSION_LABELS = {
  asia:    "Asia (02:00–08:00)",
  london:  "London (08:00–15:30)",
  ny:      "New York (15:30–21:00)",
  outside: "Outside window",
};

// ── Data quality compliance date (FIX 8: single source of truth) ────
const COMPLIANCE_DATE    = '2026-04-27 07:00:00';  // 09:00 Brussels (UTC+2 summer)
const COMPLIANCE_DATE_MS = new Date('2026-04-27T07:00:00.000Z').getTime();

module.exports = {
  COMPLIANCE_DATE,
  COMPLIANCE_DATE_MS,
  SYMBOL_CATALOG,
  SYMBOL_ALIASES,
  DEFAULT_RISK_BY_TYPE,
  SESSION_LABELS,
  TIMEZONE,
  getBrusselsComponents,
  getBrusselsDateStr,
  getBrusselsDateOnly,
  getSession,
  isMarketOpen,
  canOpenNewTrade,
  isMonitoringActive,
  isGhostActive,
  isShadowActive,
  normalizeSymbol,
  getSymbolInfo,
  getVwapPosition,
  buildOptimizerKey,
};
