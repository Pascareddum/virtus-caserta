require('dotenv').config();
const dns        = require('dns');
dns.setDefaultResultOrder('ipv4first'); // Railway non supporta IPv6 in uscita
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
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
  return brevoApiConfigurato() || brevoConfigurato() || !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

/* ─── Brevo HTTP API (contatti) ─── */
function brevoApiConfigurato() {
  return !!(process.env.BREVO_API_KEY && process.env.BREVO_FROM_EMAIL);
}

async function sendBrevoEmail({ fromName = 'Virtus Caserta', fromEmail, to, subject, html, replyTo, headers = {} }) {
  const apiKey  = process.env.BREVO_API_KEY;
  const fromAddr = (fromEmail || process.env.BREVO_FROM_EMAIL || '').trim();
  if (!apiKey)    throw new Error('BREVO_API_KEY non configurata');
  if (!fromAddr)  throw new Error('BREVO_FROM_EMAIL non configurata');

  const normalizeRecipients = r =>
    Array.isArray(r) ? r : [typeof r === 'string' ? { email: r.trim() } : r];

  const payload = {
    sender:      { name: fromName, email: fromAddr },
    to:          normalizeRecipients(to),
    subject,
    htmlContent: html,
    headers: {
      'X-Mailer':        'VirtusCaserta/1.0',
      'X-Entity-Ref-ID': crypto.randomUUID(),
      ...headers,
    },
  };
  if (replyTo) payload.replyTo = { email: typeof replyTo === 'string' ? replyTo.trim() : replyTo };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method:  'POST',
      headers: {
        'api-key':      apiKey,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
      },
      body:   JSON.stringify(payload),
      signal: controller.signal,
    });

    let data = {};
    try { data = await res.json(); } catch (_) {}

    if (!res.ok) {
      const msg = data.message || data.error || `HTTP ${res.status}`;
      const err = new Error(`Brevo API: ${msg}`);
      err.status = res.status;
      err.brevoData = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Brevo API: timeout dopo 15s');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Brevo SMTP: transporter per email shop/ordini ─── */
function brevoConfigurato() {
  return !!(
    (process.env.SMTP_USER || process.env.BREVO_SMTP_LOGIN) &&
    (process.env.SMTP_PASS || process.env.BREVO_SMTP_KEY)
  );
}

function creaTransporterBrevo() {
  return nodemailer.createTransport({
    host: (process.env.SMTP_HOST || 'smtp-relay.brevo.com').trim(),
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    family: 4,
    auth: {
      user: (process.env.SMTP_USER || process.env.BREVO_SMTP_LOGIN || '').trim(),
      pass: (process.env.SMTP_PASS || process.env.BREVO_SMTP_KEY   || '').trim(),
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

/* Mittente verificato Brevo (deve essere un sender autenticato in Brevo) */
function brevoFrom() {
  const from = (process.env.BREVO_FROM_EMAIL || process.env.SMTP_USER || process.env.BREVO_SMTP_LOGIN || '').trim();
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
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "https://www.paypal.com", "https://www.sandbox.paypal.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      frameSrc:      [
        "'self'",
        "https://www.paypal.com", "https://www.sandbox.paypal.com",
        "https://maps.google.com", "https://www.google.com",
        "https://player.twitch.tv",
        "https://www.youtube.com",
      ],
      connectSrc:    ["'self'", "https://www.paypal.com", "https://api.paypal.com"],
      imgSrc:        ["'self'", "data:", "https:"],
      styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:       ["'self'", "data:", "https://fonts.gstatic.com"],
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
      formAction:    ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cookieParser());

/* ─── Health check (Railway) ─── */
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

app.use(express.json());

/* ─── Pagine: URL puliti e protezione admin ─── */
const sendPage = (file) => (_req, res) => res.sendFile(path.join(__dirname, file));

function adminCookieCheck(req, res, next) {
  const token = req.cookies.vc_admin_session;
  if (!token) return res.redirect('/login');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return res.redirect('/login');
    next();
  } catch {
    res.clearCookie('vc_admin_session');
    return res.redirect('/login');
  }
}

// Redirect da URL .html a URL puliti
app.get('/index.html',              (_req, res) => res.redirect(301, '/'));
app.get('/chiSiamo.html',           (_req, res) => res.redirect(301, '/chi-siamo'));
app.get('/notizie.html',            (_req, res) => res.redirect(301, '/notizie'));
app.get('/calendario.html',         (_req, res) => res.redirect(301, '/calendario'));
app.get('/shop.html',               (_req, res) => res.redirect(301, '/shop'));
app.get('/admin.html',              adminCookieCheck, sendPage('admin.html'));
app.get('/admin-login.html',        (_req, res) => res.redirect(301, '/login'));
app.get('/admin-login',             (_req, res) => res.redirect(301, '/login'));
app.get('/squadra.html',            (_req, res) => res.redirect(301, '/squadra'));
app.get('/risultati.html',          (_req, res) => res.redirect(301, '/risultati'));
app.get('/classifica.html',         (_req, res) => res.redirect(301, '/risultati'));
app.get('/staff.html',              (_req, res) => res.redirect(301, '/staff'));
app.get('/privacy.html',            (_req, res) => res.redirect(301, '/privacy'));
app.get('/termini.html',            (_req, res) => res.redirect(301, '/termini'));
app.get('/ordine-confermato.html',  (_req, res) => res.redirect(301, '/ordine-confermato'));
app.get('/live.html',               (_req, res) => res.redirect(301, '/live'));
app.get('/login.html',              (_req, res) => res.redirect(301, '/login'));
app.get('/utente.html',             (_req, res) => res.redirect(301, '/utente'));
// Vecchi URL rimossi → redirect home
app.get('/galleria.html',           (_req, res) => res.redirect(301, '/'));
app.get('/iscrizione.html',         (_req, res) => res.redirect(301, '/'));
app.get('/sponsor.html',            (_req, res) => res.redirect(301, '/sponsor'));
app.get('/reset-password.html',     (_req, res) => res.redirect(301, '/'));

// Per-article OG tags for social sharing
app.get('/notizia/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT id,titolo,testo,immagine FROM notizie WHERE id=$1', [id]);
    if (!result.rows.length) return res.redirect('/notizie');
    const n = result.rows[0];
    const base = process.env.BASE_URL || 'https://www.virtuscaserta.com';
    const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const imgUrl = n.immagine ? (n.immagine.startsWith('http') ? n.immagine : `${base}${n.immagine}`) : `${base}/images/logo.png`;
    const plainTesto = (n.testo || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const desc = esc(plainTesto.slice(0, 160));
    const titolo = esc(n.titolo);
    res.send(`<!DOCTYPE html>
<html lang="it"><head>
  <meta charset="UTF-8">
  <title>${titolo} – Virtus Caserta</title>
  <meta name="description" content="${desc}">
  <meta property="og:site_name" content="Virtus Caserta">
  <meta property="og:locale" content="it_IT">
  <meta property="og:title" content="${titolo} – Virtus Caserta">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="${imgUrl}">
  <meta property="og:image:secure_url" content="${imgUrl}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${base}/notizia/${n.id}">
  <meta property="og:type" content="article">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@virtuscaserta">
  <meta name="twitter:title" content="${titolo} – Virtus Caserta">
  <meta name="twitter:description" content="${desc}">
  <meta name="twitter:image" content="${imgUrl}">
  <script>window.location.replace('/notizie#notizia-${n.id}');</script>
</head><body></body></html>`);
  } catch (e) {
    res.redirect('/notizie');
  }
});

// URL puliti
app.get('/',                  sendPage('index.html'));
app.get('/chi-siamo',         sendPage('chiSiamo.html'));
app.get('/notizie',           sendPage('notizie.html'));
app.get('/calendario',        sendPage('calendario.html'));
app.get('/shop',              sendPage('shop.html'));
app.get('/admin',             adminCookieCheck, sendPage('admin.html'));
app.get('/squadra',           sendPage('squadra.html'));
app.get('/risultati',         sendPage('risultati.html'));
app.get('/classifica',        (_req, res) => res.redirect(301, '/risultati'));
app.get('/staff',             sendPage('staff.html'));
app.get('/privacy',           sendPage('privacy.html'));
app.get('/termini',           sendPage('termini.html'));
app.get('/ordine-confermato', sendPage('ordine-confermato.html'));
app.get('/live',              sendPage('live.html'));
app.get('/login',             sendPage('login.html'));
app.get('/utente',            sendPage('utente.html'));
app.get('/eventi-tornei',     sendPage('eventi-tornei-utente.html'));
// Vecchi URL rimossi → redirect home
app.get('/galleria',          (_req, res) => res.redirect(301, '/'));
app.get('/iscrizione',        (_req, res) => res.redirect(301, '/'));
app.get('/sponsor',           sendPage('sponsor.html'));
app.get('/progetti',          sendPage('progetti.html'));
app.get('/reset-password',    (_req, res) => res.redirect(301, '/login'));
app.get('/imposta-password',  sendPage('imposta-password.html'));

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

const ordineEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Hai inviato troppi ordini. Riprova tra un\'ora.' },
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

const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(pdf|doc|docx|xls|xlsx|jpg|jpeg|png|gif|webp|txt)$/i.test(file.originalname);
    cb(null, ok);
  },
});

/* ─── Auth middleware ─── */
function verifyToken(req) {
  // httpOnly cookie first (XSS-safe, SameSite=Strict → CSRF-safe)
  const cookieToken = req.cookies.vc_admin_session || req.cookies.vc_user_session;
  if (cookieToken) {
    try { return jwt.verify(cookieToken, JWT_SECRET); } catch {}
  }
  // Bearer fallback for backwards compat
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

function userAuth(req, res, next) {
  const payload = verifyToken(req);
  if (!payload || !payload.id) return res.status(401).json({ error: 'Non autenticato' });
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
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Credenziali non valide' });
});

/* ─── Logout admin ─── */
app.post('/api/admin/logout', (_req, res) => {
  res.clearCookie('vc_admin_session');
  res.json({ success: true });
});

/* ─── Logout utente ─── */
app.post('/api/logout', (_req, res) => {
  res.clearCookie('vc_user_session');
  res.json({ success: true });
});

/* ─── Auth status (per redirect su login page) ─── */
const USER_SESSION_OPTS = () => ({
  httpOnly: true,
  sameSite: 'strict',
  maxAge: 120 * 24 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production',
});

app.get('/api/me', (req, res) => {
  const payload = verifyToken(req);
  if (!payload) return res.json({ auth: false });
  // Sliding session: refresh cookie on every authenticated page load
  if (payload.role === 'utente' && req.cookies.vc_user_session) {
    const newToken = jwt.sign({ id: payload.id, email: payload.email, nome: payload.nome, role: 'utente' }, JWT_SECRET, { expiresIn: '120d' });
    res.cookie('vc_user_session', newToken, USER_SESSION_OPTS());
  }
  res.json({ auth: true, role: payload.role, id: payload.id });
});

/* ─── Token refresh esplicito (per client Bearer) ─── */
app.post('/api/auth/refresh', (req, res) => {
  const payload = verifyToken(req);
  if (!payload || payload.role !== 'utente') return res.status(401).json({ error: 'Non autenticato' });
  const newToken = jwt.sign({ id: payload.id, email: payload.email, nome: payload.nome, role: 'utente' }, JWT_SECRET, { expiresIn: '120d' });
  res.cookie('vc_user_session', newToken, USER_SESSION_OPTS());
  res.json({ token: newToken });
});

/* ─── Utenti: registrazione (pubblico) ─── */
const registraLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Troppi tentativi. Riprova tra un\'ora.' } });
app.post('/api/register', registraLimiter, async (req, res) => {
  try {
    let { nome, cognome, email, telefono } = req.body;
    nome     = String(nome     || '').trim().slice(0, 100);
    cognome  = String(cognome  || '').trim().slice(0, 100);
    email    = String(email    || '').trim().toLowerCase().slice(0, 254);
    telefono = String(telefono || '').trim().slice(0, 30);
    if (!nome || !cognome || !email || !telefono) return res.status(400).json({ error: 'Tutti i campi sono obbligatori.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email non valida.' });
    const existing = await db.query('SELECT id FROM utenti WHERE email=$1', [email]);
    if (existing.rows.length) return res.status(409).json({ error: 'Email già registrata.' });
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO utenti (id, email, nome, cognome, telefono, stato) VALUES ($1,$2,$3,$4,$5,'in_attesa')`,
      [id, email, nome, cognome, telefono]
    );
    await logActivity('Nuova registrazione utente', `${nome} ${cognome} <${email}>`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Register]', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Utenti: login (pubblico) ─── */
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e password obbligatori.' });
    const r = await db.query('SELECT * FROM utenti WHERE email=$1', [email.trim().toLowerCase()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Credenziali non valide.' });
    const u = r.rows[0];
    if (u.stato !== 'attivo') return res.status(403).json({ error: 'Account non ancora attivo. Attendi approvazione.' });
    if (!u.password_hash) return res.status(403).json({ error: 'Password non impostata. Controlla la tua email.' });
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenziali non valide.' });
    const token = jwt.sign({ id: u.id, email: u.email, nome: u.nome, role: 'utente' }, JWT_SECRET, { expiresIn: '120d' });
    res.cookie('vc_user_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 120 * 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
    });
    res.json({ user: { id: u.id, nome: u.nome, cognome: u.cognome, email: u.email } });
  } catch (err) {
    console.error('[Login]', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Profilo utente loggato ─── */
app.get('/api/profilo', userAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id,nome,cognome,email,is_atleta,is_allenatore,ruolo_atleta,ruolo_allenatore,squadre_atleta,squadre_allenatore FROM utenti WHERE id=$1',
      [req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Utente non trovato.' });
    const campRaw = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_campionato_mappa'`);
    const campionato_mappa = JSON.parse(campRaw.rows[0]?.valore || '{}');
    const catLinksRaw = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_cat_links'`);
    const cat_links = JSON.parse(catLinksRaw.rows[0]?.valore || '{}');
    res.json({ ...r.rows[0], campionato_mappa, cat_links });
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
});

/* ─── Impegni settimana corrente per l'utente loggato ─── */
app.get('/api/profilo/prossimi', userAuth, async (req, res) => {
  try {
    const uRes = await db.query(
      'SELECT squadre_atleta,squadre_allenatore FROM utenti WHERE id=$1',
      [req.user.id]
    );
    if (!uRes.rows.length) return res.status(404).json({ error: 'Utente non trovato.' });
    const u = uRes.rows[0];

    // Mappa squadra → ruolo utente
    const squadraRuolo = {};
    for (const s of (u.squadre_atleta    || [])) squadraRuolo[s] = 'atleta';
    for (const s of (u.squadre_allenatore|| [])) squadraRuolo[s] = squadraRuolo[s] === 'atleta' ? 'entrambi' : 'allenatore';
    const nomiSquadre = Object.keys(squadraRuolo);
    if (!nomiSquadre.length) return res.json([]);

    // Calcola ts robusto: evita NaN da ora non zero-padded ("9:00")
    function safeTs(dateStr, timeStr) {
      if (!dateStr) return 0;
      const parts = (timeStr || '0:00').split(':');
      const h = parseInt(parts[0], 10) || 0;
      const m = parseInt(parts[1], 10) || 0;
      const [y, mo, d] = dateStr.split('-').map(Number);
      if (!y || !mo || !d) return 0;
      return new Date(y, mo - 1, d, h, m).getTime();
    }

    // Range lunedì–domenica in timezone Europe/Rome (server su Railway è UTC)
    const now = new Date();
    const todayIT = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);
    const [ty, tm, td] = todayIT.split('-').map(Number);
    const todayLocal = new Date(ty, tm - 1, td);
    const dow = todayLocal.getDay() === 0 ? 6 : todayLocal.getDay() - 1;
    const lunLocal = new Date(ty, tm - 1, td - dow);
    const domLocal = new Date(ty, tm - 1, td - dow + 6);
    function isoDate(dt) {
      return dt.getFullYear() + '-' +
        String(dt.getMonth() + 1).padStart(2, '0') + '-' +
        String(dt.getDate()).padStart(2, '0');
    }
    const lunStr = isoDate(lunLocal);
    const domStr = isoDate(domLocal);
    // Per fipav_matches (TIMESTAMPTZ): mezzanotte Rome lunedì/domenica
    const lun = new Date(`${lunStr}T00:00:00+02:00`);
    const dom = new Date(`${domStr}T23:59:59+02:00`);

    const eventi = [];

    // Allenamenti/eventi da calendario per ogni squadra (primaria + collegate)
    for (const nome of nomiSquadre) {
      const calRes = await db.query(
        `SELECT c.id, c.titolo, c.data_str, c.ora, c.tipo, c.note, c.responsabile,
                c.categoria, c.palestra_id, p.nome as palestra_nome
         FROM calendario c
         LEFT JOIN palestres p ON p.id = c.palestra_id
         WHERE (c.categoria ILIKE $1 OR c.categorie_collegate @> $2::jsonb)
           AND c.data_str >= $3 AND c.data_str <= $4
         ORDER BY c.data_str, c.ora`,
        [nome, JSON.stringify([nome]), lunStr, domStr]
      );
      for (const r of calRes.rows) {
        eventi.push({
          tipo:          r.tipo || 'allenamento',
          id:            r.id,
          titolo:        r.titolo,
          data:          r.data_str,
          ora:           r.ora,
          note:          r.note || '',
          responsabile:  r.responsabile || '',
          categoria:     r.categoria || '',
          palestra_nome: r.palestra_nome || '',
          squadra:       nome,
          ruolo:         squadraRuolo[nome],
          ts:            safeTs(r.data_str, r.ora),
        });
      }
    }

    // Partite: usa cla link (classifica URL) → CId → fipav_matches.cid
    const catLinksRawP = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_cat_links'`);
    const catLinksP = JSON.parse(catLinksRawP.rows[0]?.valore || '{}');

    function parseClaUrl(cla) {
      if (!cla) return null;
      try {
        const u = new URL(cla);
        if (u.hostname.includes('opespallavolo.it')) {
          const m = u.pathname.match(/\/t-teamtable\/(\d+)/);
          if (m) return { type: 'opes', tid: m[1] };
        } else {
          const cid = u.searchParams.get('CId');
          if (cid) return { type: 'fipav', cid, fonte: u.hostname.includes('campania') ? 'campania' : 'caserta' };
        }
      } catch {}
      return null;
    }

    const seenPartite = new Set();
    for (const nome of nomiSquadre) {
      const links = catLinksP[nome] || {};
      const allCla = [links.cla, ...(Array.isArray(links.extra_cla) ? links.extra_cla : [])].filter(Boolean);
      for (const claUrl of allCla) {
        const parsed = parseClaUrl(claUrl);
        if (!parsed) continue;
        let mRes;
        if (parsed.type === 'fipav') {
          await ensureFipavMatchesLoaded(parsed.cid, parsed.fonte);
          mRes = await db.query(
            `SELECT id,casa,ospite,data_ora,luogo,categoria,giornata,fonte,cid,tid FROM fipav_matches
             WHERE cid=$1 AND fonte=$2 AND played=false AND postponed=false
               AND data_ora >= $3 AND data_ora <= $4
             ORDER BY data_ora`,
            [parsed.cid, parsed.fonte, lun, dom]
          );
        } else {
          await ensureOpesMatchesLoaded(parsed.tid);
          mRes = await db.query(
            `SELECT id,casa,ospite,data_ora,luogo,categoria,giornata,fonte,cid,tid FROM fipav_matches
             WHERE tid=$1 AND fonte='opes' AND played=false AND postponed=false
               AND data_ora >= $2 AND data_ora <= $3
             ORDER BY data_ora`,
            [parsed.tid, lun, dom]
          );
        }
        for (const m of mRes.rows) {
          const key = `${m.casa}|${m.ospite}|${m.data_ora}`;
          if (seenPartite.has(key)) continue;
          seenPartite.add(key);
          eventi.push({
            tipo: 'partita',
            casa: m.casa, ospite: m.ospite,
            data_ora: m.data_ora,
            luogo: m.luogo || '',
            categoria: m.categoria,
            giornata: m.giornata || '',
            fonte: m.fonte,
            cid: m.cid || null,
            tid: m.tid || null,
            squadra: nome,
            ruolo: squadraRuolo[nome] || 'atleta',
            ts: new Date(m.data_ora).getTime(),
          });
        }
      }
    }

    // Partite torneo (utente partecipante)
    const torneoPartiteRes = await db.query(
      `SELECT tp.id, tp.data_str, tp.ora, tp.luogo,
              ts1.nome as nome_casa, ts2.nome as nome_ospite, t.nome as torneo_nome
       FROM torneo_partite tp
       JOIN torneo_partecipanti tpart ON tpart.torneo_id = tp.torneo_id AND tpart.utente_id = $1
       JOIN tornei t ON t.id = tp.torneo_id
       LEFT JOIN torneo_squadre ts1 ON ts1.id = tp.squadra_casa_id
       LEFT JOIN torneo_squadre ts2 ON ts2.id = tp.squadra_ospite_id
       WHERE tp.data_str >= $2 AND tp.data_str <= $3 AND tp.data_str != ''
       ORDER BY tp.data_str, tp.ora`,
      [req.user.id, lunStr, domStr]
    );
    for (const p of torneoPartiteRes.rows) {
      const nomeCasa   = p.nome_casa   || '?';
      const nomeOspite = p.nome_ospite || '?';
      eventi.push({
        tipo:   'torneo',
        titolo: `${nomeCasa} vs ${nomeOspite}`,
        data:   p.data_str,
        ora:    p.ora || '',
        luogo:  p.luogo || '',
        note:   p.torneo_nome,
        ts:     safeTs(p.data_str, p.ora),
      });
    }

    // Deduplicazione partite (stessa partita può apparire da più sorgenti)
    const seen = new Set();
    const unici = eventi.filter(e => {
      const key = e.tipo === 'partita' ? `${e.casa}|${e.ospite}|${e.ts}`
                : e.tipo === 'torneo'  ? `${e.titolo}|${e.data}|${e.ora}`
                : `${e.titolo}|${e.data}|${e.ora}|${e.squadra}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });

    unici.sort((a, b) => a.ts - b.ts);
    res.json({ settimana: { da: lunStr, a: domStr }, eventi: unici });
  } catch (err) {
    console.error('[/api/profilo/prossimi]', err);
    res.status(500).json({ error: 'Errore interno.' });
  }
});

/* ─── Utenti: lista admin ─── */
app.get('/api/admin/utenti', adminAuth, async (_req, res) => {
  try {
    const r = await db.query('SELECT id,email,nome,cognome,telefono,stato,created_at,is_atleta,is_allenatore,squadre_atleta,squadre_allenatore,ruolo_atleta,ruolo_allenatore FROM utenti ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
});

/* ─── Utenti: approva → invia email setup password ─── */
app.post('/api/admin/utenti/:id/approva', adminAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM utenti WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Utente non trovato.' });
    const u = r.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const exp   = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await db.query(
      `UPDATE utenti SET stato='approvato', setup_token=$1, setup_token_exp=$2 WHERE id=$3`,
      [token, exp, u.id]
    );
    await logActivity('Utente approvato', `${u.nome} ${u.cognome} <${u.email}>`);
    const base = process.env.BASE_URL || 'https://www.virtuscaserta.com';
    const setupLink = `${base}/imposta-password?token=${token}`;
    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
        <div style="background:#0d2055;padding:24px;text-align:center">
          <h1 style="color:#fff;font-size:20px;margin:0;letter-spacing:2px">VIRTUS CASERTA</h1>
          <p style="color:#ff9800;margin:6px 0 0;font-size:13px">REGISTRAZIONE APPROVATA</p>
        </div>
        <div style="padding:28px 24px">
          <p>Ciao <strong>${esc(u.nome)}</strong>,</p>
          <p>La tua registrazione a Virtus Caserta ASD è stata <strong>approvata</strong>!</p>
          <p>Clicca il pulsante qui sotto per impostare la tua password e completare l'accesso:</p>
          <div style="text-align:center;margin:28px 0">
            <a href="${setupLink}" style="display:inline-block;background:#f57c00;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:16px;font-weight:700;">Imposta la tua password</a>
          </div>
          <p style="font-size:13px;color:#6b7280;">Il link è valido per <strong>48 ore</strong>. Se non hai richiesto tu la registrazione, ignora questa email.</p>
          <p style="font-size:13px;color:#6b7280;">Oppure copia il link: <a href="${setupLink}" style="color:#f57c00;word-break:break-all;">${setupLink}</a></p>
        </div>
        <div style="background:#f8fafc;padding:14px;text-align:center;font-size:12px;color:#9ca3af">
          © 2026 Virtus Caserta – Società Sportiva Pallavolo
        </div>
      </div>`;
    if (brevoApiConfigurato()) {
      sendBrevoEmail({
        to: u.email,
        subject: 'Registrazione approvata – Imposta la tua password | Virtus Caserta',
        html: emailHtml,
      }).then(() => console.log(`[Setup email] Inviata via API a ${u.email}`))
        .catch(e => console.error('[Setup email] Errore API:', e.message));
    } else if (brevoConfigurato()) {
      creaTransporterShop().sendMail({
        from: shopFrom(), to: u.email,
        subject: 'Registrazione approvata – Imposta la tua password | Virtus Caserta',
        html: emailHtml,
      }).catch(e => console.error('[Setup email] Errore SMTP:', e.message));
    } else {
      console.warn(`[Setup email] Nessun provider email configurato. Link manuale: ${setupLink}`);
    }
    res.json({ success: true, setupLink });
  } catch (err) {
    console.error('[Approva utente]', err);
    res.status(500).json({ error: 'Errore interno.' });
  }
});

/* ─── Utenti: aggiorna tipo (atleta/allenatore/squadre) ─── */
app.put('/api/admin/utenti/:id/tipo', adminAuth, async (req, res) => {
  try {
    const { is_atleta, is_allenatore, squadre_atleta, squadre_allenatore, ruolo_atleta, ruolo_allenatore } = req.body;
    const userId = req.params.id;
    const r = await db.query(
      `UPDATE utenti SET is_atleta=$1, is_allenatore=$2, squadre_atleta=$3, squadre_allenatore=$4, ruolo_atleta=$5, ruolo_allenatore=$6 WHERE id=$7 RETURNING nome,cognome`,
      [
        !!is_atleta, !!is_allenatore,
        JSON.stringify(Array.isArray(squadre_atleta) ? squadre_atleta : []),
        JSON.stringify(Array.isArray(squadre_allenatore) ? squadre_allenatore : []),
        ruolo_atleta || '',
        ruolo_allenatore || '',
        userId,
      ]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Utente non trovato.' });
    const { nome, cognome } = r.rows[0];

    // ── Sync squadra table ──
    let ruoloAllenMap = {}, ruoloAtletaMap = {};
    try { ruoloAllenMap = JSON.parse(ruolo_allenatore || '{}'); } catch {}
    try { ruoloAtletaMap = JSON.parse(ruolo_atleta    || '{}'); } catch {}

    const sqAllen  = is_allenatore && Array.isArray(squadre_allenatore) ? squadre_allenatore : [];
    const sqAtleta = is_atleta     && Array.isArray(squadre_atleta)     ? squadre_atleta     : [];
    const COACH_ROLES = ['Allenatore', 'Vice Allenatore', 'Primo allenatore', 'Secondo allenatore', 'Assistente'];

    const existing = await db.query(`SELECT id, sesso, ruolo FROM squadra WHERE utente_id=$1`, [userId]);
    // Exclude sesso='Staff' records — those are manually managed and must not be touched by sync
    const syncable = existing.rows.filter(g => g.sesso !== 'Staff');
    const exCoach  = syncable.filter(g => COACH_ROLES.includes(g.ruolo));
    const exAtleta = syncable.filter(g => !COACH_ROLES.includes(g.ruolo) && g.ruolo !== 'Staff');

    // Helper: first team in sesso field
    const firstTeam = g => (g.sesso || '').split(',')[0].trim();

    // Sync coach records (one record per team)
    const handledCoach = new Set();
    for (const team of sqAllen) {
      const desRuolo = ruoloAllenMap[team] || 'Allenatore';
      const found = exCoach.find(g => firstTeam(g) === team);
      if (found) {
        handledCoach.add(found.id);
        if (found.ruolo !== desRuolo) await db.query(`UPDATE squadra SET ruolo=$1 WHERE id=$2`, [desRuolo, found.id]);
      } else {
        const nid = crypto.randomUUID();
        await db.query(
          `INSERT INTO squadra (id,nome,cognome,ruolo,sesso,attiva,utente_id,foto,bio) VALUES ($1,$2,$3,$4,$5,true,$6,'','')`,
          [nid, nome, cognome, desRuolo, team, userId]
        );
      }
    }
    for (const g of exCoach) {
      if (!handledCoach.has(g.id)) await db.query(`DELETE FROM squadra WHERE id=$1`, [g.id]);
    }

    // Sync athlete records (one record per team)
    const handledAtleta = new Set();
    for (const team of sqAtleta) {
      const desRuolo = ruoloAtletaMap[team] || '';
      const found = exAtleta.find(g => (g.sesso || '').split(',').map(s=>s.trim()).includes(team));
      if (found) {
        handledAtleta.add(found.id);
        if (found.ruolo !== desRuolo) await db.query(`UPDATE squadra SET ruolo=$1 WHERE id=$2`, [desRuolo, found.id]);
      } else {
        const nid = crypto.randomUUID();
        await db.query(
          `INSERT INTO squadra (id,nome,cognome,ruolo,sesso,attiva,utente_id,foto,bio) VALUES ($1,$2,$3,$4,$5,true,$6,'','')`,
          [nid, nome, cognome, desRuolo, team, userId]
        );
      }
    }
    for (const g of exAtleta) {
      if (!handledAtleta.has(g.id)) await db.query(`DELETE FROM squadra WHERE id=$1`, [g.id]);
    }

    await logActivity('Tipo utente aggiornato', `${nome} ${cognome}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Tipo utente]', err);
    res.status(500).json({ error: 'Errore interno.' });
  }
});

/* ─── Utenti: rifiuta ─── */
app.post('/api/admin/utenti/:id/rifiuta', adminAuth, async (req, res) => {
  try {
    const r = await db.query(`UPDATE utenti SET stato='rifiutato' WHERE id=$1 RETURNING nome,cognome,email`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Utente non trovato.' });
    await logActivity('Utente rifiutato', `${r.rows[0].nome} ${r.rows[0].cognome} <${r.rows[0].email}>`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
});

/* ─── Utenti: elimina ─── */
app.delete('/api/admin/utenti/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM utenti WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
});

/* ─── Imposta password: verifica token ─── */
app.get('/api/imposta-password/verifica', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token mancante.' });
    const r = await db.query(
      `SELECT id,nome,email FROM utenti WHERE setup_token=$1 AND setup_token_exp > NOW() AND stato='approvato'`,
      [token]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Link non valido o scaduto.' });
    res.json({ nome: r.rows[0].nome, email: r.rows[0].email });
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
});

/* ─── Imposta password: set ─── */
app.post('/api/imposta-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Dati mancanti.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password minimo 6 caratteri.' });
    const r = await db.query(
      `SELECT id,nome,email FROM utenti WHERE setup_token=$1 AND setup_token_exp > NOW() AND stato='approvato'`,
      [token]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Link non valido o scaduto.' });
    const u = r.rows[0];
    const hash = await bcrypt.hash(password, 12);
    await db.query(
      `UPDATE utenti SET password_hash=$1, stato='attivo', setup_token=NULL, setup_token_exp=NULL WHERE id=$2`,
      [hash, u.id]
    );
    await logActivity('Utente attivato', `${u.nome} <${u.email}>`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Imposta password]', err);
    res.status(500).json({ error: 'Errore interno.' });
  }
});

/* ─── Calendario: pubblico ─── */
app.get('/api/calendario', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM calendario ORDER BY data_str, ora');
    let rows = result.rows.map(r => ({
      id:        r.id,
      titolo:    r.titolo,
      data:      r.data_str,
      ora:       r.ora,
      categoria: r.categoria,
      note:      r.note,
      tipo:                r.tipo || 'allenamento',
      foto:                r.foto || '',
      palestra_id:         r.palestra_id || '',
      categorie_collegate: r.categorie_collegate || [],
      utenti_collegati:    r.utenti_collegati    || [],
    }));

    const payload = verifyToken(req);

    if (payload && payload.role === 'admin') {
      return res.json(rows);
    }

    const matchesCat = (r, sq, uid) => {
      if (!r.categoria && !(r.categorie_collegate||[]).length && !(r.utenti_collegati||[]).length) return true;
      if (uid && (r.utenti_collegati || []).map(String).includes(String(uid))) return true;
      const primarie  = (r.categoria || '').split(',').map(c => c.trim()).filter(Boolean);
      const collegate = r.categorie_collegate || [];
      return [...primarie, ...collegate].some(c => sq.has(c));
    };

    if (payload && payload.id) {
      const u = await db.query('SELECT squadre_atleta, squadre_allenatore FROM utenti WHERE id=$1', [payload.id]);
      if (u.rows.length) {
        const sq = new Set([...(u.rows[0].squadre_atleta || []), ...(u.rows[0].squadre_allenatore || [])]);
        rows = rows.filter(r => matchesCat(r, sq, payload.id));
      } else {
        rows = rows.filter(r => !r.categoria && !(r.categorie_collegate||[]).length);
      }
    } else {
      rows = rows.filter(r => !r.categoria && !(r.categorie_collegate||[]).length);
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Prossimi eventi pubblici ─── */
app.get('/api/prossimi-eventi', async (req, res) => {
  try {
    const oggi = new Date().toISOString().slice(0, 10);
    const r = await db.query(
      `SELECT id,titolo,data_str,ora,foto,categoria FROM calendario WHERE tipo='evento' AND data_str >= $1 ORDER BY data_str LIMIT 10`,
      [oggi]
    );
    let eventi = r.rows.map(x => ({ ...x, data: x.data_str }));

    const payload = verifyToken(req);
    if (payload && payload.id) {
      const u = await db.query('SELECT squadre_atleta, squadre_allenatore FROM utenti WHERE id=$1', [payload.id]);
      if (u.rows.length) {
        const sq = [...(u.rows[0].squadre_atleta || []), ...(u.rows[0].squadre_allenatore || [])];
        eventi = eventi.filter(e => !e.categoria || sq.includes(e.categoria));
      } else {
        eventi = eventi.filter(e => !e.categoria);
      }
    } else {
      eventi = eventi.filter(e => !e.categoria);
    }

    res.json(eventi.slice(0, 3));
  } catch (err) { res.status(500).json({ error: 'Errore interno del server.' }); }
});

/* ─── Calendario: crea sessione ─── */
app.post('/api/calendario', adminAuth, async (req, res) => {
  const { titolo, data, ora, categoria, note, ripetizione_settimanale, data_fine_ripetizione, giorni_settimana, tipo, formato, foto, palestra_id, responsabile } = req.body;
  if (!titolo || !data || !ora) return res.status(400).json({ error: 'Titolo, data e ora obbligatori' });
  const tipoVal    = ['evento','torneo'].includes(tipo) ? tipo : 'allenamento';
  const formatoVal = tipoVal === 'torneo' ? (formato || '4vs4') : '';
  const palestraVal = palestra_id || '';
  const respVal = responsabile || '';
  const dataFineEffettiva = data_fine_ripetizione || null;
  const _fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const _insertCal = (id, dataStr) => db.query(
    `INSERT INTO calendario (id, titolo, data_str, ora, categoria, note, tipo, formato, foto, palestra_id, responsabile)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, titolo, dataStr, ora, categoria || '', note || '', tipoVal, formatoVal, foto || '', palestraVal, respVal]
  );
  try {
    const giorniArr = Array.isArray(giorni_settimana) && giorni_settimana.length ? giorni_settimana.map(Number) : null;
    if (giorniArr && dataFineEffettiva && dataFineEffettiva >= data) {
      const giorniSet  = new Set(giorniArr);
      const sessioni   = [];
      let cur  = new Date(data + 'T00:00:00');
      const end = new Date(dataFineEffettiva + 'T00:00:00');
      let i = 0;
      while (cur <= end) {
        if (giorniSet.has(cur.getDay())) {
          const id      = crypto.randomUUID();
          const dataStr = _fmtDate(cur);
          await _insertCal(id, dataStr);
          sessioni.push({ id, titolo, data: dataStr, ora, tipo: tipoVal, formato: formatoVal, responsabile: respVal });
          i++;
        }
        cur.setDate(cur.getDate() + 1);
      }
      return res.status(201).json({ sessioni, count: sessioni.length });
    }
    if (ripetizione_settimanale && dataFineEffettiva && dataFineEffettiva >= data) {
      const sessioni = [];
      let currentDate = new Date(data + 'T00:00:00');
      const endDate   = new Date(dataFineEffettiva + 'T00:00:00');
      let i = 0;
      while (currentDate <= endDate) {
        const id      = crypto.randomUUID();
        const dataStr = _fmtDate(currentDate);
        await _insertCal(id, dataStr);
        sessioni.push({ id, titolo, data: dataStr, ora, tipo: tipoVal, formato: formatoVal, responsabile: respVal });
        currentDate.setDate(currentDate.getDate() + 7);
        i++;
      }
      return res.status(201).json({ sessioni, count: sessioni.length });
    }
    const id = crypto.randomUUID();
    await _insertCal(id, data);

    // Notifica email agli utenti attivi se è un evento (filtrata per categoria)
    if (tipoVal === 'evento') {
      const categoriaVal = categoria || '';
      const utenti = categoriaVal
        ? await db.query(
            `SELECT nome, email FROM utenti WHERE stato='attivo' AND email IS NOT NULL
             AND (squadre_atleta @> $1::jsonb OR squadre_allenatore @> $1::jsonb)`,
            [JSON.stringify([categoriaVal])]
          )
        : await db.query(`SELECT nome, email FROM utenti WHERE stato='attivo' AND email IS NOT NULL`);

      const base = process.env.BASE_URL || 'https://www.virtuscaserta.com';
      const calLink = `${base}/calendario#${data}`;
      const dataFormattata = new Date(data + 'T00:00:00').toLocaleDateString('it-IT', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
      const emailHtml = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
          <div style="background:#e11d48;padding:24px;text-align:center">
            <h1 style="color:#fff;font-size:20px;margin:0;letter-spacing:2px">VIRTUS CASERTA</h1>
            <p style="color:#fecdd3;margin:6px 0 0;font-size:13px">NUOVO EVENTO</p>
          </div>
          <div style="padding:28px 24px">
            <h2 style="color:#e11d48;font-size:22px;margin:0 0 16px;">${esc(titolo)}</h2>
            <p style="font-size:15px;color:#374151;"><strong>Data:</strong> ${dataFormattata}</p>
            ${ora ? `<p style="font-size:15px;color:#374151;"><strong>Orario:</strong> ${esc(ora)}</p>` : ''}
            ${categoriaVal ? `<p style="font-size:15px;color:#374151;"><strong>Categoria:</strong> ${esc(categoriaVal)}</p>` : ''}
            ${note ? `<p style="font-size:14px;color:#6b7280;margin-top:12px;">${esc(note)}</p>` : ''}
            <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:20px 24px;margin:24px 0;text-align:center">
              <p style="margin:0 0 16px;font-size:15px;font-weight:700;color:#991b1b;">Conferma la tua partecipazione</p>
              <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">Facci sapere se sarai presente all'evento accedendo al tuo account.</p>
              <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
                <a href="${calLink}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;">Confermo la partecipazione</a>
                <a href="${calLink}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;">Non parteciperò</a>
              </div>
              <p style="margin:14px 0 0;font-size:11px;color:#9ca3af;">Accedi al sito per registrare la tua risposta</p>
            </div>
          </div>
          <div style="background:#f8fafc;padding:14px;text-align:center;font-size:12px;color:#9ca3af">
            © 2026 Virtus Caserta – Società Sportiva Pallavolo
          </div>
        </div>`;
      for (const u of utenti.rows) {
        if (brevoApiConfigurato()) {
          sendBrevoEmail({ to: u.email, subject: `Nuovo evento: ${titolo} | Virtus Caserta`, html: emailHtml })
            .catch(e => console.error('[Evento email]', u.email, e.message));
        } else if (brevoConfigurato()) {
          creaTransporterShop().sendMail({ from: shopFrom(), to: u.email, subject: `Nuovo evento: ${titolo} | Virtus Caserta`, html: emailHtml })
            .catch(e => console.error('[Evento email SMTP]', u.email, e.message));
        }
      }
    }

    res.status(201).json({ id, titolo, data, ora, categoria: categoria || '', note: note || '', tipo: tipoVal, formato: formatoVal, foto: foto || '', responsabile: respVal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Calendario: aggiorna sessione ─── */
app.put('/api/calendario/:id', adminAuth, async (req, res) => {
  const { titolo, data, ora, categoria, note, tipo, formato, foto, palestra_id, responsabile } = req.body;
  const tipoVal    = ['evento','torneo'].includes(tipo) ? tipo : 'allenamento';
  const formatoVal = tipoVal === 'torneo' ? (formato || '4vs4') : '';
  const palestraVal = palestra_id || '';
  const respVal = responsabile || '';
  try {
    const result = await db.query(
      `UPDATE calendario
       SET titolo=$1, data_str=$2, ora=$3, categoria=$4, note=$5, tipo=$6, formato=$7, foto=$8, palestra_id=$9, responsabile=$10
       WHERE id=$11
       RETURNING *`,
      [titolo, data, ora, categoria || '', note || '', tipoVal, formatoVal, foto || '', palestraVal, respVal, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    const r = result.rows[0];
    res.json({ id: r.id, titolo: r.titolo, data: r.data_str, ora: r.ora, categoria: r.categoria, note: r.note, tipo: r.tipo, foto: r.foto, palestra_id: r.palestra_id || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Calendario: elimina sessione ─── */
app.delete('/api/calendario/:id', adminAuth, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM calendario WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Calendario: svuota tutto ─── */
app.delete('/api/admin/calendario/svuota', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM calendario');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Calendario: collega sessione a categoria o utente ─── */
app.post('/api/calendario/:id/collega', adminAuth, async (req, res) => {
  const { tipo, valore } = req.body;
  if (!['categoria', 'utente'].includes(tipo) || !valore) return res.status(400).json({ error: 'Parametri non validi' });
  const col = tipo === 'categoria' ? 'categorie_collegate' : 'utenti_collegati';
  try {
    const r = await db.query(
      `UPDATE calendario SET ${col} = CASE WHEN ${col} @> $1::jsonb THEN ${col} ELSE ${col} || $1::jsonb END WHERE id=$2 RETURNING id`,
      [JSON.stringify([valore]), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.delete('/api/calendario/:id/collega', adminAuth, async (req, res) => {
  const { tipo, valore } = req.body;
  if (!['categoria', 'utente'].includes(tipo) || !valore) return res.status(400).json({ error: 'Parametri non validi' });
  try {
    if (tipo === 'categoria') {
      const sess = await db.query('SELECT categoria FROM calendario WHERE id=$1', [req.params.id]);
      if (!sess.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
      const nuovaCategoria = (sess.rows[0].categoria || '')
        .split(',').map(c => c.trim()).filter(c => c && c !== valore).join(',');
      const r = await db.query(
        `UPDATE calendario
         SET categoria = $1,
             categorie_collegate = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(categorie_collegate) AS x WHERE x != $2), '[]'::jsonb)
         WHERE id=$3 RETURNING id`,
        [nuovaCategoria, valore, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    } else {
      const r = await db.query(
        `UPDATE calendario SET utenti_collegati = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(utenti_collegati) AS x WHERE x != $1), '[]'::jsonb) WHERE id=$2 RETURNING id`,
        [valore, req.params.id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    }
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Tornei: lista pubblica (per utenti autenticati) ─── */
app.get('/api/tornei/pubblici', userAuth, async (_req, res) => {
  try {
    const r = await db.query(`SELECT id, nome, formato, data_inizio, data_fine, note, stato FROM tornei WHERE stato != 'bozza' ORDER BY data_inizio DESC, created_at DESC`);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Tornei: CRUD ─── */
app.get('/api/tornei', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM tornei ORDER BY data_inizio DESC, created_at DESC');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/tornei', adminAuth, async (req, res) => {
  const { nome, formato, data_inizio, data_fine, note, stato, responsabile, immagine, palestra_nome, palestra_slots, best_of } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  const id = crypto.randomUUID();
  try {
    const r = await db.query(
      `INSERT INTO tornei (id, nome, formato, data_inizio, data_fine, note, stato, responsabile, immagine, palestra_nome, palestra_slots, best_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, nome.trim(), formato || '4vs4', data_inizio || '', data_fine || '', note || '', stato || 'bozza', responsabile || '', immagine || '', palestra_nome || '', JSON.stringify(palestra_slots || []), best_of === 5 ? 5 : 3]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.put('/api/tornei/:id', adminAuth, async (req, res) => {
  const { nome, formato, data_inizio, data_fine, note, stato, responsabile, immagine, palestra_nome, palestra_slots, best_of } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  try {
    const r = await db.query(
      `UPDATE tornei SET nome=$1, formato=$2, data_inizio=$3, data_fine=$4, note=$5, stato=$6, responsabile=$7, immagine=$8, palestra_nome=$9, palestra_slots=$10, best_of=$11 WHERE id=$12 RETURNING *`,
      [nome.trim(), formato || '4vs4', data_inizio || '', data_fine || '', note || '', stato || 'bozza', responsabile || '', immagine || '', palestra_nome || '', JSON.stringify(palestra_slots || []), best_of === 5 ? 5 : 3, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Torneo non trovato' });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.delete('/api/tornei/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM torneo_partite WHERE torneo_id=$1', [req.params.id]);
    await db.query('DELETE FROM torneo_gironi WHERE torneo_id=$1', [req.params.id]);
    await db.query('DELETE FROM torneo_partecipanti WHERE torneo_id=$1', [req.params.id]);
    await db.query('DELETE FROM torneo_squadre WHERE torneo_id=$1', [req.params.id]);
    const r = await db.query('DELETE FROM tornei WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Torneo non trovato' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Tornei: partecipanti ─── */
app.get('/api/tornei/:id/partecipanti', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT u.id, u.nome, u.cognome, u.email FROM torneo_partecipanti tp
       JOIN utenti u ON u.id = tp.utente_id
       WHERE tp.torneo_id=$1 ORDER BY u.cognome, u.nome`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/tornei/:id/partecipanti', adminAuth, async (req, res) => {
  const { utente_id } = req.body;
  if (!utente_id) return res.status(400).json({ error: 'utente_id obbligatorio' });
  try {
    await db.query(
      `INSERT INTO torneo_partecipanti (torneo_id, utente_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, utente_id]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.delete('/api/tornei/:id/partecipanti/:uid', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM torneo_partecipanti WHERE torneo_id=$1 AND utente_id=$2', [req.params.id, req.params.uid]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Tornei: squadre ─── */
app.get('/api/tornei/:id/squadre', adminAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM torneo_squadre WHERE torneo_id=$1 ORDER BY created_at', [req.params.id]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/tornei/:id/squadre', adminAuth, async (req, res) => {
  const { nome, colore, partecipanti } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  const id = crypto.randomUUID();
  try {
    const r = await db.query(
      `INSERT INTO torneo_squadre (id, torneo_id, nome, colore, partecipanti) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, req.params.id, nome.trim(), colore || '#3b82f6', JSON.stringify(partecipanti || [])]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.put('/api/tornei/:id/squadre/:sid', adminAuth, async (req, res) => {
  const { nome, colore, partecipanti } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  try {
    const r = await db.query(
      `UPDATE torneo_squadre SET nome=$1, colore=$2, partecipanti=$3 WHERE id=$4 AND torneo_id=$5 RETURNING *`,
      [nome.trim(), colore || '#3b82f6', JSON.stringify(partecipanti || []), req.params.sid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Squadra non trovata' });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.delete('/api/tornei/:id/squadre/:sid', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM torneo_squadre WHERE id=$1 AND torneo_id=$2 RETURNING id', [req.params.sid, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Squadra non trovata' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Tornei: gironi ─── */
app.get('/api/tornei/:id/gironi', adminAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM torneo_gironi WHERE torneo_id=$1 ORDER BY ordine, nome', [req.params.id]);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/tornei/:id/gironi', adminAuth, async (req, res) => {
  const { nome, ordine } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  const id = crypto.randomUUID();
  try {
    const r = await db.query(
      `INSERT INTO torneo_gironi (id, torneo_id, nome, ordine) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, req.params.id, nome.trim(), ordine || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.put('/api/tornei/:id/gironi/:gid', adminAuth, async (req, res) => {
  const { nome, ordine, squadre } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  try {
    const r = await db.query(
      `UPDATE torneo_gironi SET nome=$1, ordine=$2, squadre=$3 WHERE id=$4 AND torneo_id=$5 RETURNING *`,
      [nome.trim(), ordine ?? 0, JSON.stringify(Array.isArray(squadre) ? squadre : []), req.params.gid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Girone non trovato' });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.delete('/api/tornei/:id/gironi/:gid', adminAuth, async (req, res) => {
  try {
    await db.query(`UPDATE torneo_partite SET girone_id='' WHERE girone_id=$1`, [req.params.gid]);
    const r = await db.query('DELETE FROM torneo_gironi WHERE id=$1 AND torneo_id=$2 RETURNING id', [req.params.gid, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Girone non trovato' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Tornei: partite ─── */
app.get('/api/tornei/:id/partite', adminAuth, async (req, res) => {
  try {
    const [partite, squadre, gironi] = await Promise.all([
      db.query('SELECT * FROM torneo_partite WHERE torneo_id=$1 ORDER BY data_str, ora, created_at', [req.params.id]),
      db.query('SELECT id, nome, colore FROM torneo_squadre WHERE torneo_id=$1', [req.params.id]),
      db.query('SELECT * FROM torneo_gironi WHERE torneo_id=$1 ORDER BY ordine, nome', [req.params.id]),
    ]);
    const sqMap = Object.fromEntries(squadre.rows.map(s => [s.id, s]));
    const enriched = partite.rows.map(p => ({
      ...p,
      squadra_casa:   sqMap[p.squadra_casa_id]   || null,
      squadra_ospite: sqMap[p.squadra_ospite_id] || null,
    }));
    res.json({ partite: enriched, squadre: squadre.rows, gironi: gironi.rows });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/tornei/:id/partite', adminAuth, async (req, res) => {
  const { girone_id, squadra_casa_id, squadra_ospite_id, data_str, ora, luogo, note } = req.body;
  if (!squadra_casa_id || !squadra_ospite_id) return res.status(400).json({ error: 'Squadre obbligatorie' });
  const id = crypto.randomUUID();
  try {
    const r = await db.query(
      `INSERT INTO torneo_partite (id, torneo_id, girone_id, squadra_casa_id, squadra_ospite_id, data_str, ora, luogo, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, req.params.id, girone_id || '', squadra_casa_id, squadra_ospite_id, data_str || '', ora || '', luogo || '', note || '']
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.put('/api/tornei/:id/partite/:pid', adminAuth, async (req, res) => {
  const { girone_id, squadra_casa_id, squadra_ospite_id, data_str, ora, luogo, risultato_casa, risultato_ospite, stato, note } = req.body;
  try {
    const r = await db.query(
      `UPDATE torneo_partite SET girone_id=$1, squadra_casa_id=$2, squadra_ospite_id=$3,
         data_str=$4, ora=$5, luogo=$6, risultato_casa=$7, risultato_ospite=$8, stato=$9, note=$10
       WHERE id=$11 AND torneo_id=$12 RETURNING *`,
      [girone_id || '', squadra_casa_id, squadra_ospite_id, data_str || '', ora || '', luogo || '',
       risultato_casa ?? null, risultato_ospite ?? null, stato || 'programmata', note || '',
       req.params.pid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Partita non trovata' });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.delete('/api/tornei/:id/partite/:pid', adminAuth, async (req, res) => {
  try {
    const p = await db.query('SELECT calendario_id FROM torneo_partite WHERE id=$1 AND torneo_id=$2', [req.params.pid, req.params.id]);
    if (p.rows[0]?.calendario_id) {
      await db.query('DELETE FROM calendario WHERE id=$1', [p.rows[0].calendario_id]).catch(() => {});
    }
    const r = await db.query('DELETE FROM torneo_partite WHERE id=$1 AND torneo_id=$2 RETURNING id', [req.params.pid, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Partita non trovata' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/tornei/:id/partite/:pid/calendario', adminAuth, async (req, res) => {
  try {
    const [torneoRes, partitaRes] = await Promise.all([
      db.query('SELECT * FROM tornei WHERE id=$1', [req.params.id]),
      db.query(`SELECT tp.*, ts1.nome as nome_casa, ts2.nome as nome_ospite
                FROM torneo_partite tp
                LEFT JOIN torneo_squadre ts1 ON ts1.id = tp.squadra_casa_id
                LEFT JOIN torneo_squadre ts2 ON ts2.id = tp.squadra_ospite_id
                WHERE tp.id=$1 AND tp.torneo_id=$2`, [req.params.pid, req.params.id]),
    ]);
    if (!torneoRes.rows.length || !partitaRes.rows.length) return res.status(404).json({ error: 'Non trovato' });
    const torneo = torneoRes.rows[0];
    const partita = partitaRes.rows[0];
    const partecipanti = await db.query(
      'SELECT utente_id FROM torneo_partecipanti WHERE torneo_id=$1', [req.params.id]
    );
    const utenti_collegati = partecipanti.rows.map(r => r.utente_id);
    const titolo = `${partita.nome_casa || '?'} vs ${partita.nome_ospite || '?'}`;
    const note = torneo.nome + (partita.girone_id ? '' : '');

    if (partita.in_calendario && partita.calendario_id) {
      const noteAggiornata = [note, partita.luogo].filter(Boolean).join(' · ');
      await db.query(
        `UPDATE calendario SET titolo=$1, data_str=$2, ora=$3, note=$4, utenti_collegati=$5 WHERE id=$6`,
        [titolo, partita.data_str || '', partita.ora || '', noteAggiornata, JSON.stringify(utenti_collegati), partita.calendario_id]
      );
      return res.json({ success: true, calendario_id: partita.calendario_id, updated: true });
    }

    const calId = crypto.randomUUID();
    const noteInserita = [note, partita.luogo].filter(Boolean).join(' · ');
    await db.query(
      `INSERT INTO calendario (id, titolo, data_str, ora, categoria, note, tipo, utenti_collegati)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [calId, titolo, partita.data_str || '', partita.ora || '', '', noteInserita, 'torneo', JSON.stringify(utenti_collegati)]
    );
    await db.query(
      `UPDATE torneo_partite SET in_calendario=true, calendario_id=$1 WHERE id=$2`,
      [calId, req.params.pid]
    );
    res.json({ success: true, calendario_id: calId, updated: false });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Tornei: genera fase finale knockout ─── */
app.post('/api/tornei/:id/genera-knockout', adminAuth, async (req, res) => {
  try {
    const { squadre_ids, nome } = req.body;
    if (!Array.isArray(squadre_ids) || squadre_ids.length < 2)
      return res.status(400).json({ error: 'Minimo 2 squadre' });

    const n = squadre_ids.length;
    const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(n, 2))));

    const ROUND_NAMES = { 2:'Finale', 4:'Semifinale', 8:'Quarto di finale', 16:'Ottavo di finale', 32:'Sedicesimo di finale' };

    // Delete existing knockout girone for this torneo (replace if re-generated)
    const existingKO = await db.query(
      `SELECT id FROM torneo_gironi WHERE torneo_id=$1 AND tipo='knockout'`, [req.params.id]
    );
    for (const ko of existingKO.rows) {
      await db.query('DELETE FROM torneo_partite WHERE girone_id=$1', [ko.id]);
      await db.query('DELETE FROM torneo_gironi WHERE id=$1', [ko.id]);
    }

    const gironeId = crypto.randomUUID();
    await db.query(
      `INSERT INTO torneo_gironi (id, torneo_id, nome, ordine, tipo, squadre) VALUES ($1,$2,$3,999,'knockout',$4)`,
      [gironeId, req.params.id, nome || 'Fase Finale', JSON.stringify(squadre_ids)]
    );

    // Seed: pad to bracketSize with '' for byes
    const seeded = [...squadre_ids];
    while (seeded.length < bracketSize) seeded.push('');

    // Generate all rounds top-down
    let roundSize = bracketSize;
    let pos = 0;
    while (roundSize >= 2) {
      const roundName = ROUND_NAMES[roundSize] || `Round ${roundSize}`;
      const matches = roundSize / 2;
      for (let i = 0; i < matches; i++) {
        const casaId   = roundSize === bracketSize ? (seeded[i * 2]     || '') : '';
        const ospiteId = roundSize === bracketSize ? (seeded[i * 2 + 1] || '') : '';
        await db.query(
          `INSERT INTO torneo_partite (id, torneo_id, girone_id, squadra_casa_id, squadra_ospite_id, round, bracket_pos, stato)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'programmata')`,
          [crypto.randomUUID(), req.params.id, gironeId, casaId, ospiteId, roundName, pos++]
        );
      }
      roundSize /= 2;
    }

    res.json({ success: true, girone_id: gironeId, bracket_size: bracketSize, byes: bracketSize - n });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Tornei: vista utente (miei tornei con gironi+partite) ─── */
app.get('/api/tornei/miei', userAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const torneiRes = await db.query(
      `SELECT t.* FROM tornei t
       JOIN torneo_partecipanti tp ON tp.torneo_id = t.id
       WHERE tp.utente_id=$1
       ORDER BY t.data_inizio DESC, t.created_at DESC`,
      [userId]
    );
    const result = await Promise.all(torneiRes.rows.map(async t => {
      const [gironi, squadre, partite] = await Promise.all([
        db.query('SELECT * FROM torneo_gironi WHERE torneo_id=$1 ORDER BY ordine, nome', [t.id]),
        db.query('SELECT id, nome, colore, partecipanti FROM torneo_squadre WHERE torneo_id=$1', [t.id]),
        db.query('SELECT * FROM torneo_partite WHERE torneo_id=$1 ORDER BY data_str, ora', [t.id]),
      ]);
      const sqMap = Object.fromEntries(squadre.rows.map(s => [s.id, s]));
      const partiteEnriched = partite.rows.map(p => ({
        ...p,
        squadra_casa:   sqMap[p.squadra_casa_id]   || null,
        squadra_ospite: sqMap[p.squadra_ospite_id] || null,
      }));
      return { ...t, gironi: gironi.rows, squadre: squadre.rows, partite: partiteEnriched };
    }));
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Palestre: intervalli occupati (admin) ─── */
app.get('/api/admin/palestre-occupate', adminAuth, async (req, res) => {
  try {
    const { da, a, palestre } = req.query;
    if (!da || !a) return res.status(400).json({ error: 'da e a obbligatori' });
    const palestreList = palestre ? palestre.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (!palestreList.length) return res.json([]);

    // calendario entries linked to these palestres
    const calRes = await db.query(
      `SELECT c.data_str, c.ora, p.nome AS luogo
       FROM calendario c JOIN palestres p ON p.id = c.palestra_id
       WHERE c.data_str >= $1 AND c.data_str <= $2 AND p.nome = ANY($3)`,
      [da, a, palestreList]
    );

    // torneo_partite from ALL tornei at these palestres
    const ptRes = await db.query(
      `SELECT data_str, ora, luogo
       FROM torneo_partite
       WHERE data_str >= $1 AND data_str <= $2 AND luogo = ANY($3) AND data_str != ''`,
      [da, a, palestreList]
    );

    // Parse ora field: "19:00" → {inizio:"19:00", fine:""} / "19:00-21:00" → {inizio:"19:00", fine:"21:00"}
    function parseOraInterval(ora) {
      if (!ora) return { inizio: '', fine: '' };
      const sep = ora.includes('–') ? '–' : (ora.includes('-') ? '-' : null);
      if (sep) {
        const [a, b] = ora.split(sep);
        return { inizio: a.trim(), fine: b ? b.trim() : '' };
      }
      return { inizio: ora.trim(), fine: '' };
    }

    const result = [
      ...calRes.rows.map(r => { const { inizio, fine } = parseOraInterval(r.ora); return { data_str: r.data_str, luogo: r.luogo, inizio, fine }; }),
      ...ptRes.rows.map(r => { const { inizio, fine } = parseOraInterval(r.ora); return { data_str: r.data_str, luogo: r.luogo, inizio, fine }; }),
    ].filter(r => r.inizio);

    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Palestre: CRUD ─── */
app.get('/api/palestre', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM palestres ORDER BY nome');
    res.json(r.rows.map(p => ({ id: p.id, nome: p.nome, indirizzo: p.indirizzo || '', orari: p.orari || [] })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/admin/palestre', adminAuth, async (req, res) => {
  const { nome, indirizzo, orari } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  const id = crypto.randomUUID();
  try {
    const r = await db.query(
      `INSERT INTO palestres (id, nome, indirizzo, orari) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, nome.trim(), (indirizzo || '').trim(), JSON.stringify(orari || [])]
    );
    const p = r.rows[0];
    res.json({ id: p.id, nome: p.nome, indirizzo: p.indirizzo, orari: p.orari });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.put('/api/admin/palestre/:id', adminAuth, async (req, res) => {
  const { nome, indirizzo, orari } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  try {
    const r = await db.query(
      `UPDATE palestres SET nome=$1, indirizzo=$2, orari=$3 WHERE id=$4 RETURNING *`,
      [nome.trim(), (indirizzo || '').trim(), JSON.stringify(orari || []), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Palestra non trovata' });
    const p = r.rows[0];
    res.json({ id: p.id, nome: p.nome, indirizzo: p.indirizzo, orari: p.orari });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.delete('/api/admin/palestre/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM palestres WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Palestra non trovata' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.get('/api/palestre/:id/occupazione', async (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).json({ error: 'Parametro data obbligatorio' });
  try {
    const pr = await db.query('SELECT orari FROM palestres WHERE id=$1', [req.params.id]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Palestra non trovata' });
    const orariTutti = pr.rows[0].orari || [];
    const dow = new Date(data + 'T00:00:00').getDay();
    const orariGiorno = orariTutti.filter(o => o.giorno === dow);

    const sr = await db.query(
      `SELECT titolo, ora FROM calendario WHERE palestra_id=$1 AND data_str=$2`,
      [req.params.id, data]
    );
    const sessioni = sr.rows;

    function toMin(hhmm) {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    }
    function fromMin(min) {
      return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    }
    function parseOra(ora) {
      if (ora.includes('–')) {
        const [a, b] = ora.split('–');
        return [toMin(a.trim()), toMin(b.trim())];
      }
      const si = toMin(ora.trim());
      return [si, si + 60];
    }

    const disponibili = [];
    const occupati = [];

    for (const slot of orariGiorno) {
      const slotI = toMin(slot.inizio);
      const slotF = toMin(slot.fine);

      // Sessioni che si sovrappongono parzialmente o totalmente a questo slot
      const matches = sessioni
        .map(s => { const [si, sf] = parseOra(s.ora); return { si, sf, titolo: s.titolo }; })
        .filter(s => s.si < slotF && s.sf > slotI)
        .sort((a, b) => a.si - b.si);

      if (!matches.length) {
        disponibili.push({ inizio: slot.inizio, fine: slot.fine });
        continue;
      }

      // Split slot attorno alle sessioni
      let cursor = slotI;
      for (const s of matches) {
        const busyStart = Math.max(s.si, slotI);
        const busyEnd   = Math.min(s.sf, slotF);
        if (cursor < busyStart) disponibili.push({ inizio: fromMin(cursor), fine: fromMin(busyStart) });
        occupati.push({ inizio: fromMin(busyStart), fine: fromMin(busyEnd), titolo: s.titolo });
        cursor = busyEnd;
      }
      if (cursor < slotF) disponibili.push({ inizio: fromMin(cursor), fine: fromMin(slotF) });
    }

    res.json({ disponibili, occupati });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Admin: lista utenti attivi (per collegamento sessioni) ─── */
app.get('/api/admin/utenti-lista', adminAuth, async (_req, res) => {
  try {
    const r = await db.query(`SELECT id, nome, cognome, email FROM utenti WHERE stato='attivo' ORDER BY cognome, nome`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Utenti lista (user-accessible, for invites) ─── */
app.get('/api/utenti', userAuth, async (_req, res) => {
  try {
    const r = await db.query(`SELECT id, nome, cognome, email FROM utenti WHERE stato='attivo' ORDER BY cognome, nome`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Admin: federazioni (OPES category names) ─── */
app.get('/api/admin/federazioni', adminAuth, async (_req, res) => {
  res.json({ opes: OPES_TOURNAMENTS.map(t => t.categoria) });
});

/* ─── Comunicazioni utente ─── */
app.get('/api/comunicazioni', userAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    // Fetch user's squadre for squad-broadcast visibility
    const uInfo = await db.query(`SELECT squadre_atleta FROM utenti WHERE id=$1`, [uid]);
    const userSquadre = new Set();
    ((uInfo.rows[0]?.squadre_atleta) || []).forEach(s => s && userSquadre.add(s.trim()));
    const squadreArr = [...userSquadre];
    const r = await db.query(
      `SELECT * FROM comunicazioni
       WHERE mittente_id=$1
          OR destinatario_id=$1
          OR (destinatario_tipo='squadra' AND destinatario_label = ANY($2::text[]))
       ORDER BY creato_il DESC`,
      [uid, squadreArr.length ? squadreArr : ['__none__']]
    );
    res.json(r.rows.map(m => ({
      id: m.id, oggetto: m.oggetto, testo: m.testo,
      mittente:    m.mittente_nome  || 'Virtus Caserta',
      destinatario: m.destinatario_label || m.destinatario_tipo,
      letto: m.letto, creato_il: m.creato_il,
      inviata: m.mittente_id === uid,
    })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/comunicazioni', userAuth, async (req, res) => {
  const { oggetto, testo, destinatario, destinatario_label } = req.body;
  if (!oggetto || !testo) return res.status(400).json({ error: 'Oggetto e testo obbligatori' });
  const VALIDI = ['staff', 'admin', 'dirigenza', 'squadra'];
  if (!VALIDI.includes(destinatario)) return res.status(400).json({ error: 'Destinatario non valido' });
  try {
    const uid = String(req.user.id);
    const uRes = await db.query('SELECT nome, cognome FROM utenti WHERE id=$1', [uid]);
    const mittente_nome = uRes.rows.length ? `${uRes.rows[0].nome} ${uRes.rows[0].cognome || ''}`.trim() : 'Utente';
    const DEST_LABEL = { staff: 'Staff', admin: 'Amministrazione', dirigenza: 'Dirigenza', squadra: destinatario_label || 'Squadra' };
    const destLabel = DEST_LABEL[destinatario];
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO comunicazioni (id,mittente_id,mittente_nome,destinatario_tipo,destinatario_label,oggetto,testo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, uid, mittente_nome, destinatario, destLabel, oggetto, testo]
    );
    res.status(201).json({ id, oggetto, testo, mittente: mittente_nome, destinatario: destLabel, letto: false, creato_il: new Date().toISOString(), inviata: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/comunicazioni/:id/leggi', userAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    await db.query('UPDATE comunicazioni SET letto=true WHERE id=$1 AND destinatario_id=$2', [req.params.id, uid]);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

/* ─── Documenti utente ─── */
app.get('/api/documenti', userAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    const r = await db.query('SELECT * FROM documenti_utente WHERE utente_id=$1 ORDER BY creato_il DESC', [uid]);
    res.json(r.rows.map(d => ({ id: d.id, nome: d.nome, url: d.url, dimensione: d.dimensione, creato_il: d.creato_il })));
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/documenti', userAuth, uploadDoc.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  try {
    const uid = String(req.user.id);
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `docs_${uid}_${Date.now()}_${safeName}`;
    let url = '';
    if (supabaseStorage) {
      const { error } = await supabaseStorage.from(SUPABASE_BUCKET).upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (error) throw error;
      const { data } = supabaseStorage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
      url = data.publicUrl;
    } else {
      const localPath = path.join(UPLOADS_DIR, storagePath);
      fs.writeFileSync(localPath, req.file.buffer);
      url = '/uploads/' + storagePath;
    }
    const id = crypto.randomUUID();
    await db.query(
      'INSERT INTO documenti_utente (id,utente_id,nome,url,dimensione) VALUES ($1,$2,$3,$4,$5)',
      [id, uid, req.file.originalname, url, req.file.size]
    );
    res.status(201).json({ id, nome: req.file.originalname, url, dimensione: req.file.size, creato_il: new Date().toISOString() });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore upload' }); }
});

app.delete('/api/documenti/:id', userAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    const r = await db.query('DELETE FROM documenti_utente WHERE id=$1 AND utente_id=$2 RETURNING id', [req.params.id, uid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Documento non trovato' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Partite proposte ─── */
app.post('/api/partite/proposta', userAuth, async (req, res) => {
  const { data, ora, ora_fine, luogo, note, invitati_categorie, invitati_persone } = req.body;
  if (!data || !ora) return res.status(400).json({ error: 'Data e orario obbligatori' });
  try {
    const uid = String(req.user.id);
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO partite_proposte (id,mittente_id,data,ora,ora_fine,luogo,note,invitati_categorie,invitati_persone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, uid, data, ora, ora_fine||null, luogo||null, note||null,
       JSON.stringify(Array.isArray(invitati_categorie)?invitati_categorie:[]),
       JSON.stringify(Array.isArray(invitati_persone)?invitati_persone:[])]
    );
    res.status(201).json({ id, stato: 'pending' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.get('/api/partite/proposte', userAuth, async (req, res) => {
  try {
    const uid = String(req.user.id);
    const r = await db.query('SELECT * FROM partite_proposte WHERE mittente_id=$1 ORDER BY creato_il DESC', [uid]);
    const rows = r.rows;
    for (const row of rows) {
      const ids = (row.invitati_persone || []).map(Number).filter(Boolean);
      if (ids.length) {
        const nr = await db.query(
          `SELECT id, nome, cognome FROM utenti WHERE id = ANY($1::int[])`,
          [ids]
        );
        row.invitati_nomi = nr.rows.map(u => `${u.nome||''} ${u.cognome||''}`.trim());
      } else {
        row.invitati_nomi = [];
      }
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});

app.put('/api/partite/proposte/:id/invitati', userAuth, async (req, res) => {
  const { invitati_persone } = req.body;
  const uid = String(req.user.id);
  try {
    const r = await db.query(
      `UPDATE partite_proposte SET invitati_persone=$1
       WHERE id=$2 AND mittente_id=$3 AND stato='accepted' RETURNING *`,
      [JSON.stringify(Array.isArray(invitati_persone) ? invitati_persone : []), req.params.id, uid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovata o non autorizzato' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Admin: richieste partite proposte ─── */
app.get('/api/admin/partite-proposte', adminAuth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT pp.*, u.nome AS mittente_nome, u.cognome AS mittente_cognome, u.email AS mittente_email
      FROM partite_proposte pp
      LEFT JOIN utenti u ON u.id::text = pp.mittente_id
      ORDER BY pp.creato_il DESC
    `);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.put('/api/admin/partite-proposte/:id', adminAuth, async (req, res) => {
  const { stato, admin_note } = req.body;
  if (!['accepted', 'refused'].includes(stato)) return res.status(400).json({ error: 'Stato non valido' });
  try {
    // Fetch proposal before update to get palestra/time data
    const pr = await db.query('SELECT * FROM partite_proposte WHERE id=$1', [req.params.id]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Non trovata' });
    const prop = pr.rows[0];

    const r = await db.query(
      'UPDATE partite_proposte SET stato=$1, admin_note=$2 WHERE id=$3 RETURNING *',
      [stato, admin_note || null, req.params.id]
    );

    // On acceptance: block palestra slot in calendario
    if (stato === 'accepted' && prop.palestra_id) {
      const oraStr = prop.ora + (prop.ora_fine ? ('–' + String(prop.ora_fine).slice(0,5)) : '');
      const calId = crypto.randomUUID();
      await db.query(
        `INSERT INTO calendario (id, titolo, data_str, ora, palestra_id, categoria, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [calId, 'Partita organizzata', prop.data, oraStr, String(prop.palestra_id), 'partita', prop.note || '']
      );
    }

    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.delete('/api/admin/partite-proposte/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM partite_proposte WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Admin: documenti utente ─── */
app.get('/api/admin/utenti/:id/documenti', adminAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM documenti_utente WHERE utente_id=$1 ORDER BY creato_il DESC', [req.params.id]);
    res.json(r.rows.map(d => ({ id: d.id, nome: d.nome, url: d.url, dimensione: d.dimensione, creato_il: d.creato_il })));
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});

app.post('/api/admin/utenti/:id/documenti', adminAuth, uploadDoc.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file' });
    const uid = req.params.id;
    let url;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
      const { createClient } = require('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
      const storagePath = `documenti/${uid}/${Date.now()}_${req.file.originalname}`;
      const { error } = await sb.storage.from('virtus').upload(storagePath, req.file.buffer, { contentType: req.file.mimetype });
      if (error) throw error;
      url = `${process.env.SUPABASE_URL}/storage/v1/object/public/virtus/${storagePath}`;
    } else {
      const fs = require('fs'); const path = require('path');
      const dir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const storagePath = `${Date.now()}_${req.file.originalname}`;
      fs.writeFileSync(path.join(dir, storagePath), req.file.buffer);
      url = '/uploads/' + storagePath;
    }
    const id = crypto.randomUUID();
    await db.query('INSERT INTO documenti_utente (id,utente_id,nome,url,dimensione) VALUES ($1,$2,$3,$4,$5)', [id, uid, req.file.originalname, url, req.file.size]);
    res.status(201).json({ id, nome: req.file.originalname, url, dimensione: req.file.size, creato_il: new Date().toISOString() });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore upload' }); }
});

app.delete('/api/admin/documenti/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM documenti_utente WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Documento non trovato' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Partecipazioni: RSVP utente ─── */
app.post('/api/calendario/:id/partecipa', userAuth, async (req, res) => {
  const { risposta } = req.body;
  if (!['si', 'no'].includes(risposta)) return res.status(400).json({ error: 'Risposta non valida' });
  try {
    await db.query(
      `INSERT INTO partecipazioni (sessione_id, utente_id, risposta)
       VALUES ($1, $2, $3)
       ON CONFLICT (sessione_id, utente_id) DO UPDATE SET risposta=$3, created_at=NOW()`,
      [req.params.id, req.user.id, risposta]
    );
    res.json({ ok: true, risposta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.get('/api/calendario/:id/mia-risposta', userAuth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT risposta FROM partecipazioni WHERE sessione_id=$1 AND utente_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ risposta: r.rows.length ? r.rows[0].risposta : null });
  } catch (err) {
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Admin: lista sessioni con conteggio partecipanti ─── */
app.get('/api/admin/calendario/sessioni', adminAuth, async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT c.*,
        COUNT(p.id) FILTER (WHERE p.risposta='si') AS partecipanti_si,
        COUNT(p.id) FILTER (WHERE p.risposta='no') AS partecipanti_no
      FROM calendario c
      LEFT JOIN partecipazioni p ON p.sessione_id = c.id
      GROUP BY c.id
      ORDER BY c.data_str DESC, c.ora DESC
    `);
    res.json(r.rows.map(x => ({
      id:             x.id,
      titolo:         x.titolo,
      data:           x.data_str,
      ora:            x.ora,
      tipo:           x.tipo || 'allenamento',
      categoria:      x.categoria || '',
      luogo:          x.luogo || '',
      partecipanti_si: parseInt(x.partecipanti_si) || 0,
      partecipanti_no: parseInt(x.partecipanti_no) || 0,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Admin: partecipanti singola sessione (include non risposto + squadra players) ─── */
app.get('/api/admin/calendario/:id/partecipanti', adminAuth, async (req, res) => {
  try {
    const sessId = req.params.id;
    const sess = await db.query('SELECT categoria, categorie_collegate, utenti_collegati FROM calendario WHERE id=$1', [sessId]);
    if (!sess.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    const { categoria, categorie_collegate, utenti_collegati } = sess.rows[0];
    const categorieSplit = (categoria || '').split(',').map(c => c.trim()).filter(Boolean);
    const tutteCategorie = [...new Set([...categorieSplit, ...(categorie_collegate || [])])].filter(Boolean);
    const utentiDiretti  = (utenti_collegati || []).map(String);

    // Build per-category jsonb conditions
    const catConditions = tutteCategorie.map((_, i) => `u.squadre_atleta @> $${i+3}::jsonb OR u.squadre_allenatore @> $${i+3}::jsonb`).join(' OR ');
    const catParams     = tutteCategorie.map(c => JSON.stringify([c]));
    const hasCat        = tutteCategorie.length > 0;

    let whereClause = '';
    const params = [sessId, utentiDiretti.length ? utentiDiretti : ['__nessuno__']];
    if (hasCat) {
      whereClause = `(u.id::text = ANY($2) OR ${catConditions})`;
      params.push(...catParams);
    } else {
      whereClause = `u.id::text = ANY($2)`;
    }

    const utentiR = await db.query(`
      SELECT u.nome, u.cognome, u.email, p.risposta, p.created_at
      FROM utenti u
      LEFT JOIN partecipazioni p ON p.utente_id = u.id AND p.sessione_id = $1
      WHERE u.stato = 'attivo' AND (${whereClause})
      ORDER BY
        CASE p.risposta WHEN 'si' THEN 1 WHEN 'no' THEN 2 ELSE 3 END,
        u.cognome, u.nome
    `, params);

    // Include unlinked squadra players (no active utente account)
    let squadraRows = [];
    if (tutteCategorie.length > 0) {
      const sqR = await db.query(`
        SELECT s.nome, s.cognome,
          COALESCE(p.risposta, 'si') AS risposta,
          p.created_at
        FROM squadra s
        LEFT JOIN partecipazioni p ON p.utente_id = ('g:' || s.id) AND p.sessione_id = $1
        WHERE s.attiva = true
          AND EXISTS (SELECT 1 FROM unnest(string_to_array(s.sesso, ',')) AS cat WHERE trim(cat) = ANY($2::text[]))
          AND (s.utente_id IS NULL OR s.utente_id = ''
            OR NOT EXISTS (
              SELECT 1 FROM utenti u2 WHERE u2.id::text = s.utente_id AND u2.stato = 'attivo'
            ))
        ORDER BY s.cognome, s.nome
      `, [sessId, tutteCategorie]);
      squadraRows = sqR.rows.map(r => ({ ...r, email: '' }));
    }

    res.json([...utentiR.rows, ...squadraRows]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
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
      sconto:      parseInt(r.sconto) || 0,
      quantita:    r.quantita !== undefined ? parseInt(r.quantita) : -1,
      emoji:       r.emoji,
      disponibile: r.disponibile,
      taglie:      r.taglie,
      immagine:    r.immagine,
    }));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Admin: aggiungi prodotto ─── */
app.post('/api/admin/products', adminAuth, async (req, res) => {
  const { nome, descrizione, prezzo, emoji, taglie, disponibile, immagine, sconto, quantita } = req.body;
  if (!nome || !prezzo) return res.status(400).json({ error: 'Nome e prezzo obbligatori' });
  const id = crypto.randomUUID();
  const scontoVal   = Math.min(100, Math.max(0, parseInt(sconto) || 0));
  const quantitaVal = parseInt(quantita) !== undefined ? parseInt(quantita) : -1;
  try {
    await db.query(
      `INSERT INTO products (id, nome, descrizione, prezzo, emoji, disponibile, taglie, immagine, sconto, quantita)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, nome, descrizione || '', parseFloat(prezzo), emoji || '🏐', disponibile !== false,
       JSON.stringify(taglie || ['S', 'M', 'L', 'XL']), immagine || '', scontoVal, quantitaVal]
    );
    await logActivity('Prodotto aggiunto', nome);
    res.status(201).json({
      id, nome, descrizione: descrizione || '', prezzo: parseFloat(prezzo),
      sconto: scontoVal, quantita: quantitaVal,
      emoji: emoji || '🏐', disponibile: disponibile !== false,
      taglie: taglie || ['S', 'M', 'L', 'XL'], immagine: immagine || '',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Admin: aggiorna prodotto ─── */
app.put('/api/admin/products/:id', adminAuth, async (req, res) => {
  const { nome, descrizione, prezzo, emoji, taglie, disponibile, immagine, sconto, quantita } = req.body;
  const scontoVal   = Math.min(100, Math.max(0, parseInt(sconto) || 0));
  const quantitaVal = parseInt(quantita) !== undefined ? parseInt(quantita) : -1;
  try {
    const result = await db.query(
      `UPDATE products
       SET nome=$1, descrizione=$2, prezzo=$3, emoji=$4, disponibile=$5, taglie=$6, immagine=$7, sconto=$8, quantita=$9
       WHERE id=$10
       RETURNING *`,
      [nome, descrizione || '', parseFloat(prezzo), emoji || '🏐', disponibile !== false,
       JSON.stringify(taglie || ['S', 'M', 'L', 'XL']), immagine || '', scontoVal, quantitaVal, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Prodotto non trovato' });
    const r = result.rows[0];
    await logActivity('Prodotto modificato', r.nome);
    res.json({
      id: r.id, nome: r.nome, descrizione: r.descrizione, prezzo: parseFloat(r.prezzo),
      sconto: parseInt(r.sconto) || 0, quantita: parseInt(r.quantita) || -1,
      emoji: r.emoji, disponibile: r.disponibile, taglie: r.taglie, immagine: r.immagine,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
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
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
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
      console.error(e);
      return res.status(500).json({ error: 'Errore interno del server.' });
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
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Admin: aggiungi notizia ─── */
app.post('/api/admin/notizie', adminAuth, async (req, res) => {
  const { titolo, testo, data, colore, immagine } = req.body;
  if (!titolo || !testo) return res.status(400).json({ error: 'Titolo e testo obbligatori' });
  const id      = crypto.randomUUID();
  const dataStr = data || new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
  try {
    await db.query(
      `INSERT INTO notizie (id, titolo, testo, colore, immagine, data_str) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, titolo, testo, colore || 'blu', immagine || '', dataStr]
    );
    await logActivity('Notizia aggiunta', titolo);
    const descr = testo ? testo.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    sendPushByType('notizie', { titolo: '📰 ' + titolo, messaggio: descr, image: immagine || undefined, url: '/notizie' });
    res.status(201).json({ id, titolo, testo, colore: colore || 'blu', immagine: immagine || '', data: dataStr });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
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
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
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
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Config pubblica ─── */
app.get('/api/config', (_req, res) => {
  res.json({
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
  });
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
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
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
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Live links (pubblico) ─── */
app.get('/api/live-links', async (_req, res) => {
  try {
    const r = await db.query(`SELECT chiave, valore FROM impostazioni WHERE chiave IN ('youtube_live_url','spike_live_url')`);
    const obj = {};
    for (const row of r.rows) obj[row.chiave] = row.valore;
    res.json({ youtube_live_url: obj.youtube_live_url || '', spike_live_url: obj.spike_live_url || '', twitch_live: _twitchIsLive });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Squadre links (pubblico) ─── */
app.get('/api/squadre-links', async (_req, res) => {
  try {
    const r = await db.query(`SELECT chiave, valore FROM impostazioni WHERE chiave ~ '^sq_'`);
    const obj = {};
    for (const row of r.rows) obj[row.chiave] = row.valore;
    res.json(obj);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Squadre links (admin) ─── */
app.put('/api/admin/squadre-links', adminAuth, async (req, res) => {
  try {
    const entries = Object.entries(req.body).filter(([k]) => /^sq_[a-z0-9-]+(_\d+)?_(ris|cla|cat)$/.test(k));
    for (const [chiave, valore] of entries) {
      await db.query(
        `INSERT INTO impostazioni (chiave, valore, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (chiave) DO UPDATE SET valore=$2, updated_at=NOW()`,
        [chiave, valore || '']
      );
    }
    await logActivity('Link squadre aggiornati', entries.length + ' link');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Squadre cat-links (per-category ris/cla links) ─── */
app.get('/api/squadre-cat-links', async (_req, res) => {
  try {
    const r = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_cat_links'`);
    res.json(JSON.parse(r.rows[0]?.valore || '{}'));
  } catch { res.json({}); }
});
app.put('/api/admin/squadre-cat-links', adminAuth, async (req, res) => {
  try {
    if (typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Oggetto richiesto' });
    const safe = {};
    for (const [nome, v] of Object.entries(req.body)) {
      if (typeof nome !== 'string' || nome.length > 200) continue;
      const orari = Array.isArray(v?.orari)
        ? v.orari.map(o => ({ giorno: String(o.giorno||'').slice(0,20), ora: String(o.ora||'').slice(0,10), ora_fine: String(o.ora_fine||'').slice(0,10) }))
        : [];
      const extra_cla = Array.isArray(v?.extra_cla)
        ? v.extra_cla.map(u => String(u).slice(0, 500)).filter(Boolean)
        : [];
      safe[nome] = {
        ris:         String(v?.ris         || '').slice(0, 500),
        cla:         String(v?.cla         || '').slice(0, 500),
        palestra_id: String(v?.palestra_id || '').slice(0, 100),
        orari,
        extra_cla,
      };
    }
    await db.query(
      `INSERT INTO impostazioni (chiave, valore, updated_at) VALUES ('squadre_cat_links',$1,NOW())
       ON CONFLICT (chiave) DO UPDATE SET valore=$1, updated_at=NOW()`,
      [JSON.stringify(safe)]
    );
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});

/* ─── Categorie Squadre ─── */
const SESSO_ESCLUDI = new Set(['Maschile', 'Femminile', 'Staff', '']);

app.get('/api/squadre-categorie', async (_req, res) => {
  try {
    const { rows } = await db.query(`SELECT DISTINCT sesso FROM squadra WHERE attiva=true AND sesso IS NOT NULL AND sesso!=''`);
    const valoriUnici = new Set();
    rows.forEach(r => {
      r.sesso.split(',').map(s => s.trim()).filter(s => s && !SESSO_ESCLUDI.has(s)).forEach(s => valoriUnici.add(s));
    });

    // Merge squadre extra (aggiunte manualmente)
    const extraRaw = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_extra'`);
    const extraTeams = JSON.parse(extraRaw.rows[0]?.valore || '[]');
    extraTeams.forEach(nome => { if (nome && !SESSO_ESCLUDI.has(nome)) valoriUnici.add(nome); });

    const mRaw = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_cat_mappa'`);
    const mapping = JSON.parse(mRaw.rows[0]?.valore || '{}');

    const campRaw = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_campionato_mappa'`);
    const campionatoMapping = JSON.parse(campRaw.rows[0]?.valore || '{}');

    const esclRaw = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_escluse'`);
    const escluse = new Set(JSON.parse(esclRaw.rows[0]?.valore || '[]'));

    const extraSet = new Set(extraTeams);
    const result = [...valoriUnici]
      .filter(nome => !escluse.has(nome))
      .sort()
      .map(nome => ({
        nome,
        categoria: mapping[nome] || '',
        campionato: campionatoMapping[nome] || '',
        custom: extraSet.has(nome),
      }));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.put('/api/admin/squadre-extra', adminAuth, async (req, res) => {
  try {
    const extra = Array.isArray(req.body) ? req.body.filter(s => typeof s === 'string' && s.trim().length > 0 && s.length <= 100) : [];
    await db.query(
      `INSERT INTO impostazioni (chiave, valore, updated_at) VALUES ('squadre_extra',$1,NOW())
       ON CONFLICT (chiave) DO UPDATE SET valore=$1, updated_at=NOW()`,
      [JSON.stringify(extra)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.get('/api/admin/squadre-escluse', adminAuth, async (_req, res) => {
  try {
    const r = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_escluse'`);
    res.json(JSON.parse(r.rows[0]?.valore || '[]'));
  } catch (err) { res.status(500).json({ error: 'Errore interno del server.' }); }
});

app.put('/api/admin/squadre-escluse', adminAuth, async (req, res) => {
  try {
    const escluse = Array.isArray(req.body) ? req.body.filter(s => typeof s === 'string' && s.trim().length > 0) : [];
    await db.query(
      `INSERT INTO impostazioni (chiave, valore, updated_at) VALUES ('squadre_escluse',$1,NOW())
       ON CONFLICT (chiave) DO UPDATE SET valore=$1, updated_at=NOW()`,
      [JSON.stringify(escluse)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.put('/api/admin/squadre-categorie', adminAuth, async (req, res) => {
  try {
    if (typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Oggetto richiesto' });
    }
    // Accept both legacy flat format and new wrapper { cat_mappa, campionato_mappa }
    const rawCat  = req.body.cat_mappa  && typeof req.body.cat_mappa  === 'object' ? req.body.cat_mappa  : req.body;
    const rawCamp = req.body.campionato_mappa && typeof req.body.campionato_mappa === 'object' ? req.body.campionato_mappa : null;

    const CAT_VALIDE  = new Set(['Seniores','Giovanili','']);
    const CAMP_VALIDE = new Set(['FIPAV','OPES','']);

    // Merge into existing map instead of overwriting
    const existingCatR = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_cat_mappa'`);
    let existingCat = {};
    try { existingCat = JSON.parse(existingCatR.rows[0]?.valore || '{}'); } catch {}
    const safe = { ...existingCat };
    for (const [nome, cat] of Object.entries(rawCat)) {
      if (String(nome).length > 100 || nome === 'cat_mappa' || nome === 'campionato_mappa') continue;
      safe[nome] = CAT_VALIDE.has(cat) ? cat : '';
    }
    await db.query(
      `INSERT INTO impostazioni (chiave, valore, updated_at) VALUES ('squadre_cat_mappa',$1,NOW())
       ON CONFLICT (chiave) DO UPDATE SET valore=$1, updated_at=NOW()`,
      [JSON.stringify(safe)]
    );

    if (rawCamp) {
      const existingCampR = await db.query(`SELECT valore FROM impostazioni WHERE chiave='squadre_campionato_mappa'`);
      let existingCamp = {};
      try { existingCamp = JSON.parse(existingCampR.rows[0]?.valore || '{}'); } catch {}
      const safeCamp = { ...existingCamp };
      for (const [nome, camp] of Object.entries(rawCamp)) {
        if (String(nome).length > 100) continue;
        safeCamp[nome] = CAMP_VALIDE.has(camp) ? camp : '';
      }
      await db.query(
        `INSERT INTO impostazioni (chiave, valore, updated_at) VALUES ('squadre_campionato_mappa',$1,NOW())
         ON CONFLICT (chiave) DO UPDATE SET valore=$1, updated_at=NOW()`,
        [JSON.stringify(safeCamp)]
      );
    }

    await logActivity('Categorie squadre aggiornate', Object.keys(safe).length + ' mappings');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
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
    const liveSet = req.body.youtube_live_url || req.body.spike_live_url;
    if (liveSet && liveSet.trim()) {
      sendPushByType('live', { titolo: '🔴 Virtus Caserta in diretta!', messaggio: 'Guarda la partita live ora.', url: '/live' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Log attività (admin) ─── */
app.get('/api/admin/log', adminAuth, async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM log_attivita ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
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
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
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
        'ricevuto':       'Ordine ricevuto',
        'in lavorazione': 'In lavorazione',
        'pronto':         'Pronto per il ritiro',
        'ritirato':       'Ritirato',
        'annullato':      'Annullato',
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
            ${stato === 'annullato' ? '<p>Per informazioni contatta <a href="mailto:virtuscaserta@gmail.com">virtuscaserta@gmail.com</a></p>' : ''}
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
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Ordini: cancellazione (admin) ─── */
app.post('/api/admin/ordini/:id/rimborso', adminAuth, async (req, res) => {
  try {
    const r = await db.query(`SELECT * FROM ordini WHERE id=$1 LIMIT 1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Ordine non trovato' });
    const ordine = r.rows[0];

    await db.query(`DELETE FROM ordini WHERE id=$1`, [ordine.id]);
    await logActivity('Ordine eliminato', `Ordine #${ordine.id}`);

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
            <div style="background:#fef9c3;border-left:4px solid #ca8a04;padding:16px;border-radius:4px;margin:16px 0;">
              <strong>ℹInformazioni</strong><br>
              <span style="font-size:13px;">Per qualsiasi chiarimento contattaci a <a href="mailto:virtuscaserta@gmail.com">virtuscaserta@gmail.com</a></span>
            </div>
            <p style="font-size:13px;color:#6b7280;">Forza Virtus!</p>
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
      }).catch(e => console.error('[Email cancellazione]', e.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Ordini: toggle mail_letta (admin) ─── */
app.put('/api/admin/ordini/:id/mail-letta', adminAuth, async (req, res) => {
  const { mail_letta } = req.body;
  if (typeof mail_letta !== 'boolean') return res.status(400).json({ error: 'mail_letta deve essere booleano' });
  try {
    await db.query(`UPDATE ordini SET mail_letta=$1 WHERE id=$2`, [mail_letta, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Ordini: svuota tutti ─── */
app.delete('/api/admin/ordini/all', adminAuth, async (_req, res) => {
  try {
    const r = await db.query('DELETE FROM ordini');
    await logActivity('Database ordini svuotato', `${r.rowCount} ordini eliminati`);
    res.json({ success: true, eliminati: r.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Invio email ordine ─── */
app.post('/api/send-order-email', paymentLimiter, async (req, res) => {
  let { nome, cognome, email, indirizzo, citta, cap, items, totale, spedizione, metodo, orderId } = req.body;

  // Sanitizzazione input (lunghezza massima)
  nome     = String(nome     || '').slice(0, 100);
  cognome  = String(cognome  || '').slice(0, 100);
  email    = String(email    || '').slice(0, 254);
  indirizzo= String(indirizzo|| '').slice(0, 200);
  citta    = String(citta    || '').slice(0, 100);
  cap      = String(cap      || '').slice(0, 10);
  metodo   = String(metodo   || '').slice(0, 20);

  if (!nome || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Dati obbligatori mancanti o non validi' });
  }

  // Salva ordine nel DB (non bloccante)
  try {
    const dbOrderId = orderId || crypto.randomUUID();
    await db.query(
      `INSERT INTO ordini (id, nome, cognome, email, indirizzo, citta, cap, items, totale, spedizione, metodo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [dbOrderId, nome, cognome, email, indirizzo, citta, cap,
       JSON.stringify(items || []), parseFloat(totale) || 0, parseFloat(spedizione) || 0, metodo]
    );
    if (!orderId) orderId = dbOrderId;
  } catch (dbErr) {
    console.log('[Ordini] Errore salvataggio DB:', dbErr.message);
  }

  if (!emailShopConfigurata()) {
    console.log('[Email] Credenziali mancanti – email non inviata');
    return res.json({ success: false, reason: 'Email non configurata' });
  }

  try {
    const transporter = creaTransporterShop();

    const righeHtml = (Array.isArray(items) ? items : []).map(i =>
      `<tr>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0">${esc(i.nome)}</td>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center">Taglia ${esc(i.taglia)}</td>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:center">${Number(i.qty)}</td>
         <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right">€ ${(i.prezzo * i.qty).toFixed(2)}</td>
       </tr>`
    ).join('');

    const metodiLabel = {
      carta:    '💳 Carta di credito/debito',
      paypal:   '🅿️ PayPal',
      bonifico: '🏦 Bonifico bancario',
      sepa:     '🏦 Addebito diretto SEPA',
    };

    // IBAN dinamico dalla tabella impostazioni
    let ibanDb = 'IT00 X000 0000 0000 0000 0000 000';
    try {
      const ibanRow = await db.query(`SELECT valore FROM impostazioni WHERE chiave='iban' LIMIT 1`);
      if (ibanRow.rows.length && ibanRow.rows[0].valore) ibanDb = ibanRow.rows[0].valore;
    } catch(_) {}

    const sepaHtml = metodo === 'sepa' ? `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-top:12px">
        <strong>✅ Addebito SEPA autorizzato</strong><br>
        <span style="font-size:13px;color:#374151;">L'addebito bancario è stato autorizzato e sarà completato entro 3–5 giorni lavorativi.</span>
      </div>` : '';

    const bonificoHtml = metodo === 'bonifico' ? `
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin-top:12px">
        <strong>Coordinate bancarie:</strong><br>
        Intestatario: Virtus Caserta ASD<br>
        IBAN: ${esc(ibanDb)}<br>
        Causale: Ordine ${esc(nome)} ${esc(cognome)}${orderId ? ' – ' + esc(orderId) : ''}
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
          <p>${metodiLabel[metodo] || esc(metodo)}</p>
          ${bonificoHtml}${sepaHtml}
          <p style="color:#9ca3af;font-size:13px;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px">
            Consegna prevista entro 3–5 giorni lavorativi.<br>
            Per assistenza scrivi a <a href="mailto:virtuscaserta@gmail.com" style="color:#1535a8">virtuscaserta@gmail.com</a>
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
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Richiesta acquisto senza pagamento online ─── */
app.post('/api/richiesta-ordine', ordineEmailLimiter, async (req, res) => {
  let { nome, cognome, email, telefono, note, items, totale } = req.body;
  nome     = String(nome     || '').slice(0, 100).trim();
  cognome  = String(cognome  || '').slice(0, 100).trim();
  email    = String(email    || '').slice(0, 254).trim();
  telefono = String(telefono || '').slice(0, 30).trim();
  note     = String(note     || '').slice(0, 500).trim();

  if (!nome || !cognome || !email || !telefono || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Dati obbligatori mancanti o non validi' });
  }
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Carrello vuoto' });
  }

  // Valida prezzi e disponibilità dal DB (non fidarsi del client)
  const ids = [...new Set(items.map(i => String(i.id)))];
  const placeholders = ids.map((_, idx) => `$${idx + 1}`).join(',');
  let prodMap = {};
  try {
    const { rows } = await db.query(
      `SELECT id, nome, prezzo, sconto, quantita FROM products WHERE id IN (${placeholders}) AND disponibile = true`,
      ids
    );
    for (const r of rows) prodMap[r.id] = {
      nome:     r.nome,
      prezzo:   parseFloat(r.prezzo),
      sconto:   parseInt(r.sconto) || 0,
      quantita: r.quantita !== null ? parseInt(r.quantita) : -1,
    };
  } catch (dbErr) {
    console.error('[Richiesta ordine] Errore lettura prodotti DB:', dbErr.message);
  }

  // Ricalcola totale dai prezzi reali; filtra prodotti non trovati o esauriti
  let totaleNum = 0;
  const itemsValidati = [];
  for (const item of items) {
    const prod = prodMap[String(item.id)];
    if (!prod) continue; // prodotto non trovato/non disponibile
    if (prod.quantita === 0) continue; // esaurito
    const qty = Math.min(10, Math.max(1, parseInt(item.qty) || 1));
    const prezzo = prod.sconto > 0 ? prod.prezzo * (1 - prod.sconto / 100) : prod.prezzo;
    totaleNum += prezzo * qty;
    itemsValidati.push({ ...item, nome: prod.nome, prezzo, qty });
  }
  if (!itemsValidati.length) {
    return res.status(400).json({ error: 'Nessun prodotto disponibile nel carrello' });
  }

  const ordineId = crypto.randomUUID();

  // Salva in DB (non bloccante)
  db.query(
    `INSERT INTO ordini (id, nome, cognome, email, items, totale, spedizione, metodo, stato)
     VALUES ($1,$2,$3,$4,$5,$6,0,'richiesta','ricevuto')`,
    [ordineId, nome, cognome, email, JSON.stringify(itemsValidati), totaleNum]
  ).catch(e => console.log('[Richiesta ordine] Errore DB:', e.message));

  if (!emailShopConfigurata()) {
    console.log('[Richiesta ordine] Brevo non configurato – email non inviata');
    return res.json({ success: true, ordineId });
  }

  const righe = itemsValidati.map(i =>
    `<tr>
       <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0">${esc(String(i.nome || ''))}</td>
       <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:center">${esc(String(i.taglia || 'UNICA'))}</td>
       <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:center">${Number(i.qty || 1)}</td>
       <td style="padding:10px 8px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700">€ ${(Number(i.prezzo) * Number(i.qty || 1)).toFixed(2)}</td>
     </tr>`
  ).join('');

  const tabellaHtml = `
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px">
      <thead>
        <tr style="background:#f1f5f9">
          <th style="padding:8px;text-align:left;color:#374151">Prodotto</th>
          <th style="padding:8px;text-align:center;color:#374151">Taglia</th>
          <th style="padding:8px;text-align:center;color:#374151">Qtà</th>
          <th style="padding:8px;text-align:right;color:#374151">Importo</th>
        </tr>
      </thead>
      <tbody>${righe}</tbody>
    </table>
    <p style="text-align:right;font-size:18px;font-weight:900;color:#0d2055;margin:12px 0 0">
      Totale: € ${totaleNum.toFixed(2)}
    </p>`;

  const noteHtml = note
    ? `<div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:14px 16px;margin-top:16px">
         <strong>📝 Note:</strong> ${esc(note)}
       </div>`
    : '';

  // Email al cliente
  const htmlCliente = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
      <div style="background:#0d2055;padding:28px 24px;text-align:center">
        <h1 style="color:#fff;font-size:22px;margin:0;letter-spacing:2px">VIRTUS CASERTA</h1>
        <p style="color:#ff9800;margin:6px 0 0;font-size:14px;letter-spacing:1px">RICHIESTA RICEVUTA ✓</p>
      </div>
      <div style="padding:32px 24px">
        <p style="font-size:16px">Ciao <strong>${esc(nome)}</strong>,</p>
        <p>Abbiamo ricevuto la tua richiesta d'acquisto <strong>#${esc(ordineId.slice(0,8).toUpperCase())}</strong>.<br>
        Ti contatteremo presto per confermare disponibilità e concordare il ritiro in sede.</p>
        <h3 style="color:#0d2055;border-bottom:2px solid #f57c00;padding-bottom:8px;margin-top:24px">Riepilogo ordine</h3>
        ${tabellaHtml}
        ${noteHtml}
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin-top:20px">
          <strong>📍 Ritiro e pagamento in sede</strong><br>
          <span style="font-size:13px;color:#374151">Il pagamento avviene in sede al momento del ritiro presso la <strong>Virtus Caserta ASD</strong>.</span>
        </div>
        <p style="color:#9ca3af;font-size:13px;margin-top:24px;border-top:1px solid #e2e8f0;padding-top:16px">
          Per info: <a href="mailto:virtuscaserta@gmail.com" style="color:#1535a8">virtuscaserta@gmail.com</a>
        </p>
      </div>
      <div style="background:#f8fafc;padding:14px;text-align:center;font-size:12px;color:#9ca3af">
        © 2026 Virtus Caserta – Società Sportiva Pallavolo
      </div>
    </div>`;

  // Email all'admin (virtuscaserta@gmail.com)
  const htmlAdmin = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
      <div style="background:#0d2055;padding:20px 24px;text-align:center">
        <h1 style="color:#fff;font-size:20px;margin:0">NUOVA RICHIESTA ORDINE</h1>
        <p style="color:#ff9800;margin:4px 0 0;font-size:13px">#${esc(ordineId.slice(0,8).toUpperCase())}</p>
      </div>
      <div style="padding:24px">
        <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:16px 20px;margin-bottom:20px">
          <p style="margin:0;font-size:15px;font-weight:700;color:#15803d">CLIENTE DA CONTATTARE</p>
          <p style="margin:8px 0 0;font-size:16px;font-weight:900;color:#111">${esc(nome)} ${esc(cognome)}</p>
          <p style="margin:4px 0 0;font-size:15px">Telefono: <a href="tel:${esc(telefono)}" style="color:#0d2055;font-weight:700">${esc(telefono)}</a></p>
          <p style="margin:4px 0 0;font-size:14px">Mail:<a href="mailto:${esc(email)}" style="color:#1535a8">${esc(email)}</a></p>
        </div>
        <h3 style="color:#0d2055;border-bottom:2px solid #f57c00;padding-bottom:8px">Prodotti richiesti</h3>
        ${tabellaHtml}
        ${noteHtml}
      </div>
    </div>`;

  try {
    const t = creaTransporterShop();
    await t.sendMail({
      from: shopFrom(),
      to: email,
      subject: `Richiesta ricevuta – Virtus Caserta #${ordineId.slice(0,8).toUpperCase()}`,
      html: htmlCliente,
    });
    await t.sendMail({
      from: shopFrom(),
      to: 'virtuscaserta@gmail.com',
      replyTo: email,
      subject: `Nuova richiesta ordine da ${esc(nome)} ${esc(cognome)} (#${ordineId.slice(0,8).toUpperCase()})`,
      html: htmlAdmin,
    });
    console.log(`[Richiesta ordine] Email inviate – cliente: ${email}, admin: virtuscaserta@gmail.com`);
  } catch (mailErr) {
    console.error('[Richiesta ordine] Errore email Brevo:', mailErr.message);
    // Non blocchiamo: ordine salvato in DB, risposta success comunque
  }

  res.json({ success: true, ordineId });
});


/* ─── FIPAV Partite ─── */
const FIPAV_CASERTA_BASE   = 'https://caserta.portalefipav.net';
const FIPAV_CAMPANIA_BASE  = 'https://www.fipavcampania.it';
const FIPAV_CASERTA_URL    = 'https://caserta.portalefipav.net/risultati-classifiche.aspx?ComitatoId=19&StId=2281&DataDa=&StatoGara=&CId=&SId=5150&PId=7261&btFiltro=CERCA';
const FIPAV_CAMPANIA_URL   = 'https://www.fipavcampania.it/risultati-classifiche.aspx?ComitatoId=15&StId=2277&DataDa=&StatoGara=&CId=&SId=5150&PId=1078&btFiltro=CERCA';

/* ─── Scheduler: fetch risultato FIPAV (1.5h, retry ogni 30min, stop a 3h) ─── */
const RESULT_FETCH_INITIAL_DELAY = 1.5 * 60 * 60 * 1000;  // 1h30
const RESULT_RETRY_INTERVAL      = 30  * 60 * 1000;        // 30min
const RESULT_MAX_WINDOW          = 3   * 60 * 60 * 1000;   // 3h dal kick-off
const pendingTimers = new Map();  // match_id → Timeout

// Converte riga DB in oggetto match usato dal frontend
function dbMatchToObj(row) {
  const ts = row.data_ora ? new Date(row.data_ora).getTime() : null;
  let dataOra = '';
  if (ts) {
    const fmt = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map(({ type, value }) => [type, value]));
    dataOra = `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
  }
  return {
    id: row.id, fonte: row.fonte, categoria: row.categoria,
    cid: row.cid || null, tid: row.tid || null, giornata: row.giornata || '',
    timestamp: ts, dataOra,
    casa: row.casa, ospite: row.ospite,
    risultato: row.risultato || '', played: row.played, postponed: row.postponed,
    parziali: row.parziali || null, luogo: row.luogo || '',
    logoHome: row.logo_home || '', logoAway: row.logo_away || '',
    matchUrl: row.match_url || '', classificaUrl: row.classifica_url || '',
    utenti_collegati: row.utenti_collegati || [],
  };
}

const HOME_LUOGO_KEYWORDS = ['tenda di abramo', 'tensostruttura', 'isis a. manzoni', 'palestra isis'];
function isHomeLuogo(luogo) {
  if (!luogo) return false;
  const l = luogo.toLowerCase();
  return HOME_LUOGO_KEYWORDS.some(k => l.includes(k));
}

// Upsert batch di match nel DB
async function saveMatchesToDB(matches) {
  if (!matches.length) return;
  for (const m of matches) {
    const luogoVal = m.luogo || '';
    await db.query(`
      INSERT INTO fipav_matches
        (id,fonte,categoria,cid,tid,giornata,data_ora,casa,ospite,
         risultato,played,postponed,parziali,luogo,logo_home,logo_away,
         match_url,classifica_url,result_fetched,is_casa,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        CASE WHEN $11 THEN true ELSE false END, $19, NOW())
      ON CONFLICT (id) DO UPDATE SET
        data_ora       = COALESCE(EXCLUDED.data_ora, fipav_matches.data_ora),
        risultato      = CASE WHEN EXCLUDED.played THEN EXCLUDED.risultato ELSE fipav_matches.risultato END,
        played         = EXCLUDED.played,
        postponed      = EXCLUDED.postponed,
        parziali       = COALESCE(EXCLUDED.parziali, fipav_matches.parziali),
        luogo          = COALESCE(NULLIF(EXCLUDED.luogo,''), fipav_matches.luogo),
        is_casa        = CASE WHEN EXCLUDED.luogo != '' THEN EXCLUDED.is_casa ELSE fipav_matches.is_casa END,
        logo_home      = COALESCE(NULLIF(EXCLUDED.logo_home,''), fipav_matches.logo_home),
        logo_away      = COALESCE(NULLIF(EXCLUDED.logo_away,''), fipav_matches.logo_away),
        classifica_url = COALESCE(NULLIF(EXCLUDED.classifica_url,''), fipav_matches.classifica_url),
        result_fetched = CASE WHEN EXCLUDED.played THEN true ELSE fipav_matches.result_fetched END,
        updated_at     = NOW()
    `, [
      m.id, m.fonte, m.categoria || '', m.cid || null, m.tid ? String(m.tid) : null,
      m.giornata || '',
      m.timestamp ? new Date(m.timestamp) : null,
      m.casa, m.ospite,
      m.risultato || '', m.played || false, m.postponed || false,
      m.parziali ? JSON.stringify(m.parziali) : null,
      luogoVal, m.logoHome || '', m.logoAway || '',
      m.matchUrl || '', m.classificaUrl || '',
      isHomeLuogo(luogoVal),
    ]);
  }
}

// Calcola classifica volley da array di match (regola 3/2/1/0 punti)
function calcolaClassificaFromMatches(matches) {
  const table = {};
  const ensure = (name) => {
    if (!table[name]) table[name] = { squadra: name, pg:0, pv:0, pp:0, punti:0, sf:0, ss:0 };
    return table[name];
  };
  for (const m of matches) {
    if (!m.played || m.postponed) continue;
    const parts = (m.risultato || '').match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (!parts) continue;
    const sh = parseInt(parts[1]), sa = parseInt(parts[2]);
    if (isNaN(sh) || isNaN(sa)) continue;
    const home = ensure(m.casa), away = ensure(m.ospite);
    home.pg++; away.pg++;
    home.sf += sh; home.ss += sa;
    away.sf += sa; away.ss += sh;
    const homeWon = sh > sa;
    const tight   = sh + sa === 5; // 3-2 o 2-3
    if (homeWon) {
      home.pv++; away.pp++;
      home.punti += tight ? 2 : 3;
      away.punti += tight ? 1 : 0;
    } else {
      away.pv++; home.pp++;
      away.punti += tight ? 2 : 3;
      home.punti += tight ? 1 : 0;
    }
  }
  return Object.values(table)
    .sort((a, b) => b.punti - a.punti || b.pv - a.pv || (b.sf - b.ss) - (a.sf - a.ss))
    .map((s, i) => ({
      pos: String(i + 1), squadra: s.squadra, logo: '',
      punti: String(s.punti), pg: String(s.pg), pv: String(s.pv), pp: String(s.pp),
      sf: String(s.sf), ss: String(s.ss),
      qs: s.ss > 0 ? (s.sf / s.ss).toFixed(3) : (s.sf > 0 ? '∞' : '-'),
      pf: '-', ps: '-', penal: '0',
    }));
}

// Ricalcola e salva classifica in cache DB
async function aggiornaCacheClassifica(cid, fonte, tid) {
  try {
    let rows, categoria;
    if (tid) {
      const r = await db.query('SELECT * FROM fipav_matches WHERE tid=$1', [String(tid)]);
      rows = r.rows; categoria = rows[0]?.categoria || String(tid);
      const squadre = calcolaClassificaFromMatches(rows.map(dbMatchToObj));
      await db.query(`
        INSERT INTO fipav_classifica_cache (categoria,fonte,cid,tid,squadre,updated_at)
        VALUES ($1,'opes',NULL,$2,$3,NOW())
        ON CONFLICT (tid) WHERE tid IS NOT NULL
        DO UPDATE SET squadre=EXCLUDED.squadre, categoria=EXCLUDED.categoria, updated_at=NOW()
      `, [categoria, String(tid), JSON.stringify(squadre)]);
    } else if (cid) {
      const r = await db.query('SELECT * FROM fipav_matches WHERE cid=$1 AND fonte=$2', [String(cid), fonte]);
      rows = r.rows; categoria = rows[0]?.categoria || String(cid);
      const squadre = calcolaClassificaFromMatches(rows.map(dbMatchToObj));
      await db.query(`
        INSERT INTO fipav_classifica_cache (categoria,fonte,cid,tid,squadre,updated_at)
        VALUES ($1,$2,$3,NULL,$4,NOW())
        ON CONFLICT (cid, fonte) WHERE cid IS NOT NULL
        DO UPDATE SET squadre=EXCLUDED.squadre, categoria=EXCLUDED.categoria, updated_at=NOW()
      `, [categoria, fonte, String(cid), JSON.stringify(squadre)]);
    }
  } catch (err) {
    console.log('[Classifica cache] Errore:', err.message);
  }
}

// Fetch risultato per una singola partita FIPAV; ritorna true se risultato trovato
async function fetchAndStoreMatchResult(match) {
  try {
    console.log(`[FIPAV Scheduler] Fetch risultato: ${match.casa} vs ${match.ospite} (${match.fonte})`);
    const url  = match.fonte === 'campania' ? FIPAV_CAMPANIA_URL : FIPAV_CASERTA_URL;
    const base = match.fonte === 'campania' ? FIPAV_CAMPANIA_BASE : FIPAV_CASERTA_BASE;
    const freshMatches = await fetchFipav(url, base, match.fonte);
    const found = freshMatches.some(m => m.id === match.id && m.played);
    await saveMatchesToDB(freshMatches);
    if (match.cid) await aggiornaCacheClassifica(match.cid, match.fonte, null);
    _fipavCache = null; _fipavCacheAt = 0;
    if (found) console.log(`[FIPAV Scheduler] Risultato salvato: ${match.casa} vs ${match.ospite}`);
    else console.log(`[FIPAV Scheduler] Risultato non ancora disponibile: ${match.casa} vs ${match.ospite}`);
    return found;
  } catch (err) {
    console.log(`[FIPAV Scheduler] Errore fetch ${match.id}:`, err.message);
    return false;
  }
}

// Registra primo timer FIPAV (1.5h dal kick-off); OPES ignorato (check settimanale)
function scheduleResultFetch(match) {
  if (!match.timestamp || match.played || match.postponed) return;
  if (match.fonte === 'opes') return;
  if (pendingTimers.has(match.id)) return;
  if (Date.now() > match.timestamp + RESULT_MAX_WINDOW) return; // finestra 3h scaduta
  const firstFire = Math.max(Date.now(), match.timestamp + RESULT_FETCH_INITIAL_DELAY);
  _scheduleFipavCheck(match, firstFire);
}

// Schedulazione interna con retry ogni 30min fino a 3h dal kick-off
function _scheduleFipavCheck(match, fireAt) {
  const deadline = match.timestamp + RESULT_MAX_WINDOW;
  const delay = Math.max(0, fireAt - Date.now());
  const timer = setTimeout(async () => {
    pendingTimers.delete(match.id);
    const found = await fetchAndStoreMatchResult(match);
    if (!found) {
      const nextFire = Date.now() + RESULT_RETRY_INTERVAL;
      if (nextFire <= deadline) {
        _scheduleFipavCheck(match, nextFire);
      } else {
        console.log(`[FIPAV Scheduler] ${match.casa} vs ${match.ospite} → finestra 3h scaduta, stop check`);
      }
    }
  }, Math.min(delay, 2_147_483_647));
  pendingTimers.set(match.id, timer);
  console.log(`[FIPAV Scheduler] ${match.casa} vs ${match.ospite} → check ${new Date(Date.now() + delay).toLocaleString('it')}`);
}

// Discovery giornaliero FIPAV (solo Caserta + Campania, OPES separato)
async function refreshFutureMatches() {
  console.log('[FIPAV Scheduler] Refresh giornaliero partite FIPAV...');
  try {
    const [caserta, campania] = await Promise.allSettled([
      fetchFipav(FIPAV_CASERTA_URL,  FIPAV_CASERTA_BASE,  'caserta'),
      fetchFipav(FIPAV_CAMPANIA_URL, FIPAV_CAMPANIA_BASE, 'campania'),
    ]);
    let all = [];
    if (caserta.status  === 'fulfilled') all = all.concat(caserta.value);
    if (campania.status === 'fulfilled') all = all.concat(campania.value);
    await saveMatchesToDB(all);
    const cidsMap = new Map();
    for (const m of all) { if (m.cid) cidsMap.set(`${m.cid}|${m.fonte}`, { cid: m.cid, fonte: m.fonte }); }
    for (const { cid, fonte } of cidsMap.values()) await aggiornaCacheClassifica(cid, fonte, null);
    const future = all.filter(m => !m.played && !m.postponed && m.timestamp && m.timestamp > Date.now());
    for (const m of future) scheduleResultFetch(m);
    _fipavCache = null; _fipavCacheAt = 0;
    console.log(`[FIPAV Scheduler] Refresh FIPAV: ${all.length} partite, ${future.length} future, ${pendingTimers.size} timer attivi`);
  } catch (err) {
    console.log('[FIPAV Scheduler] Errore refresh FIPAV:', err.message);
  }
}

// Refresh settimanale OPES (ogni lunedì alle 9)
async function refreshOpesMatches() {
  console.log('[OPES Scheduler] Refresh settimanale OPES...');
  try {
    opesCache = null; // Bypass cache in-memory, forza re-fetch
    const opes = await fetchOpesAll();
    await saveMatchesToDB(opes);
    const tidsSet = new Set(opes.filter(m => m.tid).map(m => String(m.tid)));
    for (const tid of tidsSet) await aggiornaCacheClassifica(null, null, tid);
    _fipavCache = null; _fipavCacheAt = 0;
    console.log(`[OPES Scheduler] Refresh: ${opes.length} partite OPES`);
  } catch (err) {
    console.log('[OPES Scheduler] Errore refresh:', err.message);
  }
}

// Schedulazione ricorrente OPES: ogni lunedì alle 09:00
function scheduleOpesWeekly() {
  const now = new Date();
  const next = new Date(now);
  let daysUntilMonday = (1 - now.getDay() + 7) % 7;
  // Se oggi è lunedì e le 9 non sono ancora passate → oggi stesso; altrimenti prossimo lunedì
  if (daysUntilMonday === 0 && now.getHours() >= 9) daysUntilMonday = 7;
  next.setDate(now.getDate() + daysUntilMonday);
  next.setHours(9, 0, 0, 0);
  const delay = next.getTime() - Date.now();
  setTimeout(async () => {
    await refreshOpesMatches();
    scheduleOpesWeekly();
  }, delay);
  console.log(`[OPES Scheduler] Prossimo check lunedì: ${next.toLocaleString('it')}`);
}

function scheduleDailyRefresh() {
  const now = new Date();
  // Schedule both 09:00 and 14:00 checks; pick the next upcoming one
  const targets = [9, 14].map(h => {
    const t = new Date(now);
    t.setHours(h, 0, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t;
  });
  const next = targets.reduce((a, b) => a < b ? a : b);
  const delay = next.getTime() - Date.now();
  setTimeout(async () => {
    console.log(`[FIPAV Scheduler] Check giornaliero spostamenti partite (${next.getHours()}:00)`);
    await refreshFutureMatches();
    scheduleDailyRefresh();
  }, delay);
  console.log(`[FIPAV Scheduler] Prossimo check spostamenti: ${next.toLocaleString('it')}`);
}

// Boot: carica match FIPAV da DB, registra timer, avvia refresh giornaliero FIPAV + settimanale OPES
async function initFipavScheduler() {
  try {
    const r = await db.query(`
      SELECT * FROM fipav_matches
      WHERE NOT played AND NOT postponed AND data_ora IS NOT NULL
        AND fonte != 'opes'
        AND data_ora > NOW() - INTERVAL '3 hours'
    `);
    let scheduled = 0;
    for (const row of r.rows) {
      scheduleResultFetch(dbMatchToObj(row));
      scheduled++;
    }
    console.log(`[FIPAV Scheduler] Boot: ${scheduled} partite FIPAV caricate da DB`);
    await refreshFutureMatches();
    scheduleDailyRefresh();
    // OPES: refresh immediato al boot + settimanale lunedì alle 9
    await refreshOpesMatches();
    scheduleOpesWeekly();
  } catch (err) {
    console.log('[FIPAV Scheduler] Errore boot:', err.message);
    setTimeout(refreshFutureMatches, 60_000);
    scheduleDailyRefresh();
  }
}

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
    // FIPAV dates are in Europe/Rome time (CET +01:00 / CEST +02:00).
    // Must specify offset explicitly so Railway (UTC) parses correctly.
    const dm = dataOra.match(/(\d{2})\/(\d{2})\/(\d{2,4})\s+(\d{2}):(\d{2})/);
    let timestamp = null;
    let dateFormatted = dataOra.trim();
    if (dm) {
      const [, dd, mm, yy, hh, min] = dm;
      const year = yy.length === 4 ? yy : `20${yy}`;
      const y = parseInt(year), mo = parseInt(mm), d = parseInt(dd);
      const lastSunMar = 31 - new Date(y, 2, 31).getDay();
      const lastSunOct = 31 - new Date(y, 9, 31).getDay();
      const isDST = (mo > 3 && mo < 10) || (mo === 3 && d >= lastSunMar) || (mo === 10 && d < lastSunOct);
      timestamp = new Date(`${year}-${mm}-${dd}T${hh}:${min}:00${isDST ? '+02:00' : '+01:00'}`).getTime();
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

// Legge partite da DB; fallback a scraping in-memory solo se DB vuoto
async function getMatchesFromDB() {
  try {
    const r = await db.query('SELECT * FROM fipav_matches ORDER BY data_ora DESC NULLS LAST');
    if (r.rows.length === 0) return fetchFipavAll();
    return r.rows.map(dbMatchToObj);
  } catch (err) {
    console.log('[DB] getMatchesFromDB fallback scraping:', err.message);
    return fetchFipavAll();
  }
}

app.get('/api/partite', async (_req, res) => {
  try {
    const all  = await getMatchesFromDB();
    const now  = Date.now();
    const past = all.filter(m => m.played);
    const live = all.filter(m => !m.played && !m.postponed && m.timestamp && m.timestamp < now && m.timestamp + 7_200_000 > now);
    const future = all.filter(m => !m.played && !m.postponed && m.timestamp !== null && m.timestamp > now - 7_200_000)
                      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    res.json({ ultime: past.slice(0, 3), live, prossime: future.slice(0, 6), fipavUrl: FIPAV_CASERTA_URL });
  } catch (err) {
    console.error('[Partite] Errore:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.get('/api/partite/tutte', async (_req, res) => {
  try {
    const all    = await getMatchesFromDB();
    const gruppi = {};
    all.forEach(m => {
      const cat = m.categoria || 'Altre partite';
      if (!gruppi[cat]) gruppi[cat] = { classificaUrl: m.classificaUrl, cid: m.cid, fonte: m.fonte, tid: m.tid || null, partite: [] };
      gruppi[cat].partite.push(m);
    });
    res.json({ gruppi, fipavUrl: FIPAV_CASERTA_URL });
  } catch (err) {
    console.error('[Partite/tutte] Errore:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Staff arbitrale ─── */
app.get('/api/admin/staff-arbitrale', adminAuth, async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM staff_arbitrale ORDER BY cognome, nome');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
});

app.post('/api/admin/staff-arbitrale', adminAuth, async (req, res) => {
  const { utente_id, nome, cognome, ruolo } = req.body;
  if (!nome || !cognome) return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  const ruoloVal = ['addetto','refertista','entrambi'].includes(ruolo) ? ruolo : 'entrambi';
  try {
    const id = crypto.randomUUID();
    const r = await db.query(
      `INSERT INTO staff_arbitrale (id, utente_id, nome, cognome, ruolo) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, utente_id || '', nome.trim(), cognome.trim(), ruoloVal]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
});

app.delete('/api/admin/staff-arbitrale/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM staff_arbitrale WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
});

/* ─── Partite in casa (admin) ─── */
app.get('/api/admin/partite/casa', adminAuth, async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT f.id, f.categoria, f.giornata, f.data_ora, f.casa, f.ospite, f.luogo,
              f.addetto_arbitro, f.refertista, f.is_casa, f.addetto_staff_id, f.refertista_staff_id,
              a1.stato AS addetto_stato, a2.stato AS refertista_stato
       FROM fipav_matches f
       LEFT JOIN assegnazioni_partita a1 ON a1.partita_id=f.id AND a1.ruolo='addetto'
       LEFT JOIN assegnazioni_partita a2 ON a2.partita_id=f.id AND a2.ruolo='refertista'
       WHERE f.is_casa = true AND f.played=false AND f.postponed=false AND f.data_ora >= NOW()
       ORDER BY f.data_ora`
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.get('/api/admin/partite/future', adminAuth, async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT id, categoria, giornata, data_ora, casa, ospite, luogo, is_casa, utenti_collegati
       FROM fipav_matches
       WHERE played=false AND postponed=false AND data_ora >= NOW()
       ORDER BY data_ora`
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.put('/api/admin/partite/:id/is-casa', adminAuth, async (req, res) => {
  const { is_casa } = req.body;
  try {
    const r = await db.query(
      `UPDATE fipav_matches SET is_casa=$1 WHERE id=$2 RETURNING id`,
      [!!is_casa, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Partita non trovata' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.get('/api/admin/partite/casa-settimana', adminAuth, async (_req, res) => {
  try {
    const now = new Date();
    const dow = now.getDay();
    const mon = new Date(now);
    mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
    mon.setHours(0, 0, 0, 0);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    sun.setHours(23, 59, 59, 999);
    const r = await db.query(
      `SELECT id, categoria, giornata, data_ora, casa, ospite, luogo, addetto_arbitro, refertista
       FROM fipav_matches
       WHERE is_casa = true AND data_ora >= $1 AND data_ora <= $2
       ORDER BY data_ora`,
      [mon.toISOString(), sun.toISOString()]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.put('/api/admin/partite/:id/staff-arbitrale', adminAuth, async (req, res) => {
  const { addetto_staff_id, refertista_staff_id } = req.body;
  const partitaId = req.params.id;
  try {
    const pRes = await db.query('SELECT casa, ospite, data_ora, categoria FROM fipav_matches WHERE id=$1', [partitaId]);
    if (!pRes.rows.length) return res.status(404).json({ error: 'Partita non trovata' });
    const partita = pRes.rows[0];

    async function processRuolo(staffId, ruolo) {
      if (!staffId) {
        await db.query('DELETE FROM assegnazioni_partita WHERE partita_id=$1 AND ruolo=$2', [partitaId, ruolo]);
        return '';
      }
      const sRes = await db.query('SELECT * FROM staff_arbitrale WHERE id=$1', [staffId]);
      if (!sRes.rows.length) return '';
      const staff = sRes.rows[0];
      const nomeDisplay = `${staff.cognome} ${staff.nome}`;
      if (staff.utente_id) {
        const assegId = crypto.randomUUID();
        await db.query(`
          INSERT INTO assegnazioni_partita (id, partita_id, utente_id, ruolo, stato)
          VALUES ($1,$2,$3,$4,'attesa')
          ON CONFLICT (partita_id, ruolo) DO UPDATE SET utente_id=$3, stato='attesa'
        `, [assegId, partitaId, staff.utente_id, ruolo]);
        const uRes = await db.query('SELECT nome, cognome, email FROM utenti WHERE id=$1', [staff.utente_id]);
        if (uRes.rows.length && uRes.rows[0].email) {
          const u = uRes.rows[0];
          const dt = partita.data_ora ? new Date(partita.data_ora) : null;
          const dataFmt = dt ? dt.toLocaleDateString('it-IT', { weekday:'long', day:'numeric', month:'long', year:'numeric' }) : '—';
          const oraFmt  = dt ? dt.toLocaleTimeString('it-IT', { hour:'2-digit', minute:'2-digit' }) : '';
          const ruoloLabel = ruolo === 'addetto' ? "Addetto all'arbitro" : 'Refertista';
          const base = process.env.BASE_URL || 'https://www.virtuscaserta.com';
          const emailHtml = `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
              <div style="background:#0d2055;padding:24px;text-align:center">
                <h1 style="color:#fff;font-size:20px;margin:0;letter-spacing:2px">VIRTUS CASERTA</h1>
                <p style="color:#93c5fd;margin:6px 0 0;font-size:13px">RICHIESTA STAFF ARBITRALE</p>
              </div>
              <div style="padding:28px 24px">
                <p style="font-size:15px;">Ciao <strong>${esc(u.nome)}</strong>,</p>
                <p style="font-size:15px;">sei stato selezionato come <strong>${esc(ruoloLabel)}</strong> per la seguente partita:</p>
                <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;margin:20px 0;">
                  <p style="margin:0 0 6px;font-size:16px;font-weight:700;">${esc(partita.casa)} vs ${esc(partita.ospite)}</p>
                  <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">${esc(partita.categoria||'')} · ${dataFmt}${oraFmt?' · '+oraFmt:''}</p>
                </div>
                <p style="font-size:14px;color:#374151;">Accedi al tuo profilo per confermare o rifiutare la disponibilità:</p>
                <div style="text-align:center;margin:24px 0;">
                  <a href="${base}/utente.html" style="display:inline-block;background:#0d2055;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:700;">Rispondi ora</a>
                </div>
              </div>
              <div style="background:#f8fafc;padding:14px;text-align:center;font-size:12px;color:#9ca3af">© 2026 Virtus Caserta</div>
            </div>`;
          const subject = `Richiesta staff arbitrale: ${partita.casa} vs ${partita.ospite} | Virtus Caserta`;
          if (brevoApiConfigurato()) {
            sendBrevoEmail({ to: u.email, subject, html: emailHtml }).catch(e => console.error('[Staff email]', e.message));
          } else if (brevoConfigurato()) {
            creaTransporterShop().sendMail({ from: shopFrom(), to: u.email, subject, html: emailHtml }).catch(e => console.error('[Staff SMTP]', e.message));
          }
        }
      }
      return nomeDisplay;
    }

    const [addettoNome, refertistaNome] = await Promise.all([
      processRuolo(addetto_staff_id, 'addetto'),
      processRuolo(refertista_staff_id, 'refertista'),
    ]);

    await db.query(
      `UPDATE fipav_matches SET addetto_arbitro=$1, addetto_staff_id=$2, refertista=$3, refertista_staff_id=$4 WHERE id=$5`,
      [addettoNome, addetto_staff_id || '', refertistaNome, refertista_staff_id || '', partitaId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Partite: collega/scollega utenti ─── */
app.post('/api/admin/partite/:id/collega-utente', adminAuth, async (req, res) => {
  const { utente_id } = req.body;
  if (!utente_id) return res.status(400).json({ error: 'utente_id obbligatorio' });
  try {
    const r = await db.query(
      `UPDATE fipav_matches SET utenti_collegati = CASE WHEN utenti_collegati @> $1::jsonb THEN utenti_collegati ELSE utenti_collegati || $1::jsonb END WHERE id=$2 RETURNING id`,
      [JSON.stringify([String(utente_id)]), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Partita non trovata' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.delete('/api/admin/partite/:id/collega-utente/:uid', adminAuth, async (req, res) => {
  try {
    await db.query(
      `UPDATE fipav_matches SET utenti_collegati = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(utenti_collegati) AS x WHERE x != $1), '[]'::jsonb) WHERE id=$2`,
      [req.params.uid, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

app.get('/api/admin/partite/:id/utenti-collegati', adminAuth, async (req, res) => {
  try {
    const p = await db.query('SELECT utenti_collegati FROM fipav_matches WHERE id=$1', [req.params.id]);
    if (!p.rows.length) return res.status(404).json({ error: 'Partita non trovata' });
    const ids = (p.rows[0].utenti_collegati || []).map(String);
    if (!ids.length) return res.json([]);
    const u = await db.query(`SELECT id,nome,cognome,email FROM utenti WHERE id = ANY($1::text[])`, [ids]);
    res.json(u.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Staff arbitrale: API utente ─── */
app.get('/api/utente/staff-arbitrale', userAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.ruolo, a.stato, a.created_at,
              f.id AS partita_id, f.casa, f.ospite, f.data_ora, f.categoria, f.luogo
       FROM assegnazioni_partita a
       JOIN fipav_matches f ON f.id = a.partita_id
       WHERE a.utente_id = $1
       ORDER BY f.data_ora`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno.' });
  }
});

app.put('/api/utente/staff-arbitrale/:id/risposta', userAuth, async (req, res) => {
  const { stato } = req.body;
  if (!['confermato', 'rifiutato'].includes(stato)) return res.status(400).json({ error: 'Stato non valido' });
  try {
    const r = await db.query(
      `UPDATE assegnazioni_partita SET stato=$1 WHERE id=$2 AND utente_id=$3 RETURNING id`,
      [stato, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Assegnazione non trovata' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore interno.' });
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

// Se DB ha 0 match per questa categoria, fetch on-demand la pagina risultati e salva
async function ensureFipavMatchesLoaded(cid, fonte) {
  const r = await db.query('SELECT 1 FROM fipav_matches WHERE cid=$1 AND fonte=$2 LIMIT 1', [String(cid), fonte]);
  if (r.rows.length > 0) return; // già popolato
  console.log(`[Classifica] DB vuoto per cid=${cid} fonte=${fonte}, fetch on-demand...`);
  const url  = fonte === 'campania' ? FIPAV_CAMPANIA_URL : FIPAV_CASERTA_URL;
  const base = fonte === 'campania' ? FIPAV_CAMPANIA_BASE : FIPAV_CASERTA_BASE;
  const matches = await fetchFipav(url, base, fonte);
  await saveMatchesToDB(matches);
  // Schedula timer per partite future appena scoperte
  for (const m of matches.filter(m2 => !m2.played && !m2.postponed && m2.timestamp && m2.timestamp > Date.now())) {
    scheduleResultFetch(m);
  }
}

async function ensureOpesMatchesLoaded(tid) {
  const r = await db.query('SELECT 1 FROM fipav_matches WHERE tid=$1 LIMIT 1', [String(tid)]);
  if (r.rows.length > 0) return;
  console.log(`[Classifica OPES] DB vuoto per tid=${tid}, fetch on-demand...`);
  const matches = await fetchOpesAll();
  await saveMatchesToDB(matches);
}

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
    res.json({ titolo: tourney.categoria, squadre, url: `${OPES_BASE}/it/t-teamtable/${tid}/` });
  } catch (err) {
    console.error('[Classifica OPES] Errore:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

app.get('/api/classifica/:cid', async (req, res) => {
  const { cid } = req.params;
  if (!/^\d+$/.test(cid)) return res.status(400).json({ error: 'CId non valido' });
  const fonte = req.query.fonte === 'campania' ? 'campania' : 'caserta';
  const base  = fonte === 'campania' ? FIPAV_CAMPANIA_BASE : FIPAV_CASERTA_BASE;
  try {
    const r = await fetch(`${base}/classifica.aspx?CId=${cid}`, { headers: { ...FIPAV_HEADERS, Referer: `${base}/` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();

    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const titolo = titleMatch ? stripTagsFipav(titleMatch[1]).trim() : '';

    const squadre = [];
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
          pos: tds[0].trim(), squadra: tds[1].trim(), logo,
          punti: tds[2]?.trim()  || '0', pg:    tds[3]?.trim()  || '0',
          pv:   tds[4]?.trim()   || '0', pp:    tds[5]?.trim()  || '0',
          sf:   tds[6]?.trim()   || '0', ss:    tds[7]?.trim()  || '0',
          qs:   tds[8]?.trim()   || '0', pf:    tds[9]?.trim()  || '0',
          ps:   tds[10]?.trim()  || '0', penal: tds[12]?.trim() || '0',
        });
      }
    }
    res.json({ titolo, cid, fonte, squadre, url: `${base}/classifica.aspx?CId=${cid}` });
  } catch (err) {
    console.error('[Classifica] Errore:', err);
    res.status(500).json({ error: 'Errore interno del server.' });
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
    console.error(err);
    res.status(500).json({ error: 'Errore interno del server.' });
  }
});

/* ─── Squadra ─── */
app.get('/api/squadra', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM squadra WHERE attiva=true ORDER BY numero ASC NULLS LAST, cognome');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.post('/api/admin/squadra', adminAuth, async (req, res) => {
  const { nome, cognome, numero, ruolo, foto, bio, sesso, utente_id } = req.body;
  if (!nome || !cognome) return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  const id = crypto.randomUUID();
  const COACH_ROLES_SRV = ['Allenatore', 'Vice Allenatore', 'Primo allenatore', 'Secondo allenatore', 'Assistente'];
  try {
    await db.query(`INSERT INTO squadra (id,nome,cognome,numero,ruolo,foto,bio,sesso,utente_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, nome, cognome, numero || null, ruolo || '', foto || '', bio || '', sesso || 'Femminile', utente_id || '']);

    if (utente_id) {
      const linked = await db.query(
        `SELECT ruolo, sesso FROM squadra WHERE utente_id=$1 AND (sesso IS NULL OR sesso != 'Staff')`,
        [utente_id]
      );
      const sqAtleta = [], sqAllen = [];
      for (const g of linked.rows) {
        const teams = (g.sesso || '').split(',').map(s => s.trim()).filter(Boolean);
        if (COACH_ROLES_SRV.includes(g.ruolo)) { teams.forEach(t => { if (!sqAllen.includes(t)) sqAllen.push(t); }); }
        else { teams.forEach(t => { if (!sqAtleta.includes(t)) sqAtleta.push(t); }); }
      }
      await db.query(
        `UPDATE utenti SET is_atleta=($1::int > 0), is_allenatore=($2::int > 0), squadre_atleta=$3, squadre_allenatore=$4 WHERE id=$5`,
        [sqAtleta.length, sqAllen.length, JSON.stringify(sqAtleta), JSON.stringify(sqAllen), utente_id]
      );
    }

    await logActivity('Giocatrice aggiunta', `${nome} ${cognome}`);
    res.status(201).json({ id, nome, cognome, numero, ruolo, foto, bio, sesso, utente_id: utente_id || '' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.put('/api/admin/squadra/:id', adminAuth, async (req, res) => {
  const { nome, cognome, numero, ruolo, foto, bio, attiva, sesso, utente_id } = req.body;
  try {
    const prev = await db.query('SELECT utente_id FROM squadra WHERE id=$1', [req.params.id]);
    const r = await db.query(
      `UPDATE squadra SET nome=$1,cognome=$2,numero=$3,ruolo=$4,foto=$5,bio=$6,attiva=$7,sesso=$8,utente_id=$9 WHERE id=$10 RETURNING *`,
      [nome, cognome, numero || null, ruolo || '', foto || '', bio || '', attiva !== false, sesso || 'Femminile', utente_id || '', req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Giocatrice non trovata' });

    // Sync utente squadre when utente_id is set or changed
    const newUid = utente_id || '';
    const oldUid = prev.rows[0]?.utente_id || '';
    const affectedUids = new Set([newUid, oldUid].filter(Boolean));
    const COACH_ROLES_SRV = ['Allenatore', 'Vice Allenatore', 'Primo allenatore', 'Secondo allenatore', 'Assistente'];
    for (const uid of affectedUids) {
      const linked = await db.query(
        `SELECT ruolo, sesso FROM squadra WHERE utente_id=$1 AND (sesso IS NULL OR sesso != 'Staff')`,
        [uid]
      );
      const sqAtleta = [], sqAllen = [];
      for (const g of linked.rows) {
        const teams = (g.sesso || '').split(',').map(s => s.trim()).filter(Boolean);
        if (COACH_ROLES_SRV.includes(g.ruolo)) { teams.forEach(t => { if (!sqAllen.includes(t)) sqAllen.push(t); }); }
        else { teams.forEach(t => { if (!sqAtleta.includes(t)) sqAtleta.push(t); }); }
      }
      await db.query(
        `UPDATE utenti SET is_atleta=($1::int > 0), is_allenatore=($2::int > 0), squadre_atleta=$3, squadre_allenatore=$4 WHERE id=$5`,
        [sqAtleta.length, sqAllen.length, JSON.stringify(sqAtleta), JSON.stringify(sqAllen), uid]
      );
    }

    await logActivity('Giocatrice modificata', `${nome} ${cognome}`);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.delete('/api/admin/squadra/:id', adminAuth, async (req, res) => {
  const COACH_ROLES_SRV = ['Allenatore', 'Vice Allenatore', 'Primo allenatore', 'Secondo allenatore', 'Assistente'];
  try {
    const prev = await db.query('SELECT nome, cognome, utente_id FROM squadra WHERE id=$1', [req.params.id]);
    if (!prev.rows.length) return res.status(404).json({ error: 'Non trovata' });
    const { nome, cognome, utente_id: uid } = prev.rows[0];
    await db.query('DELETE FROM squadra WHERE id=$1', [req.params.id]);
    if (uid) {
      const linked = await db.query(
        `SELECT ruolo, sesso FROM squadra WHERE utente_id=$1 AND (sesso IS NULL OR sesso != 'Staff')`,
        [uid]
      );
      const sqAtleta = [], sqAllen = [];
      for (const g of linked.rows) {
        const teams = (g.sesso || '').split(',').map(s => s.trim()).filter(Boolean);
        if (COACH_ROLES_SRV.includes(g.ruolo)) { teams.forEach(t => { if (!sqAllen.includes(t)) sqAllen.push(t); }); }
        else { teams.forEach(t => { if (!sqAtleta.includes(t)) sqAtleta.push(t); }); }
      }
      await db.query(
        `UPDATE utenti SET is_atleta=($1::int > 0), is_allenatore=($2::int > 0), squadre_atleta=$3, squadre_allenatore=$4 WHERE id=$5`,
        [sqAtleta.length, sqAllen.length, JSON.stringify(sqAtleta), JSON.stringify(sqAllen), uid]
      );
    }
    await logActivity('Giocatrice eliminata', `${nome} ${cognome}`);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});

/* ─── Allenatore: atleti squadra ─── */
app.get('/api/squadra/atleti', userAuth, async (req, res) => {
  try {
    const u = await db.query('SELECT is_allenatore, squadre_allenatore FROM utenti WHERE id=$1', [req.user.id]);
    if (!u.rows.length || !u.rows[0].is_allenatore) return res.status(403).json({ error: 'Accesso non autorizzato' });
    const squadre = u.rows[0].squadre_allenatore || [];
    if (!squadre.length) return res.json([]);
    const r = await db.query(
      `SELECT * FROM squadra WHERE attiva=true AND EXISTS (SELECT 1 FROM unnest(string_to_array(sesso, ',')) AS cat WHERE trim(cat) = ANY($1::text[])) ORDER BY cognome, nome`,
      [squadre]
    );
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Allenatore: ultima sessione presenze (stats) ─── */
app.get('/api/squadra/presenze/ultima', userAuth, async (req, res) => {
  try {
    const u = await db.query('SELECT is_allenatore, squadre_allenatore FROM utenti WHERE id=$1', [req.user.id]);
    if (!u.rows.length || !u.rows[0].is_allenatore) return res.status(403).json({ error: 'Accesso non autorizzato' });
    const squadre = u.rows[0].squadre_allenatore || [];
    if (!squadre.length) return res.json(null);

    const today = new Date().toISOString().split('T')[0];
    const sessR = await db.query(`
      SELECT id, titolo, data_str, categoria, categorie_collegate
      FROM calendario
      WHERE tipo = 'allenamento' AND data_str <= $1
        AND (
          EXISTS (SELECT 1 FROM unnest(string_to_array(categoria, ',')) AS cat WHERE trim(cat) = ANY($2::text[]))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(categorie_collegate,'[]'::jsonb)) AS cat WHERE cat = ANY($2::text[]))
        )
      ORDER BY data_str DESC, ora DESC
      LIMIT 1
    `, [today, squadre]);
    if (!sessR.rows.length) return res.json(null);
    const sess = sessR.rows[0];

    const categorieSplit = (sess.categoria || '').split(',').map(c => c.trim()).filter(Boolean);
    const tutteCategorie = [...new Set([...categorieSplit, ...(sess.categorie_collegate || [])])].filter(Boolean);
    const catFiltrate = tutteCategorie.filter(c => squadre.includes(c));
    if (!catFiltrate.length) return res.json(null);

    const playersR = await db.query(
      `SELECT id, utente_id FROM squadra WHERE attiva=true AND EXISTS (SELECT 1 FROM unnest(string_to_array(sesso, ',')) AS cat WHERE trim(cat) = ANY($1::text[]))`,
      [catFiltrate]
    );
    const players = playersR.rows;
    const allKeys = players.map(p => p.utente_id || ('g:' + p.id));

    const partR = await db.query(
      'SELECT utente_id, risposta FROM partecipazioni WHERE sessione_id=$1 AND utente_id = ANY($2::text[])',
      [sess.id, allKeys]
    );
    const partMap = {};
    partR.rows.forEach(p => { partMap[p.utente_id] = p.risposta; });

    let presenti = 0, assenti = 0;
    for (const player of players) {
      const key = player.utente_id || ('g:' + player.id);
      const risposta = partMap[key];
      if (!risposta || risposta === 'si') presenti++;
      else if (risposta === 'no') assenti++;
    }
    res.json({ id: sess.id, evento: sess.titolo + ' · ' + sess.data_str, presenti, assenti });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Allenatore: lista sessioni allenamento ─── */
app.get('/api/allenatore/sessioni', userAuth, async (req, res) => {
  try {
    const u = await db.query('SELECT is_allenatore, squadre_allenatore FROM utenti WHERE id=$1', [req.user.id]);
    if (!u.rows.length || !u.rows[0].is_allenatore) return res.status(403).json({ error: 'Accesso non autorizzato' });
    const squadre = u.rows[0].squadre_allenatore || [];
    if (!squadre.length) return res.json([]);

    const r = await db.query(`
      SELECT c.id, c.titolo, c.data_str, c.ora, c.categoria
      FROM calendario c
      WHERE c.tipo = 'allenamento'
        AND (
          EXISTS (SELECT 1 FROM unnest(string_to_array(c.categoria, ',')) AS cat WHERE trim(cat) = ANY($1::text[]))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(c.categorie_collegate,'[]'::jsonb)) AS cat WHERE cat = ANY($1::text[]))
        )
      ORDER BY c.data_str DESC, c.ora DESC
      LIMIT 30
    `, [squadre]);
    res.json(r.rows.map(x => ({ id: x.id, titolo: x.titolo, data: x.data_str, ora: x.ora })));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Allenatore: presenze singola sessione ─── */
app.get('/api/allenatore/sessioni/:id/presenze', userAuth, async (req, res) => {
  try {
    const u = await db.query('SELECT is_allenatore, squadre_allenatore FROM utenti WHERE id=$1', [req.user.id]);
    if (!u.rows.length || !u.rows[0].is_allenatore) return res.status(403).json({ error: 'Accesso non autorizzato' });
    const squadre = u.rows[0].squadre_allenatore || [];

    const sessR = await db.query('SELECT id,titolo,data_str,ora,categoria,categorie_collegate FROM calendario WHERE id=$1', [req.params.id]);
    if (!sessR.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    const sess = sessR.rows[0];

    const categorieSplit = (sess.categoria || '').split(',').map(c => c.trim()).filter(Boolean);
    const tutteCategorie = [...new Set([...categorieSplit, ...(sess.categorie_collegate || [])])].filter(Boolean);
    const catFiltrate = tutteCategorie.filter(c => squadre.includes(c));
    if (!catFiltrate.length) return res.json({ sessione: { id: sess.id, titolo: sess.titolo, data: sess.data_str, ora: sess.ora }, giocatori: [] });

    const playersR = await db.query(
      `SELECT id, nome, cognome, ruolo, utente_id, sesso FROM squadra WHERE attiva=true AND EXISTS (SELECT 1 FROM unnest(string_to_array(sesso, ',')) AS cat WHERE trim(cat) = ANY($1::text[])) ORDER BY cognome, nome`,
      [catFiltrate]
    );
    const players = playersR.rows;
    const allKeys = players.map(p => p.utente_id || ('g:' + p.id));

    const partR = await db.query(
      'SELECT utente_id, risposta FROM partecipazioni WHERE sessione_id=$1 AND utente_id = ANY($2::text[])',
      [sess.id, allKeys.length ? allKeys : ['__nessuno__']]
    );
    const partMap = {};
    partR.rows.forEach(p => { partMap[p.utente_id] = p.risposta; });

    const giocatori = players.map(p => {
      const key = p.utente_id || ('g:' + p.id);
      const risposta = partMap[key];
      return {
        id: key,
        nome: p.nome,
        cognome: p.cognome,
        ruolo: p.ruolo,
        sesso: p.sesso,
        has_account: !!p.utente_id,
        risposta: risposta !== undefined ? risposta : 'si',
      };
    });

    res.json({ sessione: { id: sess.id, titolo: sess.titolo, data: sess.data_str, ora: sess.ora }, giocatori });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Allenatore: aggiorna presenza ─── */
app.put('/api/allenatore/sessioni/:id/presenze/:playerId', userAuth, async (req, res) => {
  try {
    const u = await db.query('SELECT is_allenatore FROM utenti WHERE id=$1', [req.user.id]);
    if (!u.rows.length || !u.rows[0].is_allenatore) return res.status(403).json({ error: 'Accesso non autorizzato' });
    const { risposta } = req.body;
    if (!['si', 'no'].includes(risposta)) return res.status(400).json({ error: 'Risposta non valida' });
    const sessR = await db.query('SELECT id FROM calendario WHERE id=$1', [req.params.id]);
    if (!sessR.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    await db.query(
      `INSERT INTO partecipazioni (sessione_id, utente_id, risposta)
       VALUES ($1, $2, $3)
       ON CONFLICT (sessione_id, utente_id) DO UPDATE SET risposta = $3`,
      [req.params.id, req.params.playerId, risposta]
    );
    res.json({ ok: true, risposta });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Allenatore: crea sessione calendario ─── */
app.post('/api/allenatore/calendario', userAuth, async (req, res) => {
  try {
    const u = await db.query('SELECT is_allenatore, squadre_allenatore FROM utenti WHERE id=$1', [req.user.id]);
    if (!u.rows.length || !u.rows[0].is_allenatore) return res.status(403).json({ error: 'Accesso non autorizzato' });
    const squadreAllenatore = u.rows[0].squadre_allenatore || [];
    const { titolo, data, ora, tipo, categoria, note, palestra_id, giorni_settimana, data_fine_ripetizione, responsabile } = req.body;
    if (!titolo || !data || !ora) return res.status(400).json({ error: 'Titolo, data e ora obbligatori' });
    const catList   = (categoria || '').split(',').map(c => c.trim()).filter(Boolean);
    const catValide = catList.filter(c => squadreAllenatore.includes(c));
    if (!catValide.length) return res.status(400).json({ error: 'Seleziona almeno una squadra tra quelle assegnate' });
    const tipoVal      = tipo === 'evento' ? 'evento' : 'allenamento';
    const categoriaStr = catValide.join(',');
    const palestraVal  = palestra_id || '';
    const respVal      = responsabile || '';
    const dataFineEff  = data_fine_ripetizione || null;
    const _fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const _ins = (id, dataStr) => db.query(
      `INSERT INTO calendario (id, titolo, data_str, ora, categoria, note, tipo, palestra_id, responsabile) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, titolo.trim(), dataStr, ora, categoriaStr, note || '', tipoVal, palestraVal, respVal]
    );
    const giorniArr = Array.isArray(giorni_settimana) && giorni_settimana.length ? giorni_settimana.map(Number) : null;
    if (giorniArr && dataFineEff && dataFineEff >= data) {
      const giorniSet = new Set(giorniArr);
      const sessioni = [];
      let cur = new Date(data + 'T00:00:00');
      const end = new Date(dataFineEff + 'T00:00:00');
      let i = 0;
      while (cur <= end) {
        if (giorniSet.has(cur.getDay())) {
          const id = crypto.randomUUID();
          await _ins(id, _fmtDate(cur));
          sessioni.push({ id, titolo: titolo.trim(), data: _fmtDate(cur), ora, tipo: tipoVal });
          i++;
        }
        cur.setDate(cur.getDate() + 1);
      }
      return res.status(201).json({ sessioni, count: sessioni.length });
    }
    const id = crypto.randomUUID();
    await _ins(id, data);
    res.status(201).json({ id, titolo: titolo.trim(), data_str: data, ora, tipo: tipoVal, categoria: categoriaStr, count: 1 });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Galleria ─── */
app.get('/api/galleria', async (req, res) => {
  try {
    const { album } = req.query;
    const r = album
      ? await db.query('SELECT * FROM galleria WHERE album=$1 ORDER BY created_at DESC', [album])
      : await db.query('SELECT * FROM galleria ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.get('/api/galleria/albums', async (_req, res) => {
  try {
    const r = await db.query('SELECT DISTINCT album FROM galleria ORDER BY album');
    res.json(r.rows.map(row => row.album));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.post('/api/admin/galleria', adminAuth, async (req, res) => {
  const { album, titolo, immagine } = req.body;
  if (!immagine) return res.status(400).json({ error: 'Immagine obbligatoria' });
  const id = crypto.randomUUID();
  try {
    await db.query(`INSERT INTO galleria (id,album,titolo,immagine) VALUES ($1,$2,$3,$4)`,
      [id, album || 'Generale', titolo || '', immagine]);
    await logActivity('Foto aggiunta in galleria', album || 'Generale');
    res.status(201).json({ id, album, titolo, immagine });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.delete('/api/admin/galleria/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM galleria WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovata' });
    await logActivity('Foto eliminata dalla galleria', req.params.id);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});

/* ─── Iscrizioni ─── */
const iscrizioniLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Troppi invii. Riprova tra un\'ora.' } });
app.post('/api/iscrizioni', iscrizioniLimiter, async (req, res) => {
  const { nome, cognome, email, telefono, eta, categoria, messaggio } = req.body;
  if (!nome || !cognome || !email) return res.status(400).json({ error: 'Nome, cognome ed email obbligatori' });
  const id = crypto.randomUUID();
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
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.get('/api/admin/iscrizioni', adminAuth, async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM iscrizioni ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.put('/api/admin/iscrizioni/:id/stato', adminAuth, async (req, res) => {
  const { stato } = req.body;
  try {
    await db.query('UPDATE iscrizioni SET stato=$1 WHERE id=$2', [stato, req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});

/* ─── Sponsor ─── */
app.get('/api/sponsor', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM sponsor WHERE attivo=true ORDER BY livello, nome');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.get('/api/admin/sponsor', adminAuth, async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM sponsor ORDER BY livello, nome');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.post('/api/admin/sponsor', adminAuth, async (req, res) => {
  const { nome, logo, url, livello, attivo } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  const id = crypto.randomUUID();
  try {
    await db.query(`INSERT INTO sponsor (id,nome,logo,url,livello,attivo) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, nome, logo || '', url || '', Number(livello) || 1, attivo !== false]);
    await logActivity('Sponsor aggiunto', nome);
    res.status(201).json({ id, nome, logo, url, livello, attivo });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.put('/api/admin/sponsor/:id', adminAuth, async (req, res) => {
  const { nome, logo, url, livello, attivo } = req.body;
  try {
    const r = await db.query(
      `UPDATE sponsor SET nome=$1,logo=$2,url=$3,livello=$4,attivo=$5 WHERE id=$6 RETURNING *`,
      [nome, logo || '', url || '', Number(livello) || 1, attivo !== false, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovato' });
    await logActivity('Sponsor modificato', nome);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.delete('/api/admin/sponsor/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM sponsor WHERE id=$1 RETURNING nome', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovato' });
    await logActivity('Sponsor eliminato', r.rows[0].nome);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});

/* ─── Card squadre homepage ─── */
app.get('/api/squadre-homepage', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM squadre_homepage ORDER BY ordine, created_at');
    res.json(r.rows);
  } catch { res.json([]); }
});
app.get('/api/admin/squadre-homepage', adminAuth, async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM squadre_homepage ORDER BY ordine, created_at');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});
app.post('/api/admin/squadre-homepage', adminAuth, async (req, res) => {
  const { nome, badge, sottotitolo, immagine, accent_color, link_risultati, link_classifica, link_squadra, ordine, featured, categorie, bg_position } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  const id = crypto.randomUUID();
  try {
    await db.query(
      `INSERT INTO squadre_homepage (id,nome,badge,sottotitolo,immagine,accent_color,link_risultati,link_classifica,link_squadra,ordine,featured,categorie,bg_position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, nome, badge||'', sottotitolo||'', immagine||'', accent_color||'#f57c00',
       link_risultati||'', link_classifica||'', link_squadra||'', parseInt(ordine)||0, !!featured,
       JSON.stringify(Array.isArray(categorie) ? categorie : []), bg_position||'50% 50%']
    );
    res.status(201).json({ id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno' }); }
});
app.put('/api/admin/squadre-homepage/:id', adminAuth, async (req, res) => {
  const { nome, badge, sottotitolo, immagine, accent_color, link_risultati, link_classifica, link_squadra, ordine, featured, categorie, bg_position } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obbligatorio' });
  try {
    await db.query(
      `UPDATE squadre_homepage SET nome=$1,badge=$2,sottotitolo=$3,immagine=$4,accent_color=$5,link_risultati=$6,link_classifica=$7,link_squadra=$8,ordine=$9,featured=$10,categorie=$11,bg_position=$12 WHERE id=$13`,
      [nome, badge||'', sottotitolo||'', immagine||'', accent_color||'#f57c00',
       link_risultati||'', link_classifica||'', link_squadra||'', parseInt(ordine)||0, !!featured,
       JSON.stringify(Array.isArray(categorie) ? categorie : []), bg_position||'50% 50%', req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});
app.delete('/api/admin/squadre-homepage/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM squadre_homepage WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Errore interno' }); }
});

/* ─── Risultati ─── */
app.get('/api/risultati', async (_req, res) => {
  try {
    const r = await db.query('SELECT * FROM risultati ORDER BY data_str DESC');
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.post('/api/admin/risultati', adminAuth, async (req, res) => {
  const { data, avversario, set_noi, set_loro, categoria, tipo } = req.body;
  if (!data || !avversario || set_noi == null || set_loro == null) return res.status(400).json({ error: 'Campi obbligatori mancanti' });
  const id = crypto.randomUUID();
  try {
    await db.query(`INSERT INTO risultati (id,data_str,avversario,set_noi,set_loro,categoria,tipo) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, data, avversario, parseInt(set_noi), parseInt(set_loro), categoria || '', tipo || 'campionato']);
    await logActivity('Risultato aggiunto', `vs ${avversario} ${set_noi}-${set_loro}`);
    res.status(201).json({ id, data_str: data, avversario, set_noi, set_loro, categoria, tipo });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.put('/api/admin/risultati/:id', adminAuth, async (req, res) => {
  const { data, avversario, set_noi, set_loro, categoria, tipo } = req.body;
  try {
    const r = await db.query(
      `UPDATE risultati SET data_str=$1,avversario=$2,set_noi=$3,set_loro=$4,categoria=$5,tipo=$6 WHERE id=$7 RETURNING *`,
      [data, avversario, parseInt(set_noi), parseInt(set_loro), categoria || '', tipo || 'campionato', req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovato' });
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});
app.delete('/api/admin/risultati/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query('DELETE FROM risultati WHERE id=$1 RETURNING avversario', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovato' });
    await logActivity('Risultato eliminato', `vs ${r.rows[0].avversario}`);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
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
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
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

app.get('/api/push/campionati', async (_req, res) => {
  try {
    const all = await getMatchesFromDB();
    const cats = [...new Set(all.map(m => m.categoria).filter(Boolean))].sort();
    res.json(cats);
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
});

/* Helper: invia push a tutti i subscriber con preferenza attiva */
async function sendPushByType(tipo, payload, opts = {}) {
  if (!webpush) return;
  const col = { live: 'notif_live', notizie: 'notif_notizie', partite: 'notif_partite' }[tipo];
  if (!col) return;
  try {
    let q = `SELECT endpoint, keys FROM push_subscriptions WHERE ${col}=true`;
    const params = [];
    if (tipo === 'partite' && opts.categoria) {
      q += ` AND (notif_campionati = '[]'::jsonb OR notif_campionati @> $1::jsonb)`;
      params.push(JSON.stringify([opts.categoria]));
    }
    const subs = await db.query(q, params);
    const body = JSON.stringify(payload);
    for (const sub of subs.rows) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body);
      } catch (e) {
        if (e.statusCode === 410) await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
      }
    }
  } catch (err) { console.error('[push]', err); }
}

/* Preferenze push per endpoint */
app.get('/api/push/preferences', async (req, res) => {
  const { endpoint } = req.query;
  if (!endpoint) return res.status(400).json({ error: 'endpoint mancante' });
  try {
    const r = await db.query('SELECT notif_live,notif_notizie,notif_partite,notif_campionati FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    if (!r.rows.length) return res.status(404).json({ error: 'subscription non trovata' });
    const row = r.rows[0];
    row.notif_campionati = row.notif_campionati || ['FIPAV', 'OPES'];
    res.json(row);
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
});

app.put('/api/push/preferences', async (req, res) => {
  const { endpoint, notif_live, notif_notizie, notif_partite, notif_campionati } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint mancante' });
  const campionati = Array.isArray(notif_campionati) ? notif_campionati.filter(c => typeof c === 'string' && c.length < 200) : [];
  try {
    await db.query(
      `UPDATE push_subscriptions SET notif_live=$1, notif_notizie=$2, notif_partite=$3, notif_campionati=$4 WHERE endpoint=$5`,
      [!!notif_live, !!notif_notizie, !!notif_partite, JSON.stringify(campionati), endpoint]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Errore interno.' }); }
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
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
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
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});

app.get('/api/admin/push/subscribers', adminAuth, async (req, res) => {
  try {
    const r = await db.query('SELECT COUNT(*) FROM push_subscriptions');
    res.json({ count: parseInt(r.rows[0].count, 10) });
  } catch (err) { res.status(500).json({ error: 'Errore interno del server.' }); }
});

app.post('/api/push/test', async (req, res) => {
  const token = process.env.PUSH_TEST_TOKEN;
  if (!token || req.headers['x-push-token'] !== token) {
    return res.status(401).json({ error: 'Token non valido' });
  }
  if (!webpush) return res.status(503).json({ error: 'Push non configurato (VAPID keys mancanti)' });
  const { titolo = 'Test Virtus Caserta', messaggio = 'Notifica di prova ricevuta!', url = '/' } = req.body;
  try {
    const subs = await db.query('SELECT * FROM push_subscriptions');
    if (!subs.rows.length) return res.json({ success: false, message: 'Nessun subscriber registrato' });
    const payload = JSON.stringify({ titolo, messaggio, url });
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
    res.json({ success: true, ok, fail });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Errore interno del server.' }); }
});

/* ─── Twitch Live Monitor ─── */
let _twitchToken = null;
let _twitchTokenExpiry = 0;
let _twitchIsLive = false;

async function _getTwitchToken() {
  if (_twitchToken && Date.now() < _twitchTokenExpiry) return _twitchToken;
  const clientId     = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const r = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const d = await r.json();
  if (!d.access_token) return null;
  _twitchToken = d.access_token;
  _twitchTokenExpiry = Date.now() + ((d.expires_in || 3600) - 60) * 1000;
  return _twitchToken;
}

async function checkTwitchLive() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const channel  = process.env.TWITCH_CHANNEL_NAME || 'virtuscaserta';
  if (!clientId) return;
  try {
    const token = await _getTwitchToken();
    if (!token) return;
    const r = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`, {
      headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) { if (r.status === 401) { _twitchToken = null; } return; }
    const d = await r.json();
    const isLive = Array.isArray(d.data) && d.data.length > 0;
    if (isLive && !_twitchIsLive) {
      _twitchIsLive = true;
      const stream = d.data[0];
      sendPushByType('live', {
        titolo:   '🔴 Virtus Caserta in diretta su Twitch!',
        messaggio: stream.title || 'Guarda la partita live ora.',
        url:       '/live',
      });
    } else if (!isLive) {
      _twitchIsLive = false;
    }
  } catch (err) { console.error('[Twitch monitor]', err.message); }
}

/* ─── Modulo contatti ─── */
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Troppi messaggi. Riprova tra un\'ora.' } });

app.post('/api/contact', contactLimiter, async (req, res) => {
  const { nome, email, oggetto, messaggio } = req.body;
  if (!nome || !email || !messaggio) return res.status(400).json({ error: 'Nome, email e messaggio sono obbligatori.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email non valida.' });
  if (!emailConfigurata()) return res.status(503).json({ error: 'Sistema email non configurato.' });

  const siteUrl  = process.env.BASE_URL || 'https://www.virtuscaserta.com';
  const logoUrl  = `${siteUrl}/images/negativo@4x.png`;
  const now      = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'long', timeStyle: 'short' });

  const emailHeader = `
    <div style="background:#0d2055;padding:28px 32px;text-align:center;">
      <img src="${logoUrl}" alt="Virtus Caserta" style="height:52px;max-width:200px;object-fit:contain;" />
    </div>`;

  const emailFooter = `
    <div style="background:#f8f9fb;border-top:1px solid #e5e7eb;padding:24px 32px;text-align:center;font-size:12px;color:#9ca3af;line-height:1.7;">
      <strong style="color:#374151;font-size:13px;">Virtus Caserta A.S.D.</strong><br>
      📧 <a href="mailto:virtuscaserta@gmail.com" style="color:#0d2055;text-decoration:none;">virtuscaserta@gmail.com</a>
      &nbsp;·&nbsp;
      🌐 <a href="${siteUrl}" style="color:#0d2055;text-decoration:none;">virtuscaserta.com</a><br>
      Caserta, Campania – Italia
    </div>`;

  const adminTo = (process.env.EMAIL_ADMIN || process.env.BREVO_FROM_EMAIL || '').trim();
  if (!adminTo) return res.status(503).json({ error: 'Destinatario admin non configurato.' });

  const htmlAdmin = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);" cellpadding="0" cellspacing="0">
        <tr><td>${emailHeader}</td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#f57c00;">Nuovo messaggio dal sito</p>
          <h2 style="margin:0 0 24px;font-size:20px;font-weight:800;color:#0d2055;">${esc(oggetto || 'Messaggio di contatto')}</h2>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td style="padding:10px 14px;background:#f8f9fb;border-radius:8px 8px 0 0;border-bottom:1px solid #e5e7eb;">
                <span style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;">Da</span><br>
                <span style="font-size:14px;font-weight:600;color:#111827;">${esc(nome)}</span>
                <span style="font-size:13px;color:#6b7280;">&lt;${esc(email)}&gt;</span>
              </td>
            </tr>
            <tr>
              <td style="padding:10px 14px;background:#f8f9fb;border-radius:0 0 8px 8px;">
                <span style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;">Ricevuto</span><br>
                <span style="font-size:13px;color:#374151;">${now}</span>
              </td>
            </tr>
          </table>
          <div style="background:#f8f9fb;border-left:4px solid #0d2055;border-radius:0 8px 8px 0;padding:18px 20px;margin-bottom:24px;">
            <p style="margin:0;font-size:14px;color:#374151;white-space:pre-wrap;line-height:1.7;">${esc(messaggio)}</p>
          </div>
          <a href="mailto:${esc(email)}" style="display:inline-block;background:#0d2055;color:#fff;text-decoration:none;padding:11px 24px;border-radius:8px;font-size:13px;font-weight:700;">Rispondi a ${esc(nome)}</a>
        </td></tr>
        <tr><td>${emailFooter}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const htmlUtente = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);" cellpadding="0" cellspacing="0">
        <tr><td>${emailHeader}</td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#f57c00;">Conferma ricezione</p>
          <h2 style="margin:0 0 12px;font-size:20px;font-weight:800;color:#0d2055;">Ciao, ${esc(nome)}!</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#374151;line-height:1.7;">
            Abbiamo ricevuto il tuo messaggio e ti risponderemo il prima possibile.<br>Di seguito il riepilogo di quanto ci hai inviato.
          </p>
          <div style="background:#f8f9fb;border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px;margin-bottom:28px;">
            <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;">Il tuo messaggio</p>
            <p style="margin:0 0 12px;font-size:15px;font-weight:700;color:#0d2055;">${esc(oggetto || '—')}</p>
            <p style="margin:0;font-size:13.5px;color:#6b7280;white-space:pre-wrap;line-height:1.65;">${esc(messaggio)}</p>
          </div>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 24px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #f3f4f6;">
                <span style="font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.8px;">Email</span><br>
                <a href="mailto:virtuscaserta@gmail.com" style="font-size:13.5px;color:#0d2055;text-decoration:none;font-weight:600;">virtuscaserta@gmail.com</a>
              </td>
              <td style="padding:10px 0 10px 20px;border-bottom:1px solid #f3f4f6;">
                <span style="font-size:12px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.8px;">Sito web</span><br>
                <a href="${siteUrl}" style="font-size:13.5px;color:#0d2055;text-decoration:none;font-weight:600;">virtuscaserta.com</a>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td>${emailFooter}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    const results = await Promise.allSettled([
      sendBrevoEmail({
        to:      adminTo,
        subject: `[Contatto Sito] ${esc(oggetto || 'Nuovo messaggio')} – ${esc(nome)}`,
        replyTo: email.trim(),
        html:    htmlAdmin,
      }),
      sendBrevoEmail({
        to:      email.trim(),
        subject: 'Abbiamo ricevuto il tuo messaggio – Virtus Caserta',
        html:    htmlUtente,
      }),
    ]);

    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length === 2) {
      const msg = failures[0].reason?.message || 'Errore sconosciuto';
      console.error('[Contact] Entrambe le email fallite:', msg);
      return res.status(500).json({ error: 'Invio fallito. Riprova più tardi.' });
    }
    if (failures.length === 1) {
      console.warn('[Contact] Email parzialmente fallita:', failures[0].reason?.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Contact] Errore inatteso:', err.message);
    res.status(500).json({ error: 'Invio fallito. Riprova più tardi.' });
  }
});

/* ─── Admin: test email ─── */
app.post('/api/admin/test-email', adminAuth, async (_req, res) => {
  if (!brevoApiConfigurato()) return res.status(503).json({ error: 'BREVO_API_KEY o BREVO_FROM_EMAIL non configurati.' });
  const adminTo = (process.env.EMAIL_ADMIN || process.env.BREVO_FROM_EMAIL || '').trim();
  if (!adminTo) return res.status(503).json({ error: 'EMAIL_ADMIN non configurato.' });
  try {
    await sendBrevoEmail({
      to:      adminTo,
      subject: 'Test email – Virtus Caserta',
      html:    `<p style="font-family:Arial,sans-serif;font-size:14px;">
                  Email di test inviata via Brevo HTTP API<br>
                  Ambiente: <strong>${process.env.NODE_ENV || 'development'}</strong><br>
                  Timestamp: <strong>${new Date().toISOString()}</strong>
                </p>`,
    });
    await logActivity('Test email inviato', adminTo);
    res.json({ success: true });
  } catch (err) {
    console.error('[Test email] Errore:', err.message, err.brevoData || '');
    res.status(500).json({ error: err.message || 'Errore interno del server.' });
  }
});

/* ─── Reminder giornaliero ordini non letti (ogni giorno alle 9:00 ora Italia) ─── */
function scheduleReminderMailOrdini() {
  const now  = new Date();
  const rome = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  const next = new Date(rome);
  next.setHours(9, 0, 0, 0);
  if (rome >= next) next.setDate(next.getDate() + 1);
  const delay = next - rome;
  setTimeout(async () => {
    try {
      const r = await db.query(
        `SELECT * FROM ordini WHERE mail_letta = false AND stato NOT IN ('annullato','ritirato') ORDER BY created_at ASC`
      );
      if (r.rows.length && emailShopConfigurata()) {
        const transporter = creaTransporterShop();
        const righe = r.rows.map(o =>
          `<tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">#${String(o.id).slice(-6)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${o.nome} ${o.cognome}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${o.email}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">€ ${Number(o.totale).toFixed(2)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${o.stato}</td>
          </tr>`
        ).join('');
        const html = `
          <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#222">
            <div style="background:#0d2055;padding:20px 24px;text-align:center">
              <h1 style="color:#fff;font-size:18px;margin:0;letter-spacing:2px">VIRTUS CASERTA</h1>
              <p style="color:#ff9800;margin:6px 0 0;font-size:12px">REMINDER ORDINI IN SOSPESO</p>
            </div>
            <div style="padding:24px">
              <p>Ci sono <strong>${r.rows.length}</strong> ordini con mail non ancora letta:</p>
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead>
                  <tr style="background:#f1f5f9">
                    <th style="padding:8px 12px;text-align:left">Ordine</th>
                    <th style="padding:8px 12px;text-align:left">Cliente</th>
                    <th style="padding:8px 12px;text-align:left">Email</th>
                    <th style="padding:8px 12px;text-align:left">Totale</th>
                    <th style="padding:8px 12px;text-align:left">Stato</th>
                  </tr>
                </thead>
                <tbody>${righe}</tbody>
              </table>
              <p style="margin-top:20px;font-size:13px;color:#6b7280;">Accedi al pannello admin per gestire gli ordini.</p>
            </div>
            <div style="background:#f8fafc;padding:12px;text-align:center;font-size:11px;color:#9ca3af">
              © 2026 Virtus Caserta – reminder automatico
            </div>
          </div>`;
        transporter.sendMail({
          from: shopFrom(),
          to: 'alessandro.pascarella@gmail.com',
          subject: `[Virtus Shop] ${r.rows.length} ordini in sospeso senza risposta`,
          html,
        }).catch(e => console.error('[Reminder ordini]', e.message));
        console.log(`[Reminder ordini] Inviato – ${r.rows.length} ordini in sospeso`);
      } else {
        console.log('[Reminder ordini] Nessun ordine in sospeso');
      }
    } catch (e) {
      console.error('[Reminder ordini] Errore:', e.message);
    }
    scheduleReminderMailOrdini();
  }, delay);
  const nextStr = new Date(now.getTime() + delay).toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  console.log(`[Reminder ordini] Prossimo check: ${nextStr}`);
}

/* ─── Progetti ─── */
// Multer per allegati domande (max 5 file, PDF/doc/img)
const uploadProgetti = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(file.originalname);
    cb(null, ok);
  },
});

// Pubblica: lista progetti pubblicati
app.get('/api/progetti', async (_req, res) => {
  try {
    const r = await db.query(`SELECT id, titolo, immagine, data_scadenza, pubblicato FROM progetti WHERE pubblicato=true ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pubblica: dettaglio singolo progetto
app.get('/api/progetti/:id', async (req, res) => {
  try {
    const r = await db.query(`SELECT * FROM progetti WHERE id=$1 AND pubblicato=true`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovato' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pubblica: invia domanda
app.post('/api/progetti/:id/domanda', uploadProgetti.any(), async (req, res) => {
  try {
    const { nome, cognome, email, note } = req.body;
    const progetto = await db.query(`SELECT id, documenti_richiesti FROM progetti WHERE id=$1 AND pubblicato=true`, [req.params.id]);
    if (!progetto.rows.length) return res.status(404).json({ error: 'Progetto non trovato' });
    const files = [];
    for (const f of (req.files || [])) {
      const storagePath = `progetti/${req.params.id}/${Date.now()}_${f.fieldname}_${f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      if (supabaseStorage) {
        const { error } = await supabaseStorage.from(SUPABASE_BUCKET).upload(storagePath, f.buffer, { contentType: f.mimetype, upsert: false });
        if (error) throw new Error(error.message);
        const { data } = supabaseStorage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
        files.push({ label: f.fieldname, nome: f.originalname, url: data.publicUrl });
      } else {
        const dir = path.join(UPLOADS_DIR, `progetti/${req.params.id}`);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const fp = path.join(dir, path.basename(storagePath));
        fs.writeFileSync(fp, f.buffer);
        files.push({ label: f.fieldname, nome: f.originalname, url: '/uploads/' + storagePath });
      }
    }
    const ins = await db.query(
      `INSERT INTO progetti_domande (progetto_id, nome, cognome, email, note, files) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [req.params.id, nome || '', cognome || '', email || '', note || '', JSON.stringify(files)]
    );
    res.json({ ok: true, domanda_id: ins.rows[0].id, created_at: ins.rows[0].created_at });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Admin: lista tutti i progetti
app.get('/api/admin/progetti', adminAuth, async (_req, res) => {
  try {
    const r = await db.query(`SELECT id, titolo, data_scadenza, pubblicato, created_at FROM progetti ORDER BY created_at DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: domande ricevute (tutte) — DEVE stare prima di /:id
app.get('/api/admin/progetti/domande', adminAuth, async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT d.*, p.titolo AS progetto_titolo FROM progetti_domande d JOIN progetti p ON p.id=d.progetto_id ORDER BY d.created_at DESC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: dettaglio progetto
app.get('/api/admin/progetti/:id', adminAuth, async (req, res) => {
  try {
    const r = await db.query(`SELECT * FROM progetti WHERE id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Non trovato' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function _uploadProgettoFile(file, folder) {
  const storagePath = `progetti/${folder}/${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  if (supabaseStorage) {
    const { error } = await supabaseStorage.from(SUPABASE_BUCKET).upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (error) throw new Error(error.message);
    const { data } = supabaseStorage.from(SUPABASE_BUCKET).getPublicUrl(storagePath);
    return data.publicUrl;
  } else {
    const dir = path.join(UPLOADS_DIR, `progetti/${folder}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, path.basename(storagePath)), file.buffer);
    return '/uploads/' + storagePath;
  }
}

// Admin: crea progetto
app.post('/api/admin/progetti', adminAuth, uploadProgetti.fields([{ name:'pdf_bando', maxCount:1 }, { name:'immagine', maxCount:1 }]), async (req, res) => {
  try {
    const { titolo, descrizione, data_scadenza, documenti_richiesti, pubblicato } = req.body;
    const files = req.files || {};
    let pdf_bando = null, immagine = null;
    if (files.pdf_bando?.[0]) pdf_bando = await _uploadProgettoFile(files.pdf_bando[0], 'bandi');
    if (files.immagine?.[0])  immagine  = await _uploadProgettoFile(files.immagine[0],  'img');
    const docs = documenti_richiesti ? JSON.parse(documenti_richiesti) : [];
    const r = await db.query(
      `INSERT INTO progetti (titolo, descrizione, immagine, pdf_bando, data_scadenza, documenti_richiesti, pubblicato) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [titolo, descrizione || '', immagine, pdf_bando, data_scadenza || null, JSON.stringify(docs), pubblicato === 'true']
    );
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Admin: modifica progetto
app.put('/api/admin/progetti/:id', adminAuth, uploadProgetti.fields([{ name:'pdf_bando', maxCount:1 }, { name:'immagine', maxCount:1 }]), async (req, res) => {
  try {
    const { titolo, descrizione, data_scadenza, documenti_richiesti, pubblicato } = req.body;
    const existing = await db.query(`SELECT * FROM progetti WHERE id=$1`, [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Non trovato' });
    const files = req.files || {};
    let pdf_bando = existing.rows[0].pdf_bando;
    let immagine  = existing.rows[0].immagine;
    if (files.pdf_bando?.[0]) pdf_bando = await _uploadProgettoFile(files.pdf_bando[0], 'bandi');
    if (files.immagine?.[0])  immagine  = await _uploadProgettoFile(files.immagine[0],  'img');
    const docs = documenti_richiesti ? JSON.parse(documenti_richiesti) : existing.rows[0].documenti_richiesti;
    const r = await db.query(
      `UPDATE progetti SET titolo=$1, descrizione=$2, immagine=$3, pdf_bando=$4, data_scadenza=$5, documenti_richiesti=$6, pubblicato=$7 WHERE id=$8 RETURNING *`,
      [titolo, descrizione || '', immagine, pdf_bando, data_scadenza || null, JSON.stringify(docs), pubblicato === 'true', req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Admin: elimina progetto
app.delete('/api/admin/progetti/:id', adminAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM progetti WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/progetti/:id/domande', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT d.*, p.titolo AS progetto_titolo FROM progetti_domande d JOIN progetti p ON p.id=d.progetto_id WHERE d.progetto_id=$1 ORDER BY d.created_at DESC`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─── Startup ─── */
db.init().then(async () => {
  try { await db.query(`ALTER TABLE ordini ADD COLUMN IF NOT EXISTS mail_letta BOOLEAN DEFAULT FALSE`); } catch(_){}
  try { await db.query(`ALTER TABLE calendario ADD COLUMN IF NOT EXISTS categorie_collegate JSONB DEFAULT '[]'`); } catch(_){}
  try { await db.query(`ALTER TABLE calendario ADD COLUMN IF NOT EXISTS utenti_collegati JSONB DEFAULT '[]'`); } catch(_){}
  try { await db.query(`ALTER TABLE fipav_matches ADD COLUMN IF NOT EXISTS utenti_collegati JSONB DEFAULT '[]'`); } catch(_){}
  try { await db.query(`CREATE TABLE IF NOT EXISTS comunicazioni (
    id TEXT PRIMARY KEY,
    mittente_id TEXT NOT NULL,
    mittente_nome TEXT,
    destinatario_tipo TEXT NOT NULL,
    destinatario_label TEXT,
    destinatario_id TEXT,
    oggetto TEXT NOT NULL,
    testo TEXT NOT NULL,
    letto BOOLEAN DEFAULT FALSE,
    creato_il TIMESTAMPTZ DEFAULT NOW()
  )`); } catch(_){}
  try { await db.query(`CREATE TABLE IF NOT EXISTS documenti_utente (
    id TEXT PRIMARY KEY,
    utente_id TEXT NOT NULL,
    nome TEXT NOT NULL,
    url TEXT NOT NULL,
    dimensione INTEGER,
    creato_il TIMESTAMPTZ DEFAULT NOW()
  )`); } catch(_){}
  try { await db.query(`CREATE TABLE IF NOT EXISTS partite_proposte (
    id TEXT PRIMARY KEY,
    mittente_id TEXT NOT NULL,
    data TEXT,
    ora TEXT,
    ora_fine TEXT,
    luogo TEXT,
    note TEXT,
    stato TEXT DEFAULT 'pending',
    invitati_categorie JSONB DEFAULT '[]',
    invitati_persone JSONB DEFAULT '[]',
    creato_il TIMESTAMPTZ DEFAULT NOW()
  )`); } catch(_){}
  app.listen(PORT, () => {
    console.log(`[OK] Server avviato su porta ${PORT} (${process.env.NODE_ENV || 'development'})`);
    console.log(`[OK] Email configurata: ${emailConfigurata() ? process.env.EMAIL_USER : 'NO – imposta EMAIL_USER e EMAIL_PASS'}`);
    if (!INSTAGRAM_ACCESS_TOKEN) console.log('[--] Instagram: nessun access token.');
  });
  // Avvia scheduler FIPAV: carica partite da DB, registra timer, refresh giornaliero
  initFipavScheduler().catch(err => console.log('[FIPAV Scheduler] Boot fallito:', err.message));

  // Twitch live monitor (2min interval)
  if (process.env.TWITCH_CLIENT_ID) {
    checkTwitchLive();
    setInterval(checkTwitchLive, 2 * 60 * 1000);
  }
  scheduleReminderMailOrdini();

  // Scheduler notifiche partita 3h prima
  async function checkPartiteNotifiche() {
    if (!webpush) return;
    try {
      const matches = await db.query(
        `SELECT id, casa, ospite, categoria, fonte FROM fipav_matches
         WHERE played=false AND postponed=false
           AND data_ora > NOW() + INTERVAL '2 hours 45 minutes'
           AND data_ora < NOW() + INTERVAL '3 hours 15 minutes'`
      );
      for (const m of matches.rows) {
        const already = await db.query('SELECT 1 FROM partita_notif_log WHERE match_id=$1', [m.id]);
        if (already.rows.length) continue;
        await db.query('INSERT INTO partita_notif_log (match_id) VALUES ($1) ON CONFLICT DO NOTHING', [m.id]);
        sendPushByType('partite', {
          titolo: '🏐 Partita tra 3 ore!',
          messaggio: `${m.casa} vs ${m.ospite}${m.categoria ? ' — ' + m.categoria : ''}`,
          url: '/risultati',
        }, { categoria: m.categoria });
      }
    } catch (err) { console.error('[push partite scheduler]', err.message); }
  }
  setInterval(checkPartiteNotifiche, 10 * 60 * 1000);
  checkPartiteNotifiche();
}).catch(err => {
  console.error('[DB] Errore inizializzazione:', err.message);
  app.listen(PORT, () => {
    console.log(`[WARN] Server avviato (senza DB) su porta ${PORT}`);
    console.log(`[OK]  Email configurata: ${emailConfigurata() ? process.env.EMAIL_USER : 'NO'}`);
  });
});
