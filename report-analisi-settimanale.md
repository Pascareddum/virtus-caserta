# Report Analisi Settimanale — Virtus Caserta

**Data analisi:** 6 luglio 2026  
**File analizzati:** server.js (5297 righe), db.js (568 righe), common.js (380 righe), shared.js (215 righe), sw.js, package.json, railway.json, 25 pagine HTML

---

## Riepilogo Esecutivo

I 5 punti critici principali:

1. **🔴 Bug persistente (non risolto dalla settimana scorsa):** `common.js` scrive `data.token/role/nome` nel localStorage dopo login, ma il server risponde con `{ user: {...} }` — i valori sono tutti `undefined`. Il footer non mostra mai il nome utente.
2. **🔴 SSRF parziale in `/api/proxy-image`:** Il controllo regex `isFipav` determina solo il Referer, non blocca la fetch verso URL arbitrari (inclusi host interni).
3. **🔴 2 vulnerabilità HIGH nelle dipendenze:** `multer` e `nodemailer` hanno CVE gravi risolvibili con `npm audit fix`.
4. **🟡 CSP con `'unsafe-inline'` su scriptSrc:** Annulla le protezioni XSS fornite dalla Content Security Policy.
5. **🟡 JWT utente con scadenza 120 giorni senza revoca:** Token compromessi rimangono validi 4 mesi senza possibilità di invalidarli.

---

## 1. Sicurezza

### 1.1 Bug autenticazione — localStorage stores `undefined` dopo login
**Priorità: 🔴 Alta**

- **File:** `common.js`, righe 292–294 e 317–319
- **Problema:** Dopo un login riuscito, il client scrive `data.token`, `data.role`, `data.nome` nel localStorage. Ma il server risponde con `{ user: { id, nome, cognome, email } }` — non esiste un campo `token` o `role` nella risposta. Tutti e tre i valori salvati sono `"undefined"`. Il footer non mostra mai il nome dell'utente, e la navbar non aggiorna correttamente lo stato loggato.
- **Codice attuale (`common.js` riga 289–294):**
  ```js
  const res  = await fetch('/api/login', { ... });
  const data = await res.json();
  if (!res.ok) { errEl.textContent = data.error; return; }
  localStorage.setItem('vc_token', data.token);   // undefined!
  localStorage.setItem('vc_role',  data.role);    // undefined!
  localStorage.setItem('vc_nome',  data.nome);    // undefined!
  ```
- **Risposta server (`server.js` riga 527):**
  ```js
  res.json({ user: { id: u.id, nome: u.nome, cognome: u.cognome, email: u.email } });
  ```
- **Soluzione:**
  ```js
  const data = await res.json();
  if (!res.ok) { errEl.textContent = data.error; return; }
  const { nome } = data.user;
  localStorage.setItem('vc_nome', nome);
  localStorage.setItem('vc_role', 'utente');
  // Il token JWT è già nel cookie httpOnly — non serve in localStorage
  ```

---

### 1.2 SSRF parziale in `/api/proxy-image`
**Priorità: 🔴 Alta**

- **File:** `server.js`, righe 4102–4125
- **Problema:** Il controllo `isFipav = /portalefipav|fipavcampania/i.test(url)` serve solo a scegliere il valore del header `Referer`, **non** a bloccare la richiesta. Un URL come `http://169.254.169.254/latest/meta-data?x=portalefipav` supera il test regex e fa comunque fetch verso qualsiasi host. Stessa cosa per risorse interne Railway (es. `http://localhost:5432`).
- **Codice attuale:**
  ```js
  const isFipav = /portalefipav|fipavcampania/i.test(url);
  const imgRes = await fetch(url, { ... }); // nessuna validazione del dominio!
  ```
- **Soluzione — allowlist esplicita:**
  ```js
  const ALLOWED_ORIGINS = [
    'portalefipav.net',
    'fipavcampania.it',
    'opespallavolo.it',
    'cdninstagram.com',
    'instagram.com',
  ];
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return res.status(400).json({ error: 'URL non valido' }); }
  if (!ALLOWED_ORIGINS.some(h => parsedUrl.hostname.endsWith(h))) {
    return res.status(403).json({ error: 'Dominio non consentito' });
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Protocollo non consentito' });
  }
  ```

---

### 1.3 Vulnerabilità HIGH nelle dipendenze
**Priorità: 🔴 Alta**

- **File:** `package.json`
- **Problema:** `npm audit` segnala 2 vulnerabilità di gravità HIGH:
  - **multer ≤2.1.1** — DoS via field names profondamente annidati (GHSA-72gw-mp4g-v24j) e cleanup incompleto degli upload abortiti (GHSA-3p4h-7m6x-2hcm).
  - **nodemailer ≤9.0.0** — CRLF injection nei header (GHSA-268h-hp4c-crq3), bypass validazione TLS OAuth2 (GHSA-r7g4-qg5f-qqm2), lettura arbitraria di file locali via opzione `raw` (GHSA-p6gq-j5cr-w38f).
- **Soluzione immediata:**
  ```bash
  npm audit fix
  ```
  Verificare manualmente che upload immagini e invio email funzionino dopo l'aggiornamento.

---

### 1.4 Content Security Policy con `'unsafe-inline'` su scriptSrc
**Priorità: 🟡 Media**

- **File:** `server.js`, righe 181–182
- **Problema:** La direttiva `scriptSrc: ["'self'", "'unsafe-inline'"]` annulla la protezione XSS della CSP: un attaccante che riesce ad iniettare HTML può eseguire script inline arbitrari.
- **Soluzione a lungo termine:** Sostituire gli script inline nelle pagine HTML con file `.js` esterni e rimuovere `'unsafe-inline'`. Nel breve termine, usare nonce per-request:
  ```js
  const nonce = crypto.randomBytes(16).toString('base64');
  // Passare il nonce al template e aggiungerlo ai tag <script>
  scriptSrc: ["'self'", `'nonce-${nonce}'`]
  ```

---

### 1.5 JWT utente con scadenza 120 giorni senza meccanismo di revoca
**Priorità: 🟡 Media**

- **File:** `server.js`, riga 520
- **Problema:** I token utente hanno `expiresIn: '120d'`. Non esiste una blocklist o un campo `jti` nel database. Se un account viene compromesso o un utente viene disattivato, il suo token rimane valido per 4 mesi.
- **Soluzione consigliata:** Ridurre la scadenza e verificare lo stato dell'utente nel middleware `userAuth`:
  ```js
  // In userAuth — aggiungere dopo jwt.verify():
  const u = await db.query('SELECT stato FROM utenti WHERE id=$1', [payload.id]);
  if (!u.rows.length || u.rows[0].stato !== 'attivo') {
    res.clearCookie('vc_user_session');
    return res.status(401).json({ error: 'Account non attivo.' });
  }
  ```

---

### 1.6 Nessun rate limiter globale sugli endpoint di lettura
**Priorità: 🟡 Media**

- **File:** `server.js`
- **Problema:** Endpoint pubblici come `/api/squadra`, `/api/notizie`, `/api/calendario`, `/api/sponsor`, `/api/risultati` non hanno rate limiting. Un bot può fare scraping o causare overload del DB senza restrizioni.
- **Soluzione:**
  ```js
  const globalReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', globalReadLimiter);
  // I limiter specifici (loginLimiter, contactLimiter, ecc.) fanno override automaticamente
  ```

---

## 2. Qualità del Codice

### 2.1 CSS `:root` duplicato in 10 file HTML
**Priorità: 🟡 Media**

- **File:** admin.html, calendario.html, chiSiamo.html, index.html, live.html, notizie.html, privacy.html, progetti.html, shop.html, sponsor.html
- **Problema:** Ogni pagina ridefinisce inline le variabili CSS (es. `--blu: #0d2055`, `--arancio: #f57c00`). Un rebranding richiede modifiche manuali su 10+ file. `common.css` esiste ma non contiene il blocco `:root`.
- **Soluzione:** Spostare il blocco `:root { ... }` in `common.css` e rimuovere le definizioni duplicate dalle singole pagine HTML.

### 2.2 Funzioni route molto lunghe in server.js
**Priorità: 🟢 Bassa**

- **File:** `server.js`
- **Funzioni più lunghe rilevate:**
  - `/api/profilo/prossimi` — 191 righe (aggregazione allenamenti + partite FIPAV + OPES + tornei)
  - `/api/richiesta-ordine` — 164 righe (HTML email + logica ordine + invio)
  - `/api/contact` — 129 righe (due template email + invio parallelo)
- **Soluzione:** Estrarre la generazione degli HTML email in funzioni dedicate (es. `buildContactEmailAdmin(data)`) e la logica di aggregazione eventi in un modulo separato.

### 2.3 Pool DB senza limite di connessioni configurato
**Priorità: 🟡 Media**

- **File:** `db.js`, riga 38
- **Problema:** Il `Pool` di `pg` è istanziato senza specificare `max`. Il default è 10 connessioni. Su Railway/Supabase (piano free) il limite di connessioni concorrenti è basso — rischio di errore `too many clients` sotto carico.
- **Soluzione:**
  ```js
  // In buildPoolConfig(), aggiungere a ogni oggetto di configurazione restituito:
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ```

---

## 3. Performance

### 3.1 Immagini senza lazy loading in index.html
**Priorità: 🟡 Media**

- **File:** `index.html`
- **Problema:** 24 tag `<img>` nella home page, di cui solo 5 hanno `loading="lazy"`. Le 19 rimanenti vengono caricate tutte al primo render, impattando il LCP.
- **Soluzione:** Aggiungere `loading="lazy"` a tutte le immagini sotto il fold:
  ```html
  <img src="/images/team.jpg" alt="Squadra" loading="lazy" width="800" height="600">
  ```

### 3.2 Service Worker con cache version statica
**Priorità: 🟢 Bassa**

- **File:** `sw.js`, riga 1
- **Problema:** `const CACHE_NAME = 'vc-v1'` non cambia mai tra deploy. Il SW attuale gestisce solo push notifications (nessun caching di asset), quindi l'impatto è contenuto — ma va risolto prima di aggiungere strategia di caching.
- **Soluzione:** Aggiornare il valore ad ogni deploy significativo:
  ```js
  const CACHE_NAME = 'vc-v1-20260706';
  ```

---

## 4. SEO e Accessibilità

### 4.1 Pagine pubbliche senza `<meta name="description">`
**Priorità: 🟡 Media**

- **Pagine interessate:** login.html, ordine-confermato.html (le altre 11 sono pagine private — corretto non indicizzarle)
- **Soluzione:**
  ```html
  <!-- login.html -->
  <meta name="description" content="Accedi al tuo account Virtus Caserta ASD.">
  <meta name="robots" content="noindex">

  <!-- ordine-confermato.html -->
  <meta name="robots" content="noindex, nofollow">
  ```

### 4.2 Immagini senza attributo `alt`
**Priorità: 🟡 Media**

- **Totale:** 22 immagini su 5 file
  - `admin.html` — 16 | `index.html` — 2 | `eventi-tornei-utente.html` — 2 | `notizie.html` — 1 | `calendario.html` — 1
- **Problema:** Viola WCAG 2.1 Livello A. Compromette screen reader e audit accessibilità.
- **Soluzione:** `alt=""` per immagini decorative, testo descrittivo per immagini informative.

---

## 5. Funzionalità e UX

### 5.1 Footer utente non mostra il nome
**Priorità: 🔴 Alta**

Conseguenza diretta del bug §1.1. Il footer che dovrebbe mostrare "Ciao, [Nome]" non funziona mai perché `localStorage.getItem('vc_nome')` restituisce la stringa `"undefined"`.

### 5.2 Password minima 6 caratteri
**Priorità: 🟢 Bassa**

- **File:** `server.js`, riga 932
- **Soluzione:** Aumentare a 8 caratteri (NIST SP 800-63B):
  ```js
  if (password.length < 8) return res.status(400).json({ error: 'Password minimo 8 caratteri.' });
  ```

---

## 6. Dipendenze

### 6.1 Vulnerabilità HIGH in `multer` e `nodemailer`
_Vedi §1.3 — priorità 🔴 Alta. Fix: `npm audit fix`._

### 6.2 Express 4.x — Express 5 ora stabile
**Priorità: 🟢 Bassa**

Express 5.x è rilasciato come stabile. Migrazione non urgente ma da pianificare per miglioramenti nella gestione async e delle promesse.

---

## 7. Infrastruttura e Deploy

### 7.1 Variabili d'ambiente non documentate
**Priorità: 🟡 Media**

- **Problema:** Nessun `.env.example` nel repository. Le variabili richieste (almeno 18: `JWT_SECRET`, `ADMIN_PASSWORD`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BREVO_API_KEY`, `BREVO_FROM_EMAIL`, `EMAIL_ADMIN`, `BASE_URL`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_CHANNEL_NAME`, `PUSH_TEST_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_MAILTO`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) devono essere ricavate leggendo l'intero server.js.
- **Soluzione:** Creare `.env.example` con tutte le variabili commentate e aggiungerlo al `.gitignore`-safe (non include valori reali).

---

## Tabella Riepilogativa

| # | Problema | File:riga | Priorità |
|---|----------|-----------|----------|
| 1 | Bug login: localStorage scrive `undefined` → footer utente rotto | common.js:292 | 🔴 Alta |
| 2 | SSRF parziale in `/api/proxy-image` — no allowlist dominio | server.js:4102 | 🔴 Alta |
| 3 | Vulnerabilità HIGH: multer (DoS) e nodemailer (CRLF/SSRF/file read) | package.json | 🔴 Alta |
| 4 | CSP `'unsafe-inline'` in scriptSrc — annulla protezione XSS | server.js:181 | 🟡 Media |
| 5 | JWT utente 120gg senza revoca — compromissione lunga | server.js:520 | 🟡 Media |
| 6 | Nessun rate limiter globale su endpoint pubblici di lettura | server.js | 🟡 Media |
| 7 | CSS `:root` duplicato in 10 HTML — manutenzione difficile | *.html | 🟡 Media |
| 8 | Pool DB senza `max` configurato — rischio `too many clients` | db.js:38 | 🟡 Media |
| 9 | 19 immagini senza lazy loading in index.html | index.html | 🟡 Media |
| 10 | Variabili d'ambiente non documentate (nessun `.env.example`) | — | 🟡 Media |
| 11 | 22 immagini senza attributo `alt` su 5 pagine | *.html | 🟡 Media |
| 12 | `login.html` senza meta description né `noindex` | login.html | 🟡 Media |
| 13 | Password minima 6 caratteri (troppo debole) | server.js:932 | 🟢 Bassa |
| 14 | Service worker cache version statica (`vc-v1`) | sw.js:1 | 🟢 Bassa |
| 15 | Funzioni route >150 righe (bassa testabilità) | server.js | 🟢 Bassa |
| 16 | Express 4.x in uso (Express 5 ora stabile) | package.json | 🟢 Bassa |

---

## Confronto con report precedente (29 giugno 2026)

| Problema | Stato |
|----------|-------|
| Bug localStorage login (undefined) | ⚠️ Non risolto |
| SSRF `/api/proxy-image` | ⚠️ Non risolto |
| Chiave Supabase errata nell'upload admin | ✅ Non più rilevato (probabilmente risolto) |
| CSS `:root` duplicato in HTML | ⚠️ Non risolto |
| 13 pagine senza meta description | ⚠️ Parzialmente invariato |
| Vulnerabilità multer/nodemailer | 🆕 Nuovo rilevamento |
| Pool DB senza `max` configurato | 🆕 Nuovo rilevamento |
