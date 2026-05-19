// ===============================================================
// session.js  v14.0  |  PRONTO-AI
//
// Changes v14.0:
//  - Versie bump: consistent met server.js v14.0.0.
//  - Geen functionele wijzigingen — alle logica stabiel.
//
// Changes v13.3:
//  - COMPLIANCE_DATE gezet op '2000-01-01' zodat geen historische
//    data meer weggefilterd wordt. Dashboard draait vrij zonder
//    compliance datum restrictie.
//  - Selectieve datumfilter zit nu in het dashboard (Ghost History).
//
// Changes v12.5 (dashboard optimalisaties):
//  - Versie bump: consistentie met server.js v12.5.0 en package.json v12.5.0.
//  - Geen functionele wijzigingen aan sessie-logica of risicoberekening.
//  - Nieuwe features zitten in server.js (SL milestone timing, performance
//    KPI endpoint, MAE stats, ghost grouped view) en db.js (loadPerformanceSummary,
//    loadMAEStats, loadGhostGrouped).
//
// Changes v10.9:
//  - DEFAULT_RISK_BY_TYPE gehalveerd: 0.00075 → 0.000375 (0.0375% per trade).
//    Reden: verdere risicobeperking zodat nooit manueel gesloten hoeft te worden.
//    Geldt voor forex, stock, index, commodity.
//
//  - NY DEAD ZONE: canOpenNewTrade() blokkeert nu trades van 15:30 t/m 18:00
//    Brussels tijd voor forex, commodity en stocks.
//    Reden: hoge spread + lage liquiditeit in de eerste 2,5u na NYSE open.
//    Indexes (DE30EUR, UK100GBP, NAS100USD, US30USD) zijn NIET geblokkeerd
//    in deze periode — die hebben hun eigen NY open dynamiek.
//    Session-label: "NY_DEAD_ZONE" in reject logs.
//
//  - STOCK SL_BUFFER_MULT: STOCK_SL_BUFFER_MULT = 3.0 geëxporteerd.
//    Stocks krijgen 3.0× SL buffer (in plaats van 1.5× voor forex/commodity).
//    Reden: stocks hebben grotere spread en worden te snel uitgetikt.
//    server.js gebruikt STOCK_SL_BUFFER_MULT voor calcSLFromDerivedPct()
//    wanneer assetType === 'stock'.
//
// Changes v10.8:
//  - DEFAULT_RISK_BY_TYPE gehalveerd: 0.0015 → 0.00075 (0.075% per trade).
//
// Changes v10.7:
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
  forex:     0.000375,   // 0.0375% per trade (was 0.075% — gehalveerd v10.9)
  stock:     0.000375,   // 0.0375% per trade (was 0.075% — gehalveerd v10.9)
  index:     0.000375,   // 0.0375% per trade (was 0.075% — gehalveerd v10.9)
  commodity: 0.000375,   // 0.0375% per trade (was 0.075% — gehalveerd v10.9)
};

// ================================================================
// ── SL BUFFER MULTIPLIERS ─────────────────────────────────────────
// SL buffer: MT5 SL placed at sl_pct × mult to absorb spread + timing lag.
// Stocks krijgen een dubbele buffer (3.0×) t.o.v. standaard (1.5×)
// omdat stock CFDs op FTMO grotere spreads hebben en anders te snel
// worden uitgetikt door willekeurige spread-pieken.
// ================================================================
const SL_BUFFER_MULT       = 1.5;   // standaard: forex, index, commodity
const STOCK_SL_BUFFER_MULT = 3.0;   // stocks: 2× de standaard buffer

// ================================================================
// ── NY DEAD ZONE ──────────────────────────────────────────────────
// Geen nieuwe trades van 15:30 tot 18:00 Brussels tijd voor
// forex, commodity en stocks. Reden: hoge spread + lage liquiditeit
// in de openingsperiode van de NYSE.
// Indexes zijn NIET geblokkeerd — die volgen eigen NYSE open dynamiek.
// ================================================================
const NY_DEAD_ZONE_START  = 1530;  // 15:30 Brussels — NY dead zone start
const NY_DEAD_ZONE_END    = 1800;  // 18:00 Brussels — NY dead zone end
const NY_NIGHT_START      = 2100;  // 21:00 Brussels — NY night start
const NY_NIGHT_END        = 2400;  // 00:00 Brussels — NY night end (midnight)
const ASIA_MORNING_START  =    0;  // 00:00 Brussels — Asia morning start
const ASIA_MORNING_END    =  200;  // 02:00 Brussels — Asia morning end / Asia proper start

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
  // ── Stocks (US30 = Dow Jones, treated as stock for NY-hours / 15-18u dead zone) ──
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
function getSession(date = null) {
  // FIX stap1: null-safe, correct 3-session logic
  const d = date ?? new Date();
  const { hhmm } = getBrusselsComponents(d);
  // 3 sessions only — no 4th "outside":
  //   ASIA:   02:00–08:00 Brussels
  //   LONDON: 08:00–15:30 Brussels
  //   NY:     15:30–24:00 + 00:00–02:00 Brussels (incl. dead/night/asia-morning sub-blocks)
  if (hhmm >= 200 && hhmm < 800)  return "asia";
  if (hhmm >= 800 && hhmm < 1530) return "london";
  return "ny"; // 15:30–24:00 AND 00:00–02:00 → all ny
}

// Fine-grained sub-session for shadow tracker routing
// Returns block type string used for shadow categorisation
function getSubSession(date = null) {
  const d = date ?? new Date();
  const { hhmm } = getBrusselsComponents(d);
  if (hhmm >= 800  && hhmm < 1530) return "LONDON";
  if (hhmm >= 1530 && hhmm < 1800) return "NY_DEAD_ZONE";    // 15:30–18:00 blocked
  if (hhmm >= 1800 && hhmm < 2100) return "NY_ACTIVE";       // 18:00–21:00 trading
  if (hhmm >= 2100 && hhmm < 2400) return "NY_NIGHT";        // 21:00–00:00 blocked
  if (hhmm >= 0    && hhmm < 200)  return "ASIA_MORNING";    // 00:00–02:00 blocked
  if (hhmm >= 200  && hhmm < 800)  return "ASIA";             // 02:00–08:00 trading
  return "NY"; // fallback
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
//                      MAAR: geblokkeerd 15:30–18:00 (NY dead zone)
// Forex/Commodity:     02:00–21:00 Brussels mon-fri
//                      MAAR: geblokkeerd 15:30–18:00 (NY dead zone)
// Indexes:             02:00–21:00 Brussels mon-fri (geen dead zone)
//
// NY DEAD ZONE (v10.9): 15:30–18:00 Brussels = 13:30–16:00 UTC
// OUTSIDE NIGHT: 21:00–02:00 Brussels — no new signals, overnight positions tracked
// = NYSE open tot 2,5u daarna. Hoge spread, lage liquiditeit voor
// forex + commodities + stocks. Indexes uitgezonderd.
//
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
    // Stocks: NYSE opent om 15:30 Brussels (09:30 ET).
    // Buiten 15:30–21:00 → STOCK_OUTSIDE_MARKET (markt gesloten)
    if (hhmm < NY_DEAD_ZONE_START || hhmm >= 2100) {
      return {
        allowed: false,
        reason:  `STOCK_OUTSIDE_MARKET: ${hhmm} (stocks need 1530–2100 Brussels)`,
      };
    }
    // NY_DEAD_ZONE voor stocks: 15:30–18:00 → shadow tracker (hoge spread opening)
    // Stocks pas tradeable vanaf 18:00 Brussels (12:00 ET = midden NY sessie).
    if (hhmm >= NY_DEAD_ZONE_START && hhmm < NY_DEAD_ZONE_END) {
      return {
        allowed: false,
        reason:  `NY_DEAD_ZONE: ${hhmm} (stocks geblokkeerd 1530–1800 Brussels — opening spread NYSE)`,
      };
    }
  } else if (type === "index") {
    // Indexes: 02:00–21:00 — GEEN dead zone, GEEN night block
    if (hhmm < 200 || hhmm >= 2100) {
      const sub = getSubSession(date);
      return { allowed: false, reason: `${sub}: ${hhmm} (indexes need 0200–2100 Brussels)` };
    }
  } else if (type === "forex" || type === "commodity") {
    // Forex + commodity: blocked tijden (sub-session gebaseerd):
    //   NY_DEAD_ZONE  15:30–18:00 → shadow timezone
    //   NY_NIGHT      21:00–00:00 → shadow timezone  
    //   ASIA_MORNING  00:00–02:00 → shadow timezone
    const sub = getSubSession(date);
    if (sub === "NY_DEAD_ZONE") {
      return { allowed: false, reason: `NY_DEAD_ZONE: ${hhmm} (${type} geblokkeerd 1530–1800 Brussels)` };
    }
    if (sub === "NY_NIGHT") {
      return { allowed: false, reason: `NY_NIGHT: ${hhmm} (${type} geblokkeerd 2100–0000 Brussels)` };
    }
    if (sub === "ASIA_MORNING") {
      return { allowed: false, reason: `ASIA_MORNING: ${hhmm} (${type} geblokkeerd 0000–0200 Brussels)` };
    }
  } else {
    // Onbekend symbooltype — niet in catalog gevonden.
    // Expliciet weigeren i.p.v. silent forex-fallthrough.
    return {
      allowed: false,
      reason:  `UNKNOWN_SYMBOL_TYPE: type="${type}" voor "${rawSymbol}" — niet in SYMBOL_CATALOG`,
    };
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
  asia:         "Asia (02:00–08:00)",
  london:       "London (08:00–15:30)",
  ny:           "New York (15:30–02:00)",
};

// Sub-session labels for shadow tracker UI
const SUB_SESSION_LABELS = {
  LONDON:       "London (08:00–15:30)",
  NY_DEAD_ZONE: "NY Dead Zone (15:30–18:00)",
  NY_ACTIVE:    "NY Active (18:00–21:00)",
  NY_NIGHT:     "NY Night (21:00–00:00)",
  ASIA_MORNING: "Asia Morning (00:00–02:00)",
  ASIA:         "Asia (02:00–08:00)",
};

// Which sub-sessions are blocked (no new trades allowed)
const BLOCKED_SUB_SESSIONS = new Set([
  "NY_DEAD_ZONE",
  "NY_NIGHT",
  "ASIA_MORNING",
]);

// ── Data quality compliance date (FIX 8: single source of truth) ────
// Alle stats (EV, ghost, shadow, signals) filteren op opened_at/closed_at >= deze datum.
// Aanpasbaar via POST /compliance-date (beveiligd met WEBHOOK_SECRET).
// v13.3: compliance date restriction verwijderd — alle data doorloopt vrij.
// Selectieve datumfilter zit nu in het dashboard (Ghost History from/to picker).
const COMPLIANCE_DATE    = '2000-01-01 00:00:00';
const COMPLIANCE_DATE_MS = new Date('2000-01-01T00:00:00.000Z').getTime();

module.exports = {
  COMPLIANCE_DATE,
  COMPLIANCE_DATE_MS,
  SYMBOL_CATALOG,
  SYMBOL_ALIASES,
  DEFAULT_RISK_BY_TYPE,
  SESSION_LABELS,
  TIMEZONE,
  SL_BUFFER_MULT,
  STOCK_SL_BUFFER_MULT,
  NY_DEAD_ZONE_START,
  NY_DEAD_ZONE_END,
  NY_NIGHT_START,
  NY_NIGHT_END,
  ASIA_MORNING_START,
  ASIA_MORNING_END,
  SUB_SESSION_LABELS,
  BLOCKED_SUB_SESSIONS,
  getSubSession,
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
