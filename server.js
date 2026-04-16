require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const jwt        = require('jsonwebtoken');
const multer     = require('multer');
const crypto     = require('crypto');
const rateLimit      = require('express-rate-limit');
const cookieParser   = require('cookie-parser');
const db             = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('[ERRORE CRITICO] JWT_SECRET non configurato. Imposta JWT_SECRET nelle variabili d\'ambiente di Railway prima di avviare in produzione.');
  process.exit(1);
}
const JWT_SECRET             = process.env.JWT_SECRET || 'virtus_secret_2026_dev';
const INSTAGRAM_USERNAME     = 'virtuscaserta';
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || '';

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/* ─── Nodemailer: transporter riusabile ─── */
function creaTransporter() {
  // Rimuove virgolette e spazi dall'app password (comune errore nel settare le env vars)
  const emailPass = (process.env.EMAIL_PASS || '').replace(/['"]/g, '').trim();
  const emailUser = (process.env.EMAIL_USER || '').replace(/['"]/g, '').trim();
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // STARTTLS
    auth: { user: emailUser, pass: emailPass },
  });
}

function emailConfigurata() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

app.set('trust proxy', 1);
app.use(cookieParser());

/* ─── Health check (Railway) ─── */
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

/* ─── Stripe Webhook (raw body – DEVE stare prima di express.json) ─── */
app.post('/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) return res.status(503).send('Stripe non configurato');
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.log('[Webhook] STRIPE_WEBHOOK_SECRET non configurato');
      return res.status(500).send('Webhook secret mancante');
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.log('[Webhook] Firma non valida:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const orderId = pi.metadata?.orderId;
      console.log(`[Webhook] Pagamento confermato – PaymentIntent: ${pi.id}${orderId ? ', Ordine: ' + orderId : ''}`);
      try {
        if (orderId) {
          await db.query(
            `UPDATE ordini SET stato='ricevuto', stripe_payment_id=$1 WHERE id=$2`,
            [pi.id, orderId]
          );
          await logActivity('Pagamento confermato via webhook', `Ordine #${orderId} – PI: ${pi.id}`);
        }
      } catch (dbErr) {
        console.log('[Webhook] Errore aggiornamento DB:', dbErr.message);
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      console.log(`[Webhook] Pagamento fallito – PaymentIntent: ${pi.id}`);
      await logActivity('Pagamento fallito', `PI: ${pi.id}`);
    }

    res.json({ received: true });
  }
);

app.use(express.json());

/* ─── Pagine: URL puliti e protezione admin ─── */
const sendPage = (file) => (_req, res) => res.sendFile(path.join(__dirname, file));

function adminCookieCheck(req, res, next) {
  const token = req.cookies.vc_admin_session;
  if (!token) return res.redirect('/admin-login');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return res.redirect('/admin-login');
    next();
  } catch {
    res.clearCookie('vc_admin_session');
    return res.redirect('/admin-login');
  }
}

// Redirect da URL .html a URL puliti
app.get('/index.html',              (_req, res) => res.redirect(301, '/'));
app.get('/chiSiamo.html',           (_req, res) => res.redirect(301, '/chi-siamo'));
app.get('/notizie.html',            (_req, res) => res.redirect(301, '/notizie'));
app.get('/calendario.html',         (_req, res) => res.redirect(301, '/calendario'));
app.get('/shop.html',               (_req, res) => res.redirect(301, '/shop'));
app.get('/admin.html',              adminCookieCheck, sendPage('admin.html'));
app.get('/admin-login.html',        (_req, res) => res.redirect(301, '/admin-login'));
app.get('/reset-password.html',     (_req, res) => res.redirect(301, '/reset-password'));
app.get('/squadra.html',            (_req, res) => res.redirect(301, '/squadra'));
app.get('/galleria.html',           (_req, res) => res.redirect(301, '/galleria'));
app.get('/iscrizione.html',         (_req, res) => res.redirect(301, '/iscrizione'));
app.get('/sponsor.html',            (_req, res) => res.redirect(301, '/sponsor'));
app.get('/risultati.html',          (_req, res) => res.redirect(301, '/risultati'));
app.get('/privacy.html',            (_req, res) => res.redirect(301, '/privacy'));
app.get('/termini.html',            (_req, res) => res.redirect(301, '/termini'));
app.get('/ordine-confermato.html',  (_req, res) => res.redirect(301, '/ordine-confermato'));

// URL puliti
app.get('/',                sendPage('index.html'));
app.get('/chi-siamo',       sendPage('chiSiamo.html'));
app.get('/notizie',         sendPage('notizie.html'));
app.get('/calendario',      sendPage('calendario.html'));
app.get('/shop',            sendPage('shop.html'));
app.get('/admin',           adminCookieCheck, sendPage('admin.html'));
app.get('/admin-login',     sendPage('admin-login.html'));
app.get('/reset-password',  sendPage('reset-password.html'));
app.get('/squadra',         sendPage('squadra.html'));
app.get('/galleria',        sendPage('galleria.html'));
app.get('/iscrizione',      sendPage('iscrizione.html'));
app.get('/sponsor',         sendPage('sponsor.html'));
app.get('/risultati',       sendPage('risultati.html'));
app.get('/classifica',      sendPage('classifica.html'));
app.get('/staff',           sendPage('staff.html'));
app.get('/privacy',         sendPage('privacy.html'));
app.get('/termini',         sendPage('termini.html'));
app.get('/ordine-confermato', sendPage('ordine-confermato.html'));

app.use(express.static(path.join(__dirname)));

/* ─── Health check (Railway) ─── */
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

/* ─── Rate limiting ─── */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppi tentativi. Riprova tra 15 minuti.' },
});

/* ─── Multer upload ─── */
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename:    (_req,  file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_')),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});
app.use('/uploads', express.static(UPLOADS_DIR));

/* ─── Auth middleware ─── */
function verifyToken(req) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function adminAuth(req, res, next) {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Non autenticato' });
  if (payload.role !== 'admin') return res.status(403).json({ error: 'Accesso riservato agli amministratori' });
  req.user = payload;
  next();
}

/* ─── Login admin ─── */
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username e password obbligatori' });

  const adminPassword = process.env.ADMIN_PASSWORD || 'virtus2026';
  const validUser =
    username === (process.env.ADMIN_USERNAME || 'admin') ||
    username === process.env.ADMIN_EMAIL;
  const passMatch = crypto.timingSafeEqual(
    Buffer.from(password.padEnd(64)),
    Buffer.from(adminPassword.padEnd(64))
  );
  if (validUser && passMatch) {
    const token = jwt.sign({ role: 'admin', nome: 'Admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('vc_admin_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000, // 8 ore
      secure: process.env.NODE_ENV === 'production',
    });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Credenziali non valide' });
});

/* ─── Logout admin ─── */
app.post('/api/admin/logout', (_req, res) => {
  res.clearCookie('vc_admin_session');
  res.json({ success: true });
});

/* ─── Calendario: pubblico ─── */
app.get('/api/calendario', async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM calendario ORDER BY data_str, ora');
    const rows = result.rows.map(r => ({
      id:        r.id,
      titolo:    r.titolo,
      data:      r.data_str,
      ora:       r.ora,
      luogo:     r.luogo,
      categoria: r.categoria,
      note:      r.note,
    }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Calendario: crea sessione ─── */
app.post('/api/calendario', adminAuth, async (req, res) => {
  const { titolo, data, ora, luogo, categoria, note, ripetizione_settimanale, data_fine_ripetizione } = req.body;
  if (!titolo || !data || !ora) return res.status(400).json({ error: 'Titolo, data e ora obbligatori' });
  try {
    if (ripetizione_settimanale && data_fine_ripetizione && data_fine_ripetizione >= data) {
      const sessioni = [];
      let currentDate = new Date(data + 'T00:00:00');
      const endDate   = new Date(data_fine_ripetizione + 'T00:00:00');
      let i = 0;
      while (currentDate <= endDate) {
        const id      = Date.now().toString() + '_' + i;
        const dataStr = currentDate.toISOString().slice(0, 10);
        await db.query(
          `INSERT INTO calendario (id, titolo, data_str, ora, luogo, categoria, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, titolo, dataStr, ora, luogo || '', categoria || '', note || '']
        );
        sessioni.push({ id, titolo, data: dataStr, ora });
        currentDate.setDate(currentDate.getDate() + 7);
        i++;
      }
      return res.status(201).json({ sessioni, count: sessioni.length });
    }
    const id = Date.now().toString();
    await db.query(
      `INSERT INTO calendario (id, titolo, data_str, ora, luogo, categoria, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, titolo, data, ora, luogo || '', categoria || '', note || '']
    );
    res.status(201).json({ id, titolo, data, ora, luogo: luogo || '', categoria: categoria || '', note: note || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Calendario: aggiorna sessione ─── */
app.put('/api/calendario/:id', adminAuth, async (req, res) => {
  const { titolo, data, ora, luogo, categoria, note } = req.body;
  try {
    const result = await db.query(
      `UPDATE calendario
       SET titolo=$1, data_str=$2, ora=$3, luogo=$4, categoria=$5, note=$6
       WHERE id=$7
       RETURNING *`,
      [titolo, data, ora, luogo || '', categoria || '', note || '', req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    const r = result.rows[0];
    res.json({ id: r.id, titolo: r.titolo, data: r.data_str, ora: r.ora, luogo: r.luogo, categoria: r.categoria, note: r.note });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Calendario: elimina sessione ─── */
app.delete('/api/calendario/:id', adminAuth, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM calendario WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Prodotti: pubblico ─── */
app.get('/api/products', async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM products ORDER BY created_at');
    const rows = result.rows.map(r => ({
      id:          r.id,
      nome:        r.nome,
      descrizione: r.descrizione,
      prezzo:      parseFloat(r.prezzo),
      emoji:       r.emoji,
      disponibile: r.disponibile,
      taglie:      r.taglie,
      immagine:    r.immagine,
    }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Admin: aggiungi prodotto ─── */
app.post('/api/admin/products', adminAuth, async (req, res) => {
  const { nome, descrizione, prezzo, emoji, taglie, disponibile, immagine } = req.body;
  if (!nome || !prezzo) return res.status(400).json({ error: 'Nome e prezzo obbligatori' });
  const id = Date.now().toString();
  try {
    await db.query(
      `INSERT INTO products (id, nome, descrizione, prezzo, emoji, disponibile, taglie, immagine)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, nome, descrizione || '', parseFloat(prezzo), emoji || '🏐', disponibile !== false,
       JSON.stringify(taglie || ['S', 'M', 'L', 'XL']), immagine || '']
    );
    await logActivity('Prodotto aggiunto', nome);
    res.status(201).json({
      id, nome, descrizione: descrizione || '', prezzo: parseFloat(prezzo),
      emoji: emoji || '🏐', disponibile: disponibile !== false,
      taglie: taglie || ['S', 'M', 'L', 'XL'], immagine: immagine || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Admin: aggiorna prodotto ─── */
app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  const { nome, descrizione, prezzo, emoji, taglie, disponibile, immagine } = req.body;
  try {
    const result = await db.query(
      `UPDATE products
       SET nome=$1, descrizione=$2, prezzo=$3, emoji=$4, disponibile=$5, taglie=$6, immagine=$7
       WHERE id=$8
       RETURNING *`,
      [nome, descrizione || '', parseFloat(prezzo), emoji || '🏐', disponibile !== false,
       JSON.stringify(taglie || ['S', 'M', 'L', 'XL']), immagine || '', req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Prodotto non trovato' });
    const r = result.rows[0];
    await logActivity('Prodotto modificato', r.nome);
    res.json({
      id: r.id, nome: r.nome, descrizione: r.descrizione, prezzo: parseFloat(r.prezzo),
      emoji: r.emoji, disponibile: r.disponibile, taglie: r.taglie, immagine: r.immagine,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Admin: elimina prodotto ─── */
app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM products WHERE id=$1 RETURNING id,nome', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Prodotto non trovato' });
    await logActivity('Prodotto eliminato', result.rows[0].nome);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Admin: upload foto ─── */
app.post('/api/admin/upload', adminAuth, upload.single('immagine'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  res.json({ url: '/uploads/' + req.file.filename });
});

/* ─── Notizie: pubblico ─── */
app.get('/api/notizie', async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM notizie ORDER BY created_at DESC');
    const rows = result.rows.map(r => ({
      id: r.id, titolo: r.titolo, testo: r.testo, colore: r.colore, immagine: r.immagine, data: r.data_str,
    }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Admin: aggiungi notizia ─── */
app.post('/api/admin/notizie', adminAuth, async (req, res) => {
  const { titolo, testo, data, colore, immagine } = req.body;
  if (!titolo || !testo) return res.status(400).json({ error: 'Titolo e testo obbligatori' });
  const id      = Date.now().toString();
  const dataStr = data || new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  try {
    await db.query(
      `INSERT INTO notizie (id, titolo, testo, colore, immagine, data_str) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, titolo, testo, colore || 'blu', immagine || '', dataStr]
    );
    await logActivity('Notizia aggiunta', titolo);
    res.status(201).json({ id, titolo, testo, colore: colore || 'blu', immagine: immagine || '', data: dataStr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Admin: aggiorna notizia ─── */
app.put('/api/admin/notizie/:id', adminAuth, async (req, res) => {
  const { titolo, testo, data, colore, immagine } = req.body;
  try {
    const result = await db.query(
      `UPDATE notizie SET titolo=$1, testo=$2, colore=$3, immagine=$4, data_str=$5 WHERE id=$6 RETURNING *`,
      [titolo, testo, colore || 'blu', immagine || '', data || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Notizia non trovata' });
    const r = result.rows[0];
    await logActivity('Notizia modificata', r.titolo);
    res.json({ id: r.id, titolo: r.titolo, testo: r.testo, colore: r.colore, immagine: r.immagine, data: r.data_str });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Admin: elimina notizia ─── */
app.delete('/api/admin/notizie/:id', adminAuth, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM notizie WHERE id=$1 RETURNING id,titolo', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Notizia non trovata' });
    await logActivity('Notizia eliminata', result.rows[0].titolo);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Config pubblica ─── */
app.get('/api/config', (_req, res) => {
  res.json({
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    paypalClientId:       process.env.PAYPAL_CLIENT_ID || '',
  });
});

/* ─── Stripe PaymentIntent ─── */
app.post('/api/create-payment-intent', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe non configurato. Aggiungi STRIPE_SECRET_KEY nel file .env' });
  try {
    const { amount } = req.body;
    if (!amount || amount < 50) return res.status(400).json({ error: 'Importo non valido' });
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: pi.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Log attività ─── */
async function logActivity(azione, dettaglio = '') {
  try {
    await db.query('INSERT INTO log_attivita (azione, dettaglio) VALUES ($1,$2)', [azione, dettaglio]);
  } catch {}
}

/* ─── Stats dashboard ─── */
app.get('/api/admin/stats', adminAuth, async (_req, res) => {
  try {
    const [prodotti, notizie, eventi, ordiniRaw] = await Promise.all([
      db.query('SELECT COUNT(*) FROM products'),
      db.query('SELECT COUNT(*) FROM notizie'),
      db.query('SELECT COUNT(*) FROM calendario'),
      db.query(`SELECT stato, COUNT(*) FROM ordini GROUP BY stato`),
    ]);
    const ordini = {};
    for (const r of ordiniRaw.rows) ordini[r.stato] = parseInt(r.count);
    res.json({
      prodotti:  parseInt(prodotti.rows[0].count),
      notizie:   parseInt(notizie.rows[0].count),
      eventi:    parseInt(eventi.rows[0].count),
      ordini,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Impostazioni sito ─── */
app.get('/api/admin/impostazioni', adminAuth, async (_req, res) => {
  try {
    const result = await db.query('SELECT chiave, valore FROM impostazioni');
    const obj = {};
    for (const r of result.rows) obj[r.chiave] = r.valore;
    res.json(obj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/impostazioni', adminAuth, async (req, res) => {
  try {
    const campi = ['nome_associazione','telefono','email_contatto','indirizzo','iban','p_iva'];
    for (const chiave of campi) {
      if (req.body[chiave] !== undefined) {
        await db.query(
          `INSERT INTO impostazioni (chiave, valore, updated_at) VALUES ($1,$2,NOW())
           ON CONFLICT (chiave) DO UPDATE SET valore=$2, updated_at=NOW()`,
          [chiave, req.body[chiave]]
        );
      }
    }
    await logActivity('Impostazioni aggiornate', Object.keys(req.body).join(', '));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Log attività (admin) ─── */
app.get('/api/admin/log', adminAuth, async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM log_attivita ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Ordini: tutti (admin) ─── */
app.get('/api/admin/ordini', adminAuth, async (req, res) => {
  try {
    const { stato } = req.query;
    const params = [];
    const where  = stato ? 'WHERE stato=$1' : '';
    if (stato) params.push(stato);
    const result = await db.query(`SELECT * FROM ordini ${where} ORDER BY created_at DESC`, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Ordini: aggiorna stato (admin) ─── */
app.put('/api/admin/ordini/:id/stato', adminAuth, async (req, res) => {
  const { stato } = req.body;
  const statiValidi = ['ricevuto', 'in lavorazione', 'spedito', 'consegnato', 'annullato'];
  if (!statiValidi.includes(stato)) return res.status(400).json({ error: 'Stato non valido' });
  try {
    const result = await db.query(
      'UPDATE ordini SET stato=$1 WHERE id=$2 RETURNING *',
      [stato, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Ordine non trovato' });
    const ordine = result.rows[0];
    await logActivity('Stato ordine aggiornato', `Ordine #${ordine.id} → ${stato}`);

    // Email notifica cliente
    if (emailConfigurata() && ordine.email) {
      const statiLabel = {
        'ricevuto':       '📦 Ordine ricevuto',
        'in lavorazione': '🔧 In lavorazione',
        'spedito':        '🚚 Spedito',
        'consegnato':     '✅ Consegnato',
        'annullato':      '❌ Annullato',
      };
      const transporter = creaTransporter();
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
          <div style="background:#0d2055;padding:24px;text-align:center">
            <h1 style="color:#fff;font-size:20px;margin:0;letter-spacing:2px">VIRTUS CASERTA</h1>
            <p style="color:#ff9800;margin:6px 0 0;font-size:13px">AGGIORNAMENTO ORDINE</p>
          </div>
          <div style="padding:28px 24px">
            <p>Ciao <strong>${ordine.nome}</strong>,</p>
            <p>Il tuo ordine <strong>#${ordine.id}</strong> è stato aggiornato:</p>
            <div style="background:#f0f9ff;border-left:4px solid #0d2055;padding:16px;border-radius:4px;margin:16px 0;font-size:18px;font-weight:bold">
              ${statiLabel[stato] || stato}
            </div>
            ${stato === 'spedito' ? '<p>Il tuo pacco è in viaggio! Riceverai la consegna entro 2–3 giorni lavorativi.</p>' : ''}
            ${stato === 'consegnato' ? '<p>Speriamo che tu sia soddisfatto del tuo acquisto. Grazie per aver scelto Virtus Caserta!</p>' : ''}
            ${stato === 'annullato' ? '<p>Per informazioni contatta <a href="mailto:info@virtuscaserta.it">info@virtuscaserta.it</a></p>' : ''}
          </div>
          <div style="background:#f8fafc;padding:14px;text-align:center;font-size:12px;color:#9ca3af">
            © 2026 Virtus Caserta – Società Sportiva Pallavolo
          </div>
        </div>`;
      transporter.sendMail({
        from: `"Virtus Caserta" <${process.env.EMAIL_USER}>`,
        to: ordine.email,
        subject: `Aggiornamento ordine #${ordine.id} – ${statiLabel[stato] || stato}`,
        html,
      }).catch(e => console.log('[Email ordine] Errore:', e.message));
    }

    res.json({ success: true, stato });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Invio email ordine ─── */
app.post('/api/send-order-email', async (req, res) => {
  const { nome, cognome, email, indirizzo, citta, cap, items, totale, spedizione, metodo, orderId } = req.body;

  // Salva ordine nel DB (non bloccante)
  try {
    const dbOrderId = orderId || Date.now().toString();
    await db.query(
      `INSERT INTO ordini (id, nome, cognome, email, indirizzo, citta, cap, items, totale, spedizione, metodo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [dbOrderId, nome, cognome, email, indirizzo || '', citta || '', cap || '',
       JSON.stringify(items || []), parseFloat(totale) || 0, parseFloat(spedizione) || 0, metodo || '']
    );
  } catch (dbErr) {
    console.log('[Ordini] Errore salvataggio DB:', dbErr.message);
  }

  if (!emailConfigurata()) {
    console.log('[Email] Credenziali mancanti – email non inviata');
    return res.json({ success: false, reason: 'Email non configurata' });
  }

  try {
    const transporter = creaTransporter();

    const righeHtml = items.map(i =>
      `<tr>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0">${i.nome}</td>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center">Taglia ${i.taglia}</td>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center">${i.qty}</td>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right">€ ${(i.prezzo * i.qty).toFixed(2)}</td>
       </tr>`
    ).join('');

    const metodiLabel = { carta: '💳 Carta di credito/debito', paypal: '🅿️ PayPal', bonifico: '🏦 Bonifico bancario' };

    const bonificoHtml = metodo === 'bonifico' ? `
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin-top:12px">
        <strong>Coordinate bancarie:</strong><br>
        Intestatario: Virtus Caserta ASD<br>
        IBAN: IT00 X000 0000 0000 0000 0000 000<br>
        Causale: Ordine ${nome} ${cognome}${orderId ? ' – ' + orderId : ''}
      </div>` : '';

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
        <div style="background:#0d2055;padding:28px 24px;text-align:center">
          <h1 style="color:#fff;font-size:22px;margin:0;letter-spacing:2px">VIRTUS CASERTA</h1>
          <p style="color:#ff9800;margin:6px 0 0;font-size:14px;letter-spacing:1px">ORDINE CONFERMATO</p>
        </div>
        <div style="padding:32px 24px">
          <p style="font-size:16px">Ciao <strong>${nome}</strong>,</p>
          <p>Il tuo ordine è stato ricevuto con successo${orderId ? ` (<strong>#${orderId}</strong>)` : ''}.</p>
          <h3 style="color:#0d2055;border-bottom:2px solid #f57c00;padding-bottom:8px">Riepilogo ordine</h3>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead><tr style="background:#f8fafc">
              <th style="padding:8px;text-align:left">Prodotto</th>
              <th style="padding:8px;text-align:center">Taglia</th>
              <th style="padding:8px;text-align:center">Qtà</th>
              <th style="padding:8px;text-align:right">Importo</th>
            </tr></thead>
            <tbody>${righeHtml}</tbody>
          </table>
          <p style="text-align:right;margin-top:8px;font-size:14px;color:#6b7280">
            Spedizione: <strong>€ ${Number(spedizione).toFixed(2)}</strong>
          </p>
          <p style="text-align:right;font-size:18px;font-weight:bold;color:#0d2055">
            Totale: € ${Number(totale).toFixed(2)}
          </p>
          <h3 style="color:#0d2055;border-bottom:2px solid #f57c00;padding-bottom:8px">Indirizzo di spedizione</h3>
          <p>${nome} ${cognome}<br>${indirizzo}<br>${cap} ${citta}</p>
          <h3 style="color:#0d2055;border-bottom:2px solid #f57c00;padding-bottom:8px">Metodo di pagamento</h3>
          <p>${metodiLabel[metodo] || metodo}</p>
          ${bonificoHtml}
          <p style="color:#9ca3af;font-size:13px;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px">
            Consegna prevista entro 3–5 giorni lavorativi.<br>
            Per assistenza scrivi a <a href="mailto:info@virtuscaserta.it" style="color:#1535a8">info@virtuscaserta.it</a>
          </p>
        </div>
        <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#9ca3af">
          © 2026 Virtus Caserta – Società Sportiva Pallavolo
        </div>
      </div>`;

    await transporter.sendMail({
      from: `"Virtus Caserta Shop" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Ordine confermato – Virtus Caserta${orderId ? ' #' + orderId : ''}`,
      html,
    });

    if (process.env.EMAIL_ADMIN) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_ADMIN,
        subject: `Nuovo ordine da ${nome} ${cognome}${orderId ? ' (#' + orderId + ')' : ''}`,
        html,
      });
    }

    console.log(`[Email] Ordine inviato a ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.log('[Email] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── Instagram Basic Display API ─── */
const IG_CACHE_TTL = 2 * 60 * 60 * 1000;
let igCache = null;

app.get('/api/instagram', async (_req, res) => {
  if (!INSTAGRAM_ACCESS_TOKEN) {
    return res.json({
      source: 'static',
      username: INSTAGRAM_USERNAME,
      profileUrl: `https://www.instagram.com/${INSTAGRAM_USERNAME}/`,
      message: 'Configura INSTAGRAM_ACCESS_TOKEN nel file .env per mostrare i post reali.',
      recentPosts: [],
    });
  }

  if (igCache && (Date.now() - igCache.ts) < IG_CACHE_TTL) {
    return res.json(igCache.data);
  }

  try {
    const BASE = 'https://graph.instagram.com';
    const profileRes = await fetch(`${BASE}/me?fields=id,username,account_type,media_count&access_token=${INSTAGRAM_ACCESS_TOKEN}`);
    if (!profileRes.ok) throw new Error(`HTTP ${profileRes.status} (profilo)`);
    const profile = await profileRes.json();
    if (profile.error) throw new Error(profile.error.message);

    const mediaRes = await fetch(`${BASE}/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=3&access_token=${INSTAGRAM_ACCESS_TOKEN}`);
    if (!mediaRes.ok) throw new Error(`HTTP ${mediaRes.status} (media)`);
    const mediaJson = await mediaRes.json();
    if (mediaJson.error) throw new Error(mediaJson.error.message);

    const posts = (mediaJson.data || []).map(item => ({
      id:        item.id,
      url:       item.permalink,
      thumbnail: item.media_type === 'VIDEO' ? (item.thumbnail_url || '') : (item.media_url || ''),
      caption:   item.caption || '',
      timestamp: Math.floor(new Date(item.timestamp).getTime() / 1000),
      isVideo:   item.media_type === 'VIDEO',
    }));

    const result = {
      source: 'instagram_api', username: profile.username,
      posts: profile.media_count || 0,
      profileUrl: `https://www.instagram.com/${profile.username}/`,
      recentPosts: posts,
    };
    igCache = { data: result, ts: Date.now() };
    return res.json(result);
  } catch (err) {
    console.log('[Instagram] Errore:', err.message);
    if (igCache) return res.json({ ...igCache.data, cached: true });
    return res.json({
      source: 'static', username: INSTAGRAM_USERNAME,
      profileUrl: `https://www.instagram.com/${INSTAGRAM_USERNAME}/`,
      message: `Errore Instagram: ${err.message}`, recentPosts: [],
    });
  }
});

app.post('/api/instagram/refresh-token', async (_req, res) => {
  if (!INSTAGRAM_ACCESS_TOKEN) return res.status(400).json({ error: 'Token non configurato' });
  try {
    const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${INSTAGRAM_ACCESS_TOKEN}`);
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    res.json({ access_token: json.access_token, expires_in: json.expires_in });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── FIPAV Partite ─── */
const FIPAV_CASERTA_BASE   = 'https://caserta.portalefipav.net';
const FIPAV_CAMPANIA_BASE  = 'https://www.fipavcampania.it';
const FIPAV_CASERTA_URL    = 'https://caserta.portalefipav.net/risultati-classifiche.aspx?ComitatoId=19&StId=2281&DataDa=&StatoGara=&CId=&SId=5150&PId=7261&btFiltro=CERCA';
const FIPAV_CAMPANIA_URL   = 'https://www.fipavcampania.it/risultati-classifiche.aspx?ComitatoId=15&StId=2277&DataDa=&StatoGara=&CId=&SId=5150&PId=1078&btFiltro=CERCA';
const FIPAV_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'it-IT,it;q=0.9',
};

function stripTagsFipav(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function decodeEntitiesFipav(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#\d+;/g, ' ').replace(/&nbsp;/g, ' ');
}

// Parse matches from a FIPAV risultati-classifiche page.
// baseUrl: 'https://caserta.portalefipav.net' or 'https://www.fipavcampania.it'
// fonte:   'caserta' | 'campania'
function parseFipavMatches(html, baseUrl, fonte) {
  // ── Categories + classifica links from <caption> ──
  const categories = [];
  const capRe = /<caption[^>]*>([\s\S]*?)<\/caption>/gi;
  let capm;
  while ((capm = capRe.exec(html)) !== null) {
    const capHtml = capm[1];
    const text = stripTagsFipav(capHtml).trim();
    const clMatch = capHtml.match(/href="(\/classifica\.aspx\?CId=(\d+))"/i);
    if (text.length > 4 && /[a-zA-Z]/.test(text)) {
      categories.push({
        pos: capm.index,
        text,
        cid:           clMatch ? clMatch[2] : null,
        classificaUrl: clMatch ? baseUrl + clMatch[1] : null,
        fonte,
      });
    }
  }

  const matches = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const tdRaws = [];
    let tdm;
    while ((tdm = tdRe.exec(row)) !== null) tdRaws.push(tdm[1]);
    if (tdRaws.length < 6) continue;

    const tds = tdRaws.map(stripTagsFipav);
    const [gara, giornata, dataOra, casa, ospite, risultato] = tds;
    if (!/^\d+$/.test(gara.trim()) || !/\d{2}\/\d{2}\/\d{2}/.test(dataOra)) continue;

    const score     = risultato.trim();
    const played    = /\d\s*-\s*\d/.test(score);
    const postponed = /rinviat/i.test(score);

    // ── Decode info img title (last td) ──
    const lastRaw    = tdRaws[tdRaws.length - 1] || '';
    const titleMatch = lastRaw.match(/img[^>]+src="[^"]*info_16[^"]*"[^>]+title="([^"]+)"/i)
                    || lastRaw.match(/title="([^"]+)"[^>]*img[^>]+src="[^"]*info_16[^"]*"/i);
    const decodedTitle = titleMatch ? decodeEntitiesFipav(titleMatch[1]) : '';

    // ── Parziali ──
    // Caserta: in td[6] as <span class="parziali">
    // Campania: embedded in info img title after "PARZIALI:"
    const parziali = [];
    const extractSpanParziali = (src) => {
      const re = /<span[^>]*class="parziali"[^>]*>([^<]+)<\/span>/gi;
      let m;
      while ((m = re.exec(src)) !== null) parziali.push(m[1].trim());
    };
    if (tdRaws[6] && /id="Parziali_/i.test(tdRaws[6])) {
      extractSpanParziali(tdRaws[6]);             // Caserta dedicated td
    } else if (decodedTitle && /PARZIALI/i.test(decodedTitle)) {
      extractSpanParziali(decodedTitle);           // Campania: in title
    }

    // ── Luogo ──
    let luogo = '';
    if (decodedTitle) {
      // Take only the venue part: before "PARZIALI:" and before "Arbitro"
      let raw = decodedTitle
        .replace(/IMPIANTO DI GARA\s*:/i, '')
        .replace(/PARZIALI[\s\S]*/i, '')
        .replace(/Arbitro[\s\S]*/i, '');
      luogo = stripTagsFipav(raw).replace(/\s+/g, ' ').trim();
    }

    // ── Timestamp ──
    const dm = dataOra.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    let timestamp = null;
    let dateFormatted = dataOra.trim();
    if (dm) {
      const [, dd, mm, yy, hh, min] = dm;
      timestamp = new Date(`20${yy}-${mm}-${dd}T${hh}:${min}:00`).getTime();
      dateFormatted = `${dd}/${mm}/20${yy} ${hh}:${min}`;
    }

    // ── Category ──
    const rowPos = rowMatch.index;
    let categoria = '', classificaUrl = null, cid = null, catFonte = fonte;
    for (const cat of categories) {
      if (cat.pos < rowPos) { categoria = cat.text; classificaUrl = cat.classificaUrl; cid = cat.cid; catFonte = cat.fonte; }
      else break;
    }

    matches.push({
      id: gara.trim(), giornata: giornata.trim(), dataOra: dateFormatted, timestamp,
      casa: casa.trim(), ospite: ospite.trim(), risultato: score, played, postponed,
      categoria, classificaUrl, cid, fonte: catFonte, luogo, parziali,
    });
  }
  return matches;
}

async function fetchFipav(url, baseUrl, fonte) {
  const r = await fetch(url, { headers: FIPAV_HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} da ${url}`);
  const html = await r.text();
  return parseFipavMatches(html, baseUrl, fonte);
}

// Fetch da entrambe le fonti, unifica, ordina per data DESC (più recenti prima)
async function fetchFipavAll() {
  const [caserta, campania] = await Promise.allSettled([
    fetchFipav(FIPAV_CASERTA_URL,  FIPAV_CASERTA_BASE,  'caserta'),
    fetchFipav(FIPAV_CAMPANIA_URL, FIPAV_CAMPANIA_BASE, 'campania'),
  ]);

  let all = [];
  if (caserta.status  === 'fulfilled') all = all.concat(caserta.value);
  else console.log('[FIPAV Caserta] Errore:', caserta.reason?.message);
  if (campania.status === 'fulfilled') all = all.concat(campania.value);
  else console.log('[FIPAV Campania] Errore:', campania.reason?.message);

  // Deduplication by (casa + ospite + data)
  const seen = new Set();
  all = all.filter(m => {
    const key = `${m.casa}|${m.ospite}|${m.dataOra}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Ordine decrescente (più recenti prima)
  all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return all;
}

app.get('/api/partite', async (_req, res) => {
  try {
    const all    = await fetchFipavAll();
    const now    = Date.now();
    // ultime: le 3 più recenti giocate; prossime: le 3 più vicine future
    const past   = all.filter(m => m.played);
    const future = all.filter(m => !m.played && m.timestamp !== null && m.timestamp > now)
                      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    res.json({ ultime: past.slice(0, 3), prossime: future.slice(0, 3), fipavUrl: FIPAV_CASERTA_URL });
  } catch (err) {
    console.log('[Partite] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/partite/tutte', async (_req, res) => {
  try {
    const all = await fetchFipavAll();
    const gruppi = {};
    all.forEach(m => {
      const cat = m.categoria || 'Altre partite';
      if (!gruppi[cat]) gruppi[cat] = { classificaUrl: m.classificaUrl, cid: m.cid, fonte: m.fonte, partite: [] };
      gruppi[cat].partite.push(m);
    });
    res.json({ gruppi, fipavUrl: FIPAV_CASERTA_URL });
  } catch (err) {
    console.log('[Partite/tutte] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/classifica/:cid', async (req, res) => {
  const { cid } = req.params;
  if (!/^\d+$/.test(cid)) return res.status(400).json({ error: 'CId non valido' });
  const fonte = req.query.fonte === 'campania' ? 'campania' : 'caserta';
  const base  = fonte === 'campania' ? FIPAV_CAMPANIA_BASE : FIPAV_CASERTA_BASE;
  try {
    const r = await fetch(`${base}/classifica.aspx?CId=${cid}`, { headers: FIPAV_HEADERS });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();

    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const titolo = titleMatch ? stripTagsFipav(titleMatch[1]).trim() : '';

    const squadre = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(html)) !== null) {
      const row = rowMatch[1];
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const tds = [], td1Raws = [];
      let tdm;
      while ((tdm = tdRe.exec(row)) !== null) { tds.push(stripTagsFipav(tdm[1])); td1Raws.push(tdm[1]); }
      if (tds.length >= 13 && /^\d+$/.test(tds[0].trim())) {
        let logo = '';
        const srcMatch = td1Raws[1] && td1Raws[1].match(/src="([^"]+)"/i);
        if (srcMatch) logo = base + srcMatch[1];
        squadre.push({
          pos: tds[0].trim(), squadra: tds[1].trim(), logo,
          punti: tds[2].trim(), pg: tds[3].trim(), pv: tds[4].trim(), pp: tds[5].trim(),
          sf: tds[6].trim(), ss: tds[7].trim(), qs: tds[8].trim(),
          pf: tds[9].trim(), ps: tds[10].trim(), qp: tds[11].trim(), penal: tds[12].trim(),
        });
      }
    }
    res.json({ titolo, cid, fonte, squadre, url: `${base}/classifica.aspx?CId=${cid}` });
  } catch (err) {
    console.log('[Classifica] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── Proxy immagine ─── */
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const imgRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.instagram.com/',
      },
    });
    if (!imgRes.ok) return res.status(imgRes.status).send('Error fetching image');
    res.set('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    imgRes.body.pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/* ─── Squadra ─── */
app.get('/api/squadra', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM squadra WHERE attiva=true ORDER BY numero ASC NULLS LAST, cognome');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/squadra', adminAuth, async (req, res) => {
  const { nome, cognome, numero, ruolo, foto, bio, sesso } = req.body;
  if (!nome || !cognome) return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  const id = Date.now().toString();
  try {
    await db.query(`INSERT INTO squadra (id,nome,cognome,numero,ruolo,foto,bio,sesso) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, nome, cognome, numero || null, ruolo || '', foto || '', bio || '', sesso || 'Femminile']);
    await logActivity('Giocatrice aggiunta', `${nome} ${cognome}`);
    res.status(201).json({ id, nome, cognome, numero, ruolo, foto, bio, sesso });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/squadra/:id', adminAuth, async (req, res) => {
  const { nome, cognome, numero, ruolo, foto, bio, attiva, sesso } = req.body;
  try {
    const r = await db.query(
      `UPDATE squadra SET nome=$1,cognome=$2,numero=$3,ruolo=$4,foto=$5,bio=$6,attiva=$7,sesso=$8 WHERE id=$9 RETURNING *`,
      [nome, cognome, numero || null, ruolo || '', foto || '', bio || '', attiva !== false, sesso || 'Femminile', req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Giocatrice non trovata' });
    await logActivity('Giocatrice modificata', `${nome} ${cognome}`);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/squadra/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM squadra WHERE id=$1 RETURNING nome,cognome', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovata' });
    await logActivity('Giocatrice eliminata', `${r.rows[0].nome} ${r.rows[0].cognome}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── Galleria ─── */
app.get('/api/galleria', async (req, res) => {
  try {
    const { album } = req.query;
    const r = album
      ? await db.query('SELECT * FROM galleria WHERE album=$1 ORDER BY created_at DESC', [album])
      : await db.query('SELECT * FROM galleria ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/galleria/albums', async (_req, res) => {
  try {
    const r = await db.query('SELECT DISTINCT album FROM galleria ORDER BY album');
    res.json(r.rows.map(row => row.album));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/galleria', adminAuth, async (req, res) => {
  const { album, titolo, immagine } = req.body;
  if (!immagine) return res.status(400).json({ error: 'Immagine obbligatoria' });
  const id = Date.now().toString();
  try {
    await db.query(`INSERT INTO galleria (id,album,titolo,immagine) VALUES ($1,$2,$3,$4)`,
      [id, album || 'Generale', titolo || '', immagine]);
    await logActivity('Foto aggiunta in galleria', album || 'Generale');
    res.status(201).json({ id, album, titolo, immagine });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/galleria/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM galleria WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovata' });
    await logActivity('Foto eliminata dalla galleria', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── Iscrizioni ─── */
const iscrizioniLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Troppi invii. Riprova tra un\'ora.' } });
app.post('/api/iscrizioni', iscrizioniLimiter, async (req, res) => {
  const { nome, cognome, email, telefono, eta, categoria, messaggio } = req.body;
  if (!nome || !cognome || !email) return res.status(400).json({ error: 'Nome, cognome ed email obbligatori' });
  const id = Date.now().toString();
  try {
    await db.query(`INSERT INTO iscrizioni (id,nome,cognome,email,telefono,eta,categoria,messaggio) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, nome, cognome, email, telefono || '', eta || null, categoria || '', messaggio || '']);
    if (emailConfigurata()) {
      const t = creaTransporter();
      t.sendMail({
        from: `"Virtus Caserta" <${process.env.EMAIL_USER}>`,
        to: process.env.EMAIL_ADMIN || process.env.EMAIL_USER,
        subject: `Nuova iscrizione da ${nome} ${cognome}`,
        html: `<p><b>Nome:</b> ${nome} ${cognome}<br><b>Email:</b> ${email}<br><b>Tel:</b> ${telefono || '—'}<br><b>Età:</b> ${eta || '—'}<br><b>Categoria:</b> ${categoria || '—'}<br><b>Messaggio:</b> ${messaggio || '—'}</p>`,
      }).catch(() => {});
    }
    await logActivity('Nuova iscrizione', `${nome} ${cognome} – ${email}`);
    res.status(201).json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/iscrizioni', adminAuth, async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM iscrizioni ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/iscrizioni/:id/stato', adminAuth, async (req, res) => {
  const { stato } = req.body;
  try {
    await db.query('UPDATE iscrizioni SET stato=$1 WHERE id=$2', [stato, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── Sponsor ─── */
app.get('/api/sponsor', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM sponsor WHERE attivo=true ORDER BY livello, nome');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/sponsor', adminAuth, async (req, res) => {
  const { nome, logo, url, livello } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  const id = Date.now().toString();
  try {
    await db.query(`INSERT INTO sponsor (id,nome,logo,url,livello) VALUES ($1,$2,$3,$4,$5)`,
      [id, nome, logo || '', url || '', livello || 'standard']);
    await logActivity('Sponsor aggiunto', nome);
    res.status(201).json({ id, nome, logo, url, livello });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/sponsor/:id', adminAuth, async (req, res) => {
  const { nome, logo, url, livello, attivo } = req.body;
  try {
    const r = await db.query(
      `UPDATE sponsor SET nome=$1,logo=$2,url=$3,livello=$4,attivo=$5 WHERE id=$6 RETURNING *`,
      [nome, logo || '', url || '', livello || 'standard', attivo !== false, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovato' });
    await logActivity('Sponsor modificato', nome);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/sponsor/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM sponsor WHERE id=$1 RETURNING nome', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovato' });
    await logActivity('Sponsor eliminato', r.rows[0].nome);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── Risultati ─── */
app.get('/api/risultati', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM risultati ORDER BY data_str DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/risultati', adminAuth, async (req, res) => {
  const { data, avversario, set_noi, set_loro, categoria, tipo } = req.body;
  if (!data || !avversario || set_noi == null || set_loro == null) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  const id = Date.now().toString();
  try {
    await db.query(`INSERT INTO risultati (id,data_str,avversario,set_noi,set_loro,categoria,tipo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, data, avversario, parseInt(set_noi), parseInt(set_loro), categoria || '', tipo || 'campionato']);
    await logActivity('Risultato aggiunto', `vs ${avversario} ${set_noi}-${set_loro}`);
    res.status(201).json({ id, data_str: data, avversario, set_noi, set_loro, categoria, tipo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/risultati/:id', adminAuth, async (req, res) => {
  const { data, avversario, set_noi, set_loro, categoria, tipo } = req.body;
  try {
    const r = await db.query(
      `UPDATE risultati SET data_str=$1,avversario=$2,set_noi=$3,set_loro=$4,categoria=$5,tipo=$6 WHERE id=$7 RETURNING *`,
      [data, avversario, parseInt(set_noi), parseInt(set_loro), categoria || '', tipo || 'campionato', req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovato' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/risultati/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM risultati WHERE id=$1 RETURNING avversario', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovato' });
    await logActivity('Risultato eliminato', `vs ${r.rows[0].avversario}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── Export ordini CSV ─── */
app.get('/api/admin/ordini/export', adminAuth, async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM ordini ORDER BY created_at DESC');
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['ID','Nome','Cognome','Email','Indirizzo','Città','CAP','Articoli','Totale','Spedizione','Metodo','Stato','Data'].join(';');
    const rows = r.rows.map(o => [
      o.id, o.nome, o.cognome, o.email, o.indirizzo, o.citta, o.cap,
      (o.items || []).map(i => `${i.nome} ${i.taglia} x${i.qty}`).join(' | '),
      o.totale, o.spedizione, o.metodo, o.stato,
      o.created_at ? new Date(o.created_at).toLocaleDateString('it-IT') : '',
    ].map(esc).join(';')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ordini-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send('\uFEFF' + header + '\n' + rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── Push notifications ─── */
let webpush = null;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(`mailto:${process.env.EMAIL_USER || 'admin@virtuscaserta.it'}`,
      process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  } else { webpush = null; }
} catch { webpush = null; }

app.get('/api/push/vapid-key', (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});
app.post('/api/push/subscribe', async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'Dati subscription mancanti' });
  try {
    await db.query(
      `INSERT INTO push_subscriptions (endpoint, keys) VALUES ($1,$2)
       ON CONFLICT (endpoint) DO UPDATE SET keys=$2`,
      [endpoint, JSON.stringify(keys)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/push/send', adminAuth, async (req, res) => {
  if (!webpush) return res.status(503).json({ error: 'Push non configurato (VAPID keys mancanti)' });
  const { titolo, messaggio, url } = req.body;
  try {
    const subs = await db.query('SELECT * FROM push_subscriptions');
    const payload = JSON.stringify({ titolo, messaggio, url: url || '/' });
    let ok = 0, fail = 0;
    for (const sub of subs.rows) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
        ok++;
      } catch (e) {
        fail++;
        if (e.statusCode === 410) await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
      }
    }
    await logActivity('Push notification inviata', `${titolo} → ${ok} recapitate, ${fail} fallite`);
    res.json({ success: true, ok, fail });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── Admin: test email ─── */
app.post('/api/admin/test-email', adminAuth, async (_req, res) => {
  if (!emailConfigurata()) return res.status(503).json({ error: 'EMAIL_USER o EMAIL_PASS non configurati' });
  try {
    const t = creaTransporter();
    await t.verify();
    await t.sendMail({
      from: `"Virtus Caserta" <${(process.env.EMAIL_USER || '').trim()}>`,
      to: (process.env.EMAIL_ADMIN || process.env.EMAIL_USER || '').trim(),
      subject: 'Test email – Virtus Caserta',
      text: `Email di test inviata da ${process.env.NODE_ENV || 'development'} alle ${new Date().toISOString()}`,
    });
    await logActivity('Test email inviato', process.env.EMAIL_USER || '');
    res.json({ success: true });
  } catch (err) {
    console.error('[Test email] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── Startup ─── */
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`[OK] Server avviato su porta ${PORT} (${process.env.NODE_ENV || 'development'})`);
    console.log(`[OK] Email configurata: ${emailConfigurata() ? process.env.EMAIL_USER : 'NO – imposta EMAIL_USER e EMAIL_PASS'}`);
    console.log(`[OK] Stripe configurato: ${stripe ? 'SI' : 'NO'}`);
    if (!INSTAGRAM_ACCESS_TOKEN) console.log('[--] Instagram: nessun access token.');
  });
}).catch(err => {
  console.error('[DB] Errore inizializzazione:', err.message);
  app.listen(PORT, () => {
    console.log(`[WARN] Server avviato (senza DB) su porta ${PORT}`);
    console.log(`[OK]  Email configurata: ${emailConfigurata() ? process.env.EMAIL_USER : 'NO'}`);
  });
});
