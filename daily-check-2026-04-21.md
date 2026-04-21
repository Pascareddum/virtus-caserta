# 📋 Daily Check – Virtus Caserta | 21 aprile 2026

---

## 1. Stato di oggi

**Milestone attuale:** Finestra **21–22 apr — Email ordini funzionanti**.

Restano **9 giorni** al Go Live (30 aprile). Il codice non ha subito modifiche dopo il 20 aprile (ultimo commit rilevato: `server.js` e `shop.html` ore 12:06–12:07 del 20 apr).

---

## 2. Check tecnico

### ✅ Webhook Stripe — PRESENTE
`server.js` riga 66: endpoint `/api/stripe-webhook` registrato correttamente con `express.raw()` prima di `express.json()`. Gestisce `payment_intent.succeeded` e `payment_intent.payment_failed`. Usa `STRIPE_WEBHOOK_SECRET` per la verifica della firma.

### ✅ Email — Codice pronto e corretto
- `EMAIL_USER`, `EMAIL_PASS`, `EMAIL_ADMIN` referenziati in più punti (righe 39–54, 668, 754, 852, 1515–1516, 1684–1685).
- La funzione `emailConfigurata()` (riga 54) valida la presenza delle variabili prima di tentare l'invio.
- Le email coprono: conferma ordine al cliente, notifica admin, test manuale via endpoint `/api/admin/test-email`.
- **Manca solo la configurazione reale delle variabili su Railway.**

### ✅ Privacy / Cookie banner — OK
`privacy.html` menziona Stripe come processore di pagamento. `common.js` (riga 74) include il cookie banner GDPR con accetta/rifiuta. Finestra dedicata alla revisione: 25–27 apr — ma è già a posto.

### ✅ Endpoint `/health` — PRESENTE
`server.js` riga 63: `GET /health` risponde `{"status":"ok"}` — utile per smoke test post-deploy.

---

## 3. Attività del giorno (21 aprile)

**1. Configurare `EMAIL_USER` e `EMAIL_PASS` su Railway**
Su Railway → progetto → Variables, aggiungi (se non già fatto):
```
EMAIL_USER=<indirizzo Gmail o SMTP usato per le notifiche>
EMAIL_PASS=<password app Gmail (non la password account)>
EMAIL_ADMIN=<indirizzo dove arrivano le notifiche ordini>
```
Per Gmail: usa una **App Password** da myaccount.google.com → Sicurezza → Autenticazione a 2 fattori → Password per le app.

**2. Testare l'invio email via pannello admin**
Una volta impostate le variabili, chiama l'endpoint di test:
```
POST https://www.virtuscaserta.com/api/admin/test-email
Authorization: Bearer <admin-token>
```
Verifica che l'email arrivi in inbox (e non in spam).

**3. Verificare lo stato del dominio (carry-over dal 20 apr)**
Se il dominio `www.virtuscaserta.com` non era ancora attivo ieri:
- Conferma propagazione DNS: `dig www.virtuscaserta.com` → deve puntare a Railway.
- Aggiorna l'endpoint webhook su dashboard.stripe.com con l'URL definitivo e aggiorna `STRIPE_WEBHOOK_SECRET` su Railway.

---

## 4. Problemi rilevati

| Problema | Severità | Stato |
|---|---|---|
| Nessun bug nuovo nel codice | — | ✅ OK |
| `EMAIL_USER` / `EMAIL_PASS` non verificabili dal codice | 🔴 Alta | Da configurare su Railway oggi |
| Dominio + webhook Stripe aggiornato | 🔴 Alta | Non verificabile dal codice — dipende dal 20 apr |
| Nessuna modifica al codice dal 20 apr | 🟡 Info | Il codebase è stabile |

---

## 5. Domanda all'utente

**Hai già impostato `EMAIL_USER` e `EMAIL_PASS` su Railway? E il dominio `www.virtuscaserta.com` risponde correttamente?**
Queste due informazioni determinano se siamo in linea con il piano o se c'è qualcosa da recuperare prima del 23–24 apr (test end-to-end con pagamento reale).

---

*Report generato automaticamente — 21 aprile 2026*
