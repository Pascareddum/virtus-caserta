# 📋 Daily Check – Virtus Caserta | 28 aprile 2026

---

## 1. Stato di oggi

**Milestone attuale:** Finestra **28–30 apr — Buffer finale + Go Live** 🚀
Mancano **2 giorni** al termine. Il sito deve essere live con acquisti reali entro il **30 aprile 2026**.

Tutte le milestone precedenti risultano completate lato codice. Oggi si entra nella fase finale: **verifica, go-live e monitoraggio**.

---

## 2. Check tecnico

### ✅ Webhook Stripe — PRESENTE e corretto
`server.js` riga 150: endpoint `/api/stripe-webhook` registrato con `express.raw()` e verifica firma via `STRIPE_WEBHOOK_SECRET`. Gestisce `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`. Tutto corretto.

### ✅ Email ordini — Codice pronto (Brevo SMTP)
`brevoConfigurato()` valida `BREVO_SMTP_LOGIN` e `BREVO_SMTP_KEY` prima di inviare. `brevoFrom()` usa `BREVO_FROM_EMAIL`. Il codice è corretto — serve solo conferma che le variabili siano su Railway.

### ✅ Privacy / GDPR — OK
`privacy.html` cita Stripe come processore PCI-DSS. Cookie banner presente in `common.js`. Milestone completata.

### ✅ Deployment Railway — Configurazione corretta
`railway.json` con `node server.js`, health check su `/health`, restart automatico. Il server blocca all'avvio se mancano `JWT_SECRET`, `ADMIN_PASSWORD`, `ADMIN_USERNAME`.

### ✅ BASE_URL — Corretto
Default: `https://www.virtuscaserta.com` (riga 260 di server.js).

---

## 3. Attività del giorno (28 aprile — inizio buffer Go Live)

**1. Verifica che il dominio www.virtuscaserta.com punti a Railway** *(se non ancora fatto)*
Nel dashboard Railway → Settings → Domains: il dominio deve essere verificato con record DNS corretto (CNAME o A record).

**2. Fai il test end-to-end con pagamento reale** *(priorità assoluta)*
Acquista un prodotto sul sito live. Verifica:
- L'ordine appare nel pannello admin con stato corretto
- L'email di conferma arriva al cliente via Brevo
- Il webhook aggiorna lo stato nel DB (controlla i log Railway)

**3. Verifica il webhook su Stripe Dashboard (modalità Live)**
`dashboard.stripe.com → Webhook` → l'URL deve essere:
`https://www.virtuscaserta.com/api/stripe-webhook`
Non in modalità Test — deve essere **Live**.

---

## 4. Problemi rilevati

| Problema | Severità | Stato |
|----------|----------|-------|
| Variabili d'ambiente Railway non verificabili dal codice | ⚠️ Alta | Da confermare: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`, `BREVO_FROM_EMAIL`, `JWT_SECRET`, `ADMIN_PASSWORD`, `ADMIN_USERNAME`, `DATABASE_URL` |
| Test pagamento reale non ancora confermato nei check precedenti | ⚠️ Alta | Da eseguire oggi |
| Nessun `render.yaml` presente | ℹ️ Info | Il progetto usa Railway — nessun problema |

---

## 5. Domanda all'utente

**Il dominio www.virtuscaserta.com è già configurato e attivo su Railway?**
Se sì: il sito è raggiungibile in produzione e puoi procedere con il test di pagamento reale.
Se no: questa è la priorità immediata — senza dominio attivo non è possibile configurare il webhook Stripe in modalità live né testare il flusso completo.
