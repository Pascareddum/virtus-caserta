# 📋 Daily Check – Virtus Caserta | 18 aprile 2026

---

## 1. Stato di oggi

**Milestone attuale:** Fine finestra 17–18 apr (Variabili d'ambiente su Railway) + Preparazione per 19–20 apr (Dominio www.virtuscaserta.com).

Oggi è l'ultimo giorno utile per completare la configurazione delle variabili d'ambiente. Da domani si entra nella finestra del dominio personalizzato.

---

## 2. Check tecnico

### ✅ Webhook Stripe (`/api/stripe-webhook`) — PRESENTE E CORRETTO

Confermato anche oggi: l'endpoint è presente in `server.js` (righe 59–102), posizionato correttamente prima di `express.json()`, legge `STRIPE_WEBHOOK_SECRET` e gestisce `payment_intent.succeeded` e `payment_intent.payment_failed`.

### ⚠️ Bug ancora aperto: metadata `orderId` non passato al PaymentIntent

Questo problema è stato segnalato ieri e **non risulta ancora corretto**:

- `shop.html` riga 947: chiama `inviaEmail(paymentIntent.id)` — passa l'ID del PaymentIntent come orderId, non quello dell'ordine DB
- `server.js` endpoint `/api/create-payment-intent`: crea il PaymentIntent **senza `metadata`**, quindi il webhook non riesce a collegare il pagamento all'ordine

**Conseguenza pratica:** quando Stripe chiama il webhook dopo un pagamento riuscito, `pi.metadata?.orderId` sarà `undefined` e il DB non viene aggiornato automaticamente.

**Fix rapido (5 minuti):**

In `server.js`, modifica l'endpoint `/api/create-payment-intent` (riga 474–488):

```js
app.post('/api/create-payment-intent', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe non configurato. Aggiungi STRIPE_SECRET_KEY nel file .env' });
  try {
    const { amount, orderId } = req.body;  // ← aggiungi orderId
    if (!amount || amount < 50) return res.status(400).json({ error: 'Importo non valido' });
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { orderId: orderId || '' },  // ← aggiungi metadata
    });
    res.json({ clientSecret: pi.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

In `shop.html` riga 929, passa un orderId generato prima del pagamento:

```js
const orderId = Date.now().toString();
body: JSON.stringify({ amount: Math.round(totale * 100), orderId }),
```

Poi riga 947 usa `orderId` invece di `paymentIntent.id`:

```js
await inviaEmail(orderId);
```

### ✅ Email — Configurazione nel codice corretta

`EMAIL_USER`, `EMAIL_PASS`, `EMAIL_ADMIN` sono tutte referenziate correttamente. Transporter Gmail (STARTTLS 587, IPv4). Manca solo l'impostazione delle variabili reali su Railway.

### ✅ Privacy & GDPR — OK

`privacy.html` menziona Stripe/PayPal, basi legali GDPR, cookie tecnici. Cookie banner presente in `common.js`. Nessun intervento necessario su questo fronte per ora (la finestra dedicata è 25–27 apr).

### ✅ railway.json — Configurazione deployment OK

File presente con `startCommand: node server.js`, healthcheck su `/health`, restart policy configurata.

---

## 3. Attività del giorno

**1. Completare le variabili d'ambiente su Railway** ← priorità massima oggi

Se non fatto ieri, accedi a railway.app → progetto → Variables e inserisci:

| Variabile | Dove trovarla |
|---|---|
| `STRIPE_SECRET_KEY` | dashboard.stripe.com → Developers → API keys |
| `STRIPE_PUBLISHABLE_KEY` | stessa pagina (chiave pubblica) |
| `STRIPE_WEBHOOK_SECRET` | Developers → Webhooks → Signing secret |
| `EMAIL_USER` | indirizzo Gmail mittente |
| `EMAIL_PASS` | App Password Gmail (non la password normale) |
| `JWT_SECRET` | qualsiasi stringa lunga e casuale |
| `ADMIN_PASSWORD` | password per il pannello admin |
| `DATABASE_URL` | fornita automaticamente da Railway se usi PostgreSQL add-on |

**2. Applicare il fix del metadata `orderId`** (vedi sezione 2 — 5 minuti)

Importante completarlo prima del test end-to-end del 23–24 apr.

**3. Verificare il funzionamento base del sito su Railway**

Dopo aver configurato le variabili, visita:
- `https://<dominio-railway>/health` → deve rispondere `{"status":"ok"}`
- `https://<dominio-railway>/shop` → deve caricare la pagina e i prodotti

---

## 4. Eventuali problemi rilevati

| Problema | Severità | Stato |
|---|---|---|
| `metadata.orderId` non passato al PaymentIntent | ⚠️ Media | Aperto dal 17 apr |
| `STRIPE_WEBHOOK_SECRET` non configurato → webhook ritorna HTTP 500 | 🔴 Alta | Non verificabile dal codice — dipende da Railway |
| `EMAIL_USER`/`EMAIL_PASS` non configurate → email non inviate | 🔴 Alta | Non verificabile dal codice — dipende da Railway |

---

## 5. Domanda all'utente

**Hai configurato il webhook su Stripe Dashboard puntando all'URL di Railway?**
(dashboard.stripe.com → Developers → Webhooks → Add endpoint → URL: `https://<tuo-progetto>.railway.app/api/stripe-webhook`, eventi: `payment_intent.succeeded` + `payment_intent.payment_failed`)

Se sì, hai già il **Signing Secret** da inserire come `STRIPE_WEBHOOK_SECRET` su Railway.

---

*Report generato automaticamente — 18 aprile 2026*
