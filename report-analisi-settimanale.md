# Report Analisi Settimanale — Virtus Caserta

**Data analisi:** 4 maggio 2026  
**Analizzato da:** Claude (automazione settimanale)  
**Progetto:** Virtus Caserta ASD — sito web istituzionale con shop, calendario, risultati FIPAV

---

## Riepilogo Esecutivo

I 5 punti critici principali emersi dall'analisi:

1. 🔴 **Fallback di credenziali hardcoded** — `JWT_SECRET` e `ADMIN_PASSWORD` hanno valori di default insicuri nel codice sorgente (`server.js` righe 30 e 383). Se le variabili d'ambiente non vengono impostate in produzione, le credenziali di default sono esposte.
2. 🔴 **`err.message` esposto nelle risposte HTTP** — circa 20+ endpoint restituiscono direttamente il messaggio di errore interno del database al client, rivelando potenzialmente struttura dello schema, nomi di tabelle e dettagli dell'infrastruttura.
3. 🔴 **HTML injection nelle email di iscrizione** — l'endpoint `POST /api/iscrizioni` inserisce i campi utente (`nome`, `cognome`, `email`, `messaggio`) direttamente nel corpo HTML delle email senza usare la funzione `esc()` già presente nel codice.
4. 🟡 **CSS massivamente duplicato tra le pagine** — ogni pagina HTML (14 file) contiene un blocco `<style>` separato con stili della navbar, colori, font e layout ripetuti. `index.html` pesa 109 KB e `admin.html` 106 KB principalmente per CSS inline.
5. 🟡 **Service Worker incompleto (PWA non funzionale)** — `sw.js` gestisce solo le notifiche push, senza alcuna strategia di caching. Il sito si presenta come PWA installabile ma non funziona offline.

---

## 1. Sicurezza

### 1.1 Credenziali hardcoded come fallback
**🔴 Alta priorità**

**File:** `server.js`, righe 30 e 383

```js
// riga 30
const JWT_SECRET = process.env.JWT_SECRET || 'virtus_secret_2026_dev';

// riga 383
const adminPassword = process.env.ADMIN_PASSWORD || 'virtus2026';
```

Se `JWT_SECRET` non è impostato, chiunque conosca il default può forgiare token JWT validi e accedere all'area admin. Analogamente, se `ADMIN_PASSWORD` non è impostato, la password è `virtus2026` — nota a chiunque legga il sorgente.

Il controllo in produzione (righe 23-27) verifica che `JWT_SECRET` e `ADMIN_PASSWORD` siano presenti ma **non blocca il processo** se mancano: si limita a un `console.error`. Il server si avvia comunque con i default insicuri.

**Soluzione consigliata:**
```js
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET non configurato');

// Oppure bloccare l'avvio esplicitamente:
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || !process.env.ADMIN_PASSWORD)) {
  console.error('[FATALE] Variabili critiche mancanti. Arresto.');
  process.exit(1);
}
```

---

### 1.2 Dettagli errori interni esposti al client
**🔴 Alta priorità**

**File:** `server.js`, righe 432, 468, 487, 498, 520, 546, 573, 585, 626, 644, 661, 673, 740, 769 e molte altre

```js
// Pattern ripetuto ~20+ volte:
} catch (err) { res.status(500).json({ error: err.message }); }
```

`err.message` può contenere messaggi del driver PostgreSQL come nomi di tabelle, struttura dello schema e dettagli di connessione.

**Soluzione consigliata:**
```js
} catch (err) {
  console.error('[API Error]', req.path, err.message);
  res.status(500).json({ error: 'Si è verificato un errore interno.' });
}

// Aggiungere un middleware di errore globale alla fine del file:
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ error: 'Errore interno del server.' });
});
```

---

### 1.3 HTML injection nelle email di iscrizione
**🔴 Alta priorità**

**File:** `server.js`, riga 2065

```js
// PROBLEMA: campi non sanitizzati
html: `<p><b>Nome:</b> ${nome} ${cognome}<br><b>Email:</b> ${email}<br>
       <b>Messaggio:</b> ${messaggio || '—'}</p>`,

// SOLUZIONE: usare esc() già presente nel codice (riga 343)
html: `<p><b>Nome:</b> ${esc(nome)} ${esc(cognome)}<br>
       <b>Email:</b> ${esc(email)}<br>
       <b>Messaggio:</b> ${esc(messaggio) || '—'}</p>`,
```

A differenza dell'endpoint `/api/contatto` (che usa correttamente `esc()`), l'endpoint iscrizioni non sanitizza i campi, consentendo HTML injection nell'email ricevuta dall'amministratore.

---

### 1.4 Nessun token CSRF per endpoint con cookie di sessione
**🟡 Media priorità**

**File:** `server.js` — tutti gli endpoint admin (`/api/admin/*`)

Gli endpoint admin usano il cookie `vc_admin_session` (con `sameSite: 'strict'` che mitiga parzialmente), ma non è implementata protezione CSRF completa. Considerare l'aggiunta di un header custom `X-CSRF-Token` o il doppio invio del token JWT in un header.

---

### 1.5 CSP con `unsafe-inline` per gli script
**🟢 Bassa priorità**

**File:** `server.js`, riga 122

```js
scriptSrc: ["'self'", "'unsafe-inline'", ...]
```

`'unsafe-inline'` disabilita la protezione XSS della CSP. Compromesso necessario con gli script inline attuali, ma da pianificare la migrazione a file JS separati nel lungo termine.

---

## 2. Qualità del Codice

### 2.1 CSS massivamente duplicato tra le pagine HTML
**🟡 Media priorità**

**File:** Tutti i file `.html`

| File | Dimensione | Blocchi `<style>` |
|------|-----------|-------------------|
| `index.html` | 109 KB | 1 (enorme) |
| `admin.html` | 106 KB | 2 |
| `shop.html` | 50 KB | 1 |
| `notizie.html` | 38 KB | 1 |
| `calendario.html` | 35 KB | 1 |

Ogni pagina ridefinisce variabili CSS, stili della navbar, colori brand e layout. Estrarre in `common.css` ridurrebbe ogni pagina del 20–40% e semplificherà la manutenzione.

---

### 2.2 Assenza di un logger strutturato
**🟡 Media priorità**

**File:** `server.js` — 51 occorrenze di `console.log`/`console.error`

In produzione i log non hanno timestamp, livello né formato strutturato. Considerare `pino` (leggero, JSON output) o `winston`:
```js
const pino = require('pino');
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
log.info({ module: 'db' }, 'Inizializzazione completata');
```

---

### 2.3 Tabella `log_attivita` senza pulizia automatica
**🟢 Bassa priorità**

**File:** `server.js` r. 747 / `db.js`

I record si accumulano indefinitamente. Aggiungere una pulizia periodica:
```js
// Dopo ogni INSERT in log_attivita:
await db.query(`DELETE FROM log_attivita WHERE created_at < NOW() - INTERVAL '90 days'`);
```

---

### 2.4 Due codepath autenticazione non unificate
**🟢 Bassa priorità**

**File:** `server.js`, righe 363–376

`verifyToken()` legge l'header `Authorization` (Bearer), mentre `adminAuth` controlla solo il cookie `vc_admin_session`. Unificare in un middleware unico che controlla entrambe le sorgenti.

---

## 3. Performance

### 3.1 Lazy loading mancante sulla maggior parte delle immagini
**🟡 Media priorità**

**File:** `index.html` (5 immagini lazy su 22), `shop.html` (2 su totale)

```html
<!-- Aggiungere a tutte le immagini non above-the-fold: -->
<img src="foto.jpg" alt="..." loading="lazy" width="400" height="300">
```
Aggiungere `width` e `height` espliciti per evitare layout shift (CLS).

---

### 3.2 Nessun indice DB sulle colonne di ordinamento frequenti
**🟡 Media priorità**

**File:** `db.js`

Le query più frequenti ordinano per `created_at DESC` e `data_str` senza indici:

```js
// Aggiungere in createTables():
await query(`CREATE INDEX IF NOT EXISTS idx_notizie_created ON notizie (created_at DESC)`);
await query(`CREATE INDEX IF NOT EXISTS idx_ordini_created ON ordini (created_at DESC)`);
await query(`CREATE INDEX IF NOT EXISTS idx_risultati_data ON risultati (data_str DESC)`);
await query(`CREATE INDEX IF NOT EXISTS idx_calendario_data ON calendario (data_str, ora)`);
```

---

### 3.3 Cache-Control assente su API pubbliche
**🟢 Bassa priorità**

**File:** `server.js` — solo l'endpoint `/api/risultati` (r. 1968) imposta Cache-Control.

Endpoint come `/api/notizie`, `/api/prodotti`, `/api/sponsor` potrebbero avere `Cache-Control: public, max-age=300` per ridurre le query al DB.

---

## 4. SEO e Accessibilità

### 4.1 Meta tag mancanti su pagine chiave
**🟡 Media priorità**

| Pagina | Meta Description | Open Graph | H1 |
|--------|-----------------|-----------|-----|
| `live.html` | ✅ | ❌ | ❌ |
| `calendario.html` | ✅ | ✅ | ❌ |
| `ordine-confermato.html` | ❌ | ❌ | ✅ |
| `admin-login.html` | ❌ | ❌ | ❌ |

Le pagine admin non necessitano di SEO, ma `live.html` e `calendario.html` mancano di H1 e/o Open Graph.

---

### 4.2 Attributi ARIA quasi completamente assenti
**🟡 Media priorità**

**File:** Tutti i file `.html` (eccetto `index.html` con 3 attributi via `common.js`)

Priorità minima:
```html
<!-- Pulsanti icon-only -->
<button onclick="elimina(id)" aria-label="Elimina elemento">🗑️</button>

<!-- Sezioni con aggiornamenti dinamici -->
<div id="lista-ordini" role="region" aria-live="polite" aria-label="Lista ordini"></div>
```

---

### 4.3 Immagini senza `alt` nell'area admin
**🟢 Bassa priorità**

**File:** `admin.html` — 9 immagini su 16 senza attributo `alt`.

Nei template JS che generano HTML dinamico, usare il nome dell'elemento:
```js
`<img src="${p.immagine}" alt="${p.nome}">`
```

---

## 5. Funzionalità e UX

### 5.1 Service Worker incompleto — PWA non funzionale offline
**🟡 Media priorità**

**File:** `sw.js` (23 righe — solo notifiche push)

Il sito è installabile come PWA ma non funziona offline. Aggiunta minima consigliata:
```js
const CACHE_NAME = 'virtus-v1';
const CACHED_URLS = ['/', '/common.css', '/common.js', '/images/logo.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(CACHED_URLS)));
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
```

---

### 5.2 Pagine rimosse reindirizzano solo alla homepage
**🟢 Bassa priorità**

**File:** `server.js`, righe 248–250

`/galleria.html`, `/iscrizione.html`, `/sponsor.html` redirigono tutti a `/`. Considerare redirect a pagine più pertinenti oppure ripristinare pagine dedicate per queste sezioni (le API esistono già).

---

### 5.3 Messaggi errore Stripe non tradotti
**🟢 Bassa priorità**

**File:** `shop.html`

Mappare i codici errore Stripe in italiano:
```js
const stripeErrors = {
  'card_declined': 'La carta è stata rifiutata.',
  'insufficient_funds': 'Fondi insufficienti sulla carta.',
  'expired_card': 'La carta è scaduta.',
};
const msg = stripeErrors[err.code] || 'Errore durante il pagamento. Riprova.';
```

---

## 6. Dipendenze

### 6.1 Aggiornamenti disponibili
**🟡 Media priorità**

**File:** `package.json`

| Pacchetto | Versione attuale | Azione |
|-----------|-----------------|--------|
| `express` | `^4.18.2` | Aggiornare alla 4.21.x; valutare Express 5 (breaking changes) |
| `pg` | `^8.11.0` | Aggiornare a 8.13.x (fix disponibili) |
| `dotenv` | `^16.3.1` | Aggiornare a 16.4.x |

```bash
npm audit              # verifica vulnerabilità note
npm update express pg dotenv
```

---

## 7. Infrastruttura e Deploy

### 7.1 Configurazione Railway funzionale
**🟢 Nessun problema critico**

`railway.json` è corretto. Possibile miglioramento: ridurre `healthcheckTimeout` da 60 a 30 secondi per rilevare problemi più rapidamente.

### 7.2 Variabili d'ambiente ben documentate
**🟢 Nessun problema**

`.env.example` è completo e ben commentato. Ottimo punto di riferimento per nuovi deployment.

### 7.3 Monitoring e alerting assenti
**🟢 Bassa priorità**

Nessun sistema di monitoring uptime configurato. Considerare UptimeRobot (gratuito) o Better Uptime per notifiche in caso di downtime.

---

## Tabella Riepilogativa

| # | Area | Problema | File | Priorità |
|---|------|----------|------|----------|
| 1 | Sicurezza | Credenziali hardcoded come fallback (JWT_SECRET, ADMIN_PASSWORD) | `server.js` rr. 30, 383 | 🔴 Alta |
| 2 | Sicurezza | `err.message` esposto in ~20+ risposte HTTP 500 | `server.js` (multipli) | 🔴 Alta |
| 3 | Sicurezza | HTML injection nelle email di iscrizione (no `esc()`) | `server.js` r. 2065 | 🔴 Alta |
| 4 | Sicurezza | Nessun CSRF token per endpoint admin con cookie | `server.js` | 🟡 Media |
| 5 | Sicurezza | CSP con `unsafe-inline` per script | `server.js` r. 122 | 🟢 Bassa |
| 6 | Qualità | CSS massivamente duplicato tra tutte le pagine HTML | Tutti gli `.html` | 🟡 Media |
| 7 | Qualità | Logger non strutturato (51x `console.log` in produzione) | `server.js` | 🟡 Media |
| 8 | Qualità | Tabella `log_attivita` senza pulizia automatica | `server.js`, `db.js` | 🟢 Bassa |
| 9 | Qualità | Due codepath autenticazione non unificate | `server.js` rr. 363–376 | 🟢 Bassa |
| 10 | Performance | Lazy loading mancante su ~80% delle immagini | `index.html`, `shop.html` | 🟡 Media |
| 11 | Performance | Nessun indice DB su colonne di ordinamento frequenti | `db.js` | 🟡 Media |
| 12 | Performance | Cache-Control assente su API pubbliche | `server.js` | 🟢 Bassa |
| 13 | SEO/A11y | Meta OG e H1 mancanti su alcune pagine pubbliche | `live.html`, `calendario.html` | 🟡 Media |
| 14 | SEO/A11y | Attributi ARIA quasi completamente assenti | Tutti gli `.html` | 🟡 Media |
| 15 | SEO/A11y | Immagini senza `alt` nell'admin | `admin.html` | 🟢 Bassa |
| 16 | Funzionalità | Service Worker senza cache — PWA non funzionale offline | `sw.js` | 🟡 Media |
| 17 | Funzionalità | Pagine rimosse reindirizzano solo alla homepage | `server.js` rr. 248–250 | 🟢 Bassa |
| 18 | Funzionalità | Messaggi errore Stripe non tradotti in italiano | `shop.html` | 🟢 Bassa |
| 19 | Dipendenze | `express`, `pg`, `dotenv` con patch non aggiornate | `package.json` | 🟡 Media |
| 20 | Infrastruttura | Nessun monitoring/alerting per uptime | — | 🟢 Bassa |

---

*Report generato automaticamente il 4 maggio 2026 — analisi basata sul codice sorgente in `/virtus-caserta/`.*
