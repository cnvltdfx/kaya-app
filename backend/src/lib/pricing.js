// Single source of truth for cart pricing, promotions and shipping across markets.
const db = require('./db');
const { market, convert } = require('./markets');

const round2 = (n) => Math.round(n * 100) / 100;

function unitPriceSgd(p) {
  return round2(p.price * (1 - (p.salePct || 0) / 100));
}

// Products with their review stats (ratingAvg, reviewCount), for decorateProduct.
// `where` is a trusted SQL fragment on alias p; values go in params.
async function findProducts(where = '1 = 1', params = []) {
  return db.query(
    `SELECT p.*, COALESCE(r.avg_rating, 0) AS rating_avg, COALESCE(r.review_count, 0) AS review_count
     FROM products p
     LEFT JOIN (SELECT product_id, AVG(rating) AS avg_rating, COUNT(*) AS review_count FROM reviews GROUP BY product_id) r ON r.product_id = p.id
     WHERE ${where}
     ORDER BY p.created_at, p.id`,
    params,
  );
}

// p: a row from findProducts
function decorateProduct({ ratingAvg, reviewCount, ...p }, mkt) {
  const m = market(mkt);
  return {
    ...p,
    currency: m.currency,
    priceLocal: convert(p.price, mkt),
    salePriceLocal: p.salePct ? convert(unitPriceSgd(p), mkt) : null,
    effectivePriceSgd: unitPriceSgd(p),
    rating: Math.round(Number(ratingAvg) * 10) / 10,
    reviewCount: Number(reviewCount),
    inStock: p.stock > 0,
    lowStock: p.stock > 0 && p.stock <= p.lowStockThreshold,
  };
}

// items: [{productId, qty}]
async function priceCart(items, mkt, { promoCode, fulfilment = 'delivery', user } = {}) {
  const m = market(mkt);
  const lines = [];
  const errors = [];
  const ids = (items || []).map((it) => String(it.productId));
  const products = ids.length ? await db.query('SELECT * FROM products WHERE id IN (?)', [ids]) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const it of items || []) {
    const p = byId.get(String(it.productId));
    if (!p || !p.active) { errors.push(`A product in your cart is no longer available.`); continue; }
    const qty = Math.max(1, Math.min(99, Math.floor(Number(it.qty) || 1)));
    if (qty > p.stock) errors.push(`Only ${p.stock} left of ${p.name}.`);
    const unitSgd = unitPriceSgd(p);
    lines.push({
      productId: p.id, slug: p.slug, name: p.name, size: p.size, image: p.image, qty, stock: p.stock,
      unitPriceSgd: unitSgd, unitPrice: convert(unitSgd, mkt), lineTotal: convert(unitSgd * qty, mkt),
    });
  }
  const subtotalSgd = round2(lines.reduce((s, l) => s + l.unitPriceSgd * l.qty, 0));

  let discountSgd = 0;
  let freeShipping = false;
  let promo = null;
  let promoError = null;
  if (promoCode) {
    promo = await db.one('SELECT * FROM promotions WHERE code = ? AND active', [String(promoCode).trim()]);
    const minSpendSgd = promo?.minSpend || 0;
    if (!promo) promoError = 'That promo code is not valid.';
    else if (subtotalSgd < minSpendSgd) promoError = `Spend at least S$${minSpendSgd.toFixed(2)} to use ${promo.code}.`;
    else if (promo.firstOrderOnly && user && await db.one("SELECT 1 FROM orders WHERE user_id = ? AND payment_status <> 'failed' LIMIT 1", [user.id])) promoError = `${promo.code} is for first orders only.`;
    else if (promo.type === 'percent') discountSgd = round2(subtotalSgd * promo.value / 100);
    else if (promo.type === 'shipping') freeShipping = true;
    if (promoError) promo = null;
  }

  const thresholdSgd = m.freeShippingOver / m.rate;
  let shippingSgd = 0;
  if (fulfilment === 'pickup' && m.pickup) shippingSgd = 0;
  else if (!lines.length || freeShipping || subtotalSgd - discountSgd >= thresholdSgd) shippingSgd = 0;
  else shippingSgd = round2(m.shippingFee / m.rate);

  const totalSgd = round2(subtotalSgd - discountSgd + shippingSgd);
  // Shipping fees are set per market in local currency, so use them as-is (avoids FX round-trip drift).
  const shippingLocal = shippingSgd ? m.shippingFee : 0;
  const subtotalLocal = convert(subtotalSgd, mkt);
  const discountLocal = convert(discountSgd, mkt);
  return {
    market: m.code, currency: m.currency, lines, errors,
    promo: promo ? { code: promo.code, description: promo.description } : null, promoError,
    subtotal: subtotalLocal, discount: discountLocal, shipping: shippingLocal, total: round2(subtotalLocal - discountLocal + shippingLocal),
    subtotalSgd, discountSgd, shippingSgd, totalSgd,
    freeShippingOver: m.freeShippingOver, fulfilment: fulfilment === 'pickup' && m.pickup ? 'pickup' : 'delivery',
    itemCount: lines.reduce((s, l) => s + l.qty, 0),
  };
}

module.exports = { priceCart, findProducts, decorateProduct, unitPriceSgd, round2 };
