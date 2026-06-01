# Report Analisi Settimanale — Virtus Caserta
**Data analisi:** 1 giugno 2026
**File analizzati:** server.js (4807 righe), db.js, common.js, shared.js, sw.js, common.css, *.html (25 pagine), package.json, railway.json

---

## Riepilogo Esecutivo

I 5 punti critici principali emersi dall'analisi:

1. **🔴 JWT_SECRET con fallback in chiaro** — in assenza della variabile d'ambiente, viene usato `'virtus_secret_2026_dev'` come segreto JWT. Se l'app parte in modalità development senza la variabile, tutti i token sono forgiabili.
2. **🔴 Nessun rate limiter su endpoint sensibili** — `/api/imposta-password` e `/api/push/subscribe` non hanno rate limiting. Un attaccante può enumerare token di setup o saturare la tabella `push_subscriptions`.
3. **🟡 server.js monolitico da 4807 righe** — tutta la logica di business (email, scraping FIPAV, ordini, tornei, push notifications) è in un unico file. La manutenibilità è criticamente bassa.
4. **🟡 12 pagine HTML senza meta description né OG tags** — le pagine riservate agli utenti loggati e alcune pagine pubbliche non hanno metadati SEO né `noindex`.
5. **🟡 Nessun caching HTTP su asset statici** — `express.static` è usato senza `maxAge`, ogni risorsa viene rivalidata ad ogni richiesta.

---

## 1. Sicurezza

### 1.1 JWT_SECRET con fallback hardcoded
**File:** `server.js`, riga 29
**Problema:** Se `JWT_SECRET` non è definita, il fallback `'virtus_secret_2026_dev'` è un segreto noto; chiunque legga il codice può forgiare token admin validi.
```js
// Attuale — pericoloso
const JWT_SECRET = process.env.JWT_SECRET || 'virtus_secret_2026_dev';

// Consigliato
if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET obbligatoria');
const JWT_SECRET = process.env.JWT_SECRET;
```
Il check a riga 23 fa già `process.exit(1)` in produzione, ma solo dopo che il fallback è già stato valutato. In development il fallback rimane attivo.
**Priorità: 🔴 Alta**

---

### 1.2 Rate limiting mancante su endpoint sensibili
**File:** `server.js`, righe 906, 4496
**Problema:** `/api/imposta-password` (reset password via token) e `/api/push/subscribe` non hanno rate limiter. Il primo espone l'enumerazione di token di setup; il secondo permette il flood della tabella `push_subscriptions`.
```js
const impostaPassLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const pushSubLimiter     = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });

app.post('/api/imposta-password', impostaPassLimiter, async (req, res) => { ... });
app.post('/api/push/subscribe',   pushSubLimiter,     async (req, res) => { ... });
```
**Priorità: 🔴 Alta**

---

### 1.3 Nessun rate limiter globale sulle API
**File:** `server.js`
**Problema:** Solo login, registrazione, iscrizioni e contatti hanno limiter. Non esiste un limiter globale su `/api/*` che protegga da DoS o abuso generalizzato.
```js
// Aggiungere dopo app.use(express.json()):
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', apiLimiter);
```
**Priorità: 🟡 Media**

---

### 1.4 HSTS non configurato esplicitamente
**File:** `server.js`, riga 177
**Problema:** `helmet()` è usato correttamente, ma HSTS non è configurato esplicitamente con `maxAge` lungo.
```js
app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  // ... resto della config
}));
```
**Priorità: 🟡 Media**

---

### 1.5 CSP: `unsafe-inline` su scriptSrc
**File:** `server.js`, riga 182
**Problema:** La policy CSP include `'unsafe-inline'` in `scriptSrc` e `scriptSrcAttr`. Questo annulla la protezione XSS della CSP.
**Soluzione consigliata:** Generare un nonce per richiesta e iniettarlo negli script inline. Richiede refactoring delle pagine HTML.
**Priorità: 🟡 Media**

---

### 1.6 Token Bearer ancora accettato come fallback
**File:** `server.js`, riga 388
**Problema:** L'autenticazione via `Authorization: Bearer` header è mantenuta come "fallback per compatibilità". Mantenere due meccanismi aumenta la superficie d'attacco. Se il frontend non lo usa più, va rimosso.
**Priorità: 🟡 Media**

---

## 2. Qualità del Codice

### 2.1 server.js monolitico da 4807 righe
**File:** `server.js`
**Problema:** Tutta la logica è in un unico file: email (Brevo/Gmail), scraping FIPAV, scheduler, shop/Stripe, push notifications, tornei, autenticazione. Test unitari sono praticamente impossibili.
**Soluzione consigliata:** Estrarre in moduli:
```
routes/
  auth.js, shop.js, calendario.js, tornei.js, admin.js
services/
  email.js, fipav.js, push.js
```
**Priorità: 🟡 Media**

---

### 2.2 Handler di route molto lunghi
**File:** `server.js`
**Problema:** L'handler `POST /api/admin/utenti/:id/approva` è ~234 righe (riga 486–720). Mescola logica DB, generazione email, logica di business e gestione HTTP.
**Soluzione:** Estrarre la logica in funzioni pure `async` chiamabili separatamente.
**Priorità: 🟡 Media**

---

### 2.3 Gestione errori inconsistente
**File:** `server.js`
**Problema:** Alcuni catch loggano l'errore, altri no. Nessun middleware di error handling globale. Alcuni errori sono silenti (`catch(_){}`).
```js
// Aggiungere in fondo a server.js, prima di app.listen:
app.use((err, req, res, _next) => {
  console.error('[Unhandled Error]', req.method, req.path, err);
  res.status(500).json({ error: 'Errore interno del server.' });
});
```
**Priorità: 🟡 Media**

---

### 2.4 File `db 2.js` residuo
**File:** `db 2.js`
**Problema:** Copia vecchia di `db.js` con 8 migrazioni mancanti. Non è referenziata da nessun file, ma è fonte di confusione.
**Soluzione:** `git rm "db 2.js"`
**Priorità: 🟢 Bassa**

---

### 2.5 Uso di `var` nel codice frontend
**File:** `common.js`, `shared.js`
**Problema:** 17 occorrenze di `var` nei file JS frontend, che crea scoping imprevedibile.
**Soluzione:** Sostituire meccanicamente con `const`/`let` (verificare prima le riassegnazioni).
**Priorità: 🟢 Bassa**

---

## 3. Performance

### 3.1 CSS inline massiccio in ogni pagina HTML
**File:** `index.html` (3399 righe), `notizie.html` (823 righe), `shop.html` (936 righe), ecc.
**Problema:** Ogni pagina ha un unico blocco `<style>` con centinaia di regole che duplicano parzialmente `common.css`. Non vengono cachati separatamente dal browser.
**Soluzione:** Estrarre gli stili page-specific in file `.css` separati (`index.css`, `shop.css`, ecc.) e includerli con `<link rel="stylesheet">`.
**Priorità: 🟡 Media**

---

### 3.2 Nessun maxAge su express.static
**File:** `server.js`, riga 323
**Problema:** `express.static` senza `maxAge`. Tutti gli asset statici vengono rivalidati ad ogni richiesta.
```js
// Consigliato
app.use(express.static(path.join(__dirname), {
  maxAge: '7d',
  etag: true,
}));
```
**Priorità: 🟡 Media**

---

### 3.3 Service worker senza precaching
**File:** `sw.js`
**Problema:** Il service worker gestisce solo push notifications. Non implementa nessuna strategia di caching per shell applicativa, CSS o immagini. Su mobile le performance offline sono zero.
**Soluzione:** Aggiungere precaching per `common.css`, `common.js`, logo:
```js
const CACHE = 'vc-v1';
const PRECACHE = ['/common.css', '/common.js', '/images/negativo@4x.png'];
self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)))
);
self.addEventListener('fetch', e => {
  if (e.request.destination === 'document') return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
```
**Priorità: 🟢 Bassa**

---

### 3.4 Query DB multiple sequenziali in `/api/profilo`
**File:** `server.js`, riga 513
**Problema:** L'endpoint esegue 3 query DB sequenziali separate. Le ultime due leggono sempre dalla stessa tabella `impostazioni` e potrebbero essere cachate o accorpate.
**Priorità: 🟢 Bassa**

---

## 4. SEO e Accessibilità

### 4.1 12 pagine senza meta description né OG tags
**Problema:** Le seguenti pagine non hanno `<meta name="description">` né Open Graph:

| Pagina | Tipo | Azione |
|---|---|---|
| `login.html` | Pubblica | Aggiungere meta + `noindex` |
| `imposta-password.html` | Pubblica | Aggiungere meta + `noindex` |
| `ordine-confermato.html` | Pubblica | Aggiungere meta + `noindex` |
| `utente.html` | Loggato | `noindex, nofollow` |
| `convocazioni.html` | Loggato | `noindex, nofollow` |
| `documenti-utente.html` | Loggato | `noindex, nofollow` |
| `comunicazioni-utente.html` | Loggato | `noindex, nofollow` |
| `eventi-tornei-utente.html` | Loggato | `noindex, nofollow` |
| `calendario-utente.html` | Loggato | `noindex, nofollow` |
| `admin.html` | Admin | `noindex, nofollow` |
| `gestione-atleti.html` | Admin | `noindex, nofollow` |
| `gestione-squadra.html` | Admin | `noindex, nofollow` |

**Priorità: 🟡 Media**

---

### 4.2 Struttura heading nelle pagine utente
**Problema:** Alcune pagine dell'area utente usano `<h2>` come primo heading, saltando `<h1>`. Ogni pagina dovrebbe avere esattamente un `<h1>`.
**Priorità: 🟢 Bassa**

---

## 5. Funzionalità e UX

### 5.1 `/api/push/subscribe` senza autenticazione
**File:** `server.js`, riga 4496
**Problema:** Qualsiasi visitatore non autenticato può registrare una push subscription. Non c'è associazione alla sessione utente.
**Soluzione:** Aggiungere `userAuth` come middleware, oppure almeno il rate limiter stretto (vedi §1.2).
**Priorità: 🟡 Media**

---

## 6. Dipendenze

Tutte le dipendenze principali sono recenti. Nessuna vulnerabilità critica nota.

| Pacchetto | Versione | Note |
|---|---|---|
| `express` | ^4.18.2 | Express 5 stabile disponibile — migrazione opzionale |
| `jsonwebtoken` | ^9.0.3 | ✅ |
| `bcryptjs` | ^3.0.3 | ✅ |
| `helmet` | ^8.1.0 | ✅ |
| `stripe` | ^21.0.1 | ✅ |
| `@supabase/supabase-js` | ^2.104.0 | ✅ |
| `pg` | ^8.11.0 | pg v9 disponibile — nessuna urgenza |

**Azione:** Eseguire `npm audit` periodicamente.
**Priorità: 🟢 Bassa**

---

## 7. Infrastruttura e Deploy

### 7.1 Variabili d'ambiente non documentate
**Problema:** Non esiste un file `.env.example`. Le variabili necessarie (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BREVO_API_KEY, VAPID_PUBLIC_KEY, ecc.) sono sparse nel codice.
**Soluzione:** Creare `.env.example` con tutte le variabili commentate.
**Priorità: 🟡 Media**

---

### 7.2 Logging non strutturato
**Problema:** Il logging usa `console.log`/`console.error` direttamente. Su Railway non è possibile filtrare per livello.
**Soluzione:** Introdurre `pino` (zero-dipendenze, performante): `const logger = require('pino')({ level: process.env.LOG_LEVEL || 'info' })`.
**Priorità: 🟢 Bassa**

---

### 7.3 healthcheckTimeout potenzialmente insufficiente al primo boot
**File:** `railway.json`
**Problema:** `healthcheckTimeout: 60` può non bastare al primo deploy quando le migrazioni ALTER TABLE sono numerose.
**Soluzione:** Aumentare a 120 secondi o separare la fase di migrazione dal boot.
**Priorità: 🟢 Bassa**

---

## Tabella Riepilogativa

| # | Area | Problema | File / Riga | Priorità |
|---|---|---|---|---|
| 1 | Sicurezza | JWT_SECRET con fallback hardcoded | server.js:29 | 🔴 Alta |
| 2 | Sicurezza | Rate limit mancante su /api/imposta-password e /api/push/subscribe | server.js:906,4496 | 🔴 Alta |
| 3 | Sicurezza | Nessun rate limiter globale su /api/* | server.js | 🟡 Media |
| 4 | Sicurezza | HSTS non configurato esplicitamente | server.js:177 | 🟡 Media |
| 5 | Sicurezza | CSP con unsafe-inline in scriptSrc | server.js:182 | 🟡 Media |
| 6 | Sicurezza | Token Bearer accettato come fallback (da valutare rimozione) | server.js:388 | 🟡 Media |
| 7 | Qualità | server.js monolitico da 4807 righe | server.js | 🟡 Media |
| 8 | Qualità | Handler route > 200 righe | server.js:486 | 🟡 Media |
| 9 | Qualità | Gestione errori inconsistente, nessun middleware globale | server.js | 🟡 Media |
| 10 | Qualità | File `db 2.js` residuo | db 2.js | 🟢 Bassa |
| 11 | Qualità | Uso di `var` nel frontend | common.js, shared.js | 🟢 Bassa |
| 12 | Performance | CSS inline massiccio in ogni HTML | *.html | 🟡 Media |
| 13 | Performance | Nessun maxAge su express.static | server.js:323 | 🟡 Media |
| 14 | Performance | Service worker senza precaching | sw.js | 🟢 Bassa |
| 15 | Performance | 3 query sequenziali in /api/profilo | server.js:513 | 🟢 Bassa |
| 16 | SEO | 12 pagine senza meta description / OG tags | *.html | 🟡 Media |
| 17 | SEO | Manca noindex sulle pagine admin/utente | admin.html, utente.html ecc. | 🟡 Media |
| 18 | Accessibilità | Heading h1 mancante in pagine utente | *.html | 🟢 Bassa |
| 19 | UX/API | /api/push/subscribe senza autenticazione | server.js:4496 | 🟡 Media |
| 20 | Infrastruttura | Nessun file .env.example | — | 🟡 Media |
| 21 | Infrastruttura | Logging non strutturato | server.js | 🟢 Bassa |
| 22 | Infrastruttura | healthcheckTimeout potenzialmente basso | railway.json | 🟢 Bassa |
| 23 | Dipendenze | Express 4 (Express 5 disponibile) | package.json | 🟢 Bassa |

---

*Report generato automaticamente — Virtus Caserta Weekly Review — 2026-06-01*
