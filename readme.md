# PRONTO-AI — nv-tradingview-webhook

**TradingView → MetaApi REST → FTMO MT5**  
Versie **4.3** — April 2026  
Auteur: Nick Verschoot — [nick@pronto-ai.be](mailto:nick@pronto-ai.be)

> ⚠️ **VERTROUWELIJK** — Privé project, niet voor distributie.

---

## Inhoudsopgave

1. [Projectoverzicht](#1-projectoverzicht)
2. [Systeemarchitectuur](#2-systeemarchitectuur)
3. [Database Structuur](#3-database-structuur)
4. [Risicobeheer & Parameters](#4-risicobeheer--parameters)
5. [Environment Variabelen](#5-environment-variabelen)
6. [API Endpoints](#6-api-endpoints)
7. [Deployment & Infrastructure](#7-deployment--infrastructure)
8. [Projectstructuur](#8-projectstructuur)
9. [Versiegeschiedenis](#9-versiegeschiedenis)
10. [Roadmap](#10-roadmap)
11. [Bekende Issues](#11-bekende-issues)
12. [Snelstartgids — Checklist](#12-snelstartgids--checklist)

---

## 1. Projectoverzicht

Volledig geautomatiseerde trading-infrastructuur. Ontvangt TradingView-alertsignalen via webhooks, berekent automatisch de juiste positiegrootte op basis van risicobeheer per instrumenttype, en voert orders uit op een FTMO MT5-account via de MetaApi REST API.

### Wat doet het systeem?

- Ontvangen van TradingView webhook-signalen (`BUY` / `SELL` / `CLOSE`)
- Automatische lot-berekening gebaseerd op ingesteld risico per instrumenttype
- **Spread guard**: blokkeert trades bij te hoge spread (max 1/3 van SL-afstand)
- **Forex anti-consolidatie**: half risk bij 1–2 open posities zelfde pair+richting, blok bij 3+
- **Ghost tracker**: volgt maximum koersbeweging na sluiting voor statistische analyse
- **TP/SL lock engine**: optimaliseert automatisch take-profit en stop-loss niveaus op basis van historische EV
- Persistente PostgreSQL-database op Railway voor alle trade-data en configuratie
- Live dashboard op Railway met real-time positiebeheer en analyse-endpoints
- **Restart recovery** (v4.3): open posities worden automatisch hersteld na Railway herstart

### Kerngegevens

| | |
|---|---|
| **Versie** | v4.3 (april 2026) |
| **Broker / Account** | FTMO Demo (→ Live) |
| **Platform** | MT5 via MetaApi REST API |
| **Deployment** | Railway.app |
| **Database** | PostgreSQL (Railway plugin) |
| **Taal** | Node.js 18+ (JavaScript ES6+) |
| **Licentie** | UNLICENSED / Privé |
| **Live URL** | https://tradingftmo-demo-live-production-8b1e.up.railway.app |

---

## 2. Systeemarchitectuur

### Stap 1 — TradingView stuurt een Alert

TradingView voert een Pine Script-alert uit en stuurt een JSON-payload via HTTP POST naar `/webhook`.

```json
{
  "secret": "FtmoNV2025",
  "symbol": "NAS100USD",
  "action": "BUY",
  "entry": 18250.5,
  "sl": 18100.0,
  "tp": 18550.0,
  "timeframe": "1h"
}
```

### Stap 2 — Server ontvangt & valideert het signaal

- `POST /webhook` ontvangen door Express.js server op Railway
- Secret-sleutel gecontroleerd (`WEBHOOK_SECRET` env var)
- Symbol opgezocht in `SYMBOL_MAP` (TV-naam → MT5-naam + instrument type)
- Marktvenster gecheckt via `session.js` (Brussels tijdzone, automatisch CET/CEST)
  - Stocks: alleen 15:30–20:00
  - Indices: ook Asia 02:00–08:00
  - Crypto: ook weekend

### Stap 3 — Risicocalculatie

- Risico in EUR bepaald op basis van instrument type (index: €200, forex: €15, gold: €30, enz.)
- SL-afstand berekend: `|entry - sl|`
- Spread opgehaald via MetaApi en gecontroleerd: max **1/3 van SL-afstand** (v4.3)
- `Lot-grootte = risico EUR / (SL afstand × pip waarde per lot)`
- Forex anti-consolidatie: zelfde pair + richting al open? → 50% risk of volledig geblokkeerd
- Min lot cap: `baseRisk` per type — v4.3 fix (was vaste €60, nu dynamisch per instrumenttype)

### Stap 4 — Order naar MetaApi

- MetaApi REST API call: `POST /users/current/accounts/{accountId}/trade`
- Order type: `ORDER_TYPE_BUY` of `ORDER_TYPE_SELL` met lot, SL en TP
- Positie opgeslagen in `openPositions{}` (in-memory) én PostgreSQL (bij sluiting)
- Ghost tracker gestart: volgt koersbeweging na opening in achtergrond

### Stap 5 — Ghost Tracker (post-trade monitoring)

- Na sluiting van een trade: ghost tracker blijft **24 uur** actief
- Jonger dan 6 uur gesloten → controle elke **60 seconden** (prioriteit batching)
- Ouder dan 6 uur gesloten → controle elke **5 minuten** (efficiëntie)
- Registreert `trueMaxRR`: de maximale koersbeweging na sluiting
- Leert het systeem of de TP te vroeg of te laat was ingesteld

### Stap 6 — TP/SL Lock Engine (automatische optimalisatie)

- Na **10+ trades** per symbool per sessie berekent de engine het beste RR-niveau
- EV (Expected Value) berekend voor elk RR-niveau: `0.2R, 0.4R, 0.6R ... 25R`
- RR-niveau met de hoogste EV wordt automatisch als TP-lock ingesteld en opgeslagen
- SL-optimizer adviseert of SL groter of kleiner moet op basis van historische data
- Alle wijzigingen gelogd in `tp_update_log` en `sl_update_log` (PostgreSQL)

### Stap 7 — Restart Recovery (v4.3 kritieke fix)

Na een Railway-herstart worden alle openstaande posities automatisch hersteld via MetaApi. Weesposities (open op MT5 maar niet in server-memory) worden gedetecteerd en opnieuw geregistreerd in `openPositions{}`.

---

## 3. Database Structuur

Database wordt automatisch aangemaakt bij eerste opstart via `initDB()`. Alle `ALTER TABLE` statements zijn idempotent voor veilige herstarts.

| Tabel | Doel |
|---|---|
| `closed_trades` | Alle gesloten trades: entry, SL, TP, lots, riskEUR, ghost data, sessie, spread guard, SL multiplier |
| `tp_config` | TP lock per symbool per sessie — geoptimaliseerd RR-niveau met EV en historiek |
| `tp_update_log` | Volledige historiek van alle TP wijzigingen met reden en timestamp |
| `sl_config` | SL multiplier advies per symbool (0.5× t/m 3.0×) met richting (up/down/unchanged) |
| `sl_update_log` | Historiek van alle SL aanpassingen |
| `forex_consolidation_log` | Log van geblokkeerde of half-risk forex trades bij consolidatie |
| `equity_snapshots` | Account balance en equity elke 5 minuten voor equity curve analyse |

---

## 4. Risicobeheer & Parameters

### 4.1 Risico per Instrumenttype

| Type | Std. risico | Env variabele | TP lock cap (×4) |
|---|---|---|---|
| index | €200 | `RISK_INDEX` | €800 |
| forex | €15 | `RISK_FOREX` | €60 |
| gold | €30 | `RISK_GOLD` | €120 |
| brent | €30 | `RISK_BRENT` | €120 |
| wti | €30 | `RISK_WTI` | €120 |
| crypto | €30 | `RISK_CRYPTO` | €120 |
| stock | €30 | `RISK_STOCK` | €120 |

### 4.2 Handelssessies (Brussels Tijdzone — automatisch CET/CEST)

| Sessie | Venster | Toegestane instrumenten |
|---|---|---|
| Asia | 02:00 – 08:00 | Forex, Indices, Gold, Crypto, Olie |
| London | 08:00 – 15:30 | Forex, Indices, Gold, Crypto, Olie |
| New York | 15:30 – 20:00 | Alles inclusief Stocks |
| Buiten venster | 20:00 – 02:00 | Volledig geblokkeerd (crypto weekend uitzondering) |
| Weekend | Zat / Zon | Alleen crypto 02:00–20:00 |

### 4.3 Forex Anti-Consolidatie (v4.3)

- **0 open** trades zelfde pair + richting → normaal risico (€15)
- **1–2 open** trades zelfde pair + richting → **50% risico** (€7,50) — `forexHalfRisk` flag
- **3+ open** trades zelfde pair + richting → trade **VOLLEDIG GEBLOKKEERD**
- Alle events gelogd in `forex_consolidation_log`

### 4.4 Spread Guard

- Spread real-time opgehaald via MetaApi `symbolSpecification`
- Maximum spread = **1/3 van de SL-afstand** in pips (aangescherpt in v4.3, was 1/2)
- Bij overschrijding: trade geblokkeerd, `spreadGuard=true` gelogd in database

### 4.5 RR Niveaus & SL Multiples

```js
RR_LEVELS    = [0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25]
SL_MULTIPLES = [0.5, 0.6, 0.75, 0.85, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0]
```

---

## 5. Environment Variabelen

Instellen via **Railway → Settings → Variables**. Nooit hard-coden in broncode.

| Variabele | Voorbeeld | Beschrijving |
|---|---|---|
| `META_API_TOKEN` | `7cb566c1-...` | MetaApi API token (MetaApi dashboard → API tokens) |
| `META_ACCOUNT_ID` | `abc123def456` | MetaApi account ID van het FTMO MT5 account |
| `WEBHOOK_SECRET` | `MijnGeheimWW2026` | Beveiligingssleutel — elke webhook moet dit bevatten |
| `ACCOUNT_BALANCE` | `10000` | Account grootte in EUR |
| `DATABASE_URL` | *(auto Railway)* | PostgreSQL connectie URL — automatisch gezet door Railway |
| `RISK_INDEX` | `200` | Risico per indextrade in EUR |
| `RISK_FOREX` | `15` | Risico per forextrade in EUR |
| `RISK_GOLD` | `30` | Risico per goud-trade in EUR |
| `RISK_BRENT` | `30` | Risico per Brent-olie trade in EUR |
| `RISK_WTI` | `30` | Risico per WTI-olie trade in EUR |
| `RISK_CRYPTO` | `30` | Risico per crypto-trade in EUR |
| `RISK_STOCK` | `30` | Risico per aandelen-trade in EUR |
| `PORT` | `3000` | Server poort — Railway stelt dit automatisch in |

> ⚠️ De fallback `WEBHOOK_SECRET = "FtmoNV2025"` staat hardcoded in `server.js`. Op productie **altijd** de env var gebruiken en de fallback verwijderen.

---

## 6. API Endpoints

### Webhook & Kern

| Endpoint | Methode | Beschrijving |
|---|---|---|
| `/webhook` | `POST` | Ontvang TradingView signaal — BUY / SELL / CLOSE |
| `/webhook/close-all` | `POST` | Sluit alle open posities onmiddellijk via MetaApi |
| `/dashboard` | `GET` | Live overzicht: open posities, stats, actieve fixes |
| `/health` | `GET` | Server gezondheidscheck — retourneert 200 OK |
| `/history` | `GET` | Laatste 200 webhook-events met tijdstempel en resultaat |

### Analyse & Research

| Endpoint | Beschrijving |
|---|---|
| `GET /research/tp-optimizer` | Beste TP per symbool per sessie op basis van historische EV — min. 5 trades |
| `GET /research/sl-optimizer` | SL-multiplier advies: kleiner / groter / optimaal — min. 5 trades |
| `GET /analysis/equity-curve` | Equity curve laatste N uur (`?hours=24`) — uit DB of memory |
| `GET /analysis/ghost-pending` | Alle trades zonder `trueMaxRR` ghost-data |
| `GET /tp-locks` | Actieve TP locks per symbool per sessie met EV en timestamp |
| `GET /sl-locks` | Actieve SL analyses met multiplier, richting en EV bij lock |
| `DELETE /tp-locks/:symbol` | Verwijder alle TP locks voor een symbool |
| `DELETE /tp-locks/:symbol/:session` | Verwijder TP lock voor één symbool + sessie combinatie |
| `DELETE /sl-locks/:symbol` | Verwijder SL analyse voor een symbool |

---

## 7. Deployment & Infrastructure

### Railway.app Setup

1. Ga naar [railway.app](https://railway.app) en log in met je GitHub account
2. Klik **New Project** → **Deploy from GitHub repo** → selecteer je repository
3. Voeg PostgreSQL toe: klik **+ New** → **Database** → **Add PostgreSQL**
4. `DATABASE_URL` wordt automatisch beschikbaar als environment variabele
5. Ga naar **Settings → Variables** en voeg alle env vars toe (zie Sectie 5)
6. Railway detecteert automatisch `node server.js` als start-commando via `package.json`
7. Eerste deploy start automatisch — database schema aangemaakt via `initDB()`
8. Bij elke push naar `main`: automatische redeploy zonder downtime

### TradingView Alert Instellen

1. Open TradingView en navigeer naar je indicator of strategie
2. Klik op het klok-icoon rechtsboven (**Create Alert**) of gebruik `Alt+A`
3. Stel de alert-conditie in (bijv. crossover, RSI level, MACD signaal)
4. Selecteer **Webhook URL** als notificatiemethode onder Notifications
5. Vul jouw Railway URL in: `https://[jouw-app].up.railway.app/webhook`
6. Plak de JSON payload in het **Message** veld (zie Sectie 2, Stap 1)
7. Activeer de alert — het systeem is nu volledig live

---

## 8. Projectstructuur

```
nv-tradingview-webhook/
├── server.js      ← Hoofdserver: webhook ontvangst, order executie, TP/SL engines
├── db.js          ← PostgreSQL persistence layer: alle CRUD operaties
├── session.js     ← Tijdzone & sessie helpers (Brussels, automatisch CET/CEST)
├── package.json   ← Dependencies: express, node-cron, pg | Scripts: start, dev
└── README.md      ← Dit document
```

### Dependencies

```json
{
  "express":    "^4.18.2",
  "node-cron":  "^3.0.3",
  "pg":         "^8.11.0"
}
```

**Node.js vereist: >= 18.0.0**

```bash
npm install        # installeer dependencies
npm start          # productie
npm run dev        # ontwikkeling met nodemon
```

---

## 9. Versiegeschiedenis

| Versie | Datum | Wijzigingen |
|---|---|---|
| **v4.3** | April 2026 | **FIX** Min lot cap = `baseRisk` per type (niet vaste €60) — indices buiten Asia werken correct · **FIX** Restart recovery — open posities hersteld vanuit MT5 na Railway herstart · **FEAT** Forex half risk bij 1–2 open trades zelfde pair+richting · Spread guard aangescherpt van 1/2 → 1/3 van SL-afstand · Ghost tracker prioriteit batching (recent 60s, oud 5min) · DB sessie herberekening op `openedAt` voor trades zonder sessie |
| **v4.2** | Maart 2026 | Indices toegestaan tijdens Asia sessie (02:00–08:00) · Stocks beperkt tot NY venster (15:30–20:00) · Automatische zomer/wintertijd via `Intl` API (geen hardcoded +1h/+2h) |
| **v4.1** | Februari 2026 | sub-1R TP niveaus (0.2/0.4/0.6/0.8) in `tp_config` · `spread_guard` en `sl_multiplier` kolommen in `closed_trades` · `forex_consolidation_log` tabel · `sl_config` direction kolom (up/down/unchanged) |
| **v4.0** | Januari 2026 | TP/SL lock engine geïntroduceerd · Ghost tracker systeem · PostgreSQL persistentie (was enkel in-memory) · Sessie-gebaseerde TP optimalisatie |

---

## 10. Roadmap

### Fase 1 — Stabilisatie (Nu → Mei 2026)

- [ ] **Live HTML dashboard herstellen**: `/dashboard` retourneert nu JSON — volledige visuele versie (equity curve, open posities, ghost tracker) moet worden geherintegreerd
- [ ] **Monitoring alerts**: notificaties voor server down, hoge spread, geblokkeerde trade, 3+ forex posities op hetzelfde pair
- [ ] **FTMO Safety Check implementeren**: `ftmoSafetyCheck()` retourneert nu altijd `{ ok: true }` — dagelijkse verlieslimieten (5% daily drawdown) moeten worden geïmplementeerd vóór live trading
- [ ] Automated tests schrijven voor lot-berekening, sessie-logica en spread guard
- [ ] `learnedPatches` object (dode code) verwijderen
- [ ] `WEBHOOK_SECRET` fallback hardcode verwijderen uit `server.js`

### Fase 2 — Live Account (Mei → Juli 2026)

- [ ] FTMO Demo → FTMO Live na 3 succesvolle maanden op demo
- [ ] `META_ACCOUNT_ID` en `ACCOUNT_BALANCE` updaten naar live credentials
- [ ] Telegram / Discord notificaties bij trade-opening, sluiting en blokkering
- [ ] `WEBHOOK_SECRET` roteren naar sterk wachtwoord

### Fase 3 — Schaalvergroting (Juli → December 2026)

- [ ] Multi-account support: meerdere FTMO accounts simultaan
- [ ] Portfolio risicobeheer: totaal open risico over alle accounts bewaken
- [ ] Backtesting engine: historische TradingView signals simuleren op gesloten trade-database
- [ ] React/Next.js web interface voor configuratie en monitoring
- [ ] Machine learning TP/SL optimalisatie op basis van marktregime (trend vs. range)

---

## 11. Bekende Issues

### 🔴 Kritiek

| Issue | Beschrijving |
|---|---|
| **FTMO Safety Check UIT** | `ftmoSafetyCheck()` retourneert altijd `{ ok: true }`. Dagelijkse verlieslimieten worden **NIET** gecontroleerd. Grootste risico voor live trading — moet als eerste worden opgelost. |
| **Webhook Secret fallback** | `"FtmoNV2025"` staat hardcoded als fallback in `server.js`. Op productie altijd de env var gebruiken. |

### 🟡 Minor

| Issue | Beschrijving |
|---|---|
| **Dashboard vereenvoudigd** | `/dashboard` retourneert een JSON-object i.p.v. het volledige visuele HTML-dashboard. |
| **Dode code** | `learnedPatches` object gedeclareerd maar nergens gebruikt — kan worden verwijderd. |
| **Inconsistentie safety** | `ftmoDailyLossUsed` tracking is geïmplementeerd maar de check is uitgeschakeld. |
| **SQL interpolatie** | `loadSnapshots` gebruikt template string interpolatie voor `INTERVAL` parameter. Praktisch veilig (`parseInt`), maar formeel een code smell. |

---

## 12. Snelstartgids — Checklist

### Server Setup

- [ ] Railway project aangemaakt en GitHub repository gekoppeld
- [ ] PostgreSQL plugin toegevoegd aan Railway project
- [ ] `META_API_TOKEN` ingesteld (MetaApi dashboard → API tokens)
- [ ] `META_ACCOUNT_ID` ingesteld (MetaApi dashboard → jouw MT5 account)
- [ ] `WEBHOOK_SECRET` ingesteld op een sterk uniek wachtwoord
- [ ] `ACCOUNT_BALANCE` ingesteld op jouw accountgrootte in EUR
- [ ] Risico per type ingesteld (`RISK_INDEX`, `RISK_FOREX`, `RISK_GOLD`, enz.)
- [ ] Server deployed en operationeel: `GET /health` retourneert 200 OK

### TradingView Configuratie

- [ ] Alert aangemaakt op indicator of strategie
- [ ] Webhook URL correct ingesteld: `https://[jouw-app].up.railway.app/webhook`
- [ ] JSON payload correct geconfigureerd met `secret`, `symbol`, `action`, `entry`, `sl`, `tp`
- [ ] Test-alert handmatig gestuurd en resultaat gecheckt via `GET /history`

### Monitoring

- [ ] `GET /dashboard` bookmark aangemaakt voor dagelijks gebruik
- [ ] `GET /research/tp-optimizer` gecheckt na 10+ trades voor TP aanbevelingen
- [ ] `GET /analysis/equity-curve` gecheckt voor equity curve visualisatie
- [ ] `GET /tp-locks` gecheckt voor actieve TP lock configuratie

---

*PRONTO-AI — Nick Verschoot | nick@pronto-ai.be | April 2026 | VERTROUWELIJK*
