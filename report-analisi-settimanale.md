# Report Analisi Settimanale – Virtus Caserta

**Data analisi:** 1 settembre 2026  
**Progetto:** virtus-caserta (Node.js/Express + PostgreSQL/Supabase)  
**File analizzati:** server.js (5.297 righe), db.js, common.js, shared.js, sw.js, *.html (26 pagine), package.json, railway.json

---

## Riepilogo Esecutivo

Cinque punti critici emergono dall'analisi:

1. **Logout rotto** — `window.logout` in `common.js` cancella solo il localStorage ma non chiama `/api/logout`, lasciando il cookie `vc_user_session` attivo. L'utente rimane autenticato lato server anche dopo il logout apparente.
2. **Valori di fallback insicuri** — `JWT_SECRET` e `ADMIN_PASSWORD` hanno fallback hardcoded in codice (`'virtus_secret_2026_dev'` / `'virtus2026'`). Se le variabili d'ambiente mancano in produzione, l'applicazione parte comunque con segreti noti.
3. **`/api/push/subscribe` e `/api/imposta-password` non protetti** — il primo accetta subscription senza autenticazione (spam/flood); il secondo non ha rate limiter (brute-force sui token di setup password).
4. **N+1 query in `/api/profilo/prossimi`** — per ogni squadra dell'utente vengono eseguiti query DB sequenziali in loop, causando decine di roundtrip per utenti multi-squadra.
5. **Service Worker cache `'vc-v1'` mai aggiornata** — il nome cache è fisso: dopo ogni deploy i client possono continuare a servire JS/CSS obsoleti indefinitamente.

---

## 1. Sicurezza

### 1.1 Fallback JWT_SECRET e ADMIN_PASSWORD hardcoded
**Priorità:** 🔴 Alta

**File:** `server.js`, righe 28–29 e 413
```js
const JWT_SECRET = process.env.JWT_SECRET || 'virtus_secret_2026_dev'; // ← fallback noto
const adminPassword = process.env.ADMIN_PASSWORD || 'virtus2026';       // ← fallback noto
```
Se `JWT_SECRET` non è impostato, chiunque conosca il fallback può forgiare token JWT validi. Ugualmente, `ADMIN_PASSWORD='virtus2026'` è un fallback pubblicamente leggibile nel sorgente.

**Soluzione:** Rimuovere entrambi i fallback. Il controllo già esiste in produzione per `JWT_SECRET`; estenderlo anche ad `ADMIN_PASSWORD` e far crashare il processo se mancanti.
```js
// All'avvio, ampliare il controllo:
const missing = ['JWT_SECRET', 'ADMIN_PASSWORD', 'ADMIN_USERNAME'].filter(k => !process.env[k]);
if (missing.length) { console.error(...); process.exit(1); }

const JWT_SECRET = process.env.JWT_SECRET; // nessun fallback
```

---

### 1.2 Logout non invalida il cookie di sessione
**Priorità:** 🔴 Alta

**File:** `common.js`, riga 324
```js
window.logout = function () {
  ['vc_token','vc_role','vc_nome','vc_user','vc_admin_token'].forEach(k => localStorage.removeItem(k));
  location.reload(); // ← il cookie httpOnly vc_user_session resta attivo
};
```
Il server usa cookie httpOnly (`vc_user_session`) come sorgente primaria di autenticazione. Il logout frontend che cancella solo il localStorage non invalida il cookie. L'endpoint `/api/logout` esiste ma non viene chiamato.

**Soluzione:**
```js
window.logout = async function () {
  await fetch('/api/logout', { method: 'POST' }); // cancella il cookie lato server
  ['vc_token','vc_role','vc_nome','vc_user','vc_admin_token'].forEach(k => localStorage.removeItem(k));
  location.reload();
};
```

---

### 1.3 `/api/push/subscribe` senza autenticazione
**Priorità:** 🔴 Alta

**File:** `server.js`, riga 4720
```js
app.post('/api/push/subscribe', async (req, res) => { // ← nessun middleware auth
  const { endpoint, keys } = req.body;
  ...
  await db.query(`INSERT INTO push_subscriptions ...`);
```
Chiunque può registrare endpoint arbitrari, gonfiare la tabella `push_subscriptions` e potenzialmente ricevere notifiche. Aggiungere almeno un rate limiter; idealmente richiedere autenticazione.

**Soluzione:**
```js
const pushSubscribeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, ... });
app.post('/api/push/subscribe', pushSubscribeLimiter, async (req, res) => { ... });
// Oppure, per limitare solo agli utenti autenticati:
app.post('/api/push/subscribe', pushSubscribeLimiter, userAuth, async (req, res) => { ... });
```

---

### 1.4 `/api/imposta-password` senza rate limiter
**Priorità:** 🔴 Alta

**File:** `server.js`, riga 928
```js
app.post('/api/imposta-password', async (req, res) => { // ← nessun rate limiter
  const r = await db.query(
    `SELECT id FROM utenti WHERE setup_token=$1 AND setup_token_exp > NOW()...`
```
Un attaccante può tentare token a raffica (brute-force) senza alcun throttling.

**Soluzione:**
```js
const impostaPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, ... });
app.post('/api/imposta-password', impostaPasswordLimiter, async (req, res) => { ... });
```

---

### 1.5 `/api/push/preferences` senza autenticazione
**Priorità:** 🟡 Media

**File:** `server.js`, riga 4708
```js
app.put('/api/push/preferences', async (req, res) => { // ← nessun auth
```
Le preferenze di notifica push sono modificabili da chiunque conosca l'endpoint.

**Soluzione:** Aggiungere il middleware `userAuth` o almeno un controllo sull'endpoint (`endpoint` come identifier parziale).

---

### 1.6 Leakage di messaggi d'errore interni
**Priorità:** 🟡 Media

**File:** `server.js`, riga 4985
```js
res.status(500).json({ error: err.message || 'Errore interno del server.' });
```
`err.message` può contenere dettagli interni (nomi di tabelle, stack trace parziali, messaggi PostgreSQL). La stessa logica ricorre in `console.error('[Contact] ...')` che va bene, ma non nel JSON di risposta.

**Soluzione:**
```js
console.error('[Test email]', err);
res.status(500).json({ error: 'Errore interno del server.' }); // messaggio generico
```

---

### 1.7 Token JWT utente con scadenza 120 giorni
**Priorità:** 🟢 Bassa

**File:** `server.js`, riga 520
```js
const token = jwt.sign({ ... }, JWT_SECRET, { expiresIn: '120d' });
```
120 giorni è molto lungo. Se un token viene compromesso, rimane valido per 4 mesi. La sliding session via `/api/me` è già implementata; una scadenza più breve (es. 30d) con rinnovo automatico offre un miglior bilanciamento sicurezza/UX.

---

## 2. Qualità del Codice

### 2.1 Logout frontend incoerente con l'auth backend (dettaglio aggiuntivo)
**Priorità:** 🔴 Alta

**File:** `common.js`, riga 303 (dentro `submitLogin`)
```js
localStorage.setItem('vc_token', data.token); // ← data.token è undefined
localStorage.setItem('vc_role',  data.role);  // ← data.role è undefined
localStorage.setItem('vc_nome',  data.nome);  // ← data.nome è undefined
```
Il server `/api/login` risponde con `{ user: { id, nome, cognome, email } }` via JSON e imposta il token in un cookie httpOnly. Non restituisce `data.token`, `data.role` o `data.nome` al livello radice. Le scritture in localStorage salvano `undefined` per tutti e tre i campi. Lo stato di autenticazione lato client è quindi basato su dati vuoti; funziona solo perché il cookie esiste.

**Soluzione:** Allineare il client al contratto API:
```js
const data = await res.json();
if (!res.ok) { errEl.textContent = data.error; return; }
localStorage.setItem('vc_nome', data.user?.nome || '');
window.chiudiModal();
_vcUpdateAuthUI();
```

---

### 2.2 `shared.js` usa `var` in tutto il file
**Priorità:** 🟡 Media

**File:** `shared.js`, riga 5 e seguenti (15+ occorrenze)
```js
var _p = window.location.pathname...
var _nav = ...
var _footer = ...
```
`var` ha scope a funzione e comportamento di hoisting che può causare bug sottili. L'intero file dovrebbe usare `const`/`let`.

**Soluzione:** Sostituire tutte le occorrenze di `var` con `const` o `let` a seconda che la variabile venga riassegnata.

---

### 2.3 `server.js` monolitico (5.297 righe)
**Priorità:** 🟡 Media

**File:** `server.js`

Il file gestisce: autenticazione, utenti, calendario, tornei, ordini/shop, email, push notification, FIPAV scraping, Twitch monitoring, impostazioni, log attività, sponsor, risultati, squadra, galleria, staff, sponsor, palestre, staff arbitrale, comunicazioni, documenti, partite proposte, bandi/progetti. Ogni area dovrebbe essere un router Express separato in una cartella `routes/`.

**Soluzione (struttura suggerita):**
```
routes/
  auth.js
  users.js
  calendario.js
  shop.js
  tornei.js
  push.js
  fipav.js
  admin.js
server.js  // solo bootstrap: middleware, route mounting, listen
```

---

### 2.4 `db.js`: migrazioni sequenziali ad ogni avvio
**Priorità:** 🟢 Bassa

**File:** `db.js`, funzione `createTables()`

Ogni volta che il server parte, vengono eseguiti ~60 `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` in sequenza. La maggior parte sono no-op ma consumano tempo di avvio e connessioni al pool. Considerare una libreria di migration (es. `node-pg-migrate` o `umzug`) con tracking delle versioni applicate.

---

## 3. Performance

### 3.1 N+1 query in `/api/profilo/prossimi`
**Priorità:** 🔴 Alta

**File:** `server.js`, righe 561–680 circa

Per ogni squadra dell'utente (array `nomiSquadre`), vengono eseguite query DB separate in `for...of`:
```js
for (const nome of nomiSquadre) {
  const calRes = await db.query(`SELECT ... FROM calendario WHERE ...`, [nome, ...]);
  // poi loop separato per le partite FIPAV
}
```
Con 5 squadre e 2 sorgenti dati ciascuna, un singolo caricamento della pagina profilo può generare 15+ roundtrip DB.

**Soluzione:** Consolidare con `ANY($1::text[])` o `IN (...)`:
```js
const calRes = await db.query(
  `SELECT * FROM calendario
   WHERE categoria = ANY($1::text[])
   AND data_str >= $2 AND data_str <= $3`,
  [nomiSquadre, lunStr, domStr]
);
```

---

### 3.2 Mancanza di indici DB su colonne frequentemente filtrate
**Priorità:** 🟡 Media

**File:** `db.js`

Le query frequenti filtrano su `calendario.data_str`, `fipav_matches.data_ora`, `fipav_matches.cid`, `utenti.stato`, `notizie.created_at`, ma non esistono indici corrispondenti (solo `UNIQUE` su `fipav_classifica_cache` e `assegnazioni_partita`).

**Soluzione da aggiungere in `createTables()`:**
```sql
CREATE INDEX IF NOT EXISTS idx_calendario_data ON calendario(data_str);
CREATE INDEX IF NOT EXISTS idx_fipav_matches_data ON fipav_matches(data_ora);
CREATE INDEX IF NOT EXISTS idx_fipav_matches_cid ON fipav_matches(cid, fonte);
CREATE INDEX IF NOT EXISTS idx_utenti_stato ON utenti(stato);
CREATE INDEX IF NOT EXISTS idx_notizie_created ON notizie(created_at DESC);
```

---

### 3.3 Service Worker cache con versione statica
**Priorità:** 🟡 Media

**File:** `sw.js`, riga 1
```js
const CACHE_NAME = 'vc-v1'; // ← mai aggiornato
```
Se il service worker è già installato sui browser degli utenti, `vc-v1` non viene mai invalidato dopo un deploy. I client possono continuare a usare JS e CSS obsoleti.

**Soluzione:** Aggiornare la versione ad ogni release, idealmente iniettandola al build time:
```js
const CACHE_NAME = 'vc-v2026-09-01'; // aggiornare ad ogni deploy significativo
```
Oppure aggiungere un parametro di versione generato dinamicamente (hash del bundle).

---

### 3.4 Endpoint admin senza paginazione
**Priorità:** 🟢 Bassa

**File:** `server.js`, riga 2609
```js
const result = await db.query(`SELECT * FROM ordini ${where} ORDER BY created_at DESC`);
```
Con molti ordini nel tempo, questa query restituisce l'intera tabella. Aggiungere `LIMIT`/`OFFSET` o cursori.

---

## 4. SEO e Accessibilità

### 4.1 Immagini senza attributo `alt`
**Priorità:** 🟡 Media

Pagine con immagini prive di `alt`:

| Pagina | Immagini senza `alt` |
|--------|---------------------|
| `admin.html` | 16 |
| `index.html` | 2 |
| `notizie.html` | 1 |
| `calendario.html` | 1 |
| `eventi-tornei-utente.html` | 2 |

Le immagini decorative devono avere `alt=""`, le informative un testo descrittivo.

---

### 4.2 Canonical tag assente
**Priorità:** 🟢 Bassa

Nessuna pagina HTML include il tag `<link rel="canonical">`. Con redirect 301 da URL `.html` a URL puliti, Google potrebbe indicizzare entrambe le versioni. Aggiungere:
```html
<link rel="canonical" href="https://www.virtuscaserta.com/notizie">
```

---

### 4.3 Meta tag OG presenti su tutte le pagine principali
**Priorità:** ✅ Nessun problema

`og:title`, `og:description`, `twitter:card` sono correttamente definiti su `index.html`, `notizie.html`, `shop.html`, `squadra.html`. Il meccanismo di OG dinamico per gli articoli (`/notizia/:id`) è ben implementato.

---

## 5. Funzionalità e UX

### 5.1 Stato autenticazione nel drawer mobile basato su dati corrotti
**Priorità:** 🟡 Media  
*(Conseguenza del punto 2.1)*

Il drawer mobile carica `/api/prossimi-eventi` con un token Bearer preso da `localStorage.getItem('vc_token')` che è `undefined`. La richiesta funziona grazie al cookie httpOnly, ma il codice front-end è inconsistente e potrebbe rompersi con futuri refactoring.

---

### 5.2 Numero WhatsApp non configurato
**Priorità:** 🟢 Bassa

**File:** `common.js`, riga ~170
```js
const WA_NUMBER = ''; // es. '393331234567' — lascia vuoto per nascondere
```
Il componente è implementato ma disabilitato. Se il numero è disponibile, attivarlo migliora l'engagement.

---

## 6. Dipendenze

### 6.1 Express 4.x — upgrade a 5.x disponibile
**Priorità:** 🟢 Bassa

- Installato: Express **4.22.2** (ultima 4.x)
- Disponibile: Express **5.x** (stabile da fine 2024)

Express 5 include async error handling nativo (non serve più `try/catch` manuale per ogni route async). Richiede testing prima del passaggio.

---

### 6.2 `dotenv` potrebbe essere aggiornato
**Priorità:** 🟢 Bassa

`dotenv ^16.3.1` è funzionante ma la versione installata potrebbe essere vecchia. Eseguire `npm outdated` periodicamente e aggiornare le dipendenze non breaking.

---

## 7. Infrastruttura e Deploy

### 7.1 `SUPABASE_REGION` non documentata in `.env.example`
**Priorità:** 🟡 Media

**File:** `db.js`, riga ~22
```js
const region = process.env.SUPABASE_REGION || 'eu-central-1';
```
La variabile non è in `.env.example`. Chi fa un fresh deploy potrebbe non sapere di doverla configurare e connettersi alla regione sbagliata.

**Soluzione:** Aggiungere a `.env.example`:
```env
# Regione Supabase (es. eu-central-1, eu-west-2)
SUPABASE_REGION=eu-central-1
```

---

### 7.2 `railway.json` senza `numReplicas`
**Priorità:** 🟢 Bassa

**File:** `railway.json`

Il file non specifica `numReplicas`. Su Railway, un singolo replica implica downtime durante il deploy. Per zero-downtime:
```json
{
  "deploy": {
    "numReplicas": 2,
    ...
  }
}
```
(Richiede piano Railway a pagamento con supporto multi-replica.)

---

### 7.3 Nessun logging strutturato
**Priorità:** 🟢 Bassa

Il progetto usa `console.log`/`console.error` direttamente. In produzione, un sistema di logging strutturato (es. `pino`) consente filtri per livello, correlazione request ID e integrazione con monitoring esterno.

---

## Tabella Riepilogativa

| # | Problema | File/Riga | Area | Priorità |
|---|----------|-----------|------|----------|
| 1.1 | Fallback `JWT_SECRET` e `ADMIN_PASSWORD` hardcoded | `server.js:28,413` | Sicurezza | 🔴 Alta |
| 1.2 | Logout non invalida cookie httpOnly | `common.js:324` | Sicurezza | 🔴 Alta |
| 1.3 | `/api/push/subscribe` senza auth né rate limit | `server.js:4720` | Sicurezza | 🔴 Alta |
| 1.4 | `/api/imposta-password` senza rate limiter | `server.js:928` | Sicurezza | 🔴 Alta |
| 2.1 | Login frontend scrive `undefined` in localStorage | `common.js:303` | Qualità | 🔴 Alta |
| 3.1 | N+1 query in `/api/profilo/prossimi` | `server.js:561-680` | Performance | 🔴 Alta |
| 1.5 | `/api/push/preferences` senza auth | `server.js:4708` | Sicurezza | 🟡 Media |
| 1.6 | Leakage `err.message` in risposta HTTP | `server.js:4985` | Sicurezza | 🟡 Media |
| 2.2 | `shared.js` usa `var` (15+ occorrenze) | `shared.js:5+` | Qualità | 🟡 Media |
| 2.3 | `server.js` monolitico (5.297 righe) | `server.js` | Qualità | 🟡 Media |
| 3.2 | Indici DB mancanti su colonne hot | `db.js` | Performance | 🟡 Media |
| 3.3 | Service Worker cache `'vc-v1'` statica | `sw.js:1` | Performance | 🟡 Media |
| 4.1 | Immagini senza `alt` (22 totali) | varie `.html` | Accessibilità | 🟡 Media |
| 5.1 | Auth state drawer mobile incoerente | `common.js` | UX | 🟡 Media |
| 7.1 | `SUPABASE_REGION` non in `.env.example` | `db.js:22` | Infrastruttura | 🟡 Media |
| 1.7 | Token JWT utente valido 120 giorni | `server.js:520` | Sicurezza | 🟢 Bassa |
| 2.4 | Migrazioni DB sequenziali ad ogni avvio | `db.js` | Qualità | 🟢 Bassa |
| 3.4 | Endpoint admin ordini senza paginazione | `server.js:2609` | Performance | 🟢 Bassa |
| 4.2 | Canonical tag assente | tutte le `.html` | SEO | 🟢 Bassa |
| 6.1 | Express 4.x, disponibile 5.x | `package.json` | Dipendenze | 🟢 Bassa |
| 7.2 | `railway.json` senza `numReplicas` | `railway.json` | Infrastruttura | 🟢 Bassa |
| 7.3 | Nessun logging strutturato | `server.js` | Infrastruttura | 🟢 Bassa |

---

*Report generato automaticamente — analisi statica del codice sorgente. Alcune valutazioni potrebbero necessitare verifica in ambiente reale.*
