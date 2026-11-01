// Catalogue service: products, search/filter/sort, reviews, promotions, recommendations.
// In AWS: read-heavy, served from DynamoDB/RDS behind CloudFront caching; images from S3.
const { Router } = require('../lib/router');
const db = require('../lib/db');
const { findProducts, decorateProduct } = require('../lib/pricing');
const { requireAuth } = require('../lib/security');
const { MARKETS, LANGUAGES } = require('../lib/markets');
const { log } = require('../lib/observability');

const router = Router();

const CATEGORIES = [
  { id: 'classic', name: 'Classic Kaya' },
  { id: 'specialty', name: 'Specialty Kaya' },
  { id: 'coconut', name: 'Coconut Jam' },
  { id: 'gifts', name: 'Gift Sets & Bundles' },
];

async function findProduct(key) {
  return (await findProducts('(p.id = ? OR p.slug = ?) AND p.active', [String(key), String(key)]))[0];
}

// productId -> units ever ordered
async function popularity() {
  const rows = await db.query('SELECT product_id, SUM(qty) AS units FROM order_items GROUP BY product_id');
  return Object.fromEntries(rows.map((r) => [r.productId, r.units]));
}

router.get('/config', (_req, res) => {
  res.json({ markets: MARKETS, languages: LANGUAGES, categories: CATEGORIES });
});

router.get('/categories', (_req, res) => res.json({ categories: CATEGORIES }));

router.get('/products', async (req, res) => {
  const { q, category, minPrice, maxPrice, sort = 'featured', onSale, inStock } = req.query;
  let list = (await findProducts('p.active')).map((p) => decorateProduct(p, req.market));
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
  const pop = sort === 'popular' ? await popularity() : null;
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

router.get('/products/:id', async (req, res) => {
  const p = await findProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  const reviews = await db.query('SELECT * FROM reviews WHERE product_id = ? ORDER BY created_at DESC', [p.id]);
  res.json({ product: decorateProduct(p, req.market), reviews });
});

router.post('/products/:id/reviews', requireAuth, async (req, res) => {
  const p = await findProduct(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found.' });
  const rating = Math.round(Number(req.body?.rating));
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Please choose a rating from 1 to 5.' });
  if (text.length < 3) return res.status(400).json({ error: 'Please write a short review.' });
  const already = { error: 'You have already reviewed this product.' };
  if (await db.one('SELECT 1 FROM reviews WHERE product_id = ? AND user_id = ?', [p.id, req.user.id])) return res.status(409).json(already);
  const verified = !!await db.one(
    "SELECT 1 FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.user_id = ? AND o.payment_status = 'paid' AND i.product_id = ? LIMIT 1",
    [req.user.id, p.id],
  );
  const review = { id: db.id('rev'), productId: p.id, userId: req.user.id, userName: req.user.name, rating, text, verified, createdAt: Date.now() };
  try {
    await db.query('INSERT INTO reviews (id, product_id, user_id, user_name, rating, text, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [review.id, review.productId, review.userId, review.userName, rating, text, verified, db.ts(review.createdAt)]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json(already);
    throw err;
  }
  res.status(201).json({ review });
});

router.get('/promotions', async (req, res) => {
  const promos = await db.query('SELECT code, description, type, value, min_spend FROM promotions WHERE active');
  const sales = (await findProducts('p.active AND p.sale_pct > 0')).map((p) => decorateProduct(p, req.market));
  res.json({ promotions: promos, sales });
});

// Recommendations are non-critical: failures must never block browsing or checkout.
// Set RECS_FAIL_RATE=0.5 to simulate a flaky recommendation service.
router.get('/recommendations', async (req, res) => {
  const failRate = Number(process.env.RECS_FAIL_RATE || 0);
  if (Math.random() < failRate) {
    log('warn', 'recommendations.unavailable');
    return res.status(503).json({ error: 'Recommendations temporarily unavailable.' });
  }
  const base = req.query.productId ? await findProduct(req.query.productId) : null;
  // "Customers also bought": order lines that share an order with the base product
  const rows = base
    ? await db.query('SELECT product_id, COUNT(*) AS score FROM order_items WHERE product_id <> ? AND order_id IN (SELECT order_id FROM order_items WHERE product_id = ?) GROUP BY product_id', [base.id, base.id])
    : await db.query('SELECT product_id, COUNT(*) AS score FROM order_items GROUP BY product_id');
  const score = Object.fromEntries(rows.map((r) => [r.productId, r.score]));
  const list = (await findProducts('p.active AND p.stock > 0'))
    .filter((p) => !base || p.id !== base.id)
    .sort((a, b) => (score[b.id] || 0) - (score[a.id] || 0))
    .slice(0, 4)
    .map((p) => decorateProduct(p, req.market));
  res.json({ products: list });
});

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
