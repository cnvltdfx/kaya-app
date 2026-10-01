// Cart service. Logged-in carts are persisted server-side (DynamoDB in AWS, keyed by userId);
// guest carts live in the browser and are merged into the account on login.
const express = require('express');
const { table, id } = require('../lib/db');
const { priceCart } = require('../lib/pricing');

const router = express.Router();

function getCart(userId) {
  let cart = table('carts').find((c) => c.userId === userId);
  if (!cart) cart = table('carts').insert({ id: id('crt'), userId, items: [], updatedAt: Date.now() });
  return cart;
}

function setItems(cart, items) {
  return table('carts').update(cart.id, { items: items.filter((i) => i.qty > 0), updatedAt: Date.now() });
}

const clampQty = (q) => Math.max(0, Math.min(99, Math.floor(Number(q) || 0)));

// Quote works for guests too (items sent in body) so the cart page can price a local cart.
router.post('/quote', (req, res) => {
  const items = req.user ? getCart(req.user.id).items : (req.body?.items || []);
  res.json(priceCart(items, req.market, { promoCode: req.body?.promoCode, fulfilment: req.body?.fulfilment, user: req.user }));
});

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
  next();
});

router.get('/', (req, res) => {
  res.json(priceCart(getCart(req.user.id).items, req.market, { user: req.user }));
});

router.post('/items', (req, res) => {
  const { productId } = req.body || {};
  const qty = clampQty(req.body?.qty ?? 1) || 1;
  const p = table('products').get(productId);
  if (!p || !p.active) return res.status(404).json({ error: 'Product not found.' });
  const cart = getCart(req.user.id);
  const items = [...cart.items];
  const existing = items.find((i) => i.productId === productId);
  const newQty = (existing?.qty || 0) + qty;
  if (newQty > p.stock) return res.status(409).json({ error: p.stock ? `Only ${p.stock} left in stock.` : 'Sorry, this item is sold out.' });
  if (existing) existing.qty = newQty; else items.push({ productId, qty });
  setItems(cart, items);
  res.json(priceCart(items, req.market, { user: req.user }));
});

router.put('/items/:productId', (req, res) => {
  const cart = getCart(req.user.id);
  const qty = clampQty(req.body?.qty);
  const p = table('products').get(req.params.productId);
  if (p && qty > p.stock) return res.status(409).json({ error: `Only ${p.stock} left in stock.` });
  const items = cart.items.map((i) => (i.productId === req.params.productId ? { ...i, qty } : i));
  setItems(cart, items);
  res.json(priceCart(items.filter((i) => i.qty > 0), req.market, { user: req.user }));
});

router.delete('/items/:productId', (req, res) => {
  const cart = getCart(req.user.id);
  const items = cart.items.filter((i) => i.productId !== req.params.productId);
  setItems(cart, items);
  res.json(priceCart(items, req.market, { user: req.user }));
});

router.post('/merge', (req, res) => {
  const cart = getCart(req.user.id);
  const items = [...cart.items];
  for (const g of req.body?.items || []) {
    const p = table('products').get(g.productId);
    if (!p) continue;
    const existing = items.find((i) => i.productId === g.productId);
    const qty = Math.min(p.stock, (existing?.qty || 0) + clampQty(g.qty));
    if (existing) existing.qty = qty; else if (qty > 0) items.push({ productId: g.productId, qty });
  }
  setItems(cart, items);
  res.json(priceCart(items, req.market, { user: req.user }));
});

module.exports = router;
module.exports.getCart = getCart;
module.exports.clearCart = (userId) => {
  const cart = getCart(userId);
  setItems(cart, []);
};
