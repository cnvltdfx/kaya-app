// Lightweight JSON document store.
// Each "table" maps to what would be a DynamoDB table / RDS table in AWS.
// Writes are atomic (write to temp file then rename) and debounced.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const TABLES = [
  'users', 'sessions', 'products', 'reviews', 'carts', 'orders',
  'payments', 'promotions', 'notifications', 'reports', 'auditLog', 'mfaChallenges', 'resetTokens',
];

let state = null;
let saveTimer = null;

function empty() {
  const s = {};
  for (const t of TABLES) s[t] = [];
  return s;
}

function load() {
  if (state) return state;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const t of TABLES) if (!state[t]) state[t] = [];
  } else {
    state = empty();
  }
  return state;
}

function flush() {
  clearTimeout(saveTimer);
  if (!state) return;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 50);
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

const table = (name) => ({
  all: () => load()[name],
  find: (fn) => load()[name].find(fn),
  filter: (fn) => load()[name].filter(fn),
  get: (key) => load()[name].find((r) => r.id === key),
  insert(rec) {
    load()[name].push(rec);
    save();
    return rec;
  },
  update(key, patch) {
    const rec = load()[name].find((r) => r.id === key);
    if (!rec) return null;
    Object.assign(rec, patch);
    save();
    return rec;
  },
  remove(fn) {
    const s = load();
    const before = s[name].length;
    s[name] = s[name].filter((r) => !fn(r));
    save();
    return before - s[name].length;
  },
});

function reset() {
  state = empty();
  flush();
}

module.exports = { table, id, save, flush, reset, load, DB_FILE };
