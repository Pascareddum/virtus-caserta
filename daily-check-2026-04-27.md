# 📋 Daily Check – Virtus Caserta | 27 aprile 2026

---

## 1. Stato di oggi

**Milestone attuale:** Ultimo giorno della finestra **25–27 apr** (Privacy/GDPR — già completata).
**Da domani:** Finestra **28–30 apr — Buffer finale + Go Live**.

Restano **3 giorni** al lancio su `www.virtuscaserta.com`. Oggi è l'ultimo momento utile per chiudere eventuali pendenze prima del buffer finale.

---

## 2. Check tecnico

### ✅ Webhook Stripe — PRESENTE e corretto
`server.js` riga 150: endpoint `/api/stripe-webhook` registrato con `express.raw()` e verifica firma via `STRIPE_WEBHOOK_SECRET`. Gestisce `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`. Tutto corretto.

### ✅ Email shop — Codice pronto (Brevo SMTP)
Le email degli ordini usano **Brevo SMTP** (`BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`, `BREVO_FROM_EMAIL`). Le email di contatto/iscrizioni usano Gmail (`EMAIL_USER`, `EMAIL_PASS`). La funzione `brevoConfigurato()` valida la presenza delle variabili prima di inviare. Il codice è corretto — manca solo la conferma che le variabili siano impostate su Railway.

### ✅ Privacy / Cookie banner GDPR — OK
`privacy.html` cita Stripe come processore PCI-DSS. `common.js` contiene il cookie banner con pulsanti Accetta / Solo tecnici. Milestone **già completata**.

### ✅ Deployment su Railway — Configurazione corretta
`railway.json` presente con `startCommand: node server.js`, health check su `/health`, restart automatico. Il server ha anche un controllo all'avvio che blocca se mancano `JWT_SECRET`, `ADMIN_PASSWORD`, `ADMIN_USERNAME`.

### ✅ BASE_URL — Corretto
`server.js` riga 260: `BASE_URL` di default è `https://www.virtuscaserta.com`.

---

## 3. Attività del giorno (27 aprile — ultimo giorno pre-buffer)

**1. Verifica le variabili d'ambiente su Railway** *(priorità massima)*
Controlla che nel dashboard Railway siano impostate tutte:
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- `BREVO_SMTP_LOGIN`, `BREVO_SMTP_KEY`, `BREVO_FROM_EMAIL`
- `JWT_SECRET`, `ADMIN_PASSWORD`, `ADMIN_USERNAME`
- `DATABASE_URL` (Supabase PostgreSQL)

**2. Verifica l'URL del webhook su Stripe Dashboard**
Vai su `dashboard.stripe.com → Webhook` e controlla che l'endpoint configurato sia esattamente:
`https://www.virtuscaserta.com/api/stripe-webhook`
(in modalità **Live**, non Test).

**3. Esegui il test end-to-end con pagamento reale** *(se non ancora fatto)*
Fai un acquisto reale sul sito. Verifica che:
- L'ordine venga registrato nel DB con stato corretto
- L'email di conferma arrivi al cliente e all'admin via Brevo
- Il webhook aggiorni lo stato dell'ordine

---

## 4. Problemi rilevati

| Problema | Severità | Note |
|----------|----------|------|
| Variabili d'ambiente non verificabili dal codice | ⚠️ Alta | Stripe (live), Brevo, JWT, DB — devono essere tutte impostate su Railway |
| Test pagamento reale non confermato | ⚠️ Alta | Milestone 23–24 apr: non risulta confermata nei check precedenti |
| Nessun `render.yaml` presente | ℹ️ Info | Il piano originale citava Render, ma il progetto usa Railway. Nessun problema se Railway è la piattaforma scelta |

---

## 5. Domanda all'utente

**Hai già eseguito un pagamento reale di test sul sito live?**
Se sì: l'email di conferma è arrivata (via Brevo) e l'ordine è apparso nel pannello admin?
Se no: è la cosa più urgente da fare oggi — prima del buffer finale di domani.
