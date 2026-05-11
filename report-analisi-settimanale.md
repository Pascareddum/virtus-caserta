# Report Analisi Settimanale — Virtus Caserta

**Data analisi:** 11 maggio 2026  
**Analizzato da:** Claude (automazione settimanale)  
**Progetto:** Virtus Caserta ASD — sito web istituzionale con shop, calendario, risultati FIPAV

---

## Riepilogo Esecutivo

I 5 punti critici principali emersi dall'analisi di questa settimana:

1. 🔴 **Credenziali hardcoded non risolte** — `JWT_SECRET` e `ADMIN_PASSWORD` hanno ancora valori di default insicuri (`'virtus_secret_2026_dev'` e `'virtus2026'`). Il problema era già segnalato nel report del 4 maggio e **non è ancora stato corretto**.
2. 🔴 **Vulnerabilità SSRF in `/api/proxy-image`** — L'endpoint accetta qualsiasi URL arbitrario senza whitelist e lo richiede dal server. Un attaccante può usarlo per interrogare servizi interni, metadati cloud, o scansionare la rete interna.
3. 🔴 **HTML injection non corretta nelle email di iscrizione** — `POST /api/iscrizioni` costruisce il body HTML dell'email interpolando direttamente `${nome}`, `${cognome}`, `${email}`, `${messaggio}` senza chiamare `esc()`, a differenza di tutti gli altri endpoint email. Problema già segnalato il 4 maggio, **non corretto**.
4. 🟡 **Nessun indice DB sulle colonne più interrogate** — Le tabelle `utenti`, `ordini` e `calendario` non hanno indici su `email`, `stato` e `data_str`. Con la crescita dei dati le query di ricerca degraderanno significativamente.
5. 🟡 **Date calendario memorizzate come `VARCHAR`** — La colonna `data_str` nella tabella `calendario` è di tipo `VARCHAR` invece di `DATE`, rendendo impossibili ordinamenti e filtri corretti per intervallo senza conversioni runtime.

---

## Stato correzioni dalla settimana precedente (4 maggio 2026)

| # | Problema segnalato | Stato |
|---|---|---|
| 1 | Credenziali hardcoded (JWT_SECRET, ADMIN_PASSWORD) | ❌ Non corretto |
| 2 | `err.message` esposto nelle risposte HTTP | ✅ Quasi risolto (rimane solo riga 2974 in `/api/admin/test-email`) |
| 3 | HTML injection email iscrizioni | ❌ Non corretto |
| 4 | CSS massivamente duplicato tra pagine | ❌ Non corretto |
| 5 | Service Worker incompleto (PWA) | ❌ Non corretto |

---

## 1. Sicurezza

### 1.1 Credenziali hardcoded — fallback insicuri (RIPETUTO)
**🔴 Alta priorità — `server.js` righe 29 e 397**

I valori di default sono presenti nel codice sorgente e pubblicamente visibili:

```js
// riga 29
const JWT_SECRET = process.env.JWT_SECRET || 'virtus_secret_2026_dev';

// riga 397
const adminPassword = process.env.ADMIN_PASSWORD || 'virtus2026';
```

Il blocco di verifica all'avvio (righe 23-27) logga un errore ma **non termina il processo** (`process.exit(1)` manca). Il server si avvia comunque con le credenziali di default.

**Soluzione:**
```js
// In cima al file, dopo dotenv.config():
if (process.env.NODE_ENV === 'production') {
  const mancanti = ['JWT_SECRET','ADMIN_PASSWORD','ADMIN_USERNAME'].filter(k => !process.env[k]);
  if (mancanti.length) { console.error('[FATALE] Variabili mancanti:', mancanti); process.exit(1); }
}
const JWT_SECRET = process.env.JWT_SECRET; // rimuovere || 'fallback'
```

---

### 1.2 SSRF (Server-Side Request Forgery) in `/api/proxy-image`
**🔴 Alta priorità — `server.js` righe 2542-2571**

L'endpoint accetta un parametro `url` arbitrario e lo richiede direttamente dal server senza validare il dominio di destinazione:

```js
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  // ❌ Nessuna whitelist: qualsiasi URL viene fetchato
  const imgRes = await fetch(url, { headers: { ... } });
```

Un attaccante può passare `url=http://169.254.169.254/latest/meta-data/` (AWS metadata), `url=http://localhost:3000/api/admin/utenti`, o URL di servizi interni. L'endpoint non ha rate limiting né autenticazione.

**Soluzione:**
```js
const PROXY_ALLOWED_HOSTS = [
  'portalefipav.net',
  'fipavcampania.it',
  'opespallavolo.it',
  'instagram.com',
  'cdninstagram.com',
];

app.get('/api/proxy-image', proxyLimiter, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).send('URL non valido'); }
  const allowed = PROXY_ALLOWED_HOSTS.some(h => parsed.hostname.endsWith(h));
  if (!allowed) return res.status(403).send('Host non autorizzato');
  // ...fetch continua normalmente
```

Aggiungere anche un rate limiter (es. 30 req/min per IP) su questo endpoint.

---

### 1.3 HTML injection nelle email di iscrizione (RIPETUTO)
**🔴 Alta priorità — `server.js` riga 2655**

```js
html: `<p><b>Nome:</b> ${nome} ${cognome}<br><b>Email:</b> ${email}<br>
       <b>Tel:</b> ${telefono || '—'}<br><b>Messaggio:</b> ${messaggio || '—'}</p>`,
```

I campi sono interpolati senza `esc()`. Un utente malintenzionato può iniettare HTML arbitrario nel corpo dell'email ricevuta dall'admin (phishing interno, link malevoli, contenuti fuorvianti).

**Soluzione:** sostituire con `esc(nome)`, `esc(cognome)`, `esc(email)`, `esc(messaggio)` — la funzione `esc()` è già definita nel file a riga 345.

---

### 1.4 Nessun rate limiting su `/api/push/subscribe` e `/api/imposta-password`
**🟡 Media priorità — `server.js` righe 2789 e 600**

- `/api/push/subscribe`: accetta qualsiasi endpoint senza autenticazione o rate limiting. Può essere usato per riempire la tabella `push_subscriptions` con dati arbitrari (DoS sul DB).
- `/api/imposta-password`: consente tentativi illimitati di indovinare token di setup (i token sono da 32 byte hex casuali, il rischio è basso ma la difesa dovrebbe esserci).

**Soluzione:**
```js
const pushLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Troppe sottoscrizioni.' } });
app.post('/api/push/subscribe', pushLimiter, async (req, res) => { ...

const impostaPasswordLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Troppi tentativi.' } });
app.post('/api/imposta-password', impostaPasswordLimiter, async (req, res) => { ...
```

---

### 1.5 CSP con `unsafe-inline` per gli script
**🟡 Media priorità — `server.js` righe 181-182**

```js
scriptSrc:     ["'self'", "'unsafe-inline'", ...],
scriptSrcAttr: ["'unsafe-inline'"],
```

`unsafe-inline` annulla gran parte della protezione XSS offerta dalla Content Security Policy. Se un attaccante riesce a iniettare anche solo un frammento HTML in una pagina, può eseguire JavaScript arbitrario.

**Soluzione a lungo termine:** estrarre tutti gli script inline (in ogni file HTML) in file `.js` separati e serviti staticamente, quindi rimuovere `unsafe-inline`. Alternativa rapida: usare nonces CSP generati per ogni request.

---

### 1.6 Password minima troppo corta
**🟢 Bassa priorità — `server.js` riga 604**

La password minima richiesta è di soli 6 caratteri:
```js
if (password.length < 6) return res.status(400).json({ error: 'Password minimo 6 caratteri.' });
```

Per un'applicazione con dati di atleti, ordini e calendario privato, il minimo raccomandato è 8 caratteri con verifica di complessità di base.

**Soluzione:**
```js
if (password.length < 8) return res.status(400).json({ error: 'Password minimo 8 caratteri.' });
// Opzionale: verifica presenza di almeno una cifra o carattere speciale
```

---

## 2. Qualità del codice

### 2.1 `Date.now().toString()` come chiave primaria
**🟡 Media priorità — multipli endpoint in `server.js`**

La generazione dell'ID con `const id = Date.now().toString()` è usata per prodotti, notizie, calendario, sponsor, risultati, galleria, iscrizioni. Questo crea rischi di collisione sotto carico concorrente (due inserimenti nello stesso millisecondo producono lo stesso ID) e comporta ID prevedibili e ordinabili (espone timing delle operazioni).

La tabella `utenti` usa correttamente `crypto.randomUUID()`. Portare lo stesso pattern a tutte le entità:
```js
const id = crypto.randomUUID(); // invece di Date.now().toString()
```

---

### 2.2 Email template HTML inline nel server
**🟡 Media priorità — `server.js`**

Il file contiene circa 500+ righe di HTML per template email direttamente nel codice server (email ordini, setup password, annullamenti, notifiche eventi, ecc.). Questo rende difficile la manutenzione e la modifica grafica delle email senza toccare la logica del server.

**Soluzione:** creare una cartella `templates/` con file `.html` per ogni tipo di email, caricarli con `fs.readFileSync` all'avvio e usare sostituzione di variabili con placeholder (es. `{{nome}}`).

---

### 2.3 `data_str` come `VARCHAR` invece di tipo `DATE`
**🟡 Media priorità — `db.js` righe 87 e 96**

Le tabelle `notizie`, `calendario` e `risultati` usano `data_str VARCHAR` per memorizzare date. Questo causa:
- Ordinamenti per data basati su ordinamento alfabetico (errato)
- Impossibilità di filtrare per intervallo con operatori `>` e `<` nativi
- Mancanza di validazione automatica del formato

**Soluzione:** migrare a `DATE NOT NULL`:
```sql
ALTER TABLE calendario ALTER COLUMN data_str TYPE DATE USING data_str::date;
ALTER TABLE notizie ALTER COLUMN data_str TYPE DATE USING data_str::date;
ALTER TABLE risultati ALTER COLUMN data_str TYPE DATE USING data_str::date;
```
Aggiornare le query in `server.js` di conseguenza (`.toISOString().slice(0,10)` per i valori inseriti).

---

### 2.4 Monolite: file troppo grandi
**🟢 Bassa priorità**

| File | Righe |
|------|-------|
| `server.js` | 3.064 |
| `admin.html` | 3.894 |
| `index.html` | 3.095 |

`server.js` mescola configurazione, middleware, route, business logic, parsing HTML di terze parti (FIPAV/OPES), scheduler e template email. È difficile da navigare, testare e modificare in modo sicuro.

**Soluzione a medio termine:** suddividere `server.js` in moduli separati:
- `routes/auth.js`, `routes/shop.js`, `routes/calendario.js`, ecc.
- `services/fipav.js`, `services/email.js`
- `schedulers/fipav.js`

---

## 3. Performance

### 3.1 Nessun indice DB sulle colonne più interrogate
**🟡 Media priorità — `db.js`**

Le seguenti colonne vengono filtrate frequentemente ma non hanno indici:

| Tabella | Colonna | Utilizzata in |
|---------|---------|---------------|
| `utenti` | `email` | login, register, reset password |
| `utenti` | `stato` | filtro utenti attivi per notifiche eventi |
| `ordini` | `stato` | reminder ordini non letti, export |
| `ordini` | `mail_letta` | reminder giornaliero |
| `calendario` | `data_str` | prossimi eventi, filtri frontend |
| `fipav_matches` | `fonte` | query aggregate per fonte |

**Soluzione:** aggiungere in `createTables()` di `db.js`:
```js
await query(`CREATE INDEX IF NOT EXISTS idx_utenti_email ON utenti (email)`);
await query(`CREATE INDEX IF NOT EXISTS idx_utenti_stato ON utenti (stato)`);
await query(`CREATE INDEX IF NOT EXISTS idx_ordini_stato ON ordini (stato)`);
await query(`CREATE INDEX IF NOT EXISTS idx_ordini_mail_letta ON ordini (mail_letta) WHERE mail_letta = false`);
await query(`CREATE INDEX IF NOT EXISTS idx_calendario_data ON calendario (data_str)`);
await query(`CREATE INDEX IF NOT EXISTS idx_fipav_fonte ON fipav_matches (fonte)`);
```

---

### 3.2 Immagini senza lazy loading
**🟡 Media priorità — pagine HTML**

Su `index.html` ci sono 23 tag `<img>` ma solo 5 usano `loading="lazy"`. Sulle pagine shop, squadra e notizie il rapporto è simile (1-2 lazy su 13-14 img). Le immagini above-the-fold bloccano il rendering iniziale.

**Soluzione:** aggiungere `loading="lazy"` a tutti i tag `<img>` che non sono visibili above-the-fold (es. foto squadra, gallery items, immagini notizie, loghi sponsor). Le immagini hero e logo di testata possono restare senza.

---

### 3.3 Service Worker incompleto — nessuna cache offline
**🟡 Media priorità — `sw.js`**

`sw.js` gestisce solo le notifiche push. Non è implementata nessuna strategia di caching (Cache-First, Stale-While-Revalidate, ecc.), quindi:
- Il sito non funziona offline nonostante sia registrato come PWA
- I file statici (CSS, JS, immagini) vengono richiesti al server ad ogni visita

**Soluzione:** estendere `sw.js` con una strategia base:
```js
const CACHE_NAME = 'vc-static-v1';
const STATIC_ASSETS = ['/common.css', '/common.js', '/images/logo.png', '/images/negativo@4x.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Cache-First per assets statici, Network-First per API
  if (e.request.url.includes('/api/')) return; // lascia passare le API
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
```

---

## 4. SEO e Accessibilità

### 4.1 URL nel sitemap.xml divergente dal dominio reale
**🟡 Media priorità — `robots.txt` e `sitemap.xml`**

`robots.txt` referenzia `https://virtus-caserta.it/sitemap.xml` ma il dominio produzione usato nelle email e nei link è `https://www.virtuscaserta.com`. Verificare e uniformare: il Google Search Console considererà il sitemap non valido se il dominio non corrisponde.

---

### 4.2 Mancano `og:description` su alcune pagine
**🟢 Bassa priorità**

Le pagine `calendario.html` e `risultati.html` hanno il meta `og:title` ma non `og:description`. Quando condivise su social, appariranno senza testo descrittivo.

**Soluzione:**
```html
<!-- in calendario.html -->
<meta property="og:description" content="Allenamenti, eventi e gare di Virtus Caserta ASD.">

<!-- in risultati.html -->
<meta property="og:description" content="Risultati, classifiche FIPAV e OPES di Virtus Caserta ASD.">
```

---

### 4.3 Nessun structured data (JSON-LD) per l'organizzazione
**🟢 Bassa priorità — `index.html`**

Google può mostrare rich results (pannello knowledge graph, breadcrumb, eventi) se il sito espone dati strutturati. Per una società sportiva il markup minimo sarebbe:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SportsOrganization",
  "name": "Virtus Caserta ASD",
  "url": "https://www.virtuscaserta.com",
  "sport": "Volleyball",
  "address": { "@type": "PostalAddress", "addressLocality": "Caserta", "addressCountry": "IT" }
}
</script>
```

---

## 5. Funzionalità e UX

### 5.1 Pulsante WhatsApp disabilitato
**🟢 Bassa priorità — `common.js` riga (IIFE WhatsApp)**

Il numero WhatsApp è una stringa vuota `const WA_NUMBER = '';`, quindi il pulsante floating non viene mai renderizzato. Se è intenzionale documentarlo, altrimenti impostare il numero della società.

---

### 5.2 Nessun meccanismo di revoca dei JWT utente
**🟡 Media priorità — `server.js`**

I token JWT degli utenti scadono dopo 24h ma non esistono meccanismi per revocarli anticipatamente (es. cambio password, logout forzato da admin). Se un account viene compromesso, il token resta valido fino alla scadenza naturale.

**Soluzione minima:** aggiungere alla tabella `utenti` una colonna `token_invalidato_at TIMESTAMPTZ` e verificarla in `userAuth`:
```js
// In userAuth, dopo jwt.verify:
const u = await db.query('SELECT token_invalidato_at FROM utenti WHERE id=$1', [payload.id]);
if (u.rows[0]?.token_invalidato_at && new Date(u.rows[0].token_invalidato_at) > new Date(payload.iat * 1000)) {
  return res.status(401).json({ error: 'Sessione scaduta. Effettua di nuovo il login.' });
}
```

---

## 6. Dipendenze

Dipendenze generalmente aggiornate e sane. Nessuna vulnerabilità critica nota identificata nelle versioni dichiarate.

| Pacchetto | Versione dichiarata | Note |
|-----------|-------------------|------|
| `express` | ^4.18.2 | Express 5 stabile da fine 2024 — migrazione non urgente ma consigliata |
| `jsonwebtoken` | ^9.0.3 | OK — versione corrente |
| `helmet` | ^8.1.0 | OK |
| `stripe` | ^21.0.1 | OK — aggiornato |
| `multer` | ^2.1.1 | OK |
| `bcryptjs` | ^3.0.3 | OK |

---

## 7. Infrastruttura e Deploy

### 7.1 Mancanza di file `.env.example`
**🟡 Media priorità**

Non esiste un file `.env.example` nel repository. Le variabili d'ambiente richieste sono disperse nel codice (`server.js` e `db.js`) e non sono documentate in un unico posto. In caso di deploy su un nuovo ambiente o onboarding di un nuovo sviluppatore, è necessario leggere l'intero `server.js` per capire quali variabili configurare.

**Variabili identificate nel codice:**

```
# Obbligatorie in produzione
JWT_SECRET=
ADMIN_PASSWORD=
ADMIN_USERNAME=
DATABASE_URL=

# Email (Brevo)
BREVO_API_KEY=
BREVO_FROM_EMAIL=
BREVO_SMTP_LOGIN=
BREVO_SMTP_KEY=
EMAIL_ADMIN=

# Storage
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_REGION=eu-central-1

# Push Notifications
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# Opzionali
INSTAGRAM_ACCESS_TOKEN=
BASE_URL=https://www.virtuscaserta.com
PORT=3000
NODE_ENV=production
```

**Soluzione:** creare un file `.env.example` con queste chiavi e valori placeholder da mantenere nel repository.

---

### 7.2 Nessun logging strutturato o monitoring
**🟢 Bassa priorità**

Tutto il logging avviene via `console.log`/`console.error`. In produzione su Railway i log sono disponibili solo nel pannello web e non sono ricercabili o aggregabili. Non esiste alerting automatico in caso di errori 5xx ripetuti.

**Soluzione a lungo termine:** integrare un logger strutturato come `pino` (leggero, compatibile con Node):
```js
const pino = require('pino');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
// Sostituire console.log con logger.info, console.error con logger.error
```

---

## Tabella riepilogativa

| # | Area | Problema | File | Priorità |
|---|------|----------|------|----------|
| 1.1 | Sicurezza | Credenziali hardcoded JWT/Admin (NON CORRETTO dalla settimana scorsa) | `server.js:29,397` | 🔴 Alta |
| 1.2 | Sicurezza | SSRF in `/api/proxy-image` — nessuna whitelist URL | `server.js:2542` | 🔴 Alta |
| 1.3 | Sicurezza | HTML injection email iscrizioni (NON CORRETTO dalla settimana scorsa) | `server.js:2655` | 🔴 Alta |
| 1.4 | Sicurezza | Nessun rate limiting su `/api/push/subscribe` e `/api/imposta-password` | `server.js:2789,600` | 🟡 Media |
| 1.5 | Sicurezza | CSP con `unsafe-inline` per script | `server.js:181` | 🟡 Media |
| 1.6 | Sicurezza | Password minima 6 caratteri | `server.js:604` | 🟢 Bassa |
| 2.1 | Qualità | `Date.now()` come PK — rischio collisioni | `server.js` (multipli) | 🟡 Media |
| 2.2 | Qualità | Template email HTML hardcoded nel server | `server.js` | 🟡 Media |
| 2.3 | Qualità | `data_str` come `VARCHAR` invece di `DATE` | `db.js:87,96` | 🟡 Media |
| 2.4 | Qualità | File monolitici troppo grandi | `server.js`, `admin.html` | 🟢 Bassa |
| 3.1 | Performance | Nessun indice DB su email, stato, data_str | `db.js` | 🟡 Media |
| 3.2 | Performance | Immagini senza `loading="lazy"` | Tutti gli HTML | 🟡 Media |
| 3.3 | Performance | SW.js senza caching — PWA incompleta | `sw.js` | 🟡 Media |
| 4.1 | SEO | URL sitemap divergente dal dominio reale | `robots.txt`, `sitemap.xml` | 🟡 Media |
| 4.2 | SEO | `og:description` mancante su calendario e risultati | `calendario.html`, `risultati.html` | 🟢 Bassa |
| 4.3 | SEO | Nessun JSON-LD structured data | `index.html` | 🟢 Bassa |
| 5.1 | UX | Pulsante WhatsApp disabilitato (`WA_NUMBER = ''`) | `common.js` | 🟢 Bassa |
| 5.2 | UX/Sicurezza | Nessuna revoca JWT utente | `server.js` | 🟡 Media |
| 7.1 | Infrastruttura | Nessun file `.env.example` | — | 🟡 Media |
| 7.2 | Infrastruttura | Logging solo via `console.log` | `server.js` | 🟢 Bassa |

---

*Report generato automaticamente — Analisi settimanale Virtus Caserta ASD*
