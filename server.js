const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable.');
  process.exit(1);
}
if (!ADMIN_KEY) {
  console.warn('ADMIN_KEY is not set. Admin actions will be unavailable until it is configured.');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
});

app.use(cors({ origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.options('*', cors());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPG, JPEG or WEBP images are allowed.'));
  },
});

const CONFIG = Object.freeze({
  RATE_VB_PER_GRAM: 1296000,
  MIN_SWAP_VB: 1296000,
  MIN_WITHDRAW_GRAM: 1,
  MINER_REWARD_PER_SECOND: 1,
  MINER_SECONDS: 30 * 24 * 60 * 60,
  DEPOSIT_ADDRESS: 'UQAtwnP7Qt-DsZ9iFMY9ruuGdPDUUIPxP9zJ6qsekS2oljWz',
});

function cleanAppId(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
}

function makeAppId() {
  return `VB-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function toNum(v) {
  return Number(v || 0);
}

async function db() {
  const client = await pool.connect();
  try {
    return client;
  } catch (e) {
    client.release();
    throw e;
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vb_users (
      id BIGSERIAL PRIMARY KEY,
      app_id VARCHAR(40) UNIQUE NOT NULL,
      vb_balance NUMERIC(30,6) NOT NULL DEFAULT 0,
      gram_balance NUMERIC(30,9) NOT NULL DEFAULT 0,
      miner_active BOOLEAN NOT NULL DEFAULT FALSE,
      miner_started_at TIMESTAMPTZ,
      miner_expires_at TIMESTAMPTZ,
      miner_credited_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vb_purchase_requests (
      id BIGSERIAL PRIMARY KEY,
      request_id VARCHAR(60) UNIQUE NOT NULL,
      app_id VARCHAR(40) NOT NULL REFERENCES vb_users(app_id) ON DELETE CASCADE,
      amount_gram NUMERIC(20,9) NOT NULL DEFAULT 1,
      deposit_address TEXT NOT NULL,
      photo BYTEA NOT NULL,
      photo_mime VARCHAR(100) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS vb_withdrawals (
      id BIGSERIAL PRIMARY KEY,
      withdrawal_id VARCHAR(60) UNIQUE NOT NULL,
      app_id VARCHAR(40) NOT NULL REFERENCES vb_users(app_id) ON DELETE CASCADE,
      gram_amount NUMERIC(30,9) NOT NULL,
      ton_address TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      admin_note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_vb_purchase_status ON vb_purchase_requests(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vb_withdrawal_status ON vb_withdrawals(status, created_at DESC);
  `);
  console.log('VB database ready');
}

async function getUser(appId, client = pool) {
  const id = cleanAppId(appId);
  if (!id) return null;
  const result = await client.query('SELECT * FROM vb_users WHERE app_id = $1', [id]);
  return result.rows[0] || null;
}

async function settleMiner(client, appId) {
  const user = await getUser(appId, client);
  if (!user) return null;
  if (!user.miner_active || !user.miner_started_at || !user.miner_expires_at) return user;

  const now = Date.now();
  const started = new Date(user.miner_started_at).getTime();
  const expires = new Date(user.miner_expires_at).getTime();
  const elapsed = Math.max(0, Math.min(CONFIG.MINER_SECONDS, Math.floor((Math.min(now, expires) - started) / 1000)));
  const credited = Number(user.miner_credited_seconds || 0);
  const delta = Math.max(0, elapsed - credited);

  if (delta > 0 || (now >= expires && user.miner_active)) {
    const newBalance = toNum(user.vb_balance) + delta * CONFIG.MINER_REWARD_PER_SECOND;
    const newCredited = Math.min(CONFIG.MINER_SECONDS, elapsed);
    const active = now < expires && newCredited < CONFIG.MINER_SECONDS;
    await client.query(`
      UPDATE vb_users
      SET vb_balance = $1,
          miner_credited_seconds = $2,
          miner_active = $3,
          updated_at = NOW()
      WHERE app_id = $4
    `, [newBalance, newCredited, active, appId]);
    return await getUser(appId, client);
  }
  return user;
}

function serializeUser(user) {
  if (!user) return null;
  const vb = toNum(user.vb_balance);
  const gram = toNum(user.gram_balance);
  let remaining = 0;
  if (user.miner_active && user.miner_expires_at) {
    remaining = Math.max(0, Math.floor((new Date(user.miner_expires_at).getTime() - Date.now()) / 1000));
  }
  return {
    appId: user.app_id,
    vbBalance: vb,
    gramBalance: gram,
    totalBalanceGram: vb / CONFIG.RATE_VB_PER_GRAM + gram,
    activeMiner: Boolean(user.miner_active),
    activeMiners: user.miner_active ? 1 : 0,
    minerRewardPerSecond: CONFIG.MINER_REWARD_PER_SECOND,
    minerRemainingSeconds: remaining,
    minerCreditedSeconds: Number(user.miner_credited_seconds || 0),
    createdAt: user.created_at,
  };
}

function requireAdmin(req, res, next) {
  const supplied = req.get('x-admin-key') || req.query.key || '';
  if (!ADMIN_KEY || supplied !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized admin access.' });
  next();
}

app.get('/', (_req, res) => res.json({ status: 'Active', app: 'VB Miner Backend', version: '2.0', uploadEndpoint: '/api/purchase', adminPanel: 'https://dhrutivirani907-blip.github.io/?admin=1' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'VB Miner Backend', version: '2.0' }));
app.get('/admin', (_req, res) => res.redirect('https://dhrutivirani907-blip.github.io/?admin=1'));
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', config: CONFIG });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});
app.get('/health', (_req, res) => res.json({ status: 'ok', app: 'VB Miner Backend' }));
app.get('/api/config', (_req, res) => res.json(CONFIG));

app.post('/api/user/create', async (req, res) => {
  try {
    const requested = cleanAppId(req.body?.appId);
    if (requested) {
      const existing = await getUser(requested);
      if (existing) return res.json({ user: serializeUser(existing) });
      const r = await pool.query('INSERT INTO vb_users (app_id) VALUES ($1) RETURNING *', [requested]);
      return res.json({ user: serializeUser(r.rows[0]) });
    }
    for (let i = 0; i < 5; i++) {
      const appId = makeAppId();
      try {
        const r = await pool.query('INSERT INTO vb_users (app_id) VALUES ($1) RETURNING *', [appId]);
        return res.json({ user: serializeUser(r.rows[0]) });
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }
    res.status(500).json({ error: 'Could not create App ID. Please retry.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/user/:appId', async (req, res) => {
  try {
    const client = await db();
    try {
      const user = await settleMiner(client, req.params.appId);
      if (!user) return res.status(404).json({ error: 'App ID not found.' });
      res.json({ user: serializeUser(user) });
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/purchase', upload.single('proof'), async (req, res) => {
  const appId = cleanAppId(req.body.appId);
  if (!appId) return res.status(400).json({ error: 'App ID is required.' });
  if (!req.file) return res.status(400).json({ error: 'Payment proof image is required.' });
  try {
    const client = await db();
    try {
      await client.query('BEGIN');
      const user = await getUser(appId, client);
      if (!user) throw new Error('App ID not found.');
      await settleMiner(client, appId);
      const active = await client.query('SELECT 1 FROM vb_users WHERE app_id=$1 AND miner_active=true', [appId]);
      if (active.rowCount) throw new Error('Your miner is already active.');
      const pending = await client.query(`SELECT 1 FROM vb_purchase_requests WHERE app_id=$1 AND status='pending'`, [appId]);
      if (pending.rowCount) throw new Error('A purchase request is already under review.');
      const requestId = `PUR-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      await client.query(`
        INSERT INTO vb_purchase_requests (request_id, app_id, amount_gram, deposit_address, photo, photo_mime)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [requestId, appId, 1, CONFIG.DEPOSIT_ADDRESS, req.file.buffer, req.file.mimetype]);
      await client.query('COMMIT');
      res.json({ ok: true, requestId });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: e.message });
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/purchases/:appId', async (req, res) => {
  try {
    const appId = cleanAppId(req.params.appId);
    const r = await pool.query(`
      SELECT request_id AS "requestId", amount_gram AS "amountGram", status, created_at AS "createdAt", reviewed_at AS "reviewedAt"
      FROM vb_purchase_requests WHERE app_id=$1 ORDER BY created_at DESC
    `, [appId]);
    res.json({ purchases: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/convert', async (req, res) => {
  const appId = cleanAppId(req.body.appId);
  const requested = Number(req.body.vbAmount);
  if (!appId || !Number.isFinite(requested)) return res.status(400).json({ error: 'App ID and VB amount are required.' });
  if (requested < CONFIG.MIN_SWAP_VB) return res.status(400).json({ error: `Minimum swap is ${CONFIG.MIN_SWAP_VB.toLocaleString()} VB.` });
  if (requested % CONFIG.RATE_VB_PER_GRAM !== 0) return res.status(400).json({ error: `VB amount must be in multiples of ${CONFIG.RATE_VB_PER_GRAM.toLocaleString()}.` });
  try {
    const client = await db();
    try {
      await client.query('BEGIN');
      const user = await settleMiner(client, appId);
      if (!user) throw new Error('App ID not found.');
      const balance = toNum(user.vb_balance);
      if (requested > balance + 1e-9) throw new Error('Insufficient VB balance.');
      const grams = requested / CONFIG.RATE_VB_PER_GRAM;
      const updated = await client.query(`
        UPDATE vb_users SET vb_balance=vb_balance-$1, gram_balance=gram_balance+$2, updated_at=NOW()
        WHERE app_id=$3 RETURNING *
      `, [requested, grams, appId]);
      await client.query('COMMIT');
      res.json({ ok: true, convertedVB: requested, convertedGram: grams, user: serializeUser(updated.rows[0]) });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: e.message });
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/withdraw', async (req, res) => {
  const appId = cleanAppId(req.body.appId);
  const tonAddress = String(req.body.tonAddress || '').trim();
  const amount = Number(req.body.amountGram);
  if (!appId || !tonAddress || !Number.isFinite(amount)) return res.status(400).json({ error: 'App ID, TON address and amount are required.' });
  if (!/^([A-Za-z0-9_-]{40,80})$/.test(tonAddress)) return res.status(400).json({ error: 'Please enter a valid TON address.' });
  if (amount < CONFIG.MIN_WITHDRAW_GRAM) return res.status(400).json({ error: `Minimum withdrawal is ${CONFIG.MIN_WITHDRAW_GRAM} GRAM.` });
  try {
    const client = await db();
    try {
      await client.query('BEGIN');
      const user = await settleMiner(client, appId);
      if (!user) throw new Error('App ID not found.');
      const balance = toNum(user.gram_balance);
      if (amount > balance + 1e-9) throw new Error('Insufficient GRAM balance.');
      const existing = await client.query(`SELECT 1 FROM vb_withdrawals WHERE app_id=$1 AND status='pending'`, [appId]);
      if (existing.rowCount) throw new Error('You already have a pending withdrawal.');
      const withdrawalId = `WD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      await client.query(`UPDATE vb_users SET gram_balance=gram_balance-$1, updated_at=NOW() WHERE app_id=$2`, [amount, appId]);
      await client.query(`
        INSERT INTO vb_withdrawals (withdrawal_id, app_id, gram_amount, ton_address)
        VALUES ($1,$2,$3,$4)
      `, [withdrawalId, appId, amount, tonAddress]);
      await client.query('COMMIT');
      res.json({ ok: true, withdrawalId });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: e.message });
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/withdrawals/:appId', async (req, res) => {
  try {
    const appId = cleanAppId(req.params.appId);
    const r = await pool.query(`
      SELECT withdrawal_id AS "withdrawalId", gram_amount AS "gramAmount", ton_address AS "tonAddress", status, admin_note AS "adminNote", created_at AS "createdAt", reviewed_at AS "reviewedAt"
      FROM vb_withdrawals WHERE app_id=$1 ORDER BY created_at DESC
    `, [appId]);
    res.json({ withdrawals: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/purchases', requireAdmin, async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT request_id AS "requestId", app_id AS "appId", amount_gram AS "amountGram", status, created_at AS "createdAt", reviewed_at AS "reviewedAt"
      FROM vb_purchase_requests ORDER BY created_at DESC LIMIT 500
    `);
    res.json({ purchases: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/purchases/:requestId/photo', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT photo, photo_mime FROM vb_purchase_requests WHERE request_id=$1', [req.params.requestId]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].photo_mime);
    res.set('Cache-Control', 'private, max-age=60');
    res.send(r.rows[0].photo);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/purchases/:requestId/activate', requireAdmin, async (req, res) => {
  const requestId = String(req.params.requestId);
  try {
    const client = await db();
    try {
      await client.query('BEGIN');
      const request = await client.query('SELECT * FROM vb_purchase_requests WHERE request_id=$1 FOR UPDATE', [requestId]);
      if (!request.rowCount) throw new Error('Purchase request not found.');
      const p = request.rows[0];
      if (p.status !== 'pending') throw new Error(`Request is already ${p.status}.`);
      const user = await getUser(p.app_id, client);
      if (!user) throw new Error('User not found.');
      if (user.miner_active) throw new Error('Miner is already active for this App ID.');
      const started = new Date();
      const expires = new Date(started.getTime() + CONFIG.MINER_SECONDS * 1000);
      await client.query(`
        UPDATE vb_users SET miner_active=true, miner_started_at=$1, miner_expires_at=$2, miner_credited_seconds=0, updated_at=NOW()
        WHERE app_id=$3
      `, [started, expires, p.app_id]);
      await client.query(`UPDATE vb_purchase_requests SET status='approved', reviewed_at=NOW() WHERE request_id=$1`, [requestId]);
      await client.query('COMMIT');
      res.json({ ok: true, message: 'Miner activated.', appId: p.app_id, expiresAt: expires });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: e.message });
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/purchases/:requestId/reject', requireAdmin, async (req, res) => {
  try {
    const note = String(req.body.note || 'Rejected by admin').slice(0, 500);
    const r = await pool.query(`UPDATE vb_purchase_requests SET status='rejected', reviewed_at=NOW() WHERE request_id=$1 AND status='pending' RETURNING request_id`, [req.params.requestId]);
    if (!r.rowCount) return res.status(404).json({ error: 'Pending purchase request not found.' });
    res.json({ ok: true, note });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/withdrawals', requireAdmin, async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT withdrawal_id AS "withdrawalId", app_id AS "appId", gram_amount AS "gramAmount", ton_address AS "tonAddress", status, admin_note AS "adminNote", created_at AS "createdAt", reviewed_at AS "reviewedAt"
      FROM vb_withdrawals ORDER BY created_at DESC LIMIT 500
    `);
    res.json({ withdrawals: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:withdrawalId/approve', requireAdmin, async (req, res) => {
  try {
    const note = String(req.body.note || 'Approved by admin').slice(0, 500);
    const r = await pool.query(`UPDATE vb_withdrawals SET status='approved', reviewed_at=NOW(), admin_note=$1 WHERE withdrawal_id=$2 AND status='pending' RETURNING withdrawal_id`, [note, req.params.withdrawalId]);
    if (!r.rowCount) return res.status(404).json({ error: 'Pending withdrawal not found.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawals/:withdrawalId/reject', requireAdmin, async (req, res) => {
  const note = String(req.body.note || 'Rejected by admin').slice(0, 500);
  try {
    const client = await db();
    try {
      await client.query('BEGIN');
      const r = await client.query('SELECT * FROM vb_withdrawals WHERE withdrawal_id=$1 FOR UPDATE', [req.params.withdrawalId]);
      if (!r.rowCount) throw new Error('Withdrawal not found.');
      const w = r.rows[0];
      if (w.status !== 'pending') throw new Error(`Withdrawal is already ${w.status}.`);
      await client.query('UPDATE vb_users SET gram_balance=gram_balance+$1, updated_at=NOW() WHERE app_id=$2', [w.gram_amount, w.app_id]);
      await client.query(`UPDATE vb_withdrawals SET status='rejected', reviewed_at=NOW(), admin_note=$1 WHERE withdrawal_id=$2`, [note, w.withdrawal_id]);
      await client.query('COMMIT');
      res.json({ ok: true, refundedGram: toNum(w.gram_amount) });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: e.message });
    } finally { client.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT app_id AS "appId", vb_balance AS "vbBalance", gram_balance AS "gramBalance", miner_active AS "minerActive", miner_started_at AS "minerStartedAt", miner_expires_at AS "minerExpiresAt", created_at AS "createdAt"
      FROM vb_users ORDER BY created_at DESC LIMIT 1000
    `);
    res.json({ users: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: err.message || 'Server error.' });
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`VB Miner backend listening on port ${PORT}`)))
  .catch((e) => {
    console.error('DB init failed:', e);
    process.exit(1);
  });
