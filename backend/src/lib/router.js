// express.Router() whose handlers may be async: Express 4 ignores rejected promises, so each
// handler is wrapped to pass errors on to the app's error handler.
const express = require('express');

const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

function Router() {
  const router = express.Router();
  for (const method of ['use', 'get', 'post', 'put', 'delete']) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map((a) => (typeof a === 'function' && a.length < 4 ? wrap(a) : a)));
  }
  return router;
}

module.exports = { Router };
