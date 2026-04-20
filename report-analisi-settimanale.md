# 📊 Report di Analisi Settimanale – Virtus Caserta

**Data analisi:** 20 aprile 2026
**Stack analizzato:** Node.js 18+ / Express 4 / PostgreSQL (Supabase) / Stripe / Nodemailer / deploy Railway
**Totale righe di codice analizzate:** ~10.200 (HTML + JS + CSS)

> Nota preliminare: il task richiedeva l'analisi di `render.yaml`, ma il progetto è deployato su **Railway** (`railway.json`). Le osservazioni sul deploy si riferiscono quindi a Railway.

---

## 🎯 Riepilogo esecutivo

Il codice è funzionalmente molto completo e pronto al Go Live del 30 aprile, ma presenta **alcune criticità di sicurezza bloccanti** e varie opportunità di pulizia/ottimizzazione. Ecco i 5 punti più urgenti:

1. 🔴 **La password admin viene confrontata in chiaro** (`crypto.timingSafeEqual` su stringhe padded). La libreria `bcryptjs` è installata ma inutilizzata. Inoltre esiste un **default hardcoded `'virtus2026'`** e un **`JWT_SECRET` di sviluppo hardcoded** che funziona in qualunque ambiente diverso da production.
2. 🔴 **`express.static(__dirname)` espone l'intera root del progetto**: `server.js`, `db.js`, `package.json`, `.env.example`, `daily-check-*.md` sono scaricabili pubblicamente da URL tipo `https://virtuscaserta.com/server.js`.
3. 🔴 **Nessun header di sicurezza HTTP**: manca Helmet/CSP/HSTS/X-Frame-Options/X-Content-Type-Options. Il progetto non è difeso contro clickjacking, MIME sniffing e injection di script esterni.
4. 🔴 **Feature "reset password" rotta**: `reset-password.html` chiama `POST /api/reset-password`, ma **la rotta non esiste** in `server.js`. Qualsiasi utente che riceva il link finirà su un errore 404.
5. 🟡 **CSS/JS massicciamente inline** (quasi 80 `<style>` inline su 18 pagine, `index.html` 2358 righe, `admin.html` 1607 righe). Zero caching cross-page, bundle non minificato, nessun build step. È la singola voce con l'impatto più alto su performance e manutenibilità.

Indice di priorità complessivo (vedi tabella finale): **11 criticità 🔴 Alta**, **17 🟡 Media**, **9 🟢 Bassa**.

---

## 1. 🔒 Sicurezza

### 1.1 Autenticazione admin in chiaro — 🔴 Alta
**File:** `server.js:215-234`
`bcryptjs` è in `package.json` ma non viene mai importato. Il confronto password avviene via `crypto.timingSafeEqual` su stringhe paddate a 64 byte: oltre a non essere una difesa contro l'estrazione del valore (la password è in `process.env.ADMIN_PASSWORD` in chiaro), troncare a 64 significa che `"password_lunghissima_ma_con_differenza_al_byte_70"` e `"password_lunghissima_ma_con_differenza_al_byte_70_X"` vengono considerate uguali.

**Fix consigliato:**
```js
// Pre-calcola hash bcrypt al boot (o prendilo già hashato dalla env)
const bcrypt = require('bcryptjs');
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH; // es. "$2b$12$..."
// All'avvio in dev: console.log(bcrypt.hashSync('virtus2026', 12));

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Campi obbligatori' });
  const validUser = username === process.env.ADMIN_USERNAME || username === process.env.ADMIN_EMAIL;
  const validPass = ADMIN_HASH && await bcrypt.compare(password, ADMIN_HASH);
  if (validUser && validPass) { /* firma JWT */ }
  ...
});
```
In alternativa (più manutenibile): spostare l'admin in una tabella `admin_users` con hash bcrypt per riga, così in futuro si possono avere più amministratori.

### 1.2 Default hardcoded di password/segreti — 🔴 Alta
**File:** `server.js:24`, `server.js:215-217`
```js
const JWT_SECRET = process.env.JWT_SECRET || 'virtus_secret_2026_dev';
const adminPassword = process.env.ADMIN_PASSWORD || 'virtus2026';
const validUser = username === (process.env.ADMIN_USERNAME || 'admin') || ...
```
Il check su `NODE_ENV === 'production'` (riga 20) impedisce lo startup solo se manca `JWT_SECRET`, ma non se mancano `ADMIN_PASSWORD`/`ADMIN_USERNAME`. Se Railway non ha queste variabili, il sito va in produzione con `admin`/`virtus2026`.

**Fix:** aggiungere al check iniziale anche `ADMIN_PASSWORD` e `ADMIN_USERNAME` (o `ADMIN_PASSWORD_HASH`). In dev, generare valori casuali una tantum invece di averli nel codice.

### 1.3 Directory listing / sorgenti esposti — 🔴 Alta
**File:** `server.js:167` → `app.use(express.static(path.join(__dirname)));`
Essendo la root di progetto, sono pubblicamente raggiungibili:
- `https://site/server.js` (con credenziali in chiaro se non si rimuove il default)
- `https://site/db.js`
- `https://site/package.json`, `/package-lock.json`
- `https://site/.env.example`
- `https://site/daily-check-2026-04-20.md` ← rivela TODO interni, note operative, strategie
- `https://site/railway.json`

**Fix consigliato:** spostare asset pubblici in una sottocartella `public/` e servire solo quella:
```js
// Struttura: public/index.html, public/shop.html, public/images/...
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
```
Soluzione tampone (poco elegante): aggiungere un middleware che blocca i pattern `.js`, `.json`, `.md`, `.env*`, `node_modules` dalla root prima di `express.static`.

### 1.4 Nessun header di sicurezza HTTP — 🔴 Alta
**File:** `server.js` (grep negativo su `Content-Security-Policy`, `helmet`, `X-Frame-Options`).
Nessuna CSP (scripts inline su tutte le pagine + script esterni di Stripe ammessi), nessun HSTS, nessun X-Content-Type-Options, nessun Referrer-Policy, Permissions-Policy, X-Frame-Options.

**Fix:**
```js
npm i helmet
// ---
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.stripe.com'],
      styleSrc:  ["'self'", "'unsafe-inline'"],
      imgSrc:    ["'self'", 'data:', 'https://*.fipav*', 'https://*.portalefipav.net', 'https://*.cdninstagram.com'],
      connectSrc:["'self'", 'https://api.stripe.com'],
      frameSrc:  ['https://js.stripe.com', 'https://hooks.stripe.com'],
    },
  },
  crossOriginEmbedderPolicy: false, // altrimenti rompe immagini esterne
}));
```
Se gli inline sono troppi per rimuoverli subito, iniziare con `Content-Security-Policy-Report-Only` e risolvere iterativamente.

### 1.5 Feature "reset password" non implementata — 🔴 Alta
**File:** `reset-password.html:67` chiama `POST /api/reset-password` → non esiste nessuna rotta del genere in `server.js`.
Analogamente non esiste un endpoint `POST /api/forgot-password` che spedisca il link con il token. Funzionalità dichiarata ma rotta.

**Fix (minimo):** decidere se la funzione serve davvero (solo un admin esiste: forse no). Se non serve:
- rimuovere `reset-password.html`, la rotta `/reset-password` e il redirect da `reset-password.html`.

Se serve:
- tabella `password_resets(token, user_id, expires_at, used_at)` con token random hash;
- endpoint `/api/forgot-password` + `/api/reset-password`;
- email via `nodemailer` con link firmato (JWT a breve scadenza o random + hash in DB).

### 1.6 Rate limiting con copertura insufficiente — 🟡 Media
**File:** `server.js:173`, `:1447`
Rate limit solo su `/api/admin/login` (10/15min) e `/api/iscrizioni` (5/h). Endpoint aperti al pubblico e facilmente abusabili restano scoperti:
- `POST /api/create-payment-intent` (costa soldi e aumenta il rischio di fraud score Stripe)
- `POST /api/send-order-email` (spam email, costo Gmail, rischio ban mittente)
- `POST /api/push/subscribe` (può gonfiare la tabella `push_subscriptions`)
- `GET /api/partite`, `/api/classifica/...` (scraping FIPAV/OPES, rischio di essere bannati come IP)

**Fix:**
```js
const globalApiLimiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use('/api/', globalApiLimiter);

const paymentLimiter = rateLimit({ windowMs: 15*60_000, max: 20 });
app.post('/api/create-payment-intent', paymentLimiter, ...);
app.post('/api/send-order-email', paymentLimiter, ...);
```

### 1.7 Injection HTML nelle email — 🟡 Media
**File:** `server.js:614, 696, 778-797, 1461`
I template email interpolano `${ordine.nome}`, `${nome}`, `${cognome}`, `${indirizzo}`, `${messaggio}` dentro `innerHTML` senza escaping. Un utente malintenzionato può salvare `<script>` o tag HTML nel campo "nome" o "messaggio" dell'iscrizione: il mittente sei tu, il destinatario è il cliente (o l'admin), e alcuni provider email renderizzano HTML.

**Fix:** piccola utility di escape e uso sistematico nei template:
```js
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// ---
<p>Ciao <strong>${esc(ordine.nome)}</strong>,</p>
```

### 1.8 Validazione input lato server assente — 🟡 Media
**File:** molti endpoint POST/PUT.
Si verifica solo la presenza dei campi obbligatori; nessun check su:
- formato email (`email` nei form e negli ordini)
- lunghezza massima dei campi (un "messaggio" da 5MB passa nel DB)
- valori numerici (`eta`, `prezzo`, `numero` giocatrici: parseInt su input malformato restituisce `NaN`)
- enum (`categoria`, `tipo` risultati, `livello` sponsor, `ruolo`…)

**Fix:** usare `zod` o `joi` (io preferisco zod per sintassi moderna):
```js
const { z } = require('zod');
const iscrizioneSchema = z.object({
  nome: z.string().min(1).max(60),
  cognome: z.string().min(1).max(60),
  email: z.string().email(),
  telefono: z.string().max(20).optional(),
  eta: z.coerce.number().int().min(3).max(99).optional(),
  messaggio: z.string().max(2000).optional(),
});
const data = iscrizioneSchema.parse(req.body);
```

### 1.9 Token admin in `localStorage` — 🟡 Media
**File:** `admin-login.html:87`, `admin.html:841,865,875`
Il token JWT admin è salvato sia in cookie (`httpOnly` + `sameSite:strict` — ok) sia in `localStorage`. Il cookie protegge la pagina, ma tutte le chiamate API passano il token in header `Bearer` estraendolo da `localStorage` → accessibile via XSS. Dato che il codice usa `innerHTML` in molti punti, il rischio non è teorico.

**Fix:** eliminare la copia in `localStorage`, autenticare le chiamate admin via cookie httpOnly e aggiungere CSRF token. Backend: middleware `adminAuth` che accetta anche il cookie `vc_admin_session` oltre al Bearer.

### 1.10 Multer: filter solo su mimetype dichiarato — 🟡 Media
**File:** `server.js:184-191`
`file.mimetype.startsWith('image/')` è controllato dal client: un attaccante può mandare `image/jpeg` a un `.exe`. Inoltre non c'è limite di numero file né rinomina sicura completa (path traversal difficile ma `file.originalname` viene parzialmente sanitizzato).

**Fix:** validare anche l'estensione (`/\.(jpe?g|png|webp|gif)$/i`), e, meglio, fare sniffing del magic number con `file-type`.

### 1.11 ID ordini prevedibili (`Date.now()`) — 🟢 Bassa
**File:** `server.js:486, 733, 1451...`
Gli ID sono timestamp. Un utente può enumerare ordini se scopre la route (le route admin sono protette, ma se un giorno si esponesse uno "stato ordine pubblico" per orderId il problema esplode). Passare a `crypto.randomUUID()` o `nanoid`.

### 1.12 `trust proxy` aggressivo — 🟢 Bassa
**File:** `server.js:52` → `app.set('trust proxy', 1);`
Railway è dietro proxy, quindi il valore 1 va bene, ma se un domani si sposta il deploy conviene usare `trust proxy: 'loopback, linklocal, uniquelocal'` o un valore esplicito.

---

## 2. 🧼 Qualità del codice

### 2.1 CSS massicciamente duplicato tra le pagine — 🔴 Alta
**File:** 18 file HTML hanno ciascuno un blocco `<style>` inline. Blocchi identici/quasi identici per navbar, footer, tipografia (es. navbar è ripetuta riga per riga tra `index.html`, `iscrizione.html`, `shop.html`, ecc.). `common.css` esiste ma contiene solo lo stile del drawer/hamburger.

**Fix:**
1. Estrarre in `common.css` tutta la parte condivisa: reset, variabili, navbar, footer, `.hero`, `.btn`, `.card`.
2. Mantenere nei file HTML solo lo stile davvero specifico della pagina.
3. Mettere la cache del browser a 7–30 giorni per `common.css` (vedi §3.1).

Beneficio stimato: ~40–50% di byte HTML in meno, caching fra pagine, modifiche centralizzate (cambio colore → un solo punto).

### 2.2 Pagine monolitiche con JS inline — 🟡 Media
**File:** `index.html` 2358 righe, `admin.html` 1607 righe, `shop.html` 990 righe.
- `admin.html` ha 123 dichiarazioni `let/const`, 31 `fetch(`, 25 blocchi `<script>` → è una SPA mascherata da HTML.
- `shop.html` idem, con 44 `let/const` e il flusso Stripe tutto dentro al `<script>` finale.

**Fix:** estrarre JS in `public/js/admin.js`, `public/js/shop.js`, `public/js/iscrizione.js`, ecc. Vantaggi: facilmente cachable, più leggibile, testabile, visibile nei diff git. Se si vuole evitare bundler, basta un banale `<script src="/js/admin.js" defer></script>`.

### 2.3 `innerHTML` diffuso con valori dinamici — 🟡 Media
**File:** 82 occorrenze di `innerHTML` in 12 file.
Molti template admin usano `innerHTML += "<tr>...${item.nome}..."`. `nome` proviene dal DB ma il DB contiene ciò che gli utenti inseriscono via form pubblico (es. iscrizioni). Vulnerabilità XSS stored quando l'admin rilegge il pannello.

**Fix:** preferire `textContent` per i valori e `createElement` + `append` per la struttura; oppure una piccola utility `html` che escapa per default.

### 2.4 Gestione errori backend inconsistente — 🟡 Media
**File:** `server.js` (tutto).
- Alcune rotte fanno `res.status(500).json({ error: err.message })` (fuga di dettagli interni al client).
- Altre usano `console.log` con il messaggio, altre `console.error`.
- Diverse `catch {}` silenziosi (es. `logActivity` r.500-503, `vcSubscribePush` in `common.js:151`, Instagram refresh token alternativo).

**Fix:**
- Un middleware di error handling centralizzato:
```js
app.use((err, req, res, next) => {
  console.error('[API]', req.method, req.path, err);
  res.status(err.status || 500).json({ error: err.publicMessage || 'Errore interno' });
});
```
- Wrappare le route async con `express-async-errors` o un `asyncHandler`.
- Non restituire mai `err.message` grezzo al client in produzione.

### 2.5 Route admin duplicate per `adminCookieCheck` e `adminAuth` — 🟡 Media
**File:** `server.js:114-125`, `:202-208`
`adminCookieCheck` (pagine) e `adminAuth` (API) fanno sostanzialmente la stessa verifica JWT ma in modo diverso (uno via cookie, l'altro via header). Centralizzare:
```js
function getAdminPayload(req) {
  const tok = req.cookies.vc_admin_session || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { return jwt.verify(tok, JWT_SECRET); } catch { return null; }
}
```
e derivarne i due middleware.

### 2.6 Commenti scarsi sulle funzioni più complesse — 🟢 Bassa
`parseFipavMatches` (r.1053-1165), `parseOpesHtml` (r.941-999), `fetchOpesTournament` (r.1001-1021), `parseOpesDate` (r.923) hanno regex impegnative senza JSDoc. Un minimo di `/** @param … @returns … */` aiuterebbe la manutenzione in caso di modifica del DOM delle fonti.

### 2.7 Manca linting/formatter automatico — 🟢 Bassa
Nessun `.eslintrc`, nessun `prettier`. Aggiungere:
```json
"scripts": { "lint": "eslint .", "format": "prettier -w ." }
```
così le PR future non si impantanano su style trivia.

### 2.8 Nessun test automatico — 🟢 Bassa
Non esiste `/test`. Per un e-commerce con pagamenti Stripe è una lacuna. Minimo consigliato: smoke test con `supertest` sulle API principali (+ mock Stripe), da eseguire in CI prima del deploy.

---

## 3. ⚡ Performance

### 3.1 CSS/JS inline → nessun caching — 🔴 Alta
Ogni navigazione riscarica l'intera pagina con tutto lo stile. Dato che gli stessi ~15–20 KB di CSS/navbar sono ripetuti in 18 file:
- byte in uscita inutili per ogni pageview (~300 KB totali),
- niente caching cross-page (il browser scarica CSS dall'HTML ogni volta),
- più banda usata su Railway.

**Fix:** vedi §2.1 + aggiungere `maxAge` in `express.static`:
```js
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
```

### 3.2 Nessuna compressione gzip/brotli — 🟡 Media
**File:** `server.js` (grep negativo su `compression`).
Senza compressione, la home da 79 KB viaggia invece che a 15–18 KB.

**Fix:**
```js
npm i compression
const compression = require('compression');
app.use(compression());
```

### 3.3 Caching FIPAV non simmetrico — 🟡 Media
**File:** `server.js:1175-1202`, `:836-892`
OPES ha cache TTL 1h, Instagram 2h, ma FIPAV (`fetchFipav` → chiamato ogni `/api/partite`) viene riscaricato ad ogni richiesta. Sotto carico basso su una pagina con auto-refresh è un problema: centinaia di richieste HTML alla FIPAV per utente sessione.

**Fix:** introdurre cache anche per FIPAV (TTL 10-15 minuti, bypassabile con `?refresh=1` da admin).

### 3.4 Service worker quasi vuoto — 🟡 Media
**File:** `sw.js` (14 righe).
Solo gestione push notification, nessun cache offline, nessuna strategia `staleWhileRevalidate` per gli asset. Per una PWA questo è il minimo sindacale.

**Fix base:**
```js
const CACHE = 'vc-v1';
const PRECACHE = ['/','/common.css','/common.js','/images/logo.png'];
self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(PRECACHE))
));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match('/')))
  );
});
```

### 3.5 Immagini non ottimizzate — 🟡 Media
Non c'è pipeline di resize/conversione WebP/AVIF. Un kit caricato dall'admin a 5MB serve la stessa copia a un mobile 320×320. Considerare:
- Ridimensionamento server-side con `sharp` al momento dell'upload (es. genera 320w, 720w, 1200w).
- Tag `<picture>` con sorgenti responsive.
- In alternativa, mettere le immagini su un CDN con resize on the fly (Cloudinary free tier, imgix, oppure Cloudflare Images).

### 3.6 Lazy loading coperto parzialmente — 🟢 Bassa
22 occorrenze di `loading="lazy"` su 12 file; `staff`, `squadra`, `galleria` le hanno ma molte immagini prodotto in `shop.html` no. Aggiungere `loading="lazy"` su tutte le immagini sotto il fold (+ `decoding="async"`).

### 3.7 Nessuna `ETag`/`Cache-Control` forte su `/uploads` — 🟢 Bassa
`app.use('/uploads', express.static(UPLOADS_DIR));` senza opzioni. I file caricati hanno un nome con timestamp → immutabili: si può impostare `maxAge: '1y', immutable: true`.

---

## 4. 🔍 SEO & ♿ Accessibilità

### 4.1 ARIA praticamente assente — 🔴 Alta
Solo `index.html` ha attributi `aria-*`/`role=`. Nelle altre 17 pagine: form senza `aria-describedby`, pulsanti-icona senza `aria-label`, messaggi di errore/successo non sono `role="status"` né `aria-live`.

**Fix prioritario:**
- `admin-login`, `reset-password`, `iscrizione`, `shop` (checkout): aggiungere `role="alert"` ai contenitori `.msg.err` e `role="status"` ai `.msg.ok`.
- Pulsanti con solo icona (hamburger in `common.js:11` ha `aria-label` — ok; social in footer no) → aggiungere `aria-label="Seguici su Instagram"` ecc.
- Form: ogni `<input>` dev'essere collegato ad `<label for>` (già fatto su iscrizione e reset-password — verificare su shop checkout).

### 4.2 Struttura heading disordinata — 🟡 Media
Pagine con più `<h1>`: `index.html` ne ha molti (hero + sezioni). Regola SEO: un solo `<h1>` per pagina; sezioni interne vanno in `<h2>`. Su `index.html` e `shop.html` vanno corretti.

### 4.3 Manca `<link rel="canonical">` — 🟡 Media
Nessuna pagina dichiara l'URL canonico. Siccome il sito ha sia `*.html` (redirect 301 → URL pulito) sia URL puliti, aggiungere canonical evita problemi di duplicate content:
```html
<link rel="canonical" href="https://www.virtuscaserta.com/shop">
```

### 4.4 Dati strutturati (JSON-LD) assenti — 🟡 Media
Per un'ASD sportiva Google ama `SportsOrganization`, `SportsTeam`, `Event` per calendario, `Product` per shop. Aggiungere in `<head>`:
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SportsOrganization",
  "name": "Virtus Caserta ASD",
  "url": "https://www.virtuscaserta.com",
  "logo": "https://www.virtuscaserta.com/images/logo.png",
  "sport": "Pallavolo",
  "address": { "@type": "PostalAddress", "addressLocality": "Caserta", "addressCountry": "IT" }
}
</script>
```
Stesso trattamento per le partite (`SportsEvent`) e i prodotti (`Product` con `offers`).

### 4.5 `sitemap.xml` fermo alla bozza — 🟡 Media
**File:** `sitemap.xml` (1686 byte, non rigenerato dal 14 aprile). Le URL pulite (`/chi-siamo`, `/notizie`, `/calendario`, `/shop` ecc.) non sono elencate con `lastmod` aggiornato, e mancano `galleria`, `classifica`, `staff`, `sponsor`, `iscrizione`.

**Fix:** piccolo script `scripts/build-sitemap.js` eseguito da `npm run build` che enumera le pagine statiche e legge la tabella `notizie` per aggiungere URL dinamiche (se in futuro ci saranno pagine di dettaglio).

### 4.6 `robots.txt` da verificare — 🟢 Bassa
Esiste (183 byte). Controllare che contenga `Sitemap: https://www.virtuscaserta.com/sitemap.xml` e un `Disallow: /admin`/`/api/`.

### 4.7 Meta `og:url` non sempre presente — 🟢 Bassa
`iscrizione.html` manca `og:url`; verificare su tutte le pagine.

---

## 5. 🧭 UX & funzionalità

### 5.1 "Reset password" rotto — 🔴 Alta
Vedi §1.5. Lato utente: il form parte, ma ogni submit mostra "Errore di rete" perché l'API 404 non ritorna JSON.

### 5.2 Iscrizione: nessuna email di conferma al mittente — 🟡 Media
**File:** `server.js:1448-1467`
Quando un utente compila il form di iscrizione, la mail parte solo all'admin. Il mittente non riceve nulla: non sa se il messaggio è andato. Aggiungere un'email di conferma e un messaggio su pagina: "Ti abbiamo inviato una copia a {email}".

### 5.3 Shop: nessuna conferma visiva di "Aggiunto al carrello" — 🟡 Media
`shop.html` ha il counter ma nessun toast/snackbar (verificare manualmente sulla pagina). Aggiungere un feedback ≈ 1.5s oppure un "mini cart" che si apre in basso a destra.

### 5.4 Admin: nessun undo per eliminazioni — 🟡 Media
`DELETE /api/admin/*` è hard-delete. Sconsigliato su ordini, notizie, prodotti. Aggiungere soft-delete (`deleted_at TIMESTAMPTZ`) o almeno un `confirm()` robusto con digitazione del nome.

### 5.5 Ordini: nessun tracking lato cliente — 🟡 Media
Il cliente riceve l'email ma non ha un link per vedere lo stato. Una semplice pagina `/ordine/:id?email=...` che valida email+id e mostra lo stato risolverebbe il ticket "Dov'è il mio ordine?".

### 5.6 Galleria: nessun albums filter visibile — 🟡 Media
API `/api/galleria?album=...` esiste (r.1413), ma `galleria.html` lo usa? Verificare UI. Se no, implementare filtro a tab.

### 5.7 Calendario: manca export iCal — 🟢 Bassa
Con la tabella `calendario` già strutturata è banale aggiungere `GET /api/calendario.ics` che restituisce il VCALENDAR e permettere "Aggiungi al tuo calendario Google/Apple".

### 5.8 Notifiche push: UI di abilitazione — 🟢 Bassa
`common.js:130` espone `vcSubscribePush()` ma non esiste un pulsante "Attiva notifiche" visibile; l'utente non ha modo di registrarsi. Aggiungere CTA in home o in footer.

### 5.9 Checkout con bonifico: nessuna scadenza — 🟢 Bassa
Nel template email appare un IBAN placeholder `IT00 X000 ...`. Dev'essere quello reale prima del Go Live. Inoltre nessun job marca automaticamente l'ordine "annullato" se il bonifico non arriva entro X giorni.

---

## 6. 📦 Dipendenze

### 6.1 `bcryptjs` installato ma mai importato — 🔴 Alta
Vedi §1.1. Usarlo o rimuoverlo.

### 6.2 `node-fetch@2.7.0` superato — 🟡 Media
Node 18+ ha `fetch` globale. `node-fetch@2` è ormai deprecato lato manutenzione e la v3 è ESM-only. Rimuoverlo:
```js
// in testa a server.js
- const fetch = require('node-fetch');
// (usa il globalThis.fetch già esistente su Node 18+)
```
Questo elimina una dipendenza di terze parti.

### 6.3 `express 4.22.1` — 🟢 Bassa
Express 5 è in stable. Il salto è compatibile al 90% ma non urgente. Pianificare il passaggio quando si tocca il middleware layer.

### 6.4 Nessun `npm audit` automatico — 🟡 Media
Aggiungere uno step CI `npm audit --omit=dev` e un Dependabot/Renovate config per Railway. Una vulnerabilità in `pg` o `stripe` non notificata diventa un rischio.

### 6.5 Aggiungere dipendenze mancanti — 🟡 Media
- `helmet` (§1.4)
- `compression` (§3.2)
- `zod` o `joi` (§1.8)
- `pino`/`winston` (§7.3)

---

## 7. 🛠 Infrastruttura & deploy

### 7.1 `render.yaml` inesistente — 🟢 Bassa (informativo)
Il task richiedeva l'analisi di `render.yaml`. Il progetto è su **Railway** (`railway.json` con healthcheck a `/health` e restart on failure configurato correttamente). Se in futuro si pianifica un fallback su Render, aggiungere un `render.yaml` minimale:
```yaml
services:
  - type: web
    name: virtus-caserta
    env: node
    plan: starter
    buildCommand: npm ci
    startCommand: node server.js
    healthCheckPath: /health
    autoDeploy: true
```

### 7.2 Variabili d'ambiente: documentazione incompleta — 🟡 Media
`.env.example` copre bene auth/email/Stripe/Instagram ma **manca**:
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (usate in `server.js:1579-1581`)
- `PAYPAL_CLIENT_ID` è elencata ma non esiste nessuna rotta PayPal lato server — o implementare o rimuovere.
- `SUPABASE_REGION` (usata in `db.js:21`)
- `EMAIL_ADMIN` (già presente, ma chiarire che deve essere separata da `EMAIL_USER`).

### 7.3 Logging non strutturato — 🟡 Media
`console.log('[Webhook] ...')` sparso ovunque. Su Railway la UI fatica a filtrare senza livelli e metadati.

**Fix:** `pino` con livelli (`info|warn|error`) e campo `module`:
```js
const pino = require('pino');
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
log.info({ module: 'stripe-webhook', orderId }, 'payment_intent.succeeded');
```

### 7.4 Nessun monitoring degli errori — 🟡 Media
Integrare Sentry (free tier generoso):
```js
const Sentry = require('@sentry/node');
Sentry.init({ dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV });
app.use(Sentry.Handlers.requestHandler());
// ... tutte le rotte ...
app.use(Sentry.Handlers.errorHandler());
```

### 7.5 Healthcheck ridondante — 🟢 Bassa
`app.get('/health', ...)` è definito due volte (riga 56 e 170). Il secondo non viene mai raggiunto, ma è confuso. Lasciarne uno solo.

### 7.6 Migrazione DB on-startup — 🟢 Bassa
`db.init()` (r.1641-1649) crea le tabelle e fa `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Accettabile a questa scala, ma non è idempotente su modifiche più complesse (rename, constraint). Valutare `node-pg-migrate` o Prisma per mantenere lo schema versionato.

### 7.7 Backup DB non menzionato — 🟡 Media
Supabase free tier ha backup limitati. Verificare che un dump quotidiano giri (`pg_dump` cron via Railway cron job o simile), soprattutto ora che stanno per arrivare pagamenti reali.

---

## 📋 Tabella riepilogativa

| # | Area | Punto | Priorità |
|---|------|-------|---------:|
| 1.1 | Sicurezza | Password admin in chiaro (bcryptjs inutilizzato) | 🔴 Alta |
| 1.2 | Sicurezza | JWT_SECRET/ADMIN_PASSWORD default hardcoded | 🔴 Alta |
| 1.3 | Sicurezza | `express.static` espone sorgenti (server.js, daily-check-*, ...) | 🔴 Alta |
| 1.4 | Sicurezza | Nessun header di sicurezza HTTP (no Helmet/CSP/HSTS/XFO) | 🔴 Alta |
| 1.5 | Sicurezza/UX | Feature reset-password rotta (rotta API assente) | 🔴 Alta |
| 1.6 | Sicurezza | Rate limiting solo su 2 endpoint | 🟡 Media |
| 1.7 | Sicurezza | Injection HTML nelle email (nessun escape) | 🟡 Media |
| 1.8 | Sicurezza | Validazione input (zod/joi) assente | 🟡 Media |
| 1.9 | Sicurezza | Token admin in `localStorage` (XSS) | 🟡 Media |
| 1.10 | Sicurezza | Multer: filtro solo su mimetype dichiarato | 🟡 Media |
| 1.11 | Sicurezza | ID ordini prevedibili (`Date.now()`) | 🟢 Bassa |
| 1.12 | Sicurezza | `trust proxy` valore da rivedere | 🟢 Bassa |
| 2.1 | Qualità | CSS duplicato in 18 pagine | 🔴 Alta |
| 2.2 | Qualità | Pagine monolitiche con JS inline (index.html 2358 rr.) | 🟡 Media |
| 2.3 | Qualità | `innerHTML` con valori dinamici (82 occorrenze) | 🟡 Media |
| 2.4 | Qualità | Gestione errori backend inconsistente | 🟡 Media |
| 2.5 | Qualità | Duplicazione `adminCookieCheck` / `adminAuth` | 🟡 Media |
| 2.6 | Qualità | Parser FIPAV/OPES senza JSDoc | 🟢 Bassa |
| 2.7 | Qualità | Manca ESLint/Prettier | 🟢 Bassa |
| 2.8 | Qualità | Nessun test automatico | 🟢 Bassa |
| 3.1 | Performance | CSS inline → niente caching cross-page | 🔴 Alta |
| 3.2 | Performance | Nessuna compressione gzip/brotli | 🟡 Media |
| 3.3 | Performance | FIPAV senza cache lato server | 🟡 Media |
| 3.4 | Performance | Service worker senza cache offline | 🟡 Media |
| 3.5 | Performance | Immagini non ottimizzate / nessun resize | 🟡 Media |
| 3.6 | Performance | Lazy loading parziale (shop) | 🟢 Bassa |
| 3.7 | Performance | `/uploads` senza `Cache-Control` forte | 🟢 Bassa |
| 4.1 | Accessibilità | ARIA assente su 17 pagine | 🔴 Alta |
| 4.2 | SEO | Struttura heading: più `<h1>` per pagina | 🟡 Media |
| 4.3 | SEO | Manca `<link rel="canonical">` | 🟡 Media |
| 4.4 | SEO | Dati strutturati JSON-LD assenti | 🟡 Media |
| 4.5 | SEO | `sitemap.xml` da rigenerare | 🟡 Media |
| 4.6 | SEO | `robots.txt` da verificare | 🟢 Bassa |
| 4.7 | SEO | `og:url` mancante su alcune pagine | 🟢 Bassa |
| 5.1 | UX | Reset password rotto (duplica 1.5) | 🔴 Alta |
| 5.2 | UX | Iscrizione senza email di conferma al mittente | 🟡 Media |
| 5.3 | UX | Shop senza toast "aggiunto al carrello" | 🟡 Media |
| 5.4 | UX | Admin: nessun undo / hard-delete | 🟡 Media |
| 5.5 | UX | Cliente senza tracking ordine | 🟡 Media |
| 5.6 | UX | Galleria senza filtro album visibile | 🟡 Media |
| 5.7 | UX | Calendario senza export iCal | 🟢 Bassa |
| 5.8 | UX | CTA "Attiva notifiche" mancante | 🟢 Bassa |
| 5.9 | UX | Bonifico: IBAN placeholder + nessuna scadenza | 🟢 Bassa |
| 6.1 | Dipendenze | `bcryptjs` installato ma inutilizzato (duplica 1.1) | 🔴 Alta |
| 6.2 | Dipendenze | `node-fetch@2` superato (usare fetch nativo) | 🟡 Media |
| 6.3 | Dipendenze | Express 4 → pianificare v5 | 🟢 Bassa |
| 6.4 | Dipendenze | Nessun `npm audit` automatico / Dependabot | 🟡 Media |
| 6.5 | Dipendenze | Mancano helmet / compression / zod / pino | 🟡 Media |
| 7.1 | Deploy | `render.yaml` inesistente (progetto su Railway) | 🟢 Bassa |
| 7.2 | Deploy | `.env.example` incompleto (VAPID/SUPABASE_REGION/PAYPAL) | 🟡 Media |
| 7.3 | Deploy | Logging non strutturato | 🟡 Media |
| 7.4 | Deploy | Nessun error monitoring (Sentry) | 🟡 Media |
| 7.5 | Deploy | Healthcheck duplicato | 🟢 Bassa |
| 7.6 | Deploy | Migrazioni DB senza tool dedicato | 🟢 Bassa |
| 7.7 | Deploy | Backup DB non documentato | 🟡 Media |

**Totale:** 11 🔴 Alta · 17 🟡 Media · 9 🟢 Bassa = **37 punti**

---

## 🧭 Proposta di ordine di intervento (10 giorni al Go Live)

**Oggi/domani (bloccanti per il Go Live):**
1. §1.1 + §6.1 — bcrypt sulla password admin
2. §1.2 — verificare che `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` siano impostate su Railway (e mai più usate come default)
3. §1.3 — spostare tutto in `public/` oppure aggiungere middleware che blocca sorgenti
4. §1.5 — rimuovere reset-password (o implementarlo completo)
5. §5.9 — IBAN reale al posto del placeholder

**Settimana 22–28 apr (importanti prima del Go Live):**
6. §1.4 — installare e configurare Helmet
7. §1.7 — escape HTML nei template email
8. §3.2 — aggiungere `compression`
9. §1.6 — rate limiting sui pagamenti e sulle email
10. §5.2 — email di conferma iscrizione al mittente

**Post Go Live (primo mese):**
11. §2.1 + §2.2 — estrazione CSS/JS in file dedicati (refactor graduale, una pagina alla volta)
12. §3.4 — service worker con cache offline
13. §4.4 + §4.3 — JSON-LD + canonical
14. §1.8 — zod sui form pubblici
15. §7.3 + §7.4 — logging strutturato + Sentry

---

*Report generato automaticamente da analisi settimanale – 20 aprile 2026*
