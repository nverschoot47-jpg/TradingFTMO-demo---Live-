// ===============================================================
// server.js  v12.6.0  |  PRONTO-AI
// TradingView → MetaApi REST → FTMO MT5
//
// v12.4.0 — STABILITY FIXES (30 April 2026):
//
//  FIX 1 — closeReason detectie met tolerantie + maxRR fallback:
//    handlePositionClosed() gebruikt nu 5% SL-afstand als tolerantie
//    om spread/requote variatie op te vangen. Secundaire check op
//    maxRR < 0.05R classificeert twijfelgevallen als "sl".
//    Voorkomt dat SL-hits als "manual" geclassificeerd worden →
//    GH1 (ghost stoppen) en recalcLotsAfterSL triggeren nu correct.
//
//  FIX 2 — derivedSlPct validatie aangepast voor stock 3× buffer:
//    Maximale TV SL is nu 5% / slBufferForType:
//      Stocks (×3.0): max 1.67% TV SL → max 5.0% MT5 SL
//      Overige (×1.5): max 3.33% TV SL → max 5.0% MT5 SL
//    Voorkomt extreme MT5 SL bij grote TV SL op stocks.
//
//  FIX 4 — deals tabel aangemaakt + MetaAPI history-deals integratie:
//    deals tabel in DB voor commission + swap + profit per positie.
//    fetchAndSaveDealsForPosition() haalt /history-deals/time op na
//    elke SL/TP close en slaat deals op via saveDeal().
//    fetchRealizedPnl() berekent nu netto P&L = profit + commission + swap.
//    handlePositionClosed() roept fetchAndSaveDealsForPosition() aan
//    vóór fetchRealizedPnl() zodat de waarde altijd correct is.
//
//  FIX 5 — Stocks NY dead zone verduidelijkt: effectief 16:00–18:00:
//    Stocks starten pas om 16:00; dead zone blokkering 16:00–18:00.
//    Stocks zijn tradebaar vanaf 18:00 Brussels (12:00 ET).
//    Comment in session.js verduidelijkt de intentie.
//
//  FIX 8 — evMult/dayMult in openPositions bijgewerkt na nightly optimizer:
//    evaluateDailyRisk() update na afloop pos.evMult/pos.dayMult voor alle
//    open posities zodat ghost_state periodic save actuele multipliers opslaat.
//
//  FIX 9 — liveBalance cold start fix:
//    Default balance is nu 0 (was 50000). getLiveBalance() probeert tot
//    3× MT5 te bereiken bij cold start. Laatste fallback: 100000 met waarschuwing.
//    Voorkomt verkeerde lot berekeningen in de eerste minuten na deploy.
//
//  FIX 10 — Spread guard voor stocks gebruikt ongebufferde SL-afstand:
//    Was: spread > 0.25 × buffered SL dist (3× te groot door STOCK_SL_BUFFER_MULT)
//    Nu:  spread > 0.25 × unbuffered SL dist (derivedSlPct × executionPrice)
//    Spread guard is nu weer even streng als voor de 3× buffer introductie.
//
//  FIX 11 — recalcLotsAfterSL dead code verwijderd:
//    Functie berekende baseLots na SL-hit maar sloeg niets op (lotOverrides
//    verwijderd in v11.0). Aanroep in handlePositionClosed ook verwijderd.
//
//  FIX 12 — stopReason "timeout_72h" gecorrigeerd naar "timeout_2w":
//    GHOST_MAX_MS is 14 dagen. 04:00 cleanup cron logt nu "timeout_2w".
//    DB-records die al "timeout_72h" bevatten zijn niet geraakt (geen migratie).
//
//  FIX 14 — evaluateDailyRisk DB-fallback bij lege closedTrades array:
//    Na een deploy midden op de dag is closedTrades[] leeg. De 02:00 cron
//    evaluateDailyRisk() miste dan alle trades van die dag voor keyRiskMult.
//    Nu: DB-query fallback als in-memory array 0 trades voor vandaag toont.
//
// v12.4.0 — RISK HALVED + NY DEAD ZONE + STOCK 2× SL + GHOST FIXES (30 April 2026):
//
//  FIX R2 — Risk nogmaals gehalveerd 0.075% → 0.0375% (alle asset types):
//    FIXED_RISK_PCT default: 0.00075 → 0.000375.
//    DEFAULT_RISK_BY_TYPE in session.js ook gehalveerd.
//    Reden: verder risicobeperking zodat nooit manueel gesloten hoeft te worden.
//    Env var FIXED_RISK_PCT overschrijft nog steeds (Railway).
//
//  FIX NY — NY Dead Zone blokkering 15:30–18:00 Brussels:
//    canOpenNewTrade() in session.js blokkeert nu forex, commodity en stocks
//    van 15:30 tot 18:00 Brussels tijd (= NYSE open tot 2,5u daarna).
//    Reden: hoge spread + lage liquiditeit direct na NYSE open.
//    Indexes (DE30EUR, NAS100USD, UK100GBP, US30USD) zijn NIET geblokkeerd.
//    Reject label: NY_DEAD_ZONE in signal_log.
//
//  FIX SK — Stocks krijgen 2× SL buffer (3.0× totaal, was 1.5×):
//    calcSLFromDerivedPct() gebruikt nu STOCK_SL_BUFFER_MULT=3.0 voor stocks
//    in plaats van de standaard SL_BUFFER_MULT=1.5.
//    Reden: stock CFDs hebben grotere spreads en worden te snel uitgetikt.
//    Lot sizing herberekent op de bredere SL-afstand → zelfde riskEUR.
//
//  FIX GH1 — Ghost stopt nu correct bij echte SL-hit:
//    handlePositionClosed() roept nu finalizeGhost() aan bij closeReason==="sl".
//    Voorheen bleef de ghost doorlopen terwijl de trade al gesloten was.
//    stopReason: "real_sl_hit" in ghost_trades.
//
//  FIX GH2 — ghost_state slaat slPct/riskEUR/evMult/dayMult op:
//    restorePositionsFromMT5() leest nu ook riskPct, riskEUR, evMult, dayMult
//    terug uit ghost_state zodat dashboard na restart de juiste risk% toont.
//    ghost_state tabel krijgt ADD COLUMN IF NOT EXISTS migrations in db.js.
//
// v12.2.0 — RISK HALVING + DAX FIX + GHOST SL MILESTONES (28 April 2026):
//
//  FIX R — Risk gehalveerd 0.15% → 0.075% (alle asset types):
//    DEFAULT_RISK_BY_TYPE en FIXED_RISK_PCT gehalveerd.
//    Reden: te veel losses waardoor manueel sluiten nodig was.
//    Env var FIXED_RISK_PCT overschrijft nog steeds (Railway).
//
//  FIX D — DAX/GER40 lotsize inconsistentie (0.6RR / 10RR bug):
//    fetchSymbolLotValue() valideert nu live MT5 lotVal vs bekende
//    LOT_VALUE_BY_MT5 fallback voor indexes. Als ratio buiten 0.5–2.0×
//    valt → MT5 spec verworpen, veilige fallback gebruikt.
//    Symptoom was: MetaApi gaf soms verkeerde tickValue voor GER40.cash
//    waardoor calcLots() extreme lots berekende → RR van 0.6 of 10+.
//
//  FIX G3 — Ghost tracker SL milestones (25/50/75/100%):
//    Ghost tick registreert nu het exacte tijdstip van eerste
//    overschrijding van elk SL-drempel (25/50/75/100% van SL-afstand).
//    Opgeslagen in ghost_trades.sl_milestones (JSONB).
//    Live ghost tabel toont T→25% / T→50% / T→75% / T→100% kolommen.
//    Vervangt de "Time to SL" extrapolatie kolom.
//
//  FIX G4 — Ghost maxRR en SL% fix bij manueel sluiten:
//    slMilestones worden meegestuurd bij finalizeGhost() → saveGhostTrade().
//    /live/ghosts response bevat nu ook slMilestones voor live display.
//
//  FIX EV — EV Optimizer "0 ghosts / 424 totaal" verwarring opgelost:
//    Labels verduidelijkt: "Met ghost data (≥1 ghost)" / "Zonder ghost data".
//    Meta-text toont totaal # ghost trades over actieve combos.
//    Compliance-stat badge toont datum van eerste geldige ghost data.
//    Uitleg: ghost data = phantom SL hits ná compliance datum 27/04/2026.
//
// v12.1.3 — GHOST TRACKER maxRR FIX + BLOCKED TRADES DASHBOARD (27 April 2026):
//
//  FIX G1 — Ghost tick maxPrice sync:
//    Ghost tick neemt nu de BESTE prijs van 3 bronnen:
//    1. fetchCurrentPrice() (eigen MT5 call)
//    2. openPositions[id].maxPrice (bijgehouden door syncOpenPositions elke 55s)
//    3. openPositions[id].currentPrice (actuele prijs)
//    Gunstige pieken die tussen ghost ticks (30s) vielen worden nu niet meer gemist.
//
//  FIX G2 — /live/ghosts maxRR display:
//    Dashboard endpoint gebruikt nu ook bestMaxPrice (beste van g.maxPrice
//    en openPositions.maxPrice) voor eerlijke maxRR weergave.
//
//  NEW B1 — Blocked signals teller in dashboard:
//    Trade Stats sectie toont nu een tweede blok met geblokkeerde signalen:
//    totaal geblokt + opdeling per reject-reden categorie.
//    Telt vanuit signals_log tabel (outcome=REJECTED/BLOCKED/SKIPPED).
//
// v12.1 — BUGFIXES + REJECTS ENDPOINT (27 April 2026):
//
//  FIX S1 — loadAllShadowAnalysis "column optimizer_key does not exist":
//    db.js voegt nu ADD COLUMN IF NOT EXISTS migrations toe voor alle
//    kolommen van shadow_sl_analysis inclusief optimizer_key.
//    saveShadowAnalysis() accepteert nu beide call-formaten correct
//    (runShadowOptimizer output vs loadShadowSnapshots output).
//
//  FIX S2 — bid/ask null na restart:
//    syncOpenPositions() haalt nu ook bid/ask/spread op voor posities
//    die nog geen bid/ask hadden (bijv. na server restart).
//    Eenmalig per positie bij de eerste sync — geen extra belasting.
//
//  NEW — GET /signal-stats/rejects:
//    Breakdown van alle niet-genomen trades per outcome + symbol +
//    direction. Toont: duplicate pairs, VWAP exhaustion, outside window,
//    duplicate entry when open, currency budget exhausted — met counts.
//    Handig voor post-sessie analyse en dashboard reject tabel.
//
// (alle v12.0 en eerder fixes blijven actief — zie v12.0 header)
// ===============================================================
//
//  FIX C1 — local_ positionId guard:
//    Als MetaApi geen positionId teruggeeft na placeOrder(), genereert de
//    server een fake local_${Date.now()} ID. Alle vervolgcalls faalden dan
//    met HTTP 404 en de trade werd toch opgeslagen als 0.00R phantom entry
//    in de TP Optimiser. Nieuw: na 2.5s wacht, zoek echte positie op MT5
//    o.b.v. symbol + richting + geopend < 30s geleden.
//    Gevonden → gebruik echt ID en ga door.
//    Niet gevonden → ORDER_NOT_CONFIRMED return (geen DB opslaan, geen ghost).
//
//  FIX C3 — NaN sanitizer in TV payload:
//    TradingView stuurt soms NaN voor session_high/low (forex + stocks).
//    JSON.parse() faalt op NaN → signaal verloren. Middleware vervangt
//    nu :NaN door :0 vóór parse. session_high/low worden toch niet
//    gebruikt in EV-berekening — veilig om 0 te zetten.
//
//  FIX C2 — Stock volume step (ZM, AAPL, TSLA, etc.):
//    calcLots() rondde altijd af op 0.01 stap. Stocks hebben minLot=1 en
//    volumeStep=1 (hele aandelen). MT5/FTMO weigerde volumes als 432.82.
//    fetchSymbolLotValue() slaat nu ook minVolume en volumeStep op uit spec.
//    calcLots() rondt af via floor naar volumeStep:
//      stocks: 432.82 → 432 lots (hele aandelen)
//      forex:  0.726  → 0.72 lots (0.01 stap, ongewijzigd gedrag)
//    minVolume gebruikt als ondergrens (ipv hardcoded 0.01).
//
// v11.2 — UK100 RISK FIX + VWAP BAND THRESHOLD (20 April 2026):
//
//  FIX A — vwapBandPct threshold: 0.9 → 1.5 (150%):
//    Channel break strategie genereert signals buiten de VWAP band.
//    Threshold van 90% blokkeerde bijna alle UK100 trades.
//    Verhoogd naar 150% — alleen extreme uitschieters (>1.5× halve band)
//    worden nog geblokkeerd met VWAP_BAND_EXHAUSTED.
//
//  FIX B — UK100 lotVal fallback gecorrigeerd:
//    LOT_VALUE[index] = 20 was fout voor UK100.cash (FTSE 100 CFD).
//    Echte lotVal = 1 GBP/punt/lot op FTMO MT5.
//    Nieuw: LOT_VALUE_BY_MT5 map met per-symbol fallbacks:
//      UK100.cash = 1, GER40.cash = 1, US100.cash = 1, US30.cash = 1.
//    fetchSymbolLotValue() gebruikt deze map vóór de generieke LOT_VALUE.
//    Bij actieve MT5 connectie prevaleert altijd de live spec (ongewijzigd).
//    recalcLotsAfterSL() en rebuildCurrencyExposure() ook bijgewerkt.
//
// v11.1 — BUG FIXES (20 April 2026):
//
//  FIX 1 — vwapPosition hersteld bij server restart:
//    restorePositionsFromMT5() parsete vpPos hardcoded als "unknown".
//    Nu wordt vwapPosition geparsed uit de MT5 comment string via
//    parseVwapFromComment(). Comment formaat: NV-{dir}-{sym}-{A|B|U}-{rr}-{sess}.
//    A=above, B=below, U=unknown. OptKey en ghost tracker gebruiken
//    de juiste vwapPosition na restart → VWAP-tag correct in dashboard.
//
//  FIX 2 — Ghost tracker eerste tick delay 3s:
//    Ghost startte onmiddellijk na placeOrder(). MetaApi had de positie
//    nog niet geregistreerd → eerste SL/TP modify mislukte met HTTP 404.
//    GHOST_INITIAL_DELAY_MS = 3000ms vóór de eerste tick.
//    Vervolgende ticks gebruiken GHOST_POLL_MS (30s) zoals voorheen.
//
//  FIX 3 — TP Optimiser: filter op openedAt ≥ 2026-04-20T12:00 + status closed:
//    Dashboard loadOverview() filterde op closedAt ≥ 2026-04-18.
//    Gecorrigeerd naar: openedAt ≥ 2026-04-20T12:00:00Z AND closedAt IS NOT NULL.
//    Trades die nog open staan (closedAt null) worden uitgesloten.
//    Trades geopend vóór 12u op 20/04/2026 worden uitgesloten.
//    Alleen in de dashboard-side filter — geen DB wijziging nodig.
//
// v11.0 — RISK SIZING FIXES (20 April 2026):
//
//  FIX R1 — getOptimalTP() altijd DEFAULT_TP_RR = 2.0R bij geen data:
//    Geen asset type cap. Zolang er geen EV-data is (< 5 ghosts),
//    wordt altijd 2.0R gebruikt als TP target voor alle asset types.
//    Zodra er voldoende ghosts zijn, pakt de EV optimizer het beste
//    RR niveau en wordt dat gelockt via updateTPLock().
//    De TP lock is de enige bron van truth voor EV+ combos.
//
//  FIX R2 — calcLots() min lot warning:
//    Als rawLots < 0.01 → clamped naar 0.01 maar console.warn
//    toont inflatedRisk vs riskEUR (+% inflatie) zodat het
//    dashboard niet stilletjes verkeerde risk toont.
//
//  FIX R3 — actualRiskEUR in /live/positions gebruikt live symbolSpecCache:
//    Primair: symbolSpecCache[mt5Sym].lotVal (live van MT5).
//    Fallback: LOT_VALUE[type] (statisch). Indexes tonen nu
//    correcte werkelijke exposure (niet 23× te laag).
//
//  FIX R4 — lotDivisor anti-consolidation VERWIJDERD:
//    lotDivisor was bedoeld voor currency correlatie maar
//    zorgt voor inconsistente lotgroottes. Verwijderd uit
//    alle lot berekeningen → uniform 0.15% risk per trade.
//
//  FIX R5 — Step C2 post-execution lot herberekening:
//    lotDivisor verwijderd. scaleFactor reductie ook verwijderd
//    voor EV+ trades. Alleen forex EV-neutraal krijgt nog
//    currency budget check (scaleFactor ≤ 1.0).
//
//  GENOTEERD (later fixen):
//    Alle pairs draaien momenteel op inconsistente riskPct.
//    getSymbolRiskPct resolvet via env var → DB → DEFAULT_RISK_BY_TYPE
//    → FIXED_RISK_PCT. Fix = uniforme configuratie per type zonder
//    losse env overrides, of een aparte reconcile-run.
//
// v10.6 — FUNDAMENTELE CORRECTIES (19 April 2026):
//
//  MULT CORRECTIE —
//    riskEUR = balance × FIXED_RISK_PCT  (puur, geen evMult).
//    evMult + dayMult worden VERWIJDERD uit calcRiskEUR().
//    Lotsize sequentieel: baseLots = riskEUR / (dist × lotVal)
//      → finalLots = baseLots × evMult × dayMult  (voor EV+ trades)
//      → finalLots = baseLots × scaleFactor        (voor EV neutraal)
//    Budget check: finalLots × dist × lotVal = werkelijke EUR-exposure.
//
//  FIX A — Server berekent derivedSlPct van TV absolute prijzen:
//    payload bevat entry_price + sl_price (absolute MT5 prijzen).
//    server berekent: derivedSlPct = |entry_price - sl_price| / entry_price.
//    Validatie: derivedSlPct > 0 EN ≤ 0.05, anders hard reject.
//    MT5 SL: executionPrice × (1 ± derivedSlPct × SL_BUFFER_MULT).
//
//  FIX C — Currency Exposure Budget + Anti-consolidation:
//    EV+ trades (evMult > 1.0): geen budget check, volle lots.
//    EV neutraal (evMult = 1.0): beide valuta's tellen mee in budget.
//    CURRENCY_BUDGET_PCT env var (default 0.02 = 2% van balance).
//    scaleFactor beperkt lots bij budget exhaustion.
//    Anti-consolidation: zelfde symbol+sessie+richting → modifyPosition()
//      SL ×1.5 cumulatief op huidige MT5 SL + TP herberekend, geen nieuwe trade.
//
//  FIX D — TP Floor Guard:
//    Na calcTPPrice(), vóór order naar MT5.
//    minTPDist = |executionPrice - mt5SL| × MIN_TP_RR_FLOOR.
//    TP gecorrigeerd zodat afstand ≥ minTPDist.
//
//  FIX E — RR Verificatie met echte MT5 data:
//    Na TP Floor Guard: actualSLPct + actualTPRR gecontroleerd.
//    SL op verkeerde kant → emergency close + ghost tracker start.
//    closeReason: "RR_VERIFY_FAILED", excludeFromEV: true.
//    Overige checks: SL_TOO_WIDE (>5%) + TP_RR_TOO_LOW (<0.3R) → log only.
//    ORDER_PLACED log uitgebreid met derivedSlPct, actualSLPct, actualTPRR.
//
// (alle v10.5 fixes blijven actief — zie v10.5 header)
// ===============================================================

"use strict";

const express = require("express");
const helmet  = require("helmet");
const cron    = require("node-cron");

const app = express();
// Trust Railway proxy (X-Forwarded-* headers)
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false, // Dashboard-only, niet nodig voor webhook
}));
// express.json() parset alleen Content-Type: application/json.
// TradingView stuurt webhooks soms als Content-Type: text/plain.
// express.text() vangt dit op en we parsen het handmatig als JSON.
app.use(express.json());
app.use(express.text({ type: "text/plain" }));

// Middleware: parse text/plain body als JSON wanneer nodig.
// TradingView webhook body is altijd JSON-string, maar Content-Type kan text/plain zijn.
// FIX C3 (v11.3): TV stuurt soms NaN als waarde (bv. session_high:NaN, session_low:NaN).
// NaN is geen geldig JSON — vervang :NaN door :0 vóór de parse zodat signalen niet verloren gaan.
app.use((req, res, next) => {
  if (typeof req.body === "string" && req.body.trim().startsWith("{")) {
    try {
      const sanitized = req.body.replace(/:NaN\b/g, ":0");
      if (sanitized !== req.body) {
        console.warn("[BodyParse] NaN waarden vervangen door 0 in TV payload (session_high/low reset)");
      }
      req.body = JSON.parse(sanitized);
      console.log("[BodyParse] text/plain body geparsed als JSON OK");
    } catch (e) {
      console.warn("[BodyParse] text/plain body kon niet geparsed worden:", e.message, "raw:", req.body.slice(0, 200));
    }
  }
  next();
});

// ── DB & Session imports ─────────────────────────────────────────
const {
  initDB, saveTrade, loadAllTrades,
  saveGhostTrade, loadGhostTrades, countGhostsByKey,
  saveGhostState, loadAllGhostStates, deleteGhostState,
  saveBandGhost, loadBandGhosts, loadBandGhostStats,
  saveShadowSnapshot, loadShadowSnapshots, saveShadowAnalysis, loadShadowAnalysis,
  loadAllShadowAnalysis,
  saveTPConfig, loadTPConfig,
  savePnlLog,
  saveDailyRisk, loadLatestDailyRisk,
  upsertSymbolRisk, loadSymbolRiskConfig,
  logWebhook, loadWebhookHistory,
  logSignal,
  computeEVStats,
  loadSignalStats,
  loadSignalRejects,
  loadShadowWinners,
  saveKeyRiskMult, loadKeyRiskMults,
  fetchRealizedPnl,
  saveDeal,
  saveSpreadLog, loadSpreadStats, loadSpreadLog,
  loadPerformanceSummary,
  loadMAEStats,
  loadGhostGrouped,
  loadDailyBreakdown,
  loadGhostHistoryByPair,
  loadBlockedRaw,
  setComplianceDateLive,
  saveComplianceDate,
  loadComplianceDate,
  // v12.5.1: trade numbering + ghost combo analysis
  getNextTradeNumber,
  syncTradeNumberSequence,
  computeAndSaveGhostComboAnalysis,
  loadGhostComboAnalysis,
  pool,
} = require("./db");

const {
  SYMBOL_CATALOG, SESSION_LABELS, DEFAULT_RISK_BY_TYPE,
  getBrusselsComponents, getBrusselsDateStr, getBrusselsDateOnly,
  getSession, isMarketOpen, canOpenNewTrade, isMonitoringActive,
  normalizeSymbol, getSymbolInfo,
  getVwapPosition, buildOptimizerKey,
  COMPLIANCE_DATE, COMPLIANCE_DATE_MS,  // COMPLIANCE_DATE_MS behouden voor backward compat
  SL_BUFFER_MULT: SESSION_SL_BUFFER_MULT,
  STOCK_SL_BUFFER_MULT,
} = require("./session");

// Live compliance date — geladen uit DB bij startup, aanpasbaar via POST /compliance-date.
// Beheert de datumgrens voor ghost EV, shadow, signals, history, trade stats.
// Default: hardcoded session.js waarde (2026-05-03). DB overschrijft bij startup.
let currentComplianceDate = COMPLIANCE_DATE;

// ── Config ───────────────────────────────────────────────────────
const META_API_TOKEN  = process.env.META_API_TOKEN;
const META_ACCOUNT_ID = process.env.META_ACCOUNT_ID;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;
const PORT            = process.env.PORT || 3000;

// ── Risk constants ───────────────────────────────────────────────
// FIXED_RISK_PCT: base risk per trade (0.0375% of balance — nogmaals gehalveerd v12.3, was 0.075%)
const FIXED_RISK_PCT = parseFloat(process.env.FIXED_RISK_PCT || "0.000375");

// FIX C: Currency exposure budget per valuta (default 2% van balance).
// Op €100k balance = €2.000 max exposure per valuta voor EV-neutraal trades.
const CURRENCY_BUDGET_PCT = parseFloat(process.env.CURRENCY_BUDGET_PCT || "0.02");

// FIX D: Minimum TP RR floor — TP moet minimaal deze factor × SL-afstand zijn.
const MIN_TP_RR_FLOOR = parseFloat(process.env.MIN_TP_RR_FLOOR || "0.5");

// Ghost settings
const GHOST_MIN_TRADES_FOR_TP = 5;
const GHOST_POLL_MS           = 30000;
const GHOST_MAX_MS            = 14 * 24 * 3600 * 1000;  // 2 weeks max tracking
const GHOST_MAX_RR            = 15;                       // stop at 15R peak
const MULT_MIN_SAMPLE         = 30;

// FIX 16
const MAX_CLOSED_TRADES = 10000;  // verhoogd van 5000 — bij 4500+ trades was de limiet bijna bereikt
// FIX 15
const MAX_HISTORY       = 200;

// SL buffer multipliers — geïmporteerd uit session.js (v12.3):
//   SL_BUFFER_MULT       = 1.5 → standaard voor forex, index, commodity
//   STOCK_SL_BUFFER_MULT = 3.0 → stocks: 2× de standaard buffer (spread fix)
// SESSION_SL_BUFFER_MULT is de alias voor de geïmporteerde SL_BUFFER_MULT.
const SL_BUFFER_MULT = SESSION_SL_BUFFER_MULT;  // = 1.5, backward compat alias

// Min stop distances per MT5 symbol
const MIN_STOP = {
  "GER40.cash": 10, "UK100.cash": 2, "US100.cash": 10, "US30.cash": 10,
  "XAUUSD": 0.5,
};

// LOT_VALUE = fallback contract size per lot per asset type.
// PRIMAIR: live lotVal wordt opgehaald via fetchSymbolLotValue() van MT5 spec.
// Onderstaande waarden zijn ALLEEN de fallback als MT5 spec niet beschikbaar is.
//
// Broker-specifieke specs (uit MT5 symbool info, 20 Apr 2026):
// ┌────────────┬──────────────┬──────────┬───────────┬──────────────────────────┐
// │ Symbool    │ Type         │ Min lot  │ Max lot   │ Commission               │
// ├────────────┼──────────────┼──────────┼───────────┼──────────────────────────┤
// │ XAUUSD     │ commodity    │ 0.01     │ 100       │ 0.0007% EUR/lot          │
// │ EURUSD     │ forex        │ 0.01     │ 50        │ 2.5 USD/lot              │
// │ NZDUSD     │ forex        │ 0.01     │ 50        │ 2.5 USD/lot              │
// │ GBPNZD     │ forex        │ 0.01     │ 50        │ 2.5 USD/lot              │
// │ USDCHF     │ forex        │ 0.01     │ 50        │ 2.5 USD/lot              │
// │ GOOG       │ stock (CFD)  │ 1        │ 10000     │ 0.002% EUR/lot           │
// └────────────┴──────────────┴──────────┴───────────┴──────────────────────────┘
// Swap type voor forex/commodity: "In punten" (points-based, niet percentage).
// Swap koersen: Ma/Di/Do/Vr=1x, Woensdag=3x (triple swap).
// Forex: dist × 100000 = pip-waarde. Live lotVal van MT5 prevaleert altijd.
const LOT_VALUE = {
  index: 20, commodity: 100, stock: 1, forex: 100000,
};

// FIX UK100: per-MT5-symbol lotVal fallback voor indexes.
// UK100.cash: lotVal = 1 GBP/punt/lot (niet 20 — dat is fout voor FTSE).
// GER40.cash: lotVal = 1 EUR/punt/lot.
// US100.cash: lotVal = 1 USD/punt/lot.
// US30.cash:  lotVal = 1 USD/punt/lot.
// Deze waarden worden gebruikt als fetchSymbolLotValue() geen MT5 spec terugkrijgt.
// Bij een werkende MT5 connectie wordt dit altijd overschreven door de live spec.
const LOT_VALUE_BY_MT5 = {
  "UK100.cash": 1,
  "GER40.cash": 1,
  "US100.cash": 1,
  "US30.cash":  1,
};

// ── Live balance cache ────────────────────────────────────────────
// FIX v12.4: default 0 (niet 50000) zodat lot berekeningen geblokkeerd
// worden totdat de echte balance van MT5 is opgehaald bij startup.
// getLiveBalance() wacht actief op de eerste succesvolle fetch.
let liveBalance   = 0;
let liveBalanceAt = 0;

// ── MetaApi ───────────────────────────────────────────────────────
// ── MetaApi ───────────────────────────────────────────────────────
// META_API_REGION: stel in via Railway env als je account niet op london staat.
// Geldige waarden: london, new-york, frankfurt, singapore, sydney
// Standaard: london. Als je HTTP 504 ziet "account region mismatch" -> wijzig dit.
// Zie: https://app.metaapi.cloud/api-access/api-urls voor jouw account regio.
const META_REGION = process.env.META_API_REGION || "london";
const META_BASE = `https://mt-client-api-v1.${META_REGION}.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT_ID}`;

async function metaFetch(path, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${META_BASE}${path}`, {
      ...options,
      headers: { "auth-token": META_API_TOKEN, "Content-Type": "application/json", ...(options.headers || {}) },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const body = await r.json(); msg += `: ${body?.message || body?.error || JSON.stringify(body)}`; } catch {}
      throw new Error(msg);
    }
    return r.json();
  } catch (e) { clearTimeout(t); throw e; }
}

async function fetchOpenPositions()         { return metaFetch("/positions"); }
async function fetchAccountInfo() {
  const info = await metaFetch("/accountInformation");
  if (info?.balance != null && parseFloat(info.balance) >= 0) {
    liveBalance   = parseFloat(info.balance);
    liveBalanceAt = Date.now();
    console.log(`[Balance] Live MT5 balance: €${liveBalance.toFixed(2)}`);
  }
  return info;
}
async function closePosition(id)            { return metaFetch(`/positions/${id}/close`, { method: "POST" }); }
async function fetchCurrentPrice(mt5Symbol) {
  try {
    const d   = await metaFetch(`/symbols/${encodeURIComponent(mt5Symbol)}/currentPrice`, {}, 5000);
    const bid = d.bid ?? null, ask = d.ask ?? null;
    if (bid !== null && ask !== null) return { mid: (bid + ask) / 2, bid, ask, spread: ask - bid };
    const mid = bid ?? ask ?? null;
    return mid !== null ? { mid, bid: mid, ask: mid, spread: 0 } : null;
  } catch { return null; }
}
async function placeOrder(payload) { return metaFetch("/trade", { method: "POST", body: JSON.stringify(payload) }, 12000); }

// FIX v12.4: haal history-deals op voor een positie na close.
// MetaAPI endpoint: GET /history-deals/time/{from}/{to}
// Filtert op positionId om de deals voor 1 specifieke trade te vinden.
// Haalt deals op over een venster van 5 minuten rondom nu (deals komen snel binnen).
// Slaat elk deal op via saveDeal() voor netto P&L berekening (incl. commission + swap).
async function fetchAndSaveDealsForPosition(positionId, symbol) {
  try {
    const toMs   = Date.now() + 30000;           // 30s in de toekomst als buffer
    const fromMs = toMs - (10 * 60 * 1000);      // 10 minuten terug
    const from   = new Date(fromMs).toISOString();
    const to     = new Date(toMs).toISOString();
    const data   = await metaFetch(`/history-deals/time/${encodeURIComponent(from)}/${encodeURIComponent(to)}`, {}, 8000);
    const deals  = Array.isArray(data) ? data : (data?.deals ?? []);
    let saved = 0;
    for (const d of deals) {
      const dPosId = String(d.positionId ?? d.position_id ?? "");
      if (dPosId !== String(positionId)) continue;
      await saveDeal({
        positionId:  String(positionId),
        dealId:      String(d.id ?? d.dealId ?? `${positionId}_${saved}`),
        symbol:      d.symbol ?? symbol ?? null,
        type:        d.type   ?? null,
        profit:      parseFloat(d.profit     ?? 0),
        commission:  parseFloat(d.commission ?? 0),
        swap:        parseFloat(d.swap       ?? 0),
        volume:      d.volume != null ? parseFloat(d.volume) : null,
        price:       d.price  != null ? parseFloat(d.price)  : null,
        time:        d.time   ?? null,
      }).catch(() => {});
      saved++;
    }
    if (saved > 0) console.log(`[Deals] ${positionId}: ${saved} deal(s) opgeslagen (symbol=${symbol})`);
    return saved;
  } catch (e) {
    console.warn(`[Deals] fetchAndSaveDeals ${positionId} failed: ${e.message}`);
    return 0;
  }
}

// ── In-memory state ───────────────────────────────────────────────
const openPositions  = {};
const closedTrades   = [];
const ghostTrackers  = {};
const tpLocks        = {};
const shadowResults  = {};
const webhookLog     = [];
const symbolRiskMap  = {};
const keyRiskMult    = {};   // { [optimizerKey]: { streak, evMult, dayMult } }

// FIX C: currency exposure tracking { [currency]: currentEURExposure }
// Bijgewerkt bij elke nieuwe EV-neutraal trade open/close.
const currencyExposure = {};

// FIX 9: rate-limit protection
let lastSyncAt = 0;
const SYNC_MIN_INTERVAL_MS = 55000;

// FIX 20: dupGuard with TTL
const DUP_GUARD_TTL_MS = 120000;
if (!global._dupGuard) global._dupGuard = {};

function logEvent(entry) {
  webhookLog.unshift({ ts: new Date().toISOString(), ...entry });
  if (webhookLog.length > MAX_HISTORY) webhookLog.length = MAX_HISTORY;
}

// ── Balance helpers ───────────────────────────────────────────────
// FIX v12.4: als balance nog 0 is (cold start, MT5 nog niet bereikt),
// probeer tot 3× met 2s tussenpoos te fetchen voor we terugvallen.
// Dit voorkomt verkeerde lot berekeningen in de eerste minuten na deploy.
async function getLiveBalance() {
  if (liveBalance > 0 && Date.now() - liveBalanceAt < 5 * 60 * 1000) {
    return liveBalance;
  }
  // Probeer live balance op te halen — tot 3 pogingen
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fetchAccountInfo();
      if (liveBalance > 0) return liveBalance;
    } catch (e) {
      console.warn(`[Balance] Fetch poging ${attempt}/3 mislukt: ${e.message}`);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
  }
  // Absolute fallback: als MT5 écht niet bereikbaar is, gebruik laatste
  // bekende waarde of 100000 als ultieme veilige default (beter dan 50k).
  if (liveBalance <= 0) {
    console.warn("[Balance] ⚠ Kon geen live balance ophalen — fallback 100000. Lots kunnen incorrect zijn!");
    liveBalance = 100000;
    liveBalanceAt = Date.now();
  }
  return liveBalance;
}

// ── Risk calculation ──────────────────────────────────────────────
function getSymbolRiskPct(symbol) {
  const envKey = `RISK_${symbol}`;
  if (process.env[envKey]) return parseFloat(process.env[envKey]);
  if (symbolRiskMap[symbol]) return symbolRiskMap[symbol];
  const info = getSymbolInfo(symbol);
  return DEFAULT_RISK_BY_TYPE[info?.type || "stock"] ?? FIXED_RISK_PCT;
}

// v10.6 MULT CORRECTIE: evMult en dayMult alleen voor lotsize scaling.
// riskEUR is puur: balance × pct — geen multipliers.
function getKeyEvMult(optimizerKey)  { return keyRiskMult[optimizerKey]?.evMult  ?? 1.0; }
function getKeyDayMult(optimizerKey) { return keyRiskMult[optimizerKey]?.dayMult ?? 1.0; }

// v10.6: calcRiskEUR = puur balance × pct. Geen evMult.
async function calcRiskEUR(symbol) {
  const balance = await getLiveBalance();
  const pct     = getSymbolRiskPct(symbol);
  return balance * pct;
}

// ── FIX C: Currency exposure helpers ─────────────────────────────
// Haal de twee valuta's op uit een forex pair (bijv. EURUSD → ['EUR','USD']).
function getPairCurrencies(symbol) {
  if (!symbol || symbol.length < 6) return [];
  return [symbol.slice(0, 3).toUpperCase(), symbol.slice(3, 6).toUpperCase()];
}

// Bereken de werkelijke EUR-exposure van een positie.
function calcPositionExposureEUR(lots, dist, lotVal) {
  return lots * dist * lotVal;
}

// Haal het currency budget ceiling op (in EUR).
async function getCurrencyBudget() {
  const balance = await getLiveBalance();
  return balance * CURRENCY_BUDGET_PCT;
}

// Rebuild currencyExposure vanuit alle open EV-neutrale posities.
// Wordt aangeroepen na elke open/close van een EV-neutrale positie.
function rebuildCurrencyExposure() {
  for (const k of Object.keys(currencyExposure)) delete currencyExposure[k];
  for (const pos of Object.values(openPositions)) {
    // EV+ trades tellen NIET mee in currency budget (Fix C spec)
    if ((pos.evMult ?? 1.0) > 1.0) continue;
    const info   = getSymbolInfo(pos.symbol);
    if (info?.type !== "forex") continue;
    const dist   = Math.abs(pos.entry - pos.sl);
    // Gebruik gecachede lotVal van MT5 spec (live waarde), fallback op statische 100000 voor forex
    const mt5Sym4  = pos.mt5Symbol || getSymbolInfo(pos.symbol)?.mt5 || pos.symbol;
    const cachedSpec = symbolSpecCache[mt5Sym4];
    const lotVal = cachedSpec?.lotVal ?? LOT_VALUE_BY_MT5[mt5Sym4] ?? LOT_VALUE["forex"] ?? 100000;
    const expEUR = calcPositionExposureEUR(pos.lots ?? 0, dist, lotVal);
    for (const ccy of getPairCurrencies(pos.symbol)) {
      currencyExposure[ccy] = (currencyExposure[ccy] ?? 0) + expEUR;
    }
  }
}

// Bereken scaleFactor voor EV-neutrale trade op basis van budget.
// Retourneert een getal 0..1 waarmee de lots worden vermenigvuldigd.
// Bij 0 → budget volledig uitgeput → trade geblokkeerd.
async function calcCurrencyScaleFactor(symbol, proposedLots, dist, lotVal) {
  const budget      = await getCurrencyBudget();
  const currencies  = getPairCurrencies(symbol);
  if (!currencies.length) return 1.0; // non-forex: geen budget check

  const proposedExp = calcPositionExposureEUR(proposedLots, dist, lotVal);
  let   minScale    = 1.0;

  for (const ccy of currencies) {
    const current = currencyExposure[ccy] ?? 0;
    const room    = budget - current;
    if (room <= 0) return 0; // volledig uitgeput
    const scale = room / proposedExp;
    if (scale < minScale) minScale = scale;
  }
  return Math.min(1.0, Math.max(0, minScale));
}

// ── MT5 Symbol Spec Cache ─────────────────────────────────────────
// Haalt contractSize en tickValue op van MT5 via MetaApi.
// Gecached per mt5Symbol — één keer ophalen, daarna uit cache.
// lotValue = tickValue / tickSize  (EUR per 1 prijspunt per lot)
// Fallback: LOT_VALUE[type] als MetaApi niet beschikbaar is.
const symbolSpecCache = {};

async function fetchSymbolLotValue(mt5Symbol, assetType) {
  if (symbolSpecCache[mt5Symbol]) return symbolSpecCache[mt5Symbol];
  try {
    const spec = await metaFetch(`/symbols/${encodeURIComponent(mt5Symbol)}/specification`, {}, 6000);
    // MetaApi geeft: contractSize, tickSize, tickValue (in account currency)
    const contractSize = parseFloat(spec?.contractSize) || null;
    const tickSize     = parseFloat(spec?.tickSize)     || null;
    const tickValue    = parseFloat(spec?.tickValue)    || null;
    // FIX C2 (v11.3): sla ook minVolume en volumeStep op — kritisch voor stocks (volumeStep=1)
    const minVolume    = parseFloat(spec?.minVolume)    || null;
    const volumeStep   = parseFloat(spec?.volumeStep)   || null;
    if (contractSize && tickSize && tickValue && tickSize > 0) {
      // lotValue = hoeveel account-currency verandert per 1 prijspunt per lot
      let lotVal = parseFloat((tickValue / tickSize).toFixed(6));

      // FIX v12.2 DAX/INDEX SANITY CHECK: als live lotVal voor een index abnormaal
      // afwijkt van de bekende waarde (1 per punt per lot voor FTMO indexes),
      // verwerp de MT5 spec en gebruik de veilige fallback.
      // Symptoom: GER40 berekent 0.6RR of 10RR door slechte tickValue van MT5.
      const knownLotVal = LOT_VALUE_BY_MT5[mt5Symbol];
      if (knownLotVal != null && assetType === "index") {
        const ratio = lotVal / knownLotVal;
        if (ratio < 0.5 || ratio > 2.0) {
          console.warn(`[SymSpec] ${mt5Symbol}: MT5 lotVal=${lotVal} afwijkt ${ratio.toFixed(2)}× van known=${knownLotVal} → gebruik fallback`);
          lotVal = knownLotVal; // vertrouw de handmatig gekalibreerde waarde
        }
      }

      symbolSpecCache[mt5Symbol] = { lotVal, contractSize, tickSize, tickValue, minVolume, volumeStep, source: "mt5" };
      console.log(`[SymSpec] ${mt5Symbol}: contractSize=${contractSize} tickSize=${tickSize} tickValue=${tickValue} -> lotVal=${lotVal} minVol=${minVolume} step=${volumeStep}`);
      return symbolSpecCache[mt5Symbol];
    }
  } catch (e) {
    console.warn(`[SymSpec] ${mt5Symbol}: kon spec niet ophalen (${e.message}) — gebruik fallback`);
  }
  // Fallback: eerst per-symbol override, dan generiek per asset type
  // FIX C2 (v11.3): stocks fallback — minVolume=1, volumeStep=1 (hele aandelen)
  const lotVal     = LOT_VALUE_BY_MT5[mt5Symbol] ?? LOT_VALUE[assetType] ?? 1;
  const minVolume  = assetType === "stock" ? 1 : 0.01;
  const volumeStep = assetType === "stock" ? 1 : 0.01;
  symbolSpecCache[mt5Symbol] = { lotVal, minVolume, volumeStep, source: "fallback" };
  return symbolSpecCache[mt5Symbol];
}
// ── Lot calculation ───────────────────────────────────────────────
// v10.7: lotVal live opgehaald van MT5 via fetchSymbolLotValue().
// Fallback op statische LOT_VALUE als MetaApi spec niet beschikbaar.
// Retourneert object: { lots, lotVal, source }
async function calcLots(symbol, mt5Sym, assetType, entry, sl, riskEUR, evMult, dayMult) {
  const spec       = await fetchSymbolLotValue(mt5Sym, assetType);
  const lotVal     = spec.lotVal;
  // FIX C2 (v11.3): gebruik volumeStep en minVolume uit MT5 spec.
  // Stocks: volumeStep=1, minVolume=1 (hele aandelen, geen decimalen).
  // Forex:  volumeStep=0.01, minVolume=0.01 (ongewijzigd gedrag).
  const volumeStep = spec.volumeStep ?? (assetType === "stock" ? 1 : 0.01);
  const minVolume  = spec.minVolume  ?? (assetType === "stock" ? 1 : 0.01);

  const dist = Math.abs(entry - sl);
  if (!dist || !riskEUR) return { lots: minVolume, lotVal, source: spec.source };
  const baseLots = riskEUR / (dist * lotVal);
  const em       = (evMult  && evMult  > 0) ? evMult  : 1.0;
  const dm       = (dayMult && dayMult > 0) ? dayMult : 1.0;
  const rawLots  = baseLots * em * dm;

  // FIX C2 (v11.3): rond af naar volumeStep via floor (niet 0.01 hardcoded).
  // floor(432.82 / 1) * 1 = 432  → stocks: hele aandelen
  // floor(0.726  / 0.01) * 0.01 = 0.72 → forex: 0.01 stap
  const steppedLots = Math.floor(rawLots / volumeStep) * volumeStep;
  const clampedLots = Math.max(minVolume, steppedLots);

  // FIX R2 (v11.0): waarschuw als min lot floor de werkelijke risk inflateert.
  if (rawLots < minVolume) {
    const inflatedRisk = minVolume * dist * lotVal;
    const inflationPct = ((inflatedRisk / riskEUR - 1) * 100).toFixed(0);
    console.warn(`[MinLot] ${mt5Sym} (${assetType}): rawLots=${rawLots.toFixed(5)} → clamped ${minVolume}. actualRisk=€${inflatedRisk.toFixed(2)} vs intended=€${riskEUR.toFixed(2)} (+${inflationPct}%)`);
  }

  // Afronden op correcte decimalen op basis van volumeStep
  const decimals = volumeStep < 1 ? (String(volumeStep).split(".")[1]?.length ?? 2) : 0;
  const lots = parseFloat(clampedLots.toFixed(decimals));
  return { lots, lotVal, source: spec.source };
}

// FIX v12.4: recalcLotsAfterSL verwijderd — was dead code.
// De functie berekende nieuwe baseLots na SL-hit maar sloeg niets op.
// lotOverrides werden al verwijderd in v11.0 (FIX R4). Geen vervanging nodig.

// ── SL helpers ───────────────────────────────────────────────────
// FIX A: server berekent derivedSlPct van absolute TV prijzen.
// entry_price en sl_price komen uit de TV payload.
// derivedSlPct = |entry_price - sl_price| / entry_price
// Validatie: > 0 en <= 0.05 (5%), anders hard reject.
function deriveSLPct(tvEntryPrice, tvSLPrice) {
  if (!tvEntryPrice || !tvSLPrice || tvEntryPrice <= 0) return null;
  return Math.abs(tvEntryPrice - tvSLPrice) / tvEntryPrice;
}

// MT5 SL berekening op basis van executionPrice + derivedSlPct.
// ×1.5 buffer voor forex/index/commodity absorbeert slippage/delay.
// ×3.0 buffer voor stocks (STOCK_SL_BUFFER_MULT) — grotere spread.
// assetType is optioneel: als niet opgegeven → standaard SL_BUFFER_MULT.
function calcSLFromDerivedPct(direction, executionPrice, derivedSlPct, assetType = null) {
  const mult     = assetType === "stock" ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;
  const buffered = derivedSlPct * mult;
  return direction === "buy"
    ? parseFloat((executionPrice * (1 - buffered)).toFixed(5))
    : parseFloat((executionPrice * (1 + buffered)).toFixed(5));
}

// Backwards compat alias — geen assetType beschikbaar op call sites die deze gebruiken
function calcSLFromPct(direction, mt5Entry, slPct) {
  return calcSLFromDerivedPct(direction, mt5Entry, slPct);
}

function enforceMinStop(mt5Symbol, direction, entry, sl) {
  const minD = MIN_STOP[mt5Symbol] ?? 0;
  const dist = Math.abs(entry - sl);
  if (dist >= minD) return sl;
  return direction === "buy"
    ? parseFloat((entry - minD).toFixed(5))
    : parseFloat((entry + minD).toFixed(5));
}

// ── TP calculation ────────────────────────────────────────────────
const DEFAULT_TP_RR = 2.0;

// v11.0: Geen cap per asset type — DEFAULT_TP_RR = 2.0R voor alle assets
// zolang er nog geen EV-data is (< GHOST_MIN_TRADES_FOR_TP ghosts).
// Zodra er voldoende data is, pakt de EV optimizer het beste RR niveau
// en wordt dat gelockt via updateTPLock(). De TP lock is de enige
// bron van truth voor EV+ combos — geen externe cap nodig.
async function getOptimalTP(optimizerKey, assetType = null) {
  const locked = tpLocks[optimizerKey];
  if (locked) return locked.lockedRR;
  // Fix 2: check evCache first — voorkomt live DB query per inkomende trade
  // evCache wordt elke 5min rebuilt en na elke ghost finalize
  const cached = evCache.data.find(e => e.key === optimizerKey);
  if (cached) {
    if ((cached.count ?? 0) < GHOST_MIN_TRADES_FOR_TP) return DEFAULT_TP_RR;
    return cached.bestRR ?? DEFAULT_TP_RR;
  }
  // Fallback: directe DB query als cache nog leeg is (eerste start)
  const ev = await computeEVStats(optimizerKey);
  if (!ev || ev.count < GHOST_MIN_TRADES_FOR_TP) return DEFAULT_TP_RR;
  return ev.bestRR ?? DEFAULT_TP_RR;
}

function calcTPPrice(direction, entry, sl, rrTarget) {
  const dist = Math.abs(entry - sl);
  return direction === "buy"
    ? parseFloat((entry + dist * rrTarget).toFixed(5))
    : parseFloat((entry - dist * rrTarget).toFixed(5));
}

// FIX D: TP Floor Guard — TP moet minimaal MIN_TP_RR_FLOOR × SL-afstand zijn.
// Basis = werkelijke MT5 SL afstand na enforceMinStop().
// Retourneert gecorrigeerde TP prijs (onveranderd als floor OK is).
function applyTPFloorGuard(direction, executionPrice, mt5SL, tp) {
  const slDist    = Math.abs(executionPrice - mt5SL);
  const minTPDist = slDist * MIN_TP_RR_FLOOR;
  if (direction === "buy") {
    const minTP = parseFloat((executionPrice + minTPDist).toFixed(5));
    if (tp < minTP) {
      console.log(`[TPFloor] BUY TP ${tp} < floor ${minTP} → gecorrigeerd`);
      return minTP;
    }
  } else {
    const minTP = parseFloat((executionPrice - minTPDist).toFixed(5));
    if (tp > minTP) {
      console.log(`[TPFloor] SELL TP ${tp} > floor ${minTP} → gecorrigeerd`);
      return minTP;
    }
  }
  return tp;
}

// ── FIX E: RR Verificatie met echte MT5 data ─────────────────────
// Controleert na TP Floor Guard of SL/TP op de juiste kant liggen.
// Retourneert { ok, slWrongSide, slTooWide, tpRRTooLow, actualSLPct, actualTPRR }
function verifyRR(direction, executionPrice, mt5SL, mt5TP) {
  const result = {
    ok: true, slWrongSide: false, slTooWide: false, tpRRTooLow: false,
    actualSLPct: null, actualTPRR: null,
  };

  // Bereken actuele SL afstand %
  if (executionPrice > 0 && mt5SL > 0) {
    result.actualSLPct = Math.abs(executionPrice - mt5SL) / executionPrice;
  }

  // SL op verkeerde kant?
  if (direction === "buy"  && mt5SL >= executionPrice) { result.slWrongSide = true; result.ok = false; }
  if (direction === "sell" && mt5SL <= executionPrice) { result.slWrongSide = true; result.ok = false; }

  // SL te breed? (> 5%) — log only
  if (result.actualSLPct != null && result.actualSLPct > 0.05) result.slTooWide = true;

  // Bereken TP RR t.o.v. werkelijke SL afstand
  if (mt5SL > 0 && mt5TP != null) {
    const slDist = Math.abs(executionPrice - mt5SL);
    const tpDist = direction === "buy"
      ? mt5TP - executionPrice
      : executionPrice - mt5TP;
    result.actualTPRR = slDist > 0 ? parseFloat((tpDist / slDist).toFixed(3)) : null;
  }

  // TP RR te laag? (< 0.3R) — log only
  if (result.actualTPRR != null && result.actualTPRR < 0.3) result.tpRRTooLow = true;

  return result;
}

// ── TP Lock Engine ────────────────────────────────────────────────
async function updateTPLock(optimizerKey, symbol, session, direction, vwapPos) {
  try {
    const ev = await computeEVStats(optimizerKey);
    if (!ev || ev.count < GHOST_MIN_TRADES_FOR_TP) return;
    const prev  = tpLocks[optimizerKey];
    const newRR = ev.bestRR;
    const evPos = (ev.bestEV ?? 0) > 0;
    tpLocks[optimizerKey] = { lockedRR: newRR, lockedGhosts: ev.count, evAtLock: ev.bestEV, evPositive: evPos, lockedAt: new Date().toISOString() };
    await saveTPConfig(optimizerKey, symbol, session, direction, vwapPos, newRR, ev.count, ev.bestEV, prev?.lockedRR ?? null);
    console.log(`[TP Lock] ${optimizerKey}: ${prev?.lockedRR ?? "new"}R → ${newRR}R (EV=${ev.bestEV?.toFixed(3)}, n=${ev.count})`);
  } catch (e) { console.warn("[!] updateTPLock:", e.message); }
}

// ── MaxRR helpers ─────────────────────────────────────────────────
function calcMaxRR(direction, entry, sl, maxPrice) {
  const dist = Math.abs(entry - sl);
  if (!dist || maxPrice == null) return 0;
  const fav = direction === "buy" ? maxPrice - entry : entry - maxPrice;
  // 3 decimalen — 2dp roundt 1.996R → 1.99 waardoor het als verlies telt bij TP sweep op 2.0R
  return parseFloat((Math.max(0, fav) / dist).toFixed(3));
}

function calcPctSlUsed(direction, entry, sl, currentPrice) {
  const dist = Math.abs(entry - sl);
  if (!dist) return 0;
  const adverse = direction === "buy" ? entry - currentPrice : currentPrice - entry;
  return parseFloat((Math.max(0, Math.min(100, (adverse / dist) * 100)).toFixed(2)));
}

// ── Anti-consolidation helpers (FIX 3) ───────────────────────────
function sharesCurrency(a, b) {
  if (!a || !b || a.length < 6 || b.length < 6) return false;
  const aBase = a.slice(0, 3), aQuote = a.slice(3, 6);
  const bBase = b.slice(0, 3), bQuote = b.slice(3, 6);
  return aBase === bBase || aBase === bQuote || aQuote === bBase || aQuote === bQuote;
}

// FIX 3: Find duplicate — zelfde symbol + richting, ongeacht sessie.
// Een open trade leeft over sessies heen, sessie mag niet als escape gelden.
// Returns de OUDSTE open positie (voor SL widen), of null als geen bestaat.
function findExactDuplicate(symKey, session, direction) {
  const matches = Object.values(openPositions).filter(p =>
    p.symbol === symKey && p.direction === direction
  );
  if (!matches.length) return null;
  // Oudste eerst — SL widen op de langst lopende positie
  matches.sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
  return matches[0];
}

// Hard cap: max 1 open positie per symbol+richting.
// MetaApi REST ondersteunt geen positie modify — SL widen is niet mogelijk.
// Bij >= 1 open in zelfde richting → trade geblokkeerd.
const MAX_SAME_DIRECTION = 1;
function countSameDirection(symKey, direction) {
  return Object.values(openPositions).filter(p =>
    p.symbol === symKey && p.direction === direction
  ).length;
}

// FIX 3: Count same-currency pairs open in same direction (excluding exact duplicate).
function countRelatedForex(symKey, direction) {
  return Object.values(openPositions).filter(p =>
    p.direction === direction &&
    p.symbol !== symKey &&
    sharesCurrency(p.symbol, symKey)
  ).length;
}

// FIX 3: Widen SL × 1.5 on existing trade and adjust TP proportionally.
// ── Ghost Optimizer ───────────────────────────────────────────────
// Ghost tracker volgt de live prijs en berekent maxRR op de VASTE
// SL die bij trade-open is gezet. SL en TP wijzigen niet meer mid-trade.
function startGhostTracker(pos, restoreData = null) {
  // Guard: ghost is nutteloos zonder SL (geen price tracking mogelijk)
  // en zonder vwapPosition (kan nooit in EV tabel terechtkomen)
  if (!pos.sl || pos.sl <= 0) {
    console.warn(`[Ghost] ${pos.positionId}: sl=0, ghost NOT started — wacht op SL sync`);
    return;
  }
  if (!pos.vwapPosition || pos.vwapPosition === "unknown") {
    console.warn(`[Ghost] ${pos.positionId}: vwapPosition=unknown, ghost NOT started — data incompleet voor EV`);
    return;
  }
  if (ghostTrackers[pos.positionId]) return;

  const { positionId, symbol, session, direction, vwapPosition,
          optimizerKey, entry, sl, slPct, tpRRUsed, openedAt } = pos;
  // FIX 10: mt5Symbol fallback
  const mt5Symbol = pos.mt5Symbol || getSymbolInfo(symbol)?.mt5 || symbol;

  // Restore maxPrice from persisted ghost_state if available (survives restarts)
  let maxPrice       = restoreData?.maxPrice  ?? entry;
  let maxSlPctUsed   = restoreData?.maxSlPctUsed ?? 0;
  let timer          = null;
  const startTs      = Date.now() - (restoreData ? (Date.now() - new Date(openedAt ?? 0).getTime()) : 0);
  const originalSL   = sl;
  const originalSlPct  = slPct;
  const originalTpRR   = tpRRUsed;
  let   lastStateSaveTs = Date.now();

  // v12.6: RR milestone timestamps — twee assen:
  //   adverse:   -0.1R ... -1.0R (per 0.1 stap)
  //   favorable: +0.1R ... +15R  (stappen zie array)
  // FIX v12.6: herstel opgeslagen milestones uit ghost_state zodat timing
  // NA een Railway deploy NIET verloren gaat voor lopende trades.
  const RR_ADVERSE_STEPS   = [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0];
  const RR_FAVORABLE_STEPS = [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0,1.2,1.4,1.5,1.6,1.8,2.0,2.5,3.0,3.5,4.0,4.5,5.0,6.0,7.0,8.0,9.0,10.0,12.0,15.0];

  // Initialiseer alle stappen op null, daarna overschrijven met opgeslagen waarden
  const rrMilestones = { adverse: {}, favorable: {} };
  RR_ADVERSE_STEPS.forEach(s => { rrMilestones.adverse[s]   = null; });
  RR_FAVORABLE_STEPS.forEach(s => { rrMilestones.favorable[s] = null; });
  const slMilestones = {};
  RR_ADVERSE_STEPS.forEach(s => { slMilestones[Math.round(s * 100)] = null; });

  // Herstel adverse milestones uit restoreData.rrMilestones (overleeft deploy)
  if (restoreData?.rrMilestones?.adverse) {
    for (const [k, v] of Object.entries(restoreData.rrMilestones.adverse)) {
      if (v != null) rrMilestones.adverse[parseFloat(k)] = v;
    }
  }
  // Herstel favorable milestones uit restoreData.rrMilestones
  if (restoreData?.rrMilestones?.favorable) {
    for (const [k, v] of Object.entries(restoreData.rrMilestones.favorable)) {
      if (v != null) rrMilestones.favorable[parseFloat(k)] = v;
    }
  }
  // Herstel slMilestones (pct-keys "10".."100") uit restoreData
  if (restoreData?.slMilestones) {
    for (const [k, v] of Object.entries(restoreData.slMilestones)) {
      if (v != null) slMilestones[k] = v;
    }
  }

  // Peak RR tracking — beide kanten, herstel uit restoreData
  let peakRRPos = restoreData?.peakRRPos ?? restoreData?.maxRR ?? 0;
  let peakRRNeg = restoreData?.peakRRNeg ?? 0;

  ghostTrackers[positionId] = {
    positionId, symbol, mt5Symbol, session, direction,
    vwapPosition, optimizerKey, entry,
    sl: originalSL,
    slPct: originalSlPct,
    tpRRUsed: originalTpRR,
    openedAt, maxPrice, maxSlPctUsed,
    maxRR:    restoreData?.maxRR ?? 0,
    peakRRPos,
    peakRRNeg,
    rrMilestones,   // v12.6: expose op tracker object zodat /live/ghosts het uitstuurt
    slMilestones,
    tradeNumber: pos.tradeNumber ?? restoreData?.tradeNumber ?? null,
    startTs, timer,
  };

  // FIX v12.6: sla ALLEEN op als dit een NIEUWE ghost is (geen restoreData).
  // Bij een restore willen we de bestaande DB-rij NIET overschrijven — die heeft
  // de volledige milestone history. Enkel updaten als er nieuwe data is.
  if (!restoreData) {
    saveGhostState({
      positionId, optimizerKey, symbol, mt5Symbol, session, direction,
      vwapPosition, entry, sl: originalSL, slPct: originalSlPct, tpRRUsed: originalTpRR,
      maxPrice, maxRR: 0, maxSlPctUsed: 0, openedAt,
      riskPct: pos.riskPct ?? null, riskEUR: pos.riskEUR ?? null,
      evMult: pos.evMult ?? 1.0, dayMult: pos.dayMult ?? 1.0,
      rrMilestones, slMilestones,
      peakRRPos: 0, peakRRNeg: 0,
    }).catch(() => {});
  } else {
    console.log(`[Ghost] ${positionId}: restored — adv milestones: ${Object.values(rrMilestones.adverse).filter(Boolean).length}/10 | fav: ${Object.values(rrMilestones.favorable).filter(Boolean).length}/${RR_FAVORABLE_STEPS.length}`);
  }

  async function tick() {
    try {
      if (!ghostTrackers[positionId]) return;
      const g       = ghostTrackers[positionId];
      const elapsed = Date.now() - new Date(openedAt ?? startTs).getTime();
      if (elapsed >= GHOST_MAX_MS) { await finalizeGhost(positionId, "timeout_2w", elapsed, maxPrice); return; }
      const { day } = getBrusselsComponents();
      if (day === 0 || day === 6) {
        timer = setTimeout(tick, 10 * 60 * 1000);
        g.timer = timer;
        return;
      }

      const phantomSL = g.sl;  // fixed at trade-open, never changes

      const priceData = await fetchCurrentPrice(mt5Symbol);
      const rawPrice  = priceData?.mid ?? null;

      // FIX v12.1.3: sync maxPrice vanuit openPositions tracker (syncOpenPositions loopt
      // onafhankelijk en pikt gunstige pieken op die tussen ghost ticks vallen).
      // Neem de BESTE van: live MT5 prijs + openPositions.maxPrice + eigen maxPrice.
      const livePos   = openPositions[positionId];
      const livePosMaxPrice = livePos?.maxPrice ?? null;
      const livePosCurrentPrice = livePos?.currentPrice ?? null;

      // Beste kandidaat prijs = meest gunstige van alle bronnen
      let price = rawPrice;
      if (direction === "buy") {
        if (livePosMaxPrice != null && livePosMaxPrice > (price ?? -Infinity)) price = livePosMaxPrice;
        if (livePosCurrentPrice != null && livePosCurrentPrice > (price ?? -Infinity)) price = livePosCurrentPrice;
      } else {
        if (livePosMaxPrice != null && livePosMaxPrice < (price ?? Infinity)) price = livePosMaxPrice;
        if (livePosCurrentPrice != null && livePosCurrentPrice < (price ?? Infinity)) price = livePosCurrentPrice;
      }

      if (price !== null) {
        // Track max favorable movement (best RR)
        const better = direction === "buy" ? price > maxPrice : price < maxPrice;
        if (better) {
          maxPrice = price;
          g.maxPrice = price;
          g.maxRR = calcMaxRR(direction, entry, phantomSL, price);
        }

        const slDist = Math.abs(entry - phantomSL);
        if (slDist > 0) {
          const nowIso = new Date().toISOString();
          const elapsed = Date.now() - new Date(openedAt ?? startTs).getTime();

          // ── Adverse RR milestones (-0.25R … -1.00R = phantom SL) ──────────
          const adverseMove = direction === "buy" ? entry - price : price - entry;
          const adverseRR   = parseFloat((Math.max(0, adverseMove) / slDist).toFixed(4));
          const slPctNow    = parseFloat((Math.min(100, adverseRR * 100)).toFixed(2));

          if (slPctNow > maxSlPctUsed) {
            maxSlPctUsed = slPctNow;
            g.maxSlPctUsed = maxSlPctUsed;
          }
          // Track peak adverse RR (worst drawdown, stored as positive % of SL)
          if (slPctNow > peakRRNeg) {
            peakRRNeg = slPctNow;
            g.peakRRNeg = peakRRNeg;
          }

          for (const step of RR_ADVERSE_STEPS) {
            if (!rrMilestones.adverse[step] && adverseRR >= step) {
              rrMilestones.adverse[step] = nowIso;
              // Keep slMilestones in sync — key = 10,20,...,100
              const pct = Math.round(step * 100);
              slMilestones[pct] = nowIso;
              g.rrMilestones = rrMilestones;
              g.slMilestones = { ...slMilestones };
              const elMin = Math.round(elapsed / 60000);
              console.log(`[Ghost] ${positionId} adverse -${step}R (${pct}% SL) @ +${elMin}min | maxRR so far: ${g.maxRR}R`);
            }
          }

          // ── Favorable RR milestones (+0.1R … +15R) ────────────────────────
          const favorableRR = g.maxRR; // already updated above
          // Track peak favorable RR
          if (favorableRR > peakRRPos) {
            peakRRPos = favorableRR;
            g.peakRRPos = peakRRPos;
          }
          for (const step of RR_FAVORABLE_STEPS) {
            if (!rrMilestones.favorable[step] && favorableRR >= step) {
              rrMilestones.favorable[step] = nowIso;
              g.rrMilestones = rrMilestones;
              const elMin = Math.round(elapsed / 60000);
              console.log(`[Ghost] ${positionId} favorable +${step}R reached @ +${elMin}min`);
            }
          }

          // ── -1.00R = phantom SL hit → stop immediately ────────────────────
          const slHit = direction === "buy" ? price <= phantomSL : price >= phantomSL;
          if (slHit) {
            // Ensure 100% milestone timestamp is recorded before finalizing
            if (!rrMilestones.adverse[1.00]) {
              rrMilestones.adverse[1.00] = nowIso;
              slMilestones[100] = nowIso;
              g.rrMilestones = rrMilestones;
              g.slMilestones = { ...slMilestones };
            }
            await finalizeGhost(positionId, "phantom_sl", elapsed, maxPrice);
            return;
          }

          // ── Cap at 15RR — ghost has done its job ──────────────────────────
          if (g.maxRR >= GHOST_MAX_RR) {
            await finalizeGhost(positionId, "max_rr_15", elapsed, maxPrice); return;
          }
        }
      }

      // Persist ghost state every 5 minutes (not every tick — don't hammer DB)
      if (Date.now() - lastStateSaveTs > 5 * 60 * 1000) {
        saveGhostState({ positionId, optimizerKey, symbol, mt5Symbol, session, direction,
          vwapPosition, entry, sl: g.sl, slPct: originalSlPct, tpRRUsed: originalTpRR,
          maxPrice, maxRR: g.maxRR, maxSlPctUsed, openedAt,
          riskPct: pos.riskPct ?? null, riskEUR: pos.riskEUR ?? null,
          evMult: pos.evMult ?? 1.0, dayMult: pos.dayMult ?? 1.0,
          slMilestones: g.slMilestones ?? null,
          rrMilestones: g.rrMilestones ?? null,
          tradeNumber: g.tradeNumber ?? null,
          peakRRPos, peakRRNeg,
        }).catch(() => {});
        lastStateSaveTs = Date.now();
      }

      timer = setTimeout(tick, GHOST_POLL_MS);
      g.timer = timer;
    } catch (e) {
      console.warn(`[Ghost] ${positionId} tick error:`, e.message);
      const g = ghostTrackers[positionId];
      timer = setTimeout(tick, GHOST_POLL_MS * 2);
      if (g) g.timer = timer;
    }
  }
  // FIX 2: initiële delay van 3s vóór eerste tick.
  // MetaApi registreert de positie na placeOrder() met een lichte vertraging.
  // Zonder deze delay faalt de eerste SL/TP modify met HTTP 404 (positie niet gevonden).
  // 3s is ruim voldoende voor MetaApi om de positie in zijn systeem te hebben.
  const GHOST_INITIAL_DELAY_MS = 3000;
  timer = setTimeout(tick, GHOST_INITIAL_DELAY_MS);
  ghostTrackers[positionId].timer = timer;
  console.log(`[Ghost] Started: ${positionId} | ${optimizerKey} | sl=${sl} | eerste tick over ${GHOST_INITIAL_DELAY_MS}ms`);
}

async function finalizeGhost(positionId, stopReason, elapsedMs, finalMaxPrice) {
  const g = ghostTrackers[positionId];
  if (!g) return;
  clearTimeout(g.timer);
  delete ghostTrackers[positionId];

  const finalSL       = g.sl;
  const maxRRBeforeSL = calcMaxRR(g.direction, g.entry, finalSL, finalMaxPrice);
  const timeToSLMin   = Math.round(elapsedMs / 60000);
  const phantomSLHit  = stopReason === "phantom_sl";

  const ghostRow = {
    positionId: g.positionId, symbol: g.symbol, session: g.session,
    direction: g.direction, vwapPosition: g.vwapPosition, optimizerKey: g.optimizerKey,
    entry: g.entry, sl: finalSL, slPct: g.slPct, phantomSL: finalSL, tpRRUsed: g.tpRRUsed,
    maxPrice: finalMaxPrice, maxRRBeforeSL, phantomSLHit, stopReason,
    // FIX v12.2: always save timeToSLMin regardless of stop reason —
    // timeouts and manual deploys still have valid elapsed time data.
    timeToSLMin,
    maxSlPctUsed: g.maxSlPctUsed ?? 0,
    slMilestones: g.slMilestones ?? null,
    rrMilestones: g.rrMilestones ?? null,
    tradeNumber:  g.tradeNumber  ?? null,
    peakRRPos:    g.peakRRPos    ?? maxRRBeforeSL ?? 0,
    peakRRNeg:    g.peakRRNeg    ?? g.maxSlPctUsed ?? 0,
    openedAt: g.openedAt, closedAt: new Date().toISOString(),
  };

  await saveGhostTrade(ghostRow);
  await deleteGhostState(g.positionId).catch(() => {});

  // v12.5.1: herbereken ghost combo analyse voor deze optimizer_key
  // zodat ghost history altijd actueel is na elke afgewerkte ghost trade
  computeAndSaveGhostComboAnalysis(g.optimizerKey).catch(() => {});

  // Rebuild EV cache in background — new ghost data is now available
  rebuildEVCache().catch(() => {});
  await updateTPLock(g.optimizerKey, g.symbol, g.session, g.direction, g.vwapPosition);
  await runShadowOptimizer(g.optimizerKey).catch(() => {});

  // FIX 6: If this ghost belongs to a manually-closed position, write trueMaxRR back to DB.
  const closedTrade = closedTrades.find(t => t.positionId === g.positionId);
  if (closedTrade && closedTrade.closeReason === "manual") {
    closedTrade.trueMaxRR    = maxRRBeforeSL;
    closedTrade.trueMaxPrice = finalMaxPrice;
    await saveTrade(closedTrade).catch(() => {});
    console.log(`[Ghost] ${positionId}: trueMaxRR=${maxRRBeforeSL}R written back (manual close)`);
  }

  console.log(`[Ghost] Finalized: ${positionId} | key=${g.optimizerKey} | sl=${finalSL} | maxRR=${maxRRBeforeSL}R | slHit=${phantomSLHit}`);
}

function cancelGhost(positionId) {
  const g = ghostTrackers[positionId];
  if (!g) return;
  clearTimeout(g.timer);
  delete ghostTrackers[positionId];
}

// ── Band Ghost Tracker (Ghost 2.0) ───────────────────────────────
// Tracks VWAP-exhausted rejected signals to see what would have happened.
// Completely separate from ghostTrackers and main EV data.
// Stops at: phantom SL hit / 15RR / 2-week timeout.
const bandGhostTrackers = {};

function startBandGhostTracker(pos) {
  const id = `band_${pos.symbol}_${pos.session}_${pos.direction}_${Date.now()}`;
  if (!pos.sl || pos.sl <= 0 || !pos.entry) return;

  const { optimizerKey, symbol, mt5Symbol, session, direction, vwapPosition,
          bandTier, bandPct, entry, sl, slPct, openedAt, signalId } = pos;
  let maxPrice     = entry;
  let maxSlPctUsed = 0;
  let maxRR        = 0;
  let timer        = null;
  const startTs    = Date.now();

  bandGhostTrackers[id] = { id, optimizerKey, symbol, mt5Symbol, session, direction,
    vwapPosition, bandTier, bandPct, entry, sl, slPct, openedAt, signalId,
    maxPrice, maxRR, maxSlPctUsed, timer, startTs };

  async function tick() {
    try {
      const g = bandGhostTrackers[id];
      if (!g) return;
      const elapsed = Date.now() - startTs;
      if (elapsed >= GHOST_MAX_MS) {
        await finalizeBandGhost(id, "timeout_2w", elapsed, maxPrice); return;
      }
      const { day } = getBrusselsComponents();
      if (day === 0 || day === 6) { timer = setTimeout(tick, 10*60*1000); g.timer = timer; return; }

      const priceData = await fetchCurrentPrice(mt5Symbol ?? symbol);
      const price     = priceData?.mid ?? null;
      if (price !== null) {
        const better = direction === "buy" ? price > maxPrice : price < maxPrice;
        if (better) { maxPrice = price; g.maxPrice = price; g.maxRR = calcMaxRR(direction, entry, sl, price); maxRR = g.maxRR; }
        const slDist = Math.abs(entry - sl);
        if (slDist > 0) {
          const adv = direction === "buy" ? entry - price : price - entry;
          const pct = Math.max(0, Math.min(100, (adv / slDist) * 100));
          if (pct > maxSlPctUsed) { maxSlPctUsed = pct; g.maxSlPctUsed = pct; }
        }
        if (maxRR >= GHOST_MAX_RR) { await finalizeBandGhost(id, "max_rr_15", elapsed, maxPrice); return; }
        const slHit = direction === "buy" ? price <= sl : price >= sl;
        if (slHit) { await finalizeBandGhost(id, "phantom_sl", elapsed, maxPrice); return; }
      }
      timer = setTimeout(tick, GHOST_POLL_MS);
      g.timer = timer;
    } catch (e) {
      const g = bandGhostTrackers[id];
      timer = setTimeout(tick, GHOST_POLL_MS * 2);
      if (g) g.timer = timer;
    }
  }
  timer = setTimeout(tick, 3000);
  bandGhostTrackers[id].timer = timer;
  console.log(`[BandGhost] Started ${id} | ${bandTier} ${(bandPct*100).toFixed(0)}% | entry=${entry}`);
}

async function finalizeBandGhost(id, stopReason, elapsedMs, finalMaxPrice) {
  const g = bandGhostTrackers[id];
  if (!g) return;
  clearTimeout(g.timer);
  delete bandGhostTrackers[id];
  const finalMaxRR   = calcMaxRR(g.direction, g.entry, g.sl, finalMaxPrice);
  const timeToSLMin  = Math.round(elapsedMs / 60000);
  await saveBandGhost({
    signalId: g.signalId, optimizerKey: g.optimizerKey,
    symbol: g.symbol, session: g.session, direction: g.direction,
    vwapPosition: g.vwapPosition, bandTier: g.bandTier, bandPct: g.bandPct,
    entry: g.entry, sl: g.sl, slPct: g.slPct,
    maxPrice: finalMaxPrice, maxRR: finalMaxRR, maxSlPctUsed: g.maxSlPctUsed ?? 0,
    phantomSLHit: stopReason === "phantom_sl",
    stopReason, timeToSLMin: stopReason === "phantom_sl" ? timeToSLMin : null,
    openedAt: g.openedAt, closedAt: new Date().toISOString(),
  }).catch(() => {});
  console.log(`[BandGhost] Finalized ${id} | maxRR=${finalMaxRR}R | reason=${stopReason}`);
}

// ── SL Reduction Optimizer ────────────────────────────────────────
// Uses finalized ghost trades to analyse if SL can be tightened.
// Requires 30 ghosts. Sweeps SL from 10%→100% of original distance.
// At each level: ghosts where maxSlPctUsed > level survive (SL not hit early).
// Shows EV change + WR drop so you can make an informed cut decision.
async function runShadowOptimizer(optimizerKey) {
  try {
    const ghosts = await loadGhostTrades(optimizerKey, 2000);
    const valid  = ghosts.filter(g => g.phantomSLHit && (g.maxRRBeforeSL ?? 0) > 0 && g.maxSlPctUsed != null);
    const n      = valid.length;
    const MIN_GHOSTS = 30;
    if (n < MIN_GHOSTS) {
      shadowResults[optimizerKey] = { optimizerKey, n, ready: false,
        message: `Need ${MIN_GHOSTS - n} more ghosts (have ${n}/${MIN_GHOSTS})` };
      return;
    }
    const evData = await computeEVStats(optimizerKey);
    const baseEV = evData?.bestEV ?? null;
    const baseRR = evData?.bestRR ?? 2.0;
    const baseWR = baseRR ? valid.filter(g => g.maxRRBeforeSL >= baseRR).length / n : 0;

    const slPcts = valid.map(g => g.maxSlPctUsed).sort((a, b) => a - b);
    const pctile = (p) => slPcts[Math.min(n - 1, Math.floor(p / 100 * n))];
    const p50 = pctile(50), p75 = pctile(75), p90 = pctile(90), p99 = pctile(99);
    const maxUsed = slPcts[n - 1];

    // Sweep: at SL tightness X%, ghosts where maxSlPctUsed > X would have been stopped early
    // Those become losses at the tighter SL. Survivors: maxSlPctUsed <= X (never touched tighter SL)
    const levels = [];
    for (let sl = 10; sl <= 100; sl += 5) {
      const hitTighter  = valid.filter(g => g.maxSlPctUsed > sl).length; // stopped early by tighter SL
      const stillHitTP  = valid.filter(g => g.maxSlPctUsed <= sl && g.maxRRBeforeSL >= baseRR).length;
      const newWR       = (valid.filter(g => g.maxRRBeforeSL >= baseRR && g.maxSlPctUsed <= sl).length +
                           valid.filter(g => g.maxRRBeforeSL >= baseRR && g.maxSlPctUsed > sl).length * 0) / n;
      // Simpler: at tighter SL, any ghost that reached baseRR AND didn't get knocked out is a win
      const wins  = valid.filter(g => g.maxRRBeforeSL >= baseRR && g.maxSlPctUsed <= sl).length;
      const newWRfinal = wins / n;
      const newEV = parseFloat((newWRfinal * baseRR - (1 - newWRfinal)).toFixed(4));
      const wrDrop = parseFloat(((newWRfinal - baseWR) * 100).toFixed(1));
      levels.push({ sl, wins, hitTighter, newWR: parseFloat((newWRfinal * 100).toFixed(1)), newEV, wrDrop });
    }

    // Best reduction: tightest SL where EV > 0 and WR drops < 10 percentage points
    const safeLevels = levels.filter(l => l.newEV > 0 && l.wrDrop > -10.0);
    const recommendation = safeLevels.length
      ? { reduceTo: safeLevels[0].sl, saving: 100 - safeLevels[0].sl,
          newEV: safeLevels[0].newEV, newWR: safeLevels[0].newWR, wrDrop: safeLevels[0].wrDrop }
      : null;

    const analysis = {
      optimizerKey, n, ready: true,
      symbol: optimizerKey.split("_")[0], session: optimizerKey.split("_")[1] ?? "",
      direction: optimizerKey.split("_")[2] ?? "", vwapPosition: optimizerKey.split("_")[3] ?? "unknown",
      p50, p75, p90, p99, maxUsed, baseEV, baseRR, baseWR: parseFloat((baseWR * 100).toFixed(1)),
      levels, recommendation,
      message: recommendation
        ? `Reduce SL to ${recommendation.reduceTo}% — saves ${recommendation.saving}% width, EV ${recommendation.newEV > 0 ? "+" : ""}${recommendation.newEV}, WR ${recommendation.wrDrop}%`
        : "No safe SL reduction — keep current SL",
    };
    shadowResults[optimizerKey] = analysis;
    await saveShadowAnalysis(analysis);
    console.log(`[SL-Opt] ${optimizerKey}: n=${n} maxUsed=${maxUsed}% rec=${recommendation?.reduceTo ?? "none"}%`);
  } catch (e) { console.warn(`[SL-Opt] ${optimizerKey}:`, e.message); }
}

async function runAllShadowOptimizers() {
  const keys = new Set(Object.values(openPositions).map(p => p.optimizerKey).filter(Boolean));
  for (const key of Object.keys(shadowResults)) keys.add(key);
  for (const key of keys) await runShadowOptimizer(key).catch(() => {});
}

// ── Position sync (FIX 9: rate-limited, FIX 13: clear restore flag) ──
// ── Position sync ─────────────────────────────────────────────────
// Syncs price, PnL and close events from MT5 every ~55s.
async function syncOpenPositions() {
  const now = Date.now();
  if (now - lastSyncAt < SYNC_MIN_INTERVAL_MS) return;
  lastSyncAt = now;
  try {
    const live    = await fetchOpenPositions();
    const liveIds = new Set((Array.isArray(live) ? live : []).map(p => String(p.id)));
    for (const [id, pos] of Object.entries(openPositions)) {
      if (!liveIds.has(id)) { await handlePositionClosed(pos); delete openPositions[id]; }
    }
    for (const livePos of (Array.isArray(live) ? live : [])) {
      const id    = String(livePos.id);
      const local = openPositions[id];
      if (!local) continue;
      const cur    = livePos.currentPrice ?? livePos.openPrice ?? local.entry;
      const better = local.direction === "buy" ? cur > (local.maxPrice ?? cur) : cur < (local.maxPrice ?? cur);
      if (better) {
        local.maxPrice = cur;
        local.maxRR    = calcMaxRR(local.direction, local.entry, local.sl, cur);
        // Track peak positive RR (TP kant)
        if (local.maxRR > (local.peakRRPos ?? 0)) local.peakRRPos = local.maxRR;
      }
      local.currentPrice = cur;
      local.currentPnL   = livePos.unrealizedProfit ?? 0;
      local.lastSync     = new Date().toISOString();

      // Track peak adverse RR (SL kant) — bijhouden hoe ver trade naar SL gaat
      if (local.sl && local.entry && cur) {
        const slDist2 = Math.abs(local.entry - local.sl);
        if (slDist2 > 0) {
          const adverseMove2 = local.direction === 'buy' ? local.entry - cur : cur - local.entry;
          const adverseRR2   = Math.max(0, adverseMove2) / slDist2;
          const advPct2      = adverseRR2 * 100;
          if (advPct2 > (local.peakRRNeg ?? 0)) local.peakRRNeg = advPct2;
          local.maxSlPctUsed = Math.max(local.maxSlPctUsed ?? 0, advPct2);
        }
      }

      // v12.6: favorable milestones synchroniseren vanuit ghost tracker naar positie object.
      // Ghost tracker is authoritative voor favorable milestones (+0.1R..+15R).
      if (!local.rrMilestones) local.rrMilestones = { adverse: {}, favorable: {} };
      const gt = ghostTrackers[id];
      if (gt?.rrMilestones?.favorable) local.rrMilestones.favorable = gt.rrMilestones.favorable;
      if (gt?.rrMilestones?.adverse)   local.rrMilestones.adverse   = gt.rrMilestones.adverse;

      // v12.5.1: Adverse SL milestone timing voor open posities (elke 0.1R)
      // Drempels: -0.1R (10%) t/m -1.0R (100%) per 0.1 stap.
      if (local.sl && local.entry && cur) {
        const slDist = Math.abs(local.entry - local.sl);
        if (slDist > 0) {
          const adverseMove = local.direction === 'buy' ? local.entry - cur : cur - local.entry;
          const adverseRR   = Math.max(0, adverseMove) / slDist;
          if (!local.slMilestones) local.slMilestones = {};
          const nowIso = new Date().toISOString();
          const OPEN_POS_ADV_STEPS = [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0];
          let newMilestone = false;
          for (const step of OPEN_POS_ADV_STEPS) {
            const pctKey = Math.round(step * 100).toString();
            if (!local.slMilestones[pctKey] && adverseRR >= step) {
              local.slMilestones[pctKey] = nowIso;
              if (!local.rrMilestones.adverse) local.rrMilestones.adverse = {};
              local.rrMilestones.adverse[step] = nowIso;
              newMilestone = true;
              console.log(`[Pos] ${local.positionId} adverse -${step}R (${pctKey}% SL) bereikt @ ${nowIso}`);
            }
          }
          if (newMilestone) {
            saveGhostState({
              positionId:   local.positionId,
              optimizerKey: local.optimizerKey,
              symbol:       local.symbol,
              mt5Symbol:    local.mt5Symbol,
              session:      local.session,
              direction:    local.direction,
              vwapPosition: local.vwapPosition,
              entry:        local.entry,
              sl:           local.sl,
              slPct:        local.slPct,
              tpRRUsed:     local.tpRRUsed,
              maxPrice:     local.maxPrice,
              maxRR:        local.maxRR,
              maxSlPctUsed: local.maxSlPctUsed,
              openedAt:     local.openedAt,
              riskPct:      local.riskPct,
              riskEUR:      local.riskEUR,
              evMult:       local.evMult,
              dayMult:      local.dayMult,
              slMilestones: local.slMilestones,
              rrMilestones: local.rrMilestones,
              tradeNumber:  local.tradeNumber,
              peakRRPos:    local.peakRRPos,
              peakRRNeg:    local.peakRRNeg,
            }).catch(e => console.warn('[Pos] saveGhostState milestone:', e.message));
          }
        }
      }

      // v12.1: bid/ask/spread refreshen bij elke sync — ook voor herstelde posities
      // Zo zijn bid/ask niet meer null na een restart.
      if (livePos.currentPrice && !local.bid) {
        const pdSync = await fetchCurrentPrice(local.mt5Symbol || local.symbol).catch(() => null);
        if (pdSync) {
          local.bid    = pdSync.bid;
          local.ask    = pdSync.ask;
          local.spread = pdSync.spread ?? 0;
        }
      }

      // FIX 13: clear restore flag after first live sync
      if (local.restoredAfterRestart) {
        local.restoredAfterRestart = false;
        console.log(`[Sync] ${id}: restoredAfterRestart cleared`);
      }
    }
    await fetchAccountInfo().catch(() => {});
  } catch (e) { console.warn("[Sync]", e.message); }
}

// ── handlePositionClosed (FIX 6: price-based closeReason, FIX 4: realPnl) ──
async function handlePositionClosed(pos) {
  const lastPrice = pos.currentPrice ?? pos.maxPrice ?? pos.entry;

  // FIX v12.4: verbeterde closeReason detectie.
  // Primair: vergelijk lastPrice met SL/TP met een 5% tolerantie op de SL-afstand
  // om spread/slippage-variatie op te vangen. Dit voorkomt dat een SL-hit
  // als "manual" geclassificeerd wordt omdat de prijs al teruggetrokken is.
  let closeReason;
  const slDist = pos.sl > 0 ? Math.abs(pos.entry - pos.sl) : 0;
  const tolerance = slDist * 0.05; // 5% van SL-afstand als marge

  if (pos.tp != null && pos.tp > 0) {
    const tpHit = pos.direction === "buy"
      ? lastPrice >= (pos.tp - tolerance)
      : lastPrice <= (pos.tp + tolerance);
    if (tpHit) closeReason = "tp";
  }
  if (!closeReason && pos.sl > 0) {
    const slHit = pos.direction === "buy"
      ? lastPrice <= (pos.sl + tolerance)
      : lastPrice >= (pos.sl - tolerance);
    if (slHit) closeReason = "sl";
  }
  // Secundaire check: als maxRR vrijwel 0 is (< 0.05R) bij close → waarschijnlijk SL
  // Dit vangt het geval op waarbij price al teruggetrokken is van SL bij de sync.
  if (!closeReason && pos.sl > 0 && slDist > 0) {
    const maxRRCheck = pos.maxRR ?? calcMaxRR(pos.direction, pos.entry, pos.sl, lastPrice);
    if (maxRRCheck < 0.05) closeReason = "sl";
  }
  if (!closeReason) closeReason = "manual";

  const hitTP = closeReason === "tp";
  const maxRR = pos.maxRR ?? calcMaxRR(pos.direction, pos.entry, pos.sl, pos.maxPrice ?? pos.entry);
  const now   = new Date().toISOString();

  // FIX v12.4: haal MetaAPI history-deals op voor deze positie en sla ze op in DB.
  // Dit vult de deals tabel zodat fetchRealizedPnl() de echte netto P&L kan berekenen
  // (profit + commission + swap). Alleen voor SL/TP closes — niet voor manual.
  if (closeReason !== "manual") {
    await fetchAndSaveDealsForPosition(pos.positionId, pos.mt5Symbol ?? pos.symbol).catch(() => {});
  }

  // FIX 4: fetch actual realized P&L from MT5 for sl/tp; use currentPnL for manual
  let realizedPnl = pos.currentPnL ?? 0;
  if (closeReason !== "manual") {
    try {
      const fetched = await fetchRealizedPnl(pos.positionId);
      if (fetched != null) realizedPnl = fetched;
    } catch { /* fallback to currentPnL */ }
  }

  const closed = {
    ...pos, maxRR, hitTP, closeReason, closedAt: now,
    realizedPnlEUR: realizedPnl,
    spreadAtEntry:  pos.spread ?? null,
    vwapBandPct:    pos.vwapBandPct ?? null,
    // FIX 6: trueMaxRR filled later by ghost for manual closes
    trueMaxRR:   closeReason === "manual" ? null : maxRR,
    trueMaxPrice: closeReason === "manual" ? null : pos.maxPrice,
  };

  // FIX 16: cap array
  closedTrades.push(closed);
  if (closedTrades.length > MAX_CLOSED_TRADES) closedTrades.splice(0, closedTrades.length - MAX_CLOSED_TRADES);

  await saveTrade(closed).catch(() => {});
  await savePnlLog(pos.symbol, pos.session, pos.direction, pos.vwapPosition, maxRR, hitTP, realizedPnl).catch(() => {});
  logEvent({ type: "POSITION_CLOSED", symbol: pos.symbol, direction: pos.direction, maxRR, closeReason, realizedPnl });

  // FIX A: ghost continues after manual close
  if (closeReason === "manual") {
    console.log(`[Ghost] ${pos.positionId}: manual close — ghost continues (trueMaxRR will be written on finalize)`);
  }
  if (closeReason === "sl") {
    // FIX GH1 (v12.3): Ghost afsluiten bij echte SL-hit.
    // De phantom SL = echte SL, dus de ghost zou ook onmiddellijk stoppen.
    // Maar zonder dit blijft de ghost in memory doorlopen na het sluiten van de trade.
    // finalizeGhost() slaat de ghost op in DB met correcte maxRR en stopReason.
    if (ghostTrackers[pos.positionId]) {
      const elapsedMs = Date.now() - new Date(pos.openedAt ?? 0).getTime();
      const finalMaxPrice = pos.maxPrice ?? pos.currentPrice ?? pos.entry;
      console.log(`[Ghost] ${pos.positionId}: real SL hit — finalizing ghost (stopReason=real_sl_hit)`);
      await finalizeGhost(pos.positionId, "real_sl_hit", elapsedMs, finalMaxPrice).catch(e =>
        console.warn(`[Ghost] finalizeGhost on SL hit failed: ${e.message}`)
      );
    }
  }

  // FIX C: rebuild currency exposure na close van EV-neutrale forex positie
  const posInfo = getSymbolInfo(pos.symbol);
  if (posInfo?.type === "forex" && !(pos.evMult > 1.0)) {
    rebuildCurrencyExposure();
  }
}

// ── Restore positions from MT5 ────────────────────────────────────
// FIX 1: vwapPosition wordt geparsed uit de MT5 comment string.
// Comment formaat: "NV-B-XAUUSD-A-2R-LON" → vpShort 'A'=above, 'B'=below, 'U'=unknown.
// Fallback: "unknown" als comment ontbreekt of geen vpShort heeft.
function parseVwapFromComment(comment) {
  if (!comment) return "unknown";
  const parts = comment.split("-");
  if (parts.length < 3) return "unknown";
  // Nieuw formaat (v16+): NV-{dir}-{sym}-{sess}-{rr}-{vp} — vp is altijd LAATSTE onderdeel
  const last = parts[parts.length - 1];
  if (last === "A") return "above";
  // "B" kan de dir zijn (parts[1]) of de vp — check of het het laatste deel is EN niet ook parts[1]
  if (last === "B" && parts.length > 2) return "below";
  if (last === "U") return "unknown";
  // Oud formaat fallback: NV-{dir}-{sym}-{vp}-{rr}-{sess} — vp op parts[length-3]
  if (parts.length >= 5) {
    const vp = parts[parts.length - 3];
    if (vp === "A") return "above";
    if (vp === "B") return "below";
  }
  return "unknown";
}

async function restorePositionsFromMT5() {
  try {
    const live = await fetchOpenPositions();
    if (!Array.isArray(live) || !live.length) return;

    // Load persisted ghost states so maxPrice/maxSlPctUsed survive restarts
    const ghostStates = await loadAllGhostStates();
    const ghostStateMap = {};
    for (const gs of ghostStates) ghostStateMap[gs.positionId] = gs;

    let restored = 0;
    for (const lp of live) {
      const id = String(lp.id);
      if (openPositions[id]) continue;
      const sym    = normalizeSymbol(lp.symbol) ?? lp.symbol;
      const dir    = lp.type === "POSITION_TYPE_BUY" ? "buy" : "sell";
      const entry  = lp.openPrice ?? lp.currentPrice ?? 0;
      const sess   = getSession(lp.time ? new Date(lp.time) : null);
      // Fix 13: ghost_state is de primaire bron voor vwapPosition — betrouwbaarder dan
      // het MT5 comment parsen. Comment is fallback voor posities zonder ghost_state.
      const gs = ghostStateMap[id] ?? null;
      const vpFromGhostState = gs?.vwapPosition;
      const vpFromComment    = parseVwapFromComment(lp.comment ?? lp.reason ?? "");
      const vpPos = (vpFromGhostState && vpFromGhostState !== "unknown")
        ? vpFromGhostState
        : vpFromComment;
      const optKey = buildOptimizerKey(sym, sess, dir, vpPos);

      // FIX GH2 (v12.3): gebruik riskPct/riskEUR/evMult/dayMult uit ghost_state als
      // die beschikbaar zijn. Dit voorkomt dat het dashboard na een restart 0 toont
      // voor deze velden. Fallback: FIXED_RISK_PCT voor posities zonder ghost_state.
      const restoredRiskPct = gs?.riskPct  ?? FIXED_RISK_PCT;
      const restoredRiskEUR = gs?.riskEUR  ?? 0;
      const restoredEvMult  = gs?.evMult   ?? 1.0;
      const restoredDayMult = gs?.dayMult  ?? 1.0;

      openPositions[id] = {
        positionId: id, symbol: sym, mt5Symbol: lp.symbol,
        direction: dir, vwapPosition: vpPos, optimizerKey: optKey,
        entry, sl: lp.stopLoss ?? 0, tp: lp.takeProfit ?? null,
        lots: lp.volume ?? 0.01,
        riskEUR:  restoredRiskEUR,
        riskPct:  restoredRiskPct,
        evMult:   restoredEvMult,
        dayMult:  restoredDayMult,
        session: sess, openedAt: lp.time ?? new Date().toISOString(),
        maxPrice: gs?.maxPrice ?? entry,
        maxRR:    gs?.maxRR    ?? 0,
        maxSlPctUsed: gs?.maxSlPctUsed ?? 0,
        currentPnL: lp.unrealizedProfit ?? 0,
        slPct: gs?.slPct ?? null, restoredAfterRestart: true,
        // v12.6: herstel volledige milestone data uit ghost_state
        slMilestones: (gs?.slMilestones  && typeof gs.slMilestones  === 'object') ? gs.slMilestones  : {},
        rrMilestones: (gs?.rrMilestones  && typeof gs.rrMilestones  === 'object') ? gs.rrMilestones  : { adverse: {}, favorable: {} },
        tradeNumber: gs?.tradeNumber ?? null,
        peakRRPos:   gs?.peakRRPos   ?? gs?.maxRR ?? 0,
        peakRRNeg:   gs?.peakRRNeg   ?? 0,
      };
      console.log(`[Restart] ${sym} (${id}): vwapPosition='${vpPos}' riskPct=${(restoredRiskPct*100).toFixed(4)}% riskEUR=€${restoredRiskEUR.toFixed(2)} evMult=×${restoredEvMult.toFixed(2)}`);
      if (openPositions[id].sl > 0) {
        // Pass persisted ghost state if available — preserves maxPrice across deploys
        if (gs) console.log(`[Restart] Ghost ${sym} (${id}): restoring maxPrice=${gs.maxPrice} maxRR=${gs.maxRR}R maxSlPct=${gs.maxSlPctUsed}%`);
        startGhostTracker(openPositions[id], gs);
      }
      restored++;
    }

    // Clean up ghost_state rows for positions no longer open on MT5
    const liveIds = new Set(live.map(p => String(p.id)));
    for (const gs of ghostStates) {
      if (!liveIds.has(gs.positionId)) {
        await deleteGhostState(gs.positionId).catch(() => {});
        console.log(`[Restart] Cleaned stale ghost_state for ${gs.positionId}`);
      }
    }

    console.log(`[Restart] ${restored} position(s) restored from MT5`);
  } catch (e) { console.warn("[Restart]", e.message); }
}

// ── Shadow snapshot cron ──────────────────────────────────────────
// Takes a snapshot of each open position's SL% used every cron tick.
async function takeShadowSnapshots() {
  const positions = Object.values(openPositions).filter(p => p.sl > 0 && !p.restoredAfterRestart);
  for (const pos of positions) {
    try {
      const mt5Sym = pos.mt5Symbol || getSymbolInfo(pos.symbol)?.mt5 || pos.symbol;
      const pd = await fetchCurrentPrice(mt5Sym);
      if (!pd) continue;
      const liveSL  = pos.sl;
      const pct     = calcPctSlUsed(pos.direction, pos.entry, liveSL, pd.mid);
      await saveShadowSnapshot({
        positionId: pos.positionId, optimizerKey: pos.optimizerKey,
        symbol: pos.symbol, session: pos.session, direction: pos.direction,
        vwapPosition: pos.vwapPosition, entry: pos.entry,
        sl: liveSL,   // actuele SL, niet originele
        currentPrice: pd.mid, pctSlUsed: pct,
      });
    } catch (e) { /* non-critical */ }
  }
}

// ── Daily risk evaluation (FIX 7+11 + v10.6 mult correctie) ─────
async function evaluateDailyRisk() {
  try {
    const todayStr = getBrusselsDateOnly();

    // FIX v12.4: als closedTrades leeg is (eerste startup na deploy midden in de dag
    // terwijl trades al eerder die dag geopend/gesloten waren), herlees dan uit DB.
    // Zo mist evaluateDailyRisk() nooit trades die vóór de deploy zijn gesloten.
    let todayT = closedTrades.filter(t =>
      t.closedAt &&
      getBrusselsDateOnly(t.closedAt) === todayStr &&
      t.closedAt >= currentComplianceDate &&
      (t.vwapPosition === "above" || t.vwapPosition === "below")
    );

    if (todayT.length === 0) {
      // Fallback: directe DB query voor vandaag
      try {
        const r = await pool.query(`
          SELECT
            optimizer_key    AS "optimizerKey",
            realized_pnl_eur AS "pnl",
            closed_at        AS "closedAt",
            vwap_position    AS "vwapPosition"
          FROM closed_trades
          WHERE closed_at >= $1
            AND closed_at IS NOT NULL
            AND closed_at >= $2
            AND vwap_position IN ('above','below')
        `, [
          `${todayStr}T00:00:00`,
          currentComplianceDate,
        ]);
        todayT = r.rows.map(row => ({
          optimizerKey: row.optimizerKey,
          pnl: parseFloat(row.pnl ?? 0),
          closedAt: row.closedAt,
          vwapPosition: row.vwapPosition,
        }));
        if (todayT.length > 0) console.log(`[DailyRisk] DB fallback: ${todayT.length} trade(s) gevonden voor ${todayStr}`);
      } catch (e) {
        console.warn('[DailyRisk] DB fallback mislukt:', e.message);
      }
    }
    // FIX 7: use realizedPnlEUR (in-memory) or pnl (DB-fallback rows)
    const totalPnl = todayT.reduce((s, t) => s + (t.realizedPnlEUR ?? t.pnl ?? t.currentPnL ?? 0), 0);

    const keyGroups = {};
    for (const t of todayT) {
      const k = t.optimizerKey ?? buildOptimizerKey(t.symbol, t.session, t.direction, t.vwapPosition ?? "unknown");
      if (!keyGroups[k]) keyGroups[k] = { pnl: 0, count: 0 };
      keyGroups[k].pnl   += t.realizedPnlEUR ?? t.pnl ?? t.currentPnL ?? 0;
      keyGroups[k].count += 1;
    }

    // FIX 11: evaluate ALL known keys — reset streak for those without trades today
    const allKeys = new Set([...Object.keys(keyRiskMult), ...Object.keys(tpLocks), ...Object.keys(keyGroups)]);

    for (const key of allKeys) {
      const data         = keyGroups[key];
      const ev           = await computeEVStats(key);
      const isEvPositive = (ev?.bestEV ?? 0) > 0;
      const hasSample    = (ev?.count  ?? 0) >= MULT_MIN_SAMPLE;
      const isDayPositive = (data?.pnl ?? 0) > 0;
      const hadTrades     = !!data;

      const prev = keyRiskMult[key] ?? { streak: 0, evMult: 1.0, dayMult: 1.0 };

      if (hadTrades && isEvPositive && hasSample && isDayPositive) {
        // v10.6 MULT CORRECTIE:
        //   evMult  → uitsluitend bepaald door EV kwaliteit (max ×4), groeit via EV score.
        //   dayMult → groeit ×1.2 per positieve dag (cumulatief streak).
        // Beide multipliers werken uitsluitend op LOTS, NIET op riskEUR.
        const evScore    = ev.bestEV ?? 0;
        const newEvMult  = Math.min(4.0, parseFloat((1.0 + evScore * 10).toFixed(4))); // EV-gedreven
        const newDayMult = Math.min(2.0, parseFloat((prev.dayMult * 1.2).toFixed(4)));
        keyRiskMult[key] = { streak: prev.streak + 1, evMult: newEvMult, dayMult: newDayMult };
        await saveKeyRiskMult(key, keyRiskMult[key]).catch(() => {});
        console.log(`[DailyRisk] ${key}: day+ → evMult=${newEvMult.toFixed(2)}× dayMult=${newDayMult.toFixed(2)}×`);
      } else {
        keyRiskMult[key] = { streak: 0, evMult: 1.0, dayMult: 1.0 };
        await saveKeyRiskMult(key, keyRiskMult[key]).catch(() => {});
        if ((prev.dayMult ?? 1.0) > 1.0 || (prev.evMult ?? 1.0) > 1.0) {
          console.log(`[DailyRisk] ${key}: reset → ×1.0 (hadTrades=${hadTrades}, evPos=${isEvPositive}, dayPos=${isDayPositive})`);
        }
      }
    }

    // FIX v12.4: update evMult/dayMult in open posities zodat ghost_state periodic
    // save de actuele multipliers opslaat, niet de verouderde snapshot.
    for (const pos of Object.values(openPositions)) {
      const km = keyRiskMult[pos.optimizerKey];
      if (km) {
        pos.evMult  = km.evMult  ?? 1.0;
        pos.dayMult = km.dayMult ?? 1.0;
      }
    }

    await saveDailyRisk(todayStr, totalPnl, todayT.length, 1.0, 1.0);
  } catch (e) { console.warn("[DailyRisk]", e.message); }
}

// ── CRON JOBS ─────────────────────────────────────────────────────
cron.schedule("*/1 * * * *", async () => { await syncOpenPositions().catch(() => {}); }, { timezone: "Europe/Brussels" });
cron.schedule("*/1 * * * *", async () => { await takeShadowSnapshots().catch(() => {}); }, { timezone: "Europe/Brussels" });

// FIX 20: dupGuard cleanup every 5 min
cron.schedule("*/5 * * * *", () => {
  const cutoff = Date.now() - DUP_GUARD_TTL_MS;
  for (const [k, ts] of Object.entries(global._dupGuard)) { if (ts < cutoff) delete global._dupGuard[k]; }
}, { timezone: "Europe/Brussels" });

cron.schedule("0 3 * * 1-5", async () => {
  console.log("🌙 03:00 — Nightly optimizer...");
  const keys = new Set([
    ...closedTrades.map(t => buildOptimizerKey(t.symbol, t.session, t.direction, t.vwapPosition ?? "unknown")),
    ...Object.keys(shadowResults),
  ]);
  // FIX F: skip keys with active ghosts
  const activeGhostKeys = new Set(Object.values(ghostTrackers).map(g => g.optimizerKey).filter(Boolean));
  let updated = 0, skipped = 0;
  for (const key of keys) {
    const parts = key.split("_");
    if (parts.length < 4) continue;
    if (activeGhostKeys.has(key)) { skipped++; continue; }
    const [sym, sess, dir, vp] = parts;
    await updateTPLock(key, sym, sess, dir, vp).catch(() => {});
    await runShadowOptimizer(key).catch(() => {});
    updated++;
  }
  await runAllShadowOptimizers().catch(() => {});
  console.log(`[OK] Nightly optimizer done — ${updated} keys updated, ${skipped} skipped (active ghosts)`);
  logEvent({ type: "NIGHTLY_OPTIMIZER", keys: keys.size, updated, skipped });
}, { timezone: "Europe/Brussels" });

cron.schedule("0 2 * * 1-5", async () => {
  console.log("🔄 02:00 — daily reset...");
  await evaluateDailyRisk().catch(() => {});
  await restorePositionsFromMT5().catch(() => {});
  logEvent({ type: "DAILY_RESET", keyMultipliers: Object.keys(keyRiskMult).length });
}, { timezone: "Europe/Brussels" });

cron.schedule("0 4 * * 1-5", async () => {
  const cutoff = Date.now() - GHOST_MAX_MS;
  let cleaned = 0;
  for (const [id, g] of Object.entries(ghostTrackers)) {
    if (g.startTs < cutoff) {
      clearTimeout(g.timer);
      await saveGhostTrade({
        positionId: g.positionId, symbol: g.symbol, session: g.session,
        direction: g.direction, vwapPosition: g.vwapPosition,
        optimizerKey: g.optimizerKey, entry: g.entry, sl: g.sl, slPct: g.slPct,
        phantomSL: g.sl, tpRRUsed: g.tpRRUsed,
        maxPrice: g.maxPrice, maxRRBeforeSL: calcMaxRR(g.direction, g.entry, g.sl, g.maxPrice),
        phantomSLHit: false, stopReason: "timeout_2w",   // FIX v12.4: was "timeout_72h" (fout — is 14 dagen)
        timeToSLMin: null, openedAt: g.openedAt, closedAt: new Date().toISOString(),
      }).catch(() => {});
      delete ghostTrackers[id];
      cleaned++;
    }
  }
  if (cleaned > 0) { console.log(`[04:00] ${cleaned} ghost(s) cleaned up (timeout_2w)`); logEvent({ type: "GHOST_CLEANUP_2W", count: cleaned }); }
}, { timezone: "Europe/Brussels" });


// ── Detailed reject logger ────────────────────────────────────────
// Prints timestamp, symbol, reject reason, and ALL relevant payload values
// at every reject path so Railway logs have full context for debugging.
function logReject(label, { symbol, direction, session, optimizerKey, reason, payload = {} } = {}) {
  const ts = new Date().toISOString();
  console.log(`[REJECT][${ts}] ──────────────────────────────────────────`);
  console.log(`  Label    : ${label}`);
  console.log(`  Symbol   : ${symbol ?? '?'}`);
  console.log(`  Direction: ${direction ?? '?'}`);
  console.log(`  Session  : ${session ?? '?'}`);
  console.log(`  OptKey   : ${optimizerKey ?? '?'}`);
  console.log(`  Reason   : ${reason}`);
  if (Object.keys(payload).length) {
    console.log(`  Payload  :`);
    for (const [k, v] of Object.entries(payload)) {
      console.log(`    ${String(k).padEnd(22)}: ${v}`);
    }
  }
  console.log(`[REJECT] ────────────────────────────────────────────────`);
}

// ── Webhook handler ───────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const webhookReceivedAt = Date.now();

  // ── Debug log: elke inkomende webhook request zichtbaar in Railway logs ──
  console.log(`[WebhookIN][${new Date().toISOString()}] ─────────────────────────`);
  console.log(`  Method       : ${req.method}`);
  console.log(`  Content-Type : ${req.headers["content-type"] ?? "(geen)"}`);
  console.log(`  Body type    : ${typeof req.body}`);
  console.log(`  Body preview : ${JSON.stringify(req.body)?.slice(0, 300) ?? "(leeg)"}`);
  console.log(`  Query secret : ${req.query.secret ? "aanwezig" : "(geen query secret)"}`);
  console.log(`[WebhookIN] ─────────────────────────────────────────────────────`);

  const secret = req.query.secret || req.body?.secret;
  if (secret !== WEBHOOK_SECRET) {
    console.warn(`[WebhookIN] 401 UNAUTHORIZED — secret mismatch. Query: "${req.query.secret ?? "(geen)"}" Body.secret: "${req.body?.secret ?? "(geen)"}"`);
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body || {};
  const { action, symbol: rawSymbol, vwap, vwap_upper, vwap_lower } = body;

  // session_high / session_low kunnen NaN zijn vanuit TradingView Pine Script.
  // Sanitize: NaN → null zodat ze nooit DB of log vervuilen.
  const rawSessionHigh = parseFloat(body.session_high);
  const rawSessionLow  = parseFloat(body.session_low);
  const sessionHigh = isNaN(rawSessionHigh) ? null : rawSessionHigh;
  const sessionLow  = isNaN(rawSessionLow)  ? null : rawSessionLow;

  // TV stuurt entry + sl (absolute prijzen) + sl_pct (genegeerd).
  // Server berekent derivedSlPct zelf: |entry - sl| / entry
  // Pine Script hoeft NIETS te wijzigen.
  const tvEntry = parseFloat(body.entry ?? body.entry_price) || 0;
  const tvSL    = parseFloat(body.sl    ?? body.sl_price)    || 0;

  const direction = action === "buy" ? "buy" : action === "sell" ? "sell" : null;
  if (!direction) return res.status(400).json({ error: "action must be buy or sell" });

  const symKey  = normalizeSymbol(rawSymbol);
  const symInfo = symKey ? getSymbolInfo(symKey) : null;
  if (!symKey || !symInfo) {
    const _r1 = `Symbol not in catalog: ${rawSymbol}`;
    logReject("SYMBOL_NOT_IN_CATALOG", { symbol: rawSymbol, direction, reason: _r1, payload: {
      rawSymbol, action, tvEntry, tvSL,
      sessionHigh, sessionLow,
    }});
    logEvent({ type: "REJECTED", reason: _r1 });
    await logSignal({ symbol: rawSymbol, direction, outcome: "REJECTED", rejectReason: _r1 }).catch(() => {});
    return res.status(400).json({ error: `Symbol not allowed: ${rawSymbol}` });
  }
  const { type: assetType, mt5: mt5Symbol } = symInfo;

  // Server berekent derivedSlPct — sl_pct van TV volledig genegeerd.
  const derivedSlPct = deriveSLPct(tvEntry, tvSL);

  // FIX v12.4: validatie rekent met de EFFECTIEVE MT5 SL-afstand na buffer.
  // Voor stocks is de buffer 3×, dus de TV SL mag maximaal 5%/3 = 1.67% zijn.
  // Voor overige assets: buffer 1.5×, dus max 5%/1.5 = 3.33%.
  // De grens van 5% geldt voor de MT5 SL (na buffer), niet de TV SL.
  const slBufferForType  = assetType === "stock" ? STOCK_SL_BUFFER_MULT : SL_BUFFER_MULT;
  const maxDerivedSlPct  = 0.05 / slBufferForType;  // 1.67% voor stocks, 3.33% voor rest

  if (!derivedSlPct || derivedSlPct <= 0 || derivedSlPct > maxDerivedSlPct) {
    const slPctHuman = derivedSlPct ? (derivedSlPct * 100).toFixed(3) + "%" : "invalid";
    const mt5SlPct   = derivedSlPct ? (derivedSlPct * slBufferForType * 100).toFixed(3) + "%" : "?";
    const reason = `SL_INVALID: derivedSlPct=${slPctHuman} → MT5 SL≈${mt5SlPct} (max ${(maxDerivedSlPct*100).toFixed(2)}% voor ${assetType}, entry=${tvEntry}, sl=${tvSL}).`;
    logReject("SL_INVALID", { symbol: symKey, direction, reason, payload: {
      tvEntry, tvSL, derivedSlPct: derivedSlPct ?? "null",
      slPctHuman, assetType, mt5Symbol, slBufferForType,
      maxDerivedSlPct: (maxDerivedSlPct*100).toFixed(2) + "%",
      mt5SlPct,
      sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
    }});
    logEvent({ type: "REJECTED", reason, symbol: symKey, direction });
    await logSignal({ symbol: symKey, direction, tvEntry, slPct: derivedSlPct ?? null, outcome: "REJECTED", rejectReason: reason }).catch(() => {});
    return res.status(400).json({ error: reason });
  }
  const slPctHuman = (derivedSlPct * 100).toFixed(3) + "%";

  const session     = getSession();
  const closePrice  = tvEntry;
  const vwapMid      = parseFloat(vwap)       || 0;
  const vwapUpper    = parseFloat(vwap_upper) || 0;
  const vwapLower    = parseFloat(vwap_lower) || 0;
  const vwapPosition = getVwapPosition(closePrice, vwapMid);
  const optimizerKey = buildOptimizerKey(symKey, session, direction, vwapPosition);

  // VWAP band exhaustion filter
  let vwapBandPct = null;
  const bandWidth = vwapUpper - vwapLower;

  // Fix 9: Als vwapMid aanwezig is maar bandWidth = 0 → VWAP data ontbreekt.
  // Vroeger werd de check overgeslagen, waardoor trades zonder VWAP band altijd doorkwamen.
  // Risico: Pine Script stuurt soms 0 voor band waarden bij herinitialisatie.
  if (vwapMid > 0 && bandWidth <= 0) {
    const reason = "VWAP_BAND_MISSING: vwap_upper/lower zijn 0 of ontbreken — mogelijk indicator niet geïnitialiseerd";
    logReject("VWAP_BAND_MISSING", { symbol: symKey, direction, reason, payload: { vwapMid, vwapUpper, vwapLower } });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct: null, outcome: "REJECTED", rejectReason: reason }).catch(() => {});
    return res.status(200).json({ status: "VWAP_BAND_MISSING", vwapMid, vwapUpper, vwapLower });
  }

  if (bandWidth > 0 && vwapMid > 0) {
    const distFromMid = Math.abs(closePrice - vwapMid);
    vwapBandPct = parseFloat((distFromMid / (bandWidth / 2)).toFixed(3));
    // VWAP band threshold: stocks 250% (NY market hours only), forex/index/commodity 150%
    const vwapBandThreshold = assetType === 'stock' ? 2.5 : 1.5;
    if (vwapBandPct > vwapBandThreshold) {
      const reason = `VWAP_BAND_EXHAUSTED: ${(vwapBandPct * 100).toFixed(0)}% into band`;
      logReject("VWAP_BAND_EXHAUSTED", { symbol: symKey, direction, session, optimizerKey, reason, payload: {
        closePrice, vwapMid, vwapUpper, vwapLower,
        vwapBandPct: (vwapBandPct * 100).toFixed(1) + "%",
        vwapPosition, derivedSlPct: slPctHuman,
        sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
      }});
      logEvent({ type: "REJECTED", reason, symbol: symKey, direction, optimizerKey, vwapBandPct });
      const signalLogRow = await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct, outcome: "REJECTED", rejectReason: reason }).catch(() => null);

      // ── Ghost 2.0: start a band ghost for this rejected signal ──────
      const pct = vwapBandPct;
      const bandTier = assetType === 'stock'
        ? (pct >= 3.5 ? "350_500" : "250_350")
        : (pct >= 2.5 ? "250_350" : "150_250");
      if (pct < 5.0) {
        const tempSLForBand   = calcSLFromDerivedPct(direction, closePrice, derivedSlPct, assetType);
        const enforcedSLBand  = enforceMinStop(mt5Symbol, direction, closePrice, tempSLForBand);
        startBandGhostTracker({
          signalId:      signalLogRow?.id ?? null,
          optimizerKey, symbol: symKey, mt5Symbol, session, direction, vwapPosition,
          bandTier, bandPct: pct,
          entry: closePrice, sl: enforcedSLBand, slPct: derivedSlPct,
          openedAt: new Date().toISOString(),
        });
      }
      return res.status(200).json({ status: "VWAP_BAND_EXHAUSTED", vwapBandPct });
    }
  }

  // Trade window check
  const tradeWindow = canOpenNewTrade(symKey);
  if (!tradeWindow.allowed) {
    logReject("OUTSIDE_TRADE_WINDOW", { symbol: symKey, direction, session, optimizerKey, reason: tradeWindow.reason, payload: {
      assetType, closePrice, derivedSlPct: slPctHuman,
      vwapPosition, vwapBandPct: vwapBandPct ?? "n/a",
      sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
    }});
    logEvent({ type: "REJECTED", reason: tradeWindow.reason, symbol: symKey, direction, assetType });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct, outcome: "OUTSIDE_WINDOW", rejectReason: tradeWindow.reason }).catch(() => {});
    return res.status(200).json({ status: "OUTSIDE_TRADE_WINDOW", reason: tradeWindow.reason, assetType });
  }

  // Duplicate guard
  const dupKey  = `${symKey}_${direction}`;
  const dupLast = global._dupGuard?.[dupKey];
  if (dupLast && (Date.now() - dupLast) < DUP_GUARD_TTL_MS) {
    const _dupAge = Math.round((Date.now() - dupLast) / 1000);
    logReject("DUPLICATE_BLOCKED", { symbol: symKey, direction, session, optimizerKey, reason: `Duplicate within TTL (${_dupAge}s ago, TTL=${DUP_GUARD_TTL_MS/1000}s)`, payload: {
      dupKey, dupAgeSeconds: _dupAge, ttlSeconds: DUP_GUARD_TTL_MS / 1000,
      closePrice, derivedSlPct: slPctHuman,
      sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
    }});
    logEvent({ type: "DUPLICATE_BLOCKED", symbol: symKey, direction, optimizerKey });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "DUPLICATE_BLOCKED" }).catch(() => {});
    return res.status(200).json({ status: "DUPLICATE_BLOCKED" });
  }
  global._dupGuard[dupKey] = Date.now();

  // ── Anti-consolidation ────────────────────────────────────────────
  // MetaApi REST ondersteunt geen positie modify (SL/TP aanpassen na open).
  // Enige optie: blokkeren als zelfde symbol+richting al open staat.
  // Ongeacht sessie — een open trade leeft over sessies heen.
  {
    const sameCount = countSameDirection(symKey, direction);
    if (sameCount >= MAX_SAME_DIRECTION) {
      const existing = Object.values(openPositions).find(p => p.symbol === symKey && p.direction === direction);
      const reason = `DUPLICATE_BLOCKED: ${symKey} ${direction} al open (pos=${existing?.positionId} sess=${existing?.session}) — MetaApi ondersteunt geen SL modify`;
      logReject("DUPLICATE_BLOCKED", { symbol: symKey, direction, session, optimizerKey, reason, payload: {
        existingPositionId: existing?.positionId, existingSession: existing?.session,
        existingEntry: existing?.entry, existingOpenedAt: existing?.openedAt,
        closePrice, derivedSlPct: slPctHuman,
      }});
      logEvent({ type: "DUPLICATE_BLOCKED", symbol: symKey, direction, session, optimizerKey,
        existingPositionId: existing?.positionId });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey,
        tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct,
        outcome: "DUPLICATE_BLOCKED", rejectReason: reason }).catch(() => {});
      return res.status(200).json({ status: "DUPLICATE_BLOCKED", reason,
        existingPositionId: existing?.positionId });
    }
  }

  // ── Risk & lots ───────────────────────────────────────────────────
  // v10.6 MULT CORRECTIE:
  //   riskEUR = balance × pct (puur, geen evMult).
  //   EV+ (evMult > 1.0): finalLots = baseLots × evMult × dayMult.
  //     → tellen NIET mee in currency budget.
  //   EV neutraal (evMult = 1.0): finalLots = baseLots × scaleFactor.
  //     → tellen WEL mee in currency budget.
  const riskPct  = getSymbolRiskPct(symKey);
  const evMult   = getKeyEvMult(optimizerKey);
  const dayMult  = getKeyDayMult(optimizerKey);
  const isEvPlus = evMult > 1.0;

  // Puur riskEUR — geen multipliers
  const riskEUR  = await calcRiskEUR(symKey);
  const balance  = await getLiveBalance();

  // FIX R4 (v11.0): lotDivisor anti-consolidation VERWIJDERD.
  // Was bedoeld voor currency correlatie maar zorgde voor inconsistente
  // lotgroottes per pair. Uniform 0.15% risk per trade ongeacht correlatie.
  const lotDivisor = 1; // altijd 1 — geen divisie meer

  // FIX R1 (v11.0): DEFAULT_TP_RR=2.0R bij geen data, EV lock zodra ≥5 ghosts
  const tpRR    = await getOptimalTP(optimizerKey);
  const rrLabel = tpRR % 1 === 0 ? `${tpRR}R` : `${tpRR.toFixed(1)}R`;

  // Voorlopige SL voor lot berekening (op closePrice) — lotVal wordt live bijgewerkt
  // FIX DAX: enforceMinStop wordt NU ook op tempSL toegepast zodat lots berekend worden
  // op dezelfde SL-afstand die straks naar MT5 gaat. Zonder dit: bij een krappe TV SL
  // (bijv. 2pt DAX) rekende calcLots op 2pt, maar MT5 SL werd 10pt → werkelijk risk 5×
  // hoger dan bedoeld. Nu is tempSL altijd ≥ minStop afstand, consistente lot sizing.
  // v12.3: stocks gebruiken 3× buffer → bredere tempSL → juiste (lagere) lots.
  const tempSLRaw = calcSLFromDerivedPct(direction, closePrice || 1, derivedSlPct, assetType);
  const tempSL    = enforceMinStop(mt5Symbol, direction, closePrice || 1, tempSLRaw);
  const symInfoL = getSymbolInfo(symKey);
  let   lotVal   = LOT_VALUE[symInfoL?.type || "stock"] ?? 1; // fallback, overschreven door live MT5 spec
  const tempDist = Math.abs((closePrice || 1) - tempSL);

  let lots;
  {
    // v12.0: geen lot overrides meer — altijd live MT5 spec berekening
    const calcResult = await calcLots(symKey, mt5Symbol, assetType, closePrice || 1, tempSL, riskEUR, evMult, dayMult);
    lots = calcResult.lots;
    lotVal = calcResult.lotVal;
    console.log(`[Lots] ${symKey}: ${calcResult.source} lotVal=${lotVal} baseLots→${lots}`);
  }

  // FIX C: currency exposure budget check (alleen voor EV neutraal + forex)
  let scaleFactor = 1.0;
  if (!isEvPlus && assetType === "forex") {
    scaleFactor = await calcCurrencyScaleFactor(symKey, lots, tempDist, lotVal);
    if (scaleFactor <= 0) {
      const reason = `CURRENCY_BUDGET_EXHAUSTED: ${symKey} — beide valuta's op budget ceiling`;
      logReject("CURRENCY_BUDGET_EXHAUSTED", { symbol: symKey, direction, session, optimizerKey, reason, payload: {
        lots, tempDist, lotVal, scaleFactor: 0,
        evMult, isEvPlus, assetType,
        currencies: getPairCurrencies(symKey).join("/"),
        currentExposure: JSON.stringify(Object.fromEntries(getPairCurrencies(symKey).map(c => [c, (currencyExposure[c] ?? 0).toFixed(2)]))),
        sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
      }});
      logEvent({ type: "REJECTED", reason, symbol: symKey, direction, optimizerKey, evMult, scaleFactor: 0 });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "CURRENCY_BUDGET_EXHAUSTED", rejectReason: reason }).catch(() => {});
      return res.status(200).json({ status: "CURRENCY_BUDGET_EXHAUSTED", reason });
    }
    if (scaleFactor < 1.0) {
      lots = Math.max(0.01, parseFloat((lots * scaleFactor).toFixed(2)));
      console.log(`[CurrBudget] ${symKey}: scaleFactor=${scaleFactor.toFixed(3)} → lots=${lots}`);
      logEvent({ type: "LOTS_SCALED_CURRENCY_BUDGET", symbol: symKey, direction, scaleFactor, lots });
    }
  }

  if (!lots || lots <= 0) {
    logReject("LOT_CALC_FAILED", { symbol: symKey, direction, session, optimizerKey, reason: "calcLots returned 0 or undefined", payload: {
      lots, lotVal, riskEUR: riskEUR?.toFixed(2), tempDist, closePrice,
      derivedSlPct: slPctHuman, assetType, mt5Symbol,
      sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
    }});
    logEvent({ type: "REJECTED", reason: "calcLots returned 0", symbol: symKey, direction });
    return res.status(200).json({ status: "LOT_CALC_FAILED" });
  }

  // Step A: Place market order
  const sessShort = session === "london" ? "LON" : session === "ny" ? "NY" : "AS";
  const dirShort  = direction === "buy" ? "B" : "S";
  const vpShort   = vwapPosition === "above" ? "A" : vwapPosition === "below" ? "B" : "U";
  // Fix 1: vpShort staat ALTIJD als laatste karakter — parseVwapFromComment leest last char.
  // Geen .slice(0,26) meer — decimale RR in midden (bijv "1.5R") telt extra "-" mee als
  // scheidingsteken waardoor de positie van vpShort onbetrouwbaar werd.
  // Nieuw formaat: NV-{dir}-{sym}-{sess}-{rr}-{vp}  → vpShort altijd op positie -1
  const comment = `NV-${dirShort}-${symKey.slice(0, 8)}-${sessShort}-${rrLabel}-${vpShort}`;
  // Resultaat: NV-B-USDCHF-A-2R-LON (buy, above VWAP, london)
  //            NV-S-XAUUSD-B-2R-LON (sell, below VWAP, london)
  // Fix 1: Haal live MT5 prijs op VOOR de order.
  // TV entry + TV SL → derivedSlPct al bekend. Nu: live MT5 bid/ask ophalen,
  // zelfde % eraf/erbij zetten voor SL (×1.5 buffer), TP berekenen op die prijs.
  // Alles meegestuurd in de orderPayload — geen aparte modify nodig als fallback.
  let preBid = null, preAsk = null, preSpread = 0;
  let preExecPrice = closePrice; // fallback op TV entry als MT5 niet bereikbaar
  try {
    const prePd = await fetchCurrentPrice(mt5Symbol);
    if (prePd) {
      preBid    = prePd.bid;
      preAsk    = prePd.ask;
      preSpread = prePd.spread ?? 0;
      // Gebruik bid voor sell, ask voor buy — dit is de realistische executieprijs
      preExecPrice = direction === "buy"
        ? (prePd.ask ?? prePd.mid ?? closePrice)
        : (prePd.bid ?? prePd.mid ?? closePrice);
      console.log(`[PreOrder] ${mt5Symbol}: bid=${preBid} ask=${preAsk} spread=${preSpread} → preExec=${preExecPrice}`);
    }
  } catch (e) {
    console.warn(`[PreOrder] fetchCurrentPrice failed (${e.message}) — fallback op TV entry ${closePrice}`);
  }

  // Bereken SL/TP op live MT5 prijs vóór de order
  // derivedSlPct = |tvEntry - tvSL| / tvEntry (al berekend bovenaan)
  // Zelfde % op MT5 live prijs toepassen, met buffer (×1.5 standaard, ×3.0 voor stocks)
  const preMt5SL = enforceMinStop(mt5Symbol, direction,
    preExecPrice, calcSLFromDerivedPct(direction, preExecPrice, derivedSlPct, assetType));
  const preMt5TP = applyTPFloorGuard(direction, preExecPrice, preMt5SL,
    calcTPPrice(direction, preExecPrice, preMt5SL, tpRR));
  console.log(`[PreOrder] SL=${preMt5SL} TP=${preMt5TP} (${tpRR}R) op preExec=${preExecPrice} | derivedSlPct=${slPctHuman}`);

  const orderPayload = {
    symbol: mt5Symbol,
    actionType: direction === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
    volume: lots, comment,
    stopLoss:   preMt5SL,  // Fix 1: direct in order — werkt ook als modify later faalt
    takeProfit: preMt5TP,  // Fix 1: direct in order
  };

  let result, positionId;
  try {
    result     = await placeOrder(orderPayload);
    positionId = String(result?.positionId ?? result?.orderId ?? `local_${Date.now()}`);
  } catch (e) {
    const errMsg = e.message;
    const latencyMs = Date.now() - webhookReceivedAt;
    logEvent({ type: "ERROR", symbol: symKey, direction, reason: errMsg, optimizerKey });
    await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition, action, status: "ERROR", reason: errMsg, optimizerKey, entry: closePrice, sl: null, tp: null, lots, riskPct, latencyMs, tvEntry: closePrice, vwapBandPct });
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "ORDER_FAILED", rejectReason: errMsg, latencyMs }).catch(() => {});
    return res.status(200).json({ status: "ORDER_FAILED", error: errMsg });
  }

  // Step B: Read back real execution price
  // Pre-order SL/TP al actief in MT5. Nu verfijnen op werkelijke fill prijs.
  let executionPrice = preExecPrice; // start van live MT5 prijs, niet TV entry
  let spread = preSpread, bid = preBid, ask = preAsk;
  try {
    await new Promise(r => setTimeout(r, 2500));
    const positions = await fetchOpenPositions();

    // FIX C1 (v11.3): local_ positionId guard.
    // Als MetaApi geen positionId gaf na placeOrder() → fake ID gegenereerd.
    // Zoek de echte positie op basis van symbol + richting + recent geopend (<30s).
    if (positionId.startsWith("local_")) {
      const nowMs   = Date.now();
      const matched = Array.isArray(positions)
        ? positions.find(p =>
            p.symbol === mt5Symbol &&
            (direction === "buy"
              ? p.type === "POSITION_TYPE_BUY"
              : p.type === "POSITION_TYPE_SELL") &&
            (p.time ? nowMs - new Date(p.time).getTime() < 30000 : true)
          )
        : null;
      if (matched) {
        console.log(`[Order] local_ ID opgelost → echte positionId=${matched.id} (${mt5Symbol} ${direction})`);
        positionId = String(matched.id);
      } else {
        // Positie bestaat niet op MT5 — niet opslaan in DB
        const errMsg = `ORDER_NOT_CONFIRMED: geen positionId van MetaApi en positie niet gevonden op MT5 (${mt5Symbol} ${direction})`;
        console.warn(`[Order] ${errMsg}`);
        logEvent({ type: "ERROR", symbol: symKey, direction, reason: errMsg, optimizerKey });
        await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition, action,
          status: "ORDER_NOT_CONFIRMED", reason: errMsg, optimizerKey,
          entry: closePrice, sl: null, tp: null, lots, riskPct,
          latencyMs: Date.now() - webhookReceivedAt, tvEntry: closePrice, vwapBandPct });
        await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey,
          tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct,
          outcome: "ORDER_NOT_CONFIRMED", rejectReason: errMsg,
          latencyMs: Date.now() - webhookReceivedAt }).catch(() => {});
        return res.status(200).json({ status: "ORDER_NOT_CONFIRMED", error: errMsg });
      }
    }

    const realPos = Array.isArray(positions) ? positions.find(p => String(p.id) === positionId) : null;
    if (realPos?.openPrice) executionPrice = parseFloat(realPos.openPrice);
    // Refresh spread na fill
    const pd = await fetchCurrentPrice(mt5Symbol);
    if (pd) { bid = pd.bid; ask = pd.ask; spread = pd.spread ?? 0; }
  } catch { /* pre-order waarden blijven actief als fallback */ }

  const slippage = parseFloat((executionPrice - closePrice).toFixed(5));

  // v10.7 FIX 3: Spread opslaan in spread_log voor tijdzone analyse
  if (bid != null && ask != null) {
    const spreadAbs = parseFloat((ask - bid).toFixed(8));
    const spreadPct = bid > 0 ? parseFloat((spreadAbs / bid * 100).toFixed(6)) : null;
    const { hour, minute, day } = getBrusselsComponents();
    saveSpreadLog({
      symbol: symKey, mt5Symbol, session,
      hourBrussels: hour, minuteBrussels: minute, dayOfWeek: day,
      bid, ask, spreadAbs, spreadPct, assetType, positionId,
    }).catch(() => {});
  }

  // FIX 5: spread guard voor stocks.
  // FIX v12.4: de guard vergelijkt spread met de ONGEBUFFERDE SL-afstand (derivedSlPct ×1,
  // niet ×3) zodat de drempel niet meeschaalt met de bredere buffer.
  // Rationale: spread is een fixed kost; de SL-buffer beschermt tegen slippage maar
  // verandert de economische betekenis van de spread-ratio niet.
  // Blokkeer als spread > 25% van de originele (ongebufferde) SL-afstand.
  if (assetType === "stock" && spread > 0) {
    const unbufferedSLDist = Math.abs(executionPrice * derivedSlPct); // originele TV SL-afstand
    if (unbufferedSLDist > 0 && spread > 0.25 * unbufferedSLDist) {
      const reason = `SPREAD_GUARD: spread ${spread.toFixed(5)} > 25% of unbuffered SL dist ${unbufferedSLDist.toFixed(5)}`;
      logReject("SPREAD_GUARD_CLOSE", { symbol: symKey, direction, session, optimizerKey, reason, payload: {
        positionId, spread: spread.toFixed(5), unbufferedSLDist: unbufferedSLDist.toFixed(5),
        spreadPct: (spread / unbufferedSLDist * 100).toFixed(1) + "% of unbuffered SL dist",
        executionPrice, lots, assetType,
        sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
      }});
      logEvent({ type: "SPREAD_GUARD_CLOSE", symbol: symKey, direction, positionId, spread, slDist: unbufferedSLDist, reason });
      await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, outcome: "SPREAD_GUARD_CLOSE", rejectReason: reason }).catch(() => {});
      try { await closePosition(positionId); } catch {}
      return res.status(200).json({ status: "SPREAD_GUARD_CLOSE", reason, positionId });
    }
  }

  // Step C: FIX A — SL berekening op executionPrice met derivedSlPct × buffer.
  // derivedSlPct komt van server (TV absolute prijzen), NIET van TV payload.
  // Stocks: ×3.0 buffer (STOCK_SL_BUFFER_MULT), overige: ×1.5 (SL_BUFFER_MULT).
  let mt5SL = calcSLFromDerivedPct(direction, executionPrice, derivedSlPct, assetType);
  mt5SL     = enforceMinStop(mt5Symbol, direction, executionPrice, mt5SL);

  // Fix 6: Log the full SL conversion chain for audit
  {
    const slDist = Math.abs(executionPrice - mt5SL);
    const slPctActual = executionPrice > 0 ? (slDist / executionPrice * 100).toFixed(4) : "?";
    console.log(`[SL-CHAIN] ${symKey} ${direction}: TV entry=${closePrice} TV SL=${tvSL ?? "n/a"} → slPct=${(derivedSlPct*100).toFixed(4)}% → MT5 exec=${executionPrice} → MT5 SL=${mt5SL} (dist=${slDist.toFixed(5)} = ${slPctActual}%)`);
  }

  // Step C2: Recalculate lots op executionPrice — nu met live lotVal
  // FIX R5 (v11.0): lotDivisor verwijderd — uniform risk per trade.
  {
    const calcResult2 = await calcLots(symKey, mt5Symbol, assetType, executionPrice, mt5SL, riskEUR, evMult, dayMult);
    lots   = calcResult2.lots;
    lotVal = calcResult2.lotVal; // live lotVal na executie (spec al gecached)
    // FIX C: herbereken scaleFactor op echte dist met live lotVal (alleen forex EV-neutraal)
    if (!isEvPlus && assetType === "forex") {
      const realDist = Math.abs(executionPrice - mt5SL);
      scaleFactor = await calcCurrencyScaleFactor(symKey, lots, realDist, lotVal);
      if (scaleFactor <= 0) {
        try { await closePosition(positionId); } catch {}
        const reason = `CURRENCY_BUDGET_EXHAUSTED post-execution: ${symKey}`;
        logEvent({ type: "CURRENCY_BUDGET_EXHAUSTED_POSTEXEC", symbol: symKey, direction, positionId, reason });
        return res.status(200).json({ status: "CURRENCY_BUDGET_EXHAUSTED", reason, positionId });
      }
      if (scaleFactor < 1.0) {
        lots = Math.max(0.01, parseFloat((lots * scaleFactor).toFixed(2)));
      }
    }
  }

  // Step D: TP berekening
  let mt5TP = calcTPPrice(direction, executionPrice, mt5SL, tpRR);

  // FIX D: TP Floor Guard — vóór order naar MT5
  const mt5TPBeforeFloor = mt5TP;
  mt5TP = applyTPFloorGuard(direction, executionPrice, mt5SL, mt5TP);
  if (mt5TP !== mt5TPBeforeFloor) {
    logEvent({ type: "TP_FLOOR_APPLIED", symbol: symKey, direction, positionId,
      tpBefore: mt5TPBeforeFloor, tpAfter: mt5TP, executionPrice, mt5SL });
  }
  // Fix 6: Log final TP placement
  {
    const slDist = Math.abs(executionPrice - mt5SL);
    const tpDist = Math.abs(mt5TP - executionPrice);
    const rrActual = slDist > 0 ? (tpDist / slDist).toFixed(3) : "?";
    console.log(`[TP-CHAIN] ${symKey} ${direction}: MT5 TP=${mt5TP} → actual RR=${rrActual}R (target=${tpRR}R) lots=${lots}`);
  }

  // FIX E: RR Verificatie met werkelijke MT5 waarden
  const rrCheck = verifyRR(direction, executionPrice, mt5SL, mt5TP);
  if (rrCheck.slWrongSide) {
    // Emergency close + ghost tracker start (Optie A)
    console.error(`[RR_VERIFY_FAILED] ${positionId}: SL op VERKEERDE KANT! exec=${executionPrice} sl=${mt5SL} dir=${direction}`);
    logReject("RR_VERIFY_FAILED", { symbol: symKey, direction, session, optimizerKey, reason: `SL on wrong side: exec=${executionPrice} sl=${mt5SL}`, payload: {
      positionId, executionPrice, mt5SL, mt5TP, direction,
      actualSLPct: rrCheck.actualSLPct, actualTPRR: rrCheck.actualTPRR,
      derivedSlPct: slPctHuman, lots, riskEUR: riskEUR?.toFixed(2),
      sessionHigh: sessionHigh ?? "NaN→null", sessionLow: sessionLow ?? "NaN→null",
    }});
    logEvent({
      type: "RR_VERIFY_FAILED", positionId, symbol: symKey, direction,
      executionPrice, mt5SL, mt5TP,
      actualSLPct: rrCheck.actualSLPct, actualTPRR: rrCheck.actualTPRR,
    });
    // Sluit positie
    try { await closePosition(positionId); } catch (ce) {
      console.error(`[RR_VERIFY_FAILED] closePosition ${positionId} mislukt: ${ce.message}`);
    }
    // Register gesloten trade met excludeFromEV flag
    const failedTrade = {
      positionId, symbol: symKey, mt5Symbol, direction, vwapPosition,
      optimizerKey, entry: executionPrice, sl: mt5SL, tp: mt5TP,
      lots, riskEUR, riskPct, evMult, dayMult, balance,
      session, openedAt: new Date().toISOString(), closedAt: new Date().toISOString(),
      closeReason: "RR_VERIFY_FAILED", excludeFromEV: true,
      maxRR: 0, hitTP: false, realizedPnlEUR: 0,
      tvEntry: closePrice, executionPrice, slippage, vwapBandPct,
      spread, derivedSlPct,
    };
    closedTrades.push(failedTrade);
    if (closedTrades.length > MAX_CLOSED_TRADES) closedTrades.splice(0, closedTrades.length - MAX_CLOSED_TRADES);
    await saveTrade(failedTrade).catch(() => {});
    // Start ghost tracker zodat MAE + trueMaxRR bijgehouden worden
    openPositions[positionId] = { ...failedTrade, maxPrice: executionPrice, currentPnL: 0 };
    startGhostTracker(openPositions[positionId]);
    // Positie direct verwijderen uit openPositions (al gesloten)
    delete openPositions[positionId];
    await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, outcome: "RR_VERIFY_FAILED", latencyMs: Date.now() - webhookReceivedAt, positionId }).catch(() => {});
    return res.status(200).json({ status: "RR_VERIFY_FAILED", positionId, executionPrice, mt5SL, mt5TP });
  }

  // FIX E: log-only checks (niet blokkeren)
  if (rrCheck.slTooWide) {
    logEvent({ type: "SL_TOO_WIDE", positionId, symbol: symKey, actualSLPct: rrCheck.actualSLPct });
    console.warn(`[SL_TOO_WIDE] ${positionId}: actualSLPct=${(rrCheck.actualSLPct * 100).toFixed(3)}%`);
  }
  if (rrCheck.tpRRTooLow) {
    logEvent({ type: "TP_RR_TOO_LOW", positionId, symbol: symKey, actualTPRR: rrCheck.actualTPRR });
    console.warn(`[TP_RR_TOO_LOW] ${positionId}: actualTPRR=${rrCheck.actualTPRR}R`);
  }

  // Step D: Geen SL/TP modify meer — pre-order waarden blijven actief.
  // Pre-order SL (preMt5SL) en TP (preMt5TP) zijn al actief in MT5 bij de order.
  // MetaApi REST modify was instabiel en leverde SL_TP_MODIFY_FAILED events op.
  // v12.0: SL/TP direct meegegeven bij placeOrder() — dat is de enige bron van truth.
  // Gebruik pre-order waarden als definitieve SL/TP:
  mt5SL = preMt5SL;
  mt5TP = preMt5TP;
  console.log(`[SL/TP] Pre-order actief: ${positionId} SL=${mt5SL} TP=${mt5TP} (${tpRR}R) exec=${executionPrice}`);

  // Register position
  const latencyMs = Date.now() - webhookReceivedAt;
  const now = new Date().toISOString();

  // v12.5.1: wijs een uniek trade nummer toe
  const tradeNumber = await getNextTradeNumber().catch(() => null);

  openPositions[positionId] = {
    positionId, symbol: symKey, mt5Symbol, direction, vwapPosition,
    optimizerKey, entry: executionPrice, sl: mt5SL, tp: mt5TP, slPct: derivedSlPct,
    lots, riskEUR, riskPct, evMult, dayMult, balance,
    spread, bid, ask, session, openedAt: now,
    maxPrice: executionPrice, maxRR: 0, currentPnL: 0,
    vwapAtEntry: vwapMid, tpRRUsed: tpRR,
    tvEntry: closePrice, executionPrice, slippage, vwapBandPct, slPctHuman,
    lotDivisor, isEvPlus, scaleFactor, derivedSlPct,
    tradeNumber,     // v12.5.1: doorlopend trade nummer
    peakRRPos: 0,    // v12.5.1: beste positieve RR (SL kant)
    peakRRNeg: 0,    // v12.5.1: slechtste adverse RR (als % SL, positief getal)
  };

  // FIX C: currency exposure bijwerken voor EV-neutrale forex trades
  if (!isEvPlus && assetType === "forex") {
    rebuildCurrencyExposure();
  }

  startGhostTracker(openPositions[positionId]);

  // FIX E: ORDER_PLACED log uitgebreid met derivedSlPct, actualSLPct, actualTPRR
  logEvent({
    type: "ORDER_PLACED", symbol: symKey, direction, session, vwapPosition, optimizerKey,
    executionPrice, slippage, sl: mt5SL, tp: mt5TP, tpRR, rrLabel,
    lots, riskPct, riskEUR: riskEUR.toFixed(2), evMult, dayMult, lotDivisor,
    spread: spread.toFixed(5), bid, ask, balance: balance.toFixed(2),
    positionId, comment, derivedSlPct, slPctHuman, vwap: vwapMid, vwapBandPct, latencyMs,
    actualSLPct: rrCheck.actualSLPct, actualTPRR: rrCheck.actualTPRR,
    isEvPlus, scaleFactor,
    tpFloorApplied: mt5TP !== mt5TPBeforeFloor,
  });

  await logWebhook({ symbol: symKey, direction, session, vwapPos: vwapPosition, action, status: "PLACED", positionId, optimizerKey, entry: executionPrice, sl: mt5SL, tp: mt5TP, lots, riskPct, latencyMs, tvEntry: closePrice, executionPrice, slippage, vwapBandPct });
  await logSignal({ symbol: symKey, direction, session, vwapPosition, optimizerKey, tvEntry: closePrice, slPct: derivedSlPct, slPctHuman, vwap: vwapMid, vwapUpper, vwapLower, vwapBandPct, outcome: "PLACED", latencyMs, positionId }).catch(() => {});

  console.log(`[✓] ${direction.toUpperCase()} ${symKey} | key=${optimizerKey} | exec=${executionPrice} | sl=${mt5SL} tp=${mt5TP} (${rrLabel}) | lots=${lots} | riskEUR=€${riskEUR.toFixed(2)} evMult=×${evMult.toFixed(2)} dayMult=×${dayMult.toFixed(2)} derivedSlPct=${slPctHuman} | latency=${latencyMs}ms`);

  return res.status(200).json({
    status: "PLACED", positionId, symbol: symKey, direction,
    executionPrice, slippage, sl: mt5SL, tp: mt5TP, tpRR, rrLabel,
    lots, riskPct, riskEUR, evMult, dayMult, lotDivisor, optimizerKey,
    spread, bid, ask, balance, latencyMs, derivedSlPct, slPctHuman, vwapBandPct,
    actualSLPct: rrCheck.actualSLPct, actualTPRR: rrCheck.actualTPRR, isEvPlus, scaleFactor,
  });
});

// ── REST API ──────────────────────────────────────────────────────
app.get("/live/positions", (req, res) => {
  // Gebruik liveBalance direct — NOOIT await getLiveBalance() hier want dat kan
  // een MetaApi call triggeren en de response blokkeren. Balance wordt apart
  // bijgewerkt via de 5-min cron en na elke syncOpenPositions.
  const balance = liveBalance;
  const positions = Object.values(openPositions).map(p => {
    // ── Werkelijke EUR exposure (eerlijk) ─────────────────────────
    // riskEUR in het object is de PUUR berekende basis (balance × pct).
    // Door evMult en dayMult wordt de werkelijke positiegrootte groter,
    // waardoor ook de werkelijke exposure groter is.
    const info      = getSymbolInfo(p.symbol);
    const type      = info?.type || "stock";
    const mt5SymL   = info?.mt5 || p.mt5Symbol || p.symbol;
    // FIX R3 (v11.0): gebruik live symbolSpecCache voor correcte lotVal.
    // Statische LOT_VALUE[index]=20 is FOUT voor indexes (echte waarde ≈0.85).
    // symbolSpecCache bevat de live MT5 spec opgehaald bij startup + eerste trade.
    const cachedSpecL = symbolSpecCache[mt5SymL];
    const lotVal    = cachedSpecL?.lotVal ?? LOT_VALUE[type] ?? 1;
    const slDist    = p.sl > 0 ? Math.abs(p.entry - p.sl) : 0;
    // actualRiskEUR = werkelijke verlies bij SL hit (lots × slDist × lotVal)
    const actualRiskEUR = slDist > 0 ? parseFloat((p.lots * slDist * lotVal).toFixed(2)) : null;
    // actualRiskPct = actualRiskEUR als % van balance
    const actualRiskPct = actualRiskEUR && balance > 0
      ? parseFloat((actualRiskEUR / balance * 100).toFixed(4)) : null;
    // SL distance % op basis van huidige MT5 SL (live, niet origineel)
    const slDistPct = p.sl && p.entry
      ? parseFloat((Math.abs(p.entry - p.sl) / p.entry * 100).toFixed(3)) : null;
    // TP RR op basis van huidige MT5 SL/TP (live)
    const tpRRActual = p.tp && p.sl && p.entry && slDist > 0
      ? parseFloat((Math.abs(p.tp - p.entry) / slDist).toFixed(3)) : null;

    return {
      positionId: p.positionId, symbol: p.symbol, direction: p.direction,
      session: p.session, vwapPosition: p.vwapPosition, optimizerKey: p.optimizerKey,
      entry: p.entry, sl: p.sl, tp: p.tp, lots: p.lots,
      riskPct: p.riskPct,
      riskEUR: p.riskEUR,          // basis puur (balance × pct)
      actualRiskEUR,               // werkelijk bij SL: lots × dist × lotVal
      actualRiskPct,               // werkelijk % van balance
      evMult: p.evMult ?? 1.0, dayMult: p.dayMult ?? 1.0,
      spread: p.spread ?? 0, bid: p.bid, ask: p.ask,
      currentPrice: p.currentPrice, currentPnL: p.currentPnL,
      maxRR: p.maxRR, tpRR: p.tpRRUsed,
      tpRRActual,                  // live TP RR op basis van huidige MT5 SL
      openedAt: p.openedAt, balance: p.balance,
      slDistPct,
      slPctUsed: p.currentPrice ? calcPctSlUsed(p.direction, p.entry, p.sl, p.currentPrice) : null,
      isGhosted: !!ghostTrackers[p.positionId],
      lotDivisor: p.lotDivisor ?? 1,
      isEvPlus: p.isEvPlus ?? false,
      scaleFactor: p.scaleFactor ?? 1.0,
      slMilestones: p.slMilestones ?? null,
      rrMilestones: p.rrMilestones ?? null,   // v12.6: favorable milestones voor open pos tabel
      tradeNumber: p.tradeNumber ?? null,
      peakRRPos: p.peakRRPos ?? p.maxRR ?? 0,
      peakRRNeg: p.peakRRNeg ?? 0,
    };
  });
  res.json({ count: positions.length, balance, positions });
});

app.get("/live/ghosts", (req, res) => {
  const ghosts = Object.values(ghostTrackers).map(g => {
    const livePos     = openPositions[g.positionId];
    const liveSL      = livePos?.sl ?? g.sl;
    const livePrice   = livePos?.currentPrice ?? g.maxPrice;

    // FIX v12.1.3: neem de beste maxPrice van alle bronnen voor eerlijke maxRR display.
    // openPositions.maxPrice wordt bijgewerkt door syncOpenPositions() elke 55s — pikt
    // gunstige pieken op die tussen ghost ticks (30s) vallen.
    let bestMaxPrice = g.maxPrice ?? g.entry;
    const livePosMax = livePos?.maxPrice;
    if (livePosMax != null) {
      if (g.direction === "buy"  && livePosMax > bestMaxPrice) bestMaxPrice = livePosMax;
      if (g.direction === "sell" && livePosMax < bestMaxPrice) bestMaxPrice = livePosMax;
    }

    return {
      positionId: g.positionId, symbol: g.symbol, optimizerKey: g.optimizerKey,
      direction: g.direction, session: g.session, vwapPosition: g.vwapPosition,
      entry: g.entry, sl: liveSL, maxPrice: bestMaxPrice,
      phantomSL: liveSL,
      maxRR: calcMaxRR(g.direction, g.entry, liveSL, bestMaxPrice),
      tpRRUsed: g.tpRRUsed,
      elapsedMin: Math.round((Date.now() - g.startTs) / 60000),
      openedAt: g.openedAt,
      slPctUsed: liveSL && g.entry && livePrice
        ? calcPctSlUsed(g.direction, g.entry, liveSL, livePrice) : 0,
      slMilestones: g.slMilestones ?? null,
      rrMilestones: g.rrMilestones ?? null,
      // v12.6: peak RR pos (best ever) en peak RR neg (worst adverse ever, als % SL)
      peakRRPos: g.peakRRPos ?? calcMaxRR(g.direction, g.entry, liveSL, bestMaxPrice) ?? 0,
      peakRRNeg: g.peakRRNeg ?? g.maxSlPctUsed ?? 0,
    };
  });
  res.json({ count: ghosts.length, ghosts });
});

// ── POST /admin/ghosts/cancel-all ─────────────────────────────────
// Annuleert alle actieve ghost trackers zonder ze op te slaan in de DB.
// Gebruik dit na manueel sluiten van alle trades voor een schone herstart.
// Vereist: ?secret=WEBHOOK_SECRET (zelfde als webhook secret).
app.post("/admin/ghosts/cancel-all", (req, res) => {
  const { secret } = req.query;
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized — geef ?secret= mee" });
  }
  const ids      = Object.keys(ghostTrackers);
  const count    = ids.length;
  if (count === 0) {
    return res.json({ status: "OK", cancelled: 0, message: "Geen actieve ghosts." });
  }
  for (const id of ids) {
    cancelGhost(id);
  }
  console.log(`[Admin] /admin/ghosts/cancel-all: ${count} ghost(s) geannuleerd`);
  logEvent({ type: "ADMIN_GHOSTS_CANCELLED", count, ids });
  res.json({ status: "OK", cancelled: count, ids, message: `${count} ghost(s) geannuleerd (niet opgeslagen in DB).` });
});

// ── PRE-DEPLOY: finalize all active ghosts with reason "manual_deploy" ──
// This saves their maxRR data to DB before a restart wipes memory.
// Use via the dashboard PREPARE DEPLOY button or directly with curl.
app.post("/admin/finalize-all-ghosts", async (req, res) => {
  const { secret } = req.query;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  const ids = Object.keys(ghostTrackers);
  if (!ids.length) return res.json({ status: "OK", finalized: 0, message: "No active ghosts." });
  const results = [];
  for (const id of ids) {
    const g = ghostTrackers[id];
    if (!g) continue;
    const elapsed = Date.now() - new Date(g.openedAt ?? g.startTs ?? 0).getTime();
    try {
      await finalizeGhost(id, "manual_deploy", elapsed, g.maxPrice ?? g.entry);
      results.push({ id, symbol: g.symbol, maxRR: g.maxRR ?? 0, status: "finalized" });
    } catch (e) {
      results.push({ id, symbol: g.symbol, status: "error", error: e.message });
    }
  }
  console.log(`[Admin] finalize-all-ghosts: ${results.length} ghost(s) finalized for deploy`);
  logEvent({ type: "ADMIN_GHOSTS_FINALIZED_DEPLOY", count: results.length });
  res.json({ status: "OK", finalized: results.length, results });
});

// ── PRE-DEPLOY: close all open MT5 positions ──────────────────────────
app.post("/admin/close-all-positions", async (req, res) => {
  const { secret } = req.query;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
  const positions = Object.values(openPositions);
  if (!positions.length) return res.json({ status: "OK", closed: 0, message: "No open positions." });
  const results = [];
  for (const pos of positions) {
    try {
      await metaFetch(`/positions/${pos.positionId}`, { method: "DELETE" }, 8000);
      results.push({ positionId: pos.positionId, symbol: pos.symbol, status: "closed" });
      console.log(`[Admin] Closed position ${pos.positionId} (${pos.symbol})`);
    } catch (e) {
      results.push({ positionId: pos.positionId, symbol: pos.symbol, status: "error", error: e.message });
    }
  }
  logEvent({ type: "ADMIN_POSITIONS_CLOSED_DEPLOY", count: results.filter(r => r.status === "closed").length });
  res.json({ status: "OK", closed: results.filter(r => r.status === "closed").length, results });
});

// ── GET /admin/deploy-status — check if safe to deploy ───────────────
app.get("/admin/deploy-status", (req, res) => {
  const openCount  = Object.keys(openPositions).length;
  const ghostCount = Object.keys(ghostTrackers).length;
  const { day, hhmm } = getBrusselsComponents();
  const outsideWindow = day === 0 || day === 6 || hhmm < 200 || hhmm >= 2100;
  res.json({
    safeToDeployNow: openCount === 0 && ghostCount === 0,
    outsideMarketWindow: outsideWindow,
    openPositions: openCount,
    activeGhosts: ghostCount,
    recommendation: openCount === 0 && ghostCount === 0
      ? "✓ Safe to deploy — no open positions or active ghosts"
      : openCount > 0
        ? `⚠ Close ${openCount} open position(s) first, then finalize ${ghostCount} ghost(s)`
        : `⚠ Finalize ${ghostCount} active ghost(s) before deploy`,
  });
});

app.get("/ghosts/history", async (req, res) => {
  const { key, limit = 100 } = req.query;
  const rows = await loadGhostTrades(key || null, parseInt(limit));
  res.json({ count: rows.length, rows });
});

// GET /ghosts/combo-analysis — gecombineerde analyse per optimizer_key
// Bevat best_sl_pct, best_tp_rr, win_rate, ev_score, peak RR data
// Wordt herberekend bij elke ghost finalize.
app.get("/ghosts/combo-analysis", async (req, res) => {
  try {
    const { key } = req.query;
    const rows = await loadGhostComboAnalysis(key || null);
    res.json({ count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// EV cache — rebuilt after each ghost finalizes and on demand
// Prevents the dashboard from timing out on 500+ serial DB queries
const evCache = { data: [], lastBuilt: 0, building: false };
const EV_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min stale-while-revalidate

async function rebuildEVCache() {
  if (evCache.building) return;
  evCache.building = true;
  try {
    const { SYMBOL_CATALOG } = require("./session");
    const sessions = { stock: ["ny"], forex: ["asia","london","ny"], index: ["asia","london","ny"], commodity: ["asia","london","ny"] };
    const allKeys = new Set([...Object.keys(tpLocks)]);
    for (const [sym, info] of Object.entries(SYMBOL_CATALOG)) {
      for (const sess of (sessions[info.type] ?? ["london"])) {
        for (const dir of ["buy","sell"]) {
          for (const vwap of ["above","below"]) {
            allKeys.add(`${sym}_${sess}_${dir}_${vwap}`);
          }
        }
      }
    }
    closedTrades.forEach(t => {
      const k = buildOptimizerKey(t.symbol, t.session, t.direction, t.vwapPosition ?? "unknown");
      allKeys.add(k);
    });

    // Fix 12: Haal ook alle optimizer_keys op uit ghost_trades DB — onafhankelijk van
    // closedTrades in-memory array. Als closedTrades boven MAX_CLOSED_TRADES gaat worden
    // oude trades verwijderd maar hun ghost data is nog in de DB aanwezig.
    try {
      const { pool } = require("./db");
      const r = await pool.query(`SELECT DISTINCT optimizer_key FROM ghost_trades WHERE optimizer_key IS NOT NULL AND optimizer_key != ''`);
      r.rows.forEach(row => allKeys.add(row.optimizer_key));
    } catch (e) {
      console.warn("[EV Cache] ghost_trades key scan failed:", e.message);
    }

    const keyArr = [...allKeys];
    const results = [];
    // Process in chunks of 20 concurrent DB queries — avoids pool exhaustion
    const CHUNK = 20;
    for (let i = 0; i < keyArr.length; i += CHUNK) {
      const chunk = keyArr.slice(i, i + CHUNK);
      const evs   = await Promise.all(chunk.map(k => computeEVStats(k).catch(() => null)));
      for (let j = 0; j < chunk.length; j++) {
        const ev = evs[j];
        results.push(ev && ev.count > 0
          ? { key: chunk[j], ...ev }
          : { key: chunk[j], count: 0, bestRR: null, bestEV: null, avgRR: null, avgTimeToSLMin: null, avgMaxSlPct: null, bestWinnerSlPct: null });
      }
    }
    results.sort((a, b) => (b.bestEV ?? -99) - (a.bestEV ?? -99));
    evCache.data      = results;
    evCache.lastBuilt = Date.now();
    console.log(`[EV Cache] rebuilt: ${results.filter(r => r.count > 0).length} combos with data / ${results.length} total`);
  } catch (e) {
    console.warn("[EV Cache] rebuild failed:", e.message);
  } finally {
    evCache.building = false;
  }
}

app.get("/ev/:key", async (req, res) => {
  const ev = await computeEVStats(decodeURIComponent(req.params.key));
  res.json(ev);
});

app.get("/ev", (req, res) => {
  // ALTIJD onmiddellijk antwoorden — nooit wachten op cache rebuild.
  // Als cache leeg is: stuur lege array + header zodat dashboard weet dat het bezig is.
  const age = Date.now() - evCache.lastBuilt;
  if (!evCache.building && (age > EV_CACHE_TTL_MS || evCache.data.length === 0)) {
    rebuildEVCache().catch(() => {});  // altijd fire-and-forget
  }
  res.setHeader("X-Cache-Status", evCache.data.length === 0 ? "building" : "ready");
  res.setHeader("X-Cache-Age-Ms", String(age));
  res.json(evCache.data);  // [] als nog leeg — dashboard herlaadt na 5s
});

// GET /ev/status — dashboard pollt dit om te weten wanneer cache klaar is
app.get("/ev/status", (req, res) => {
  res.json({
    ready:      evCache.data.length > 0,
    building:   evCache.building,
    count:      evCache.data.length,
    withData:   evCache.data.filter(r => r.count > 0).length,
    lastBuiltMs: evCache.lastBuilt,
    ageMs:      Date.now() - evCache.lastBuilt,
  });
});

app.get("/shadow", (req, res) => {
  const results = Object.values(shadowResults).sort((a, b) => a.optimizerKey.localeCompare(b.optimizerKey));
  res.json({ count: results.length, results });
});

// GET /shadow/sl-warning
// Returns open positions that have hit 50%, 75%, or 90%+ of their SL distance.
// For each, compares to the SL distribution from ghost data for that combo:
// if the current SL% used exceeds p75 of historical MAE for winners on that combo,
// it means the trade is behaving like a loser — early close consideration flag.
app.get("/shadow/sl-warning", async (req, res) => {
  const warnings = [];
  for (const pos of Object.values(openPositions)) {
    if (!pos.sl || !pos.entry || !pos.currentPrice) continue;
    const slDist  = Math.abs(pos.entry - pos.sl);
    if (!slDist) continue;
    const adverse = pos.direction === "buy"
      ? pos.entry - pos.currentPrice
      : pos.currentPrice - pos.entry;
    const slPctNow = Math.max(0, Math.min(100, (adverse / slDist) * 100));

    // Thresholds: 50% / 75% / 90% of SL used
    const tier = slPctNow >= 90 ? 3 : slPctNow >= 75 ? 2 : slPctNow >= 50 ? 1 : 0;
    if (tier === 0) continue;

    // Compare to ghost data for this combo
    const sr = shadowResults[pos.optimizerKey];
    let historicalContext = null;
    if (sr?.ready && sr.p75 != null) {
      // If current SL% used > p75 of ALL ghosts → most ghosts didn't go this deep
      const beyondP75 = slPctNow > sr.p75;
      const beyondP90 = slPctNow > sr.p90;
      historicalContext = {
        p50: sr.p50, p75: sr.p75, p90: sr.p90, maxUsed: sr.maxUsed,
        beyondP75, beyondP90,
        signal: beyondP90
          ? "STRONG: deeper than 90% of historical moves — consider closing"
          : beyondP75
            ? "MODERATE: deeper than 75% of historical moves — watch closely"
            : "NORMAL: within typical range",
      };
    }

    warnings.push({
      positionId:  pos.positionId,
      symbol:      pos.symbol,
      direction:   pos.direction,
      session:     pos.session,
      vwapPosition: pos.vwapPosition,
      optimizerKey: pos.optimizerKey,
      entry:       pos.entry,
      sl:          pos.sl,
      currentPrice: pos.currentPrice,
      slPctUsed:   parseFloat(slPctNow.toFixed(1)),
      tier,         // 1=50%+ 2=75%+ 3=90%+
      tierLabel:   tier === 3 ? "90%+ — DANGER" : tier === 2 ? "75%+" : "50%+",
      currentPnL:  pos.currentPnL ?? 0,
      historicalContext,
    });
  }
  warnings.sort((a, b) => b.slPctUsed - a.slPctUsed);
  res.json({ count: warnings.length, warnings });
});

app.get("/shadow/winners", async (req, res) => {
  const data = await loadShadowWinners();
  const rows = Object.entries(data).map(([key, v]) => ({ optimizerKey: key, ...v }));
  rows.sort((a, b) => a.optimizerKey.localeCompare(b.optimizerKey));
  res.json({ count: rows.length, winners: rows });
});

app.get("/shadow/:key", async (req, res) => {
  const key   = decodeURIComponent(req.params.key);
  const local = shadowResults[key];
  if (local) return res.json(local);
  const rows = await loadShadowAnalysis(key);
  res.json(rows[0] ?? { error: "No data yet for this key" });
});

app.get("/tp-locks", (req, res) => {
  const entries = Object.entries(tpLocks).map(([key, v]) => ({ key, ...v }));
  entries.sort((a, b) => (b.evAtLock ?? 0) - (a.evAtLock ?? 0));
  res.json(entries);
});

app.get("/risk-config", async (req, res) => {
  const balance = await getLiveBalance();
  const config = Object.keys(SYMBOL_CATALOG).map(sym => ({
    symbol:  sym, type: SYMBOL_CATALOG[sym].type,
    riskPct: getSymbolRiskPct(sym),
    riskEUR: parseFloat((getSymbolRiskPct(sym) * balance).toFixed(2)),
    evMult:  getKeyEvMult(sym), dayMult: getKeyDayMult(sym),
    envVar:  `RISK_${sym}`, lotOverride: null,
  }));
  res.json({ balance, fixedRiskPct: FIXED_RISK_PCT, config });
});

// FIX 15: return full MAX_HISTORY (200), not just 100
app.get("/history", (req, res) => { res.json(webhookLog); });

// FIX 17: default limit 5000
app.get("/trades", (req, res) => {
  const { symbol, session, direction, vwap_pos, limit = 5000 } = req.query;
  let filtered = closedTrades;
  if (symbol)    filtered = filtered.filter(t => t.symbol === symbol);
  if (session)   filtered = filtered.filter(t => t.session === session);
  if (direction) filtered = filtered.filter(t => t.direction === direction);
  if (vwap_pos)  filtered = filtered.filter(t => t.vwapPosition === vwap_pos);
  res.json({ count: filtered.length, trades: filtered.slice(0, parseInt(limit)) });
});

// /lot-overrides endpoint verwijderd in v12.0 — lot overrides niet meer in gebruik

app.get("/risk-multipliers", (req, res) => {
  const entries = Object.entries(keyRiskMult).map(([key, v]) => ({ key, ...v }));
  entries.sort((a, b) => (b.evMult ?? 1) - (a.evMult ?? 1));
  res.json({ fixedRiskPct: FIXED_RISK_PCT, multipliers: entries });
});

app.get("/signal-stats", async (req, res) => {
  const stats = await loadSignalStats();
  if (!stats) return res.status(500).json({ error: "Could not compute signal stats" });
  res.json(stats);
});

// GET /signal-stats/rejects — breakdown van NIET-genomen trades
// Toont per outcome (DUPLICATE_BLOCKED, OUTSIDE_WINDOW, VWAP_BAND_EXHAUSTED, ...)
// welke symbolen + richting + reden het meest voorkomen.
// Gebruik: dashboard reject tabel, post-sessie analyse.
app.get("/signal-stats/rejects", async (req, res) => {
  try {
    const since = req.query.since ?? null; // optioneel: ISO date string
    const rows  = await loadSignalRejects({ since });
    // Bouw ook een flat top-pairs lijst voor snelle tabel weergave
    const allPairs = rows.flatMap(r => r.pairs.map(p => ({ ...p, outcome: r.outcome })));
    allPairs.sort((a, b) => b.count - a.count);
    res.json({
      byOutcome: rows,
      topPairs:  allPairs.slice(0, 100),
      total:     allPairs.reduce((s, p) => s + p.count, 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /stats — dashboard KPI totals
app.get("/stats", (req, res) => {
  res.json({
    totalClosedTrades: closedTrades.length,
    totalOpenPositions: Object.keys(openPositions).length,
    totalActiveGhosts: Object.keys(ghostTrackers).length,
  });
});

// ── Spread statistieken (v10.7 Fix 3) ────────────────────────────
// GET /spread-stats?symbol=EURUSD&session=london&hourMin=8&hourMax=16&dayOfWeek=1
app.get("/spread-stats", async (req, res) => {
  const { symbol, session, hourMin, hourMax, dayOfWeek } = req.query;
  const stats = await loadSpreadStats({
    symbol:    symbol    || undefined,
    session:   session   || undefined,
    hourMin:   hourMin   != null ? parseInt(hourMin)   : undefined,
    hourMax:   hourMax   != null ? parseInt(hourMax)   : undefined,
    dayOfWeek: dayOfWeek != null ? parseInt(dayOfWeek) : undefined,
  });
  res.json({ count: stats.length, stats });
});

// GET /spread-log?symbol=EURUSD&session=london&limit=200
app.get("/spread-log", async (req, res) => {
  const { symbol, session, limit = 200 } = req.query;
  const rows = await loadSpreadLog({ symbol, session, limit: parseInt(limit) });
  res.json({ count: rows.length, rows });
});

// GET /vwap-band-signals?minPct=150&maxPct=250&limit=200
// Returns rejected signals from signal_log where vwap_band_pct is in [minPct, maxPct].
// Used by the dashboard VWAP Band Ghost tab to evaluate whether widening the band makes sense.
app.get("/vwap-band-signals", async (req, res) => {
  const minPct  = parseFloat(req.query.minPct  ?? 1.5);  // ratio (not %)
  const maxPct  = parseFloat(req.query.maxPct  ?? 2.5);
  const limit   = parseInt(req.query.limit    ?? 300);
  try {
    const r = await pool.query(`
      SELECT symbol, direction, session, vwap_position, optimizer_key,
             tv_entry, sl_pct_human, vwap_band_pct, outcome, reject_reason, received_at
      FROM signal_log
      WHERE vwap_band_pct >= $1 AND vwap_band_pct < $2
        AND outcome IN ('REJECTED','VWAP_BAND_EXHAUSTED')
      ORDER BY received_at DESC
      LIMIT $3
    `, [minPct, maxPct, limit]);
    res.json({ count: r.rows.length, rows: r.rows, minPct, maxPct });
  } catch (e) {
    res.json({ count: 0, rows: [], error: e.message });
  }
});

// GET /vwap-band-signals — raw rejected signals for dashboard band tabs
// GET /band-ghosts?tier=150_250&limit=200 — finalized band ghost trades
app.get("/band-ghosts", async (req, res) => {
  const { tier, symbol, limit = 200 } = req.query;
  const rows = await loadBandGhosts({ bandTier: tier, symbol, limit: parseInt(limit) });
  res.json({ count: rows.length, rows });
});

// GET /band-ghost-stats?tier=150_250 — aggregated stats per combo for EV preview
app.get("/band-ghost-stats", async (req, res) => {
  const { tier = "150_250" } = req.query;
  const rows = await loadBandGhostStats(tier);
  res.json({ count: rows.length, tier, rows });
});

// GET /band-ghosts/active — currently running band ghost count
app.get("/band-ghosts/active", (req, res) => {
  const active = Object.values(bandGhostTrackers).map(g => ({
    id: g.id, symbol: g.symbol, bandTier: g.bandTier,
    bandPct: g.bandPct ? parseFloat((g.bandPct * 100).toFixed(0)) : null,
    maxRR: g.maxRR ?? 0, elapsedMin: Math.round((Date.now() - g.startTs) / 60000),
  }));
  res.json({ count: active.length, active });
});

// ── GET /performance — investeerder KPI samenvatting (v12.5) ──────
// Win rate, profit factor, expectancy, max drawdown, P&L curve.
// Alle berekeningen post-compliance datum, enkel tp/sl closes.
app.get("/performance", async (req, res) => {
  try {
    const summary = await loadPerformanceSummary();
    if (!summary) return res.status(500).json({ error: "Could not compute performance summary" });
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /mae-stats — MAE percentiles per optimizer_key (v12.5) ───
// Max Adverse Excursion analyse voor SL inkortings beslissingen.
// Retourneert p50/p75/p90 MAE + kleur-aanbeveling per combo.
app.get("/mae-stats", async (req, res) => {
  try {
    const rows = await loadMAEStats();
    res.json({ count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /ghosts/grouped — ghost history per optimizer_key (v12.5) ─
// Gegroepeerde ghost info per combo voor de "grouped" tab in ghost tracker.
// Toont gemiddeld TP RR, avg SL%, avg max RR per combo.
app.get("/ghosts/grouped", async (req, res) => {
  try {
    const rows = await loadGhostGrouped();
    res.json({ count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/daily-breakdown (v12.6) ─────────────────────────────
app.get('/api/daily-breakdown', async (req, res) => {
  try {
    const data = await loadDailyBreakdown();
    res.json(data ?? { days: [], maxWinStreak: 0, maxLossStreak: 0, maxDrawdownDay: 0, bestTrades: [], worstTrades: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/ghost-history-by-pair (v12.6) ────────────────────────
app.get('/api/ghost-history-by-pair', async (req, res) => {
  try {
    const since = req.query.since ?? currentComplianceDate;
    const data  = await loadGhostHistoryByPair(since);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/blocked-raw (v12.6) ─────────────────────────────────
// Ruwe geblokkeerde signalen gegroepeerd per symbol+direction+vwap+session+reason
app.get('/api/blocked-raw', async (req, res) => {
  try {
    const data = await loadBlockedRaw(currentComplianceDate);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/ev-sl-optimizer (v12.6) ─────────────────────────────
// EV SL optimizer data: MAE stats + shadow + combo analyse
app.get('/api/ev-sl-optimizer', async (req, res) => {
  try {
    const [mae, shadow, combo] = await Promise.all([
      loadMAEStats(currentComplianceDate),
      loadAllShadowAnalysis(),
      loadGhostComboAnalysis(),
    ]);
    const maeMap    = Object.fromEntries((mae || []).map(m => [m.optimizerKey, m]));
    const shadowMap = Object.fromEntries((shadow || []).map(s => [s.optimizerKey, s]));
    const merged = (combo || []).map(c => ({
      ...c,
      mae:    maeMap[c.optimizerKey]    ?? null,
      shadow: shadowMap[c.optimizerKey] ?? null,
    }));
    merged.sort((a, b) => (b.sampleCount ?? 0) - (a.sampleCount ?? 0));
    res.json(merged);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TEST endpoint — gebruik dit om Railway connectie te verifiëren ──
// GET  /test           → bevestigt dat Railway draait
// POST /test           → echo's de body terug zodat je TV webhook kunt testen
// Gebruik: curl -X POST https://JOUW-URL/test -H "Content-Type: application/json" -d '{"hello":"world"}'
// Of in TV webhook URL: https://JOUW-URL/test (geen secret nodig)
app.get("/test", (req, res) => {
  res.json({
    status: "Railway is bereikbaar",
    version: "12.6.0",
    time: new Date().toISOString(),
    headers: {
      "content-type": req.headers["content-type"] ?? "(geen)",
      "user-agent":   (req.headers["user-agent"] ?? "(geen)").slice(0, 80),
    },
  });
});

app.post("/test", (req, res) => {
  const ts = new Date().toISOString();
  console.log(`[TEST POST][${ts}] Content-Type: ${req.headers["content-type"] ?? "(geen)"}`);
  console.log(`[TEST POST] Body type: ${typeof req.body}`);
  console.log(`[TEST POST] Body: ${JSON.stringify(req.body)?.slice(0, 500)}`);
  res.json({
    status: "POST ontvangen",
    time: ts,
    contentType: req.headers["content-type"] ?? "(geen)",
    bodyType: typeof req.body,
    bodyReceived: req.body,
    note: "Als bodyReceived leeg/null is → Content-Type probleem. Als bodyReceived gevuld is → webhook URL of secret probleem.",
  });
});

app.get("/health", async (req, res) => {
  const balance = await getLiveBalance();
  const tradeWindowForex = canOpenNewTrade("EURUSD");
  const tradeWindowStock = canOpenNewTrade("AAPL");
  res.json({
    status: "ok", version: "12.6.0", time: getBrusselsDateStr(),
    openPos: Object.keys(openPositions).length, ghosts: Object.keys(ghostTrackers).length,
    tpLocks: Object.keys(tpLocks).length, closedT: closedTrades.length, balance,
    fixedRiskPct: FIXED_RISK_PCT, marketOpen: isMarketOpen(), session: getSession(),
    tradeWindowForex: tradeWindowForex.allowed, tradeWindowStocks: tradeWindowStock.allowed,
    lotOverrides: 0, evKeyMults: Object.keys(keyRiskMult).length,
    multMinSample: MULT_MIN_SAMPLE, slBufferMult: SL_BUFFER_MULT,
    stockSlBufferMult: STOCK_SL_BUFFER_MULT,
    nyDeadZone: "1530-1800 Brussels (forex/commodity/stock geblokkeerd)",
    complianceDate: currentComplianceDate,
  });
});

// ── Dashboard — PRONTO·AI v12.5 Professional ─────────────────────
app.get(["/", "/dashboard"], async (req, res) => {
  const balance = await getLiveBalance();
  res.setHeader("Content-Type", "text/html");

  const FOREX_SYMBOLS     = ["AUDCAD","AUDCHF","AUDNZD","AUDUSD","CADCHF","EURAUD","EURCHF","EURUSD","GBPAUD","GBPNZD","GBPUSD","NZDCAD","NZDCHF","NZDUSD","USDCAD","USDCHF"];
  const INDEX_SYMBOLS     = ["DE30EUR","NAS100USD","UK100GBP","US30USD"];
  const COMMODITY_SYMBOLS = ["XAUUSD"];
  const STOCK_SYMBOLS     = ["AAPL","AMD","AMZN","ARM","ASML","AVGO","AZN","BA","BABA","BAC","BRKB","CSCO","CVX","DIS","FDX","GE","GM","GME","GOOGL","IBM","INTC","JNJ","JPM","KO","LMT","MCD","META","MSFT","MSTR","NFLX","NKE","NVDA","PFE","PLTR","QCOM","SBUX","SNOW","T","TSLA","V","WMT","XOM","ZM"];

  let dbTradeCount = 0;
  try { const r = await pool.query("SELECT COUNT(*) AS cnt FROM closed_trades"); dbTradeCount = parseInt(r.rows[0]?.cnt ?? 0, 10); } catch(e) {}

  // RR milestones: adverse -0.1 to -1.0 per 0.1, favorable 0.1 to 15
  const ADV_STEPS = [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0];
  const FAV_STEPS = [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0,1.2,1.4,1.5,1.6,1.8,2.0,2.5,3.0,3.5,4.0,4.5,5.0,6.0,7.0,8.0,9.0,10.0,12.0,15.0];

  res.end(`<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PRONTO·AI — Algorithmic Trading Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
/* ══ DESIGN TOKENS ══════════════════════════════════════════════ */
:root {
  --bg:    #050810;
  --bg1:   #080d18;
  --bg2:   #0c1220;
  --bg3:   #111828;
  --bg4:   #151f30;
  --bdr:   #1a2540;
  --bdr2:  #1e2d4a;
  --bdr3:  #253555;

  --ink:   #d4e2f4;
  --ink2:  #7a9bc4;
  --ink3:  #3d5880;
  --ink4:  #243650;

  --g:     #00e5a0;
  --g2:    rgba(0,229,160,.1);
  --g3:    rgba(0,229,160,.04);
  --r:     #ff3356;
  --r2:    rgba(255,51,86,.1);
  --r3:    rgba(255,51,86,.04);
  --b:     #2196f3;
  --b2:    rgba(33,150,243,.12);
  --b3:    rgba(33,150,243,.05);
  --b4:    rgba(33,150,243,.25);
  --y:     #ffb800;
  --y2:    rgba(255,184,0,.1);
  --p:     #a855f7;
  --p2:    rgba(168,85,247,.1);
  --o:     #f97316;
  --o2:    rgba(249,115,22,.1);
  --c:     #06b6d4;
  --c2:    rgba(6,182,212,.1);
  --w:     rgba(255,255,255,.06);

  --radius: 8px;
  --radius-sm: 4px;

  --fn: 'Space Grotesk', sans-serif;
  --fm: 'JetBrains Mono', monospace;
  --fi: 'Inter', sans-serif;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--fn);
  font-size: 13px;
  line-height: 1.5;
  overflow-x: hidden;
  min-height: 100vh;
}
::selection { background: var(--b4); }
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--bdr3); border-radius: 2px; }

/* ══ HEADER ════════════════════════════════════════════════════ */
#hdr {
  position: sticky; top: 0; z-index: 400;
  height: 56px;
  background: rgba(5,8,16,.92);
  backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--bdr2);
  display: flex; align-items: center;
  padding: 0 20px; gap: 0;
}
.logo {
  font-family: var(--fm);
  font-size: 16px; font-weight: 700;
  letter-spacing: 3px;
  color: var(--b);
  text-shadow: 0 0 32px rgba(33,150,243,.5);
  padding-right: 20px;
  border-right: 1px solid var(--bdr2);
  margin-right: 20px;
  flex-shrink: 0;
  white-space: nowrap;
}
.logo span { color: var(--g); }
.hdr-kpis {
  display: flex; align-items: stretch;
  gap: 0; flex: 1; overflow: hidden; height: 100%;
}
.hdr-kpi {
  display: flex; flex-direction: column; justify-content: center;
  padding: 0 16px;
  border-right: 1px solid var(--bdr);
  min-width: 0; flex-shrink: 0;
}
.hk-lbl {
  font-family: var(--fi);
  font-size: 9px; font-weight: 500;
  letter-spacing: 1px; text-transform: uppercase;
  color: var(--ink3); margin-bottom: 2px;
}
.hk-val {
  font-family: var(--fm);
  font-size: 18px; font-weight: 600;
  line-height: 1; white-space: nowrap;
}
.hdr-right {
  display: flex; align-items: center;
  gap: 10px; margin-left: auto; flex-shrink: 0;
}
.live-indicator {
  display: flex; align-items: center; gap: 6px;
  font-family: var(--fi); font-size: 10px;
  color: var(--g); font-weight: 500;
}
.live-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--g);
  box-shadow: 0 0 0 0 rgba(0,229,160,.5);
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0%   { box-shadow: 0 0 0 0 rgba(0,229,160,.5); }
  70%  { box-shadow: 0 0 0 8px rgba(0,229,160,0); }
  100% { box-shadow: 0 0 0 0 rgba(0,229,160,0); }
}
.sess-badge {
  font-family: var(--fm);
  font-size: 10px; font-weight: 700;
  letter-spacing: 1px; padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid; text-transform: uppercase;
}
.sb-asia   { background: var(--c2); color: var(--c); border-color: var(--c); }
.sb-london { background: var(--g2); color: var(--g); border-color: var(--g); }
.sb-ny     { background: var(--p2); color: var(--p); border-color: var(--p); }
.sb-out    { background: var(--w);  color: var(--ink3); border-color: var(--bdr2); }
.hdr-clock {
  font-family: var(--fm);
  font-size: 20px; font-weight: 600;
  color: var(--ink); letter-spacing: 2px;
}
.hbtn {
  background: var(--w); border: 1px solid var(--bdr3);
  color: var(--ink2); padding: 6px 12px;
  font-family: var(--fn); font-size: 11px; font-weight: 500;
  cursor: pointer; border-radius: var(--radius-sm);
  transition: all .15s; white-space: nowrap;
}
.hbtn:hover { background: var(--b2); color: var(--b); border-color: var(--b); }
.hbtn.danger { border-color: var(--r); color: var(--r); }
.hbtn.danger:hover { background: var(--r2); }

/* ══ NAV ═══════════════════════════════════════════════════════ */
#nav {
  position: sticky; top: 56px; z-index: 300;
  background: var(--bg1);
  border-bottom: 1px solid var(--bdr2);
  display: flex; align-items: center;
  padding: 0 20px; overflow-x: auto;
  gap: 0;
}
#nav::-webkit-scrollbar { height: 0; }
.ntab {
  font-family: var(--fi); font-size: 12px; font-weight: 500;
  padding: 12px 16px; cursor: pointer;
  color: var(--ink3); border-bottom: 2px solid transparent;
  transition: all .15s; white-space: nowrap;
  display: flex; align-items: center; gap: 6px;
}
.ntab:hover { color: var(--ink); }
.ntab.on { color: var(--b); border-bottom-color: var(--b); }
.ntab-badge {
  display: inline-flex; align-items: center;
  background: var(--b2); color: var(--b);
  font-size: 9px; font-weight: 700;
  padding: 1px 6px; border-radius: 20px;
  font-family: var(--fm); min-width: 20px; justify-content: center;
}
.ntab-badge.err { background: var(--r2); color: var(--r); }
.ntab-badge.warn { background: var(--y2); color: var(--y); }
.npage { display: none; }
.npage.on { display: block; }
#nav-right { margin-left: auto; font-size: 10px; color: var(--ink3); white-space: nowrap; padding-left: 20px; font-family: var(--fi); }

/* ══ COMPLIANCE BAR ════════════════════════════════════════════ */
.comp-bar {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 20px;
  background: rgba(255,184,0,.03);
  border-bottom: 1px solid rgba(255,184,0,.08);
  font-size: 10px; color: var(--ink3);
  font-family: var(--fi);
}
.comp-icon { color: var(--y); font-size: 12px; }
.comp-bar strong { color: var(--y); }

/* ══ PAGE LAYOUT ════════════════════════════════════════════════ */
.page { padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; }

/* ══ CARDS ══════════════════════════════════════════════════════ */
.card {
  background: var(--bg1);
  border: 1px solid var(--bdr2);
  border-radius: var(--radius);
  overflow: hidden;
}
.card-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px;
  background: var(--bg2);
  border-bottom: 1px solid var(--bdr2);
}
.card-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600;
  letter-spacing: .5px; text-transform: uppercase;
  color: var(--ink2);
}
.card-meta { font-size: 10px; color: var(--ink3); font-family: var(--fi); }
.status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.sd-ok   { background: var(--g); box-shadow: 0 0 8px rgba(0,229,160,.5); }
.sd-err  { background: var(--r); animation: pulse-r 1.5s infinite; }
.sd-wait { background: var(--y); }
@keyframes pulse-r {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255,51,86,.5); }
  50%       { box-shadow: 0 0 0 6px rgba(255,51,86,0); }
}

/* ══ STAT STRIP ═════════════════════════════════════════════════ */
.sstrip { display: flex; border-bottom: 1px solid var(--bdr2); }
.ss {
  flex: 1; padding: 12px 16px;
  border-right: 1px solid var(--bdr);
}
.ss:last-child { border-right: none; }
.ss-lbl {
  font-family: var(--fi); font-size: 9px; font-weight: 500;
  letter-spacing: 1px; text-transform: uppercase;
  color: var(--ink3); margin-bottom: 4px;
}
.ss-val {
  font-family: var(--fm); font-size: 22px; font-weight: 600;
  line-height: 1;
}
.ss-sub { font-size: 9px; color: var(--ink3); margin-top: 3px; font-family: var(--fi); }

/* ══ OVERVIEW GRID ══════════════════════════════════════════════ */
.ov-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px; padding: 16px 20px;
}
.ov-card {
  background: var(--bg1);
  border: 1px solid var(--bdr2);
  border-radius: var(--radius);
  padding: 14px 16px;
  position: relative; overflow: hidden;
}
.ov-card::before {
  content: ''; position: absolute;
  top: 0; left: 0; right: 0; height: 2px;
  background: var(--accent, var(--b));
}
.ov-lbl {
  font-family: var(--fi); font-size: 9px; font-weight: 500;
  letter-spacing: 1px; text-transform: uppercase;
  color: var(--ink3); margin-bottom: 8px;
}
.ov-val {
  font-family: var(--fm); font-size: 32px; font-weight: 700;
  line-height: 1; color: var(--accent, var(--ink));
}
.ov-sub { font-size: 9px; color: var(--ink3); margin-top: 5px; font-family: var(--fi); }

/* ══ WINRATE TABLE ══════════════════════════════════════════════ */
.wr-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.wr-section { }
.wr-title {
  font-family: var(--fi); font-size: 10px; font-weight: 600;
  letter-spacing: .5px; text-transform: uppercase;
  color: var(--ink2); padding: 8px 12px;
  border-bottom: 1px solid var(--bdr2);
  background: var(--bg3);
}
.wr-row {
  display: grid; grid-template-columns: 140px 1fr 60px 60px;
  align-items: center; gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--bdr);
}
.wr-row:last-child { border-bottom: none; }
.wr-row:hover { background: var(--w); }
.wr-label { font-size: 11px; color: var(--ink); }
.wr-bar-wrap { height: 5px; background: var(--bdr); border-radius: 3px; overflow: hidden; }
.wr-bar-fill { height: 100%; border-radius: 3px; transition: width .4s; }
.wr-pct { font-family: var(--fm); font-size: 12px; font-weight: 600; text-align: right; }
.wr-n { font-family: var(--fm); font-size: 10px; color: var(--ink3); text-align: right; }

/* ══ FILTER BAR ═════════════════════════════════════════════════ */
.fbar {
  display: flex; flex-wrap: wrap; align-items: center;
  gap: 6px; padding: 8px 16px;
  border-bottom: 1px solid var(--bdr2);
  background: var(--bg);
}
.fl {
  font-family: var(--fi); font-size: 9px; font-weight: 600;
  color: var(--ink3); text-transform: uppercase;
  letter-spacing: .5px; margin-right: 2px;
}
.fb {
  background: transparent; border: 1px solid var(--bdr3);
  color: var(--ink3); padding: 3px 10px;
  border-radius: 20px; cursor: pointer;
  font-family: var(--fi); font-size: 10px; font-weight: 500;
  transition: all .12s; letter-spacing: .2px;
}
.fb.on, .fb:hover {
  background: var(--b2); color: var(--b);
  border-color: rgba(33,150,243,.4);
}

/* ══ TABLES ═════════════════════════════════════════════════════ */
.tw { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
thead th {
  background: var(--bg2); border-bottom: 1px solid var(--bdr2);
  padding: 6px 10px; text-align: left; white-space: nowrap;
  font-family: var(--fi); font-size: 9px; font-weight: 600;
  letter-spacing: .8px; text-transform: uppercase; color: var(--ink3);
  cursor: pointer; user-select: none; position: sticky; top: 0; z-index: 1;
}
thead th:hover { color: var(--b); }
thead th.asc::after  { content: ' ↑'; color: var(--b); }
thead th.desc::after { content: ' ↓'; color: var(--b); }
thead th.rr-th { font-size: 7px; padding: 6px 3px; color: var(--ink4); letter-spacing: 0; }
thead th.adv-th { font-size: 7px; padding: 6px 3px; color: var(--r); letter-spacing: 0; opacity: .7; }
thead th.fav-th { font-size: 7px; padding: 6px 3px; color: var(--g); letter-spacing: 0; opacity: .7; }
td {
  padding: 5px 10px; border-bottom: 1px solid var(--bdr);
  white-space: nowrap; vertical-align: middle;
  font-size: 11px;
}
tbody tr:hover { background: rgba(33,150,243,.03); }
tbody tr:last-child td { border-bottom: none; }
.nd { text-align: center; padding: 20px; color: var(--ink3); font-size: 11px; }

/* type row accents */
tr.t-fx td:first-child { border-left: 2px solid rgba(6,182,212,.6); }
tr.t-ix td:first-child { border-left: 2px solid rgba(255,184,0,.6); }
tr.t-cm td:first-child { border-left: 2px solid rgba(249,115,22,.6); }
tr.t-sk td:first-child { border-left: 2px solid rgba(33,150,243,.6); }

/* ══ BADGES ═════════════════════════════════════════════════════ */
.bd {
  display: inline-flex; align-items: center;
  padding: 2px 7px; border-radius: 4px;
  font-family: var(--fi); font-size: 9px; font-weight: 700;
  letter-spacing: .5px; text-transform: uppercase; white-space: nowrap;
}
.b-buy    { background: var(--g2); color: var(--g); }
.b-sell   { background: var(--r2); color: var(--r); }
.b-ab     { background: var(--b2); color: var(--b); }
.b-bw     { background: var(--p2); color: var(--p); }
.b-asia   { background: var(--c2); color: var(--c); }
.b-lon    { background: var(--g2); color: var(--g); }
.b-ny     { background: var(--p2); color: var(--p); }
.b-out    { background: var(--w);  color: var(--ink3); }
.b-tp     { background: var(--g2); color: var(--g); }
.b-sl     { background: var(--r2); color: var(--r); }
.b-ev     { background: rgba(0,229,160,.15); color: var(--g); border: 1px solid rgba(0,229,160,.3); }
.b-lk     { background: var(--y2); color: var(--y); border: 1px solid rgba(255,184,0,.3); }
.b-fx     { background: var(--c2); color: var(--c); }
.b-ix     { background: var(--y2); color: var(--y); }
.b-cm     { background: var(--o2); color: var(--o); }
.b-sk     { background: var(--b2); color: var(--b); }
.b-ghost  { background: var(--p2); color: var(--p); }
.b-block  { background: var(--r2); color: var(--r); }

/* ══ COLORS ═════════════════════════════════════════════════════ */
.cg { color: var(--g); }
.cr { color: var(--r); }
.cb { color: var(--b); }
.cy { color: var(--y); }
.cp { color: var(--p); }
.cc { color: var(--c); }
.co { color: var(--o); }
.cd { color: var(--ink3); }
.fw { font-weight: 700; }
.fm { font-family: var(--fm) !important; }

/* ══ SL PROGRESS BAR ════════════════════════════════════════════ */
.slbar { display: flex; align-items: center; gap: 5px; min-width: 90px; }
.slbg { height: 4px; flex: 1; background: var(--bdr); border-radius: 2px; overflow: hidden; }
.slfi { height: 100%; border-radius: 2px; background: var(--g); transition: width .3s; }
.slfi.y { background: var(--y); }
.slfi.r { background: var(--r); }
.sl-pct { font-family: var(--fm); font-size: 9px; color: var(--ink3); }

/* ══ RR MILESTONE CELLS ═════════════════════════════════════════ */
td.rr-hit    { background: rgba(0,229,160,.06); color: var(--g); font-weight: 600; }
td.rr-fast   { background: rgba(0,229,160,.03); color: var(--g); }
td.rr-mid    { color: var(--y); }
td.rr-slow   { color: var(--ink3); }
td.adv-hit   { background: rgba(255,51,86,.05); color: var(--r); font-weight: 600; }
td.adv-near  { color: var(--o); }
td.adv-ok    { color: var(--ink3); }

/* ══ WINRATE GAUGE ══════════════════════════════════════════════ */
.wr-gauge {
  display: inline-flex; align-items: center; gap: 6px;
}
.wr-gauge-fill {
  height: 3px; border-radius: 2px;
  background: var(--g); transition: width .4s;
}

/* ══ INNER TABS ═════════════════════════════════════════════════ */
.itabs {
  display: flex; border-bottom: 1px solid var(--bdr2);
  background: var(--bg);
}
.itab {
  font-family: var(--fi); font-size: 11px; font-weight: 500;
  padding: 8px 14px; cursor: pointer;
  color: var(--ink3); border-bottom: 2px solid transparent;
  transition: all .12s; white-space: nowrap;
}
.itab:hover { color: var(--ink); }
.itab.on { color: var(--b); border-bottom-color: var(--b); }
.ipane { display: none; }
.ipane.on { display: block; }

/* ══ EV MATRIX ══════════════════════════════════════════════════ */
table.mx th { font-size: 8px; padding: 5px 8px; background: var(--bg3); }
table.mx td { padding: 4px 8px; text-align: center; font-family: var(--fm); font-size: 10px; }
td.mx-sym { text-align: left !important; font-weight: 600; color: var(--y); font-family: var(--fn) !important; position: sticky; left: 0; background: var(--bg1); z-index: 1; }

/* ══ SIGNAL DETAIL ══════════════════════════════════════════════ */
.sig-stat-grid {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 0; border-bottom: 1px solid var(--bdr2);
}
.sig-stat {
  padding: 10px 14px; border-right: 1px solid var(--bdr);
}
.sig-stat:last-child { border-right: none; }
.sig-stat-lbl { font-size: 9px; color: var(--ink3); font-family: var(--fi); font-weight: 500; letter-spacing: .5px; text-transform: uppercase; margin-bottom: 3px; }
.sig-stat-val { font-family: var(--fm); font-size: 18px; font-weight: 600; }

/* ══ TRADE DISTRIBUTION TABLE ══════════════════════════════════ */
.dist-table { font-size: 11px; }
.dist-table td, .dist-table th { padding: 5px 10px; }

/* ══ GHOST PEAK CELL ════════════════════════════════════════════ */
.peak-pos { color: var(--g); font-weight: 600; }
.peak-neg { color: var(--r); font-weight: 600; }

/* ══ EV OPTIMIZER CELLS ═════════════════════════════════════════ */
.ev-pos { color: var(--g); font-weight: 700; }
.ev-neg { color: var(--r); font-weight: 700; }
.ev-neu { color: var(--ink3); }

/* ══ RESPONSIVE ════════════════════════════════════════════════ */
@media (max-width: 1200px) { .ov-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 800px)  { .ov-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>

<!-- ══ HEADER ═══════════════════════════════════════════════════ -->
<header id="hdr">
  <div class="logo">PRONTO<span>·</span>AI</div>
  <div class="hdr-kpis">
    <div class="hdr-kpi">
      <div class="hk-lbl">MT5 Balance</div>
      <div class="hk-val cb">€<span id="k-bal">${balance.toFixed(0)}</span></div>
    </div>
    <div class="hdr-kpi">
      <div class="hk-lbl">Open Trades</div>
      <div class="hk-val cg" id="k-pos">—</div>
    </div>
    <div class="hdr-kpi">
      <div class="hk-lbl">Live P&L</div>
      <div class="hk-val" id="k-pnl">—</div>
    </div>
    <div class="hdr-kpi">
      <div class="hk-lbl">Ghosts</div>
      <div class="hk-val cp" id="k-gh">—</div>
    </div>
    <div class="hdr-kpi">
      <div class="hk-lbl">Risk/Trade</div>
      <div class="hk-val cc">${(FIXED_RISK_PCT*100).toFixed(4)}%</div>
    </div>
    <div class="hdr-kpi">
      <div class="hk-lbl">Win Rate</div>
      <div class="hk-val cy" id="k-wr">—</div>
    </div>
    <div class="hdr-kpi">
      <div class="hk-lbl">TP Locked</div>
      <div class="hk-val cy" id="k-tp">—</div>
    </div>
    <div class="hdr-kpi">
      <div class="hk-lbl">Total Trades DB</div>
      <div class="hk-val cb">${dbTradeCount.toLocaleString()}</div>
    </div>
  </div>
  <div class="hdr-right">
    <div class="live-indicator">
      <div class="live-dot"></div>
      <span>LIVE</span>
    </div>
    <span class="sess-badge sb-out" id="hdr-sess">—</span>
    <span class="hdr-clock" id="clock">--:--:--</span>
    <button class="hbtn" onclick="loadAll()">↻ Refresh</button>
    <button class="hbtn danger" id="dbtn" onclick="prepareDeploy()">⚡ Deploy</button>
  </div>
</header>

<!-- ══ NAV ══════════════════════════════════════════════════════ -->
<nav id="nav">
  <div class="ntab on" onclick="showPage('overview')">
    Overview
  </div>
  <div class="ntab" onclick="showPage('positions')">
    Open Positions
    <span class="ntab-badge" id="nb-pos">—</span>
  </div>
  <div class="ntab" onclick="showPage('ghosts')">
    Ghost Tracker
    <span class="ntab-badge" id="nb-gh">—</span>
  </div>
  <div class="ntab" onclick="showPage('history')">
    Ghost History
  </div>
  <div class="ntab" onclick="showPage('ev')">
    EV TP Optimizer
  </div>
  <div class="ntab" onclick="showPage('ev-sl')">
    EV SL Optimizer
  </div>
  <div class="ntab" onclick="showPage('signals')">
    Signals
    <span class="ntab-badge err" id="nb-sig">—</span>
  </div>
  <div class="ntab" onclick="showPage('blocked-raw')">
    Blocked Raw
  </div>
  <div id="nav-right" id="nav-status">—</div>
</nav>

<!-- ══ COMPLIANCE BAR ════════════════════════════════════════════ -->
<div class="comp-bar">
  <span class="comp-icon">📅</span>
  <strong>Compliance: 3 mei 2026 00:00 UTC</strong>
  <span>— all EV, statistics &amp; P&amp;L calculated only on trades after this date</span>
  <span style="margin-left: auto; font-family: var(--fm); color: var(--c); font-size: 10px;">${dbTradeCount.toLocaleString()} trades in DB</span>
</div>

<!-- ══════════════════════════════════════════════════════════════
     PAGE: OVERVIEW — INVESTOR DASHBOARD
═══════════════════════════════════════════════════════════════ -->
<div class="npage on" id="page-overview">

  <!-- KPI Grid -->
  <div class="ov-grid">
    <div class="ov-card" style="--accent: var(--b)">
      <div class="ov-lbl">Balance MT5</div>
      <div class="ov-val">€<span id="ov-bal">${balance.toFixed(0)}</span></div>
      <div class="ov-sub">Live account equity</div>
    </div>
    <div class="ov-card" style="--accent: var(--g)">
      <div class="ov-lbl">Live P&L</div>
      <div class="ov-val" id="ov-pnl">—</div>
      <div class="ov-sub" id="ov-pnl-sub">—</div>
    </div>
    <div class="ov-card" style="--accent: var(--c)">
      <div class="ov-lbl">Win Rate</div>
      <div class="ov-val" id="ov-wr">—</div>
      <div class="ov-sub" id="ov-wr-sub">compliance period</div>
    </div>
    <div class="ov-card" style="--accent: var(--y)">
      <div class="ov-lbl">Profit Factor</div>
      <div class="ov-val cy" id="ov-pf">—</div>
      <div class="ov-sub">Gross win / gross loss</div>
    </div>
    <div class="ov-card" style="--accent: var(--p)">
      <div class="ov-lbl">Active Ghosts</div>
      <div class="ov-val cp" id="ov-gh">—</div>
      <div class="ov-sub" id="ov-pos-sub">phantom SL trackers</div>
    </div>
    <div class="ov-card" style="--accent: var(--o)">
      <div class="ov-lbl">Compliance Trades</div>
      <div class="ov-val" id="ov-comp">—</div>
      <div class="ov-sub">closed after 3 mei 2026</div>
    </div>
  </div>

  <div class="page" style="padding-top:0">
    <!-- Win Rate Breakdown -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-wait" id="wr-dot"></div>
          Win Rate — Trade / Session / VWAP / Direction
        </div>
        <div class="card-meta" id="wr-meta">loading...</div>
      </div>

      <div class="sstrip">
        <div class="ss">
          <div class="ss-lbl">Overall</div>
          <div class="ss-val cg" id="wr-overall">—</div>
          <div class="ss-sub" id="wr-overall-n">— trades</div>
        </div>
        <div class="ss">
          <div class="ss-lbl">Long (Buy)</div>
          <div class="ss-val cg" id="wr-buy">—</div>
          <div class="ss-sub" id="wr-buy-n">—</div>
        </div>
        <div class="ss">
          <div class="ss-lbl">Short (Sell)</div>
          <div class="ss-val cr" id="wr-sell">—</div>
          <div class="ss-sub" id="wr-sell-n">—</div>
        </div>
        <div class="ss">
          <div class="ss-lbl">VWAP Above</div>
          <div class="ss-val cb" id="wr-ab">—</div>
          <div class="ss-sub" id="wr-ab-n">—</div>
        </div>
        <div class="ss">
          <div class="ss-lbl">VWAP Below</div>
          <div class="ss-val cp" id="wr-bw">—</div>
          <div class="ss-sub" id="wr-bw-n">—</div>
        </div>
        <div class="ss">
          <div class="ss-lbl">Asia</div>
          <div class="ss-val cc" id="wr-asia">—</div>
          <div class="ss-sub" id="wr-asia-n">—</div>
        </div>
        <div class="ss">
          <div class="ss-lbl">London</div>
          <div class="ss-val cg" id="wr-lon">—</div>
          <div class="ss-sub" id="wr-lon-n">—</div>
        </div>
        <div class="ss">
          <div class="ss-lbl">New York</div>
          <div class="ss-val cp" id="wr-ny">—</div>
          <div class="ss-sub" id="wr-ny-n">—</div>
        </div>
      </div>

      <!-- Win Rate Table per combo -->
      <div class="tw">
        <table class="dist-table">
          <thead><tr>
            <th data-col="0">Session</th>
            <th data-col="1">Direction</th>
            <th data-col="2">VWAP</th>
            <th data-col="3">Wins</th>
            <th data-col="4">Losses</th>
            <th data-col="5">Total</th>
            <th data-col="6">Win Rate</th>
            <th>Win Rate Bar</th>
            <th data-col="8">Avg W (€)</th>
            <th data-col="9">Avg L (€)</th>
            <th data-col="10">EV/trade</th>
          </tr></thead>
          <tbody id="wr-body"></tbody>
        </table>
      </div>
    </div>

    <!-- Trade Distribution (open trades zichtbaar zodra geopend) -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-wait" id="dist-dot"></div>
          Trade Distribution — 3 mei 2026+
        </div>
        <div class="card-meta" id="dist-meta">loading...</div>
      </div>
      <div class="sstrip">
        <div class="ss"><div class="ss-lbl">Total Closed</div><div class="ss-val cb" id="d-tot">—</div></div>
        <div class="ss"><div class="ss-lbl">Buy</div><div class="ss-val cg" id="d-buy">—</div></div>
        <div class="ss"><div class="ss-lbl">Sell</div><div class="ss-val cr" id="d-sell">—</div></div>
        <div class="ss"><div class="ss-lbl">Above VWAP</div><div class="ss-val cb" id="d-ab">—</div></div>
        <div class="ss"><div class="ss-lbl">Below VWAP</div><div class="ss-val cp" id="d-bw">—</div></div>
        <div class="ss"><div class="ss-lbl">Asia</div><div class="ss-val cc" id="d-as">—</div></div>
        <div class="ss"><div class="ss-lbl">London</div><div class="ss-val cg" id="d-lo">—</div></div>
        <div class="ss"><div class="ss-lbl">NY</div><div class="ss-val cp" id="d-ny">—</div></div>
      </div>
      <div class="tw">
        <table class="dist-table">
          <thead><tr>
            <th>Session</th>
            <th style="color:var(--g)">Buy / Above VWAP</th>
            <th style="color:var(--g)">Buy / Below VWAP</th>
            <th style="color:var(--r)">Sell / Above VWAP</th>
            <th style="color:var(--r)">Sell / Below VWAP</th>
            <th>Total</th>
            <th>Win Rate</th>
          </tr></thead>
          <tbody id="dist-body"></tbody>
          <tfoot>
            <tr style="background:var(--bg3);font-weight:700;border-top:2px solid var(--bdr2)">
              <td class="cy fm">TOTAL</td>
              <td id="ft-ba" class="cg">—</td>
              <td id="ft-bb" class="cg">—</td>
              <td id="ft-sa" class="cr">—</td>
              <td id="ft-sb" class="cr">—</td>
              <td id="ft-t"  class="cb">—</td>
              <td id="ft-wr" class="cy">—</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <!-- ── Daily Breakdown (v12.6) ─────────────────────────────────── -->
    <div class="card" id="card-daily">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-wait" id="daily-dot"></div>
          Daily Breakdown — Per Dag Performance (compliance+)
        </div>
        <div class="card-meta" id="daily-meta">loading...</div>
      </div>
      <!-- Streak + Drawdown KPI strip -->
      <div class="sstrip" id="daily-kpi">
        <div class="ss"><div class="ss-lbl">Max Win Streak</div><div class="ss-val cg" id="d-wstrk">—</div></div>
        <div class="ss"><div class="ss-lbl">Max Loss Streak</div><div class="ss-val cr" id="d-lstrk">—</div></div>
        <div class="ss"><div class="ss-lbl">Max Drawdown (dag-gebaseerd)</div><div class="ss-val cy" id="d-dd">—</div></div>
      </div>
      <div class="tw">
        <table id="daily-tbl">
          <thead><tr>
            <th data-col="0">Datum</th>
            <th data-col="1"># Trades</th>
            <th data-col="2">Wins</th>
            <th data-col="3">Losses</th>
            <th data-col="4">Win%</th>
            <th data-col="5">Dag P&amp;L €</th>
            <th data-col="6">Cum P&amp;L €</th>
            <th data-col="7">Avg Lots</th>
            <th data-col="8">Best RR</th>
            <th data-col="9">Avg RR</th>
          </tr></thead>
          <tbody id="daily-body"></tbody>
        </table>
      </div>
      <!-- Best / Worst setups -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 14px;border-top:1px solid var(--bdr2)">
        <div>
          <div style="font-size:10px;color:var(--g);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;font-family:var(--fi)">🏆 Best 5 Setups</div>
          <table id="best-tbl" style="font-size:10px;width:100%;border-collapse:collapse">
            <thead><tr>
              <th style="text-align:left;padding:3px 4px;color:var(--ink3)">Symbol</th>
              <th>Dir</th><th>Session</th><th>VWAP</th>
              <th>RR</th><th>P&amp;L €</th>
            </tr></thead>
            <tbody id="best-body"></tbody>
          </table>
        </div>
        <div>
          <div style="font-size:10px;color:var(--r);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;font-family:var(--fi)">💀 Worst 5 Setups</div>
          <table id="worst-tbl" style="font-size:10px;width:100%;border-collapse:collapse">
            <thead><tr>
              <th style="text-align:left;padding:3px 4px;color:var(--ink3)">Symbol</th>
              <th>Dir</th><th>Session</th><th>VWAP</th>
              <th>RR</th><th>P&amp;L €</th>
            </tr></thead>
            <tbody id="worst-body"></tbody>
          </table>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════
     PAGE: OPEN POSITIONS
═══════════════════════════════════════════════════════════════ -->
<div class="npage" id="page-positions">
  <div class="page">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-err" id="pos-dot"></div>
          Open Positions — Live
        </div>
        <div class="card-meta" id="pos-meta">loading...</div>
      </div>

      <!-- Trade distribution shows also open trades -->
      <div class="sstrip" id="pos-strip" style="display:none">
        <div class="ss"><div class="ss-lbl">Open Trades</div><div class="ss-val cg" id="pos-cnt">—</div></div>
        <div class="ss"><div class="ss-lbl">Total P&L</div><div class="ss-val" id="pos-pnl">—</div></div>
        <div class="ss"><div class="ss-lbl">Ghosted</div><div class="ss-val cp" id="pos-gh">—</div></div>
        <div class="ss"><div class="ss-lbl">EV+ Trades</div><div class="ss-val cg" id="pos-ev">—</div></div>
        <div class="ss"><div class="ss-lbl">Buy / Sell</div><div class="ss-val" id="pos-bs">— / —</div></div>
        <div class="ss"><div class="ss-lbl">Above / Below</div><div class="ss-val" id="pos-ab">— / —</div></div>
      </div>

      <div class="tw">
        <table id="pos-tbl">
          <thead><tr>
            <th data-col="0">Symbol</th>
            <th>Type</th>
            <th data-col="2">Dir</th>
            <th data-col="3">VWAP</th>
            <th data-col="4">Session</th>
            <th data-col="5">Entry</th>
            <th data-col="6">SL</th>
            <th data-col="7">TP</th>
            <th data-col="8" title="Live RR based on current price">RR Now</th>
            <th data-col="9" title="Best favorable RR ever reached">Peak +RR</th>
            <th data-col="10" title="Worst adverse RR ever reached (% of SL dist)">Peak −RR</th>
            <th title="SL distance consumed now">SL Used</th>
            <th data-col="11" title="TP target RR">→TP</th>
            <th data-col="12">P&L €</th>
            <th data-col="13">Lots</th>
            <th data-col="14" title="Actual risk% at SL hit">Risk %</th>
            <!-- Adverse milestones -0.1 to -1.0 per 0.1 -->
            ${ADV_STEPS.map(v=>`<th class="adv-th" title="Time to reach -${v}R">-${v}</th>`).join('')}
            <!-- Favorable milestones +0.1 to +15 -->
            ${FAV_STEPS.map(v=>`<th class="fav-th" title="Time to reach +${v}R">+${v}</th>`).join('')}
            <th data-col="99">Opened</th>
          </tr></thead>
          <tbody id="pos-body">
            <tr><td colspan="100" class="nd">Loading open positions...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════
     PAGE: GHOST TRACKER
═══════════════════════════════════════════════════════════════ -->
<div class="npage" id="page-ghosts">
  <div class="page">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-err" id="gh-dot"></div>
          Ghost Tracker — Active (runs until phantom SL / 15R / 14 days)
        </div>
        <div class="card-meta" id="gh-meta">Phantom SL = real SL at trade open</div>
      </div>

      <div class="sstrip" id="gh-strip" style="display:none">
        <div class="ss"><div class="ss-lbl">Active Ghosts</div><div class="ss-val cp" id="gh-cnt">—</div></div>
        <div class="ss"><div class="ss-lbl">Peak +RR (best)</div><div class="ss-val cg" id="gh-bestRR">—</div></div>
        <div class="ss"><div class="ss-lbl">Peak -RR (worst)</div><div class="ss-val cr" id="gh-worstRR">—</div></div>
        <div class="ss"><div class="ss-lbl">Avg Elapsed</div><div class="ss-val cd" id="gh-elapsed">—</div></div>
      </div>

      <div class="tw">
        <table id="gh-tbl">
          <thead><tr>
            <th data-col="0">Symbol</th>
            <th>Type</th>
            <th data-col="2">Session</th>
            <th data-col="3">Dir</th>
            <th data-col="4">VWAP</th>
            <th data-col="5" title="Best favorable RR ever reached (peak positive)">Peak +RR</th>
            <th data-col="6" title="Worst adverse RR ever reached (% of SL distance, peak)">Peak −RR%</th>
            <th title="SL distance consumed right now">SL Now</th>
            <!-- Adverse -0.1 to -1.0 -->
            ${ADV_STEPS.map(v=>`<th class="adv-th" title="T to -${v}R">-${v}</th>`).join('')}
            <!-- Favorable +0.1 to +15 -->
            ${FAV_STEPS.map(v=>`<th class="fav-th" title="T to +${v}R">+${v}</th>`).join('')}
            <th data-col="98">Elapsed</th>
            <th data-col="99">Opened</th>
          </tr></thead>
          <tbody id="gh-body">
            <tr><td colspan="100" class="nd">No active ghost trackers</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════
     PAGE: GHOST HISTORY
═══════════════════════════════════════════════════════════════ -->
<div class="npage" id="page-history">
  <div class="page">

    <!-- Ghost History Grouped (v12.6: per-pair individuele lijnen + expand) -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-wait" id="ghh2-dot"></div>
          Ghost History — Grouped per Pair · Klik rij voor detail
        </div>
        <div class="card-meta" id="ghh2-meta">loading...</div>
      </div>
      <div class="fbar">
        <span class="fl">Session:</span>
        <button class="fb on" onclick="setGHHF('sess','all',this)">All</button>
        <button class="fb" onclick="setGHHF('sess','asia',this)">Asia</button>
        <button class="fb" onclick="setGHHF('sess','london',this)">London</button>
        <button class="fb" onclick="setGHHF('sess','ny',this)">NY</button>
        &nbsp;<span class="fl">Dir:</span>
        <button class="fb on" onclick="setGHHF('dir','all',this)">All</button>
        <button class="fb" onclick="setGHHF('dir','buy',this)">Buy</button>
        <button class="fb" onclick="setGHHF('dir','sell',this)">Sell</button>
      </div>
      <div class="tw">
        <table id="ghh2-tbl">
          <thead><tr>
            <th>▶</th>
            <th data-col="1">Symbol</th>
            <th data-col="2">Session</th>
            <th data-col="3">Dir</th>
            <th data-col="4">VWAP</th>
            <th data-col="5"># Ghosts</th>
            <th>SL Hits</th>
            <th>Max RR15</th>
            <th>Timeout</th>
            <th data-col="9">Avg Peak+RR</th>
            <th data-col="10">Avg Peak−RR%</th>
            <th>Max Peak+RR</th>
            <th>Best TP (last 5)</th>
            <th>Best SL% (last 5)</th>
          </tr></thead>
          <tbody id="ghh2-body"></tbody>
        </table>
      </div>
    </div>

    <!-- Ghost History — klassiek gegroepeerd (bestaand) -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-wait" id="ghh-dot"></div>
          Ghost History — Klassiek Grouped by Signal Combo
        </div>
        <div class="card-meta" id="ghh-meta">Peak RR negative &amp; positive per combo · 3 mei 2026+</div>
      </div>
      <div class="tw">
        <table id="ghh-tbl">
          <thead><tr>
            <th data-col="0">Symbol</th>
            <th>Type</th>
            <th data-col="2">Session</th>
            <th data-col="3">Dir</th>
            <th data-col="4">VWAP</th>
            <th data-col="5"># Ghosts</th>
            <th data-col="6" title="EV-eligible: SL hit, VWAP known, ≥0.5R"># EV</th>
            <th data-col="7" title="Best positive RR reached">Peak +RR</th>
            <th data-col="8" title="Best adverse RR before SL / timeout">Peak −RR</th>
            <th data-col="9">Avg RR</th>
            <th class="adv-th" title="Avg T to -¼R">T-¼R</th>
            <th class="adv-th" title="Avg T to -½R">T-½R</th>
            <th class="adv-th" title="Avg T to -¾R">T-¾R</th>
            <th class="adv-th" title="Avg T to -1R (phantom SL)">T-1R</th>
            <th class="fav-th" title="Avg T to +0.5R">+½R</th>
            <th class="fav-th" title="Avg T to +1R">+1R</th>
            <th class="fav-th" title="Avg T to +1.5R">+1.5R</th>
            <th class="fav-th" title="Avg T to +2R">+2R</th>
            <th class="fav-th" title="Avg T to +3R">+3R</th>
            <th class="fav-th" title="Avg T to +5R">+5R</th>
            <th class="fav-th" title="Avg T to +10R">+10R</th>
            <th class="fav-th" title="Avg T to +15R">+15R</th>
            <th data-col="20">Stop Reason</th>
            <th>MAE p50</th><th>MAE p75</th><th data-col="23">MAE p90</th>
            <th title="EV SL — read-only, MAE-based">EV SL</th>
            <th title="EV TP — best WR+Risk from ghost history (updates after 5 trades)">EV TP</th>
          </tr></thead>
          <tbody id="ghh-body"></tbody>
        </table>
      </div>
    </div>

    <!-- SL Optimizer (read-only) -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-wait" id="sl-dot"></div>
          EV SL Optimizer — READ ONLY · MAE-based recommendations
        </div>
        <div class="card-meta">Never auto-applied · informational · based on MAE p90 of winning ghost trades</div>
      </div>
      <div style="padding:7px 14px;background:rgba(6,182,212,.04);border-bottom:1px solid rgba(6,182,212,.1);font-size:10px;color:var(--ink3);font-family:var(--fi)">
        ℹ These recommendations show how much the SL could theoretically be tightened. Requires ≥5 completed ghost trades per combo.
      </div>
      <div class="tw">
        <table id="sl-tbl">
          <thead><tr>
            <th data-col="0">Symbol</th>
            <th>Type</th>
            <th data-col="2">Session</th>
            <th data-col="3">Dir</th>
            <th data-col="4">VWAP</th>
            <th data-col="5"># Ghosts</th>
            <th data-col="6">MAE p50</th>
            <th data-col="7">MAE p75</th>
            <th data-col="8">MAE p90</th>
            <th data-col="9">SL Advice (READ ONLY)</th>
            <th data-col="10">Potential SL Reduction</th>
          </tr></thead>
          <tbody id="sl-body"></tbody>
        </table>
      </div>
    </div>

  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════
     PAGE: EV SL OPTIMIZER (v12.6)
═══════════════════════════════════════════════════════════════ -->
<div class="npage" id="page-ev-sl">
  <div class="page">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-wait" id="evsl-dot"></div>
          EV SL Optimizer — MAE-based SL Reduction Recommendations
        </div>
        <div class="card-meta">READ ONLY · MAE p90 per combo · min 5 ghost trades vereist</div>
      </div>
      <div style="padding:7px 14px;background:rgba(6,182,212,.04);border-bottom:1px solid rgba(6,182,212,.1);font-size:10px;color:var(--ink3);font-family:var(--fi)">
        ℹ Gebaseerd op MAE (Max Adverse Excursion) van ghost trades. Hoe kleiner MAE p90 t.o.v. 100%, hoe meer de SL kan worden ingekort.
      </div>
      <div class="tw">
        <table id="evsl-tbl">
          <thead><tr>
            <th data-col="0">Symbol</th>
            <th>Type</th>
            <th data-col="2">Session</th>
            <th data-col="3">Dir</th>
            <th data-col="4">VWAP</th>
            <th data-col="5"># Ghosts</th>
            <th>MAE p50</th>
            <th>MAE p75</th>
            <th data-col="8">MAE p90</th>
            <th data-col="9">EV SL Advies (READ ONLY)</th>
            <th data-col="10">Best SL%</th>
            <th>Potentiële Reductie</th>
            <th>Shadow p50</th>
            <th>Shadow p90</th>
          </tr></thead>
          <tbody id="evsl-body"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════
     PAGE: BLOCKED RAW (v12.6)
═══════════════════════════════════════════════════════════════ -->
<div class="npage" id="page-blocked-raw">
  <div class="page">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">Blocked Signals — Raw Grouped View</div>
        <div class="card-meta" id="blkraw-meta">Compliance+ · gegroepeerd per symbol / dir / vwap / session / reason</div>
      </div>
      <div class="tw">
        <table id="blkraw-tbl">
          <thead><tr>
            <th data-col="0">Symbol</th>
            <th data-col="1">Dir</th>
            <th data-col="2">VWAP</th>
            <th data-col="3">Session</th>
            <th data-col="4">Outcome</th>
            <th data-col="5">Reject Reason</th>
            <th data-col="6"># Geblokkeerd</th>
            <th>Laatste Keer</th>
          </tr></thead>
          <tbody id="blkraw-body"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════
     PAGE: EV OPTIMIZER
═══════════════════════════════════════════════════════════════ -->
<div class="npage" id="page-ev">
  <div class="page">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-err" id="ev-dot"></div>
          EV / TP Optimizer — All Signal Combos
        </div>
        <div class="card-meta" id="ev-meta">EV locked at ≥5 ghost trades</div>
      </div>
      <div class="fbar">
        <span class="fl">Type:</span>
        <button class="fb on" onclick="setEVF('type','all',this)">All</button>
        <button class="fb" onclick="setEVF('type','forex',this)">Forex</button>
        <button class="fb" onclick="setEVF('type','index',this)">Index</button>
        <button class="fb" onclick="setEVF('type','stock',this)">Stock</button>
        &nbsp;
        <span class="fl">Session:</span>
        <button class="fb on" onclick="setEVF('sess','all',this)">All</button>
        <button class="fb" onclick="setEVF('sess','asia',this)">Asia</button>
        <button class="fb" onclick="setEVF('sess','london',this)">London</button>
        <button class="fb" onclick="setEVF('sess','ny',this)">New York</button>
        &nbsp;
        <span class="fl">Dir:</span>
        <button class="fb on" onclick="setEVF('dir','all',this)">All</button>
        <button class="fb" onclick="setEVF('dir','buy',this)">Buy</button>
        <button class="fb" onclick="setEVF('dir','sell',this)">Sell</button>
        &nbsp;
        <span class="fl">Min Ghosts:</span>
        <button class="fb on" onclick="setEVF('min','1',this)">≥1</button>
        <button class="fb" onclick="setEVF('min','5',this)">≥5 (EV ready)</button>
        <button class="fb" onclick="setEVF('min','0',this)">All</button>
      </div>
      <div class="sstrip">
        <div class="ss"><div class="ss-lbl">Combos shown</div><div class="ss-val cb" id="ev-cnt">—</div></div>
        <div class="ss"><div class="ss-lbl">With ghost data</div><div class="ss-val cc" id="ev-data">—</div></div>
        <div class="ss"><div class="ss-lbl">EV+ locked</div><div class="ss-val cy" id="ev-lck">—</div></div>
        <div class="ss"><div class="ss-lbl">Total P&L (compliance+)</div><div class="ss-val" id="ev-pnl">—</div></div>
      </div>
      <div class="tw">
        <table id="ev-tbl">
          <thead><tr>
            <th data-col="0">Symbol</th>
            <th>Type</th>
            <th data-col="2">Session</th>
            <th data-col="3">Dir</th>
            <th data-col="4">VWAP</th>
            <th data-col="5"># Ghosts</th>
            <th data-col="6"># Trades</th>
            <th data-col="7">Best TP RR</th>
            <th data-col="8">Avg RR</th>
            <th data-col="9">EV Score</th>
            <th>Status</th>
            <th data-col="11">TP Lock</th>
            <th data-col="12">Avg T→SL</th>
            <th data-col="13">Avg MAE %</th>
            <th data-col="14">P&L €</th>
          </tr></thead>
          <tbody id="ev-body"></tbody>
        </table>
      </div>
    </div>

    <!-- EV Matrix -->
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">EV Matrix — Quick View</div>
        <div class="card-meta">EV score · n trades · ★ = TP locked · grey = no data</div>
      </div>
      <div style="overflow-x:auto">
        <div style="display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--bdr2)">
          <div style="border-right:1px solid var(--bdr2)">
            <div style="padding:5px 12px;font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;background:var(--bg3);border-bottom:1px solid var(--bdr2);">FOREX</div>
            <table class="mx"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-fx"></tbody></table>
          </div>
          <div>
            <div style="padding:5px 12px;font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;background:var(--bg3);border-bottom:1px solid var(--bdr2);">INDEXES + COMMODITIES</div>
            <table class="mx"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-ix"></tbody></table>
          </div>
        </div>
        <div style="padding:5px 12px;font-size:9px;color:var(--ink3);text-transform:uppercase;letter-spacing:.5px;background:var(--bg3);border-bottom:1px solid var(--bdr2);">STOCKS (NY only)</div>
        <table class="mx"><thead><tr><th>Symbol</th><th>B/Above</th><th>B/Below</th><th>S/Above</th><th>S/Below</th></tr></thead><tbody id="mxb-sk"></tbody></table>
      </div>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════════
     PAGE: SIGNALS
═══════════════════════════════════════════════════════════════ -->
<div class="npage" id="page-signals">
  <div class="page">
    <div class="card">
      <div class="card-hdr">
        <div class="card-title">
          <div class="status-dot sd-err" id="sig-dot"></div>
          Signal Log — Errors, Blocked &amp; Band Analysis
        </div>
        <div class="card-meta" id="sig-meta">loading...</div>
      </div>

      <!-- Signal Overview Stats -->
      <div class="sig-stat-grid">
        <div class="sig-stat">
          <div class="sig-stat-lbl">Total Signals</div>
          <div class="sig-stat-val cb" id="sig-total">—</div>
        </div>
        <div class="sig-stat">
          <div class="sig-stat-lbl">Placed</div>
          <div class="sig-stat-val cg" id="sig-placed">—</div>
        </div>
        <div class="sig-stat">
          <div class="sig-stat-lbl">Blocked / Rejected</div>
          <div class="sig-stat-val cr" id="sig-blocked">—</div>
        </div>
        <div class="sig-stat">
          <div class="sig-stat-lbl">Conversion Rate</div>
          <div class="sig-stat-val cy" id="sig-conv">—</div>
        </div>
      </div>

      <!-- Blocked breakdown strip -->
      <div class="sstrip">
        <div class="ss"><div class="ss-lbl">Total Blocked</div><div class="ss-val cr" id="blk-tot">—</div></div>
        <div class="ss"><div class="ss-lbl">Duplicate Open</div><div class="ss-val co" id="blk-dup">—</div></div>
        <div class="ss"><div class="ss-lbl">VWAP Exhausted</div><div class="ss-val cp" id="blk-vw">—</div></div>
        <div class="ss"><div class="ss-lbl">Outside Window</div><div class="ss-val cd" id="blk-win">—</div></div>
        <div class="ss"><div class="ss-lbl">Currency Budget</div><div class="ss-val cy" id="blk-cur">—</div></div>
        <div class="ss"><div class="ss-lbl">NY Dead Zone</div><div class="ss-val cr" id="blk-ny">—</div></div>
      </div>

      <div class="itabs">
        <div class="itab on" onclick="showItab('sig','errors')">⚠ Webhook Errors</div>
        <div class="itab" onclick="showItab('sig','rejects')">🚫 Blocked Signals</div>
        <div class="itab" onclick="showItab('sig','placed')">✅ Placed Signals</div>
        <div class="itab" onclick="showItab('sig','band150')">Band 150–250%</div>
        <div class="itab" onclick="showItab('sig','band250')">Band 250–350%</div>
      </div>

      <!-- Webhook Errors -->
      <div class="ipane on" id="sig-tab-errors">
        <div class="tw">
          <table id="whe-tbl">
            <thead><tr>
              <th data-col="0">Time</th>
              <th data-col="1">Type</th>
              <th data-col="2">Symbol</th>
              <th data-col="3">Dir</th>
              <th data-col="4">Session</th>
              <th data-col="5">VWAP</th>
              <th>Entry</th><th>SL%</th><th>Band%</th>
              <th>Reason</th>
            </tr></thead>
            <tbody id="whe-body"></tbody>
          </table>
        </div>
      </div>

      <!-- Blocked Signals -->
      <div class="ipane" id="sig-tab-rejects">
        <div class="tw">
          <table id="blk-tbl">
            <thead><tr>
              <th>Outcome</th>
              <th>Reject Reason</th>
              <th data-col="2">Symbol</th>
              <th data-col="3">Dir</th>
              <th data-col="4">Session</th>
              <th data-col="5">VWAP</th>
              <th data-col="6">Count</th>
            </tr></thead>
            <tbody id="blk-body"></tbody>
          </table>
        </div>
      </div>

      <!-- Placed Signals -->
      <div class="ipane" id="sig-tab-placed">
        <div class="tw">
          <table id="placed-tbl">
            <thead><tr>
              <th data-col="0">Time</th>
              <th data-col="1">Symbol</th>
              <th>Dir</th><th>Session</th><th>VWAP</th>
              <th>Entry</th><th>SL%</th><th>TP RR</th>
              <th>Latency</th><th>EV+</th>
            </tr></thead>
            <tbody id="placed-body"></tbody>
          </table>
        </div>
      </div>

      <!-- Band 150-250 -->
      <div class="ipane" id="sig-tab-band150">
        <div style="padding:7px 14px;background:var(--bg3);border-bottom:1px solid var(--bdr2);font-size:10px;color:var(--ink3)">
          <b class="cy">Band 150–250%</b> — signals with VWAP band distance 150%–250% of half-band (currently rejected). Ghost data shows actual RR potential.
        </div>
        <div class="sstrip" id="b150-strip" style="display:none">
          <div class="ss"><div class="ss-lbl">Ghosts</div><div class="ss-val cb" id="b150-n">—</div></div>
          <div class="ss"><div class="ss-lbl">Avg Max RR</div><div class="ss-val cg" id="b150-rr">—</div></div>
          <div class="ss"><div class="ss-lbl">Avg SL%</div><div class="ss-val co" id="b150-sl">—</div></div>
        </div>
        <div class="tw"><table id="b150-tbl"><thead><tr><th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th><th>n</th><th>Avg RR</th><th>Max RR</th><th>Avg SL%</th><th>Avg T→SL</th></tr></thead><tbody id="b150-body"></tbody></table></div>
      </div>

      <!-- Band 250-350 -->
      <div class="ipane" id="sig-tab-band250">
        <div style="padding:7px 14px;background:var(--bg3);border-bottom:1px solid var(--bdr2);font-size:10px;color:var(--ink3)">
          <b class="cr">Band 250–350%</b> — extreme outliers. Read-only analysis.
        </div>
        <div class="sstrip" id="b250-strip" style="display:none">
          <div class="ss"><div class="ss-lbl">Ghosts</div><div class="ss-val cb" id="b250-n">—</div></div>
          <div class="ss"><div class="ss-lbl">Avg Max RR</div><div class="ss-val cg" id="b250-rr">—</div></div>
          <div class="ss"><div class="ss-lbl">Avg SL%</div><div class="ss-val co" id="b250-sl">—</div></div>
        </div>
        <div class="tw"><table id="b250-tbl"><thead><tr><th>Symbol</th><th>Session</th><th>Dir</th><th>VWAP</th><th>n</th><th>Avg RR</th><th>Max RR</th><th>Avg SL%</th><th>Avg T→SL</th></tr></thead><tbody id="b250-body"></tbody></table></div>
      </div>
    </div>
  </div>
</div>

<script>
/* ══════════════════════════════════════════════════════════════
   PRONTO·AI Dashboard v12.5 — Full Rewrite
   ══════════════════════════════════════════════════════════════ */
const FOREX=${JSON.stringify(FOREX_SYMBOLS)};
const INDEX=${JSON.stringify(INDEX_SYMBOLS)};
const COMM=${JSON.stringify(COMMODITY_SYMBOLS)};
const STOCKS=${JSON.stringify(STOCK_SYMBOLS)};
const ADV_STEPS=${JSON.stringify(ADV_STEPS)};
const FAV_STEPS=${JSON.stringify(FAV_STEPS)};
const COMPLIANCE = new Date('2026-05-03T00:00:00.000Z');

let _allTrades=[], _evData=[], _tpMap={}, _evMap={}, _maeData={};
let _lastLoad = null;
const evF = { type:'all', sess:'all', dir:'all', min:'1' };

/* ── Formatters ────────────────────────────────────────────── */
const f  = (v,d=2) => v==null ? '—' : (+v).toFixed(d);
const eu = v => v==null ? '—' : (v>=0?'+':'')+'€'+Math.abs(+v).toFixed(2);
const pC = v => v==null ? 'cd' : v>0 ? 'cg' : v<0 ? 'cr' : 'cd';
const fm_cls = 'fm ';
const ts = s => !s ? '—' : new Date(s).toLocaleTimeString('nl-BE',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit'});
const dt = s => !s ? '—' : new Date(s).toLocaleDateString('nl-BE',{timeZone:'Europe/Brussels',month:'2-digit',day:'2-digit'});
const dtTs = s => !s ? '—' : dt(s)+' '+ts(s);
const msFmt = m => {
  if(m==null) return '—';
  if(m<60) return m+'m';
  return Math.floor(m/60)+'h'+(m%60?String(m%60).padStart(2,'0')+'m':'');
};
const wrPct = (w,t) => t>0 ? (w/t*100).toFixed(1)+'%' : '—';

/* ── Symbol helpers ─────────────────────────────────────────── */
function sType(s) {
  if(FOREX.includes(s))   return 'fx';
  if(INDEX.includes(s))   return 'ix';
  if(COMM.includes(s))    return 'cm';
  return 'sk';
}
function sTypeName(s) {
  if(FOREX.includes(s))   return 'forex';
  if(INDEX.includes(s))   return 'index';
  if(COMM.includes(s))    return 'commodity';
  return 'stock';
}
function tCls(s) { return 't-'+sType(s); }

/* ── Badges ─────────────────────────────────────────────────── */
function dBadge(d) { return d==='buy'?'<span class="bd b-buy">BUY</span>':d==='sell'?'<span class="bd b-sell">SELL</span>':'—'; }
function vBadge(v) { return v==='above'?'<span class="bd b-ab">ABOVE</span>':v==='below'?'<span class="bd b-bw">BELOW</span>':'<span class="bd" style="color:var(--ink3)">?</span>'; }
function sBadge(s) {
  const m = {asia:'b-asia',london:'b-lon',ny:'b-ny',outside:'b-out'};
  const n = {asia:'ASIA',london:'LON',ny:'NY',outside:'OUT'};
  return \`<span class="bd \${m[s]||'b-out'}">\${n[s]||s||'—'}</span>\`;
}
function tyBadge(t) {
  const m={forex:'b-fx',index:'b-ix',commodity:'b-cm',stock:'b-sk'};
  const n={forex:'FX',index:'IDX',commodity:'COM',stock:'STK'};
  return \`<span class="bd \${m[t]||'b-sk'}">\${n[t]||t}</span>\`;
}

/* ── SL bar ─────────────────────────────────────────────────── */
function slBar(p) {
  const w = Math.min(100,Math.max(0,p||0));
  const cls = w<50?'':w<80?' y':' r';
  return \`<div class="slbar"><div class="slbg"><div class="slfi\${cls}" style="width:\${w}%"></div></div><span class="sl-pct">\${f(p,0)}%</span></div>\`;
}

/* ── Status dots ────────────────────────────────────────────── */
function setDot(id, ok) {
  const e = document.getElementById(id);
  if(e) e.className = 'status-dot '+(ok?'sd-ok':'sd-err');
}

/* ── Empty row ──────────────────────────────────────────────── */
function emptyRow(n,msg='') { return \`<tr><td colspan="\${n}" class="nd">\${msg}</td></tr>\`; }

/* ── Win rate bar ───────────────────────────────────────────── */
function wrBar(pct, w=80) {
  const p = parseFloat(pct)||0;
  const col = p>=60?'var(--g)':p>=45?'var(--y)':'var(--r)';
  return \`<div class="wr-bar-wrap" style="width:\${w}px"><div class="wr-bar-fill" style="width:\${p}%;background:\${col}"></div></div>\`;
}

/* ── RR milestone timing helper ─────────────────────────────── */
function msT(ts_val, openedAt, isFav=true) {
  if(!ts_val||!openedAt) return '<td class="cd" style="font-size:8px">—</td>';
  const m = Math.round((new Date(ts_val)-new Date(openedAt))/60000);
  let cls;
  if(isFav) cls = m<30?'rr-hit':m<120?'rr-fast':m<480?'rr-mid':'rr-slow';
  else       cls = m<30?'adv-hit':m<120?'adv-near':'adv-ok';
  return \`<td class="\${cls}" style="font-size:8px">\${msFmt(m)}</td>\`;
}

/* find milestone in multiple formats */
function getMilestone(ms, key) {
  if(!ms) return null;
  const fk = parseFloat(key);
  return ms[key]||ms[fk]||ms[String(fk)]||ms[fk.toFixed(1)]||ms[fk.toFixed(2)]||null;
}

function advTds(adv, openedAt) {
  return ADV_STEPS.map(s => msT(getMilestone(adv,s), openedAt, false)).join('');
}
function favTds(fav, openedAt) {
  return FAV_STEPS.map(s => msT(getMilestone(fav,s), openedAt, true)).join('');
}

/* ── API helper ─────────────────────────────────────────────── */
async function api(path, ms=12000) {
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(), ms);
  try {
    const r = await fetch(path, {signal:c.signal});
    clearTimeout(t);
    if(!r.ok) return null;
    return r.json();
  } catch(e) { clearTimeout(t); return null; }
}

/* ── Navigation ─────────────────────────────────────────────── */
let _page = 'overview';
function showPage(name) {
  document.querySelectorAll('.npage').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('on'));
  document.getElementById('page-'+name)?.classList.add('on');
  document.querySelectorAll('.ntab').forEach(t=>{
    if(t.getAttribute('onclick')?.includes("'"+name+"'")) t.classList.add('on');
  });
  _page = name;
  // Lazy load on first visit
  if(name==='history'     && !_histLoaded)    { _histLoaded=true;    loadGhostHistory(); loadGhostHistoryGrouped(); }
  if(name==='ev-sl'       && !_evslLoaded)    { _evslLoaded=true;    loadEVSL(); }
  if(name==='blocked-raw' && !_blkRawLoaded)  { _blkRawLoaded=true;  loadBlockedRaw(); }
}
let _histLoaded=false, _evslLoaded=false, _blkRawLoaded=false;

function showItab(group, name) {
  const pre = group+'-tab-';
  document.querySelectorAll(\`[id^="\${pre}"]\`).forEach(p=>p.classList.remove('on'));
  document.querySelectorAll(\`.itab[onclick*="'\${group}'"]\`).forEach(t=>t.classList.remove('on'));
  document.getElementById(pre+name)?.classList.add('on');
  document.querySelector(\`.itab[onclick="showItab('\${group}','\${name}')"]\`)?.classList.add('on');
  if(group==='sig'&&name==='band150') loadBand('150_250','b150');
  if(group==='sig'&&name==='band250') loadBand('250_350','b250');
}

/* ── Sort ───────────────────────────────────────────────────── */
const _sortState = {};
function initSort(id) {
  const t = document.getElementById(id);
  if(!t) return;
  t.querySelectorAll('th[data-col]').forEach(th => th.addEventListener('click', ()=>{
    const col = +th.dataset.col;
    const k = id+'_'+col;
    const asc = _sortState[k]!=='asc';
    _sortState[k] = asc?'asc':'desc';
    t.querySelectorAll('th[data-col]').forEach(h=>h.classList.remove('asc','desc'));
    th.classList.add(asc?'asc':'desc');
    const tb = t.querySelector('tbody');
    const rows = Array.from(tb.rows);
    rows.sort((a,b)=>{
      const av = a.cells[col]?.dataset?.val ?? a.cells[col]?.textContent ?? '';
      const bv = b.cells[col]?.dataset?.val ?? b.cells[col]?.textContent ?? '';
      const an=parseFloat(av), bn=parseFloat(bv);
      return (asc?1:-1)*(!isNaN(an)&&!isNaN(bn)?an-bn:av.localeCompare(bv));
    });
    rows.forEach(r=>tb.appendChild(r));
  }));
}
function initAll() {
  ['pos-tbl','gh-tbl','ghh-tbl','ghh2-tbl','daily-tbl','ev-tbl','evsl-tbl','whe-tbl','blk-tbl','blkraw-tbl','sl-tbl','placed-tbl','wr-body']
    .forEach(initSort);
}

/* ══ CLOCK ══════════════════════════════════════════════════════ */
const SESS_META = {
  asia:    {cls:'sb-asia',   lbl:'ASIA'},
  london:  {cls:'sb-london', lbl:'LONDON'},
  ny:      {cls:'sb-ny',     lbl:'NEW YORK'},
  outside: {cls:'sb-out',    lbl:'OUTSIDE'},
};
function updateClock() {
  const d = new Date();
  const bf = new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Brussels',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(d);
  const gp = t => bf.find(p=>p.type===t)?.value??'00';
  let h = parseInt(gp('hour'));
  const mi = parseInt(gp('minute'));
  if(h===24) h=0;
  document.getElementById('clock').textContent = \`\${String(h).padStart(2,'0')}:\${gp('minute')}:\${gp('second')}\`;
  const hhmm = h*100+mi;
  const day = new Date(d.toLocaleDateString('en-CA',{timeZone:'Europe/Brussels'})).getDay();
  let sess = 'outside';
  if(day>0&&day<6) {
    if(hhmm>=200&&hhmm<800)   sess='asia';
    else if(hhmm>=800&&hhmm<1530)  sess='london';
    else if(hhmm>=1530&&hhmm<2100) sess='ny';
  }
  const sm = SESS_META[sess];
  const el = document.getElementById('hdr-sess');
  if(el) { el.textContent=sm.lbl; el.className='sess-badge '+sm.cls; }
  if(_lastLoad) {
    const rem = Math.max(0,30-Math.floor((Date.now()-_lastLoad)/1000)%30);
    const ns = document.getElementById('nav-right');
    if(ns) ns.textContent = 'Next refresh in '+rem+'s';
  }
}
setInterval(updateClock, 1000);
updateClock();

/* ══ TRADE STATS / WIN RATE ════════════════════════════════════ */
async function loadTradeStats() {
  const d = await api('/trades?limit=10000');
  if(!d) { setDot('wr-dot',false); setDot('dist-dot',false); return; }
  setDot('wr-dot',true); setDot('dist-dot',true);

  const trades = (d.trades||[]).filter(t => t.openedAt && new Date(t.openedAt)>=COMPLIANCE);
  const total = trades.length;
  document.getElementById('wr-meta').textContent = total+' closed trades after compliance date';
  document.getElementById('dist-meta').textContent = total+' closed trades — 3 mei 2026+';
  document.getElementById('ov-comp').textContent = total||'0';

  // Helper: wins = hitTp=true OR closeReason='tp'
  const isWin = t => t.hitTp===true || t.closeReason==='tp';
  const overall = trades.filter(isWin).length;

  /* ── Header KPI Win Rate ── */
  const wrPctVal = total>0 ? (overall/total*100).toFixed(1)+'%' : '—';
  document.getElementById('k-wr').textContent = wrPctVal;
  document.getElementById('ov-wr').textContent = wrPctVal;
  document.getElementById('ov-wr-sub').textContent = overall+'/'+total+' wins';

  // Profit factor
  const wins  = trades.filter(isWin);
  const losses= trades.filter(t=>!isWin(t));
  const grossW = wins.reduce((s,t)=>s+Math.abs(t.realizedPnlEUR||0),0);
  const grossL = losses.reduce((s,t)=>s+Math.abs(t.realizedPnlEUR||0),0);
  const pf = grossL>0 ? (grossW/grossL).toFixed(2) : wins.length>0?'∞':'—';
  document.getElementById('ov-pf').textContent = pf;

  /* ── Breakdowns ── */
  function wr(arr) {
    const w=arr.filter(isWin).length, n=arr.length;
    return { w, n, pct: n>0?(w/n*100).toFixed(1)+'%':'—' };
  }
  const byBuy  = wr(trades.filter(t=>t.direction==='buy'));
  const bySell = wr(trades.filter(t=>t.direction==='sell'));
  const byAb   = wr(trades.filter(t=>t.vwapPosition==='above'));
  const byBw   = wr(trades.filter(t=>t.vwapPosition==='below'));
  const byAsia = wr(trades.filter(t=>t.session==='asia'));
  const byLon  = wr(trades.filter(t=>t.session==='london'));
  const byNY   = wr(trades.filter(t=>t.session==='ny'));

  function setSS(id, pct, sub) {
    document.getElementById(id).textContent = pct;
    document.getElementById(id+'-n')?.textContent && (document.getElementById(id+'-n').textContent = sub);
  }
  document.getElementById('wr-overall').textContent = wrPctVal;
  document.getElementById('wr-overall-n').textContent = total+' trades';
  document.getElementById('wr-buy').textContent  = byBuy.pct;  document.getElementById('wr-buy-n').textContent  = byBuy.w+'/'+byBuy.n;
  document.getElementById('wr-sell').textContent = bySell.pct; document.getElementById('wr-sell-n').textContent = bySell.w+'/'+bySell.n;
  document.getElementById('wr-ab').textContent   = byAb.pct;   document.getElementById('wr-ab-n').textContent   = byAb.w+'/'+byAb.n;
  document.getElementById('wr-bw').textContent   = byBw.pct;   document.getElementById('wr-bw-n').textContent   = byBw.w+'/'+byBw.n;
  document.getElementById('wr-asia').textContent = byAsia.pct; document.getElementById('wr-asia-n').textContent = byAsia.w+'/'+byAsia.n;
  document.getElementById('wr-lon').textContent  = byLon.pct;  document.getElementById('wr-lon-n').textContent  = byLon.w+'/'+byLon.n;
  document.getElementById('wr-ny').textContent   = byNY.pct;   document.getElementById('wr-ny-n').textContent   = byNY.w+'/'+byNY.n;

  /* ── Win Rate Table (combos) ── */
  const combos = [];
  for(const sess of ['asia','london','ny']) {
    for(const dir of ['buy','sell']) {
      for(const vwap of ['above','below']) {
        const arr = trades.filter(t=>t.session===sess&&t.direction===dir&&t.vwapPosition===vwap);
        if(!arr.length) continue;
        const w=arr.filter(isWin).length, n=arr.length;
        const pct=w/n*100;
        const avgW=w>0?arr.filter(isWin).reduce((s,t)=>s+(t.realizedPnlEUR||0),0)/w:null;
        const avgL=n-w>0?arr.filter(t=>!isWin(t)).reduce((s,t)=>s+(t.realizedPnlEUR||0),0)/(n-w):null;
        const ev = (avgW!=null&&avgL!=null) ? (pct/100)*avgW + (1-pct/100)*avgL : null;
        combos.push({sess,dir,vwap,w,n,pct,avgW,avgL,ev});
      }
    }
  }
  combos.sort((a,b)=>b.pct-a.pct);
  document.getElementById('wr-body').innerHTML = combos.map(c=>{
    const pctStr = c.pct.toFixed(1)+'%';
    const cls = c.pct>=60?'cg fw':c.pct>=45?'cy':'cr';
    return \`<tr>
      <td>\${sBadge(c.sess)}</td>
      <td>\${dBadge(c.dir)}</td>
      <td>\${vBadge(c.vwap)}</td>
      <td class="cg fm">\${c.w}</td>
      <td class="cr fm">\${c.n-c.w}</td>
      <td class="cb fm">\${c.n}</td>
      <td data-val="\${c.pct}" class="\${cls} fm">\${pctStr}</td>
      <td>\${wrBar(c.pct, 120)}</td>
      <td class="\${c.avgW!=null?(c.avgW>0?'cg':'cr'):'cd'} fm">\${c.avgW!=null?eu(c.avgW):'—'}</td>
      <td class="\${c.avgL!=null?(c.avgL>0?'cg':'cr'):'cd'} fm">\${c.avgL!=null?eu(c.avgL):'—'}</td>
      <td data-val="\${c.ev??-9999}" class="\${c.ev!=null?(c.ev>0?'cg':'cr'):'cd'} fm">\${c.ev!=null?eu(c.ev):'—'}</td>
    </tr>\`;
  }).join('');

  /* ── Trade Distribution Table ── */
  document.getElementById('d-tot').textContent  = total;
  document.getElementById('d-buy').textContent  = trades.filter(t=>t.direction==='buy').length;
  document.getElementById('d-sell').textContent = trades.filter(t=>t.direction==='sell').length;
  document.getElementById('d-ab').textContent   = trades.filter(t=>t.vwapPosition==='above').length;
  document.getElementById('d-bw').textContent   = trades.filter(t=>t.vwapPosition==='below').length;
  document.getElementById('d-as').textContent   = trades.filter(t=>t.session==='asia').length;
  document.getElementById('d-lo').textContent   = trades.filter(t=>t.session==='london').length;
  document.getElementById('d-ny').textContent   = trades.filter(t=>t.session==='ny').length;

  let ba_t=0,bb_t=0,sa_t=0,sb_t=0;
  const tb = document.getElementById('dist-body');
  tb.innerHTML = ['asia','london','ny'].map(sess=>{
    const st = trades.filter(t=>t.session===sess);
    const ba=st.filter(t=>t.direction==='buy'&&t.vwapPosition==='above');
    const bb=st.filter(t=>t.direction==='buy'&&t.vwapPosition==='below');
    const sa=st.filter(t=>t.direction==='sell'&&t.vwapPosition==='above');
    const sb=st.filter(t=>t.direction==='sell'&&t.vwapPosition==='below');
    ba_t+=ba.length; bb_t+=bb.length; sa_t+=sa.length; sb_t+=sb.length;
    const tw=st.filter(isWin).length, tn=st.length;
    const wCls=tn>0?(tw/tn>=.6?'cg':tw/tn>=.45?'cy':'cr'):'cd';
    return \`<tr>
      <td>\${sBadge(sess)}</td>
      <td class="cg fm fw">\${ba.length}</td>
      <td class="cg fm">\${bb.length}</td>
      <td class="cr fm fw">\${sa.length}</td>
      <td class="cr fm">\${sb.length}</td>
      <td class="cb fm fw">\${st.length}</td>
      <td class="\${wCls} fm">\${tn>0?((tw/tn)*100).toFixed(1)+'%':'—'}</td>
    </tr>\`;
  }).join('');
  document.getElementById('ft-ba').textContent = ba_t;
  document.getElementById('ft-bb').textContent = bb_t;
  document.getElementById('ft-sa').textContent = sa_t;
  document.getElementById('ft-sb').textContent = sb_t;
  document.getElementById('ft-t').textContent  = total;
  document.getElementById('ft-wr').textContent = total>0?((overall/total)*100).toFixed(1)+'%':'—';
}

/* ══ OPEN POSITIONS ════════════════════════════════════════════ */
async function loadPositions() {
  const d = await api('/live/positions');
  if(!d) { setDot('pos-dot',false); document.getElementById('pos-meta').textContent='error'; setTimeout(loadPositions,10000); return; }
  setDot('pos-dot',true);
  const cnt=d.count||0;
  document.getElementById('pos-meta').textContent = cnt+' open trades';
  document.getElementById('k-pos').textContent = cnt;
  document.getElementById('nb-pos').textContent = cnt;
  document.getElementById('ov-pnl').textContent = cnt>0?eu(d.positions?.reduce((s,p)=>s+(p.currentPnL||0),0)):'€0.00';
  document.getElementById('ov-pnl').className = 'ov-val '+pC(d.positions?.reduce((s,p)=>s+(p.currentPnL||0),0)??0);

  // P&L header
  const pnl=d.positions?.reduce((s,p)=>s+(p.currentPnL||0),0)??0;
  const pnlEl=document.getElementById('k-pnl');
  pnlEl.textContent=eu(pnl); pnlEl.className='hk-val '+pC(pnl);

  // Position strip
  if(cnt>0) {
    const strip = document.getElementById('pos-strip');
    if(strip) strip.style.display='flex';
    document.getElementById('pos-cnt').textContent=cnt;
    document.getElementById('pos-pnl').textContent=eu(pnl);
    document.getElementById('pos-pnl').className='ss-val '+pC(pnl);
    const ghd=d.positions?.filter(p=>p.isGhosted).length||0;
    const evp=d.positions?.filter(p=>p.isEvPlus).length||0;
    const buys=d.positions?.filter(p=>p.direction==='buy').length||0;
    const sells=cnt-buys;
    const ab=d.positions?.filter(p=>p.vwapPosition==='above').length||0;
    document.getElementById('pos-gh').textContent=ghd;
    document.getElementById('pos-ev').textContent=evp;
    document.getElementById('pos-bs').textContent=buys+' / '+sells;
    document.getElementById('pos-ab').textContent=ab+' / '+(cnt-ab);
  }

  const tb = document.getElementById('pos-body');
  if(!d.positions?.length) { tb.innerHTML=emptyRow(15+ADV_STEPS.length+FAV_STEPS.length,'No open trades'); return; }

  const isFx = s => FOREX.includes(s)||INDEX.includes(s);
  tb.innerHTML = d.positions.map(p=>{
    const slDist = p.sl&&p.entry ? Math.abs(p.entry-p.sl) : 0;
    const priceD = p.currentPrice&&p.entry ? (p.direction==='buy'?(p.currentPrice-p.entry):(p.entry-p.currentPrice)) : null;
    const rrNow  = slDist>0&&priceD!=null ? +(priceD/slDist).toFixed(2) : null;
    const rrCls  = rrNow==null?'cd':rrNow>=2?'cg fw':rrNow>=1?'cg':rrNow>=0?'cy':rrNow>=-0.5?'cr':'cr fw';
    const maxRR  = p.maxRR??0;
    const tpRR   = p.tpRRActual??p.tpRR;
    const rPct   = p.actualRiskPct??p.riskPct;
    const dec    = isFx(p.symbol)?5:2;

    // Milestone data — adverse uit slMilestones (pct keys 10-100), favorable uit rrMilestones.favorable
    const ms     = p.slMilestones ?? {};
    const favMs  = p.rrMilestones?.favorable ?? {};
    const advFull = {};
    ADV_STEPS.forEach(s => {
      const pctKey = Math.round(s * 100) + '';   // "10","20",...,"100"
      advFull[s] = ms[pctKey] || ms[s] || ms[String(parseFloat(s))] || null;
    });

    const peakPos = p.peakRRPos ?? p.maxRR ?? 0;
    const peakNeg = p.peakRRNeg ?? 0;   // stored as % of SL distance (0–100)

    return \`<tr class="\${tCls(p.symbol)}">
      <td data-val="\${p.symbol}" class="cb fw fm" style="font-size:11px">\${p.symbol}</td>
      <td>\${tyBadge(sTypeName(p.symbol))}</td>
      <td>\${dBadge(p.direction)}</td>
      <td>\${vBadge(p.vwapPosition)}</td>
      <td>\${sBadge(p.session)}</td>
      <td data-val="\${p.entry}" class="cd fm" style="font-size:10px">\${f(p.entry,dec)}</td>
      <td data-val="\${p.sl}"    class="cr fm" style="font-size:10px">\${f(p.sl,dec)}</td>
      <td data-val="\${p.tp}"    class="cg fm" style="font-size:10px">\${f(p.tp,dec)}</td>
      <td data-val="\${rrNow??-99}" class="\${rrCls} fm" style="font-size:13px">\${rrNow!=null?rrNow+'R':'—'}</td>
      <td data-val="\${peakPos}" class="\${peakPos>=2?'cg fw':peakPos>=1?'cg':peakPos>0?'cy':'cd'} fm">\${f(peakPos,2)}R</td>
      <td data-val="\${peakNeg}" class="\${peakNeg>80?'cr fw':peakNeg>50?'cr':peakNeg>25?'co':'cd'} fm">\${peakNeg>0?'-'+f(peakNeg,0)+'%':'—'}</td>
      <td>\${slBar(p.slPctUsed)}</td>
      <td data-val="\${tpRR??-99}" class="cy fm">\${tpRR!=null?f(tpRR,2)+'R':'—'}</td>
      <td data-val="\${p.currentPnL??-99999}" class="\${pC(p.currentPnL)} fw fm">\${eu(p.currentPnL)}</td>
      <td data-val="\${p.lots}" class="cd fm">\${f(p.lots,2)}</td>
      <td data-val="\${rPct??-1}" class="\${rPct&&rPct>0.04?'cr fw':rPct&&rPct>0.025?'co':'cg'} fm">\${rPct!=null?f(rPct,3)+'%':'—'}</td>
      \${ADV_STEPS.map(s=>msT(advFull[s],p.openedAt,false)).join('')}
      \${FAV_STEPS.map(s=>msT(getMilestone(favMs,s),p.openedAt,true)).join('')}
      <td data-val="\${p.openedAt}" class="cd" style="font-size:9px">\${dtTs(p.openedAt)}</td>
    </tr>\`;
  }).join('');
}

/* ══ GHOST TRACKER ══════════════════════════════════════════════ */
async function loadGhosts() {
  const d = await api('/live/ghosts');
  if(!d) { setDot('gh-dot',false); document.getElementById('gh-meta').textContent='error'; setTimeout(loadGhosts,10000); return; }
  setDot('gh-dot',true);
  const cnt=d.count||0;
  document.getElementById('gh-meta').textContent = cnt+' active · until phantom SL / 15R / 14 days';
  document.getElementById('k-gh').textContent = cnt;
  document.getElementById('nb-gh').textContent = cnt;
  document.getElementById('ov-gh').textContent = cnt;

  if(cnt>0) {
    const strip = document.getElementById('gh-strip');
    if(strip) strip.style.display='flex';
    document.getElementById('gh-cnt').textContent=cnt;
    const best = Math.max(...(d.ghosts||[]).map(g=>g.peakRRPos??g.maxRR??0));
    document.getElementById('gh-bestRR').textContent = best>0?f(best,2)+'R':'—';
    const worst = Math.max(...(d.ghosts||[]).map(g=>g.peakRRNeg??g.slPctUsed??0));
    const worstEl = document.getElementById('gh-worstRR');
    if(worstEl) { worstEl.textContent = worst>0?'-'+f(worst,0)+'%':'—'; }
    const elapsed = d.ghosts?.map(g=>g.elapsedMin||0);
    const avgElap = elapsed?.length>0?Math.round(elapsed.reduce((s,v)=>s+v,0)/elapsed.length):0;
    document.getElementById('gh-elapsed').textContent = msFmt(avgElap);
  }

  const tb=document.getElementById('gh-body');
  if(!d.ghosts?.length) { tb.innerHTML=emptyRow(8+ADV_STEPS.length+FAV_STEPS.length,'No active ghost trackers'); return; }
  const isFx=s=>FOREX.includes(s)||INDEX.includes(s);

  tb.innerHTML=d.ghosts.map(g=>{
    const advMs  = {};
    const ms     = g.slMilestones||{};
    ADV_STEPS.forEach(s=>{
      const pk = Math.round(s*100)+'';
      advMs[s] = ms[pk]||ms[s]||null;
    });
    const favMs = g.rrMilestones?.favorable||{};

    // v12.6: gebruik echte peak waarden uit API (niet current slPctUsed)
    const peakPos = g.peakRRPos ?? g.maxRR ?? 0;
    const peakNeg = g.peakRRNeg ?? g.slPctUsed ?? 0;  // % van SL afstand

    return \`<tr class="\${tCls(g.symbol)}">
      <td data-val="\${g.symbol}" class="cb fw fm" style="font-size:11px">\${g.symbol}</td>
      <td>\${tyBadge(sTypeName(g.symbol))}</td>
      <td>\${sBadge(g.session)}</td>
      <td>\${dBadge(g.direction)}</td>
      <td>\${vBadge(g.vwapPosition)}</td>
      <td data-val="\${peakPos}" class="\${peakPos>=2?'cg fw':peakPos>=1?'cg':peakPos>0?'cy':'cd'} fm">\${f(peakPos,2)}R</td>
      <td data-val="\${peakNeg}" class="\${peakNeg>80?'cr fw':peakNeg>50?'cr':peakNeg>25?'co':'cd'} fm">\${peakNeg>0?'-'+f(peakNeg,0)+'%':'—'}</td>
      <td>\${slBar(g.slPctUsed)}</td>
      \${ADV_STEPS.map(s=>msT(advMs[s],g.openedAt,false)).join('')}
      \${FAV_STEPS.map(s=>msT(getMilestone(favMs,s),g.openedAt,true)).join('')}
      <td data-val="\${g.elapsedMin??0}" class="cd fm">\${msFmt(g.elapsedMin)}</td>
      <td data-val="\${g.openedAt}" class="cd" style="font-size:9px">\${dtTs(g.openedAt)}</td>
    </tr>\`;
  }).join('');
}

/* ══ DAILY BREAKDOWN (v12.6) ════════════════════════════════════ */
async function loadDailyBreakdown() {
  const d = await api('/api/daily-breakdown');
  if(!d){ setDot('daily-dot',false); return; }
  setDot('daily-dot',true);
  document.getElementById('d-wstrk').textContent = (d.maxWinStreak??0)+' days';
  document.getElementById('d-lstrk').textContent = (d.maxLossStreak??0)+' days';
  document.getElementById('d-dd').textContent    = '€'+f(d.maxDrawdownDay??0,2);
  document.getElementById('daily-meta').textContent = (d.days?.length??0)+' trading days · compliance+';

  const tb = document.getElementById('daily-body');
  tb.innerHTML = (d.days||[]).map(row=>{
    const wins   = parseInt(row.wins??0);
    const losses = parseInt(row.losses??0);
    const trades = parseInt(row.trades??0);
    const wr     = trades>0?(wins/trades*100).toFixed(0):'0';
    const pnl    = parseFloat(row.day_pnl??0);
    const cum    = parseFloat(row.cum_pnl??0);
    return \`<tr>
      <td class="cd fm" style="font-size:10px">\${row.trade_date}</td>
      <td data-val="\${trades}" class="cb fm">\${trades}</td>
      <td class="cg fm">\${wins}</td>
      <td class="cr fm">\${losses}</td>
      <td data-val="\${wr}" class="\${wr>=60?'cg':wr>=45?'cy':'cr'} fm">\${wr}%</td>
      <td data-val="\${pnl}" class="\${pnl>=0?'cg':'cr'} fw fm">\${eu(pnl)}</td>
      <td class="\${cum>=0?'cg':'cr'} fm">\${eu(cum)}</td>
      <td class="cd fm">\${f(parseFloat(row.avg_lots??0),2)}</td>
      <td class="cg fm">\${f(parseFloat(row.best_rr??0),2)}R</td>
      <td class="cy fm">\${f(parseFloat(row.avg_rr??0),2)}R</td>
    </tr>\`;
  }).join('')||emptyRow(10,'Geen data');

  const setupRow = t => \`<tr style="border-bottom:1px solid var(--bdr)">
    <td class="cb fm" style="padding:2px 4px;font-size:9px">\${t.symbol}</td>
    <td>\${dBadge(t.direction)}</td>
    <td>\${sBadge(t.session)}</td>
    <td>\${vBadge(t.vwapPosition)}</td>
    <td class="cy fm" style="font-size:9px">\${f(parseFloat(t.maxRR??0),2)}R</td>
    <td class="\${(t.pnl??0)>=0?'cg':'cr'} fw fm" style="font-size:9px">\${eu(parseFloat(t.pnl??0))}</td>
  </tr>\`;
  document.getElementById('best-body').innerHTML  = (d.bestTrades||[]).map(setupRow).join('')||emptyRow(6,'—');
  document.getElementById('worst-body').innerHTML = (d.worstTrades||[]).map(setupRow).join('')||emptyRow(6,'—');
}

/* ══ GHOST HISTORY GROUPED (v12.6) ════════════════════════════ */
let _ghhData2=[], _ghhF2={sess:'all',dir:'all'};
function setGHHF(k,v,btn){
  _ghhF2[k]=v;
  document.querySelectorAll(\`.fb[onclick*="setGHHF('\${k}'"]\`).forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  renderGhostHistoryGrouped();
}

async function loadGhostHistoryGrouped() {
  const d = await api('/api/ghost-history-by-pair');
  if(!d) return;
  _ghhData2=d;
  renderGhostHistoryGrouped();
}

function renderGhostHistoryGrouped() {
  const data = _ghhData2.filter(g=>{
    if(_ghhF2.sess!=='all'&&g.session!==_ghhF2.sess) return false;
    if(_ghhF2.dir !=='all'&&g.direction!==_ghhF2.dir)  return false;
    return true;
  });
  const meta = document.getElementById('ghh2-meta');
  if(meta) meta.textContent = data.length+' combos · compliance+';

  const tb = document.getElementById('ghh2-body');
  if(!tb) return;
  tb.innerHTML = data.map(g=>{
    const tpRRs  = (g.trades||[]).filter(t=>parseFloat(t.peakRRPos??0)>0).map(t=>parseFloat(t.peakRRPos));
    const last5TP = tpRRs.slice(0,5);
    const bestTP = last5TP.length>0?'avg '+f(last5TP.reduce((s,v)=>s+v,0)/last5TP.length,2)+'R':'—';
    const slPcts = (g.trades||[]).filter(t=>parseFloat(t.maxSlPct??0)>0).map(t=>parseFloat(t.maxSlPct)).sort((a,b)=>a-b);
    const last5SL = slPcts.slice(0,5);
    const bestSL  = last5SL.length>0?'p90: '+(last5SL[Math.min(last5SL.length-1,Math.floor(last5SL.length*.9))]??'—')+'%':'—';
    const safeKey = g.optimizerKey.replace(/[^a-zA-Z0-9_]/g,'_');
    return \`<tr style="cursor:pointer" onclick="toggleGHH2('\${safeKey}')">
      <td style="color:var(--ink3);font-size:9px">▶</td>
      <td data-val="\${g.symbol}" class="cb fw fm" style="font-size:11px">\${g.symbol}</td>
      <td>\${sBadge(g.session)}</td>
      <td>\${dBadge(g.direction)}</td>
      <td>\${vBadge(g.vwapPosition)}</td>
      <td data-val="\${g.n}" class="\${g.n>=5?'cy fw':'cc'} fm">\${g.n}</td>
      <td class="cr fm">\${g.nSLHit}</td>
      <td class="cg fm">\${g.nMaxRR15}</td>
      <td class="cy fm">\${g.nMaxDays}</td>
      <td data-val="\${g.avgPeakPos}" class="cg fm">\${f(g.avgPeakPos,2)}R</td>
      <td data-val="\${g.avgPeakNeg}" class="cr fm">\${f(g.avgPeakNeg,1)}%</td>
      <td class="cg fw fm">\${f(g.maxPeakPos,2)}R</td>
      <td class="cy fm" style="font-size:9px">\${bestTP}</td>
      <td class="cd fm" style="font-size:9px">\${bestSL}</td>
    </tr>
    <tr class="ghh2-detail" id="ghh2-detail-\${safeKey}" style="display:none">
      <td colspan="14" style="padding:0;background:var(--bg3)">
        <table style="width:100%;font-size:9px;border-collapse:collapse">
          <thead><tr style="background:var(--bg4)">
            <th style="padding:4px 6px">#</th>
            <th>Opened</th><th>Close Reason</th>
            <th>TP RR</th><th>Max RR</th>
            <th>Peak+RR</th><th>Peak−RR%</th><th>MAE%</th>
          </tr></thead>
          <tbody>\${(g.trades||[]).map((t,i)=>{
            const sr = t.stopReason==='phantom_sl'?'cr':t.stopReason==='max_rr_15'?'cg':'cy';
            return \`<tr style="border-bottom:1px solid var(--bdr)">
              <td style="padding:3px 6px;color:var(--ink3)">\${i+1}</td>
              <td class="cd" style="font-size:8px">\${t.openedAt?new Date(t.openedAt).toLocaleDateString('nl-BE'):'—'}</td>
              <td class="\${sr}" style="font-size:8px">\${t.stopReason??'—'}</td>
              <td class="cy fm">\${t.tpRRUsed??'—'}</td>
              <td class="cy fm">\${f(parseFloat(t.maxRR??0),2)}R</td>
              <td class="cg fm">\${f(parseFloat(t.peakRRPos??0),2)}R</td>
              <td class="cr fm">\${f(parseFloat(t.peakRRNeg??0),1)}%</td>
              <td class="cd fm">\${f(parseFloat(t.maxSlPct??0),1)}%</td>
            </tr>\`;
          }).join('')}</tbody>
        </table>
      </td>
    </tr>\`;
  }).join('')||emptyRow(14,'Geen ghost history');
}
function toggleGHH2(key){
  const el=document.getElementById('ghh2-detail-'+key);
  if(el) el.style.display=el.style.display==='none'?'':'none';
}

/* ══ EV SL OPTIMIZER (v12.6) ═══════════════════════════════════ */
async function loadEVSL() {
  const d = await api('/api/ev-sl-optimizer');
  if(!d){ setDot('evsl-dot',false); return; }
  setDot('evsl-dot',true);
  function maePct(v,t1,t2){if(v==null)return'<td class="cd">—</td>';const c=v<t1?'cg':v<t2?'cy':'cr';return\`<td class="\${c} fm">\${f(v,1)}%</td>\`;}
  const tb = document.getElementById('evsl-body');
  tb.innerHTML = d.filter(c=>(c.sampleCount??0)>=5).map(c=>{
    const mae=c.mae, shad=c.shadow, slRec=mae?.slReduction;
    return \`<tr class="\${tCls(c.symbol||'')}">
      <td data-val="\${c.symbol}" class="cb fw fm" style="font-size:11px">\${c.symbol||'—'}</td>
      <td>\${tyBadge(sTypeName(c.symbol||''))}</td>
      <td>\${sBadge(c.session)}</td>
      <td>\${dBadge(c.direction)}</td>
      <td>\${vBadge(c.vwapPosition)}</td>
      <td data-val="\${c.sampleCount}" class="\${(c.sampleCount??0)>=5?'cy fw':'cc'} fm">\${c.sampleCount??0}</td>
      \${maePct(mae?.maeP50,40,65)}\${maePct(mae?.maeP75,50,75)}\${maePct(mae?.maeP90,50,80)}
      <td class="\${slRec?.color==='g'?'cg fw':slRec?.color==='y'?'cy':'cr'} fm" style="font-size:9px">\${slRec?.label||'—'}</td>
      <td data-val="\${c.bestSlPct??0}" class="cy fm">\${c.bestSlPct!=null?c.bestSlPct+'%':'—'}</td>
      <td class="cc fm">\${c.bestSlPct!=null?((100-c.bestSlPct).toFixed(0))+'% kleiner':'—'}</td>
      <td class="cd fm">\${shad?.p50!=null?f(shad.p50,1)+'%':'—'}</td>
      <td class="cd fm">\${shad?.p90!=null?f(shad.p90,1)+'%':'—'}</td>
    </tr>\`;
  }).join('')||emptyRow(14,'Min 5 ghost trades vereist per combo');
}

/* ══ BLOCKED RAW (v12.6) ════════════════════════════════════════ */
async function loadBlockedRaw() {
  const d = await api('/api/blocked-raw');
  if(!d) return;
  const meta = document.getElementById('blkraw-meta');
  if(meta) meta.textContent = d.length+' groepen · compliance+';
  const tb = document.getElementById('blkraw-body');
  tb.innerHTML = d.map(row=>\`<tr>
    <td data-val="\${row.symbol||''}" class="cb fw fm" style="font-size:11px">\${row.symbol||'—'}</td>
    <td>\${dBadge(row.direction)}</td>
    <td>\${vBadge(row.vwapPosition)}</td>
    <td>\${sBadge(row.session)}</td>
    <td data-val="\${row.outcome||''}" class="cd fm" style="font-size:10px">\${row.outcome||'—'}</td>
    <td class="cr fm" style="font-size:10px">\${row.rejectReason||'—'}</td>
    <td data-val="\${row.count}" class="cy fw fm">\${row.count}</td>
    <td class="cd" style="font-size:9px">\${row.lastSeen?new Date(row.lastSeen).toLocaleDateString('nl-BE'):'—'}</td>
  </tr>\`).join('')||emptyRow(8,'Geen geblokkeerde signalen');
}

/* ══ GHOST HISTORY ══════════════════════════════════════════════ */
async function loadGhostHistory() {
  _histLoaded = true;
  const d = await api('/ghosts/history?limit=2000');
  if(!d) { setDot('ghh-dot',false); return; }
  setDot('ghh-dot',true);
  await loadMAE();

  const rows = (d.rows||[]).filter(g => g.openedAt && new Date(g.openedAt)>=COMPLIANCE && g.vwapPosition && g.vwapPosition!=='unknown');
  document.getElementById('ghh-meta').textContent = rows.length+' ghost trades after compliance date';

  // Group by optimizer key
  const byK = {};
  for(const g of rows) {
    const key = g.optimizerKey||((g.symbol||'?')+'_'+(g.session||'?')+'_'+(g.direction||'?')+'_'+(g.vwapPosition||'?'));
    if(!byK[key]) byK[key] = {
      key, sym:g.symbol, sess:g.session, dir:g.direction, vwap:g.vwapPosition,
      count:0, evCount:0,
      bestRR:0, worstRR:0, sumRR:0,
      advSum:{},advN:{}, favSum:{},favN:{},
      reasons:{},
    };
    const b=byK[key];
    b.count++;
    const mr = parseFloat(g.maxRrBeforeSl??g.maxRR??0);
    if(mr>b.bestRR) b.bestRR=mr;
    const cr = g.stopReason||'sl';
    b.reasons[cr]=(b.reasons[cr]||0)+1;
    if((g.phantomSlHit||g.stopReason==='max_rr_15') && mr>=0.5) b.evCount++;
    b.sumRR+=mr;

    // SL milestones
    const ms=g.slMilestones||{};
    const pctMap={25:0.25,50:0.50,75:0.75,100:1.00};
    for(const [pk,rk] of Object.entries(pctMap)){
      const t=ms[pk]||ms[rk]||ms[pk+''];
      if(t&&g.openedAt){const m=Math.round((new Date(t)-new Date(g.openedAt))/60000);if(!isNaN(m)){b.advSum[rk]=(b.advSum[rk]||0)+m;b.advN[rk]=(b.advN[rk]||0)+1;}}
    }
    // Favorable milestones (from rrMilestones.favorable if available)
  }

  const combined=Object.values(byK).sort((a,z)=>z.count-a.count);
  const tb=document.getElementById('ghh-body');
  if(!combined.length){tb.innerHTML=emptyRow(28,'No ghost history after compliance date');return;}

  function aAvg(b,s){const n=b.advN[s];return n>0?Math.round(b.advSum[s]/n):null;}
  function tCell(m,cls='cd'){return\`<td class="\${m!=null?cls:'cd'}" style="font-size:8px">\${m!=null?msFmt(m):'—'}</td>\`;}
  function maePct(v,t1,t2){if(v==null)return'<td class="cd">—</td>';const c=v<t1?'cg':v<t2?'cy':'cr';return\`<td class="\${c} fm" style="font-size:9px">\${f(v,1)}%</td>\`;}

  tb.innerHTML=combined.map(g=>{
    const avgRR=g.count>0?g.sumRR/g.count:0;
    const topR=Object.entries(g.reasons).sort((a,b)=>b[1]-a[1])[0]?.[0]||'sl';
    const mae=_maeData[g.key]??null;
    const slRec=mae?.slReduction;

    // EV TP: best winrate+risk combo from ghost history (after 5+ trades)
    const evTP = g.evCount>=5 ? (g.bestRR>0?f(g.bestRR,1)+'R EV':'—') : g.count>=5?'pending':'need '+(5-g.count)+' more';
    const evTPcls = g.evCount>=5&&g.bestRR>0?'cg':'cd';

    return \`<tr class="\${tCls(g.sym||'')}">
      <td data-val="\${g.sym}" class="cb fw fm" style="font-size:11px">\${g.sym||'—'}</td>
      <td>\${tyBadge(sTypeName(g.sym||''))}</td>
      <td>\${sBadge(g.sess)}</td>
      <td>\${dBadge(g.dir)}</td>
      <td>\${vBadge(g.vwap)}</td>
      <td data-val="\${g.count}" class="\${g.count>=5?'cy fw':'cc'} fm">\${g.count}</td>
      <td data-val="\${g.evCount}" class="\${g.evCount>=5?'cy fw':g.evCount>=1?'cc':'cd'} fm">\${g.evCount}</td>
      <td data-val="\${g.bestRR}" class="\${g.bestRR>0?'cg fw':'cd'} fm">\${f(g.bestRR,2)}R</td>
      <td data-val="\${g.worstRR}" class="\${g.worstRR<0?'cr fw':'cd'} fm">\${g.worstRR?f(g.worstRR,2)+'R':'—'}</td>
      <td data-val="\${avgRR}" class="\${avgRR>=1?'cg':avgRR>0?'cy':'cd'} fm">\${f(avgRR,2)}R</td>
      \${tCell(aAvg(g,0.25),'co')}\${tCell(aAvg(g,0.50),'co')}\${tCell(aAvg(g,0.75),'cr')}\${tCell(aAvg(g,1.00),'cr')}
      \${tCell(null,'cg')}\${tCell(null,'cg')}\${tCell(null,'cg')}\${tCell(null,'cg')}\${tCell(null,'cg')}\${tCell(null,'cg')}\${tCell(null,'cg')}\${tCell(null,'cg')}
      <td style="font-size:9px">\${topR==='sl'?'<span class="bd b-sl">SL</span>':topR==='max_rr_15'?'<span class="bd b-ev">15R</span>':topR==='timeout_2w'?'<span class="bd b-lk">TIMEOUT</span>':'<span class="bd" style="color:var(--ink3)">\${topR}</span>'}</td>
      \${maePct(mae?.maeP50,40,65)}\${maePct(mae?.maeP75,50,75)}\${maePct(mae?.maeP90,50,80)}
      <td class="\${slRec?.color==='g'?'cg':slRec?.color==='y'?'cy':'cr'} fm" style="font-size:9px">\${slRec?.label||'—'}</td>
      <td class="\${evTPcls} fm" style="font-size:9px">\${evTP}</td>
    </tr>\`;
  }).join('');
  renderSLOpt(combined);
}

function renderSLOpt(combined) {
  const hasMae=combined.filter(g=>_maeData[g.key]?.maeP90!=null).sort((a,z)=>{
    return ((_maeData[a.key]?.slReduction?.pct??100)-(_maeData[z.key]?.slReduction?.pct??100));
  });
  const tb=document.getElementById('sl-body');
  if(!hasMae.length){tb.innerHTML=emptyRow(11,'No MAE data available yet — waiting for ghost history');return;}
  function maePct(v,t1,t2){if(v==null)return'<td class="cd">—</td>';const c=v<t1?'cg':v<t2?'cy':'cr';return\`<td class="\${c} fm">\${f(v,1)}%</td>\`;}
  tb.innerHTML=hasMae.map(g=>{
    const mae=_maeData[g.key];const slRec=mae?.slReduction;
    return\`<tr class="\${tCls(g.sym||'')}">
      <td class="cb fw fm" style="font-size:11px">\${g.sym||'—'}</td>
      <td>\${tyBadge(sTypeName(g.sym||''))}</td>
      <td>\${sBadge(g.sess)}</td><td>\${dBadge(g.dir)}</td><td>\${vBadge(g.vwap)}</td>
      <td class="\${g.count>=5?'cy fw':'cc'} fm">\${g.count}</td>
      \${maePct(mae?.maeP50,40,65)}\${maePct(mae?.maeP75,50,75)}\${maePct(mae?.maeP90,50,80)}
      <td class="\${slRec?.color==='g'?'cg fw':slRec?.color==='y'?'cy':'cr'} fm">\${slRec?.label||'—'}</td>
      <td class="cc fm">\${slRec?.pct?((100-slRec.pct).toFixed(0))+'% smaller SL':'—'}</td>
    </tr>\`;
  }).join('');
  setDot('sl-dot',true);
}

/* ══ EV OPTIMIZER ══════════════════════════════════════════════ */
async function loadEV() {
  const [trD,tpD]=await Promise.all([api('/trades?limit=10000'),api('/tp-locks')]);
  if(!trD){setDot('ev-dot',false);return;}
  _allTrades=trD.trades||[];
  _tpMap={};if(tpD)tpD.forEach(t=>{_tpMap[t.key]=t;});
  document.getElementById('k-tp').textContent=Object.values(_tpMap).filter(t=>(t.evAtLock??0)>0).length;
  _buildCombos();setDot('ev-dot',true);
  _loadEVRetry();
}
async function _loadEVRetry(n=0){
  const evD=await api('/ev');
  if(evD?.length>0){evD.forEach(e=>{_evMap[e.key]=e;});_buildCombos();setDot('ev-dot',true);return;}
  if(n<12)setTimeout(()=>_loadEVRetry(n+1),5000);else setDot('ev-dot',false);
}
function _buildCombos(){
  const combos=[];
  for(const sym of[...FOREX,...INDEX,...COMM,...STOCKS]){
    const type=sTypeName(sym);
    const sessions=type==='stock'?['ny']:['asia','london','ny'];
    for(const sess of sessions)for(const dir of['buy','sell'])for(const vwap of['above','below']){
      const key=sym+'_'+sess+'_'+dir+'_'+vwap;
      const trades=_allTrades.filter(t=>t.symbol===sym&&t.session===sess&&t.direction===dir&&t.vwapPosition===vwap&&t.closedAt!=null&&t.openedAt&&new Date(t.openedAt)>=COMPLIANCE);
      combos.push({sym,sess,dir,vwap,key,trades,totalPnl:trades.reduce((s,t)=>s+(t.realizedPnlEUR??t.currentPnL??0),0),type,ev:_evMap[key]??null,tp:_tpMap[key]??null});
    }
  }
  _evData=combos;renderEV();buildMatrix(combos);
}
function renderEV(){
  let d=[..._evData];
  if(evF.type!=='all')d=d.filter(c=>c.type===evF.type);
  if(evF.sess!=='all')d=d.filter(c=>c.sess===evF.sess);
  if(evF.dir!=='all')d=d.filter(c=>c.dir===evF.dir);
  if(evF.min==='1')d=d.filter(c=>(c.ev?.count??0)>=1);
  else if(evF.min==='5')d=d.filter(c=>(c.ev?.count??0)>=5);
  d.sort((a,z)=>{const ha=(a.ev?.count??0)>0,hz=(z.ev?.count??0)>0;if(ha!==hz)return ha?-1:1;return(z.ev?.bestEV??-999)-(a.ev?.bestEV??-999);});
  const withData=d.filter(c=>c.ev&&c.ev.count>0);
  const pnl=d.reduce((s,c)=>s+c.totalPnl,0);
  document.getElementById('ev-meta').textContent=d.length+' combos · '+withData.length+' with ghost data';
  document.getElementById('ev-cnt').textContent=d.length;
  document.getElementById('ev-data').textContent=withData.length;
  document.getElementById('ev-lck').textContent=d.filter(c=>c.tp&&(c.ev?.bestEV??0)>0).length;
  const pe=document.getElementById('ev-pnl');pe.textContent=eu(pnl);pe.className='ss-val '+pC(pnl);
  const tb=document.getElementById('ev-body');
  if(!d.length){tb.innerHTML=emptyRow(15,'No combos match current filters');return;}
  tb.innerHTML=d.map(c=>{
    const ev=c.ev;const tp=c.tp;const evV=ev?.bestEV??null;const gN=ev?.count??0;const ready=gN>=5;
    const bestTP=tp?tp.lockedRR:(ev?.bestRR??null);
    const rs=gN===0&&c.trades.length===0?' style="opacity:.35"':'';
    const evCls=evV==null?'cd':evV>0?'ev-pos':'ev-neg';
    return\`<tr class="\${tCls(c.sym)}"\${rs}>
      <td data-val="\${c.sym}" class="cb fw fm" style="font-size:11px">\${c.sym}</td>
      <td>\${tyBadge(c.type)}</td>
      <td>\${sBadge(c.sess)}</td><td>\${dBadge(c.dir)}</td><td>\${vBadge(c.vwap)}</td>
      <td data-val="\${gN}" class="\${ready?'cy fw':gN>0?'cc':'cd'} fm">\${gN===0?'<span class="cd">0</span>':gN+(ready?'':' <span class="cd" style="font-size:8px">('+(5-gN)+'→5)</span>')}</td>
      <td data-val="\${c.trades.length}" class="\${c.trades.length>0?'cb':'cd'} fm">\${c.trades.length}</td>
      <td data-val="\${bestTP??-99}" class="\${bestTP?'cg fw':'cd'} fm">\${bestTP!=null?f(bestTP,1)+'R':'—'}</td>
      <td data-val="\${ev?.avgRR??-99}" class="\${(ev?.avgRR??0)>=1?'cg':'cd'} fm">\${ev?.avgRR!=null?f(ev.avgRR,2)+'R':'—'}</td>
      <td data-val="\${evV??-999}" class="\${evCls} fm">\${evV!=null?evV.toFixed(3):'—'}</td>
      <td>\${ready?(evV!=null?(evV>0?'<span class="bd b-ev">EV+ ✓</span>':'<span class="bd b-sl">EV−</span>'):'<span class="bd" style="color:var(--ink3)">pending</span>'):gN>0?'<span class="cd" style="font-size:9px">need '+(5-gN)+' more</span>':'<span class="cd" style="font-size:9px">—</span>'}</td>
      <td>\${tp?\`<span class="bd b-lk">★ \${tp.lockedRR.toFixed(1)}R</span>\`:'<span class="cd">—</span>'}</td>
      <td data-val="\${ev?.avgTimeToSLMin??9999}" class="cd fm">\${ev?.avgTimeToSLMin!=null?ev.avgTimeToSLMin+'min':'—'}</td>
      <td data-val="\${ev?.avgMaxSlPct??-1}" class="\${ev?.avgMaxSlPct!=null?(ev.avgMaxSlPct<50?'cg':ev.avgMaxSlPct<80?'cy':'co'):'cd'} fm">\${ev?.avgMaxSlPct!=null?f(ev.avgMaxSlPct,1)+'%':'—'}</td>
      <td data-val="\${c.totalPnl}" class="\${pC(c.totalPnl)} fw fm">\${eu(c.totalPnl)}</td>
    </tr>\`;
  }).join('');
}
function setEVF(k,v,btn){evF[k]=v;btn.closest('.fbar').querySelectorAll('.fb').forEach(b=>{if(b.getAttribute('onclick')?.includes("'"+k+"'"))b.classList.remove('on');});btn.classList.add('on');renderEV();}

/* ── EV Matrix ─────────────────────────────────────────────── */
function buildMatrix(combos){
  const byKey={};combos.forEach(c=>{byKey[c.key]=c;});
  function make(syms,tid){
    const body=document.getElementById(tid);if(!body)return;
    body.innerHTML=syms.map(sym=>{
      const isSK=STOCKS.includes(sym);
      return'<tr>'+[\`<td class="mx-sym">\${sym}</td>\`,...[['buy','above'],['buy','below'],['sell','above'],['sell','below']].map(([dir,vwap])=>{
        const keys=isSK?[sym+'_ny_'+dir+'_'+vwap]:['asia','london','ny'].map(s=>sym+'_'+s+'_'+dir+'_'+vwap);
        const cs=keys.map(k=>byKey[k]).filter(Boolean);
        const n=cs.reduce((s,c)=>s+c.trades.length,0);
        if(!n)return'<td style="color:var(--ink4)">—</td>';
        const allEV=cs.map(c=>c.ev?.bestEV).filter(v=>v!=null);
        const evV=allEV.length?allEV.reduce((s,v)=>s+v,0)/allEV.length:null;
        const star=cs.some(c=>c.tp)?'★':'';
        const cls=evV==null?'cd':evV>0?'cg fw':'cr';
        return\`<td class="\${cls}" title="n=\${n} EV=\${evV!=null?evV.toFixed(3):'?'}">\${star}\${evV!=null?evV.toFixed(2):'?'}<br><span style="font-size:7px;color:var(--ink3)">n=\${n}</span></td>\`;
      })].join('')+'</tr>';
    }).join('');
  }
  make(FOREX,'mxb-fx');make([...INDEX,...COMM],'mxb-ix');make(STOCKS,'mxb-sk');
}

/* ══ SIGNALS ════════════════════════════════════════════════════ */
async function loadErrors(){
  const d=await api('/history');
  if(!d){setDot('sig-dot',false);document.getElementById('sig-meta').textContent='error';setTimeout(loadErrors,10000);return;}
  const ERR_TYPES=['REJECTED','SL_TP_SET_FAILED','LOT_CALC_FAILED','ORDER_NOT_CONFIRMED','VWAP_BAND_EXHAUSTED','SPREAD_GUARD_CLOSE','RR_VERIFY_FAILED','CURRENCY_BUDGET_EXHAUSTED','OUTSIDE_WINDOW'];
  const errs=(Array.isArray(d)?d:[]).filter(e=>ERR_TYPES.includes(e.type));
  const placed=(Array.isArray(d)?d:[]).filter(e=>e.type==='ORDER_PLACED');
  setDot('sig-dot',errs.length===0);
  document.getElementById('sig-meta').textContent=errs.length+' errors · '+placed.length+' placed (recent)';
  document.getElementById('nb-sig').textContent=errs.length;
  document.getElementById('sig-total').textContent=d.length||'—';
  document.getElementById('sig-placed').textContent=placed.length;
  document.getElementById('sig-blocked').textContent=errs.length;
  const conv=d.length>0?(placed.length/d.length*100).toFixed(1)+'%':'—';
  document.getElementById('sig-conv').textContent=conv;

  const tb=document.getElementById('whe-body');
  if(!errs.length){tb.innerHTML='<tr><td colspan="10" class="nd cg">✓ No webhook errors</td></tr>';return;}
  tb.innerHTML=errs.slice(0,80).map(e=>{
    const p=e.payload||{};const bp=p.vwapBandPct||e.vwapBandPct;
    return\`<tr>
      <td class="cd fm" style="font-size:9px">\${ts(e.ts)}</td>
      <td><span class="cr fw" style="font-size:9px">\${e.type}</span></td>
      <td class="cb fw">\${e.symbol||p.symbol||'—'}</td>
      <td>\${dBadge(e.direction||p.direction)}</td>
      <td>\${sBadge(e.session||p.session)}</td>
      <td>\${vBadge(e.vwapPos||p.vwapPosition)}</td>
      <td class="cd fm">\${e.entry?f(e.entry,5):'—'}</td>
      <td class="co fm">\${p.slPctHuman||p.derivedSlPct||'—'}</td>
      <td class="\${bp&&(+bp)>1.5?'cr':'cd'} fm">\${bp!=null?((+bp)*100).toFixed(0)+'%':'—'}</td>
      <td class="cd" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;font-size:9px">\${e.reason||p.reason||''}</td>
    </tr>\`;
  }).join('');

  // Placed signals
  const ptb=document.getElementById('placed-body');
  if(!placed.length){ptb.innerHTML='<tr><td colspan="10" class="nd">No placed signals in recent log</td></tr>';return;}
  ptb.innerHTML=placed.slice(0,50).map(e=>\`<tr>
    <td class="cd fm" style="font-size:9px">\${ts(e.ts)}</td>
    <td class="cb fw fm">\${e.symbol||'—'}</td>
    <td>\${dBadge(e.direction)}</td>
    <td>\${sBadge(e.session)}</td>
    <td>\${vBadge(e.vwapPos||e.vwapPosition)}</td>
    <td class="cd fm">\${e.executionPrice?f(e.executionPrice,5):'—'}</td>
    <td class="co fm">\${e.slPctHuman||e.derivedSlPct||'—'}</td>
    <td class="cy fm">\${e.tpRR?f(e.tpRR,2)+'R':'—'}</td>
    <td class="cd fm">\${e.latencyMs?e.latencyMs+'ms':'—'}</td>
    <td>\${e.isEvPlus?'<span class="bd b-ev">EV+</span>':'<span class="cd" style="font-size:9px">—</span>'}</td>
  </tr>\`).join('');
}

async function loadBlockedSignals(){
  const rejectD=await api('/signal-stats/rejects?since=2026-05-03T00:00:00.000Z');
  if(!rejectD)return;
  const byO={};(rejectD?.byOutcome||[]).forEach(r=>{byO[r.outcome]=r.pairs?.reduce((s,p)=>s+p.count,0)??0;});
  document.getElementById('blk-tot').textContent=rejectD.total||0;
  document.getElementById('blk-dup').textContent=((byO['DUPLICATE_OPEN']??0)+(byO['DUPLICATE_BLOCKED']??0)+(byO['DUPLICATE']??0));
  document.getElementById('blk-vw').textContent=((byO['VWAP_BAND_EXHAUSTED']??0)+(byO['VWAP_EXHAUSTED']??0));
  document.getElementById('blk-win').textContent=((byO['OUTSIDE_WINDOW']??0)+(byO['OUTSIDE_HOURS']??0));
  document.getElementById('blk-cur').textContent=((byO['CURRENCY_BUDGET']??0)+(byO['BUDGET_EXHAUSTED']??0));
  document.getElementById('blk-ny').textContent=((byO['NY_DEAD_ZONE']??0));
  const tb=document.getElementById('blk-body');
  const allP=rejectD?.topPairs||[];
  if(!allP.length){tb.innerHTML=emptyRow(7,'No blocked signals after compliance date');return;}
  tb.innerHTML=allP.slice(0,50).map(p=>\`<tr>
    <td><span class="bd b-block" style="font-size:8px">BLOCKED</span></td>
    <td style="color:var(--o);font-size:9px;font-family:var(--fi)">\${p.outcome}</td>
    <td class="cb fw fm">\${p.symbol||'?'}</td>
    <td>\${p.direction?dBadge(p.direction):'—'}</td>
    <td>\${p.session?sBadge(p.session):'—'}</td>
    <td>\${p.vwapPosition?vBadge(p.vwapPosition):'—'}</td>
    <td class="cr fw fm">\${p.count}</td>
  </tr>\`).join('');
}

async function loadBand(tier,prefix){
  const d=await api(\`/band-ghost-stats?tier=\${tier}\`);
  const rows=d?.rows||[];
  const tb=document.getElementById(prefix+'-body');
  const strip=document.getElementById(prefix+'-strip');
  if(!rows.length){tb.innerHTML=emptyRow(9,'No ghost data for this band');if(strip)strip.style.display='none';return;}
  const avgRR=rows.filter(r=>r.avgMaxRR!=null).reduce((s,r,_,a)=>s+(+r.avgMaxRR)/a.length,0);
  const avgSL=rows.filter(r=>r.avgSlPct!=null).reduce((s,r,_,a)=>s+(+r.avgSlPct)/a.length,0);
  if(strip)strip.style.display='flex';
  document.getElementById(prefix+'-n').textContent=rows.reduce((s,r)=>s+(+r.n||0),0);
  document.getElementById(prefix+'-rr').textContent=avgRR?f(avgRR,2)+'R':'—';
  document.getElementById(prefix+'-sl').textContent=avgSL?f(avgSL,1)+'%':'—';
  tb.innerHTML=rows.map(r=>\`<tr class="\${tCls(r.symbol||'')}">
    <td class="cb fw fm">\${r.symbol||'—'}</td><td>\${sBadge(r.session)}</td>
    <td>\${dBadge(r.direction)}</td><td>\${vBadge(r.vwapPosition)}</td>
    <td class="\${(+r.n||0)>=5?'cy fw':'cc'} fm">\${r.n||0}</td>
    <td class="\${(+r.avgMaxRR||0)>=2?'cg fw':(+r.avgMaxRR||0)>=1?'cy':'cd'} fm">\${r.avgMaxRR!=null?f(r.avgMaxRR,2)+'R':'—'}</td>
    <td class="cg fm">\${r.maxMaxRR!=null?f(r.maxMaxRR,2)+'R':'—'}</td>
    <td class="\${(+r.avgSlPct||0)<50?'cg':(+r.avgSlPct||0)<80?'cy':'co'} fm">\${r.avgSlPct!=null?f(r.avgSlPct,1)+'%':'—'}</td>
    <td class="cd fm">\${r.avgTimeMin!=null?r.avgTimeMin+'min':'—'}</td>
  </tr>\`).join('');
}

async function loadMAE(){
  const d=await api('/mae-stats');if(!d?.rows)return;
  _maeData={};for(const r of d.rows)_maeData[r.optimizerKey]=r;
}

/* ══ DEPLOY ════════════════════════════════════════════════════ */
async function prepareDeploy(){
  const sEl=document.getElementById('nav-right');const btn=document.getElementById('dbtn');
  const st=await api('/admin/deploy-status');
  if(!st){sEl.textContent='Error checking status';return;}
  if(st.safeToDeployNow){sEl.textContent='✓ Safe to deploy';return;}
  if(!confirm('DEPLOY\\n\\n'+st.recommendation+'\\n\\nContinue?'))return;
  btn.disabled=true;sEl.textContent='Closing positions...';
  const sec=prompt('WEBHOOK_SECRET:');if(!sec){btn.disabled=false;return;}
  const r1=await fetch(\`/admin/close-all-positions?secret=\${encodeURIComponent(sec)}\`,{method:'POST'});
  const d1=await r1.json().catch(()=>({}));
  if(d1.status!=='OK'){sEl.textContent='Error: '+(d1.error||'?');btn.disabled=false;return;}
  const r2=await fetch(\`/admin/finalize-all-ghosts?secret=\${encodeURIComponent(sec)}\`,{method:'POST'});
  const d2=await r2.json().catch(()=>({}));
  sEl.textContent=\`✓ READY — \${d1.closed} positions, \${d2.finalized} ghosts\`;
  btn.style.color='var(--g)';await loadAll();
}

/* ══ LOAD ALL ══════════════════════════════════════════════════ */
async function loadAll(){
  const t0=Date.now(); _lastLoad=t0;
  const ns=document.getElementById('nav-right');
  if(ns)ns.textContent='Loading...';
  await Promise.allSettled([
    loadTradeStats().catch(()=>{}),
    loadPositions().catch(()=>{}),
    loadGhosts().catch(()=>{}),
    loadEV().catch(()=>{}),
    loadErrors().catch(()=>{}),
    loadBlockedSignals().catch(()=>{}),
    loadMAE().catch(()=>{}),
    loadDailyBreakdown().catch(()=>{}),
    (_histLoaded?loadGhostHistory():Promise.resolve()).catch(()=>{}),
    (_histLoaded?loadGhostHistoryGrouped():Promise.resolve()).catch(()=>{}),
    (_evslLoaded?loadEVSL():Promise.resolve()).catch(()=>{}),
    (_blkRawLoaded?loadBlockedRaw():Promise.resolve()).catch(()=>{}),
  ]);
  const ms=Date.now()-t0;
  if(ns)ns.textContent='Updated: '+new Date().toLocaleTimeString('nl-BE',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+' ('+ms+'ms)';
}

/* ══ INIT ══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', ()=>{
  initAll();
  loadAll();
  setInterval(loadAll, 30000);
});
</script>
</body>
</html>`);
});








// ── /api/summary — volledig leesbare snapshot voor Claude/AI ────
// Geeft ALLES: balance, open trades, ghosts, closed trades,
// EV/optimizer data, tpLocks, keyRiskMult, signaallog, config.
app.get("/api/summary", async (req, res) => {
  try {
    // ── Open posities ────────────────────────────────────────────
    const positions = Object.values(openPositions).map(p => {
      const info    = getSymbolInfo(p.symbol);
      const type    = info?.type || "stock";
      const mt5Sym  = info?.mt5 || p.mt5Symbol || p.symbol;
      const cached  = symbolSpecCache[mt5Sym];
      const lotVal  = cached?.lotVal ?? LOT_VALUE[type] ?? 1;
      const slDist  = p.sl > 0 ? Math.abs(p.entry - p.sl) : 0;
      const actualRiskEUR = slDist > 0 ? parseFloat((p.lots * slDist * lotVal).toFixed(2)) : null;
      const actualRiskPct = actualRiskEUR && liveBalance > 0
        ? parseFloat((actualRiskEUR / liveBalance * 100).toFixed(4)) : null;
      const slDistPct = p.sl && p.entry
        ? parseFloat((Math.abs(p.entry - p.sl) / p.entry * 100).toFixed(3)) : null;
      const tpRRActual = p.tp && p.sl && p.entry && slDist > 0
        ? parseFloat((Math.abs(p.tp - p.entry) / slDist).toFixed(3)) : null;
      return {
        positionId: p.positionId, symbol: p.symbol, type,
        direction: p.direction, session: p.session,
        vwapPosition: p.vwapPosition, optimizerKey: p.optimizerKey,
        entry: p.entry, sl: p.sl, tp: p.tp, lots: p.lots,
        riskPct: p.riskPct, riskEUR: p.riskEUR,
        actualRiskEUR, actualRiskPct, slDistPct, tpRRActual,
        evMult: p.evMult ?? 1.0, dayMult: p.dayMult ?? 1.0,
        currentPrice: p.currentPrice, currentPnL: p.currentPnL,
        maxRR: p.maxRR, tpRR: p.tpRRUsed, isEvPlus: p.isEvPlus ?? false,
        spread: p.spread ?? 0, scaleFactor: p.scaleFactor ?? 1.0,
        slMilestones: p.slMilestones ?? null,
        isGhosted: !!ghostTrackers[p.positionId],
        openedAt: p.openedAt, balance: p.balance,
      };
    });

    // ── Actieve ghosts ───────────────────────────────────────────
    const ghosts = Object.values(ghostTrackers).map(g => ({
      positionId: g.positionId, symbol: g.symbol,
      direction: g.direction, session: g.session,
      vwapPosition: g.vwapPosition, optimizerKey: g.optimizerKey,
      entry: g.entry, sl: g.sl, tp: g.tp,
      maxRR: g.maxRR, currentPrice: g.currentPrice,
      slMilestones: g.slMilestones ?? null,
      openedAt: g.openedAt,
    }));

    // ── Closed trades (laatste 200) ──────────────────────────────
    const recentClosed = closedTrades.slice(-200).reverse().map(t => ({
      positionId: t.positionId, symbol: t.symbol,
      direction: t.direction, session: t.session,
      vwapPosition: t.vwapPosition, optimizerKey: t.optimizerKey,
      entry: t.entry, sl: t.sl, tp: t.tp, lots: t.lots,
      closeReason: t.closeReason, closedAt: t.closedAt,
      openedAt: t.openedAt, realizedPnL: t.realizedPnL,
      riskPct: t.riskPct, riskEUR: t.riskEUR,
      maxRR: t.maxRR, tpRR: t.tpRRUsed,
      isEvPlus: t.isEvPlus ?? false,
    }));

    // ── TP Locks ─────────────────────────────────────────────────
    const tpLocksData = Object.entries(tpLocks).map(([key, v]) => ({
      optimizerKey: key, ...v
    }));

    // ── Key Risk Multipliers ──────────────────────────────────────
    const riskMultData = Object.entries(keyRiskMult).map(([key, v]) => ({
      optimizerKey: key, ...v
    })).sort((a, b) => (b.evMult ?? 1) - (a.evMult ?? 1));

    // ── Currency exposure ─────────────────────────────────────────
    const exposureData = Object.entries(currencyExposure).map(([cur, v]) => ({
      currency: cur, ...v
    }));

    // ── EV optimizer data (cached) ────────────────────────────────
    const evData = evCache.data ?? [];

    // ── Webhook log (laatste 50) ──────────────────────────────────
    const recentWebhooks = webhookLog.slice(0, 50);

    // ── Band ghosts ───────────────────────────────────────────────
    const bandGhosts = Object.values(bandGhostTrackers ?? {}).map(g => ({
      symbol: g.symbol, direction: g.direction, session: g.session,
      vwapPosition: g.vwapPosition, bandPct: g.bandPct,
      maxRR: g.maxRR, openedAt: g.openedAt,
    }));

    // ── Config snapshot ───────────────────────────────────────────
    const config = {
      fixedRiskPct:      FIXED_RISK_PCT,
      currencyBudgetPct: CURRENCY_BUDGET_PCT,
      minTpRrFloor:      MIN_TP_RR_FLOOR,
      slBufferMult:      SL_BUFFER_MULT,
      ghostPollMs:       GHOST_POLL_MS,
      ghostMaxMs:        GHOST_MAX_MS,
      ghostMaxRR:        GHOST_MAX_RR,
      ghostMinTradesForTp: GHOST_MIN_TRADES_FOR_TP,
      maxClosedTrades:   MAX_CLOSED_TRADES,
    };

    res.json({
      timestamp:          new Date().toISOString(),
      balance:            liveBalance,
      openTradesCount:    positions.length,
      activeGhostsCount:  ghosts.length,
      bandGhostsCount:    bandGhosts.length,
      totalClosedTrades:  closedTrades.length,
      tpLocksCount:       tpLocksData.length,
      config,
      positions,
      ghosts,
      bandGhosts,
      tpLocks:            tpLocksData,
      keyRiskMultipliers: riskMultData,
      currencyExposure:   exposureData,
      recentClosed,
      evOptimizer:        evData,
      recentWebhooks,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Compliance date endpoint ──────────────────────────────────────
// GET  /compliance-date  → huidige datum + default
// POST /compliance-date  → { date: "2026-05-03" } of ISO string
// Geldt direct voor: EV stats, ghost data, shadow snapshots, signals, history
app.get("/compliance-date", async (req, res) => {
  res.json({
    complianceDate: currentComplianceDate,
    default:        COMPLIANCE_DATE,
    note:           "Trades/ghosts/EV/signals vóór deze datum worden genegeerd in alle stats",
  });
});

app.post("/compliance-date", async (req, res) => {
  // Beveiligd: alleen WEBHOOK_SECRET mag de compliance datum wijzigen.
  const secret = req.query.secret || req.body?.secret;
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized — geef ?secret= mee (zelfde als webhook secret)" });
  }
  try {
    const raw = req.body?.date;
    if (!raw) return res.status(400).json({ error: "Geef { date: 'YYYY-MM-DD' } of ISO string mee" });
    const parsed = new Date(raw);
    if (isNaN(parsed.getTime())) return res.status(400).json({ error: `Ongeldige datum: ${raw}` });
    // Sla op als "YYYY-MM-DD HH:MM:SS" formaat (consistent met bestaande queries)
    const isoStr = parsed.toISOString().slice(0, 19).replace("T", " ");
    setComplianceDateLive(isoStr);
    currentComplianceDate = isoStr;
    await saveComplianceDate(isoStr);
    console.log(`[ComplianceDate] Bijgewerkt via API → ${isoStr}`);
    logEvent({ type: "COMPLIANCE_DATE_UPDATED", date: isoStr });
    res.json({ ok: true, complianceDate: isoStr, message: `Alle stats gefilterd vanaf ${isoStr}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: "Route not found", route: `${req.method} ${req.originalUrl}` }));

// ── Startup ───────────────────────────────────────────────────────
async function start() {
  const missing = ["META_API_TOKEN", "META_ACCOUNT_ID", "WEBHOOK_SECRET"].filter(k => !process.env[k]);
  if (missing.length) { console.error(`[ERR] Missing env: ${missing.join(", ")}`); process.exit(1); }

  console.log("🚀 PRONTO-AI v12.6.0 starting...");
  await initDB();

  // v12.5.1: sync trade_number sequence met huidige DB waarde
  await syncTradeNumberSequence().catch(e => console.warn('[TradeNum] sync:', e.message));
  console.log('[TradeNum] Trade number sequence synced');

  // Laad compliance date uit DB — overschrijft hardcoded default als eerder ingesteld via /compliance-date
  const savedComplianceDate = await loadComplianceDate();
  if (savedComplianceDate) {
    currentComplianceDate = savedComplianceDate;
    setComplianceDateLive(savedComplianceDate);
    console.log(`📅 Compliance date (DB): ${savedComplianceDate}`);
  } else {
    console.log(`📅 Compliance date (default): ${COMPLIANCE_DATE}`);
  }

  // Load closed trades
  const trades = await loadAllTrades();
  closedTrades.push(...trades);
  console.log(`📂 ${trades.length} closed trades loaded`);

  // Load TP locks
  const savedTP = await loadTPConfig();
  Object.assign(tpLocks, savedTP);
  console.log(`🔒 ${Object.keys(tpLocks).length} TP locks loaded`);

  // FIX 12: Load ALL shadow analyses at startup
  const shadowRows = await loadAllShadowAnalysis();
  for (const row of shadowRows) shadowResults[row.optimizerKey] = row;
  console.log(`🌑 ${shadowRows.length} shadow analyses loaded`);

  // FIX 19: Load key risk multipliers from DB
  const dbKeyMults = await loadKeyRiskMults();
  Object.assign(keyRiskMult, dbKeyMults);
  console.log(`📈 ${Object.keys(keyRiskMult).length} key risk multipliers loaded from DB`);

  // Load symbol risk overrides from DB + env
  const dbRisk = await loadSymbolRiskConfig();
  Object.assign(symbolRiskMap, dbRisk);
  for (const sym of Object.keys(SYMBOL_CATALOG)) {
    const envKey = `RISK_${sym}`;
    if (process.env[envKey]) {
      const pct = parseFloat(process.env[envKey]);
      symbolRiskMap[sym] = pct;
      await upsertSymbolRisk(sym, pct);
    }
  }
  console.log(`💰 Symbol risk overrides: ${Object.keys(symbolRiskMap).length}`);

  try {
    await fetchAccountInfo();
    console.log(`💵 Live MT5 balance: €${liveBalance.toFixed(2)}`);
  } catch (e) { console.warn(`[!] Could not fetch live balance: ${e.message}`); }

  const dr = await loadLatestDailyRisk();
  if (dr) console.log(`📊 Last daily risk record: ${dr.tradeDate}`);

  await restorePositionsFromMT5();

  // STARTUP: prefetch MT5 symbol specs voor alle catalog symbolen
  // Zo is de lotVal cache gevuld voor de eerste trade - geen fallback meer.
  console.log("Prefetching MT5 symbol specs...");
  const prefetchResults = { ok: 0, fallback: 0 };
  await Promise.allSettled(
    Object.entries(SYMBOL_CATALOG).map(async ([sym, info]) => {
      try {
        const spec = await fetchSymbolLotValue(info.mt5, info.type);
        if (spec.source === "mt5") prefetchResults.ok++;
        else prefetchResults.fallback++;
        console.log(`[SymSpec] ${sym} (${info.mt5}): lotVal=${spec.lotVal} source=${spec.source}`);
      } catch (e) {
        prefetchResults.fallback++;
        console.warn(`[SymSpec] ${sym}: prefetch failed - ${e.message}`);
      }
    })
  );
  console.log(`[SymSpec] Done: ${prefetchResults.ok} live van MT5, ${prefetchResults.fallback} fallback`);

  // FIX C: rebuild currency exposure na restore van open posities
  rebuildCurrencyExposure();
  console.log(`💱 Currency exposure rebuilt: ${JSON.stringify(Object.fromEntries(Object.entries(currencyExposure).map(([k,v])=>[k,v.toFixed(2)])))}`);

  // Pre-build EV cache in background — don't block server start
  console.log("[EV Cache] Starting background build...");
  rebuildEVCache().catch(() => {});

  app.listen(PORT, () => {
    console.log(`[✓] PRONTO-AI v12.6.0 on port ${PORT}`);
    console.log(`   🔹 Dashboard:      /`);
    console.log(`   🔹 Health:         /health`);
    console.log(`   🔹 EV Table:       /ev`);
    console.log(`   🔹 Shadow SL:      /shadow`);
    console.log(`   🔹 TP Locks:       /tp-locks`);
    console.log(`   🔹 Risk Config:    /risk-config`);
    console.log(`   🔹 Risk Mults:     /risk-multipliers`);
    console.log(`   🔹 Signal Stats:   /signal-stats`);
    console.log(`   🔹 Rejects:        /signal-stats/rejects`);
    console.log(`   🔹 Spread Stats:   /spread-stats?symbol=EURUSD&session=london`);
    console.log(`   🔹 Spread Log:     /spread-log?symbol=EURUSD&limit=200`);
    console.log(`   🔹 Compliance:     GET/POST /compliance-date`);
    console.log(`   🔹 Webhook:        POST /webhook?secret=<secret>`);
    console.log(`   💵 Fixed risk:     ${(FIXED_RISK_PCT*100).toFixed(3)}% | Balance: €${liveBalance.toFixed(2)}`);
    console.log(`   🌍 MetaApi regio:  ${META_REGION} (wijzig via META_API_REGION env als 504 errors)`);
    console.log(`   💰 Curr budget:    ${(CURRENCY_BUDGET_PCT*100).toFixed(1)}% per valuta | TP floor: ${MIN_TP_RR_FLOOR}R`);
    console.log(`   🕐 Ghost max:      ${GHOST_MAX_MS / (24*3600*1000)}d | SL buffer: ×${SL_BUFFER_MULT} | Stock SL buffer: ×${STOCK_SL_BUFFER_MULT}`);
    console.log(`   📊 Mult threshold: ${MULT_MIN_SAMPLE} ghost samples`);
    console.log(`   📅 Compliance:     ${currentComplianceDate} (POST /compliance-date om te wijzigen)`);
  });
}

start().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });
