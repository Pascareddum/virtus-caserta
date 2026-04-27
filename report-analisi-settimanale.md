# 📊 Report Analisi Settimanale — Virtus Caserta
**Data:** 27 aprile 2026  
**Autore:** Analisi automatica settimanale  
**Scope:** Backend (server.js, db.js), Frontend (common.js, *.html), Infrastruttura

---

## 🔑 Riepilogo Esecutivo

I cinque punti critici principali emersi dall'analisi sono:

1. **🔴 SSRF in `/api/proxy-image`** — L'endpoint accetta URL arbitrari senza whitelist verificata, esponendo il server a richieste verso servizi interni (metadata cloud, localhost, subnet private).
2. **🔴 ID record prevedibili (timestamp-based)** — Tutti i record del DB usano `Date.now().toString()` come ID primario: enumerabili e non sicuri per endpoint pubblici.
3. **🟡 CSS/JS interamente inline** — Tutte le 15 pagine HTML hanno stili e logica embedded, impedendo il caching del browser e gonfiando i file (index.html = 92KB, admin.html = 98KB).
4. **🟡 ARIA e accessibilità quasi assenti** — Solo index.html ha 3 attributi aria-*; le altre 14 pagine ne sono prive.
5. **🟡 Dipendenze con major update disponibili** — Express 4→5, dotenv 16→17, stripe 21→22 meritano valutazione.

---

## 1. 🔐 Sicurezza

### 1.1 — SSRF nel proxy immagini
**Priorità:** 🔴 Alta

**Problema:** L'endpoint `GET /api/proxy-image?url=...` (server.js righe 1662–1683) accetta URL arbitrari da query string e li fetch lato server senza una whitelist vincolante. Il check attuale (`/portalefipav|fipavcampania/i.test(url)`) influenza solo il `Referer` header, non blocca richieste a URL non autorizzati. Un attaccante può passare `url=http://169.254.169.254/latest/meta-data/` (AWS metadata) o `url=http://localhost:5432` per sondare la rete interna.

**File:** `server.js` righe 1662–1683

**Soluzione consigliata:**
```js
const ALLOWED_PROXY_ORIGINS = [
  'https://caserta.portalefipav.net',
  'https://www.fipavcampania.it',
  'https://www.opespallavolo.it',
  'https://www.instagram.com',
  'https://scontent.cdninstagram.com',
];

app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).send('URL non valido'); }
  if (!['https:'].includes(parsed.protocol)) return res.status(400).send('Protocollo non consentito');
  if (!ALLOWED_PROXY_ORIGINS.some(o => url.startsWith(o))) {
    return res.status(403).send('URL non consentito');
  }
  // ... resto invariato
});
```

---

### 1.2 — ID record prevedibili (timestamp-based)
**Priorità:** 🔴 Alta

**Problema:** Tutti i record del database (notizie, prodotti, ordini, squadra, risultati, sponsor, iscrizioni, galleria) usano `Date.now().toString()` come chiave primaria (server.js righe 439, 452, 520, 626, 1696, 1743, 1765, 1812, 1850). Gli ID sono prevedibili e sequenziali: un utente malintenzionato potrebbe enumerare ordini di altri utenti o sondare dati non suoi tramite endpoint pubblici. Inoltre, inserimenti simultanei nello stesso millisecondo causano collisioni di chiave primaria con errore 500.

**File:** `server.js` (righe multiple)

**Soluzione consigliata:** Usare `crypto.randomUUID()` (già disponibile nel codebase) per tutti i nuovi record:
```js
// Sostituire ovunque:
const id = Date.now().toString();
// Con:
const id = crypto.randomUUID();
```

---

### 1.3 — Esposizione di `err.message` in produzione
**Priorità:** 🟡 Media

**Problema:** 52 endpoint restituiscono `res.status(500).json({ error: err.message })` direttamente. Questi messaggi possono rivelare dettagli interni (schema DB, nomi tabelle, errori di connessione) a utenti malintenzionati.

**File:** `server.js` (pattern diffuso)

**Soluzione consigliata:**
```js
function serverError(res, err) {
  console.error('[API Error]', err.message);
  const msg = process.env.NODE_ENV === 'production'
    ? 'Errore interno del server'
    : err.message;
  return res.status(500).json({ error: msg });
}
// Uso nei catch: catch (err) { serverError(res, err); }
```

---

### 1.4 — `/api/push/subscribe` privo di rate limiting
**Priorità:** 🟡 Media

**Problema:** L'endpoint `POST /api/push/subscribe` (server.js riga 1908) non ha un rate limiter dedicato. Un attaccante potrebbe inviare migliaia di subscription false gonfiando la tabella `push_subscriptions`.

**File:** `server.js` riga 1908

**Soluzione consigliata:**
```js
const pushLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Troppe richieste push. Riprova più tardi.' },
});
app.post('/api/push/subscribe', pushLimiter, async (req, res) => { ... });
```

---

### 1.5 — Fallback password admin hardcoded
**Priorità:** 🟡 Media

**Problema:** Se `ADMIN_PASSWORD` non è impostata, il codice usa il fallback `'virtus2026'` (server.js riga 375). Il check di avvio blocca l'app in produzione se la variabile manca, ma in ambienti di sviluppo mal configurati il fallback è attivo.

**Nota:** Il rischio è contenuto grazie al controllo all'avvio (righe 24–29) che blocca il server in `production` se la variabile manca.

---

### 1.6 — Nessun rate limiter globale per endpoint pubblici
**Priorità:** 🟢 Bassa

**Problema:** Endpoint come `GET /api/notizie`, `GET /api/partite`, `GET /api/calendario` non hanno rate limiting e possono essere colpiti ripetutamente saturando le query DB.

**Soluzione consigliata:**
```js
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 200 });
app.use('/api/', generalLimiter);
```

---

## 2. 🧹 Qualità del Codice

### 2.1 — CSS e JS interamente inline nelle pagine HTML
**Priorità:** 🟡 Media

**Problema:** Ogni pagina HTML (15 totali) contiene un blocco `<style>` con centinaia di righe e blocchi `<script>` inline. I file più pesanti sono `admin.html` (98KB, 2079 righe) e `index.html` (92KB, 2635 righe). Questo impedisce il caching del browser e duplica definizioni CSS tra le pagine.

**File:** Tutti i file `.html`

**Soluzione consigliata (graduale):**
1. Continuare a espandere `common.css` (già 361 righe) con gli stili condivisi
2. Creare un `common-page.js` per la logica condivisa tra pagine pubbliche
3. Per i file più grandi (admin.html, index.html) considerare suddivisione in moduli

---

### 2.2 — Pool DB senza configurazione esplicita
**Priorità:** 🟡 Media

**Problema:** Il `Pool` di pg in `db.js` non specifica `max` connections, `idleTimeoutMillis` o `connectionTimeoutMillis`. In picchi di carico si rischia di aprire troppe connessioni verso il pooler Supabase.

**File:** `db.js`

**Soluzione consigliata:**
```js
const pool = new Pool({
  ...buildPoolConfig(DATABASE_URL),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
```

---

### 2.3 — Gestione errori silente in `logActivity`
**Priorità:** 🟢 Bassa

**Problema:** La funzione `logActivity` (server.js riga 737) ha un `catch {}` vuoto — errori di logging vengono inghiottiti silenziosamente.

**File:** `server.js` riga 740

**Soluzione:**
```js
} catch (e) {
  console.warn('[logActivity] Errore:', e.message);
}
```

---

## 3. ⚡ Performance

### 3.1 — Immagini non ottimizzate
**Priorità:** 🟡 Media

**Problema:** Le immagini nella cartella `/images/` non sono compresse per il web:
- `Volley S3.jpeg`: 444KB
- `Home.jpeg`: 378KB
- `positivo@4x.png` / `negativo@4x.png`: 251KB ciascuna
- `logo.png`: 91KB

Per un sito sportivo su mobile, queste dimensioni impattano significativamente i Core Web Vitals (LCP in particolare).

**Soluzione consigliata:**
- Convertire JPEG in WebP (risparmio stimato 30–50%)
- Ridimensionare a max 1200px di larghezza per le immagini hero
- Usare il tag `<picture>` con fallback per compatibilità

---

### 3.2 — CSS inline non cachabile tra le pagine
**Priorità:** 🟡 Media

**Problema:** Gli stili inline vengono re-scaricati ad ogni navigazione. Un utente che va da `index.html` a `notizie.html` ri-scarica stili identici. La soluzione è completare la migrazione in `common.css`.

---

### 3.3 — Cache API in-memory non persistente tra restart
**Priorità:** 🟢 Bassa

**Problema:** Le cache di FIPAV (`_fipavCache`), OPES (`opesCache`) e Instagram (`igCache`) sono variabili in-memory. Ad ogni deploy su Railway la cache si azzera, causando un picco di chiamate alle API esterne.

**Soluzione a medio termine:** Persistere le cache più costose nella tabella `impostazioni` già esistente nel DB, o aggiungere Redis.

---

### 3.4 — Lazy loading mancante su 3 pagine
**Priorità:** 🟢 Bassa

**Problema:** `admin-login.html`, `calendario.html` e `ordine-confermato.html` non usano `loading="lazy"` sulle immagini, a differenza delle altre 10 pagine che già lo fanno.

---

## 4. 🔍 SEO e Accessibilità

### 4.1 — ARIA quasi assente
**Priorità:** 🟡 Media

**Problema:** 14 delle 15 pagine HTML hanno 0 attributi `aria-*`. I form, i modali e i pulsanti interattivi mancano di etichette ARIA, rendendo il sito difficilmente accessibile con screen reader.

**Aree prioritarie:**
- Form di login in `admin-login.html`: `aria-label` sugli input
- Modali: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
- Pulsanti icona (carrello, social): `aria-label`

---

### 4.2 — H1 mancante su 4 pagine
**Priorità:** 🟡 Media

**Problema:** Le pagine `admin-login.html`, `admin.html`, `calendario.html` e `live.html` non hanno un tag `<h1>`.

**Soluzione:** Aggiungere H1 appropriati — per le pagine admin può essere visivamente nascosto con `.sr-only`.

---

### 4.3 — OG tags incompleti su 3 pagine
**Priorità:** 🟢 Bassa

**Problema:**
- `live.html`: manca `og:title` e `og:description`
- `admin-login.html` e `ordine-confermato.html`: mancano `og:title`, `og:description`, `og:image`

La pagina `live.html` è quella più urgente da correggere — chi condivide il link della live non vede anteprima sui social.

---

### 4.4 — Immagini senza alt in `admin.html`
**Priorità:** 🟢 Bassa

**Problema:** `admin.html` ha 16 tag `<img>` ma solo 7 con attributo `alt`.

---

## 5. 🖥️ Funzionalità e UX

### 5.1 — WhatsApp button disabilitato
**Priorità:** 🟢 Bassa

**Problema:** In `common.js` il pulsante WhatsApp floating è presente ma disabilitato: `const WA_NUMBER = '';`.

**Soluzione:** Esporre il numero tramite `/api/config` e configurarlo come variabile d'ambiente.

---

### 5.2 — Instagram non configurato
**Priorità:** 🟢 Bassa

**Problema:** `INSTAGRAM_ACCESS_TOKEN` non è impostato — la sezione Instagram della homepage mostra un fallback. Da configurare dopo il go-live.

---

### 5.3 — Nessun loading state per dati FIPAV/OPES
**Priorità:** 🟢 Bassa

**Problema:** Le chiamate alle API FIPAV/OPES (2–5 secondi) non mostrano uno spinner. L'utente vede una pagina vuota senza feedback visivo.

**Soluzione:** Aggiungere skeleton loader o spinner nelle sezioni che attendono dati esterni.

---

## 6. 📦 Dipendenze

### 6.1 — Major update disponibili
**Priorità:** 🟡 Media

| Pacchetto | Versione attuale | Ultima stabile | Tipo |
|-----------|-----------------|----------------|------|
| `express` | 4.22.1 | 5.2.1 | **Major** — breaking changes |
| `dotenv` | 16.6.1 | 17.4.2 | **Major** — verificare changelog |
| `stripe` | 21.0.1 | 22.1.0 | **Major** — verificare API usate |
| `@supabase/supabase-js` | 2.104.0 | 2.104.1 | Patch — aggiornare subito |
| `express-rate-limit` | 8.3.2 | 8.4.1 | Patch — aggiornare subito |
| `nodemailer` | 8.0.5 | 8.0.6 | Patch — aggiornare subito |

**Raccomandazione:** Rinviare i major update a dopo il go-live. Aggiornare subito le patch:
```bash
npm install @supabase/supabase-js@latest express-rate-limit@latest nodemailer@latest
```

---

### 6.2 — VAPID keys e SUPABASE_REGION non documentate
**Priorità:** 🟡 Media

**Problema:** Le variabili `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `SUPABASE_REGION` sono usate nel codice ma non documentate in `.env.example`. Un redeploy da zero fallirebbe silenziosamente per la regione DB o non attiverebbe le push notification.

**File:** `.env.example`

**Aggiungere:**
```
# ─── Push Notifications (VAPID) ──────────────────────
# Genera con: node -e "const wp=require('web-push'); console.log(wp.generateVAPIDKeys())"
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# Regione Supabase (es. eu-central-1, us-east-1) — vedi Project Settings > General
SUPABASE_REGION=eu-central-1
```

---

## 7. 🏗️ Infrastruttura e Deploy

### 7.1 — Logging non strutturato
**Priorità:** 🟢 Bassa

**Problema:** Il server usa solo `console.log()` con stringhe formattate manualmente. Su Railway questo rende difficile il filtering e l'analisi dei log in produzione.

**Soluzione a medio termine:** Integrare `pino` (logger JSON leggero compatibile con Railway).

---

### 7.2 — Nessun error monitoring
**Priorità:** 🟢 Bassa

**Problema:** Non è presente alcun sistema di error monitoring. Se il server crasha in produzione, lo sviluppatore non riceve alcuna notifica.

**Soluzione:** Integrare Sentry (free tier):
```bash
npm install @sentry/node
```

---

### 7.3 — Nessuna CORS policy esplicita
**Priorità:** 🟢 Bassa

**Problema:** Non c'è configurazione CORS esplicita. Per un sito con un unico dominio è buona pratica bloccare esplicitamente le richieste da origini diverse.

---

## 📋 Tabella Riepilogativa

| # | Area | Problema | File | Priorità |
|---|------|----------|------|----------|
| 1.1 | Sicurezza | SSRF in `/api/proxy-image` — whitelist non vincolante | server.js:1662 | 🔴 Alta |
| 1.2 | Sicurezza | ID timestamp prevedibili → enumerazione + race condition | server.js:452+ | 🔴 Alta |
| 1.3 | Sicurezza | `err.message` esposto in 52 endpoint di produzione | server.js | 🟡 Media |
| 1.4 | Sicurezza | `/api/push/subscribe` senza rate limiting | server.js:1908 | 🟡 Media |
| 1.5 | Sicurezza | Fallback password admin hardcoded in sviluppo | server.js:375 | 🟡 Media |
| 1.6 | Sicurezza | Nessun rate limiter globale per endpoint pubblici | server.js | 🟢 Bassa |
| 2.1 | Qualità | CSS/JS inline in tutte le pagine — no caching | Tutti gli HTML | 🟡 Media |
| 2.2 | Qualità | Pool DB senza max connections / idle timeout | db.js | 🟡 Media |
| 2.3 | Qualità | `logActivity` catch vuoto — errori silenti | server.js:740 | 🟢 Bassa |
| 3.1 | Performance | Immagini fino a 444KB non ottimizzate (no WebP) | /images/ | 🟡 Media |
| 3.2 | Performance | CSS inline non cachato tra le pagine | Tutti gli HTML | 🟡 Media |
| 3.3 | Performance | Cache API in-memory azzerata ad ogni restart | server.js | 🟢 Bassa |
| 3.4 | Performance | Lazy loading mancante su 3 pagine | admin-login, calendario, ordine-confermato | 🟢 Bassa |
| 4.1 | Accessibilità | ARIA quasi assente — 14/15 pagine con 0 attributi aria-* | Tutti gli HTML | 🟡 Media |
| 4.2 | SEO | H1 mancante su 4 pagine (admin-login, admin, calendario, live) | HTML vari | 🟡 Media |
| 4.3 | SEO | OG tags incompleti su live, admin-login, ordine-confermato | HTML vari | 🟢 Bassa |
| 4.4 | Accessibilità | 9 img senza alt in admin.html | admin.html | 🟢 Bassa |
| 5.1 | UX | WhatsApp button disabilitato (WA_NUMBER vuoto) | common.js | 🟢 Bassa |
| 5.2 | UX | Instagram non configurato → fallback su homepage | server.js, .env | 🟢 Bassa |
| 5.3 | UX | Nessun loading state per chiamate FIPAV/OPES lente | risultati.html | 🟢 Bassa |
| 6.1 | Dipendenze | Express 4→5, dotenv 16→17, stripe 21→22 da valutare | package.json | 🟡 Media |
| 6.2 | Dipendenze | VAPID keys e SUPABASE_REGION non documentate in .env.example | .env.example | 🟡 Media |
| 7.1 | Infrastruttura | Logging non strutturato (solo console.log) | server.js | 🟢 Bassa |
| 7.2 | Infrastruttura | Nessun error monitoring (Sentry o simile) | — | 🟢 Bassa |
| 7.3 | Infrastruttura | Nessuna CORS policy esplicita | server.js | 🟢 Bassa |

---

**Totale:** 2 🔴 Alta &nbsp;|&nbsp; 13 🟡 Media &nbsp;|&nbsp; 10 🟢 Bassa

---

*Report generato automaticamente il 27/04/2026 — Prossima analisi: 04/05/2026*
