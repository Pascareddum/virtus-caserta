require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const fs         = require('fs');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');
const jwt        = require('jsonwebtoken');
const multer     = require('multer');

const app  = express();
const PORT = process.env.PORT || 3000;

const INSTAGRAM_USERNAME   = 'virtuscaserta';
const INSTAGRAM_SESSION_ID = decodeURIComponent(process.env.INSTAGRAM_SESSION_ID || '');

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

app.use(express.static(path.join(__dirname)));
app.use(express.json());

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

/* ─── Helpers prodotti ─── */
const PRODUCTS_FILE = path.join(__dirname, 'products.json');
function readProducts()          { return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); }
function writeProducts(products) { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2)); }

/* ─── Helpers notizie ─── */
const NOTIZIE_FILE = path.join(__dirname, 'notizie.json');
function readNotizie()         { return JSON.parse(fs.readFileSync(NOTIZIE_FILE, 'utf8')); }
function writeNotizie(notizie) { fs.writeFileSync(NOTIZIE_FILE, JSON.stringify(notizie, null, 2)); }

/* ─── Middleware auth admin ─── */
const JWT_SECRET = process.env.JWT_SECRET || 'virtus_secret_fallback';
function adminAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non autenticato' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token non valido o scaduto' });
  }
}

/* ─── Admin: login ─── */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === (process.env.ADMIN_USERNAME || 'admin') &&
    password === (process.env.ADMIN_PASSWORD || 'virtus2026')
  ) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Credenziali non valide' });
});

/* ─── Prodotti: pubblico ─── */
app.get('/api/products', (_req, res) => {
  res.json(readProducts());
});

/* ─── Admin: aggiungi prodotto ─── */
app.post('/api/admin/products', adminAuth, (req, res) => {
  const { nome, descrizione, prezzo, emoji, taglie } = req.body;
  if (!nome || !prezzo) return res.status(400).json({ error: 'Nome e prezzo obbligatori' });
  const products = readProducts();
  const newProduct = {
    id: Date.now().toString(),
    nome,
    descrizione: descrizione || '',
    prezzo: parseFloat(prezzo),
    emoji: emoji || '🏐',
    disponibile: true,
    taglie: taglie || ['S', 'M', 'L', 'XL'],
  };
  products.push(newProduct);
  writeProducts(products);
  res.status(201).json(newProduct);
});

/* ─── Admin: aggiorna prodotto ─── */
app.put('/api/admin/products/:id', adminAuth, (req, res) => {
  const products = readProducts();
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Prodotto non trovato' });
  products[idx] = { ...products[idx], ...req.body, id: req.params.id };
  writeProducts(products);
  res.json(products[idx]);
});

/* ─── Admin: elimina prodotto ─── */
app.delete('/api/admin/products/:id', adminAuth, (req, res) => {
  const products = readProducts();
  const idx = products.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Prodotto non trovato' });
  products.splice(idx, 1);
  writeProducts(products);
  res.json({ success: true });
});

/* ─── Admin: upload foto ─── */
app.post('/api/admin/upload', adminAuth, upload.single('immagine'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  res.json({ url: '/uploads/' + req.file.filename });
});

/* ─── Notizie: pubblico ─── */
app.get('/api/notizie', (_req, res) => {
  res.json(readNotizie());
});

/* ─── Admin: aggiungi notizia ─── */
app.post('/api/admin/notizie', adminAuth, (req, res) => {
  const { titolo, testo, data, colore, immagine } = req.body;
  if (!titolo || !testo) return res.status(400).json({ error: 'Titolo e testo obbligatori' });
  const notizie = readNotizie();
  const nuova = { id: Date.now().toString(), titolo, testo, data: data || new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }), colore: colore || 'blu', immagine: immagine || '' };
  notizie.unshift(nuova);
  writeNotizie(notizie);
  res.status(201).json(nuova);
});

/* ─── Admin: aggiorna notizia ─── */
app.put('/api/admin/notizie/:id', adminAuth, (req, res) => {
  const notizie = readNotizie();
  const idx = notizie.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Notizia non trovata' });
  notizie[idx] = { ...notizie[idx], ...req.body, id: req.params.id };
  writeNotizie(notizie);
  res.json(notizie[idx]);
});

/* ─── Admin: elimina notizia ─── */
app.delete('/api/admin/notizie/:id', adminAuth, (req, res) => {
  const notizie = readNotizie();
  const idx = notizie.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Notizia non trovata' });
  notizie.splice(idx, 1);
  writeNotizie(notizie);
  res.json({ success: true });
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

/* ─── Invio email ordine ─── */
app.post('/api/send-order-email', async (req, res) => {
  const { nome, cognome, email, indirizzo, citta, cap, items, totale, spedizione, metodo, orderId } = req.body;

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

/* ─── Instagram API ─── */
async function fetchInstagramCookies() {
  const r = await fetch('https://www.instagram.com/', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
  });
  const setCookies = r.headers.raw()['set-cookie'] || [];
  const cookies = {};
  setCookies.forEach(c => {
    const [pair] = c.split(';');
    const [k, v] = pair.split('=');
    if (k && v) cookies[k.trim()] = v.trim();
  });
  return cookies;
}

function buildCookieString(publicCookies, sessionId) {
  const dsUserId = sessionId.split(':')[0];
  const all = { ...publicCookies, sessionid: sessionId, ds_user_id: dsUserId };
  return Object.entries(all).map(([k, v]) => `${k}=${v}`).join('; ');
}

app.get('/api/instagram', async (req, res) => {
  if (!INSTAGRAM_SESSION_ID) {
    return res.json({
      source: 'static',
      username: INSTAGRAM_USERNAME,
      profileUrl: `https://www.instagram.com/${INSTAGRAM_USERNAME}/`,
      message: 'Configura INSTAGRAM_SESSION_ID nel file .env per mostrare i post reali.',
      recentPosts: [],
    });
  }

  try {
    const publicCookies = await fetchInstagramCookies();
    const cookieStr = buildCookieString(publicCookies, INSTAGRAM_SESSION_ID);

    const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram/304.0.0.31.113';
    const hdrs = {
      'User-Agent':  mobileUA,
      'Accept':      '*/*',
      'X-IG-App-ID': '936619743392459',
      'Cookie':      cookieStr,
    };

    const profileRes = await fetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${INSTAGRAM_USERNAME}`,
      {
        headers: {
          ...hdrs,
          'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer':          'https://www.instagram.com/',
        },
        redirect: 'follow',
      }
    );

    console.log('[Instagram] Status profilo:', profileRes.status);
    if (!profileRes.ok) throw new Error(`HTTP ${profileRes.status} (profilo)`);

    const profileJson = await profileRes.json();
    const user = profileJson?.data?.user;
    if (!user) throw new Error('campo user non trovato');

    const USER_ID = user.id;

    const feedRes = await fetch(
      `https://i.instagram.com/api/v1/feed/user/${USER_ID}/?count=3`,
      { headers: hdrs, redirect: 'follow' }
    );

    console.log('[Instagram] Status feed:', feedRes.status);
    if (!feedRes.ok) throw new Error(`HTTP ${feedRes.status} (feed)`);

    const feedJson = await feedRes.json();
    const items = feedJson.items || [];

    const posts = items.slice(0, 3).map(item => ({
      id:        item.pk,
      shortcode: item.code,
      url:       `https://www.instagram.com/p/${item.code}/`,
      thumbnail: item.image_versions2?.candidates?.[0]?.url || '',
      caption:   item.caption?.text || '',
      likes:     item.like_count || 0,
      comments:  item.comment_count || 0,
      timestamp: item.taken_at,
      isVideo:   item.media_type === 2,
    }));

    return res.json({
      source:    'instagram_api',
      username:  user.username,
      fullName:  user.full_name,
      bio:       user.biography,
      followers: user.edge_followed_by?.count || 0,
      following: user.edge_follow?.count || 0,
      posts:     user.edge_owner_to_timeline_media?.count || 0,
      avatar:    user.profile_pic_url_hd || user.profile_pic_url,
      recentPosts: posts,
    });

  } catch (err) {
    console.log('[Instagram] Errore:', err.message);
    return res.json({
      source: 'static',
      username: INSTAGRAM_USERNAME,
      profileUrl: `https://www.instagram.com/${INSTAGRAM_USERNAME}/`,
      message: `Errore Instagram: ${err.message}`,
      recentPosts: [],
    });
  }
});

/* ─── FIPAV Partite ─── */
const FIPAV_URL = 'https://caserta.portalefipav.net/risultati-classifiche.aspx?ComitatoId=19&StId=2281&DataDa=&StatoGara=&CId=&SId=5150&PId=7261&btFiltro=CERCA';

function parseFipavMatches(html) {
  function stripTags(s) {
    return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Pass 1: collect all <caption> category headings with their position in the HTML
  const categories = [];
  const capRe = /<caption[^>]*>([\s\S]*?)<\/caption>/gi;
  let capm;
  while ((capm = capRe.exec(html)) !== null) {
    const text = stripTags(capm[1]).trim();
    if (text.length > 4 && /[a-zA-Z]/.test(text)) {
      categories.push({ pos: capm.index, text });
    }
  }

  // Pass 2: parse match rows and assign the nearest preceding category
  const matches = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const tds = [];
    let tdMatch;
    while ((tdMatch = tdRe.exec(row)) !== null) {
      tds.push(stripTags(tdMatch[1]));
    }

    if (tds.length >= 6) {
      const [gara, giornata, dataOra, casa, ospite, risultato] = tds;
      if (/^\d+$/.test(gara.trim()) && /\d{2}\/\d{2}\/\d{2}/.test(dataOra)) {
        const score = risultato.trim();
        const played = /\d\s*-\s*\d/.test(score);

        const dm = dataOra.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
        let timestamp = null;
        let dateFormatted = dataOra.trim();
        if (dm) {
          const [, dd, mm, yy, hh, min] = dm;
          timestamp = new Date(`20${yy}-${mm}-${dd}T${hh}:${min}:00`).getTime();
          dateFormatted = `${dd}/${mm}/20${yy} ${hh}:${min}`;
        }

        // Find the last category whose position is before this row
        const rowPos = rowMatch.index;
        let categoria = '';
        for (const cat of categories) {
          if (cat.pos < rowPos) categoria = cat.text;
          else break;
        }

        matches.push({
          id: gara.trim(),
          giornata: giornata.trim(),
          dataOra: dateFormatted,
          timestamp,
          casa: casa.trim(),
          ospite: ospite.trim(),
          risultato: score,
          played,
          categoria,
        });
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
    // DEBUG: mostra i 300 caratteri prima della prima partita
    const idx702 = html.indexOf('>702<');
    if (idx702 !== -1) console.log('[Partite] HTML prima di 702:', JSON.stringify(html.slice(Math.max(0, idx702 - 1000), idx702)));

    const all = parseFipavMatches(html);
    console.log('[Partite] match trovati:', all.length);
    console.log('[Partite] prime 3 categorie:', all.slice(0, 3).map(m => `"${m.categoria}"`));

    all.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const past    = all.filter(m => m.played);
    const future  = all.filter(m => !m.played);

    res.json({
      ultime:   past.slice(-3),
      prossime: future.slice(0, 3),
      fipavUrl: FIPAV_URL,
    });
  } catch (err) {
    console.log('[Partite] Errore:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

app.listen(PORT, () => {
  console.log(`Server avviato su http://localhost:${PORT}`);
  if (!INSTAGRAM_SESSION_ID) {
    console.log('[Instagram] Nessun session ID configurato.');
  } else {
    console.log('[Instagram] Session ID rilevato e decodificato.');
  }
});
