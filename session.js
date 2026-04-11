// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// session.js \u2014 Timezone + Sessie helpers  |  v7.1
// Automatische zomer/wintertijd via Intl API (geen hardcoded +1h)
//   Winter \u2192 CET  = UTC+1
//   Zomer  \u2192 CEST = UTC+2
//
// Wijzigingen v7.1 (t.o.v. v7.0):
//  \u2705 getBrusselsComponents() \u2014 accepteert nu ook string/number date input
//     Fix: was (date instanceof Date) ? date : new Date() \u2192 negeerde strings
//     Nu:  date ? new Date(date) : new Date()  \u2014 consistent met getBrusselsDateOnly
//  \u2705 isMarketOpen() \u2014 optionele `date` parameter toegevoegd voor testbaarheid
//     Voorheen altijd "nu"; nu testbaar met historische of gesimuleerde tijden
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

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
  // \u2192 string/number input werd genegeerd, altijd new Date() gebruikt.
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
 * [v7.0