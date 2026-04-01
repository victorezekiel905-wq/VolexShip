/* ============================================================
   VeloxShip — Layout: Header & Footer (flat nav, no submenus)
   ============================================================ */

function headerMarkup(page, user) {
  const isAdmin   = user?.role === 'admin';
  const dashHref  = user ? (isAdmin ? 'admin.html' : 'dashboard.html') : 'login.html';
  const dashLabel = user ? (isAdmin ? 'Workspace' : 'Dashboard') : 'Sign in';
  const authBtn   = user
    ? `<button class="btn btn-secondary btn-sm" onclick="logoutUser()"><i class="fa-solid fa-arrow-right-from-bracket"></i>Sign out</button>`
    : `<a class="btn btn-primary btn-sm" href="signup.html">Create account</a>`;

  function navLink(href, label, key) {
    return `<a class="nav-link ${page === key ? 'is-active' : ''}" href="${href}">${label}</a>`;
  }

  const unread = user ? countUnreadMessages(user.email) : 0;
  const msgBadge = (unread > 0 && !isAdmin)
    ? `<span class="nav-badge">${unread}</span>` : '';
  const dashActive = ['admin', 'dashboard'].includes(page) ? 'is-active' : '';

  return `
    <header class="site-header" id="siteHeader">
      <div class="container header-row">
        <a class="site-logo" href="index.html">
          <span class="logo-mark"><img src="logo-v.svg" alt="VeloxShip V logo"></span>
          <strong>Velox<span>Ship</span></strong>
        </a>

        <nav class="site-nav" aria-label="Primary">
          ${navLink('index.html',     'Home',      'home')}
          ${navLink('about.html',     'About',     'about')}
          ${navLink('shipping.html',  'Shipping',  'shipping')}
          ${navLink('tracking.html',  'Tracking',  'tracking')}
          ${navLink('locations.html', 'Locations', 'locations')}
          ${navLink('support.html',   'Support',   'support')}
        </nav>

        <div class="nav-cta">
          <a class="btn btn-secondary btn-sm nav-dash-btn ${dashActive}" href="${dashHref}">
            ${dashLabel}${msgBadge}
          </a>
          ${authBtn}
        </div>

        <button class="icon-btn mobile-nav-toggle" id="mobileNavToggle" aria-label="Toggle menu">
          <i class="fa-solid fa-bars"></i>
        </button>
      </div>

      <div class="mobile-drawer" id="mobileDrawer">
        <div class="mobile-links">
          <a href="index.html">Home</a>
          <a href="about.html">About</a>
          <a href="shipping.html">Shipping</a>
          <a href="tracking.html">Tracking</a>
          <a href="locations.html">Locations</a>
          <a href="support.html">Support</a>
          <hr class="mobile-sep">
          ${user
            ? `<a href="${dashHref}" class="${dashActive}">${dashLabel}${msgBadge}</a><button onclick="logoutUser()">Sign out</button>`
            : `<a href="login.html">Sign in</a><a href="signup.html">Create account</a>`
          }
        </div>
      </div>
    </header>`;
}

function footerMarkup() {
  return `
    <footer class="site-footer">
      <div class="container footer-grid">
        <div class="footer-brand">
          <a class="site-logo" href="index.html">
            <span class="logo-mark"><img src="logo-v.svg" alt="VeloxShip V logo"></span>
            <strong>Velox<span>Ship</span></strong>
          </a>
          <p>World-class logistics with cinematic motion, premium dashboards and responsive customer flows across every screen.</p>
        </div>
        <div class="footer-links">
          <strong>Company</strong>
          <a href="index.html">Home</a>
          <a href="about.html">About Us</a>
          <a href="locations.html">Locations</a>
          <a href="support.html">Support</a>
        </div>
        <div class="footer-links">
          <strong>Shipping</strong>
          <a href="shipping.html">Shipping info</a>
          <a href="shipping.html#rates">Rates</a>
          <a href="shipping.html#freight">Freight</a>
        </div>
        <div class="footer-links">
          <strong>Tracking</strong>
          <a href="tracking.html">Track shipment</a>
          <a href="dashboard.html">Customer dashboard</a>
          <a href="signup.html">Create account</a>
        </div>
      </div>
      <div class="container footer-note">
        <span>VeloxShip premium logistics platform · fully responsive</span>
        <span data-year></span>
      </div>
    </footer>`;
}

function installShell() {
  const shell = document.querySelector('[data-site-shell]');
  if (!shell) return;
  const page = document.body.dataset.page || 'home';
  const user = getCurrentUser();
  shell.insertAdjacentHTML('afterbegin', headerMarkup(page, user));
  shell.insertAdjacentHTML('beforeend', footerMarkup());
}

function installVisualVault() {
  const main = document.querySelector('main');
  if (!main || document.querySelector('.visual-vault')) return;
  const page = document.body.dataset.page || 'home';

  if (page === 'home') {
    const vault = document.createElement('section');
    vault.className = 'section-tight visual-vault';
    const imgs = window.VS_GALLERY_IMAGES || [];
    vault.innerHTML = `
      <div class="container stack">
        <div class="stack reveal visible center">
          <span class="eyebrow">Visual freight library</span>
          <h2 class="section-title vault-title">Every supplied brand image in one premium stream.</h2>
        </div>
        <div class="visual-ribbon">
          <div class="visual-track">
            ${imgs.map(img => `<figure class="visual-tile"><img src="${img}" alt="VeloxShip" loading="lazy"></figure>`).join('')}
            ${imgs.map(img => `<figure class="visual-tile"><img src="${img}" alt="VeloxShip" loading="lazy"></figure>`).join('')}
          </div>
        </div>
        <div class="visual-ribbon reverse">
          <div class="visual-track">
            ${[...imgs].reverse().map(img => `<figure class="visual-tile wide"><img src="${img}" alt="VeloxShip" loading="lazy"></figure>`).join('')}
            ${[...imgs].reverse().map(img => `<figure class="visual-tile wide"><img src="${img}" alt="VeloxShip" loading="lazy"></figure>`).join('')}
          </div>
        </div>
      </div>`;
    const anchor = document.querySelector('.route-marquee') || main.firstElementChild;
    anchor?.insertAdjacentElement('afterend', vault);
    return;
  }

  const slices = {
    about:    ['premium-gallery-01.jpeg', 'cargo-ship.jpeg', 'worker-containers.jpeg', 'world-map-a.jpeg'],
    shipping: ['premium-gallery-07.jpeg', 'premium-gallery-10.jpeg', 'premium-gallery-14.jpeg'],
    tracking: ['premium-gallery-06.jpeg', 'premium-gallery-11.jpeg', 'premium-gallery-12.jpeg'],
    support:  ['premium-gallery-08.jpeg', 'premium-gallery-16.jpeg', 'premium-gallery-17.jpeg'],
    locations:['premium-gallery-01.jpeg', 'premium-gallery-09.jpeg', 'premium-gallery-15.jpeg'],
    auth:     ['premium-gallery-02.jpeg', 'premium-gallery-04.jpeg', 'premium-gallery-12.jpeg']
  };
  const images = slices[page];
  if (!images) return;

  const compact = document.createElement('section');
  compact.className = 'section-tight compact-vault';
  compact.innerHTML = `
    <div class="container compact-vault-grid${page === 'about' ? ' about-mission-gallery' : ''} reveal visible">
      ${images.map((img, i) => `<figure class="compact-vault-card card-shift-${i + 1}">
        <img src="${img}" alt="VeloxShip" loading="lazy">
      </figure>`).join('')}
    </div>`;
  const anchor = page === 'about'
    ? main.querySelector('.section')
    : main.querySelector('.page-hero, .auth-shell');
  anchor?.insertAdjacentElement('afterend', compact);
}

function installGlobalInteractions() {
  const header = document.getElementById('siteHeader');
  const toggle = document.getElementById('mobileNavToggle');
  const drawer = document.getElementById('mobileDrawer');

  if (toggle && drawer) {
    toggle.addEventListener('click', () => {
      drawer.classList.toggle('active');
      toggle.querySelector('i').className = drawer.classList.contains('active')
        ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.site-header')) {
        drawer.classList.remove('active');
        if (toggle.querySelector('i')) toggle.querySelector('i').className = 'fa-solid fa-bars';
      }
    });
  }

  const onScroll = () => {
    if (header) header.classList.toggle('scrolled', window.scrollY > 12);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Safety fallback: reveal all elements after 2s if JS observer is slow
  setTimeout(() => {
    document.querySelectorAll(".reveal").forEach(el => el.classList.add("visible"));
  }, 2000);

  const revealObserver = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
  }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
  document.querySelectorAll('.reveal').forEach((el, i) => {
    el.style.setProperty('--reveal-delay', `${Math.min(i * 60, 400)}ms`);
    revealObserver.observe(el);
  });

  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', e => {
      const target = document.querySelector(link.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  document.querySelectorAll('[data-year]').forEach(el => {
    el.textContent = `© ${new Date().getFullYear()} VeloxShip`;
  });

  document.querySelectorAll('.btn, .feature-card, .metric, .shipment-card, .dashboard-card, .media-card').forEach((el, i) => {
    if (el.classList.contains('feature-card') || el.classList.contains('metric') ||
        el.classList.contains('shipment-card') || el.classList.contains('dashboard-card')) {
      el.classList.add('premium-hover-lift');
    }
    el.style.setProperty('--reveal-delay', `${Math.min(i * 50, 350)}ms`);
  });
}

function installAmbientMotion() {
  document.body.classList.add('ambient-motion');
  const targets = document.querySelectorAll('.hero-panel .floating-card, .page-hero .media-card, .page-grid .media-card, .auth-visual, .metric, .dashboard-card, .compact-vault-card, .visual-tile, .table-card');
  targets.forEach((el, i) => {
    if (el.classList.contains('motion-float')) return;
    el.classList.add('motion-float');
    el.style.setProperty('--float-duration', `${13 + (i % 4) * 1.75}s`);
    el.style.setProperty('--float-delay', `${(i % 5) * -1.2}s`);
  });
}

function installAboutHeroTransitions() {
  const slides = document.querySelectorAll('.about-hero-slider .hero-slide');
  if (!slides.length) return;
  let index = 0;
  const show = next => slides.forEach((slide, i) => slide.classList.toggle('is-active', i === next));
  show(index);
  window.setInterval(() => {
    index = (index + 1) % slides.length;
    show(index);
  }, 3800);
}

function installVisualVaultLightbox() {
  const images = document.querySelectorAll('.visual-vault .visual-tile img');
  if (!images.length || document.querySelector('.gallery-lightbox')) return;

  const lightbox = document.createElement('div');
  lightbox.className = 'gallery-lightbox';
  lightbox.setAttribute('aria-hidden', 'true');
  lightbox.innerHTML = `
    <div class="gallery-lightbox-dialog" role="dialog" aria-modal="true" aria-label="Expanded gallery image">
      <button class="gallery-lightbox-close" type="button" aria-label="Close image preview">
        <i class="fa-solid fa-xmark"></i>
      </button>
      <img class="gallery-lightbox-image" src="" alt="Expanded gallery image">
    </div>`;

  const dialog = lightbox.querySelector('.gallery-lightbox-dialog');
  const preview = lightbox.querySelector('.gallery-lightbox-image');
  const closeBtn = lightbox.querySelector('.gallery-lightbox-close');

  const closeLightbox = () => {
    lightbox.classList.remove('open');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('gallery-lightbox-open');
  };

  images.forEach(img => {
    img.addEventListener('click', () => {
      preview.src = img.currentSrc || img.src;
      preview.alt = img.alt || 'Expanded gallery image';
      lightbox.classList.add('open');
      lightbox.setAttribute('aria-hidden', 'false');
      document.body.classList.add('gallery-lightbox-open');
    });
  });

  closeBtn.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', event => {
    if (!dialog.contains(event.target) || event.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && lightbox.classList.contains('open')) closeLightbox();
  });

  document.body.appendChild(lightbox);
}

function installFloatingSocialPanel() {
  if (document.querySelector('.social-panel')) return;
  const panel = document.createElement('div');
  panel.className = 'social-panel';
  panel.innerHTML = `
    <div class="social-panel-menu" aria-label="Social and contact links">
      <a class="social-link" href="https://wa.me/18008356901" target="_blank" rel="noreferrer"><i class="fa-brands fa-whatsapp"></i><span>WhatsApp</span></a>
      <a class="social-link" href="mailto:support@veloxship.com"><i class="fa-solid fa-envelope"></i><span>Email</span></a>
      <a class="social-link" href="https://www.facebook.com/" target="_blank" rel="noreferrer"><i class="fa-brands fa-facebook-f"></i><span>Facebook</span></a>
      <a class="social-link" href="https://www.instagram.com/" target="_blank" rel="noreferrer"><i class="fa-brands fa-instagram"></i><span>Instagram</span></a>
    </div>
    <button class="social-toggle" type="button" aria-expanded="false" aria-label="Open social links">
      <i class="fa-solid fa-share-nodes"></i><span>Connect</span>
    </button>`;
  const toggle = panel.querySelector('.social-toggle');
  toggle?.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.social-panel')) {
      panel.classList.remove('open');
      toggle?.setAttribute('aria-expanded', 'false');
    }
  });
  document.body.appendChild(panel);
}

document.addEventListener('DOMContentLoaded', async () => {
  await window.vsReady;
  installShell();
  installVisualVault();
  installGlobalInteractions();
  installAmbientMotion();
  installAboutHeroTransitions();
  installVisualVaultLightbox();
  installFloatingSocialPanel();
});
