/* shared.js — public navbar + footer + auth for Virtus Caserta */
(function () {

  /* ── Active page detection ── */
  var _p = window.location.pathname.replace(/\/$/, '') || '/';
  function _ac(href) {
    if (href === '/') return _p === '' || _p === '/';
    return _p === href || _p.startsWith(href + '/');
  }
  function _cls(href) { return _ac(href) ? ' class="attivo"' : ''; }
  function _drc(href) { return _ac(href) ? ' attivo' : ''; }

  /* ── Nav HTML (mirrors index.html exactly, absolute image paths) ── */
  var _nav =
  '<nav class="nav-std">' +
    '<ul class="nav-menu">' +
      '<li class="nav-hashtag"><span>#noisiamolasquadra</span></li>' +
      '<li><a href="/chi-siamo"' + _cls('/chi-siamo') + '>Chi siamo</a></li>' +
      '<li><a href="/notizie"' + _cls('/notizie') + '>Notizie</a></li>' +
      '<li class="nav-dropdown">' +
        '<span class="nav-dropdown-toggle">Noi</span>' +
        '<ul class="nav-dropdown-menu">' +
          '<li><a href="/squadra"' + _cls('/squadra') + '>Squadra</a></li>' +
          '<li><a href="/staff"' + _cls('/staff') + '>Staff</a></li>' +
        '</ul>' +
      '</li>' +
    '</ul>' +
    '<a href="/" class="nav-brand">' +
      '<img src="/images/negativo@4x.png" alt="Virtus Caserta" onerror="this.style.display=\'none\'">' +
      '<span class="nav-hashtag-m">#noisiamolasquadra</span>' +
    '</a>' +
    '<div class="nav-actions">' +
      '<ul class="nav-menu" style="justify-content:flex-start;">' +
        '<li><a href="/risultati"' + _cls('/risultati') + '>Risultati</a></li>' +
        '<li><a href="/shop"' + _cls('/shop') + '>Shop</a></li>' +
        '<li><a href="/live"' + _cls('/live') + '>Live</a></li>' +
      '</ul>' +
    '</div>' +
    '<a class="nav-auth-icon" id="navAuthIcon" href="/login" aria-label="Accedi" title="Accedi">' +
      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-3.3 0-10 1.7-10 5v2h20v-2c0-3.3-6.7-5-10-5z"/></svg>' +
    '</a>' +
    '<button class="nav-hamburger" id="navHamburger" onclick="toggleDrawer()" aria-label="Menu">' +
      '<span></span><span></span><span></span>' +
    '</button>' +
  '</nav>' +
  '<div id="navAuthBar">' +
    '<div id="navLoginArea"><a href="/login" class="nav-login-btn">Accedi</a></div>' +
    '<div id="navLoggedArea" style="display:none; align-items:center; gap:10px;">' +
      '<a href="/utente" class="nav-login-btn" id="navUtenteLink" style="display:none">Area Utente</a>' +
      '<a href="/admin" class="nav-login-btn" id="navAdminLink" style="display:none">Amministratore</a>' +
    '</div>' +
  '</div>' +
  '<div class="nav-drawer" id="navDrawer">' +
    '<div class="drawer-logo"><img src="/images/negativo@4x.png" alt="Virtus Caserta" onerror="this.style.display=\'none\'"></div>' +
    '<a href="/" class="drawer-link' + _drc('/') + '" onclick="chiudiDrawer()">Home</a>' +
    '<a href="/chi-siamo" class="drawer-link' + _drc('/chi-siamo') + '" onclick="chiudiDrawer()">Chi siamo</a>' +
    '<a href="/notizie" class="drawer-link' + _drc('/notizie') + '" onclick="chiudiDrawer()">Notizie</a>' +
    '<a href="/squadra" class="drawer-link' + _drc('/squadra') + '" onclick="chiudiDrawer()">Squadra</a>' +
    '<a href="/staff" class="drawer-link' + _drc('/staff') + '" onclick="chiudiDrawer()">Staff</a>' +
    '<a href="/risultati" class="drawer-link' + _drc('/risultati') + '" onclick="chiudiDrawer()">Risultati</a>' +
    '<a href="/shop" class="drawer-link' + _drc('/shop') + '" onclick="chiudiDrawer()">Shop</a>' +
    '<a href="/live" class="drawer-link' + _drc('/live') + '" onclick="chiudiDrawer()">Live</a>' +
    '<div class="drawer-hashtag">#noisiamolasquadra</div>' +
    '<div class="drawer-social">' +
      '<a href="https://www.facebook.com/virtuscaserta" target="_blank" rel="noopener" title="Facebook"><img src="/images/facebook-icon.png" alt="Facebook"></a>' +
      '<a href="https://www.instagram.com/virtuscaserta/" target="_blank" rel="noopener" title="Instagram"><img src="/images/instagram-icon.png" alt="Instagram"></a>' +
      '<a href="https://www.youtube.com/@virtuscaserta" target="_blank" rel="noopener" title="YouTube"><img src="/images/youtube-logo-removebg-preview.png" alt="YouTube"></a>' +
      '<a href="https://www.twitch.tv/virtuscaserta" target="_blank" rel="noopener" title="Twitch"><img src="/images/Twitch-logo-removebg-preview.png" alt="Twitch"></a>' +
    '</div>' +
  '</div>';

  /* ── Footer HTML (mirrors index.html exactly, absolute image paths) ── */
  var _footer =
  '<footer class="footer-std">' +
    '<div class="footer-inner">' +
      '<img src="/images/negativo@4x.png" alt="Virtus Caserta" loading="lazy" onerror="this.style.display=\'none\'">' +
      '<div class="footer-links">' +
        '<a href="/">Home</a>' +
        '<a href="/chi-siamo">Chi siamo</a>' +
        '<a href="/notizie">Notizie</a>' +
        '<a href="/risultati">Risultati</a>' +
        '<a href="/shop">Shop</a>' +
        '<a href="/live">Live</a>' +
      '</div>' +
      '<div class="footer-soc">' +
        '<a href="https://www.facebook.com/virtuscaserta" target="_blank" rel="noopener" title="Facebook"><img src="/images/facebook-icon.png" alt="Facebook"></a>' +
        '<a href="https://www.instagram.com/virtuscaserta/" target="_blank" rel="noopener" title="Instagram"><img src="/images/instagram-icon.png" alt="Instagram"></a>' +
        '<a href="https://www.youtube.com/@virtuscaserta" target="_blank" rel="noopener" title="YouTube"><img src="/images/youtube-logo-removebg-preview.png" alt="YouTube"></a>' +
        '<a href="https://www.twitch.tv/virtuscaserta" title="Twitch"><img src="/images/Twitch-logo-removebg-preview.png" alt="Twitch"></a>' +
      '</div>' +
    '</div>' +
    '<div class="footer-bottom">' +
      '<p>© 2024 <strong>Virtus Caserta</strong> – Società Sportiva Pallavolo · <a href="/privacy">Privacy</a> · <a href="/termini">Termini</a> · Sito realizzato da Alessandro Pascarella</p>' +
    '</div>' +
  '</footer>';

  /* ── Extra CSS (not in common.css) ── */
  var _css =
    '.nav-login-btn{background:#f57c00;color:#fff;border:none;border-radius:50px;padding:6px 16px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;transition:background .2s;white-space:nowrap;}' +
    '.nav-login-btn:hover{background:#d4520a;}' +
    '#navAuthBar{position:fixed;top:0;right:40px;height:76px;display:flex;align-items:center;gap:10px;z-index:1001;}' +
    '#navLoggedArea,#navUtenteLink,#navAdminLink{display:none;}' +
    '.nav-auth-icon{display:none;width:44px;height:44px;border-radius:50%;align-items:center;justify-content:center;color:#fff;text-decoration:none;transition:background .2s,color .2s;flex-shrink:0;}' +
    '.nav-auth-icon:hover{background:rgba(255,255,255,.12);}' +
    '.nav-auth-icon svg{display:block;width:24px;height:24px;}' +
    '.nav-auth-icon[data-role="admin"]{color:#f57c00;}' +
    '.nav-hashtag-m{display:none;}' +
    '@media(max-width:768px){' +
      '#navAuthBar{display:none!important;}' +
      '.nav-auth-icon{display:flex;}' +
      'nav.nav-std{grid-template-columns:1fr auto auto!important;}' +
      'nav.nav-std>.nav-auth-icon{grid-column:2;grid-row:1;justify-self:end;}' +
      'nav.nav-std>.nav-hamburger{grid-column:3!important;}' +
      '.nav-hashtag-m{display:inline;font-size:10px;font-weight:900;letter-spacing:1.5px;color:rgba(255,255,255,.55);text-transform:uppercase;white-space:nowrap;}' +
    '}';

  /* ── Inject CSS only ── */
  function _injectCSS() {
    var s = document.createElement('style');
    s.textContent = _css;
    document.head.appendChild(s);
  }

  /* ── Inject nav + footer + CSS ── */
  function _inject() {
    _injectCSS();

    // Remove any existing nav + related elements before injecting shared ones
    var existing = document.querySelectorAll('nav');
    existing.forEach(function(n) { n.parentNode && n.parentNode.removeChild(n); });
    var ab = document.getElementById('navAuthBar');
    if (ab) ab.parentNode.removeChild(ab);
    var dr = document.getElementById('navDrawer');
    if (dr) dr.parentNode.removeChild(dr);

    // Inject nav at top of body
    document.body.insertAdjacentHTML('afterbegin', _nav);

    // Replace existing footer or append
    var ef = document.querySelector('footer');
    if (ef) {
      ef.outerHTML = _footer;
    } else {
      document.body.insertAdjacentHTML('beforeend', _footer);
    }
  }

  /* ── Auth functions (global) ── */
  window.aggiornaNavbar = async function () {
    var isLoggedIn = false, isAdmin = false;
    try {
      var d = await fetch('/api/me').then(function(r) { return r.json(); });
      isLoggedIn = !!d.auth;
      isAdmin = isLoggedIn && (d.role === 'admin' || d.role === 'dirigente');
    } catch (e) {}
    var showUtente = isLoggedIn && !isAdmin;
    var nla = document.getElementById('navLoginArea');
    var nlo = document.getElementById('navLoggedArea');
    var nul = document.getElementById('navUtenteLink');
    var nal = document.getElementById('navAdminLink');
    if (nla) nla.style.display = isLoggedIn ? 'none' : '';
    if (nlo) nlo.style.display = isLoggedIn ? 'flex' : 'none';
    if (nul) nul.style.display = showUtente ? 'inline-flex' : 'none';
    if (nal) nal.style.display = isAdmin ? 'inline-flex' : 'none';
    var icon = document.getElementById('navAuthIcon');
    if (icon) {
      if (isAdmin) {
        icon.href = '/admin'; icon.title = 'Amministratore';
        icon.setAttribute('aria-label', 'Amministratore');
        icon.setAttribute('data-role', 'admin');
      } else if (showUtente) {
        icon.href = '/utente'; icon.title = 'Area Utente';
        icon.setAttribute('aria-label', 'Area Utente');
        icon.setAttribute('data-role', 'utente');
      } else {
        icon.href = '/login'; icon.title = 'Accedi';
        icon.setAttribute('aria-label', 'Accedi');
        icon.removeAttribute('data-role');
      }
    }
  };

  window.toggleDrawer = function () {
    document.getElementById('navHamburger').classList.toggle('aperto');
    document.getElementById('navDrawer').classList.toggle('aperto');
    document.body.classList.toggle('nav-aperta');
  };

  window.chiudiDrawer = function () {
    document.getElementById('navHamburger').classList.remove('aperto');
    document.getElementById('navDrawer').classList.remove('aperto');
    document.body.classList.remove('nav-aperta');
  };

  window.logout = async function () {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
    location.reload();
  };

  /* ── Bootstrap ── */
  function _boot() {
    if (_p === '/') { _injectCSS(); } else { _inject(); }
    window.aggiornaNavbar();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }

})();
