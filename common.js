/* ── Hamburger Nav (mobile ≤ 768px) ── */
(function () {
  const nav = document.querySelector('nav');
  if (!nav || !nav.querySelector('.nav-brand') || !nav.querySelector('.nav-menu')) return;

  nav.classList.add('nav-std');

  // Hamburger button
  const btn = document.createElement('button');
  btn.className = 'nav-hamburger';
  btn.setAttribute('aria-label', 'Apri menu');
  btn.innerHTML = '<span></span><span></span><span></span>';
  nav.appendChild(btn);

  // Full-screen drawer
  const drawer = document.createElement('div');
  drawer.className = 'nav-drawer';

  // Logo in drawer
  const logoWrap = document.createElement('div');
  logoWrap.className = 'drawer-logo';
  logoWrap.innerHTML = '<a href="/"><img src="/images/negativo@4x.png" alt="Virtus Caserta"></a>';
  drawer.appendChild(logoWrap);

  // Raccoglie tutti i link dalla nav (escludi brand e social)
  const seen = new Set();
  nav.querySelectorAll('a[href]').forEach(a => {
    if (a.classList.contains('nav-brand') || a.closest('.nav-social')) return;
    const text = a.textContent.trim();
    const href = a.getAttribute('href');
    if (!text || seen.has(text)) return;
    seen.add(text);
    const link = document.createElement('a');
    link.href  = href;
    link.className = 'drawer-link' + (a.classList.contains('attivo') ? ' attivo' : '');
    link.textContent = text;
    drawer.appendChild(link);
  });

  // Hashtag
  const ht = document.createElement('div');
  ht.className = 'drawer-hashtag';
  ht.textContent = '#noisiamolasquadra';
  drawer.appendChild(ht);

  // Social icons
  const socialLinks = nav.querySelectorAll('.nav-social a');
  if (socialLinks.length) {
    const row = document.createElement('div');
    row.className = 'drawer-social';
    socialLinks.forEach(s => row.appendChild(s.cloneNode(true)));
    drawer.appendChild(row);
  }

  document.body.appendChild(drawer);

  let isOpen = false;
  function openMenu() {
    isOpen = true;
    btn.classList.add('aperto');
    btn.setAttribute('aria-label', 'Chiudi menu');
    drawer.classList.add('aperto');
    document.body.classList.add('nav-aperta');
  }
  function closeMenu() {
    isOpen = false;
    btn.classList.remove('aperto');
    btn.setAttribute('aria-label', 'Apri menu');
    drawer.classList.remove('aperto');
    document.body.classList.remove('nav-aperta');
  }

  btn.addEventListener('click', () => isOpen ? closeMenu() : openMenu());
  drawer.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) closeMenu(); });
})();

/* ── Cookie Banner GDPR ── */
(function () {
  const KEY = 'vc_cookie_consent';
  if (localStorage.getItem(KEY)) return;

  const banner = document.createElement('div');
  banner.id = 'cookie-banner';
  banner.innerHTML = `
    <div style="max-width:700px">
      <p style="margin:0 0 8px;font-weight:700;font-size:15px">🍪 Utilizziamo i cookie</p>
      <p style="margin:0;font-size:13px;color:rgba(255,255,255,.75)">
        Questo sito utilizza cookie tecnici necessari al funzionamento e, previo consenso, cookie analitici per migliorare la navigazione.
        <a href="/privacy" style="color:#ff9800;text-decoration:underline">Privacy Policy</a>
      </p>
    </div>
    <div style="display:flex;gap:10px;flex-shrink:0;margin-top:10px">
      <button id="cookie-accept" style="background:#f57c00;color:#fff;border:none;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">Accetta</button>
      <button id="cookie-reject" style="background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.3);padding:10px 22px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">Solo tecnici</button>
    </div>`;
  Object.assign(banner.style, {
    position:'fixed', bottom:'0', left:'0', right:'0', zIndex:'9999',
    background:'#0d2055', color:'#fff', padding:'18px 28px',
    display:'flex', alignItems:'center', justifyContent:'space-between',
    gap:'20px', flexWrap:'wrap', boxShadow:'0 -4px 20px rgba(0,0,0,.25)',
  });
  document.body.appendChild(banner);

  function accept(val) {
    localStorage.setItem(KEY, val);
    banner.remove();
    if (val === 'all' && window._vcAnalyticsInit) window._vcAnalyticsInit();
  }
  document.getElementById('cookie-accept').onclick = () => accept('all');
  document.getElementById('cookie-reject').onclick  = () => accept('minimal');
})();

/* ── WhatsApp floating button ── */
(function () {
  const WA_NUMBER = ''; // es. '393331234567' — lascia vuoto per nascondere
  if (!WA_NUMBER) return;
  const btn = document.createElement('a');
  btn.href   = `https://wa.me/${WA_NUMBER}`;
  btn.target = '_blank';
  btn.rel    = 'noopener';
  btn.title  = 'Scrivici su WhatsApp';
  btn.innerHTML = `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:30px;height:30px"><path fill="#fff" d="M16 2C8.27 2 2 8.27 2 16c0 2.44.65 4.73 1.79 6.72L2 30l7.52-1.97A13.93 13.93 0 0016 30c7.73 0 14-6.27 14-14S23.73 2 16 2zm6.77 19.18c-.28.79-1.63 1.52-2.24 1.6-.58.07-1.3.1-2.1-.13-.48-.14-1.1-.33-1.9-.65-3.35-1.44-5.53-4.82-5.7-5.05-.17-.22-1.36-1.8-1.36-3.44s.86-2.44 1.17-2.77c.3-.33.66-.41.88-.41.22 0 .44 0 .63.01.2.01.48-.08.75.57.28.67.95 2.32 1.04 2.49.09.17.14.37.03.59-.11.22-.17.36-.33.55-.17.2-.35.44-.5.59-.17.17-.34.35-.15.68.2.33.87 1.43 1.86 2.32 1.28 1.14 2.36 1.5 2.69 1.66.33.17.53.14.72-.08.2-.22.84-.98 1.07-1.31.22-.33.44-.28.74-.17.3.11 1.91.9 2.24 1.06.33.17.55.25.63.39.08.14.08.79-.2 1.59z"/></svg>`;
  Object.assign(btn.style, {
    position:'fixed', bottom:'90px', right:'20px', zIndex:'8888',
    width:'56px', height:'56px', borderRadius:'50%',
    background:'#25d366', display:'flex', alignItems:'center', justifyContent:'center',
    boxShadow:'0 4px 16px rgba(0,0,0,.25)', transition:'transform .2s',
  });
  btn.onmouseenter = () => btn.style.transform = 'scale(1.1)';
  btn.onmouseleave = () => btn.style.transform = 'scale(1)';
  document.body.appendChild(btn);
})();

/* ── Push Notifications subscribe ── */
async function vcSubscribePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const { key } = await fetch('/api/push/vapid-key').then(r => r.json());
    if (!key) return;
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!reg) return;
    const existing = await reg.pushManager.getSubscription();
    if (existing) return;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    const j = sub.toJSON();
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
    });
  } catch {}
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* ── Auth module (modal + footer account) ── */
(function () {
  // Modal CSS
  if (!document.getElementById('vc-auth-style')) {
    const s = document.createElement('style');
    s.id = 'vc-auth-style';
    s.textContent = `
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;align-items:center;justify-content:center;padding:16px}
.modal-overlay.aperta{display:flex}
.modal-box{background:#fff;border-radius:20px;padding:32px 28px 28px;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.3);position:relative}
.modal-close{position:absolute;top:16px;right:20px;background:none;border:none;font-size:22px;cursor:pointer;color:#9ca3af;line-height:1}
.modal-close:hover{color:#0d2055}
.modal-tabs{display:flex;margin-bottom:28px;border-bottom:2px solid #e2e8f0}
.modal-tab{flex:1;background:none;border:none;padding:12px 0;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9ca3af;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;transition:color .2s,border-color .2s}
.modal-tab.attiva{color:#0d2055;border-bottom-color:#f57c00}
.modal-panel{display:none}.modal-panel.attivo{display:block}
.modal-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.modal-field label{font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#374151}
.modal-field input{padding:11px 14px;border:1.5px solid #d1d5db;border-radius:10px;font-size:14px;outline:none;transition:border-color .2s;width:100%;box-sizing:border-box}
.modal-field input:focus{border-color:#0d2055}
.modal-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.modal-submit{width:100%;padding:13px;background:#f57c00;color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;transition:background .2s;margin-top:4px}
.modal-submit:hover{background:#d4520a}
.modal-error{color:#dc2626;font-size:13px;margin-top:10px;min-height:18px}
.modal-success{color:#16a34a;font-size:13px;margin-top:10px;min-height:18px}
.footer-auth{display:flex;flex-direction:column;gap:10px}
.footer-auth-title{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:4px}
.footer-auth-login a,.footer-auth-login button{cursor:pointer}
.footer-auth-logged{display:none;align-items:center;gap:12px}
#footerAuthArea.logged .footer-auth-login{display:none}
#footerAuthArea.logged .footer-auth-logged{display:flex}
.footer-auth-nome{color:#fff;font-weight:700;font-size:14px}
.footer-btn{display:inline-flex;align-items:center;background:#f57c00;color:#fff;border:none;border-radius:50px;padding:8px 20px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;text-decoration:none;transition:background .2s;white-space:nowrap}
.footer-btn:hover{background:#d4520a}
.footer-btn-outline{background:transparent;border:1px solid rgba(255,255,255,.25);color:rgba(255,255,255,.65)}
.footer-btn-outline:hover{background:rgba(255,255,255,.08);color:#fff}
footer.footer-std .footer-acc{display:flex;flex-direction:column;gap:8px;align-items:flex-end}
footer.footer-std .footer-acc-title{font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,.35)}
@media(max-width:600px){footer.footer-std .footer-acc{align-items:center}}
    `;
    document.head.appendChild(s);
  }

  // Inject modal if not already in DOM
  if (!document.getElementById('modalLogin')) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="modal-overlay" id="modalLogin" onclick="if(event.target===this)window.chiudiModal&&chiudiModal()">
  <div class="modal-box">
    <button class="modal-close" onclick="chiudiModal()">✕</button>
    <div class="modal-tabs">
      <button class="modal-tab attiva" id="tabAccedi" onclick="switchTab('accedi')">Accedi</button>
      <button class="modal-tab" id="tabRegistrati" onclick="switchTab('registrati')">Registrati</button>
    </div>
    <div class="modal-panel attivo" id="panelAccedi">
      <div class="modal-field"><label>Email</label><input type="email" id="loginEmail" placeholder="tua@email.com" autocomplete="email"></div>
      <div class="modal-field"><label>Password</label><input type="password" id="loginPassword" placeholder="••••••" autocomplete="current-password"></div>
      <button class="modal-submit" onclick="submitLogin()">Accedi</button>
      <div class="modal-error" id="loginError"></div>
    </div>
    <div class="modal-panel" id="panelRegistrati">
      <div class="modal-row">
        <div class="modal-field"><label>Nome</label><input type="text" id="regNome" placeholder="Mario"></div>
        <div class="modal-field"><label>Cognome</label><input type="text" id="regCognome" placeholder="Rossi"></div>
      </div>
      <div class="modal-field"><label>Email</label><input type="email" id="regEmail" placeholder="tua@email.com" autocomplete="email"></div>
      <div class="modal-field"><label>Conferma Email</label><input type="email" id="regEmailConferma" placeholder="Ripeti email"></div>
      <div class="modal-field"><label>Password</label><input type="password" id="regPassword" placeholder="Almeno 6 caratteri" autocomplete="new-password"></div>
      <div class="modal-field"><label>Conferma Password</label><input type="password" id="regPasswordConferma" placeholder="Ripeti password" autocomplete="new-password"></div>
      <button class="modal-submit" onclick="submitRegistrazione()">Crea account</button>
      <div class="modal-error" id="regError"></div>
      <div class="modal-success" id="regSuccess"></div>
    </div>
  </div>
</div>`;
    document.body.appendChild(wrap.firstElementChild);
  }

  // Define auth functions only if not already defined
  if (!window.apriModal) {
    window.apriModal = function () {
      const el = document.getElementById('modalLogin');
      if (el) el.classList.add('aperta');
      const err = document.getElementById('loginError');
      if (err) err.textContent = '';
    };
    window.chiudiModal = function () {
      const el = document.getElementById('modalLogin');
      if (el) el.classList.remove('aperta');
    };
    window.switchTab = function (tab) {
      const isAcc = tab === 'accedi';
      document.getElementById('tabAccedi').classList.toggle('attiva', isAcc);
      document.getElementById('tabRegistrati').classList.toggle('attiva', !isAcc);
      document.getElementById('panelAccedi').classList.toggle('attivo', isAcc);
      document.getElementById('panelRegistrati').classList.toggle('attivo', !isAcc);
    };
    window.submitLogin = async function () {
      const errEl = document.getElementById('loginError');
      errEl.textContent = '';
      const email    = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;
      if (!email || !password) { errEl.textContent = 'Inserisci email e password.'; return; }
      try {
        const res  = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error; return; }
        localStorage.setItem('vc_token', data.token);
        localStorage.setItem('vc_role',  data.role);
        localStorage.setItem('vc_nome',  data.nome);
        window.chiudiModal();
        _vcUpdateAuthUI();
      } catch { errEl.textContent = 'Errore di rete. Riprova.'; }
    };
    window.submitRegistrazione = async function () {
      const errEl = document.getElementById('regError');
      const okEl  = document.getElementById('regSuccess');
      errEl.textContent = ''; okEl.textContent = '';
      const nome             = document.getElementById('regNome').value.trim();
      const cognome          = document.getElementById('regCognome').value.trim();
      const email            = document.getElementById('regEmail').value.trim();
      const emailConferma    = document.getElementById('regEmailConferma').value.trim();
      const password         = document.getElementById('regPassword').value;
      const passwordConferma = document.getElementById('regPasswordConferma').value;
      if (!nome || !cognome || !email || !emailConferma || !password || !passwordConferma) { errEl.textContent = 'Compila tutti i campi.'; return; }
      if (email !== emailConferma) { errEl.textContent = 'Le email non coincidono.'; return; }
      if (password !== passwordConferma) { errEl.textContent = 'Le password non coincidono.'; return; }
      try {
        const res  = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome, cognome, email, password }) });
        const data = await res.json();
        if (!res.ok) { errEl.textContent = data.error; return; }
        if (data.message) { okEl.textContent = data.message; return; }
        localStorage.setItem('vc_token', data.token);
        localStorage.setItem('vc_role',  data.role);
        localStorage.setItem('vc_nome',  data.nome);
        window.chiudiModal();
        _vcUpdateAuthUI();
      } catch { errEl.textContent = 'Errore di rete. Riprova.'; }
    };
    window.logout = function () {
      localStorage.removeItem('vc_token');
      localStorage.removeItem('vc_role');
      localStorage.removeItem('vc_nome');
      _vcUpdateAuthUI();
    };
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') window.chiudiModal && window.chiudiModal();
    });
    ['loginEmail','loginPassword'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') window.submitLogin(); });
    });
  }

  function _vcUpdateAuthUI() {
    const token = localStorage.getItem('vc_token');
    const nome  = localStorage.getItem('vc_nome');
    const role  = localStorage.getItem('vc_role');
    const area  = document.getElementById('footerAuthArea');
    if (!area) return;
    area.classList.toggle('logged', !!token);
    const nomeEl = document.getElementById('footerNome');
    if (nomeEl) nomeEl.textContent = nome || '';
    const adminLink = document.getElementById('footerAdminLink');
    if (adminLink) adminLink.style.display = (role === 'admin' || role === 'dirigente') ? '' : 'none';
  }
  window._vcUpdateAuthUI = _vcUpdateAuthUI;
  _vcUpdateAuthUI();
})();
