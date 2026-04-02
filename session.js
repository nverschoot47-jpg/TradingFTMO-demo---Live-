// ═══════════════════════════════════════════════════════════════
// session.js — Timezone + Sessie helpers  |  v4.1
// Automatische zomer/wintertijd via Intl API (geen hardcoded +1h)
//   Winter → CET  = UTC+1
//   Zomer  → CEST = UTC+2
// ═══════════════════════════════════════════════════════════════

"use strict";

const TIMEZONE = "Europe/Brussels";

const DAYS_MAP = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

/**
 * Geeft { day, hhmm, hour, minute } in Brussels lokale tijd terug.
 * Verwerkt CET (winter, UTC+1) en CEST (zomer, UTC+2) automatisch.
 * @param {Date|null} date  – standaard new Date()
 * @returns {{ day: number, hhmm: number, hour: number, minute: number }}
 */
function getBrusselsComponents(date) {
  const d = (date instanceof Date) ? date : new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday:  "long",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
  }).formatToParts(d);

  const get = (type) => parts.find(p => p.type === type)?.value ?? "0";

  let hour   = parseInt(get("hour"),   10);
  const minute = parseInt(get("minute"), 10);

  // Sommige Intl-implementaties geven 24 terug voor middernacht – normaliseer
  if (hour === 24) hour = 0;

  const weekday = get("weekday");
  const day     = DAYS_MAP[weekday] ?? 0;

  return { day, hhmm: hour * 100 + minute, hour, minute };
}

/**
 * Geeft de huidige tijd terug als leesbare string in Brussels tijdzone.
 * @returns {string}  bijv. "02/04/2026 09:31:15"
 */
function getBrusselsDateStr() {
  return new Intl.DateTimeFormat("nl-BE", {
    timeZone:  TIMEZONE,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date());
}

// ── Sessie labels ──────────────────────────────────────────────
const SESSION_LABELS = {
  asia:           "Asia (02:00–08:00)",
  london:         "London (08:00–15:30)",
  ny:             "New York (15:30–20:00)",
  buiten_venster: "Buiten venster",
};

/**
 * Geeft de huidige of historische handelssessie terug.
 * @param {Date|string|null} dateOrStr
 * @returns {"asia"|"london"|"ny"|"buiten_venster"}
 */
function getSessionGMT1(dateOrStr) {
  const d = dateOrStr ? new Date(dateOrStr) : new Date();
  const { hhmm } = getBrusselsComponents(d);
  if (hhmm >= 200  && hhmm < 800)  return "asia";
  if (hhmm >= 800  && hhmm < 1530) return "london";
  if (hhmm >= 1530 && hhmm < 2000) return "ny";
  return "buiten_venster";
}

/**
 * Controleert of de markt open is voor het opgegeven instrument type.
 * @param {"index"|"forex"|"gold"|"stock"|"crypto"|"brent"|"wti"} type
 * @param {string} symbol
 * @param {function(string): boolean} isCryptoWeekendFn
 * @returns {boolean}
 */
function isMarketOpen(type, symbol, isCryptoWeekendFn) {
  const { day, hhmm } = getBrusselsComponents();
  const isWE = day === 0 || day === 6;

  if (isWE) {
    if (!isCryptoWeekendFn(symbol || "")) {
      console.warn(`🚫 Weekend — ${symbol} geblokkeerd`);
      return false;
    }
    if (hhmm < 200 || hhmm >= 2000) {
      console.warn(`🚫 Weekend crypto buiten 02:00–20:00 (${hhmm})`);
      return false;
    }
    return true;
  }

  if (hhmm < 200)   { console.warn(`🚫 Voor 02:00 (${hhmm})`);        return false; }
  if (hhmm >= 2000) { console.warn(`🚫 Na 20:00 (${hhmm})`);          return false; }
  if (type === "stock" && hhmm < 1530) {
    console.warn(`🚫 Aandelen buiten 15:30–20:00 (${hhmm})`);
    return false;
  }
  return true;
}

module.exports = {
  getBrusselsComponents,
  getBrusselsDateStr,
  getSessionGMT1,
  isMarketOpen,
  SESSION_LABELS,
  TIMEZONE,
};
