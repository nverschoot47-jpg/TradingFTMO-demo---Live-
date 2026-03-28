// ═══════════════════════════════════════════════════════════════
// session.js — Trading sessie detectie (UTC gebaseerd)
//
// Asia    : 00:00 – 08:00 UTC
// London  : 07:00 – 16:00 UTC  (overlap met Asia 07-08)
// New York: 13:00 – 22:00 UTC  (overlap met London 13-16)
// Overlap London/NY is eigen categorie — vaak meest volatiel
// ═══════════════════════════════════════════════════════════════

function getSession(dateInput) {
  const d    = dateInput ? new Date(dateInput) : new Date();
  const hour = d.getUTCHours(); // 0–23

  // London/NY overlap — meest volatiel, apart bijhouden
  if (hour >= 13 && hour < 16) return "overlap_lndy";

  if (hour >= 7  && hour < 16) return "london";
  if (hour >= 13 && hour < 22) return "new_york";
  if (hour >= 22 || hour < 7)  return "asia";

  return "asia"; // fallback
}

// Geeft een leesbaar label terug voor in rapporten
function getSessionLabel(session) {
  return {
    asia:          "🌏 Asia        (00–07 UTC)",
    london:        "🇬🇧 London      (07–16 UTC)",
    overlap_lndy:  "⚡ LDN/NY Overlap (13–16 UTC)",
    new_york:      "🗽 New York     (13–22 UTC)",
  }[session] || session;
}

module.exports = { getSession, getSessionLabel };