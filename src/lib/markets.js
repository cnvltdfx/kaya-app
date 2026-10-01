// Market configuration for the four Asia-Pacific markets.
// Base prices are stored in SGD; other currencies are converted at checkout.
const MARKETS = {
  SG: { code: 'SG', name: 'Singapore', currency: 'SGD', rate: 1, timeZone: 'Asia/Singapore', defaultLang: 'en', shippingFee: 4.0, freeShippingOver: 60, pickup: true },
  MY: { code: 'MY', name: 'Malaysia', currency: 'MYR', rate: 3.45, timeZone: 'Asia/Kuala_Lumpur', defaultLang: 'ms', shippingFee: 12.0, freeShippingOver: 120, pickup: false },
  TH: { code: 'TH', name: 'Thailand', currency: 'THB', rate: 26.5, timeZone: 'Asia/Bangkok', defaultLang: 'th', shippingFee: 15.0, freeShippingOver: 120, pickup: false },
  HK: { code: 'HK', name: 'Hong Kong', currency: 'HKD', rate: 5.9, timeZone: 'Asia/Hong_Kong', defaultLang: 'zh-Hant', shippingFee: 15.0, freeShippingOver: 120, pickup: false },
};

const LANGUAGES = ['en', 'zh-Hans', 'zh-Hant', 'ms', 'th'];

function market(code) {
  return MARKETS[code] || MARKETS.SG;
}

// Convert an SGD amount into the market's currency, rounded to 2dp (THB to whole baht).
function convert(sgd, code) {
  const m = market(code);
  const v = sgd * m.rate;
  return m.currency === 'THB' ? Math.round(v) : Math.round(v * 100) / 100;
}

module.exports = { MARKETS, LANGUAGES, market, convert };
