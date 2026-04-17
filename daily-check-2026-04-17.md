# 📋 Daily Check – Virtus Caserta | 17 aprile 2026

---

## 1. Stato di oggi

**Milestone attuale:** Fine finestra 16–17 apr (Webhook Stripe) + Inizio 17–18 apr (Variabili d'ambiente su Railway).

Il webhook è già nel codice — oggi il focus si sposta sulla configurazione dell'ambiente di produzione su Railway.

---

## 2. Check tecnico

### ✅ Webhook Stripe — PRESENTE

L'endpoint `/api/stripe-webhook` è correttamente implementato in `server.js` (righe 54–97):
- Posizionato **prima** di `express.json()` (corretto — richiede raw body)
- Legge `STRIPE_WEBHOOK_SECRET` per validare la firma
- Gestisce `payment_intent.succeeded` e `payment_intent.payment_failed`
- Aggiorna il DB e logga l'attività

### ⚠️ Problema rilevato: metadata `orderId` non passato

Il webhook cerca `pi.metadata?.orderId` per collegare il pagamento all'ordine nel DB, ma il `PaymentIntent` viene creato (sia nel backend che nel frontend) **senza passare metadata**. Di conseguenza, quando Stripe chiama il webhook, `orderId` sarà sempre `undefined` e la query `UPDATE ordini` non avrà effetto.

**Impatto:** Il webhook non aggiorna automaticamente lo stato dell'ordine. Il flusso funziona lo stesso (l'ordine viene salvato da `/api/send-order-email`), ma la double-confirmation è inefficace.

**Fix consigliato** in `server.js` (endpoint `/api/create-payment-intent`), aggiungere il metadata:

```js
// Genera un orderId provvisorio da passare al frontend
const orderId = Date.now().toString();
const pi = await stripe.paymentIntents.create({
  amount: Math.round(amount),
  currency: 'eur',
  automatic_payment_methods: { enabled: true },
  metadata: { orderId },
});
res.json({ clientSecret: pi.client_secret, orderId });
```

Poi in `shop.html`, usare l'`orderId` restituito al posto di `paymentIntent.id` nella chiamata a `inviaEmail()`.

### ✅ Email — Correttamente configurata nel codice

`EMAIL_USER` e `EMAIL_PASS` sono referenziate tramite `emailConfigurata()`. Il transporter Gmail (STARTTLS 587) è configurato. Rimane da impostare le variabili reali su Railway.

### ✅ Privacy policy e Termini — OK

- `privacy.html`: menziona Stripe/PayPal, basi legali GDPR (art. 6 lett. a e b), cookie tecnici e consenso.
- `termini.html`: menziona Stripe PCI-DSS.
- Cookie banner: presente in `common.js` con pulsanti "Accetta" e "Solo tecnici".

### ✅ railway.json — Configurazione deployment OK

`railway.json` è presente e configurato con `startCommand: node server.js`, healthcheck su `/health`, e restart policy su failure.
Le variabili d'ambiente (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `EMAIL_USER`, `EMAIL_PASS`, `DATABASE_URL`, ecc.) devono essere inserite manualmente nella dashboard Railway.

---

## 3. Attività del giorno

**1. Configurare le variabili d'ambiente su Railway**
   - Accedi a railway.app → progetto `virtus-caserta` → Variables
   - Inserisci: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `EMAIL_USER`, `EMAIL_PASS`, `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`

**2. Registrare il webhook su Stripe Dashboard**
   - Vai su dashboard.stripe.com → Developers → Webhooks → Add endpoint
   - URL: `https://<dominio-railway>/api/stripe-webhook`
   - Eventi da ascoltare: `payment_intent.succeeded` + `payment_intent.payment_failed`
   - Copia il **Signing Secret** → inseriscilo come `STRIPE_WEBHOOK_SECRET` su Railway

**3. Correggere il metadata `orderId` nel PaymentIntent** (vedi fix sopra)
   - Fix rapido, 5 minuti di lavoro, importante prima del deploy in produzione

---

## 4. Eventuali problemi rilevati

| Problema | Severità | Note |
|---|---|---|
| metadata `orderId` non passato al PaymentIntent | ⚠️ Media | Il flusso ordini funziona, ma il webhook non aggiornerà lo stato nel DB automaticamente |
| `STRIPE_WEBHOOK_SECRET` non configurato blocca il webhook con HTTP 500 | ⚠️ Alta | Va inserito su Railway **prima** di andare live |

---

## 5. Domanda all'utente

**Hai già configurato le variabili d'ambiente su Railway (STRIPE_SECRET_KEY, DATABASE_URL, EMAIL_USER, ecc.)?**
Se sì, puoi verificare che tutto funzioni visitando `https://<dominio-railway>/health` — dovrebbe rispondere `{"status":"ok"}`.

---

*Report generato automaticamente — 17 aprile 2026*
