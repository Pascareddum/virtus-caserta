# 📋 Daily Check – Virtus Caserta | 20 aprile 2026

---

## 1. Stato di oggi

**Milestone attuale:** Ultimo giorno della finestra **19–20 apr — Dominio `www.virtuscaserta.com`**.

Da domani (21–22 apr) si entra nella finestra **Email ordini funzionanti**. Restano **10 giorni** al Go Live (30 aprile).

> Nota: il progetto è deployato su **Railway** (file `railway.json` presente), non su Render. Il `render.yaml` menzionato nel task non esiste nel repo — le istruzioni di deploy vanno lette su Railway.

---

## 2. Check tecnico

### ✅ Webhook Stripe — PRESENTE E CORRETTO
`server.js` riga 59: endpoint `/api/stripe-webhook` registrato con `express.raw({ type: 'application/json' })` **prima** di `express.json()`. Valida la firma con `STRIPE_WEBHOOK_SECRET` e gestisce `payment_intent.succeeded` / `payment_intent.payment_failed`.

### ✅ Bug `metadata.orderId` — RISOLTO
Il fix segnalato nei check del 17–18 apr è stato applicato:
- `server.js` riga 486–491: l'endpoint `/api/create-payment-intent` ora genera `const orderId = Date.now().toString()` e lo passa sia nel `metadata` del PaymentIntent sia nella risposta JSON.
- `shop.html` riga 934: il frontend riceve `orderId` dal backend e lo inoltra a `inviaEmail(orderId)` (riga 950).

Il collegamento pagamento ↔ ordine nel webhook ora funziona correttamente.

### ✅ Email — Codice pronto
`EMAIL_USER`, `EMAIL_PASS`, `EMAIL_ADMIN` referenziati correttamente (righe 34–49, 628, 714, 1458–1459, 1622–1632). La funzione `emailConfigurata()` valida la presenza delle variabili. Manca solo l'impostazione reale su Railway.

### ✅ Privacy / GDPR
`privacy.html` e `common.js` (cookie banner) già OK dal check precedente. La finestra dedicata è 25–27 apr.

---

## 3. Attività del giorno (20 aprile)

**1. Configurare il dominio personalizzato su Railway**
- Railway → progetto → Settings → Networking → **Custom Domain** → aggiungi `www.virtuscaserta.com` (e opzionalmente `virtuscaserta.com` con redirect).
- Nel pannello DNS del registrar (dove è registrato `virtuscaserta.com`) aggiungi il record CNAME fornito da Railway per `www` e un redirect/ALIAS per l'apex.
- Attendi la propagazione (da minuti a ~1h) e verifica SSL automatico (Let's Encrypt attivato da Railway).

**2. Aggiornare il webhook Stripe con il nuovo dominio**
Una volta che `www.virtuscaserta.com` risponde, vai su dashboard.stripe.com → Developers → Webhooks e modifica l'endpoint da `<progetto>.railway.app/api/stripe-webhook` a `https://www.virtuscaserta.com/api/stripe-webhook`. Copia il nuovo **Signing Secret** e aggiornalo come `STRIPE_WEBHOOK_SECRET` su Railway.

**3. Smoke test post-dominio**
- `https://www.virtuscaserta.com/health` → deve rispondere `{"status":"ok"}`
- `https://www.virtuscaserta.com/shop` → carica prodotti
- Nessun mixed-content warning nella console browser

---

## 4. Problemi rilevati

| Problema | Severità | Stato |
|---|---|---|
| Nessun bug nuovo nel codice | — | OK |
| Variabili d'ambiente su Railway | 🔴 Alta | Non verificabile dal codice |
| Dominio + SSL attivi | 🔴 Alta | Non verificabile dal codice — task di oggi |
| `render.yaml` menzionato nel piano ma inesistente | 🟡 Bassa | Il progetto usa `railway.json` |

---

## 5. Domanda all'utente

**Hai già avviato la configurazione del dominio `www.virtuscaserta.com` su Railway e aggiunto il record CNAME nel DNS del registrar?**
(Serve sapere se partiamo da zero oggi o se la propagazione DNS è già in corso — da questo dipende se domani possiamo entrare nella finestra email con il dominio già live.)

---

*Report generato automaticamente — 20 aprile 2026*
