// Catalogue service: products, search/filter/sort, reviews, promotions, recommendations.
// In AWS: read-heavy, served from DynamoDB/RDS behind CloudFront caching; images from S3.
const express = require('express');
const { table, id } = require('../lib/db');
const { decorateProduct } = require('../lib/pricing');
const { requireAuth } = require('../lib/security');
const { MARKETS, LANGUAGES } = require('../lib/markets');
const { log } = require('../lib/observability');

const router = express.Router();

const CATEGORIES = [
  { id: 'classic', name: 'Classic Kaya' },
  { id: 'specialty', name: 'Specialty Kaya' },
  { id: 'coconut', name: 'Coconut Jam' },
  { id: 'gifts', name: 'Gift Sets & Bundles' },
];

function findProduct(key) {
  return table('products').find((p) => (p.id === key || p.slug === key) && p.active);
}

function popularity() {
  const counts = {};
  for (const o of table('orders').all()) for (const it of o.items) counts[it.productId] = (counts[it.productId] || 0) + it.qty;
  return counts;
}

router.get('/config', (_req, res) => {
  res.json({ markets: MARKETS, languages: LANGUAGES, categories: CATEGORIES });
});

router.get('/categories', (_req, res) => res.json({ categories: CATEGORIES }));

router.get('/products', (req, res) => {
  const { q, category, minPrice, maxPrice, sort = 'featured', onSale, inStock } = req.query;
  let list = table('products').filter((p) => p.active).map((p) => decorateProduct(p, req.market));
  if (q) {
    const terms = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter((p) => {
      const hay = `${p.name} ${p.description} ${p.ingredients} ${p.category}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  if (category) list = list.filter((p) => p.category === category);
  // Price filters are in the shopper's local currency
  const price = (p) => p.salePriceLocal ?? p.priceLocal;
  if (minPrice) list = list.filter((p) => price(p) >= Number(minPrice));
  if (maxPrice) list = list.filter((p) => price(p) <= Number(maxPrice));
  if (onSale === '1') list = list.filter((p) => p.salePct > 0);
  if (inStock === '1') list = list.filter((p) => p.inStock);
  const pop = sort === 'popular' ? popularity() : null;
  const sorters = {
    featured: (a, b) => (b.featured - a.featured) || a.name.localeCompare(b.name),
    price_asc: (a, b) => price(a) - price(b),
    price_desc: (a, b) => price(b) - price(a),
    rating: (a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount,
    newest: (a, b) => b.createdAt - a.createdAt,
    name: (a, b) => a.name.localeCompare(b.name),
    popular: (a, b) => (pop[b.id] || 0) - (pop[a.id] || 0),
  };
  list.sort(sorters[sort] || sorters.featured);
  res.json({ products: list, total: list.length });
});

router.get('/products/:id', (req, res) => {
  const p = findProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  const reviews = table('reviews').filter((r) => r.productId === p.id).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ product: decorateProduct(p, req.market), reviews });
});

router.post('/products/:id/reviews', requireAuth, (req, res) => {
  const p = findProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  const rating = Math.round(Number(req.body?.rating));
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Please choose a rating from 1 to 5.' });
  if (text.length < 3) return res.status(400).json({ error: 'Please write a short review.' });
  if (table('reviews').find((r) => r.productId === p.id && r.userId === req.user.id)) return res.status(409).json({ error: 'You have already reviewed this product.' });
  const verified = table('orders').filter((o) => o.userId === req.user.id && o.paymentStatus === 'paid').some((o) => o.items.some((i) => i.productId === p.id));
  const review = table('reviews').insert({ id: id('rev'), productId: p.id, userId: req.user.id, userName: req.user.name, rating, text, verified, createdAt: Date.now() });
  res.status(201).json({ review });
});

router.get('/promotions', (req, res) => {
  const promos = table('promotions').filter((p) => p.active).map(({ code, description, type, value, minSpend }) => ({ code, description, type, value, minSpend }));
  const sales = table('products').filter((p) => p.active && p.salePct > 0).map((p) => decorateProduct(p, req.market));
  res.json({ promotions: promos, sales });
});

// Recommendations are non-critical: failures must never block browsing or checkout.
// Set RECS_FAIL_RATE=0.5 to simulate a flaky recommendation service.
router.get('/recommendations', (req, res) => {
  const failRate = Number(process.env.RECS_FAIL_RATE || 0);
  if (Math.random() < failRate) {
    log('warn', 'recommendations.unavailable');
    return res.status(503).json({ error: 'Recommendations temporarily unavailable.' });
  }
  const base = req.query.productId ? findProduct(req.query.productId) : null;
  // "Customers also bought": co-occurrence in past orders
  const score = {};
  for (const o of table('orders').all()) {
    const ids = o.items.map((i) => i.productId);
    if (base && !ids.includes(base.id)) continue;
    for (const pid of ids) if (!base || pid !== base.id) score[pid] = (score[pid] || 0) + 1;
  }
  const list = table('products')
    .filter((p) => p.active && p.stock > 0 && (!base || p.id !== base.id))
    .sort((a, b) => (score[b.id] || 0) - (score[a.id] || 0))
    .slice(0, 4)
    .map((p) => decorateProduct(p, req.market));
  res.json({ products: list });
});

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
