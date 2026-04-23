require('dotenv').config();
const dns        = require('dns');
dns.setDefaultResultOrder('ipv4first'); // Railway non supporta IPv6 in uscita
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const multer     = require('multer');
const crypto     = require('crypto');
const { createClient: createSupabaseClient } = require('@supabase/supabase-js');
const helmet         = require('helmet');
const compression    = require('compression');
const rateLimit      = require('express-rate-limit');
const cookieParser   = require('cookie-parser');
const db             = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV === 'production') {
  const missing = ['JWT_SECRET', 'ADMIN_PASSWORD', 'ADMIN_USERNAME'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[ERRORE CRITICO] Variabili mancanti in produzione: ${missing.join(', ')}. Configurale su Railway prima di avviare.`);
    process.exit(1);
  }
}
const JWT_SECRET             = process.env.JWT_SECRET || 'virtus_secret_2026_dev';
const INSTAGRAM_USERNAME     = 'virtuscaserta';
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || '';

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/* ─── Supabase Storage ─── */
let supabaseStorage = null;
const SUPABASE_BUCKET = 'uploads';
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  const supabase = createSupabaseClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
  supabaseStorage = supabase.storage;
  console.log('[Supabase Storage] Configurato, bucket:', SUPABASE_BUCKET);
} else {
  console.warn('[Supabase Storage] Non configurato — upload locali (non persistenti su Railway)');
}

/* ─── Nodemailer: transporter Gmail (contatti/iscrizioni) ─── */
function creaTransporter() {
  const emailPass = (process.env.EMAIL_PASS || '').replace(/['"]/g, '').trim();
  const emailUser = (process.env.EMAIL_USER || '').replace(/['"]/g, '').trim();
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    family: 4,
    auth: { user: emailUser, pass: emailPass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

function emailConfigurata() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

/* ─── Brevo SMTP: transporter per email shop/ordini ─── */
function brevoConfigurato() {
  return !!(process.env.BREVO_SMTP_LOGIN && process.env.BREVO_SMTP_KEY);
}

function creaTransporterBrevo() {
  return nodemailer.createTransport({
    host: 'smtp-relay.brevo.com',
    port: 587,
    secure: false,
    family: 4,
    auth: {
      user: (process.env.BREVO_SMTP_LOGIN || '').trim(),
      pass: (process.env.BREVO_SMTP_KEY   || '').trim(),
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

/* Mittente verificato Brevo (deve essere un sender autenticato in Brevo) */
function brevoFrom() {
  const from = (process.env.BREVO_FROM_EMAIL || process.env.BREVO_SMTP_LOGIN || '').trim();
  return `"Virtus Caserta Shop" <${from}>`;
}

/* Email shop: solo Brevo */
function creaTransporterShop() {
  return creaTransporterBrevo();
}

function emailShopConfigurata() {
  return brevoConfigurato();
}

function shopFrom() {
  return brevoFrom();
}

function adminFrom() {
  return brevoFrom();
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
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
      console.log(`[Webhook] Pagamento confermato – PI: ${pi.id}${orderId ? ', Ordine: ' + orderId : ' (nessun orderId nei metadata)'}`);
      try {
        if (orderId) {
          await db.query(`UPDATE ordini SET stato='in lavorazione', stripe_pi_id=$2 WHERE id=$1`, [orderId, pi.id]);
          await logActivity('Pagamento confermato via webhook', `Ordine #${orderId} – PI: ${pi.id}`);
        }
      } catch (dbErr) {
        console.log('[Webhook] Errore aggiornamento DB:', dbErr.message);
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      const orderId = pi.metadata?.orderId;
      console.log(`[Webhook] Pagamento fallito – PI: ${pi.id}`);
      try {
        if (orderId) {
          await db.query(`UPDATE ordini SET stato='annullato' WHERE id=$1`, [orderId]);
        }
      } catch (dbErr) {
        console.log('[Webhook] Errore aggiornamento DB:', dbErr.message);
      }
      await logActivity('Pagamento fallito', `PI: ${pi.id}${orderId ? ', Ordine: ' + orderId : ''}`);
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
app.get('/squadra.html',            (_req, res) => res.redirect(301, '/squadra'));
app.get('/risultati.html',          (_req, res) => res.redirect(301, '/risultati'));
app.get('/classifica.html',         (_req, res) => res.redirect(301, '/classifica'));
app.get('/staff.html',              (_req, res) => res.redirect(301, '/staff'));
app.get('/privacy.html',            (_req, res) => res.redirect(301, '/privacy'));
app.get('/termini.html',            (_req, res) => res.redirect(301, '/termini'));
app.get('/ordine-confermato.html',  (_req, res) => res.redirect(301, '/ordine-confermato'));
app.get('/live.html',               (_req, res) => res.redirect(301, '/live'));
// Vecchi URL rimossi → redirect home
app.get('/galleria.html',           (_req, res) => res.redirect(301, '/'));
app.get('/iscrizione.html',         (_req, res) => res.redirect(301, '/'));
app.get('/sponsor.html',            (_req, res) => res.redirect(301, '/'));
app.get('/reset-password.html',     (_req, res) => res.redirect(301, '/'));

// URL puliti
app.get('/',                  sendPage('index.html'));
app.get('/chi-siamo',         sendPage('chiSiamo.html'));
app.get('/notizie',           sendPage('notizie.html'));
app.get('/calendario',        sendPage('calendario.html'));
app.get('/shop',              sendPage('shop.html'));
app.get('/admin',             adminCookieCheck, sendPage('admin.html'));
app.get('/admin-login',       sendPage('admin-login.html'));
app.get('/squadra',           sendPage('squadra.html'));
app.get('/risultati',         sendPage('risultati.html'));
app.get('/classifica',        sendPage('classifica.html'));
app.get('/staff',             sendPage('staff.html'));
app.get('/privacy',           sendPage('privacy.html'));
app.get('/termini',           sendPage('termini.html'));
app.get('/ordine-confermato', sendPage('ordine-confermato.html'));
app.get('/live',              sendPage('live.html'));
// Vecchi URL rimossi → redirect home
app.get('/galleria',          (_req, res) => res.redirect(301, '/'));
app.get('/iscrizione',        (_req, res) => res.redirect(301, '/'));
app.get('/sponsor',           (_req, res) => res.redirect(301, '/'));
app.get('/reset-password',    (_req, res) => res.redirect(301, '/admin-login'));

const BLOCKED_FILES = /^\/?(server\.js|db\.js|package(?:-lock)?\.json|railway\.json|\.env[^/]*)$/i;
app.use((req, res, next) => {
  if (BLOCKED_FILES.test(req.path) || /\.md$/i.test(req.path)) {
    return res.status(403).json({ error: 'Accesso negato' });
  }
  next();
});
app.use(express.static(path.join(__dirname)));

/* ─── Rate limiting ─── */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppi tentativi. Riprova tra 15 minuti.' },
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppe richieste di pagamento. Riprova tra un minuto.' },
});

/* ─── Utility: escape HTML per email ─── */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ─── Multer upload ─── */
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
const upload = multer({
  storage: multer.memoryStorage(),
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
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username e password obbligatori' });

  const adminPassword = process.env.ADMIN_PASSWORD || 'virtus2026';
  const validUser =
    username === (process.env.ADMIN_USERNAME || 'admin') ||
    username === process.env.ADMIN_EMAIL;

  // Se ADMIN_PASSWORD è un hash bcrypt usalo direttamente, altrimenti confronto diretto timing-safe
  let passMatch = false;
  if (adminPassword.startsWith('$2')) {
    passMatch = await bcrypt.compare(password, adminPassword);
  } else {
    const a = Buffer.alloc(64); const b = Buffer.alloc(64);
    Buffer.from(password).copy(a); Buffer.from(adminPassword).copy(b);
    passMatch = crypto.timingSafeEqual(a, b);
  }

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
app.post('/api/admin/upload', adminAuth, upload.single('immagine'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });

  const safeFilename = Date.now() + '-' + req.file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');

  if (supabaseStorage) {
    try {
      const { error } = await supabaseStorage
        .from(SUPABASE_BUCKET)
        .upload(safeFilename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (error) throw error;
      const { data: { publicUrl } } = supabaseStorage.from(SUPABASE_BUCKET).getPublicUrl(safeFilename);
      return res.json({ url: publicUrl });
    } catch (e) {
      console.error('[Upload] Supabase error:', e.message);
      return res.status(500).json({ error: 'Errore upload Supabase: ' + e.message });
    }
  }

  // Fallback: salva su disco locale (non persistente su Railway)
  const localPath = path.join(UPLOADS_DIR, safeFilename);
  fs.writeFile(localPath, req.file.buffer, (err) => {
    if (err) return res.status(500).json({ error: 'Errore salvataggio file' });
    res.json({ url: '/uploads/' + safeFilename });
  });
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
app.post('/api/create-payment-intent', paymentLimiter, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe non configurato. Aggiungi STRIPE_SECRET_KEY nel file .env' });
  try {
    const { amount } = req.body;
    if (!amount || amount < 50) return res.status(400).json({ error: 'Importo non valido' });
    const orderId = Date.now().toString();
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { orderId },
    });
    res.json({ clientSecret: pi.client_secret, orderId });
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

/* ─── Live links (pubblico) ─── */
app.get('/api/live-links', async (_req, res) => {
  try {
    const r = await db.query(`SELECT chiave, valore FROM impostazioni WHERE chiave IN ('youtube_live_url','spike_live_url')`);
    const obj = {};
    for (const row of r.rows) obj[row.chiave] = row.valore;
    res.json({ youtube_live_url: obj.youtube_live_url || '', spike_live_url: obj.spike_live_url || '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/impostazioni', adminAuth, async (req, res) => {
  try {
    const campi = ['nome_associazione','telefono','email_contatto','indirizzo','iban','p_iva','youtube_live_url','spike_live_url'];
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
  const statiValidi = ['ricevuto', 'in lavorazione', 'pronto', 'ritirato', 'annullato'];
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
    if (emailShopConfigurata() && ordine.email) {
      const statiLabel = {
        'ricevuto':       '📦 Ordine ricevuto',
        'in lavorazione': '🔧 In lavorazione',
        'pronto':         '📦 Pronto per il ritiro',
        'ritirato':       '✅ Ritirato',
        'annullato':      '❌ Annullato',
      };
      const transporter = creaTransporterShop();
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
            ${stato === 'pronto' ? '<p>Il tuo ordine è pronto per il ritiro presso la sede della <strong>Virtus Caserta ASD</strong>. Ti aspettiamo!</p>' : ''}
            ${stato === 'ritirato' ? '<p>Grazie per il tuo acquisto! Speriamo di rivederti presto. Forza Virtus!</p>' : ''}
            ${stato === 'annullato' ? '<p>Per informazioni contatta <a href="mailto:info@virtuscaserta.it">info@virtuscaserta.it</a></p>' : ''}
          </div>
          <div style="background:#f8fafc;padding:14px;text-align:center;font-size:12px;color:#9ca3af">
            © 2026 Virtus Caserta – Società Sportiva Pallavolo
          </div>
        </div>`;
      transporter.sendMail({
        from: shopFrom(),
        to: ordine.email,
        subject: `Aggiornamento ordine #${ordine.id} – ${statiLabel[stato] || stato}`,
        html,
      }).then(() => {
        console.log(`[Email ordine] Inviata a ${ordine.email} – stato: ${stato}`);
      }).catch(e => {
        console.error(`[Email ordine] ERRORE (${e.code || 'unknown'}): ${e.message}`);
      });
    }

    res.json({ success: true, stato });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Ordini: rimborso + cancellazione (admin) ─── */
app.post('/api/admin/ordini/:id/rimborso', adminAuth, async (req, res) => {
  try {
    // Cerca per id primario O per stripe_pi_id (admin potrebbe passare l'uno o l'altro)
    const param = req.params.id;
    const r = await db.query(
      `SELECT * FROM ordini WHERE id=$1 OR stripe_pi_id=$1 LIMIT 1`,
      [param]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Ordine non trovato' });
    const ordine = r.rows[0];

    // Trova il PaymentIntent ID
    // Se l'admin ha passato il PI ID direttamente, usalo subito
    let piId = param.startsWith('pi_') ? param : ordine.stripe_pi_id;
    if (!piId && stripe) {
      try {
        const pis = await stripe.paymentIntents.search({ query: `metadata['orderId']:'${ordine.id}'`, limit: 1 });
        if (pis.data.length) piId = pis.data[0].id;
      } catch(_) {}
    }

    // Esegui rimborso Stripe (se configurato)
    let rimborsoEffettuato = false;
    let rimborsoErrore = null;
    if (piId && stripe) {
      try {
        await stripe.refunds.create({ payment_intent: piId });
        rimborsoEffettuato = true;
      } catch(e) {
        rimborsoErrore = e.message;
        console.error('[Rimborso] Errore Stripe:', e.message);
      }
    }

    // Rimuovi dal DB
    await db.query(`DELETE FROM ordini WHERE id=$1`, [ordine.id]);
    await logActivity('Ordine eliminato' + (rimborsoEffettuato ? ' + rimborso' : ''), `Ordine #${ordine.id}`);

    // Email al cliente
    if (emailShopConfigurata() && ordine.email) {
      const transporter = creaTransporterShop();
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
          <div style="background:#0d2055;padding:24px;text-align:center">
            <h1 style="color:#fff;font-size:20px;margin:0;letter-spacing:2px">VIRTUS CASERTA</h1>
            <p style="color:#ff9800;margin:6px 0 0;font-size:13px">ORDINE CANCELLATO</p>
          </div>
          <div style="padding:28px 24px">
            <p>Ciao <strong>${ordine.nome}</strong>,</p>
            <p>Il tuo ordine <strong>#${ordine.id}</strong> è stato cancellato dal nostro staff.</p>
            ${rimborsoEffettuato ? `
            <div style="background:#f0fdf4;border-left:4px solid #16a34a;padding:16px;border-radius:4px;margin:16px 0;">
              <strong>✅ Rimborso in corso</strong><br>
              <span style="font-size:13px;color:#374151;">Il rimborso di <strong>€ ${Number(ordine.totale).toFixed(2)}</strong> è stato avviato e apparirà sul tuo metodo di pagamento entro 5-10 giorni lavorativi.</span>
            </div>` : `
            <div style="background:#fef9c3;border-left:4px solid #ca8a04;padding:16px;border-radius:4px;margin:16px 0;">
              <strong>ℹ️ Rimborso</strong><br>
              <span style="font-size:13px;">Per informazioni sul rimborso contatta <a href="mailto:info@virtuscaserta.it">info@virtuscaserta.it</a></span>
            </div>`}
            <p style="font-size:13px;color:#6b7280;">Per qualsiasi domanda siamo disponibili a <a href="mailto:info@virtuscaserta.it">info@virtuscaserta.it</a>. Forza Virtus!</p>
          </div>
          <div style="background:#f8fafc;padding:14px;text-align:center;font-size:12px;color:#9ca3af">
            © 2026 Virtus Caserta – Società Sportiva Pallavolo
          </div>
        </div>`;
      transporter.sendMail({
        from: shopFrom(),
        to: ordine.email,
        subject: `Ordine #${ordine.id} cancellato – Virtus Caserta`,
        html,
      }).catch(e => console.error('[Email rimborso]', e.message));
    }

    res.json({ success: true, rimborso: rimborsoEffettuato, erroreStripe: rimborsoErrore });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Ordini: svuota tutti ─── */
app.delete('/api/admin/ordini/all', adminAuth, async (_req, res) => {
  try {
    const r = await db.query('DELETE FROM ordini');
    await logActivity('Database ordini svuotato', `${r.rowCount} ordini eliminati`);
    res.json({ success: true, eliminati: r.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Invio email ordine ─── */
app.post('/api/send-order-email', paymentLimiter, async (req, res) => {
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

  if (!emailShopConfigurata()) {
    console.log('[Email] Credenziali mancanti – email non inviata');
    return res.json({ success: false, reason: 'Email non configurata' });
  }

  try {
    const transporter = creaTransporterShop();

    const righeHtml = items.map(i =>
      `<tr>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0">${esc(i.nome)}</td>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center">Taglia ${esc(i.taglia)}</td>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center">${Number(i.qty)}</td>
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
          <p style="font-size:16px">Ciao <strong>${esc(nome)}</strong>,</p>
          <p>Il tuo ordine è stato ricevuto con successo${orderId ? ` (<strong>#${esc(orderId)}</strong>)` : ''}.</p>
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
          <p>${esc(nome)} ${esc(cognome)}<br>${esc(indirizzo)}<br>${esc(cap)} ${esc(citta)}</p>
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
      from: shopFrom(),
      to: email,
      subject: `Ordine confermato – Virtus Caserta${orderId ? ' #' + orderId : ''}`,
      html,
    });

    if (process.env.EMAIL_ADMIN) {
      await transporter.sendMail({
        from: adminFrom(),
        to: process.env.EMAIL_ADMIN,
        subject: `Nuovo ordine da ${nome} ${cognome}${orderId ? ' (#' + orderId + ')' : ''}`,
        html,
      });
    }

    console.log(`[Email] Ordine confermato inviato a ${email}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[Email] ERRORE (${err.code || 'unknown'}): ${err.message}`);
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

/* ─── OPES Partite ─── */
const OPES_BASE = 'https://www.opespallavolo.it';
const OPES_AJAX = 'https://www.opespallavolo.it/system/include/ajax/public/league.php';
const OPES_TOURNAMENTS = [
  { tid: 7,  categoria: 'Open Mix',        maxDays: 14 },
  { tid: 28, categoria: 'Open Femminile',  maxDays: 10 },
];
const OPES_MESI = { GEN:0,FEB:1,MAR:2,APR:3,MAG:4,GIU:5,LUG:6,AGO:7,SET:8,OTT:9,NOV:10,DIC:11 };
const OPES_CACHE_TTL = 60 * 60 * 1000;
let opesCache = null;

function parseOpesDate(dateStr) {
  const dm = dateStr.match(/(\d{2})\s+([A-Z]{3})\s+(\d{2}):(\d{2})/);
  if (!dm) return { timestamp: null, dateFormatted: dateStr.trim() };
  const [, day, mon, hh, min] = dm;
  const monIdx = OPES_MESI[mon];
  if (monIdx === undefined) return { timestamp: null, dateFormatted: dateStr.trim() };
  const now  = new Date();
  let year   = now.getFullYear();
  const tryD = new Date(year, monIdx, parseInt(day), parseInt(hh), parseInt(min));
  // If more than 6 months in the future, it's from last year
  if (tryD.getTime() - now.getTime() > 180 * 24 * 60 * 60 * 1000) year--;
  const d = new Date(year, monIdx, parseInt(day), parseInt(hh), parseInt(min));
  return {
    timestamp:     d.getTime(),
    dateFormatted: `${day}/${String(monIdx + 1).padStart(2, '0')}/${year} ${hh}:${min}`,
  };
}

function parseOpesHtml(html, categoria, giornata) {
  const matches = [];
  const blocks  = html.split('<div class="match-element">');
  blocks.shift();

  for (const block of blocks) {
    if (/turno di riposo/i.test(block) && !block.includes('href=')) continue;

    const noteM    = block.match(/<div class='match-note'>([^<]+)<\/div>/i);
    const postponed = noteM ? /rinviat/i.test(noteM[1]) : false;

    const urlM = block.match(/href="(https:\/\/www\.opespallavolo\.it\/it\/match\/(\d+)\/[^"]+)"/);
    if (!urlM) continue;
    const matchUrl = urlM[1];
    const matchId  = urlM[2];

    // Header: venue + date
    const hdrM = block.match(/<div class="match-header">([\s\S]*?)<\/div>/);
    let venue = '', dateStr = '';
    if (hdrM) {
      const parts = hdrM[1].replace(/<[^>]+>/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) { venue = parts[0]; dateStr = parts[1]; }
      else if (parts.length === 1) { dateStr = parts[0]; }
    }
    const { timestamp, dateFormatted } = parseOpesDate(dateStr);

    // Teams + logos
    const partRe = /<div class="participant-single-row[^"]*">\s*<img src='([^']+)'>\s*<div class='participant-name[^']*'>([^<]+)<\/div>/g;
    const parts  = [...block.matchAll(partRe)];
    if (parts.length < 2) continue;
    const home = { logo: parts[0][1], name: parts[0][2].trim() };
    const away = { logo: parts[1][1], name: parts[1][2].trim() };

    if (!/virtus/i.test(home.name) && !/virtus/i.test(away.name)) continue;

    // Set scores
    const scoreRe = /<div class="score-container"><div class='set([^']*)'>([\d]+)<sup[^>]*><\/sup><\/div><div class='set([^']*)'>([\d]+)<sup[^>]*><\/sup><\/div><\/div>/g;
    const parziali = [];
    let homeSets = 0, awaySets = 0;
    let sm;
    while ((sm = scoreRe.exec(block)) !== null) {
      const [, cls1, s1,, s2] = sm;
      parziali.push(`${s1}-${s2}`);
      if (cls1.includes('winner')) homeSets++; else awaySets++;
    }

    const played    = parziali.length > 0;
    const risultato = played ? `${homeSets}-${awaySets}` : '';

    matches.push({
      id: `opes-${matchId}`, giornata: String(giornata), dataOra: dateFormatted, timestamp,
      casa: home.name, ospite: away.name, risultato, played, postponed,
      categoria, fonte: 'opes', luogo: venue, parziali,
      logoHome: home.logo, logoAway: away.logo, matchUrl,
      tid: null, // filled by fetchOpesTournament
    });
  }
  return matches;
}

async function fetchOpesTournament({ tid, categoria, maxDays }) {
  const days    = Array.from({ length: maxDays }, (_, i) => i + 1);
  const results = await Promise.allSettled(
    days.map(day =>
      fetch(OPES_AJAX, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': `${OPES_BASE}/it/t-calendar/${tid}/`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: `op=22&tid=${tid}&match_day=${day}`,
      }).then(r => r.json()).then(d => parseOpesHtml(d.html || '', categoria, day))
    )
  );
  const all = [];
  for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);
  // Attach tid to each match for classifica lookup
  all.forEach(m => { m.tid = tid; });
  return all;
}

async function fetchOpesAll() {
  if (opesCache && (Date.now() - opesCache.ts) < OPES_CACHE_TTL) return opesCache.data;
  const results = await Promise.allSettled(OPES_TOURNAMENTS.map(t => fetchOpesTournament(t)));
  let all = [];
  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.log(`[OPES ${OPES_TOURNAMENTS[i].categoria}] Errore:`, r.reason?.message);
  }
  const seen = new Set();
  all = all.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
  opesCache = { data: all, ts: Date.now() };
  return all;
}
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
    if (!/^\d+$/.test(gara.trim()) || !/\d{2}\/\d{2}\/\d{2,4}/.test(dataOra)) continue;

    const score     = risultato.trim();
    const played    = /\d\s*-\s*\d/.test(score);
    const postponed = /rinviat/i.test(score);

    // ── Decode info img title (last td) ──
    const lastRaw    = tdRaws[tdRaws.length - 1] || '';
    const titleMatch = lastRaw.match(/img[^>]+src="[^"]*info_16[^"]*"[^>]+title="([^"]+)"/i)
                    || lastRaw.match(/title="([^"]+)"[^>]*img[^>]+src="[^"]*info_16[^"]*"/i);
    const decodedTitle = titleMatch ? decodeEntitiesFipav(titleMatch[1]) : '';

    // ── Parziali ──
    // Caserta: <span class="parziali"> in td[6] o nel title dell'icona info
    // Campania: nel title dell'icona info dopo "PARZIALI:"
    const parziali = [];
    const extractSpanParziali = (src) => {
      const re = /<span[^>]*class="parziali"[^>]*>([^<]+)<\/span>/gi;
      let m;
      while ((m = re.exec(src)) !== null) parziali.push(m[1].trim());
    };
    const extractTextParziali = (src) => {
      const pm = src.match(/PARZIALI[:\s]*([^\n<]{2,120})/i);
      if (!pm) return;
      const parts = pm[1].match(/\d+\s*[-–]\s*\d+/g);
      if (parts) parziali.push(...parts.map(p => p.replace(/\s/g, '')));
    };
    // 1) prova td[6] con span (Caserta)
    if (tdRaws[6]) extractSpanParziali(tdRaws[6]);
    // 2) prova title img info (funziona per Caserta e Campania)
    if (!parziali.length && decodedTitle && /PARZIALI/i.test(decodedTitle)) {
      extractSpanParziali(decodedTitle);
      if (!parziali.length) extractTextParziali(decodedTitle);
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

    // ── Timestamp ── (supports DD/MM/YY and DD/MM/YYYY)
    const dm = dataOra.match(/(\d{2})\/(\d{2})\/(\d{2,4})\s+(\d{2}):(\d{2})/);
    let timestamp = null;
    let dateFormatted = dataOra.trim();
    if (dm) {
      const [, dd, mm, yy, hh, min] = dm;
      const year = yy.length === 4 ? yy : `20${yy}`;
      timestamp = new Date(`${year}-${mm}-${dd}T${hh}:${min}:00`).getTime();
      dateFormatted = `${dd}/${mm}/${year} ${hh}:${min}`;
    }

    // ── Category ──
    const rowPos = rowMatch.index;
    let categoria = '', classificaUrl = null, cid = null, catFonte = fonte;
    for (const cat of categories) {
      if (cat.pos < rowPos) { categoria = cat.text; classificaUrl = cat.classificaUrl; cid = cat.cid; catFonte = cat.fonte; }
      else break;
    }

    // ── Logo squadre (dalla colonna td[3] e td[4]) ──
    const logoSrcRe = /src="([^"]+Loghi[^"]+)"/i;
    const logoHomeSrc = tdRaws[3] && (tdRaws[3].match(logoSrcRe) || [])[1];
    const logoAwaySrc = tdRaws[4] && (tdRaws[4].match(logoSrcRe) || [])[1];
    const logoHome = logoHomeSrc ? baseUrl + logoHomeSrc : '';
    const logoAway = logoAwaySrc ? baseUrl + logoAwaySrc : '';

    matches.push({
      id: gara.trim(), giornata: giornata.trim(), dataOra: dateFormatted, timestamp,
      casa: casa.trim(), ospite: ospite.trim(), risultato: score, played, postponed,
      categoria, classificaUrl, cid, fonte: catFonte, luogo, parziali,
      logoHome, logoAway,
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

// Cache FIPAV: 10 minuti
let _fipavCache = null;
let _fipavCacheAt = 0;
const FIPAV_CACHE_TTL = 10 * 60 * 1000;

// Fetch da tutte le fonti (FIPAV Caserta, Campania, OPES), unifica, ordina per data DESC
async function fetchFipavAll() {
  if (_fipavCache && Date.now() - _fipavCacheAt < FIPAV_CACHE_TTL) return _fipavCache;
  const [caserta, campania, opes] = await Promise.allSettled([
    fetchFipav(FIPAV_CASERTA_URL,  FIPAV_CASERTA_BASE,  'caserta'),
    fetchFipav(FIPAV_CAMPANIA_URL, FIPAV_CAMPANIA_BASE, 'campania'),
    fetchOpesAll(),
  ]);

  let all = [];
  if (caserta.status  === 'fulfilled') all = all.concat(caserta.value);
  else console.log('[FIPAV Caserta] Errore:', caserta.reason?.message);
  if (campania.status === 'fulfilled') all = all.concat(campania.value);
  else console.log('[FIPAV Campania] Errore:', campania.reason?.message);
  if (opes.status     === 'fulfilled') all = all.concat(opes.value);
  else console.log('[OPES] Errore:', opes.reason?.message);

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
  _fipavCache = all;
  _fipavCacheAt = Date.now();
  return all;
}

app.get('/api/partite', async (_req, res) => {
  try {
    const all    = await fetchFipavAll();
    const now    = Date.now();
    const past   = all.filter(m => m.played);
    const live   = all.filter(m => !m.played && !m.postponed && m.timestamp && m.timestamp < now && m.timestamp + 7200000 > now);
    // prossime: partite future + quelle iniziate da <2h senza risultato (live), ordinate per orario
    const future = all.filter(m => !m.played && !m.postponed && m.timestamp !== null && m.timestamp > now - 7200000)
                      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    res.json({ ultime: past.slice(0, 3), live, prossime: future.slice(0, 6), fipavUrl: FIPAV_CASERTA_URL });
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
      if (!gruppi[cat]) gruppi[cat] = { classificaUrl: m.classificaUrl, cid: m.cid, fonte: m.fonte, tid: m.tid || null, partite: [] };
      gruppi[cat].partite.push(m);
    });
    res.json({ gruppi, fipavUrl: FIPAV_CASERTA_URL });
  } catch (err) {
    console.log('[Partite/tutte] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── Classifica OPES ─── */
function parseOpesClassifica(html) {
  // Split left-table (pos + name + logo) from right-table (stats)
  const leftM  = html.match(/<div class="left-table"[^>]*>([\s\S]*?)(?=<div class="right-table")/);
  const rightM = html.match(/<div class="right-table"[^>]*>([\s\S]*)/);
  if (!leftM || !rightM) return [];

  // Left rows: position + logo + name
  const leftRows = [];
  const lRowRe = /<div class="tables-body tables-row[^"]*">([\s\S]*?)(?=<div class="tables-body|<\/div>\s*<\/div>)/g;
  let lm;
  while ((lm = lRowRe.exec(leftM[1])) !== null) {
    const posM  = lm[1].match(/<small>(\d+)<\/small>/);
    const imgM  = lm[1].match(/<img src="([^"]+)"/);
    const nameM = lm[1].match(/<div class="participant-name"[^>]*>([^<]+)/);
    if (posM && nameM) {
      leftRows.push({ pos: posM[1], logo: imgM ? imgM[1] : '', squadra: nameM[1].trim() });
    }
  }

  // Right rows: stats (Pt, G, V, P, QS, QP, FP)
  const rightRows = [];
  const rRowRe = /<div class="tables-body tables-row[^"]*">([\s\S]*?)(?=<div class="tables-body|<\/div>\s*<\/div>)/g;
  let rm;
  while ((rm = rRowRe.exec(rightM[1])) !== null) {
    const vals = [...rm[1].matchAll(/<small>([^<]*)<\/small>/g)].map(m => m[1].trim());
    if (vals.length) rightRows.push(vals);
  }

  return leftRows.map((l, i) => {
    const r = rightRows[i] || [];
    return {
      pos: l.pos, squadra: l.squadra, logo: l.logo,
      punti: r[0]||'-', pg: r[1]||'-', pv: r[2]||'-', pp: r[3]||'-',
      sf: '-', ss: '-', qs: r[4]||'-', pf: '-', ps: '-', penal: '0',
    };
  });
}

const OPES_TOURNEY_MAP = Object.fromEntries(
  OPES_TOURNAMENTS.map(t => [String(t.tid), t])
);

app.get('/api/classifica-opes/:tid', async (req, res) => {
  const { tid } = req.params;
  const tourney = OPES_TOURNEY_MAP[tid];
  if (!tourney) return res.status(404).json({ error: 'Torneo OPES non trovato' });
  try {
    const r = await fetch(OPES_AJAX, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${OPES_BASE}/it/t-teamtable/${tid}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: `op=20&tid=${tid}`,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json    = await r.json();
    const squadre = parseOpesClassifica(json.html || '');
    res.json({
      titolo:  tourney.categoria,
      squadre,
      url: `${OPES_BASE}/it/t-teamtable/${tid}/`,
    });
  } catch (err) {
    console.log('[Classifica OPES] Errore:', err.message);
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
    // FIPAV HTML usa <tr> senza </tr> — split invece di regex
    const rowSegments = html.split(/<tr[^>]*>/i).slice(1);
    for (const row of rowSegments) {
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const tds = [], tdRaws = [];
      let tdm;
      while ((tdm = tdRe.exec(row)) !== null) { tds.push(stripTagsFipav(tdm[1])); tdRaws.push(tdm[1]); }
      if (tds.length >= 3 && /^\d+$/.test(tds[0].trim())) {
        let logo = '';
        const srcMatch = tdRaws[1] && tdRaws[1].match(/src="([^"]+)"/i);
        if (srcMatch) logo = (srcMatch[1].startsWith('http') ? '' : base) + srcMatch[1];
        squadre.push({
          pos:   tds[0].trim(),
          squadra: tds[1].trim(),
          logo,
          punti: tds[2]?.trim() || '0',
          pg:    tds[3]?.trim() || '0',
          pv:    tds[4]?.trim() || '0',
          pp:    tds[5]?.trim() || '0',
          sf:    tds[6]?.trim() || '0',
          ss:    tds[7]?.trim() || '0',
          qs:    tds[8]?.trim() || '0',
          pf:    tds[9]?.trim() || '0',
          ps:    tds[10]?.trim() || '0',
          penal: tds[12]?.trim() || '0',
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
  const isFipav = /portalefipav|fipavcampania/i.test(url);
  const referer = isFipav
    ? (/fipavcampania/i.test(url) ? 'https://www.fipavcampania.it/' : 'https://caserta.portalefipav.net/')
    : 'https://www.instagram.com/';
  try {
    const imgRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': referer,
      },
    });
    if (!imgRes.ok) return res.status(imgRes.status).send('Error fetching image');
    res.set('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    const buf = await imgRes.arrayBuffer();
    res.end(Buffer.from(buf));
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

/* ─── Modulo contatti ─── */
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Troppi messaggi. Riprova tra un\'ora.' } });

app.post('/api/contact', contactLimiter, async (req, res) => {
  const { nome, email, oggetto, messaggio } = req.body;
  if (!nome || !email || !messaggio) return res.status(400).json({ error: 'Nome, email e messaggio sono obbligatori.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email non valida.' });
  if (!emailConfigurata()) return res.status(503).json({ error: 'Sistema email non configurato.' });
  try {
    const t = creaTransporter();
    await t.sendMail({
      from: `"Virtus Caserta" <${(process.env.EMAIL_USER || '').trim()}>`,
      to: (process.env.EMAIL_ADMIN || process.env.EMAIL_USER || '').trim(),
      replyTo: email.trim(),
      subject: `[Contatto Sito] ${esc(oggetto || 'Nuovo messaggio')} – ${esc(nome)}`,
      html: `<h2>Nuovo messaggio dal sito</h2>
<p><strong>Nome:</strong> ${esc(nome)}</p>
<p><strong>Email:</strong> ${esc(email)}</p>
<p><strong>Oggetto:</strong> ${esc(oggetto || '—')}</p>
<p><strong>Messaggio:</strong></p>
<p style="white-space:pre-wrap">${esc(messaggio)}</p>`,
    });
    await t.sendMail({
      from: `"Virtus Caserta" <${(process.env.EMAIL_USER || '').trim()}>`,
      to: email.trim(),
      subject: 'Abbiamo ricevuto il tuo messaggio – Virtus Caserta',
      html: `<p>Ciao ${esc(nome)},</p>
<p>Grazie per averci scritto. Abbiamo ricevuto il tuo messaggio e ti risponderemo al più presto.</p>
<p>– Staff Virtus Caserta</p>`,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[Contact] Errore:', err.message);
    res.status(500).json({ error: 'Invio fallito. Riprova più tardi.' });
  }
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
db.init().then(async () => {
  // Migrazione: aggiunge stripe_pi_id se non esiste
  try { await db.query(`ALTER TABLE ordini ADD COLUMN IF NOT EXISTS stripe_pi_id TEXT`); } catch(_){}
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
