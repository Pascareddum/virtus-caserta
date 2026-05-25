# 📊 Report Analisi Settimanale – Virtus Caserta

**Data analisi:** 25 Maggio 2026  
**Progetto:** Virtus Caserta ASD – Sito web pallavolo  
**File analizzati:** server.js (4380 righe), db.js, common.js, common.css, tutti i file .html, package.json, railway.json, sw.js

---

## 🔎 Riepilogo Esecutivo

I cinque punti critici principali identificati questa settimana:

1. **🔴 Token JWT utente memorizzati in `localStorage`** — esposti ad attacchi XSS. Il token admin è anch'esso in `localStorage`. Dovrebbero essere usati cookie `httpOnly`.
2. **🔴 Nessuna protezione CSRF** — tutte le API che mutano stato (POST/PUT/DELETE) sono vulnerabili a Cross-Site Request Forgery.
3. **🔴 6 vulnerabilità moderate nelle dipendenze** — `express`, `express-rate-limit`, `ws`, `qs` segnalati da `npm audit`. Risolvibili con `npm audit fix`.
4. **🔴 ID generati con `Date.now().toString()`** — usato in 22+ punti, con rischio di collisione in scenari concorrenti. `crypto.randomUUID()` è già usato in alcuni punti e dovrebbe essere standardizzato.
5. **🟡 `server.js` monolitico da 4380 righe e `admin.html` da 7129 righe** — manutenibilità critica, impossibile fare debug o test in modo efficace.

---

## 1. 🔒 Sicurezza

### 1.1 Token JWT in `localStorage` — rischio XSS
**File:** `common.js` righe 292, 317, 345–354; `admin.html` riga ~2950  
**Problema:** I token JWT (sia utente che admin) vengono salvati in `localStorage`, accessibile da qualsiasi script JavaScript sulla pagina. Un attacco XSS anche minore permetterebbe di rubare la sessione.

```js
// ATTUALE (insicuro)
localStorage.setItem('vc_token', data.token);
localStorage.setItem('vc_admin_token', TOKEN);
```

**Soluzione consigliata:** Usare cookie `httpOnly` per i token utente, come già fatto per la sessione admin lato server (`vc_admin_session`). Il server emette il cookie sul login, il client non accede mai al token direttamente.

```js
// SERVER: al login utente
res.cookie('vc_session', token, {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 24 * 60 * 60 * 1000,
});
```

**Priorità:** 🔴 Alta

---

### 1.2 Nessuna protezione CSRF
**File:** `server.js` — tutti gli endpoint POST/PUT/DELETE  
**Problema:** Nessun middleware CSRF è presente. Qualsiasi sito esterno potrebbe inviare richieste autenticate per conto di un utente loggato. Il `sameSite: 'strict'` sui cookie mitiga parzialmente, ma solo se si migra ai cookie httpOnly (punto 1.1).

**Soluzione consigliata:** Implementare il Double Submit Cookie pattern:

```js
// Genera un token CSRF al login e invialo in un cookie leggibile dal JS
res.cookie('csrf_token', crypto.randomUUID(), { sameSite: 'strict', secure: true });

// Middleware di verifica
function csrfCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const header = req.headers['x-csrf-token'];
  const cookie = req.cookies['csrf_token'];
  if (!header || header !== cookie) return res.status(403).json({ error: 'CSRF token non valido' });
  next();
}
app.use('/api/', csrfCheck);
```

**Priorità:** 🔴 Alta

---

### 1.3 Password minima troppo corta
**File:** `server.js` riga 807  
**Problema:** La password minima è di soli 6 caratteri. Le linee guida OWASP e NIST raccomandano almeno 8 caratteri.

```js
// ATTUALE
if (password.length < 6) return res.status(400).json({ error: 'Password minimo 6 caratteri.' });
```

**Soluzione consigliata:**

```js
if (password.length < 8) return res.status(400).json({ error: 'Password minimo 8 caratteri.' });
```

**Priorità:** 🟡 Media

---

### 1.4 CSP con `'unsafe-inline'` per script
**File:** `server.js` righe 181–191  
**Problema:** La direttiva `scriptSrc` include `'unsafe-inline'` e `scriptSrcAttr: ["'unsafe-inline'"]`, il che neutralizza gran parte della protezione XSS offerta dal Content Security Policy.

**Soluzione consigliata:** Sostituire `unsafe-inline` con nonce generati per richiesta. Richiede di passare il nonce alle pagine server-side rendered:

```js
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});
// Nel CSP: scriptSrc: ["'self'", `'nonce-${res.locals.nonce}'`]
```

**Priorità:** 🟡 Media

---

### 1.5 Nessun rate limit sulle API generali
**File:** `server.js`  
**Problema:** Solo login, registrazione, pagamenti e contatti hanno rate limiting. Endpoint pubblici come `/api/calendario`, `/api/notizie`, `/api/squadra` sono senza limiti e potrebbero essere usati per DDoS o scraping aggressivo.

**Soluzione consigliata:**

```js
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe richieste. Riprova più tardi.' },
});
app.use('/api/', globalLimiter);
```

**Priorità:** 🟡 Media

---

### 1.6 Nessun refresh token JWT per utenti
**File:** `server.js` riga 479  
**Problema:** I token utente durano 24 ore senza meccanismo di refresh. Non esiste un endpoint di revoca. Se un token viene compromesso, è valido per tutta la sua durata.

**Soluzione consigliata:** Implementare token di refresh separati, o almeno ridurre la durata dell'access token a 1–2 ore.

**Priorità:** 🟡 Media

---

## 2. 🏗️ Qualità del Codice

### 2.1 ID generati con `Date.now().toString()` — rischio collisione
**File:** `server.js` — 22 occorrenze  
**Problema:** `Date.now().toString()` produce ID identici se due richieste arrivano nello stesso millisecondo. In ambienti concorrenti (es. più ordini simultanei) si rischiano conflitti di PRIMARY KEY nel database. In alcuni punti viene aggiunto `Math.random()` come patch, ma non è una soluzione robusta.

```js
// ATTUALE (a rischio)
const id = Date.now().toString();

// GIÀ USATO in alcuni punti — da standardizzare ovunque
const id = crypto.randomUUID();
```

**Soluzione consigliata:** Sostituire tutti gli usi di `Date.now().toString()` con `crypto.randomUUID()`, già importato e disponibile nel file.

**Priorità:** 🔴 Alta

---

### 2.2 File monolitici difficili da manutenere
**Problema:** `server.js` è 4380 righe e `admin.html` è 7129 righe. Qualsiasi modifica rischia di introdurre regressioni. È impossibile fare unit testing.

**Soluzione consigliata:** Dividere `server.js` in moduli Express separati:

```
routes/
  auth.js          ← login, logout, register, imposta-password
  calendario.js    ← CRUD calendario, tornei, palestre
  shop.js          ← prodotti, ordini, email ordini
  utenti.js        ← gestione utenti admin
  fipav.js         ← integrazione FIPAV/OPES
  notizie.js       ← CRUD notizie
  ...
server.js          ← solo bootstrap, middleware globali, app.listen
```

**Priorità:** 🟡 Media

---

### 2.3 File `admin 2.html` — duplicato legacy non servito
**File:** `admin 2.html` (con spazio nel nome)  
**Problema:** Esiste una copia legacy del pannello admin accessibile come file statico (il blocco `BLOCKED_FILES` non lo esclude). Potrebbe esporre funzionalità obsolete.

**Soluzione consigliata:**

```bash
git rm "admin 2.html"
```

**Priorità:** 🟡 Media

---

### 2.4 Schema migrations inline all'avvio del server
**File:** `db.js` — funzione `createTables()`  
**Problema:** Le migrazioni schema vengono eseguite ad ogni avvio con decine di `ALTER TABLE ADD COLUMN IF NOT EXISTS`. Su database con molte righe, questo rallenta il boot. Non c'è storico delle migrazioni né possibilità di rollback.

**Soluzione consigliata:** Adottare un tool di migrazione come `node-pg-migrate`:

```bash
npm install node-pg-migrate
```

**Priorità:** 🟡 Media

---

### 2.5 Variabili d'ambiente non documentate
**File:** `.env.example`  
**Problema:** Mancano nel file di esempio:
- `BREVO_API_KEY` — essenziale per invio email via API Brevo
- `SUPABASE_REGION` — usata in `db.js` per costruire l'URL del pooler
- `DATABASE_URL` — presente ma senza esempio del formato

**Soluzione consigliata:** Aggiungere al `.env.example`:

```env
# Brevo HTTP API (alternativa preferita a SMTP per email transazionali)
BREVO_API_KEY=xkeysib-...

# Regione Supabase per connessione pooler
SUPABASE_REGION=eu-central-1
```

**Priorità:** 🟢 Bassa

---

## 3. ⚡ Performance

### 3.1 CSS inline in ogni pagina HTML (no caching browser)
**File:** Tutti i file `.html`  
**Problema:** Ogni pagina contiene centinaia di righe di CSS inline nel tag `<style>`. Questo CSS non viene cachato dal browser tra le navigazioni. `index.html` ha circa 700 righe di CSS inline, `admin.html` oltre 1000.

**Soluzione consigliata:** Estrarre il CSS page-specific in file separati linkati nell'`<head>`. `common.css` già esiste come pattern — estenderlo.

**Priorità:** 🟡 Media

---

### 3.2 Query N+1 in `/api/profilo/prossimi`
**File:** `server.js` righe 547–580  
**Problema:** Per ogni squadra dell'utente viene eseguita una query DB separata dentro un ciclo `for`. Con 5 squadre → 5 query sequenziali invece di 1.

```js
// ATTUALE — N query nel loop
for (const nome of nomiSquadre) {
  const calRes = await db.query(`... WHERE categoria ILIKE $1 ...`, [nome, ...]);
}
```

**Soluzione consigliata:**

```js
// UNA sola query con array
const calRes = await db.query(
  `SELECT * FROM calendario
   WHERE (categoria = ANY($1) OR categorie_collegate ?| $1)
     AND data_str >= $2 AND data_str <= $3
   ORDER BY data_str, ora`,
  [nomiSquadre, lunStr, domStr]
);
```

**Priorità:** 🟡 Media

---

### 3.3 Lazy loading parziale sulle immagini
**File:** `index.html` e pagine con immagini dinamiche  
**Problema:** Solo 5 immagini usano `loading="lazy"`. Le immagini generate dinamicamente tramite `innerHTML` non hanno mai il lazy loading.

**Soluzione consigliata:** Aggiungere `loading="lazy"` in tutti i template HTML generati via JavaScript:

```js
`<img src="${sq.immagine}" loading="lazy" alt="${esc(sq.nome)}">`
```

**Priorità:** 🟢 Bassa

---

### 3.4 Nessun cache-busting per asset statici
**File:** `server.js` (configurazione `express.static`), file HTML  
**Problema:** `common.css` e `common.js` vengono serviti senza versioning. Dopo un aggiornamento, gli utenti potrebbero vedere la versione vecchia in cache.

**Soluzione consigliata:** Aggiungere un query string versione nei link HTML:

```html
<link rel="stylesheet" href="/common.css?v=20260525">
<script src="/common.js?v=20260525"></script>
```

**Priorità:** 🟢 Bassa

---

## 4. 🔍 SEO e Accessibilità

### 4.1 Meta tag mancanti su pagine utente-facing
**Problema:** Diverse pagine mancano di `<meta name="description">` e tag Open Graph:

| Pagina | description | OG tags | Note |
|--------|-------------|---------|------|
| `login.html` | ❌ | ❌ | Aggiungere `noindex` |
| `live.html` | ✅ | ❌ | Manca OG |
| `utente.html` | ❌ | ❌ | Aggiungere `noindex` |
| `imposta-password.html` | ❌ | ❌ | Aggiungere `noindex` |
| `ordine-confermato.html` | ❌ | ❌ | Aggiungere `noindex` |

**Priorità:** 🟡 Media

---

### 4.2 Discrepanza URL in `og:url` di `index.html`
**File:** `index.html` riga ~12  
**Problema:** Il tag `og:url` punta a `https://virtuscaserta.it/` ma il dominio effettivo è `https://www.virtuscaserta.com`.

```html
<!-- ATTUALE (errato) -->
<meta property="og:url" content="https://virtuscaserta.it/">

<!-- CORRETTO -->
<meta property="og:url" content="https://www.virtuscaserta.com/">
```

**Priorità:** 🟢 Bassa

---

### 4.3 Nessun tag `<link rel="canonical">`
**Problema:** Nessuna pagina ha il tag canonical. Con i redirect da `.html` a URL puliti, i crawler potrebbero indicizzare entrambe le versioni duplicando il contenuto.

**Soluzione consigliata:** Aggiungere in ogni pagina pubblica:

```html
<link rel="canonical" href="https://www.virtuscaserta.com/notizie">
```

**Priorità:** 🟢 Bassa

---

## 5. 🖥️ Funzionalità e UX

### 5.1 Stripe in `.env.example` ma non implementato
**File:** `.env.example`, `server.js`  
**Problema:** Il file `.env.example` documenta `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` e `STRIPE_WEBHOOK_SECRET`, ma non c'è nessuna implementazione Stripe nel backend. Il pagamento avviene solo tramite PayPal. Questo crea confusione nell'onboarding.

**Soluzione consigliata:** Rimuovere le variabili Stripe da `.env.example` se l'integrazione non è pianificata a breve, oppure implementare il checkout Stripe con verifica webhook.

**Priorità:** 🟡 Media

---

### 5.2 `sw.js` minimale — nessuna cache offline
**File:** `sw.js`  
**Problema:** Il service worker gestisce solo notifiche push. Non implementa nessuna strategia di caching. Il sito non funziona offline e non beneficia delle ottimizzazioni PWA.

**Soluzione consigliata:** Aggiungere una strategia Cache First per gli asset statici:

```js
const CACHE_NAME = 'virtus-v1';
const STATIC_ASSETS = ['/', '/common.css', '/common.js', '/images/logo.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
```

**Priorità:** 🟢 Bassa

---

### 5.3 Email iscrizioni usa Gmail SMTP legacy invece di Brevo
**File:** `server.js` riga ~3876  
**Problema:** L'endpoint `/api/iscrizioni` usa `creaTransporter()` (Gmail SMTP) invece di Brevo. Questo è inconsistente con il resto del sistema e Gmail SMTP è meno affidabile per email transazionali.

**Soluzione consigliata:** Sostituire `creaTransporter()` con `sendBrevoEmail()` o `creaTransporterBrevo()` per unificare tutti gli invii email su Brevo.

**Priorità:** 🟡 Media

---

## 6. 📦 Dipendenze

### 6.1 6 vulnerabilità moderate — risolvibili con `npm audit fix`
**File:** `package.json`  
**Problema:** `npm audit` rileva 6 vulnerabilità moderate:
- `ip-address ≤10.1.0` → XSS in metodi HTML (via `express-rate-limit`)
- `qs 6.11.1–6.15.1` → DoS con `qs.stringify` (via `express`, `body-parser`)
- `ws 8.0.0–8.20.0` → uninitialized memory disclosure (via `@supabase/supabase-js`)

**Soluzione consigliata:**

```bash
npm audit fix
# Testare che tutto funzioni ancora correttamente dopo l'aggiornamento
```

**Priorità:** 🔴 Alta

---

### 6.2 Aggiornamenti disponibili

| Pacchetto | Versione attuale | Ultima disponibile | Tipo |
|-----------|-----------------|-------------------|------|
| `express` | 4.22.1 | 4.22.2 | Patch |
| `express-rate-limit` | 8.3.2 | 8.5.2 | Minor |
| `helmet` | 8.1.0 | 8.2.0 | Minor |
| `nodemailer` | 8.0.5 | 8.0.8 | Patch |
| `pg` | 8.20.0 | 8.21.0 | Patch |
| `@supabase/supabase-js` | 2.104.0 | 2.106.1 | Minor |
| `stripe` | 21.0.1 | 22.1.1 | **Major** |
| `dotenv` | 16.x | 17.x | **Major** |

**Soluzione consigliata:**

```bash
# Aggiornamenti sicuri (patch/minor)
npm update express express-rate-limit helmet nodemailer pg @supabase/supabase-js
# Major: leggere changelog prima di aggiornare stripe e dotenv
```

**Priorità:** 🟡 Media

---

## 7. 🚀 Infrastruttura e Deploy

### 7.1 Nessun sistema di error monitoring
**File:** `server.js` — usa solo `console.log`/`console.error`  
**Problema:** In produzione su Railway non c'è nessun sistema di alerting. Gli errori vengono loggati ma non aggregati. Non c'è visibility su errori ricorrenti o degradation delle performance.

**Soluzione consigliata:** Integrare Sentry (piano gratuito disponibile):

```bash
npm install @sentry/node
```

```js
const Sentry = require('@sentry/node');
Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });
app.use(Sentry.Handlers.requestHandler());
// ... tutte le route ...
app.use(Sentry.Handlers.errorHandler());
```

**Priorità:** 🟡 Media

---

### 7.2 Check variabili d'ambiente incomplete all'avvio
**File:** `server.js` righe 22–27  
**Problema:** Il check di avvio verifica solo `JWT_SECRET`, `ADMIN_PASSWORD` e `ADMIN_USERNAME`, ma mancano `DATABASE_URL` (il server avvia comunque senza DB) e `BREVO_API_KEY`.

**Soluzione consigliata:**

```js
const REQUIRED_ENV = ['JWT_SECRET', 'ADMIN_PASSWORD', 'ADMIN_USERNAME', 'DATABASE_URL'];
if (process.env.NODE_ENV === 'production') {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[CRITICO] Variabili mancanti: ${missing.join(', ')}`);
    process.exit(1);
  }
}
```

**Priorità:** 🟢 Bassa

---

## 📋 Tabella Riepilogativa

| # | Area | Problema | File | Priorità |
|---|------|----------|------|----------|
| 1 | Sicurezza | JWT token in `localStorage` — vulnerabilità XSS | `common.js`, `admin.html` | 🔴 Alta |
| 2 | Sicurezza | Nessuna protezione CSRF sulle API | `server.js` | 🔴 Alta |
| 3 | Dipendenze | 6 vulnerabilità moderate (`npm audit`) | `package.json` | 🔴 Alta |
| 4 | Qualità | ID con `Date.now()` — rischio collisione DB | `server.js` (22 punti) | 🔴 Alta |
| 5 | Sicurezza | Password minima 6 caratteri (troppo corta) | `server.js` riga 807 | 🟡 Media |
| 6 | Sicurezza | CSP con `unsafe-inline` per script | `server.js` righe 181–191 | 🟡 Media |
| 7 | Sicurezza | Nessun rate limit globale sulle API | `server.js` | 🟡 Media |
| 8 | Sicurezza | Nessun refresh token JWT per utenti | `server.js` riga 479 | 🟡 Media |
| 9 | Qualità | `server.js` monolitico (4380 righe) | `server.js` | 🟡 Media |
| 10 | Qualità | `admin.html` monolitico (7129 righe) | `admin.html` | 🟡 Media |
| 11 | Qualità | File `admin 2.html` — duplicato legacy non rimosso | `admin 2.html` | 🟡 Media |
| 12 | Qualità | Migrazioni schema inline all'avvio | `db.js` | 🟡 Media |
| 13 | Performance | CSS inline in ogni pagina (nessun caching browser) | tutti gli `.html` | 🟡 Media |
| 14 | Performance | Query N+1 in `/api/profilo/prossimi` | `server.js` righe 547–580 | 🟡 Media |
| 15 | SEO | Meta description e OG mancanti su più pagine | `login.html`, `utente.html`, ecc. | 🟡 Media |
| 16 | Funzionalità | Stripe nel `.env.example` ma non implementato | `.env.example`, `server.js` | 🟡 Media |
| 17 | Funzionalità | Email iscrizioni usa Gmail SMTP invece di Brevo | `server.js` riga ~3876 | 🟡 Media |
| 18 | Infrastruttura | Nessun error monitoring (Sentry o simili) | `server.js` | 🟡 Media |
| 19 | Dipendenze | Aggiornamenti disponibili per 6+ pacchetti | `package.json` | 🟡 Media |
| 20 | Qualità | `BREVO_API_KEY` e `SUPABASE_REGION` non documentati | `.env.example` | 🟢 Bassa |
| 21 | Performance | Lazy loading parziale sulle immagini | vari `.html` | 🟢 Bassa |
| 22 | Performance | Nessun cache-busting per asset statici | `server.js`, file HTML | 🟢 Bassa |
| 23 | SEO | `og:url` punta a dominio errato (`virtuscaserta.it`) | `index.html` | 🟢 Bassa |
| 24 | SEO | Nessun tag `<link rel="canonical">` | tutti gli `.html` | 🟢 Bassa |
| 25 | Funzionalità | Service worker senza strategia di caching offline | `sw.js` | 🟢 Bassa |
| 26 | Infrastruttura | Check variabili obbligatorie incompleto all'avvio | `server.js` | 🟢 Bassa |

---

*Report generato automaticamente dall'analisi settimanale del 25 Maggio 2026.*
