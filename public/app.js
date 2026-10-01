/* Kool Kaya Kitchen storefront — vanilla JS single-page app (hash routing). */
(() => {
  'use strict';

  // ---------- State ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  function guessMarket() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz === 'Asia/Kuala_Lumpur' || tz === 'Asia/Kuching') return 'MY';
    if (tz === 'Asia/Bangkok') return 'TH';
    if (tz === 'Asia/Hong_Kong') return 'HK';
    return 'SG';
  }

  const S = {
    token: store.get('kk_token', null),
    user: null,
    market: store.get('kk_market', guessMarket()),
    lang: store.get('kk_lang', null),
    config: null,
    guestCart: store.get('kk_cart', []),
    cartCount: 0,
    promos: [],
  };

  const LOCALES = { en: 'en-SG', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-HK', ms: 'ms-MY', th: 'th-TH' };
  const FLAGS = { SG: '🇸🇬', MY: '🇲🇾', TH: '🇹🇭', HK: '🇭🇰' };
  const app = document.getElementById('app');

  // ---------- Helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function t(key, vars) {
    const dict = window.I18N[S.lang] || window.I18N.en;
    let s = dict[key] ?? window.I18N.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    return s;
  }
  const locale = () => LOCALES[S.lang] || 'en-SG';
  const mkt = () => S.config?.markets[S.market] || { currency: 'SGD', timeZone: 'Asia/Singapore', name: 'Singapore', pickup: true };
  const SYMBOLS = { SGD: 'S$', MYR: 'RM', THB: '฿', HKD: 'HK$' };
  function money(n, currency = mkt().currency) {
    const dp = currency === 'THB' ? 0 : 2;
    const num = new Intl.NumberFormat(locale(), { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Math.abs(n));
    return `${n < 0 ? '−' : ''}${SYMBOLS[currency] || currency + ' '}${num}`;
  }
  function fmtDate(ts, opts = { dateStyle: 'medium', timeStyle: 'short' }, tz = mkt().timeZone) {
    return new Intl.DateTimeFormat(locale(), { ...opts, timeZone: tz }).format(new Date(ts));
  }
  const stars = (r) => {
    const full = Math.round(r);
    return `<span class="stars" aria-label="${r} out of 5">${'★'.repeat(full)}<span class="off">${'★'.repeat(5 - full)}</span></span>`;
  };
  const statusPill = (s) => {
    const cls = { delivered: 'pill-green', processing: 'pill-gold', shipped: 'pill-gold', ready_for_pickup: 'pill-green', pending_payment: 'pill-red', cancelled: 'pill-grey' }[s] || 'pill-grey';
    return `<span class="pill ${cls}">${esc(t('status_' + s))}</span>`;
  };
  const catName = (c) => (c ? t('cat_' + c.id) : '');
  const isStaff = () => S.user && ['staff', 'admin'].includes(S.user.role);

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  async function api(method, path, body, extraHeaders = {}) {
    const headers = { 'x-market': S.market, ...extraHeaders };
    if (S.token) headers.authorization = `Bearer ${S.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (res.status === 401 && S.token && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/mfa')) {
      setSession(null, null);
    }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function setSession(token, user) {
    S.token = token;
    S.user = user;
    if (token) store.set('kk_token', token); else store.del('kk_token');
    renderHeader();
  }

  function priceHtml(p) {
    if (p.salePriceLocal != null) return `<span class="price"><span class="sale">${money(p.salePriceLocal, p.currency)}</span><s>${money(p.priceLocal, p.currency)}</s></span>`;
    return `<span class="price">${money(p.priceLocal, p.currency)}</span>`;
  }

  function productCard(p) {
    const tags = [
      p.salePct ? `<span class="pill pill-sale">-${p.salePct}%</span>` : '',
      !p.inStock ? `<span class="pill pill-grey">${esc(t('soldOut'))}</span>` : p.lowStock ? `<span class="pill pill-gold">${esc(t('onlyLeft', { n: p.stock }))}</span>` : '',
    ].join('');
    return `<article class="product-card">
      <a class="img-link" href="#/product/${esc(p.slug)}"><img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy"><div class="tags">${tags}</div></a>
      <div class="body">
        <h3><a href="#/product/${esc(p.slug)}">${esc(p.name)}</a></h3>
        <div class="meta">${esc(p.size)} · ${p.reviewCount ? `${stars(p.rating)} <span>(${p.reviewCount})</span>` : ''}</div>
        <div class="foot">${priceHtml(p)}
          <button class="btn btn-primary btn-sm" data-add="${esc(p.id)}" data-stock="${p.stock}" ${p.inStock ? '' : 'disabled'}>${esc(p.inStock ? t('addToCart') : t('soldOut'))}</button>
        </div>
      </div>
    </article>`;
  }

  const loading = () => { app.innerHTML = '<div class="grid">' + '<div class="skeleton"></div>'.repeat(4) + '</div>'; };
  const errorView = (e) => { app.innerHTML = `<div class="empty"><img src="/img/logo.webp" alt=""><h2>Oops</h2><p>${esc(e.message)}</p><a class="btn btn-ghost" href="#/">Back to home</a></div>`; };

  // ---------- Cart ----------
  async function refreshCartCount() {
    if (S.token) {
      try { const c = await api('GET', '/api/cart'); S.cartCount = c.itemCount; } catch { S.cartCount = 0; }
    } else {
      S.cartCount = S.guestCart.reduce((s, i) => s + i.qty, 0);
    }
    const b = document.getElementById('cart-count');
    b.textContent = S.cartCount;
    b.hidden = !S.cartCount;
  }

  async function cartAdd(productId, qty = 1, stock = 99) {
    if (S.token) {
      await api('POST', '/api/cart/items', { productId, qty });
    } else {
      const existing = S.guestCart.find((i) => i.productId === productId);
      const newQty = (existing?.qty || 0) + qty;
      if (newQty > stock) throw new Error(`Only ${stock} left in stock.`);
      if (existing) existing.qty = newQty; else S.guestCart.push({ productId, qty });
      store.set('kk_cart', S.guestCart);
    }
    await refreshCartCount();
  }

  async function cartSet(productId, qty) {
    if (S.token) {
      if (qty <= 0) await api('DELETE', `/api/cart/items/${encodeURIComponent(productId)}`);
      else await api('PUT', `/api/cart/items/${encodeURIComponent(productId)}`, { qty });
    } else {
      S.guestCart = S.guestCart.map((i) => (i.productId === productId ? { ...i, qty } : i)).filter((i) => i.qty > 0);
      store.set('kk_cart', S.guestCart);
    }
    await refreshCartCount();
  }

  const cartQuote = (opts = {}) => api('POST', '/api/cart/quote', { items: S.guestCart, ...opts });

  async function mergeGuestCart() {
    if (!S.guestCart.length) return;
    try { await api('POST', '/api/cart/merge', { items: S.guestCart }); } catch { /* best effort */ }
    S.guestCart = [];
    store.set('kk_cart', []);
  }

  // ---------- Header ----------
  function renderHeader() {
    const nav = document.getElementById('main-nav');
    const route = location.hash.split('?')[0];
    const links = [
      ['#/shop', t('shop')], ['#/shop?category=gifts', t('gifts')], ['#/promotions', t('promotions')], ['#/help', t('help')],
    ];
    nav.innerHTML = links.map(([h, l]) => `<a href="${h}" class="${location.hash === h || (h === '#/shop' && route === '#/shop' && !location.hash.includes('gifts')) ? 'active' : ''}">${esc(l)}</a>`).join('')
      + (isStaff() ? `<a href="#/admin" class="staff ${route.startsWith('#/admin') ? 'active' : ''}">${esc(t('admin'))}</a>` : '');
    document.getElementById('search-input').placeholder = t('search');
    const ms = document.getElementById('market-select');
    if (S.config) {
      ms.innerHTML = Object.values(S.config.markets).map((m) => `<option value="${m.code}" ${m.code === S.market ? 'selected' : ''}>${FLAGS[m.code]} ${m.currency}</option>`).join('');
      document.getElementById('lang-select').innerHTML = S.config.languages.map((l) => `<option value="${l}" ${l === S.lang ? 'selected' : ''}>${esc(window.I18N[l]?.langName || l)}</option>`).join('');
    }
    document.getElementById('account-link').title = S.user ? S.user.name : t('login');
    document.getElementById('footer-tag').textContent = t('footerTag');
    document.documentElement.lang = S.lang || 'en';
    const bar = document.getElementById('promo-bar');
    const p = S.promos.find((x) => x.code === 'KAYA1111') || S.promos[0];
    bar.innerHTML = p ? `${esc(p.description)} — code <strong>${esc(p.code)}</strong> · ${esc(t('shipTo'))} ${FLAGS[S.market]} ${esc(mkt().name)}` : '';
  }

  // ---------- Views ----------
  async function viewHome() {
    const [feat, cats] = await Promise.all([api('GET', '/api/catalog/products?sort=featured'), Promise.resolve(S.config.categories)]);
    const featured = feat.products.filter((p) => p.featured).slice(0, 4);
    const catImg = { classic: 'classic-pandan', specialty: 'durian-kaya', coconut: 'coconut-jam-original', gifts: 'heritage-gift-box' };
    app.innerHTML = `
      <section class="hero">
        <div>
          <span class="pill pill-green">Artisan · Handcrafted · Est. 2023</span>
          <h1 style="margin-top:14px">${esc(t('heroTitle'))}</h1>
          <p>${esc(t('heroSub'))}</p>
          <div class="hero-actions"><a class="btn btn-primary" href="#/shop">${esc(t('shopNow'))}</a><a class="btn btn-ghost" href="#/shop?category=gifts">${esc(t('viewGifts'))}</a></div>
          <div class="hero-badges"><div>No preservatives</div><div>Fresh pandan & coconut</div><div>Ships to SG · MY · TH · HK</div></div>
        </div>
        <div class="hero-art"><img src="/img/logo.webp" alt="Kool Kaya Kitchen — traditional & coconut jam distributor"></div>
      </section>
      <section class="section">
        <div class="section-head"><h2>${esc(t('featured'))}</h2><a href="#/shop">${esc(t('allProducts'))} →</a></div>
        <div class="grid">${featured.map(productCard).join('')}</div>
      </section>
      <section class="section">
        <div class="section-head"><h2>${esc(t('categories'))}</h2></div>
        <div class="cat-grid">${cats.map((c) => `<a class="cat-tile" href="#/shop?category=${c.id}"><img src="/img/products/${catImg[c.id]}.svg" alt=""><strong>${esc(catName(c))}</strong></a>`).join('')}</div>
      </section>
      <section class="section">
        <div class="section-head"><h2>${esc(t('promotions'))}</h2><a href="#/promotions">${esc(t('promotions'))} →</a></div>
        <div class="promo-cards">${S.promos.map(promoCard).join('')}</div>
      </section>`;
  }

  const promoCard = (p) => `<div class="promo-card"><h3>${esc(p.description)}</h3><p style="margin:0;opacity:.85">${p.minSpend ? `Min. spend S$${p.minSpend}` : 'No minimum spend'}</p><code>${esc(p.code)}</code></div>`;

  async function viewShop(q) {
    const params = new URLSearchParams();
    for (const k of ['q', 'category', 'sort', 'minPrice', 'maxPrice', 'onSale', 'inStock']) if (q.get(k)) params.set(k, q.get(k));
    loading();
    const data = await api('GET', `/api/catalog/products?${params}`);
    const cat = q.get('category') || '';
    const sorts = ['featured', 'popular', 'price_asc', 'price_desc', 'rating', 'newest'];
    const curCat = catName(S.config.categories.find((c) => c.id === cat));
    app.innerHTML = `
      <div class="breadcrumbs"><a href="#/">Home</a> / ${esc(t('shop'))}${curCat ? ` / ${esc(curCat)}` : ''}</div>
      <div class="shop-layout">
        <aside class="filters card"><details class="filter-details" ${innerWidth > 820 ? 'open' : ''}><summary>${esc(t('filters'))}</summary>
          <h3>${esc(t('category'))}</h3>
          <a class="cat-link ${!cat ? 'active' : ''}" href="${shopLink(q, { category: '' })}">${esc(t('allProducts'))}</a>
          ${S.config.categories.map((c) => `<a class="cat-link ${cat === c.id ? 'active' : ''}" href="${shopLink(q, { category: c.id })}">${esc(catName(c))}</a>`).join('')}
          <form id="price-filter">
            <h3>${esc(t('price'))} (${esc(mkt().currency)})</h3>
            <div class="row"><input type="number" name="minPrice" min="0" placeholder="${esc(t('min'))}" value="${esc(q.get('minPrice') || '')}" aria-label="Min price"><input type="number" name="maxPrice" min="0" placeholder="${esc(t('max'))}" value="${esc(q.get('maxPrice') || '')}" aria-label="Max price"></div>
            <label class="check"><input type="checkbox" name="onSale" ${q.get('onSale') ? 'checked' : ''}> ${esc(t('onSale'))}</label>
            <label class="check"><input type="checkbox" name="inStock" ${q.get('inStock') ? 'checked' : ''}> ${esc(t('inStock'))}</label>
            <div class="row" style="margin-top:10px"><button class="btn btn-brown btn-sm">${esc(t('apply'))}</button><a class="btn btn-ghost btn-sm" href="#/shop">${esc(t('clear'))}</a></div>
          </form>
        </details></aside>
        <section>
          <div class="toolbar">
            <div><h2 style="margin:0">${esc(q.get('q') ? `“${q.get('q')}”` : curCat || t('allProducts'))}</h2><span class="muted small">${esc(t('results', { n: data.total }))}</span></div>
            <label class="muted small">${esc(t('sortBy'))} <select id="sort-select">${sorts.map((s) => `<option value="${s}" ${(q.get('sort') || 'featured') === s ? 'selected' : ''}>${esc(t('sort_' + s))}</option>`).join('')}</select></label>
          </div>
          ${data.products.length ? `<div class="grid">${data.products.map(productCard).join('')}</div>` : `<div class="empty"><p>${esc(t('noResults'))}</p><a class="btn btn-ghost" href="#/shop">${esc(t('clear'))}</a></div>`}
        </section>
      </div>`;
    document.getElementById('sort-select').onchange = (e) => { location.hash = shopLink(q, { sort: e.target.value }); };
    document.getElementById('price-filter').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      location.hash = shopLink(q, { minPrice: f.get('minPrice'), maxPrice: f.get('maxPrice'), onSale: f.get('onSale') ? '1' : '', inStock: f.get('inStock') ? '1' : '' });
    };
  }

  function shopLink(q, patch) {
    const p = new URLSearchParams(q);
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    const s = p.toString();
    return `#/shop${s ? '?' + s : ''}`;
  }

  async function viewProduct(slug) {
    loading();
    const { product: p, reviews } = await api('GET', `/api/catalog/products/${encodeURIComponent(slug)}`);
    const pCat = catName(S.config.categories.find((c) => c.id === p.category));
    const reviewed = S.user && reviews.some((r) => r.userId === S.user.id);
    app.innerHTML = `
      <div class="breadcrumbs"><a href="#/">Home</a> / <a href="#/shop?category=${esc(p.category)}">${esc(pCat)}</a> / ${esc(p.name)}</div>
      <div class="pdp">
        <div class="pdp-img"><img src="${esc(p.image)}" alt="${esc(p.name)}"></div>
        <div>
          ${p.salePct ? `<span class="pill pill-sale">-${p.salePct}% SALE</span>` : ''}
          <h1 style="margin-top:8px">${esc(p.name)}</h1>
          <div class="muted">${esc(p.size)} · ${p.reviewCount ? `${stars(p.rating)} ${p.rating} (${p.reviewCount} ${esc(t('reviews').toLowerCase())})` : 'No reviews yet'}</div>
          <p style="margin:18px 0">${priceHtml(p)}</p>
          <p>${esc(p.description)}</p>
          <p class="small"><strong>${esc(t('ingredients'))}:</strong> <span class="muted">${esc(p.ingredients)}</span></p>
          <div class="qty-row">
            <div class="stepper"><button type="button" data-step="-1" aria-label="Decrease">−</button><span id="pdp-qty">1</span><button type="button" data-step="1" aria-label="Increase">+</button></div>
            <button class="btn btn-primary" id="pdp-add" ${p.inStock ? '' : 'disabled'}>${esc(p.inStock ? t('addToCart') : t('soldOut'))}</button>
            ${p.lowStock ? `<span class="pill pill-gold">${esc(t('onlyLeft', { n: p.stock }))}</span>` : ''}
          </div>
          <div class="alert alert-info small">🚚 ${esc(t('shipTo'))} ${FLAGS[S.market]} ${esc(mkt().name)} · ${esc(t('free'))} ${esc(t('shipping').toLowerCase())} ≥ ${money(mkt().freeShippingOver)}${mkt().pickup ? ' · Self pick-up available' : ''}</div>
        </div>
      </div>
      <section class="section two-col">
        <div class="card">
          <h2>${esc(t('reviews'))} (${reviews.length})</h2>
          ${reviews.length ? reviews.map((r) => `<div class="review"><div class="review-head">${stars(r.rating)} <strong>${esc(r.userName)}</strong>${r.verified ? '<span class="pill pill-green">Verified buyer</span>' : ''}<span class="muted small">${fmtDate(r.createdAt, { dateStyle: 'medium' })}</span></div><p style="margin:6px 0 0">${esc(r.text)}</p></div>`).join('') : '<p class="muted">Be the first to review this product.</p>'}
        </div>
        <div class="card">
          <h3>${esc(t('writeReview'))}</h3>
          ${!S.user ? `<p class="muted"><a href="#/login?next=${encodeURIComponent('#/product/' + p.slug)}">${esc(t('login'))}</a> to leave a review.</p>` : reviewed ? '<p class="muted">Thanks — you have reviewed this product.</p>' : `
          <form id="review-form">
            <div class="rating-input" role="radiogroup" aria-label="Rating">${[5, 4, 3, 2, 1].map((n) => `<input type="radio" name="rating" id="r${n}" value="${n}"><label for="r${n}" title="${n} stars">★</label>`).join('')}</div>
            <label class="field"><span>Review</span><textarea name="text" rows="4" maxlength="1000" required></textarea></label>
            <button class="btn btn-brown">${esc(t('submit'))}</button>
          </form>`}
        </div>
      </section>
      <section class="section" id="recs"></section>`;

    let qty = 1;
    app.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => {
      qty = Math.max(1, Math.min(p.stock || 1, qty + Number(b.dataset.step)));
      document.getElementById('pdp-qty').textContent = qty;
    }));
    document.getElementById('pdp-add').onclick = async (e) => {
      e.target.disabled = true;
      try { await cartAdd(p.id, qty, p.stock); toast(`${t('added')}: ${p.name} × ${qty}`, 'ok'); } catch (err) { toast(err.message, 'error'); }
      e.target.disabled = false;
    };
    const rf = document.getElementById('review-form');
    if (rf) rf.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(rf);
      try { await api('POST', `/api/catalog/products/${p.id}/reviews`, { rating: f.get('rating'), text: f.get('text') }); toast('Thanks for your review!', 'ok'); route(); } catch (err) { toast(err.message, 'error'); }
    };
    // Recommendations are non-critical: render nothing if the service fails.
    api('GET', `/api/catalog/recommendations?productId=${p.id}`).then((r) => {
      const el = document.getElementById('recs');
      if (el && r.products.length) el.innerHTML = `<div class="section-head"><h2>${esc(t('youMayLike'))}</h2></div><div class="grid">${r.products.map(productCard).join('')}</div>`;
    }).catch(() => {});
  }

  async function viewCart() {
    const promo = sessionStorage.getItem('kk_promo') || '';
    const c = await cartQuote({ promoCode: promo || undefined });
    if (!c.lines.length) {
      app.innerHTML = `<div class="empty"><img src="/img/logo.webp" alt=""><h2>${esc(t('emptyCart'))}</h2><a class="btn btn-primary" href="#/shop">${esc(t('continueShopping'))}</a></div>`;
      return;
    }
    const remaining = c.freeShippingOver - (c.subtotal - c.discount);
    app.innerHTML = `
      <h1>${esc(t('yourCart'))}</h1>
      <div class="two-col">
        <div class="card">
          ${c.errors.map((e) => `<div class="alert alert-error">${esc(e)}</div>`).join('')}
          ${c.lines.map((l) => `
            <div class="cart-line">
              <img src="${esc(l.image)}" alt="">
              <div><h3><a href="#/product/${esc(l.slug)}">${esc(l.name)}</a></h3><div class="muted small">${esc(l.size)} · ${money(l.unitPrice, c.currency)}</div></div>
              <div class="right">
                <strong>${money(l.lineTotal, c.currency)}</strong>
                <div class="stepper"><button data-qty="${esc(l.productId)}" data-v="${l.qty - 1}" aria-label="Decrease">−</button><span>${l.qty}</span><button data-qty="${esc(l.productId)}" data-v="${l.qty + 1}" ${l.qty >= l.stock ? 'disabled' : ''} aria-label="Increase">+</button></div>
                <button class="link-btn small" data-qty="${esc(l.productId)}" data-v="0">${esc(t('remove'))}</button>
              </div>
            </div>`).join('')}
          <a href="#/shop" class="btn btn-ghost btn-sm" style="margin-top:16px">← ${esc(t('continueShopping'))}</a>
        </div>
        <aside class="card summary">
          <h3>${esc(t('total'))}</h3>
          ${remaining > 0 ? `<div class="small muted">${esc(t('freeShipHint', { amt: money(remaining, c.currency) }))}</div><div class="progress"><div style="width:${Math.min(100, ((c.subtotal - c.discount) / c.freeShippingOver) * 100)}%"></div></div>` : `<div class="alert alert-ok small">🎉 ${esc(t('free'))} ${esc(t('shipping').toLowerCase())}!</div>`}
          <form id="promo-form" class="row" style="margin-top:14px"><input name="code" placeholder="${esc(t('promoCode'))}" value="${esc(promo)}" aria-label="${esc(t('promoCode'))}"><button class="btn btn-ghost btn-sm" style="flex:0">${esc(t('apply'))}</button></form>
          ${c.promoError ? `<div class="alert alert-error small" style="margin-top:8px">${esc(c.promoError)}</div>` : c.promo ? `<div class="alert alert-ok small" style="margin-top:8px">✓ ${esc(c.promo.code)} — ${esc(c.promo.description)}</div>` : ''}
          ${summaryDl(c)}
          <button class="btn btn-primary btn-block" id="go-checkout" ${c.errors.length ? 'disabled' : ''}>${esc(t('checkout'))}</button>
          <p class="muted small" style="text-align:center;margin:10px 0 0">🔒 Secure checkout · Card · PayNow · Apple Pay</p>
        </aside>
      </div>`;
    app.querySelectorAll('[data-qty]').forEach((b) => (b.onclick = async () => {
      try { await cartSet(b.dataset.qty, Number(b.dataset.v)); viewCart(); } catch (e) { toast(e.message, 'error'); }
    }));
    document.getElementById('promo-form').onsubmit = (e) => {
      e.preventDefault();
      sessionStorage.setItem('kk_promo', new FormData(e.target).get('code').trim().toUpperCase());
      viewCart();
    };
    document.getElementById('go-checkout').onclick = () => { location.hash = S.token ? '#/checkout' : '#/login?next=%23%2Fcheckout'; };
  }

  const summaryDl = (c) => `<dl>
      <dt>${esc(t('subtotal'))}</dt><dd>${money(c.subtotal, c.currency)}</dd>
      ${c.discount ? `<dt>${esc(t('discount'))}${c.promo ? ` (${esc(c.promo.code)})` : ''}</dt><dd style="color:var(--pandan-dark)">−${money(c.discount, c.currency)}</dd>` : ''}
      <dt>${esc(t('shipping'))}</dt><dd>${c.shipping ? money(c.shipping, c.currency) : esc(t('free'))}</dd>
      <dt class="grand">${esc(t('total'))}</dt><dd class="grand">${money(c.total, c.currency)}</dd>
    </dl>`;

  async function viewCheckout() {
    if (!S.token) { location.hash = '#/login?next=%23%2Fcheckout'; return; }
    const [c, slots] = await Promise.all([cartQuote(), api('GET', '/api/orders/pickup-slots')]);
    if (!c.lines.length) { location.hash = '#/cart'; return; }
    const m = mkt();
    const u = S.user;
    const a = u.address || {};
    const idemKey = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
    const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString('sv-SE', { timeZone: m.timeZone });
    app.innerHTML = `
      <div class="breadcrumbs"><a href="#/cart">${esc(t('cart'))}</a> / ${esc(t('checkout'))}</div>
      <h1>${esc(t('checkout'))}</h1>
      <form id="checkout-form" class="two-col" novalidate>
        <div>
          <div class="card checkout-section">
            <h3 class="step-title"><b>1</b>${esc(t('delivery'))} / ${esc(t('pickup'))}</h3>
            <div class="choice-group">
              <label class="choice"><input type="radio" name="fulfilment" value="delivery" checked><strong>🚚 ${esc(t('delivery'))}</strong><small>${esc(m.name)} · 2–5 business days</small></label>
              <label class="choice"><input type="radio" name="fulfilment" value="pickup" ${m.pickup ? '' : 'disabled'}><strong>🏪 ${esc(t('pickup'))}</strong><small>${m.pickup ? '1 Kaya Lane, Singapore · Free' : 'Singapore only'}</small></label>
            </div>
            <div id="delivery-fields">
              <div class="row"><label class="field"><span>${esc(t('name'))}</span><input type="text" name="name" value="${esc(u.name)}" autocomplete="name"></label><label class="field"><span>${esc(t('phone'))}</span><input type="tel" name="phone" value="${esc(u.phone)}" autocomplete="tel"></label></div>
              <label class="field"><span>${esc(t('address'))}</span><input type="text" name="line1" value="${esc(a.line1)}" autocomplete="address-line1" placeholder="Street address"></label>
              <label class="field"><input type="text" name="line2" value="${esc(a.line2)}" autocomplete="address-line2" placeholder="Unit / floor (optional)" aria-label="Address line 2"></label>
              <div class="row"><label class="field"><span>City</span><input type="text" name="city" value="${esc(a.city)}" autocomplete="address-level2"></label><label class="field"><span>Postcode</span><input type="text" name="postcode" value="${esc(a.postcode)}" autocomplete="postal-code"></label><label class="field"><span>Country</span><input type="text" value="${esc(m.name)}" disabled></label></div>
              <label class="check"><input type="checkbox" name="saveAddress" checked> Save this address to my profile</label>
            </div>
            <div id="pickup-fields" hidden>
              <div class="row"><label class="field"><span>Pickup date</span><input type="date" name="pickupDate" min="${tomorrow}" value="${tomorrow}"></label>
              <label class="field"><span>Time slot</span><select name="pickupSlot">${slots.slots.map((s) => `<option>${s}</option>`).join('')}</select></label></div>
            </div>
          </div>
          <div class="card checkout-section">
            <h3 class="step-title"><b>2</b>${esc(t('payment'))}</h3>
            <div class="choice-group">
              <label class="choice"><input type="radio" name="method" value="card" checked><strong>💳 ${esc(t('card'))}</strong><small>Visa · Mastercard · Amex</small></label>
              <label class="choice"><input type="radio" name="method" value="paynow" ${S.market === 'SG' ? '' : 'disabled'}><strong>📱 ${esc(t('paynow'))}</strong><small>${S.market === 'SG' ? 'Scan QR with your bank app' : 'Singapore only'}</small></label>
              <label class="choice"><input type="radio" name="method" value="applepay"><strong> ${esc(t('applepay'))}</strong><small>Touch ID / Face ID</small></label>
            </div>
            <div id="card-fields">
              <label class="field"><span>Name on card</span><input type="text" name="cardName" autocomplete="cc-name"></label>
              <label class="field"><span>Card number</span><input type="text" name="cardNumber" inputmode="numeric" autocomplete="cc-number" placeholder="1234 5678 9012 3456" maxlength="23"></label>
              <div class="row"><label class="field"><span>Expiry (MM/YY)</span><input type="text" name="cardExpiry" autocomplete="cc-exp" placeholder="MM/YY" maxlength="5"></label><label class="field"><span>CVC</span><input type="text" name="cardCvc" inputmode="numeric" autocomplete="cc-csc" maxlength="4"></label></div>
              <div class="test-hint">Demo gateway — test cards: <code>4242 4242 4242 4242</code> succeeds, <code>4000 0000 0000 0002</code> is declined. Any future expiry and CVC.</div>
            </div>
            <div id="paynow-info" class="alert alert-info small" hidden>After placing your order you'll see a PayNow QR code. Your order is confirmed once payment is received.</div>
            <div id="applepay-info" class="alert alert-info small" hidden>You'll confirm with Apple Pay on your device (simulated in this demo).</div>
          </div>
        </div>
        <aside class="card summary">
          <h3>${esc(t('total'))}</h3>
          ${c.lines.map((l) => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:.9rem;margin:6px 0"><span>${esc(l.name)} × ${l.qty}</span><span>${money(l.lineTotal, c.currency)}</span></div>`).join('')}
          <div class="row" style="margin-top:12px"><input name="promoCode" placeholder="${esc(t('promoCode'))}" value="${esc(sessionStorage.getItem('kk_promo') || '')}" aria-label="${esc(t('promoCode'))}"><button type="button" class="btn btn-ghost btn-sm" style="flex:0" id="apply-promo">${esc(t('apply'))}</button></div>
          <div id="promo-msg"></div>
          <div id="totals">${summaryDl(c)}</div>
          <div id="checkout-error"></div>
          <button class="btn btn-primary btn-block" id="place-order">${esc(t('placeOrder'))}</button>
          <p class="muted small" style="text-align:center;margin:10px 0 0">🔒 TLS encrypted · we never store full card numbers</p>
        </aside>
      </form>`;

    const form = document.getElementById('checkout-form');
    const val = (n) => form.elements[n]?.value?.trim();
    const update = async () => {
      const fulfilment = form.elements.fulfilment.value;
      const method = form.elements.method.value;
      document.getElementById('delivery-fields').hidden = fulfilment !== 'delivery';
      document.getElementById('pickup-fields').hidden = fulfilment !== 'pickup';
      document.getElementById('card-fields').hidden = method !== 'card';
      document.getElementById('paynow-info').hidden = method !== 'paynow';
      document.getElementById('applepay-info').hidden = method !== 'applepay';
      const promoCode = val('promoCode');
      try {
        const q = await cartQuote({ promoCode: promoCode || undefined, fulfilment });
        document.getElementById('totals').innerHTML = summaryDl(q);
        document.getElementById('promo-msg').innerHTML = q.promoError ? `<div class="alert alert-error small" style="margin-top:8px">${esc(q.promoError)}</div>` : q.promo ? `<div class="alert alert-ok small" style="margin-top:8px">✓ ${esc(q.promo.description)}</div>` : '';
      } catch { /* totals will be re-validated server-side */ }
    };
    form.addEventListener('change', (e) => { if (['fulfilment', 'method'].includes(e.target.name)) update(); });
    document.getElementById('apply-promo').onclick = () => { sessionStorage.setItem('kk_promo', val('promoCode').toUpperCase()); update(); };
    form.elements.cardNumber.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 '); });
    form.elements.cardExpiry.addEventListener('input', (e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 4); e.target.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; });
    update();

    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = document.getElementById('place-order');
      const errBox = document.getElementById('checkout-error');
      errBox.innerHTML = '';
      const fulfilment = form.elements.fulfilment.value;
      const method = form.elements.method.value;
      const body = {
        fulfilment, promoCode: val('promoCode') || undefined,
        address: { name: val('name'), phone: val('phone'), line1: val('line1'), line2: val('line2'), city: val('city'), postcode: val('postcode') },
        pickupDate: val('pickupDate'), pickupSlot: val('pickupSlot'),
        payment: { method, card: method === 'card' ? { name: val('cardName'), number: val('cardNumber'), expiry: val('cardExpiry'), cvc: val('cardCvc') } : undefined },
      };
      btn.disabled = true;
      btn.textContent = 'Processing…';
      try {
        const { order } = await api('POST', '/api/orders/checkout', body, { 'idempotency-key': idemKey });
        if (fulfilment === 'delivery' && form.elements.saveAddress.checked) {
          api('PUT', '/api/auth/me', { phone: body.address.phone, address: { ...body.address, country: m.name } }).then((r) => { S.user = r.user; }).catch(() => {});
        }
        sessionStorage.removeItem('kk_promo');
        await refreshCartCount();
        location.hash = `#/order/${order.id}?new=1`;
      } catch (err) {
        errBox.innerHTML = `<div class="alert alert-error">${esc(err.message)}</div>`;
        btn.disabled = false;
        btn.textContent = t('placeOrder');
      }
    };
  }

  function qrSvg(seed) {
    // Decorative QR-style code for the PayNow demo (not a scannable payload).
    let h = 2166136261;
    for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const n = 25;
    let cells = '';
    const finder = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (finder(x, y)) continue;
      h = (h + 0x6D2B79F5) | 0;
      let r = Math.imul(h ^ (h >>> 15), 1 | h);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      if (((r ^ (r >>> 14)) >>> 0) % 2) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
    const fp = (x, y) => `<rect x="${x}" y="${y}" width="7" height="7"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`;
    return `<svg viewBox="0 0 ${n} ${n}" fill="#7c1f7d" shape-rendering="crispEdges" role="img" aria-label="PayNow QR code">${cells}${fp(0, 0)}${fp(n - 7, 0)}${fp(0, n - 7)}</svg>`;
  }

  async function viewOrder(id, q) {
    const { order: o, payment } = await api('GET', `/api/payments/${encodeURIComponent(id)}/receipt`);
    const tz = S.config.markets[o.market].timeZone;
    const flow = o.fulfilment === 'pickup' ? ['placed', 'processing', 'ready_for_pickup', 'delivered'] : ['placed', 'processing', 'shipped', 'delivered'];
    const reached = new Map(o.statusHistory.map((h) => [h.status, h.at]));
    const cancelled = o.status === 'cancelled';
    const methodLabel = { card: payment?.brand ? `${payment.brand}${payment.last4 ? ' •••• ' + payment.last4 : ''}` : t('card'), paynow: 'PayNow', applepay: 'Apple Pay' }[o.paymentMethod];
    app.innerHTML = `
      ${q.get('new') && o.status !== 'pending_payment' ? `<div class="alert alert-ok no-print">✓ ${esc(t('thankYou'))} A confirmation email${S.user?.phone ? ' and SMS have' : ' has'} been sent.</div>` : ''}
      <div class="admin-head"><h1 style="margin:0">Order ${esc(o.id)}</h1><div class="no-print" style="display:flex;gap:8px">
        ${['pending_payment', 'processing'].includes(o.status) && o.userId === S.user?.id ? `<button class="btn btn-danger btn-sm" id="cancel-order">${esc(t('cancelOrder'))}</button>` : ''}
        <button class="btn btn-ghost btn-sm" id="print-receipt">${esc(t('print'))}</button></div></div>
      <p class="muted">${fmtDate(o.createdAt, undefined, tz)} · ${statusPill(o.status)}</p>
      ${o.status === 'pending_payment' ? `
        <div class="card" style="margin-bottom:18px">
          <h3>Pay with PayNow</h3>
          <div class="paynow-box">${qrSvg(o.paynow?.ref || o.id)}
            <div><p style="margin:0">Amount: <strong>${money(o.total, o.currency)}</strong></p><p style="margin:4px 0">UEN: <span class="mono">${esc(o.paynow?.uen)}</span></p><p style="margin:4px 0">Reference: <span class="mono">${esc(o.paynow?.ref)}</span></p>
            <p class="muted small">Scan with any Singapore banking app. This page updates once we receive payment.</p>
            <button class="btn btn-primary btn-sm no-print" id="sim-paynow">Simulate bank confirmation (demo)</button></div>
          </div>
        </div>` : ''}
      <div class="two-col">
        <div class="card">
          <h3>${esc(t('receipt'))}</h3>
          <table class="receipt-table">
            <thead><tr><th>Item</th><th class="num">${esc(t('qty'))}</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
            <tbody>${o.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${money(i.unitPrice, o.currency)}</td><td class="num">${money(i.unitPrice * i.qty, o.currency)}</td></tr>`).join('')}</tbody>
          </table>
          <div class="summary" style="position:static">${summaryDl({ ...o, promo: o.promoCode ? { code: o.promoCode } : null })}</div>
          <p class="small muted" style="margin:0">${esc(t('payment'))}: ${esc(methodLabel)} · ${esc(o.paymentStatus)} · Ref <span class="mono">${esc(o.paymentRef || '-')}</span></p>
        </div>
        <aside class="card">
          <h3>Status</h3>
          <ul class="timeline">
            ${cancelled ? `<li class="done"><strong>${esc(t('status_placed'))}</strong><div class="muted small">${fmtDate(o.createdAt, undefined, tz)}</div></li><li class="cancel"><strong>${esc(t('status_cancelled'))}</strong><div class="muted small">${fmtDate(reached.get('cancelled'), undefined, tz)}</div></li>`
              : flow.map((s) => `<li class="${reached.has(s) ? 'done' : ''}"><strong>${esc(t('status_' + s))}</strong>${reached.has(s) ? `<div class="muted small">${fmtDate(reached.get(s), undefined, tz)}</div>` : ''}</li>`).join('')}
          </ul>
          <h3 style="margin-top:10px">${o.fulfilment === 'pickup' ? esc(t('pickup')) : esc(t('delivery'))}</h3>
          ${o.fulfilment === 'pickup' && o.pickupSlot ? `<p class="small">${esc(o.pickupSlot.date)} · ${esc(o.pickupSlot.slot)}<br><span class="muted">${esc(o.pickupSlot.location)}</span></p>`
            : o.address ? `<p class="small">${esc(o.address.name || '')}<br>${esc(o.address.line1)} ${esc(o.address.line2 || '')}<br>${esc(o.address.city)} ${esc(o.address.postcode)}<br>${esc(o.address.country)}</p>` : ''}
        </aside>
      </div>
      <p class="no-print" style="margin-top:20px"><a href="#/account/orders">← ${esc(t('orderHistory'))}</a></p>`;
    document.getElementById('print-receipt').onclick = () => window.print();
    const sim = document.getElementById('sim-paynow');
    if (sim) sim.onclick = async () => {
      try { await api('POST', `/api/payments/${o.id}/paynow/confirm`); toast('Payment received!', 'ok'); viewOrder(id, new URLSearchParams('new=1')); } catch (e) { toast(e.message, 'error'); }
    };
    const cancel = document.getElementById('cancel-order');
    if (cancel) cancel.onclick = async () => {
      if (!confirm('Cancel this order? Any payment will be refunded.')) return;
      try { await api('POST', `/api/orders/${o.id}/cancel`); toast('Order cancelled'); viewOrder(id, new URLSearchParams()); } catch (e) { toast(e.message, 'error'); }
    };
  }

  async function viewAccount(tab = 'profile') {
    if (!S.token) { location.hash = '#/login?next=%23%2Faccount'; return; }
    const u = S.user;
    const tabs = [['profile', t('profile')], ['orders', t('orders')], ['notifications', t('notifications')], ['security', t('security')]];
    app.innerHTML = `
      <div class="admin-head"><h1 style="margin:0">${esc(t('account'))}</h1><button class="btn btn-ghost btn-sm" id="logout">${esc(t('logout'))}</button></div>
      <p class="muted">${esc(u.name)} · ${esc(u.email)}${u.role !== 'customer' ? ` · <span class="pill pill-green">${esc(u.role)}</span>` : ''}</p>
      <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/account/${k}" class="${tab === k ? 'active' : ''}">${esc(l)}</a>`).join('')}</nav>
      <div id="tab-body"></div>`;
    document.getElementById('logout').onclick = async () => {
      try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
      setSession(null, null);
      await refreshCartCount();
      toast('Logged out');
      location.hash = '#/';
    };
    const body = document.getElementById('tab-body');
    if (tab === 'orders') {
      const { orders } = await api('GET', '/api/orders');
      body.innerHTML = orders.length ? `<div class="card">${orders.map((o) => `
        <div class="order-row"><div><strong><a href="#/order/${esc(o.id)}">${esc(o.id)}</a></strong><div class="muted small">${fmtDate(o.createdAt, { dateStyle: 'medium' }, S.config.markets[o.market].timeZone)}</div></div>
        <div class="small">${o.items.reduce((s, i) => s + i.qty, 0)} items · ${esc(o.fulfilment === 'pickup' ? t('pickup') : t('delivery'))}</div>
        <div>${statusPill(o.status)}</div><div><strong>${money(o.total, o.currency)}</strong></div></div>`).join('')}</div>`
        : `<div class="empty"><p>No orders yet.</p><a class="btn btn-primary" href="#/shop">${esc(t('shopNow'))}</a></div>`;
    } else if (tab === 'notifications') {
      const { notifications } = await api('GET', '/api/auth/notifications');
      body.innerHTML = `<div class="card"><p class="muted small">Email & SMS messages sent to you (delivered via Amazon SES / SNS in production).</p>${notifications.length ? notifications.map((n) => `
        <div class="notif"><span class="ch ${n.channel === 'sms' ? 'warn-c' : 'ok-c'}">${esc(n.channel)}</span> <strong>${esc(n.subject)}</strong> <span class="muted small">· ${fmtDate(n.createdAt)}</span><div class="small">${esc(n.body)}</div></div>`).join('') : '<p class="muted">No notifications yet.</p>'}</div>`;
    } else if (tab === 'security') {
      body.innerHTML = `<div class="two-col" style="grid-template-columns:1fr 1fr">
        <form class="card" id="pw-form"><h3>Change password</h3>
          ${!u.hasPassword ? `<p class="muted small">You signed up with ${esc(u.ssoProvider)}. Set a password to also log in with email.</p>` : `<label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>`}
          <label class="field"><span>New password</span><input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
          <button class="btn btn-brown">${esc(t('save'))}</button></form>
        <div class="card"><h3>Two-factor authentication</h3>
          ${u.role !== 'customer' ? '<p class="muted">MFA is mandatory for staff and admin accounts.</p><p class="status-dot ok-c">Enabled</p>' : `
          <p class="muted small">Require a one-time code sent to your email whenever you log in.</p>
          <label class="check"><input type="checkbox" id="mfa-toggle" ${u.mfaEnabled ? 'checked' : ''}> Enable email verification codes</label>`}
        </div></div>`;
      document.getElementById('pw-form').onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try { await api('POST', '/api/auth/password', { current: f.get('current'), password: f.get('password') }); toast('Password updated', 'ok'); e.target.reset(); } catch (err) { toast(err.message, 'error'); }
      };
      const mt = document.getElementById('mfa-toggle');
      if (mt) mt.onchange = async () => {
        try { const r = await api('PUT', '/api/auth/me', { mfaEnabled: mt.checked }); S.user = r.user; toast(t('saved'), 'ok'); } catch (err) { toast(err.message, 'error'); }
      };
    } else {
      const a = u.address || {};
      body.innerHTML = `<form class="card" id="profile-form" style="max-width:720px">
        <div class="row"><label class="field"><span>${esc(t('name'))}</span><input type="text" name="name" value="${esc(u.name)}" required></label><label class="field"><span>${esc(t('email'))}</span><input type="email" name="email" value="${esc(u.email)}" required></label></div>
        <div class="row"><label class="field"><span>${esc(t('phone'))}</span><input type="tel" name="phone" value="${esc(u.phone)}" placeholder="For SMS order updates"></label>
          <label class="field"><span>${esc(t('market'))}</span><select name="market">${Object.values(S.config.markets).map((m) => `<option value="${m.code}" ${m.code === u.market ? 'selected' : ''}>${FLAGS[m.code]} ${esc(m.name)} (${m.currency})</option>`).join('')}</select></label>
          <label class="field"><span>${esc(t('language'))}</span><select name="language">${S.config.languages.map((l) => `<option value="${l}" ${l === u.language ? 'selected' : ''}>${esc(window.I18N[l].langName)}</option>`).join('')}</select></label></div>
        <h3>${esc(t('address'))}</h3>
        <label class="field"><span>Line 1</span><input type="text" name="line1" value="${esc(a.line1)}"></label>
        <label class="field"><span>Line 2</span><input type="text" name="line2" value="${esc(a.line2)}"></label>
        <div class="row"><label class="field"><span>City</span><input type="text" name="city" value="${esc(a.city)}"></label><label class="field"><span>Postcode</span><input type="text" name="postcode" value="${esc(a.postcode)}"></label><label class="field"><span>Country</span><input type="text" name="country" value="${esc(a.country)}"></label></div>
        <button class="btn btn-brown">${esc(t('save'))}</button>
      </form>`;
      document.getElementById('profile-form').onsubmit = async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try {
          const r = await api('PUT', '/api/auth/me', { name: f.name, email: f.email, phone: f.phone, market: f.market, language: f.language, address: { line1: f.line1, line2: f.line2, city: f.city, postcode: f.postcode, country: f.country } });
          S.user = r.user;
          applyPrefs(r.user.market, r.user.language);
          toast(t('saved'), 'ok');
        } catch (err) { toast(err.message, 'error'); }
      };
    }
  }

  function authShell(title, inner) {
    app.innerHTML = `<div class="auth-wrap"><div class="card"><img class="auth-logo" src="/img/logo.webp" alt=""><h2 style="text-align:center">${esc(title)}</h2><div id="auth-err"></div>${inner}</div></div>`;
  }
  const authErr = (msg) => { document.getElementById('auth-err').innerHTML = msg ? `<div class="alert alert-error">${esc(msg)}</div>` : ''; };

  async function onLoggedIn({ token, user }, next) {
    setSession(token, user);
    await mergeGuestCart();
    applyPrefs(user.market, user.language, false);
    await refreshCartCount();
    toast(`Welcome, ${user.name}!`, 'ok');
    location.hash = next || (['staff', 'admin'].includes(user.role) ? '#/admin' : '#/');
  }

  function viewLogin(q) {
    const next = q.get('next');
    authShell(t('login'), `
      <form id="login-form">
        <label class="field"><span>${esc(t('email'))}</span><input type="email" name="email" autocomplete="email" required></label>
        <label class="field"><span>${esc(t('password'))}</span><input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn btn-primary btn-block">${esc(t('login'))}</button>
      </form>
      <p class="small" style="text-align:right;margin:8px 0 0"><a href="#/forgot">${esc(t('forgot'))}</a></p>
      <div class="divider">or</div>
      <button class="btn sso-btn" data-sso="google"><b style="color:#4285F4">G</b> Continue with Google</button>
      <button class="btn sso-btn" data-sso="apple"> Continue with Apple</button>
      <p class="small" style="text-align:center;margin-top:16px">New here? <a href="#/register${next ? '?next=' + encodeURIComponent(next) : ''}">${esc(t('register'))}</a></p>
      <div class="test-hint">Demo accounts are listed in the README.</div>`);
    document.getElementById('login-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api('POST', '/api/auth/login', f);
        if (r.mfaRequired) return viewMfa(r, next);
        await onLoggedIn(r, next);
      } catch (err) { authErr(err.message); }
    };
    app.querySelectorAll('[data-sso]').forEach((b) => (b.onclick = () => viewSso(b.dataset.sso, next)));
  }

  function viewSso(provider, next) {
    const label = provider === 'google' ? 'Google' : 'Apple';
    authShell(`Continue with ${label}`, `
      <p class="muted small" style="text-align:center">Demo single sign-on. In production this redirects to ${label} via Amazon Cognito federated identities.</p>
      <form id="sso-form">
        <label class="field"><span>${esc(label)} account email</span><input type="email" name="email" required></label>
        <label class="field"><span>${esc(t('name'))}</span><input type="text" name="name"></label>
        <button class="btn btn-primary btn-block">Continue</button>
      </form><p class="small" style="text-align:center"><a href="#/login">← Back</a></p>`);
    document.getElementById('sso-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await onLoggedIn(await api('POST', '/api/auth/sso', { provider, ...f }), next); } catch (err) { authErr(err.message); }
    };
  }

  function viewMfa(r, next) {
    authShell('Verify it\'s you', `
      <p class="muted small" style="text-align:center">We've sent a 6-digit code to your email.</p>
      ${r.devCode ? `<div class="test-hint">Development mode — your code is <code>${esc(r.devCode)}</code> (also in the notification outbox).</div>` : ''}
      <form id="mfa-form" style="margin-top:14px">
        <label class="field"><span>Verification code</span><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus></label>
        <button class="btn btn-primary btn-block">Verify</button>
      </form>`);
    document.getElementById('mfa-form').onsubmit = async (e) => {
      e.preventDefault();
      try { await onLoggedIn(await api('POST', '/api/auth/mfa', { challengeId: r.challengeId, code: new FormData(e.target).get('code') }), next); } catch (err) { authErr(err.message); }
    };
  }

  function viewRegister(q) {
    const next = q.get('next');
    authShell(t('register'), `
      <form id="reg-form">
        <label class="field"><span>${esc(t('name'))}</span><input type="text" name="name" autocomplete="name" required></label>
        <label class="field"><span>${esc(t('email'))}</span><input type="email" name="email" autocomplete="email" required></label>
        <label class="field"><span>${esc(t('password'))}</span><input type="password" name="password" autocomplete="new-password" minlength="8" required><small class="muted">At least 8 characters with letters and numbers.</small></label>
        <label class="field"><span>${esc(t('market'))}</span><select name="market">${Object.values(S.config.markets).map((m) => `<option value="${m.code}" ${m.code === S.market ? 'selected' : ''}>${FLAGS[m.code]} ${esc(m.name)}</option>`).join('')}</select></label>
        <button class="btn btn-primary btn-block">${esc(t('register'))}</button>
      </form>
      <p class="small" style="text-align:center;margin-top:16px">Already have an account? <a href="#/login">${esc(t('login'))}</a></p>`);
    document.getElementById('reg-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await onLoggedIn(await api('POST', '/api/auth/register', { ...f, language: S.lang }), next); } catch (err) { authErr(err.message); }
    };
  }

  function viewForgot() {
    authShell(t('resetPassword'), `
      <form id="forgot-form"><label class="field"><span>${esc(t('email'))}</span><input type="email" name="email" required></label><button class="btn btn-primary btn-block">Send reset link</button></form>
      <div id="forgot-out"></div><p class="small" style="text-align:center"><a href="#/login">← ${esc(t('login'))}</a></p>`);
    document.getElementById('forgot-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/auth/forgot', Object.fromEntries(new FormData(e.target)));
        document.getElementById('forgot-out').innerHTML = `<div class="alert alert-ok" style="margin-top:14px">${esc(r.message)}</div>${r.devToken ? `<div class="test-hint">Development mode — <a href="#/reset?token=${esc(r.devToken)}">open the reset link</a>.</div>` : ''}`;
      } catch (err) { authErr(err.message); }
    };
  }

  function viewReset(q) {
    authShell(t('resetPassword'), `<form id="reset-form"><label class="field"><span>New ${esc(t('password').toLowerCase())}</span><input type="password" name="password" minlength="8" autocomplete="new-password" required></label><button class="btn btn-primary btn-block">${esc(t('resetPassword'))}</button></form>`);
    document.getElementById('reset-form').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/auth/reset', { token: q.get('token'), password: new FormData(e.target).get('password') }); toast('Password updated — please log in.', 'ok'); location.hash = '#/login'; } catch (err) { authErr(err.message); }
    };
  }

  async function viewPromotions() {
    const data = await api('GET', '/api/catalog/promotions');
    app.innerHTML = `<h1>${esc(t('promotions'))}</h1>
      <div class="promo-cards">${data.promotions.map(promoCard).join('')}</div>
      <section class="section"><div class="section-head"><h2>${esc(t('onSale'))}</h2></div><div class="grid">${data.sales.map(productCard).join('')}</div></section>`;
  }

  function viewHelp() {
    const ms = Object.values(S.config.markets);
    const faqs = [
      ['How long does kaya keep?', 'Unopened jars keep for 3 months in a cool, dry place. Once opened, refrigerate and finish within 3 weeks. We use no preservatives.'],
      ['Which countries do you ship to?', 'Singapore, Malaysia, Thailand and Hong Kong. Prices are shown in your local currency — switch markets using the currency selector at the top.'],
      ['Can I collect my order?', 'Yes — Singapore customers can choose free self pick-up from our kitchen at 1 Kaya Lane during checkout.'],
      ['Which payment methods do you accept?', 'Visa, Mastercard, Amex, Apple Pay, and PayNow (Singapore). All payments are processed securely; we never store your full card number.'],
      ['How do I track my order?', 'Go to Account → Orders. You also receive email (and SMS if you add a phone number) at each status change.'],
      ['Can I cancel my order?', 'Orders can be cancelled from the order page until they ship. Refunds take 5–7 business days.'],
      ['Do you sell wholesale?', 'Yes! Cafés and retailers can email wholesale@koolkaya.sg for trade pricing.'],
    ];
    app.innerHTML = `<h1>${esc(t('help'))}</h1>
      <div class="two-col">
        <div><h2>${esc(t('faq'))}</h2>${faqs.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>
        <aside>
          <div class="card" style="margin-bottom:16px"><h3>${esc(t('shipping'))}</h3>
            <table class="simple"><thead><tr><th>${esc(t('market'))}</th><th>Fee</th><th>${esc(t('free'))} ≥</th></tr></thead>
            <tbody>${ms.map((m) => `<tr><td>${FLAGS[m.code]} ${esc(m.name)}</td><td>${money(m.shippingFee, m.currency)}</td><td>${money(m.freeShippingOver, m.currency)}</td></tr>`).join('')}</tbody></table>
            <p class="small muted">SG: 1–2 days · MY/TH/HK: 3–5 business days</p></div>
          <div class="card"><h3>${esc(t('contact'))}</h3><p class="small">📧 hello@koolkaya.sg<br>📞 +65 6123 4567 (Mon–Sat, 9am–6pm SGT)<br>📍 1 Kaya Lane #01-01, Singapore 123456</p></div>
        </aside>
      </div>`;
  }

  // ---------- Router ----------
  async function route() {
    const hash = location.hash || '#/';
    const [pathPart, query = ''] = hash.slice(1).split('?');
    const parts = pathPart.split('/').filter(Boolean);
    const q = new URLSearchParams(query);
    renderHeader();
    window.scrollTo(0, 0);
    try {
      switch (parts[0]) {
        case undefined: await viewHome(); break;
        case 'shop': await viewShop(q); break;
        case 'product': await viewProduct(parts[1]); break;
        case 'cart': await viewCart(); break;
        case 'checkout': await viewCheckout(); break;
        case 'order': await viewOrder(parts[1], q); break;
        case 'account': await viewAccount(parts[1]); break;
        case 'login': viewLogin(q); break;
        case 'register': viewRegister(q); break;
        case 'forgot': viewForgot(); break;
        case 'reset': viewReset(q); break;
        case 'promotions': await viewPromotions(); break;
        case 'help': viewHelp(); break;
        case 'admin':
          if (!isStaff()) { location.hash = '#/login?next=%23%2Fadmin'; return; }
          await window.KKAdmin.render(app, parts[1] || 'dashboard', q);
          break;
        default: errorView(new Error('Page not found.'));
      }
    } catch (e) {
      if (e.status === 401) { location.hash = `#/login?next=${encodeURIComponent(hash)}`; return; }
      errorView(e);
    }
  }

  function applyPrefs(market, lang, rerender = true) {
    let changed = false;
    if (market && market !== S.market) { S.market = market; store.set('kk_market', market); changed = true; }
    if (lang && lang !== S.lang) { S.lang = lang; store.set('kk_lang', lang); changed = true; }
    if (changed && rerender) route();
  }

  // Global click handler for "add to cart" buttons on product cards
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    b.disabled = true;
    try {
      await cartAdd(b.dataset.add, 1, Number(b.dataset.stock));
      toast(t('added'), 'ok');
    } catch (err) { toast(err.message, 'error'); }
    b.disabled = false;
  });

  document.getElementById('search-form').onsubmit = (e) => {
    e.preventDefault();
    const v = document.getElementById('search-input').value.trim();
    location.hash = v ? `#/shop?q=${encodeURIComponent(v)}` : '#/shop';
  };
  document.getElementById('market-select').onchange = (e) => {
    const m = e.target.value;
    if (S.user) api('PUT', '/api/auth/me', { market: m }).then((r) => { S.user = r.user; }).catch(() => {});
    applyPrefs(m, null);
    refreshCartCount();
  };
  document.getElementById('lang-select').onchange = (e) => {
    if (S.user) api('PUT', '/api/auth/me', { language: e.target.value }).then((r) => { S.user = r.user; }).catch(() => {});
    applyPrefs(null, e.target.value);
  };
  window.addEventListener('hashchange', route);
  document.getElementById('year').textContent = new Date().getFullYear();

  // Expose helpers for admin.js
  window.KK = { S, api, esc, money, fmtDate, toast, statusPill, route, t };

  (async function boot() {
    try {
      S.config = await api('GET', '/api/catalog/config');
      if (!S.config.markets[S.market]) S.market = 'SG';
      if (!S.lang) S.lang = S.config.markets[S.market].defaultLang === 'en' ? 'en' : (navigator.language?.startsWith('en') ? 'en' : S.config.markets[S.market].defaultLang);
      api('GET', '/api/catalog/promotions').then((p) => { S.promos = p.promotions; renderHeader(); }).catch(() => {});
      if (S.token) {
        try { S.user = (await api('GET', '/api/auth/me')).user; } catch { setSession(null, null); }
      }
      await refreshCartCount();
    } catch (e) {
      errorView(e);
      return;
    }
    route();
  })();
})();
