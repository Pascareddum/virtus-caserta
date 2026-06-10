# Report di Analisi Settimanale — Virtus Caserta

**Data analisi:** 8 giugno 2026
**Ambito:** server.js, db.js, common.js, shared.js, sw.js, pagine HTML, package.json, configurazione di deploy

---

## Riepilogo esecutivo

1. 🔴 **Token JWT salvati in `localStorage` in parallelo ai cookie httpOnly** (`common.js`): espone gli utenti a furto di sessione via XSS, vanificando in parte la protezione che i cookie `httpOnly`/`SameSite=Strict` offrono già lato server.
2. 🔴 **Integrazione Stripe rimossa dal codice ma ancora presente come dipendenza e in `.env.example`**: il webhook `/api/stripe-webhook` documentato nei daily-check del 4 maggio non esiste più in `server.js`, ma `stripe` resta in `package.json` e le chiavi `STRIPE_*` sono ancora documentate — fonte di confusione e superficie di attacco/manutenzione inutile.
3. 🟡 **Nessun gestore di errori globale né handler 404 dedicato per le API**: gli errori non gestiti possono produrre risposte Express di default (con stack trace in sviluppo) e risposte incoerenti per rotte non trovate.
4. 🟡 **CSS e JS quasi interamente inline nelle pagine HTML** (oltre 1.190 occorrenze di `style="` e blocchi `<style>` da 5–48 KB per pagina): nessuna cache del browser, file `admin.html` da 429 KB / 8.426 righe difficile da manutenere.
5. 🟡 **`.env.example` disallineato dalla configurazione reale**: documenta variabili non più usate (Stripe, Gmail SMTP, Instagram, PayPal) e non documenta quelle effettivamente in uso (`BREVO_API_KEY`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, `SUPABASE_REGION`, `PUSH_TEST_TOKEN`).

Nota: il file `report-analisi-settimanale.md` esisteva già (ultima versione del 1° giugno); questo report lo sostituisce con un'analisi aggiornata all'8 giugno.

---

## 1. Sicurezza

### 1.1 Token duplicati: cookie httpOnly + localStorage 🔴
`server.js` (riga 381) imposta correttamente cookie di sessione `httpOnly`, `sameSite=strict` e `secure` in produzione, con un commento esplicito "*XSS-safe, SameSite=Strict → CSRF-safe*". Tuttavia `common.js` (righe 292-356) salva gli stessi JWT anche in `localStorage` (`vc_token`, `vc_admin_token`, `vc_role`, `vc_nome`) e li rilegge per costruire l'header `Authorization: Bearer`.

Questo doppio binario annulla in parte il vantaggio dei cookie httpOnly: qualsiasi script malevolo iniettato via XSS (anche su una pagina terza che condivide dominio/sottodominio) può leggere `localStorage.getItem('vc_token')` e impersonare l'utente, cosa impossibile con i soli cookie httpOnly.

**Soluzione consigliata:** eliminare gradualmente il fallback `Authorization: Bearer` lato client e affidarsi solo ai cookie httpOnly (che il backend già supporta in via prioritaria, riga 382). Se serve mantenere compatibilità, ridurre il contenuto di `localStorage` a dati non sensibili (es. solo `vc_nome` per la UI) e non al token stesso.

```js
// common.js — invece di salvare il token:
localStorage.setItem('vc_nome', data.nome); // solo dati di presentazione
// il cookie httpOnly gestisce già l'autenticazione automaticamente con fetch({credentials:'include'})
```

Priorità: 🔴 Alta

### 1.2 Integrazione Stripe "fantasma" 🔴
I daily-check del progetto (es. `daily-check-2026-05-04.md`) descrivono un endpoint `/api/stripe-webhook` funzionante con verifica firma `STRIPE_WEBHOOK_SECRET`. Oggi quell'endpoint **non esiste più** in `server.js` (0 occorrenze di "stripe" case-insensitive nel file), ma:
- `stripe@^21.0.1` resta tra le dipendenze in `package.json`;
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` restano documentate in `.env.example`.

Questo crea ambiguità su come vengono effettivamente gestiti i pagamenti (il sito sembra ora basarsi su PayPal lato client + email d'ordine via Brevo) e mantiene una dipendenza pesante e potenzialmente vulnerabile inutilizzata.

**Soluzione consigliata:** decidere se Stripe va reintrodotto o abbandonato. Se abbandonato: `npm uninstall stripe`, rimuovere le voci `STRIPE_*` da `.env.example` e aggiornare la documentazione/daily-check per riflettere il flusso di pagamento reale (PayPal + pagamento in sede).

Priorità: 🔴 Alta

### 1.3 JWT: scadenze e algoritmo
- `jwt.sign` non specifica esplicitamente `algorithm`, quindi usa il default `HS256` — corretto e coerente con `jwt.verify` che non forza l'algoritmo previsto. Va bene così, ma è buona pratica rendere esplicito `{ algorithm: 'HS256' }` sia in firma che in verifica per prevenire attacchi di tipo *algorithm confusion* in caso di refactoring futuri.
- Il token utente ha una durata di **120 giorni** (righe 466, 476, 519) — molto lunga per un cookie che, pur essendo httpOnly, in caso di compromissione del dispositivo resta valido per 4 mesi. Da valutare un refresh-token separato a vita breve + access token più corto.
- `JWT_SECRET` ha un **fallback hard-coded** `'virtus_secret_2026_dev'` (riga 29). In produzione la app si rifiuta di partire se manca (righe 22-28), il che è corretto, ma il fallback resta comunque nel codice sorgente e potrebbe essere usato per errore in ambienti non marcati `NODE_ENV=production`.

**Soluzione consigliata:**
```js
const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '120d', algorithm: 'HS256' });
const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
```

Priorità: 🟡 Media

### 1.4 Protezione endpoint admin/API
Il middleware `adminAuth`/`userAuth` (righe 393-406) e `adminCookieCheck` (riga 212) sono applicati in modo coerente: ho contato 208 route `app.get/post/put/delete` e la quasi totalità delle rotte di scrittura sotto `/api/admin/*` passa per `adminAuth`. Buon livello di copertura.

Un dettaglio: `BLOCKED_FILES` (riga 316) usa una regex per impedire l'accesso diretto a `server.js`, `db.js`, `package.json`, `.env*` e `*.md` — soluzione pragmatica, ma sarebbe più robusto spostare questi file fuori dalla `webroot` servita da `express.static` piuttosto che fare affidamento su un filtro a blacklist (un nuovo file sensibile aggiunto in futuro non sarebbe automaticamente protetto).

Priorità: 🟢 Bassa

### 1.5 Header di sicurezza HTTP
`helmet()` è configurato con una CSP personalizzata (righe 177-200). Punti d'attenzione:
- `scriptSrc` e `scriptSrcAttr` includono `'unsafe-inline'`, necessario per il codice inline diffuso nelle pagine ma che **riduce significativamente l'efficacia della CSP contro XSS** (vedi anche punto 1.1: se uno script inline viene iniettato, la CSP non lo blocca).
- `imgSrc` include `https:` generico, che permette il caricamento di immagini da qualunque host HTTPS — accettabile per contenuti come loghi sponsor/social embed, ma più permissivo del necessario.
- Helmet imposta comunque di default `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security` ecc., quindi la base è solida.

**Soluzione consigliata (percorso a medio termine):** estrarre gli script inline in file `.js` esterni con hash/nonce CSP, per poter rimuovere `'unsafe-inline'` da `scriptSrc`. Questo è anche il prerequisito per chiudere davvero il punto 1.1.

Priorità: 🟡 Media

### 1.6 Validazione input e gestione errori
- Gli endpoint pubblici principali (`/api/register`, `/api/login`, `/api/contact`, `/api/iscrizioni`) applicano trim, troncamento di lunghezza e regex email — buona pratica (es. righe 486-491).
- Le query SQL usano sistematicamente parametri posizionali (`$1`, `$2`, ...) tramite `pg`, quindi il rischio di SQL injection è basso. Non ho trovato concatenazioni dirette di input utente in stringhe SQL.
- **Manca un body-size limit esplicito** su `express.json()` (riga 207): di default Express limita a 100 KB, il che è probabilmente accettabile, ma vale la pena renderlo esplicito e coerente con i limiti di `multer` (5/10 MB) per evitare comportamenti sorprendenti.
- **165 blocchi `catch`** nel file, ma la gestione è disomogenea: alcuni loggano con `console.error`, altri con `console.log` (es. righe 3134, 3153, 3208 usano `console.log` per errori), rendendo più difficile filtrare i log critici in produzione.

**Soluzione consigliata:**
```js
app.use(express.json({ limit: '1mb' }));
```
e standardizzare su `console.error` (o un logger strutturato, vedi sezione 7) per tutti i casi di errore.

Priorità: 🟡 Media

### 1.7 Rate limiting
Coperti: login admin/utente, registrazione, reset password (`imposta-password` non ha un limiter dedicato — vedi sotto), invio ordini, contatti, iscrizioni. **`/api/imposta-password` (riga 927) non ha alcun rate limiter**, mentre è un endpoint pubblico che gestisce token di reset — un bersaglio tipico per attacchi a forza bruta sul token.

**Soluzione consigliata:**
```js
const impostaPasswordLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: {...} });
app.post('/api/imposta-password', impostaPasswordLimiter, async (req, res) => { ... });
```

Priorità: 🟡 Media

### 1.8 Connessione al database
`db.js` forza `ssl: { rejectUnauthorized: false }` per tutte le modalità di connessione (righe 14, 29, 34). Questo disabilita la verifica del certificato TLS del server Postgres, esponendo (in teoria) a man-in-the-middle se la rete tra Railway/Render e Supabase fosse compromessa. È una pratica comune con i pooler Supabase per problemi di catena di certificati, ma andrebbe documentata esplicitamente come compromesso accettato, o sostituita fornendo il CA certificate corretto (`ssl: { ca: ... }`).

Priorità: 🟢 Bassa

---

## 2. Qualità del codice

### 2.1 Uso di `var`
`server.js` e `common.js` non usano `var` (0 occorrenze). `shared.js`, invece, ne contiene **17 occorrenze** (es. riga 5: `var _p = window.location.pathname...`). Non è un problema funzionale, ma è incoerente con lo stile `const`/`let` usato altrove.

**Soluzione consigliata:** sostituire `var` con `const`/`let` in `shared.js` per coerenza (find & replace mirato, con attenzione allo scoping di funzione vs blocco).

Priorità: 🟢 Bassa

### 2.2 File duplicato `db 2.js`
Nella root del progetto è presente `db 2.js` (12 KB), una **versione precedente di `db.js`** — il `diff` mostra che `db.js` contiene migrazioni di schema (`ALTER TABLE`, nuove tabelle `squadre_homepage`, ecc.) assenti in `db 2.js`. Il file con lo spazio nel nome è quasi certamente un backup accidentale (probabilmente generato da un editor/Finder con "salva con nome") e non viene richiesto da nessuna parte del codice.

**Soluzione consigliata:** eliminare `db 2.js` dal repository (`git rm "db 2.js"`) per evitare che qualcuno lo modifichi per errore credendolo il file attivo.

Priorità: 🟡 Media

### 2.3 File monolitici e funzioni lunghe
- `server.js` è arrivato a **5.065 righe** in un unico file, con oltre 200 route definite inline. Funzioni come l'handler di `/api/profilo/prossimi` (righe 550-720+) superano le 150 righe e mescolano calcolo date, query multiple e trasformazione dati.
- `admin.html` è di **8.426 righe / 429 KB**, `index.html` di 3.426 righe / 128 KB — entrambi mescolano markup, CSS e JavaScript applicativo nello stesso file.

**Soluzione consigliata:** suddividere `server.js` in router Express per dominio (`routes/admin.js`, `routes/calendario.js`, `routes/shop.js`, `routes/auth.js`, ecc.) usando `express.Router()`, e isolare le funzioni di utilità (es. `safeTs`, `parseClaUrl`) in moduli dedicati testabili singolarmente.

```js
// routes/calendario.js
const router = require('express').Router();
router.get('/api/profilo/prossimi', userAuth, getProssimiEventi);
module.exports = router;
```

Priorità: 🟡 Media

### 2.4 Commenti
Il codice ha buoni commenti "a sezione" (es. `/* ─── Auth middleware ─── */`) che aiutano la navigazione, ma le funzioni complesse con logica di business (calcolo date settimana corrente, generazione tornei a eliminazione diretta, parsing URL classifica FIPAV/OPES) non hanno commenti che spieghino il *perché* delle scelte (es. riga 567 `safeTs` spiega il problema "ora non zero-padded" solo con un commento di una riga).

Priorità: 🟢 Bassa

---

## 3. Performance

### 3.1 CSS/JS inline non cacheabili 🟡
Ho rilevato **1.192 attributi `style="`** e blocchi `<style>` da 5 a 48 KB ripetuti in ciascuna delle pagine HTML campionate (index, notizie, shop, squadra, risultati, staff, sponsor, chi-siamo, live). Questo significa che:
- ad ogni navigazione tra pagine il browser **ri-scarica e ri-parsa** CSS sostanzialmente identico (la navbar, i colori del brand, le card, ecc.);
- non è possibile sfruttare la cache HTTP del browser su questi asset.

`common.css` esiste già (12 KB) e copre parte degli stili condivisi: andrebbe esteso per assorbire i blocchi `<style>` ripetuti, e gli script applicativi ripetuti dovrebbero confluire in `common.js`/`shared.js`.

**Soluzione consigliata:**
```html
<!-- invece di centinaia di righe <style>...</style> per pagina -->
<link rel="stylesheet" href="/common.css">
<link rel="stylesheet" href="/notizie.css">  <!-- solo stili specifici della pagina -->
```

Priorità: 🟡 Media

### 3.2 Nessuna cache HTTP per gli asset statici
`express.static(path.join(__dirname))` (riga 323) e `express.static(UPLOADS_DIR)` (riga 368) sono montati **senza opzioni di cache** (`maxAge`, `immutable`, `etag`). Ogni richiesta di immagini, CSS, JS statici viene rivalidata o ritrasmessa integralmente.

**Soluzione consigliata:**
```js
app.use(express.static(path.join(__dirname), { maxAge: '1d', etag: true }));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d', immutable: true }));
```
(per gli HTML, che cambiano più spesso, si può escludere la cache lunga o usare `setHeaders` per differenziare per estensione).

Priorità: 🟡 Media

### 3.3 Lazy loading immagini
`loading="lazy"` è presente ma applicato in modo incompleto: 5 occorrenze in `index.html` (su 24 immagini), 2 in `notizie.html`, 1 in `shop.html`, 0 in `utente.html`. Le pagine con gallerie lunghe (squadra, sponsor, staff) trarrebbero beneficio da un'applicazione sistematica.

**Soluzione consigliata:** aggiungere `loading="lazy" decoding="async"` a tutte le `<img>` che non sono "above the fold" (la prima schermata visibile).

Priorità: 🟢 Bassa

### 3.4 Service Worker sotto-utilizzato
`sw.js` (29 righe) gestisce solo le notifiche push (`push`, `notificationclick`) e la pulizia cache obsolete, ma **non implementa un handler `fetch`** né salva alcun asset in `caches` — la costante `CACHE_NAME = 'vc-v1'` è dichiarata ma mai usata per memorizzare risorse. Di fatto il sito non sfrutta le potenzialità PWA di funzionamento offline/cache-first che il service worker renderebbe possibili.

**Soluzione consigliata:** aggiungere una strategia *cache-first* per asset statici (CSS/JS/immagini del brand) e *network-first* per le pagine dinamiche.

Priorità: 🟢 Bassa

### 3.5 Compressione e query
`compression()` è attivo globalmente (riga 201) — positivo. Le query verso `impostazioni` (chiavi come `squadre_cat_links`, `squadre_campionato_mappa`) vengono **rilette più volte nello stesso ciclo di richiesta** (es. `/api/profilo` legge `squadre_cat_links` alla riga 543, e `/api/profilo/prossimi` la rilegge alla riga 631 con la stessa query) — un piccolo livello di caching in-memory (con TTL breve) eviterebbe round-trip ridondanti al database.

Priorità: 🟢 Bassa

---

## 4. SEO e accessibilità

### 4.1 Meta tag e Open Graph
Tutte le pagine campionate hanno `<meta name="description">`, tag Open Graph (7 per pagina) e `<title>` distintivo — buona base SEO. L'endpoint `/notizia/:id` (righe 251-289) genera correttamente OG tag dinamici per la condivisione social di singole notizie, con escaping HTML (`esc()`) appropriato.

### 4.2 Tag `alt` sulle immagini
Su un campione di 9 pagine, **3 immagini in `index.html`** e **1 in `notizie.html`** risultano prive dell'attributo `alt` (su 24 e 13 immagini totali rispettivamente). Le altre pagine campionate (shop, squadra, risultati, staff, sponsor, chi-siamo, live) hanno `alt` su tutte le immagini.

**Soluzione consigliata:** individuare le `<img>` senza `alt` in `index.html`/`notizie.html` (probabilmente immagini decorative o caricate dinamicamente via JS) e aggiungere `alt=""` per quelle puramente decorative o un testo descrittivo per le altre.

Priorità: 🟢 Bassa

### 4.3 Struttura heading
Ogni pagina campionata ha **esattamente un `<h1>`**, corretto — tranne `live.html`, che **non ha alcun `<h1>`**. Su una pagina che presenta contenuti video/streaming, un `<h1>` (anche visivamente nascosto via CSS) migliorerebbe sia la SEO sia l'accessibilità per chi naviga con screen reader.

**Soluzione consigliata:**
```html
<h1 class="sr-only">Live streaming partite Virtus Caserta</h1>
```

Priorità: 🟢 Bassa

### 4.4 ARIA e accessibilità
Le `aria-*` sono usate solo in modo puntuale (2-5 occorrenze per pagina, tipicamente su pulsanti hamburger/menu in `common.js`). Elementi interattivi come dropdown, modali e form di shop/iscrizione non sembrano avere `aria-label`, `aria-expanded` o `role` sistematici.

**Soluzione consigliata:** condurre un audit con uno strumento come axe DevTools o Lighthouse Accessibility sulle pagine con form e interazioni complesse (shop, utente, calendario), e aggiungere `aria-live` alle aree di feedback dinamico (messaggi di conferma/errore).

Priorità: 🟡 Media

### 4.5 `lang`, viewport, robots/sitemap
`<html lang="it">`, `<meta name="viewport">`, `robots.txt` e `sitemap.xml` sono presenti e corretti — buona igiene SEO di base. `robots.txt` blocca correttamente `/admin`, `/api/`, `/ordine-confermato`, `/reset-password`.

---

## 5. Funzionalità e UX

### 5.1 Pagina `live.html` priva di `<h1>` e potenzialmente "stub"
Oltre al problema di accessibilità (4.3), vale la pena verificare che la pagina `/live` mostri sempre contenuti utili anche quando non ci sono eventi in diretta (stato vuoto chiaro, messaggio "Nessuna diretta in programma" con CTA verso il calendario).

Priorità: 🟢 Bassa

### 5.2 Feedback utente sugli errori
La gran parte degli endpoint risponde con `{ error: '...' }` e messaggi in italiano comprensibili (es. "Troppi tentativi. Riprova tra 15 minuti."), un buon segnale di attenzione alla UX anche lato API. Andrebbe verificato che **tutte** le chiamate fetch lato client (specialmente in `utente.html`, `shop.html`, `gestione-squadra.html`) traducano questi errori in stati di caricamento/messaggi visibili e non silenzino i `catch` con `.catch(() => {})` (pattern presente ad es. in `common.js` riga 60).

**Soluzione consigliata:** evitare `.catch(() => {})` silenziosi sulle chiamate che alimentano contenuti visibili all'utente; mostrare almeno un placeholder o un messaggio di "contenuto non disponibile al momento".

Priorità: 🟡 Media

### 5.3 Sessione "scorrevole" (sliding session)
`/api/me` (righe 461-470) rinnova automaticamente il cookie utente ad ogni caricamento pagina autenticato — buona UX (l'utente non viene disconnesso durante la navigazione attiva), ma rinforza l'osservazione del punto 1.3 sulla durata complessiva molto lunga della sessione.

Priorità: 🟢 Bassa

---

## 6. Dipendenze

`npm audit` non segnala vulnerabilità note nelle dipendenze attuali (0 vulnerabilità). Le versioni in `package.json` sono recenti (helmet 8, express-rate-limit 8, jsonwebtoken 9, bcryptjs 3, multer 2, ecc.).

Punti da rivedere:
- **`stripe@^21.0.1`**: non utilizzato nel codice (vedi 1.2) — candidato alla rimozione o reintegrazione esplicita.
- **`nodemailer@^8.0.4`**: il codice usa principalmente Brevo via API HTTP (`sendBrevoEmail`) e SMTP (`creaTransporterBrevo`), con `creaTransporter()` (Gmail) presente ma marcato come "solo per contatti/iscrizioni" — verificare se è ancora necessario mantenere due percorsi email paralleli (Gmail SMTP + Brevo) o se si può consolidare su Brevo, riducendo la superficie di configurazione.
- **`package-lock.json` in `.gitignore`**: è inusuale escludere il lockfile dal controllo versione — questo può causare build non riproducibili tra ambienti diversi (dev vs Railway). Si raccomanda di **includere `package-lock.json` nel repository**.

**Soluzione consigliata:**
```bash
npm uninstall stripe       # se non reintrodotto
git rm --cached package-lock.json -f   # rimuovi dal .gitignore e ri-aggiungi al repo
```

Priorità: 🟡 Media

---

## 7. Infrastruttura e deploy

### 7.1 `render.yaml` non presente — il progetto usa Railway
La traccia di analisi richiedeva la verifica di `render.yaml`, ma **questo file non esiste nel progetto**. La configurazione di deploy effettiva è `railway.json` (Nixpacks builder, healthcheck su `/health`, restart policy `ON_FAILURE` con max 3 retry) e numerosi commenti nel codice fanno riferimento esplicito a Railway (es. `dns.setDefaultResultOrder('ipv4first')` con commento "Railway non supporta IPv6 in uscita", riga 3).

**Azione consigliata:** se il progetto è effettivamente ospitato su Railway, aggiornare la documentazione interna (inclusi i daily-check) per evitare riferimenti incrociati a "render.yaml"; se invece è prevista una migrazione verso Render, andrebbe pianificata e un `render.yaml` andrebbe creato di conseguenza.

Priorità: 🟡 Media

### 7.2 Variabili d'ambiente disallineate 🟡
Confrontando `.env` (variabili effettivamente configurate) con `.env.example` (documentazione):

| Solo in `.env` (non documentate) | Solo in `.env.example` (probabilmente obsolete) |
|---|---|
| `BREVO_API_KEY` | `ADMIN_EMAIL`, `BREVO_SMTP_KEY`, `BREVO_SMTP_LOGIN` |
| `PUSH_TEST_TOKEN` | `EMAIL_USER`, `EMAIL_PASS`, `INSTAGRAM_ACCESS_TOKEN` |
| `SUPABASE_REGION` | `PAYPAL_CLIENT_ID`, `PORT` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `SMTP_HOST/PORT/USER/PASS`, `STRIPE_*` |

Questo rende `.env.example` **fuorviante** per chiunque debba configurare un nuovo ambiente (es. un altro sviluppatore, o il developer stesso tra qualche mese).

**Soluzione consigliata:** rigenerare `.env.example` allineandolo a `.env`, rimuovendo le voci obsolete e documentando le nuove (in particolare `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, necessarie per le notifiche push web).

Priorità: 🟡 Media

### 7.3 Logging e monitoring
- È presente un health-check (`/health`) collegato al monitoraggio di Railway — corretto.
- Il logging è interamente basato su `console.log`/`console.error`, senza livelli, timestamp strutturati o correlazione tra richieste. In caso di incidenti in produzione, individuare la causa radice tra migliaia di righe di log non strutturato è oneroso.
- Non risulta integrato alcun servizio di error tracking (es. Sentry) — gli errori non gestiti (vedi 1.6) potrebbero passare inosservati.

**Soluzione consigliata:** introdurre un logger strutturato leggero (es. `pino`) con livelli (`info`/`warn`/`error`) e, se il budget lo consente, un servizio di error tracking gratuito/freemium per ambienti Node.

Priorità: 🟢 Bassa

### 7.4 File superflui nella root del repository
Sono presenti **8 file `daily-check-2026-*.md`** (totale ~30 KB) e il già citato `db 2.js` nella root del progetto, oltre al vecchio `report-analisi-settimanale.md`. Questi file di lavoro/log non sembrano avere un ruolo applicativo e appesantiscono la root del repository.

**Soluzione consigliata:** spostare i `daily-check-*.md` in una sottocartella dedicata (es. `docs/daily-check/`) o un repository/wiki separato, ed eliminare `db 2.js`.

Priorità: 🟢 Bassa

---

## Tabella riepilogativa

| # | Area | Problema/Opportunità | File | Priorità |
|---|------|----------------------|------|----------|
| 1 | Sicurezza | JWT salvati anche in `localStorage` oltre ai cookie httpOnly → rischio furto sessione via XSS | common.js:292-356 | 🔴 Alta |
| 2 | Sicurezza/Dipendenze | Integrazione Stripe rimossa dal codice ma dipendenza e `.env.example` ancora presenti | server.js, package.json, .env.example | 🔴 Alta |
| 3 | Sicurezza | `JWT_SECRET` con fallback hard-coded; algoritmo non esplicito in sign/verify | server.js:29, 216, 384, 390 | 🟡 Media |
| 4 | Sicurezza | Sessione utente valida 120 giorni — durata molto lunga per un cookie | server.js:457, 466, 519 | 🟡 Media |
| 5 | Sicurezza | CSP con `'unsafe-inline'` per script — riduce l'efficacia anti-XSS | server.js:181-182 | 🟡 Media |
| 6 | Sicurezza | `express.json()` senza limite esplicito di dimensione body | server.js:207 | 🟡 Media |
| 7 | Sicurezza | `/api/imposta-password` privo di rate limiting | server.js:927 | 🟡 Media |
| 8 | Sicurezza | `BLOCKED_FILES` come blacklist invece di spostare file sensibili fuori dalla webroot | server.js:316 | 🟢 Bassa |
| 9 | Sicurezza | `ssl: { rejectUnauthorized: false }` su tutte le connessioni DB | db.js:14, 29, 34 | 🟢 Bassa |
| 10 | Qualità codice | Uso di `var` in `shared.js` (17 occorrenze), incoerente col resto del codice | shared.js | 🟢 Bassa |
| 11 | Qualità codice | File `db 2.js` duplicato/obsoleto nella root | db 2.js | 🟡 Media |
| 12 | Qualità codice | `server.js` (5.065 righe) e `admin.html` (8.426 righe) monolitici, route e funzioni molto lunghe | server.js, admin.html | 🟡 Media |
| 13 | Qualità codice | Logging incoerente (`console.log` vs `console.error` per errori) | server.js varie righe | 🟡 Media |
| 14 | Performance | CSS/JS inline ripetuti in ogni pagina (1.192 `style=`, blocchi fino a 48 KB) | *.html | 🟡 Media |
| 15 | Performance | Asset statici serviti senza header di cache (`maxAge`, `etag`) | server.js:323, 368 | 🟡 Media |
| 16 | Performance | `loading="lazy"` applicato in modo incompleto sulle immagini | index.html, shop.html, utente.html | 🟢 Bassa |
| 17 | Performance | Service Worker non implementa caching offline/asset (solo push) | sw.js | 🟢 Bassa |
| 18 | Performance | Query a `impostazioni` ripetute nello stesso flusso senza cache in-memory | server.js:543, 631 | 🟢 Bassa |
| 19 | SEO/Accessibilità | Alcune `<img>` senza `alt` in index.html (3) e notizie.html (1) | index.html, notizie.html | 🟢 Bassa |
| 20 | SEO/Accessibilità | `live.html` privo di `<h1>` | live.html | 🟢 Bassa |
| 21 | SEO/Accessibilità | Uso limitato di attributi ARIA su form/modali/dropdown | varie pagine | 🟡 Media |
| 22 | UX | `.catch(() => {})` silenziosi che possono nascondere errori all'utente | common.js:60 e simili | 🟡 Media |
| 23 | Dipendenze | `package-lock.json` escluso dal repo (`.gitignore`) — build non riproducibili | .gitignore | 🟡 Media |
| 24 | Dipendenze | Due percorsi email paralleli (Gmail SMTP + Brevo) da consolidare | server.js:49-62, 73-170 | 🟢 Bassa |
| 25 | Infrastruttura | `render.yaml` assente — deploy reale via `railway.json`, documentazione disallineata | railway.json | 🟡 Media |
| 26 | Infrastruttura | `.env.example` disallineato dalle variabili realmente in uso | .env, .env.example | 🟡 Media |
| 27 | Infrastruttura | Logging non strutturato, nessun error tracking | server.js (globale) | 🟢 Bassa |
| 28 | Infrastruttura | File di lavoro (`daily-check-*.md`, `db 2.js`) nella root del repo | root progetto | 🟢 Bassa |

---

*Report generato automaticamente come parte della revisione settimanale programmata del progetto Virtus Caserta.*
