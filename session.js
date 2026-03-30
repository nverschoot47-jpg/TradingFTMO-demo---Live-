// ═══════════════════════════════════════════════════════════════
// session.js — Trading sessie detectie (GMT+1)  |  v3.8
//
// Sessies (aangepast aan FTMO handelsvenster):
//   Asia    : 02:00 – 08:00 GMT+1
//   London  : 08:00 – 15:30 GMT+1
//   New York: 15:30 – 20:00 GMT+1
//
// Buiten deze vensters = "buiten_venster"
// (FTMO handelsvenster loopt van 02:00 tot 20:00 GMT+1)
// ═══════════════════════════════════════════════════════════════

function getGMT1Time(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  return new Date(d.getTime() + 3600 * 1000);
}

function getSession(dateInput) {
  const d    = getGMT1Time(dateInput);
  const hhmm = d.getUTCHours() * 100 + d.getUTCMinutes();
  if (hhmm >= 200  && hhmm < 800)  return "asia";
  if (hhmm >= 800  && hhmm < 1530) return "london";
  if (hhmm >= 1530 && hhmm < 2000) return "ny";
  return "buiten_venster";
}

const SESSION_LABELS = {
  asia:           "Asia (02:00–08:00 GMT+1)",
  london:         "London (08:00–15:30 GMT+1)",
  ny:             "New York (15:30–20:00 GMT+1)",
  buiten_venster: "Buiten venster",
};

function getSessionLabel(session) {
  return SESSION_LABELS[session] || session;
}

module.exports = { getSession, getSessionLabel, SESSION_LABELS };
