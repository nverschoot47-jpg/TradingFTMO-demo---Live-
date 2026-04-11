// ===============================================================
// session.js  -  Timezone + Sessie helpers  |  v7.1
// Automatische zomer/wintertijd via Intl API (geen hardcoded +1h)
//   Winter -> CET  = UTC+1
//   Zomer  -> CEST = UTC+2
//
// Wijzigingen v7.1 (t.o.v. v7.0):
//  [OK] getBrusselsComponents()  -  accepteert nu ook string/number date input
//     Fix: was (date instanceof Date) ? date : new Date() -> negeerde strings
//     Nu:  date ? new Date(date) : new Date()   -  consistent met getBrusselsDateOnly
//  [OK] isMarketOpen()  -  optionele `date` parameter toegevoegd voor testbaarheid
//     Voorheen altijd "nu"; nu testbaar met historische of gesimuleerde tijden
// ===============================================================

"use strict";

const TIMEZONE = "Europe/Brussels";

const DAYS_MAP = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

/**
 * Geeft { day, hhmm, hour, minute } in Brussels lokale tijd terug.
 *
 * @param {Date|string|number|null} date  optioneel, default = now
 */
function getBrusselsComponents(date) {
  // [v7.1] Fix: was (date instanceof Date) ? date : new Date()
  // -> string/number input werd genegeerd, altijd new Date() gebruikt.
  // Nu consistent met getBrusselsDateOnly().
  const d = date ? new Date(date) : new Date();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday:  "long",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
  }).formatToParts(d);

  const get = (type) => parts.find(p => p.type === type)?.value ?? "0";

  let hour     = parseInt(get("hour"),   10);
  const minute = parseInt(get("minute"), 10);
  if (hour === 24) hour = 0;

  const weekday = get("weekday");
  const day     = DAYS_MAP[weekday] ?? 0;

  return { day, hhmm: hour * 100 + minute, hour, minute };
}

/**
 * Leesbare datum/tijd string in Brussels tijdzone.
 */
function getBrusselsDateStr() {
  return new Intl.DateTimeFormat("nl-BE", {
    timeZone:  TIMEZONE,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date());
}

/**
 * [v7.0] Geeft de huidige (of opgegeven) datum als YYYY-MM-DD
 * in Brussels tijdzone.
 *
 * Vervangt ALLE uses van:
 *   new Date().toISOString().split("T")[0]
 *
 * Reden: UTC midnight != Brussels midnight. Een trade gesloten om
 * 23:30 Brussels (= 21:30 UTC winter) werd onder de verkeerde
 * UTC-dag geboekt. Brussels midnight is de correcte grens.
 *
 * @param {Date|string|number|null} date  optioneel, default = now
 * @returns {string}  "YYYY-MM-DD" in Brussels tijd
 */
function getBrusselsDateOnly(date) {
  const d = date ? new Date(date) : new Date();
  // en-CA locale geeft altijd YYYY-MM-DD formaat
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
  }).format(d);
}

const SESSION_LABELS = {
  asia:           "Asia (02:00-08:00)",
  london:         "London (08:00-15:30)",
  ny:             "New York (15:30-20:00)",
  buiten_venster: "Buiten venster",
};

/**
 * Geeft de handelssessie op basis van een tijdstip (of nu).
 *
 * @param {Date|string|number|null} dateOrStr  optioneel, default = now
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
 * Controleert of de markt open is voor nieuwe TRADES (nieuwe orders).
 * Geen nieuwe trades na 20:00  -  geldt voor alle types behalve crypto weekend.
 *
 * Vensters (Brussels tijd):
 *   - Alle types behalve stock: 02:00-20:00 (ma-vr)
 *   - Stocks: alleen 15:30-20:00 (NY venster)
 *   - Crypto: ook weekend 02:00-20:00
 *
 * [v7.1] Optionele `date` parameter voor testbaarheid.
 *
 * @param {string}   type               asset type (bijv. "stock", "crypto", ...)
 * @param {string}   symbol             MT5 symbool
 * @param {Function} isCryptoWeekendFn  functie (symbol) => boolean
 * @param {Date|string|number|null} date optioneel, default = now
 */
function isMarketOpen(type, symbol, isCryptoWeekendFn, date = null) {
  const { day, hhmm } = getBrusselsComponents(date);
  const isWE = day === 0 || day === 6;

  if (isWE) {
    if (!isCryptoWeekendFn(symbol || "")) {
      console.warn(`🚫 Weekend  -  ${symbol} geblokkeerd`);
      return false;
    }
    if (hhmm < 200 || hhmm >= 2000) {
      console.warn(`🚫 Weekend crypto buiten 02:00-20:00 (${hhmm})`);
      return false;
    }
    return true;
  }

  if (hhmm < 200)   { console.warn(`🚫 Voor 02:00 (${hhmm})`);   return false; }
  if (hhmm >= 2000) { console.warn(`🚫 Na 20:00  -  geen nieuwe trades (${hhmm})`); return false; }

  if (type === "stock" && hhmm < 1530) {
    console.warn(`🚫 Aandelen buiten 15:30-20:00 (${hhmm})`);
    return false;
  }

  return true;
}

/**
 * [v5.2] Controleert of ghost tracking nog actief mag zijn.
 * Ghost trading loopt door tot 22:00 (na auto-close van 21:50).
 * Stopt NIET bij 20:00  -  alleen bij SL phantom trigger of 22:00.
 *
 * @param {Date|string|number|null} date  optioneel, default = now
 */
function isGhostActive(date) {
  const d = date ? new Date(date) : new Date();
  const { day, hhmm } = getBrusselsComponents(d);
  const isWE = day === 0 || day === 6;
  if (isWE) return false;        // geen ghost in weekend
  if (hhmm < 200)  return false; // voor dagstart
  if (hhmm >= 2200) return false; // na 22:00 hard stop
  return true;
}

/**
 * [v5.2] Controleert of shadow optimizer actief mag zijn.
 * Zelfde tijdvenster als ghost: stopt om 22:00.
 *
 * @param {Date|string|number|null} date  optioneel, default = now
 */
function isShadowActive(date) {
  return isGhostActive(date);
}

module.exports = {
  getBrusselsComponents,
  getBrusselsDateStr,
  getBrusselsDateOnly,
  getSessionGMT1,
  isMarketOpen,
  isGhostActive,
  isShadowActive,
  SESSION_LABELS,
  TIMEZONE,
};
