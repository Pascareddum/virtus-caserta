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
const rateLimit  = require('express-rate-limit');
const db         = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('[ERRORE CRITICO] JWT_SECRET non configurato. Imposta JWT_SECRET nel file .env prima di avviare in produzione.');
  process.exit(1);
}
const JWT_SECRET             = process.env.JWT_SECRET || 'virtus_secret_2026_dev';
const INSTAGRAM_USERNAME     = 'virtuscaserta';
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || '';

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

app.use(express.static(path.join(__dirname)));
app.use(express.json());

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
    return res.json({ token });
  }
  res.status(401).json({ error: 'Credenziali non valide' });
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
    const result = await db.query('DELETE FROM products WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Prodotto non trovato' });
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
    res.json({ id: r.id, titolo: r.titolo, testo: r.testo, colore: r.colore, immagine: r.immagine, data: r.data_str });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Admin: elimina notizia ─── */
app.delete('/api/admin/notizie/:id', adminAuth, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM notizie WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Notizia non trovata' });
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
    const result = await db.query('UPDATE ordini SET stato=$1 WHERE id=$2 RETURNING id', [stato, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Ordine non trovato' });
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

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('[Email] Credenziali mancanti – email non inviata');
    return res.json({ success: false, reason: 'Email non configurata' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

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
const FIPAV_URL = 'https://caserta.portalefipav.net/risultati-classifiche.aspx?ComitatoId=19&StId=2281&DataDa=&StatoGara=&CId=&SId=5150&PId=7261&btFiltro=CERCA';

function parseFipavMatches(html) {
  function stripTags(s) {
    return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const categories = [];
  const capRe = /<caption[^>]*>([\s\S]*?)<\/caption>/gi;
  let capm;
  while ((capm = capRe.exec(html)) !== null) {
    const text = stripTags(capm[1]).trim();
    if (text.length > 4 && /[a-zA-Z]/.test(text)) categories.push({ pos: capm.index, text });
  }
  const matches = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const tds = [];
    let tdMatch;
    while ((tdMatch = tdRe.exec(row)) !== null) tds.push(stripTags(tdMatch[1]));
    if (tds.length >= 6) {
      const [gara, giornata, dataOra, casa, ospite, risultato] = tds;
      if (/^\d+$/.test(gara.trim()) && /\d{2}\/\d{2}\/\d{2}/.test(dataOra)) {
        const score = risultato.trim();
        const played = /\d\s*-\s*\d/.test(score);
        const postponed = /rinviat/i.test(score);
        const dm = dataOra.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
        let timestamp = null;
        let dateFormatted = dataOra.trim();
        if (dm) {
          const [, dd, mm, yy, hh, min] = dm;
          timestamp = new Date(`20${yy}-${mm}-${dd}T${hh}:${min}:00`).getTime();
          dateFormatted = `${dd}/${mm}/20${yy} ${hh}:${min}`;
        }
        const rowPos = rowMatch.index;
        let categoria = '';
        for (const cat of categories) {
          if (cat.pos < rowPos) categoria = cat.text;
          else break;
        }
        matches.push({ id: gara.trim(), giornata: giornata.trim(), dataOra: dateFormatted, timestamp, casa: casa.trim(), ospite: ospite.trim(), risultato: score, played, postponed, categoria });
      }
    }
  }
  return matches;
}

app.get('/api/partite', async (_req, res) => {
  try {
    const r = await fetch(FIPAV_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-IT,it;q=0.9',
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    const all = parseFipavMatches(html);
    all.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const now    = Date.now();
    const past   = all.filter(m => m.played);
    const future = all.filter(m => !m.played && m.timestamp !== null && m.timestamp > now);
    res.json({ ultime: past.slice(-3), prossime: future.slice(0, 3), fipavUrl: FIPAV_URL });
  } catch (err) {
    console.log('[Partite] Errore:', err.message);
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

/* ─── Startup ─── */
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Server avviato su http://localhost:${PORT}`);
    if (!INSTAGRAM_ACCESS_TOKEN) console.log('[Instagram] Nessun access token configurato.');
  });
}).catch(err => {
  console.error('[DB] Errore inizializzazione:', err.message);
  app.listen(PORT, () => {
    console.log(`Server avviato (senza DB) su http://localhost:${PORT}`);
  });
});
