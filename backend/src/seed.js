// Seeds the store with products, promotions, demo users, reviews and historical orders.
// Run `npm run seed` to wipe and reseed. The server seeds automatically on first start.
//
// Demo accounts (development only):
//   customer  demo@koolkaya.sg   / Demo@1234
//   staff     staff@koolkaya.sg  / Staff@1234   (MFA code required)
//   admin     admin@koolkaya.sg  / Admin@1234   (MFA code required)
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const { hashPassword } = require('./lib/security');
const { convert, MARKETS } = require('./lib/markets');

// Product art is committed in the frontend; `npm run images` regenerates it there.
const IMG_DIR = process.env.PRODUCT_IMG_DIR || path.join(__dirname, '..', '..', 'frontend', 'img', 'products');

const PRODUCTS = [
  { slug: 'classic-pandan', name: 'Classic Pandan Kaya', size: '250g', price: 9.9, category: 'classic', stock: 120, jam: '#8fae3c', jam2: '#b9c95a', lid: '#e9dcc0', featured: true,
    description: 'Our signature kaya, slow-stirred for six hours with fresh pandan leaves, free-range eggs and coconut cream. Silky, fragrant and just sweet enough.', ingredients: 'Coconut cream, free-range eggs, sugar, fresh pandan juice' },
  { slug: 'nyonya-gula-melaka', name: 'Nyonya Gula Melaka Kaya', size: '250g', price: 10.9, category: 'classic', stock: 95, jam: '#b8792f', jam2: '#d79c4c', lid: '#e8d5b0', featured: true,
    description: 'A Peranakan family recipe using smoky gula melaka palm sugar for deep caramel notes. Perfect on warm toast with cold butter.', ingredients: 'Coconut cream, eggs, gula melaka, pandan' },
  { slug: 'hainanese-caramel', name: 'Hainanese Caramel Kaya', size: '250g', price: 10.5, category: 'classic', stock: 80, jam: '#8a5420', jam2: '#a86b2c', lid: '#dccaa8',
    description: 'The kopitiam classic. Sugar is caramelised before it meets the custard, giving a rich brown kaya with a toasty finish.', ingredients: 'Coconut cream, eggs, caramelised sugar' },
  { slug: 'low-sugar-pandan', name: 'Low-Sugar Pandan Kaya', size: '250g', price: 11.5, category: 'classic', stock: 60, jam: '#a6c05a', jam2: '#c6d77f', lid: '#efe6cf',
    description: '40% less sugar, all of the pandan. Sweetened lightly with coconut sugar for a gentler everyday spread.', ingredients: 'Coconut cream, eggs, coconut sugar, pandan' },
  { slug: 'durian-kaya', name: 'Musang King Durian Kaya', size: '200g', price: 14.9, category: 'specialty', stock: 40, jam: '#e3b93a', jam2: '#f0d16a', lid: '#f1e3b8', featured: true,
    description: 'Small-batch kaya folded with Musang King durian pulp. Bold, creamy and unapologetically pungent.', ingredients: 'Coconut cream, eggs, sugar, Musang King durian' },
  { slug: 'salted-egg-kaya', name: 'Salted Egg Yolk Kaya', size: '200g', price: 13.9, category: 'specialty', stock: 35, jam: '#e8a530', jam2: '#f3c35b', lid: '#f2e1bd',
    description: 'Sweet meets savoury: classic kaya enriched with cured salted egg yolk and a hint of curry leaf.', ingredients: 'Coconut cream, eggs, salted egg yolk, sugar, curry leaf' },
  { slug: 'coconut-jam-original', name: 'Coconut Jam Original', size: '300g', price: 9.5, category: 'coconut', stock: 150, jam: '#d6a35a', jam2: '#e6bf7d', lid: '#efe2c6',
    description: 'A thicker, spoonable coconut jam made with freshly grated coconut. Great on pancakes, ice cream or straight from the jar.', ingredients: 'Fresh coconut milk, eggs, sugar' },
  { slug: 'coconut-jam-toasted', name: 'Toasted Coconut Jam', size: '300g', price: 10.5, category: 'coconut', stock: 70, jam: '#a8692d', jam2: '#c58745', lid: '#e3cfa8',
    description: 'We toast the coconut before cooking for a nutty, roasted aroma. A customer favourite in Hong Kong.', ingredients: 'Toasted coconut, coconut milk, eggs, sugar' },
  { slug: 'tasting-flight', name: 'Mini Tasting Flight (6 x 50g)', size: '6 x 50g', price: 19.9, category: 'gifts', stock: 50, jam: '#c08b3c', jam2: '#8fae3c', lid: '#e9dcc0', multi: true,
    description: 'Six mini jars covering our full range. The best way to find your favourite, or to share with friends.', ingredients: 'Assorted, see individual jars' },
  { slug: 'heritage-gift-box', name: 'Heritage Gift Box (3 jars)', size: '3 x 250g', price: 32.9, category: 'gifts', stock: 45, jam: '#b8792f', jam2: '#8fae3c', lid: '#d9c49b', multi: true, featured: true,
    description: 'Pandan, Gula Melaka and Hainanese Caramel in a hand-tied kraft gift box with a recipe card. Ideal for festive gifting.', ingredients: 'Assorted' },
  { slug: 'kaya-toast-set', name: 'Kaya Toast Breakfast Set', size: 'Set', price: 24.9, category: 'gifts', stock: 30, jam: '#8fae3c', jam2: '#d79c4c', lid: '#e9dcc0', multi: true,
    description: 'Everything for a kopitiam breakfast at home: Pandan Kaya, salted butter, a kaya spreader and our toast guide.', ingredients: 'Classic Pandan Kaya, cultured salted butter' },
  { slug: 'festive-hamper', name: 'Festive Celebration Hamper', size: 'Hamper', price: 58.0, category: 'gifts', stock: 20, jam: '#e3b93a', jam2: '#b8792f', lid: '#d4b98a', multi: true,
    description: 'Four full-size jars, tasting flight, spreader and a woven rattan basket. Our most generous gift.', ingredients: 'Assorted' },
];

const PROMOTIONS = [
  { code: 'WELCOME10', description: '10% off your first order', type: 'percent', value: 10, minSpend: 0, firstOrderOnly: true, active: true },
  { code: 'KAYA1111', description: '11.11 Mega Sale: 11% off orders above S$30', type: 'percent', value: 11, minSpend: 30, active: true },
  { code: 'FREESHIP', description: 'Free shipping on any order', type: 'shipping', value: 0, minSpend: 0, active: true },
];

// Product-level sales (shown as strikethrough prices)
const SALES = { 'durian-kaya': 15, 'heritage-gift-box': 10 };

function jarSvg(p) {
  const jar = (x, scale, jam, jam2, lid) => `
  <g transform="translate(${x} ${60 + (1 - scale) * 220}) scale(${scale})">
    <ellipse cx="100" cy="262" rx="78" ry="10" fill="#000" opacity=".08"/>
    <path d="M40 70 Q30 80 30 110 L30 225 Q30 255 60 258 L140 258 Q170 255 170 225 L170 110 Q170 80 160 70 Z" fill="${jam}"/>
    <path d="M40 120 L170 120 L170 225 Q170 255 140 258 L60 258 Q30 255 30 225 Z" fill="${jam2}" opacity=".55"/>
    <path d="M45 85 Q42 150 48 235" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".35" fill="none"/>
    <rect x="52" y="140" width="96" height="60" rx="8" fill="#fbf4e4" stroke="#7a4a1d" stroke-width="2.5"/>
    <text x="100" y="166" text-anchor="middle" font-family="Georgia,serif" font-size="13" font-weight="700" fill="#5c3612">KOOL KAYA</text>
    <text x="100" y="185" text-anchor="middle" font-family="Georgia,serif" font-size="10" fill="#7a4a1d">artisan</text>
    <path d="M28 55 Q20 70 40 75 Q70 82 100 80 Q130 82 160 75 Q180 70 172 55 Q100 35 28 55 Z" fill="${lid}" stroke="#a07b48" stroke-width="2"/>
    <path d="M32 68 Q100 86 168 68" stroke="#8a5a2b" stroke-width="3" fill="none"/>
    <circle cx="100" cy="76" r="5" fill="#8a5a2b"/>
  </g>`;
  const body = p.multi
    ? jar(10, 0.72, p.jam2, p.jam, p.lid) + jar(170, 0.72, p.jam, p.jam2, p.lid) + jar(80, 0.92, p.jam, p.jam2, p.lid)
    : jar(100, 1, p.jam, p.jam2, p.lid);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 360">
  <defs><radialGradient id="bg" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#fbf3e2"/><stop offset="1" stop-color="#f1e2c4"/></radialGradient></defs>
  <rect width="400" height="360" fill="url(#bg)"/>
  <g fill="#6f9a3a" opacity=".55">
    <path d="M20 330 Q60 280 120 300 Q70 310 20 330Z"/><path d="M380 330 Q340 280 280 300 Q330 310 380 330Z"/>
    <path d="M30 40 Q80 20 120 60 Q70 50 30 40Z"/><path d="M370 40 Q320 20 280 60 Q330 50 370 40Z"/>
  </g>${body}
</svg>`;
}

function seed({ reset = false } = {}) {
  if (reset) db.reset();
  const products = db.table('products');
  if (products.all().length) return false;

  const now = Date.now();
  for (const p of PRODUCTS) {
    products.insert({
      id: `prd_${p.slug}`,
      slug: p.slug,
      name: p.name,
      size: p.size,
      category: p.category,
      price: p.price,
      salePct: SALES[p.slug] || 0,
      stock: p.stock,
      lowStockThreshold: 15,
      featured: !!p.featured,
      description: p.description,
      ingredients: p.ingredients,
      image: `/img/products/${p.slug}.svg`,
      active: true,
      createdAt: now,
    });
  }

  for (const promo of PROMOTIONS) db.table('promotions').insert({ id: db.id('promo'), ...promo });

  const users = db.table('users');
  const mk = (email, name, role, pw, market, extra = {}) => users.insert({
    id: db.id('usr'), email, name, role, passwordHash: hashPassword(pw), market, language: MARKETS[market].defaultLang,
    phone: '', address: { line1: '', line2: '', city: '', postcode: '', country: MARKETS[market].name },
    mfaEnabled: role !== 'customer', createdAt: now - 90 * 864e5, ...extra,
  });
  mk('admin@koolkaya.sg', 'Aisha (Admin)', 'admin', 'Admin@1234', 'SG');
  mk('staff@koolkaya.sg', 'Ben (Ops Staff)', 'staff', 'Staff@1234', 'SG');
  const demo = mk('demo@koolkaya.sg', 'Demo Customer', 'customer', 'Demo@1234', 'SG', {
    phone: '+65 8123 4567', language: 'en',
    address: { line1: '1 Kaya Lane', line2: '#01-23', city: 'Singapore', postcode: '123456', country: 'Singapore' },
  });

  // Synthetic shoppers per market for historical data (80% SG, rest split evenly)
  const shoppers = { SG: [demo], MY: [], TH: [], HK: [] };
  const names = { SG: ['Wei Ling', 'Rahul', 'Siti'], MY: ['Ahmad', 'Mei Hua'], TH: ['Somchai', 'Ploy'], HK: ['Ka Yan', 'Jason'] };
  for (const [m, list] of Object.entries(names)) {
    for (const n of list) shoppers[m].push(mk(`${n.toLowerCase().replace(/\s/g, '.')}@example.com`, n, 'customer', `Shop@${Math.random().toString(36).slice(2, 8)}A1`, m));
  }

  // Reviews
  const reviewTexts = [
    [5, 'Tastes exactly like my grandmother\'s. The pandan is so fragrant!'],
    [5, 'Silky smooth, not too sweet. Already ordered a second jar.'],
    [4, 'Lovely flavour, wish the jar was bigger.'],
    [5, 'Perfect with thick toast and cold butter. Kopitiam at home.'],
    [4, 'Great gift, my colleagues loved it.'],
    [3, 'Good but a bit too sweet for me.'],
  ];
  const allShoppers = Object.values(shoppers).flat();
  products.all().forEach((p, i) => {
    const n = 2 + (i % 3);
    for (let k = 0; k < n; k++) {
      const [rating, text] = reviewTexts[(i + k) % reviewTexts.length];
      const u = allShoppers[(i * 3 + k) % allShoppers.length];
      db.table('reviews').insert({ id: db.id('rev'), productId: p.id, userId: u.id, userName: u.name, rating, text, verified: true, createdAt: now - (k + 1) * 6 * 864e5 });
    }
  });

  // Historical orders over the last 30 days
  const statuses = ['delivered', 'delivered', 'delivered', 'shipped', 'processing'];
  let rnd = 42;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const plist = products.all();
  for (let i = 0; i < 160; i++) {
    const r = rand();
    const market = r < 0.8 ? 'SG' : r < 0.8667 ? 'MY' : r < 0.9333 ? 'TH' : 'HK';
    const user = shoppers[market][Math.floor(rand() * shoppers[market].length)];
    const items = [];
    const count = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < count; k++) {
      const p = plist[Math.floor(rand() * plist.length)];
      const unitSgd = Math.round(p.price * (1 - p.salePct / 100) * 100) / 100;
      items.push({ productId: p.id, name: p.name, qty: 1 + Math.floor(rand() * 2), unitPriceSgd: unitSgd, unitPrice: convert(unitSgd, market) });
    }
    const subtotalSgd = items.reduce((s, it) => s + it.unitPriceSgd * it.qty, 0);
    const shippingSgd = subtotalSgd >= MARKETS[market].freeShippingOver / MARKETS[market].rate ? 0 : MARKETS[market].shippingFee / MARKETS[market].rate;
    const createdAt = now - Math.floor(rand() * 30 * 864e5);
    const totalSgd = Math.round((subtotalSgd + shippingSgd) * 100) / 100;
    const status = createdAt > now - 2 * 864e5 ? 'processing' : statuses[Math.floor(rand() * statuses.length)];
    const orderId = `KK${(100000 + i).toString()}`;
    db.table('orders').insert({
      id: orderId, userId: user.id, email: user.email, market, currency: MARKETS[market].currency,
      items, fulfilment: market === 'SG' && rand() < 0.2 ? 'pickup' : 'delivery',
      address: user.address, subtotal: convert(subtotalSgd, market), discount: 0, shipping: convert(shippingSgd, market),
      total: convert(totalSgd, market), totalSgd, promoCode: null, paymentMethod: ['card', 'paynow', 'applepay'][Math.floor(rand() * 3)],
      paymentStatus: 'paid', status, statusHistory: [{ status: 'placed', at: createdAt }, ...(status !== 'processing' ? [{ status, at: createdAt + 864e5 }] : [])],
      createdAt,
    });
  }
  db.flush();
  return true;
}

function writeProductImages(dir = IMG_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  for (const p of PRODUCTS) fs.writeFileSync(path.join(dir, `${p.slug}.svg`), jarSvg(p));
  return dir;
}

module.exports = { seed, writeProductImages };

if (require.main === module) {
  if (process.argv.includes('--images')) {
    console.log('Wrote product images to', writeProductImages());
  } else {
    seed({ reset: process.argv.includes('--reset') });
    console.log('Seeded database at', db.DB_FILE);
  }
}
