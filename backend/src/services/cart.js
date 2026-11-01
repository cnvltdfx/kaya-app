// Cart service. Logged-in carts are persisted server-side (cart_items, keyed by user);
// guest carts live in the browser and are merged into the account on login.
const { Router } = require('../lib/router');
const db = require('../lib/db');
const { priceCart } = require('../lib/pricing');

const router = Router();

async function getCart(userId) {
  const items = await db.query('SELECT product_id, qty FROM cart_items WHERE user_id = ? ORDER BY added_at, product_id', [userId]);
  return { userId, items };
}

// Replaces the user's cart with items (in order), dropping zero quantities.
async function setItems(userId, items) {
  const keep = items.filter((i) => i.qty > 0);
  const now = Date.now();
  await db.tx(async (t) => {
    await t.query('DELETE FROM cart_items WHERE user_id = ?', [userId]);
    if (keep.length) await t.query('INSERT INTO cart_items (user_id, product_id, qty, added_at) VALUES ?', [keep.map((i, n) => [userId, i.productId, i.qty, db.ts(now + n)])]);
  });
  return keep;
}

const getProduct = (productId) => db.one('SELECT * FROM products WHERE id = ?', [String(productId)]);

const clampQty = (q) => Math.max(0, Math.min(99, Math.floor(Number(q) || 0)));

// Quote works for guests too (items sent in body) so the cart page can price a local cart.
router.post('/quote', async (req, res) => {
  const items = req.user ? (await getCart(req.user.id)).items : (req.body?.items || []);
  res.json(await priceCart(items, req.market, { promoCode: req.body?.promoCode, fulfilment: req.body?.fulfilment, user: req.user }));
});

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  next();
});

router.get('/', async (req, res) => {
  res.json(await priceCart((await getCart(req.user.id)).items, req.market, { user: req.user }));
});

router.post('/items', async (req, res) => {
  const { productId } = req.body || {};
  const qty = clampQty(req.body?.qty ?? 1) || 1;
  const p = await getProduct(productId);
  if (!p || !p.active) return res.status(404).json({ error: 'Product not found.' });
  const items = [...(await getCart(req.user.id)).items];
  const existing = items.find((i) => i.productId === productId);
  const newQty = (existing?.qty || 0) + qty;
  if (newQty > p.stock) return res.status(409).json({ error: p.stock ? `Only ${p.stock} left in stock.` : 'Sorry, this item is sold out.' });
  if (existing) existing.qty = newQty; else items.push({ productId, qty });
  await setItems(req.user.id, items);
  res.json(await priceCart(items, req.market, { user: req.user }));
});

router.put('/items/:productId', async (req, res) => {
  const cart = await getCart(req.user.id);
  const qty = clampQty(req.body?.qty);
  const p = await getProduct(req.params.productId);
  if (p && qty > p.stock) return res.status(409).json({ error: `Only ${p.stock} left in stock.` });
  const items = cart.items.map((i) => (i.productId === req.params.productId ? { ...i, qty } : i));
  await setItems(req.user.id, items);
  res.json(await priceCart(items.filter((i) => i.qty > 0), req.market, { user: req.user }));
});

router.delete('/items/:productId', async (req, res) => {
  const items = (await getCart(req.user.id)).items.filter((i) => i.productId !== req.params.productId);
  await setItems(req.user.id, items);
  res.json(await priceCart(items, req.market, { user: req.user }));
});

router.post('/merge', async (req, res) => {
  const items = [...(await getCart(req.user.id)).items];
  for (const g of req.body?.items || []) {
    const p = await getProduct(g.productId);
    if (!p) continue;
    const existing = items.find((i) => i.productId === g.productId);
    const qty = Math.min(p.stock, (existing?.qty || 0) + clampQty(g.qty));
    if (existing) existing.qty = qty; else if (qty > 0) items.push({ productId: g.productId, qty });
  }
  await setItems(req.user.id, items);
  res.json(await priceCart(items, req.market, { user: req.user }));
});

module.exports = router;
module.exports.getCart = getCart;
// Takes an optional transaction so checkout can empty the cart in the same commit as the order.
module.exports.clearCart = (userId, t = db) => t.query('DELETE FROM cart_items WHERE user_id = ?', [userId]);
