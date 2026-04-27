# 📋 Daily Check – Virtus Caserta | 26 aprile 2026

---

## 1. Stato di oggi

**Milestone attuale:** Finestra **25–27 apr — Privacy policy + cookie banner GDPR** → già completata.
**Prossimo step:** **28–30 apr — Buffer finale + Go Live** su `www.virtuscaserta.com`.

Restano **4 giorni** al Go Live. Questa è l'ultima finestra utile per test finali e correzioni.

---

## 2. Check tecnico

### ✅ Webhook Stripe — PRESENTE e corretto
`server.js` riga 150: endpoint `/api/stripe-webhook` registrato con `express.raw()` **prima** di `express.json()` (ordine corretto). Gestisce `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`. Firma verificata via `STRIPE_WEBHOOK_SECRET`.

### ✅ Email — Codice pronto
`EMAIL_USER`, `EMAIL_PASS`, `EMAIL_ADMIN` referenziati correttamente in più punti. La funzione `emailConfigurata()` valida la presenza delle variabili prima di inviare. Endpoint di test disponibile: `POST /api/admin/test-email`. **Manca solo conferma che le variabili siano impostate su Railway.**

### ✅ Privacy / Cookie banner — OK
`privacy.html` cita Stripe come processore di pagamento (PCI-DSS). `common.js` contiene il cookie banner GDPR con pulsanti Accetta / Solo tecnici. Milestone 25–27 apr **già completata**.

### ✅ Endpoint `/health` — PRESENTE
`GET /health` risponde `{"status":"ok"}` — pronto per smoke test post-deploy.

### ⚠️ Deployment su Railway (non Render)
Trovato `railway.json`, **nessun `render.yaml`**. Il piano di lancio fa riferimento a Render, ma il progetto è configurato per Railway. Verifica che la piattaforma di deploy usata sia quella giusta e che il dominio `www.virtuscaserta.com` punti correttamente.

---

## 3. Attività del giorno (26 aprile — ultimi 4 giorni al Go Live)

**1. Eseguire il test end-to-end con pagamento reale** *(milestone 23-24 apr, da confermare)*
Fai un acquisto reale sul sito con una carta Stripe in modalità live. Verifica che:
- L'ordine venga registrato nel DB con stato `in lavorazione`
- Il webhook aggiorni correttamente lo stato
- L'email di conferma arrivi al cliente e all'admin

**2. Verificare `STRIPE_WEBHOOK_SECRET` su Railway**
Vai su `dashboard.stripe.com → Webhook` e controlla che l'URL configurato sia `https://www.virtuscaserta.com/api/stripe-webhook`. Copia il signing secret e aggiorna la variabile `STRIPE_WEBHOOK_SECRET` su Railway se necessario.

**3. Smoke test finale**
Controlla che `https://www.virtuscaserta.com/health` risponda `{"status":"ok"}` e che la shop funzioni end-to-end in modalità produzione.

---

## 4. Problemi rilevati

| Problema | Severità | Note |
|----------|----------|------|
| Piattaforma deploy incerta (Railway vs Render) | ⚠️ Media | `railway.json` presente, nessun `render.yaml`. Conferma quale piattaforma è in uso. |
| `STRIPE_WEBHOOK_SECRET` non verificabile dal codice | ⚠️ Media | Il codice è pronto; la variabile su Railway deve essere impostata e verificata. |
| Test pagamento reale non confermato | ⚠️ Alta | Milestone 23-24 apr: non risulta completata nei check precedenti. Priorità massima oggi. |

---

## 5. Domanda all'utente

**Hai già eseguito un pagamento reale di test (milestone 23–24 apr)?**
Se sì: lo stato degli ordini nel DB si è aggiornato correttamente e l'email è arrivata?
Se no: questo è il momento critico — fallo oggi prima del buffer finale.
