const express = require('express');
const path = require('path');
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const SHELTERS = [
  { id: 'riv', name: 'Riverside High School', pin: '1111' },
  { id: 'cen', name: 'Central Community Center', pin: '2222' },
  { id: 'fgr', name: 'Fairgrounds Hall', pin: '3333' },
];

// ---- Storage: Firestore when FIREBASE_SERVICE_ACCOUNT is set, otherwise in memory ----
function memoryStore() {
  const cols = {}; let n = 0;
  const c = (k) => (cols[k] ||= []);
  return {
    list: async (k) => c(k).map((d) => ({ ...d })),
    add: async (k, doc) => { const d = { ...doc, id: 'm' + ++n }; c(k).push(d); return { ...d }; },
    update: async (k, id, p) => { Object.assign(c(k).find((d) => d.id === id), p); },
  };
}
function firestoreStore() {
  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  const db = admin.firestore();
  return {
    list: async (k) => (await db.collection(k).get()).docs.map((d) => ({ ...d.data(), id: d.id })),
    add: async (k, doc) => ({ ...doc, id: (await db.collection(k).add(doc)).id }),
    update: async (k, id, p) => { await db.collection(k).doc(id).update(p); },
  };
}
const store = process.env.FIREBASE_SERVICE_ACCOUNT ? firestoreStore() : memoryStore();

// ---- Fuzzy name matching (spelling variants, accents; aliases are matched too) ----
const norm = (s = '') => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length);
function nameScore(q, target) {
  const qt = norm(q), tt = norm(target);
  if (!qt.length || !tt.length) return 0;
  return qt.reduce((s, t) => s + Math.max(...tt.map((x) => sim(t, x))), 0) / qt.length;
}
function score(q, p) {
  if (q.code && q.code.trim().toUpperCase() === p.code) return 1;
  let s = Math.max(nameScore(q.name, p.name), nameScore(q.name, p.alias));
  if (q.ageRange && p.ageRange && q.ageRange !== p.ageRange) s *= 0.85;
  return s;
}
const findMatches = async (q) =>
  (await store.list('people')).map((p) => ({ p, s: score(q || {}, p) })).filter((x) => x.s >= 0.72).sort((a, b) => b.s - a.s);

// ---- Middleware ----
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Something went wrong. Try again.' }); });
const publicHits = {};
const staffHits = {};
const limit = (req, res, next) => {
  const t = Date.now();
  publicHits[req.ip] = (publicHits[req.ip] || []).filter((x) => t - x < 60000);
  if (publicHits[req.ip].length >= 20) return res.status(429).json({ error: 'Too many searches. Wait a minute and try again.' });
  publicHits[req.ip].push(t); next();
};
const staffLimit = (req, res, next) => {
  const t = Date.now();
  staffHits[req.ip] = (staffHits[req.ip] || []).filter((x) => t - x < 60000);
  if (staffHits[req.ip].length >= 60) return res.status(429).json({ error: 'Too many shelter requests. Wait a minute and try again.' });
  staffHits[req.ip].push(t); next();
};
const staff = (req, res, next) => {
  const s = SHELTERS.find((x) => x.pin === req.get('x-pin'));
  if (!s) return res.status(401).json({ error: 'That PIN is not right.' });
  req.shelter = s; next();
};

// ---- Public: search shows ONLY people who chose to be listed ----
app.post('/api/search', limit, wrap(async (req, res) => {
  const found = (await findMatches(req.body)).filter((x) => x.p.visibility === 'open');
  res.json({ results: found.map(({ p }) => ({ code: p.code, displayName: p.name || p.alias, ageRange: p.ageRange, shelterName: SHELTERS.find((s) => s.id === p.shelter).name })) });
}));

// ---- Public: leave a note. Same reply every time; hidden people are never notified ----
app.post('/api/notes', limit, wrap(async (req, res) => {
  const { query = {}, contact = '', message = '' } = req.body;
  await store.add('notes', {
    query: { name: query.name || '', code: query.code || '', ageRange: query.ageRange || '' },
    contact: String(contact).slice(0, 300),
    message: String(message).slice(0, 1000),
    ageRange: query.ageRange || '',
    doneBy: [],
    status: 'new',
    createdAt: Date.now()
  });
  res.json({ ok: true });
}));

// ---- Staff (shelter PIN) ----
app.get('/api/staff/me', staffLimit, staff, (req, res) => res.json({ name: req.shelter.name }));

app.post('/api/people', staffLimit, staff, wrap(async (req, res) => {
  const b = req.body, t = (v) => String(v || '').trim().slice(0, 200);
  const minor = ['child', 'teen'].includes(b.ageRange);
  const unknownAge = !b.ageRange;
  const visibility = minor ? 'ask' : ['open', 'ask', 'hidden'].includes(b.visibility) ? (unknownAge && b.visibility === 'open' ? 'ask' : b.visibility) : 'ask';
  const p = await store.add('people', { code: req.shelter.id.toUpperCase() + '-' + Math.floor(1000 + Math.random() * 9000), shelter: req.shelter.id, name: t(b.name), alias: t(b.alias), ageRange: b.ageRange || '', travelingWith: t(b.travelingWith), lastSeen: t(b.lastSeen), visibility, createdAt: Date.now() });
  res.json({ code: p.code, visibility });
}));

app.get('/api/staff/notes', staffLimit, staff, wrap(async (req, res) => {
  const notes = (await store.list('notes')).filter((n) => !Array.isArray(n.doneBy) || !n.doneBy.includes(req.shelter.id));
  const people = await store.list('people');
  const out = [];
  for (const n of notes) {
    const q = { name: n.query?.name || '', code: n.query?.code || '', ageRange: n.ageRange || n.query?.ageRange || '' };
    const peopleForThisShelter = (await findMatches(q)).filter((x) => x.p.shelter === req.shelter.id && x.p.visibility !== 'hidden').map(({ p }) => ({ code: p.code, name: p.name, alias: p.alias, visibility: p.visibility }));
    if (!peopleForThisShelter.length) continue;
    out.push({
      id: n.id,
      createdAt: n.createdAt,
      searchedFor: n.query?.name || n.query?.code || '',
      contact: n.contact,
      message: n.message,
      people: peopleForThisShelter,
    });
  }
  res.json({ notes: out });
}));

app.post('/api/staff/notes/:id/resolve', staffLimit, staff, wrap(async (req, res) => {
  const notes = await store.list('notes');
  const note = notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: 'That note was not found.' });
  const doneBy = Array.isArray(note.doneBy) ? [...new Set([...note.doneBy, req.shelter.id])] : [req.shelter.id];
  await store.update('notes', req.params.id, { doneBy, status: 'done' });
  res.json({ ok: true });
}));

// ---- Demo data (clearly fake) ----
async function seed() {
  if ((await store.list('people')).length) return;
  const F = ['Maria', 'James', 'Aaliyah', 'Chen', 'Omar', 'Sofia', 'Dmitri', 'Grace', 'Luis', 'Priya', 'Hannah', 'Tyrone'];
  const L = ['Alvarez', 'Johnson', 'Nguyen', 'Okafor', 'Haddad', 'Kim', 'Petrov', 'Brooks', 'Santos', 'Patel'];
  const ages = ['child', 'teen', 'adult', 'adult', 'adult', 'senior'], sh = ['riv', 'cen', 'fgr'];
  for (let i = 0; i < 30; i++) {
    const age = ages[i % 6], minor = age === 'child' || age === 'teen';
    await store.add('people', { code: sh[i % 3].toUpperCase() + '-' + (1000 + i * 37), shelter: sh[i % 3], name: i === 5 ? '' : F[i % 12] + ' ' + L[(i * 7) % 10], alias: i === 5 ? 'Abuela Rosa' : '', ageRange: age, travelingWith: '', lastSeen: '', visibility: minor ? 'ask' : i % 10 === 0 ? 'hidden' : i % 3 === 0 ? 'ask' : 'open', createdAt: Date.now() });
  }
}

app.use(express.static(path.join(__dirname, '../client/dist')));
app.use((req, res) => res.sendFile(path.join(__dirname, '../client/dist/index.html')));
seed().then(() => app.listen(process.env.PORT || 3000, () => console.log('running')));
