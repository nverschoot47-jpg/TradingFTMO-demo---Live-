// ═══════════════════════════════════════════════════════════════
// session.js — Trading sessie detectie (GMT+1)
//
// Asia         : 00:00 – 08:00 GMT+1
// London       : 08:00 – 15:30 GMT+1
// LDN/NY Overlap: 15:30 – 17:00 GMT+1
// New York     : 17:00 – 00:00 GMT+1
// ═══════════════════════════════════════════════════════════════

function getGMT1Time(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  return new Date(d.getTime() + 1 * 3600 * 1000);
}

function getSession(dateInput) {
  const d    = getGMT1Time(dateInput);
  const hhmm = d.getUTCHours() * 100 + d.getUTCMinutes();

  if (hhmm >= 1530 && hhmm < 1700) return "overlap_lndy";
  if (hhmm >= 800  && hhmm < 1530) return "london";
  if (hhmm >= 1700 && hhmm < 2400) return "new_york";

  return "asia"; // 00:00 – 08:00
}

function getSessionLabel(session) {
  return {
    asia:         "🌏 Asia          (00:00–08:00 GMT+1)",
    london:       "🇬🇧 London        (08:00–15:30 GMT+1)",
    overlap_lndy: "⚡ LDN/NY Overlap (15:30–17:00 GMT+1)",
    new_york:     "🗽 New York       (17:00–00:00 GMT+1)",
  }[session] || session;
}

module.exports = { getSession, getSessionLabel };