const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-admin-key']
}));
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// BABYDOGE reward settings
const MIN_WITHDRAWAL = 10000000;
const TASK_REWARD = 300000;
const REFERRAL_REWARD = 300000;
const TOKEN_NAME = 'BABYDOGE';

// =====================================================
// DATABASE MIGRATION & SCHEMA FIXES
// =====================================================
const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS withdrawals (
                id VARCHAR(255) PRIMARY KEY,
                user_id VARCHAR(255),
                binance_id VARCHAR(255),
                wallet VARCHAR(255),
                amount NUMERIC NOT NULL,
                type VARCHAR(50) DEFAULT 'Binance',
                token_type VARCHAR(50) DEFAULT 'BABYDOGE',
                total_deduct NUMERIC DEFAULT 0,
                status VARCHAR(50) DEFAULT 'Pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            ALTER TABLE withdrawals
            ADD COLUMN IF NOT EXISTS user_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS binance_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS wallet VARCHAR(255),
            ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'Binance',
            ADD COLUMN IF NOT EXISTS token_type VARCHAR(50) DEFAULT 'BABYDOGE',
            ADD COLUMN IF NOT EXISTS total_deduct NUMERIC DEFAULT 0,
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

            ALTER TABLE withdrawals ALTER COLUMN user_id DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN binance_id DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN wallet DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN type DROP NOT NULL;
            ALTER TABLE withdrawals ALTER COLUMN total_deduct DROP NOT NULL;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS bonk_referrals (
                id BIGSERIAL PRIMARY KEY,
                referrer_id VARCHAR(255) NOT NULL,
                referred_user_id VARCHAR(255) NOT NULL UNIQUE,
                referral_code VARCHAR(255) NOT NULL,
                reward NUMERIC NOT NULL DEFAULT ${REFERRAL_REWARD},
                status VARCHAR(50) NOT NULL DEFAULT 'Completed',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            ALTER TABLE bonk_referrals ALTER COLUMN reward SET DEFAULT ${REFERRAL_REWARD};
        `);

        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS unique_bonk_referral_user
            ON bonk_referrals(referred_user_id);
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_bonk_referral_code
            ON bonk_referrals(referral_code);
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_bonk_referrer_id
            ON bonk_referrals(referrer_id);
        `);

        console.log('SUCCESS: Database schema fully active and verified!');
        console.log('SUCCESS: BABYDOGE referral system database ready!');
    } catch (err) {
        console.error('Database initialization error:', err.message);
    }
};
initDb();

// =====================================================
// ROOT
// =====================================================
app.get('/', (req, res) => {
    res.json({ status: 'Active', app: 'BONK Tap Backend', legacy: 'BONK/BABYDOGE API compatibility enabled', vbMiner: true });
});

// =====================================================
// 1. ADS & ENERGY RECHARGE HANDLERS
// =====================================================
const rechargeHandler = (req, res) => {
    const { userId, energyAmount } = req.body;
    const addedEnergy = energyAmount || 300;
    console.log(`[ADS REWARD] Refill request received for: ${userId || 'User'} | Added: ${addedEnergy}`);
    res.json({ success: true, message: 'Energy successfully recharged!', energyAdded: addedEnergy });
};
app.post('/api/recharge-energy', rechargeHandler);
app.post('/api/bonk/recharge-energy', rechargeHandler);

// =====================================================
// 2. SUBMIT WITHDRAWAL HANDLER
// =====================================================
const withdrawHandler = async (req, res) => {
    // VB Miner withdrawal uses appId + TON address + GRAM amount.
    if (req.body && (req.body.appId || req.body.tonAddress || req.body.amountGram !== undefined)) {
        try {
            await settleVBUser(String(req.body.appId || '').trim());
            const appId = String(req.body.appId || '').trim();
            const tonAddress = String(req.body.tonAddress || '').trim();
            const amountGram = Number(req.body.amountGram || 0);
            if (!appId || !tonAddress || !Number.isFinite(amountGram) || amountGram <= 0) {
                return res.status(400).json({ success:false, error:'App ID, TON address and valid GRAM amount are required.' });
            }
            const userQ = await pool.query('SELECT gram_balance FROM vb_users WHERE app_id=$1', [appId]);
            if (!userQ.rowCount) return res.status(404).json({ success:false, error:'User not found' });
            const balance = Number(userQ.rows[0].gram_balance || 0);
            if (amountGram > balance + 1e-12) return res.status(400).json({ success:false, error:'Insufficient GRAM balance' });
            const id = 'WD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,7).toUpperCase();
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE vb_users SET gram_balance=gram_balance-$1, updated_at=NOW() WHERE app_id=$2', [amountGram, appId]);
                await client.query(`INSERT INTO vb_withdrawals (withdrawal_id,app_id,ton_address,gram_amount,status) VALUES ($1,$2,$3,$4,'pending')`, [id,appId,tonAddress,amountGram]);
                await client.query('COMMIT');
            } catch(e) { try{await client.query('ROLLBACK')}catch(_){} throw e; } finally { client.release(); }
            return res.json({success:true, withdrawalId:id, status:'pending'});
        } catch(e) { console.error('VB withdrawal error',e); return res.status(500).json({success:false,error:'VB withdrawal failed'}); }
    }

    // Legacy BONK/BABYDOGE withdrawal compatibility.
    const { binanceId, amount, userId, wallet, type, tokenType, totalDeduct } = req.body;
    if (!binanceId || !amount || Number(amount) < MIN_WITHDRAWAL) {
        return res.status(400).json({
            success: false,
            message: `Minimum withdrawal is ${MIN_WITHDRAWAL.toLocaleString()} ${TOKEN_NAME}`
        });
    }
    const id = Date.now().toString();
    const finalUserId = userId || req.body.user_id || 'N/A';
    const finalWallet = wallet || req.body.wallet || binanceId;
    const finalType = type || req.body.type || 'Binance';
    const finalTokenType = tokenType || req.body.token_type || TOKEN_NAME;
    const finalDeduct = totalDeduct || req.body.total_deduct || amount;
    try {
        const query = `INSERT INTO withdrawals (id,user_id,binance_id,wallet,amount,type,token_type,total_deduct,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *;`;
        await pool.query(query,[id,finalUserId,binanceId,finalWallet,amount,finalType,finalTokenType,finalDeduct,'Pending']);
        res.json({success:true,message:'Request received'});
    } catch(err) { console.error('Database Save Error:',err.message); res.status(500).json({success:false,message:'Database Error',error:err.message}); }
};

app.post('/api/withdraw', withdrawHandler);
app.post('/api/bonk/withdraw', withdrawHandler);

// =====================================================
// 3. GET BONK/BABYDOGE WITHDRAWALS
// =====================================================
app.get('/api/bonk/withdrawals', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, user_id AS "userId", binance_id AS "binanceId", wallet,
                   amount, type, token_type AS "tokenType", status,
                   created_at AS "createdAt"
            FROM withdrawals
            WHERE UPPER(token_type) = 'BABYDOGE'
               OR UPPER(token_type) = 'BONK'
               OR token_type IS NULL
            ORDER BY created_at DESC;
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Database Fetch Error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error', error: err.message });
    }
});

// =====================================================
// 4. GET ALL WITHDRAWALS
// =====================================================
app.get('/api/withdrawals', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, user_id AS "userId", binance_id AS "binanceId", wallet,
                   amount, type, token_type AS "tokenType", status,
                   created_at AS "createdAt"
            FROM withdrawals
            ORDER BY created_at DESC;
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Database Fetch Error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error', error: err.message });
    }
});

// =====================================================
// 5. UPDATE WITHDRAWAL STATUS HANDLER
// =====================================================
const updateStatusHandler = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ success: false, message: 'Status is required' });

    try {
        const result = await pool.query(
            `UPDATE withdrawals SET status = $1 WHERE id = $2 RETURNING *;`,
            [status, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Request not found' });
        }
        res.json({ success: true, message: `Status updated to ${status}` });
    } catch (err) {
        console.error('Database Update Error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error', error: err.message });
    }
};
app.put('/api/withdrawals/:id', updateStatusHandler);
app.put('/api/bonk/withdrawals/:id', updateStatusHandler);

// =====================================================
// 6. BABYDOGE REFERRAL SYSTEM
// =====================================================
const initReferralDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bonk_referrals (
                id BIGSERIAL PRIMARY KEY,
                referrer_id VARCHAR(255) NOT NULL,
                referred_user_id VARCHAR(255) NOT NULL UNIQUE,
                referral_code VARCHAR(255) NOT NULL,
                reward NUMERIC NOT NULL DEFAULT ${REFERRAL_REWARD},
                status VARCHAR(50) NOT NULL DEFAULT 'Completed',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`ALTER TABLE bonk_referrals ALTER COLUMN reward SET DEFAULT ${REFERRAL_REWARD};`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS unique_bonk_referral_user ON bonk_referrals(referred_user_id);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_bonk_referral_code ON bonk_referrals(referral_code);`);
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_bonk_referrer_id ON bonk_referrals(referrer_id);`);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bonk_referral_rewards (
                user_id VARCHAR(255) PRIMARY KEY,
                pending_reward NUMERIC NOT NULL DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('SUCCESS: BABYDOGE referral database ready!');
    } catch (err) {
        console.error('Referral database initialization error:', err.message);
    }
};
initReferralDb();

app.post('/api/bonk/referral', async (req, res) => {
    const { userId, referralCode } = req.body;
    if (!userId) return res.status(400).json({ success: false, rewardAdded: false, message: 'User ID is required' });
    if (!referralCode) return res.status(400).json({ success: false, rewardAdded: false, message: 'Referral code is required' });

    const cleanUserId = String(userId).trim();
    const cleanReferralCode = String(referralCode).trim();
    if (!/^U[0-9]+$/i.test(cleanReferralCode)) {
        return res.status(400).json({ success: false, rewardAdded: false, message: 'Invalid referral code' });
    }

    const referrerId = cleanReferralCode.substring(1);
    if (referrerId === cleanUserId) {
        return res.json({ success: false, rewardAdded: false, message: 'Self referral is not allowed' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const existing = await client.query(
            `SELECT id FROM bonk_referrals WHERE referred_user_id = $1 LIMIT 1`,
            [cleanUserId]
        );
        if (existing.rowCount > 0) {
            await client.query('ROLLBACK');
            return res.json({ success: true, rewardAdded: false, message: 'Referral already processed' });
        }

        await client.query(`
            INSERT INTO bonk_referrals
            (referrer_id, referred_user_id, referral_code, reward, status)
            VALUES ($1, $2, $3, $4, 'Completed')
        `, [referrerId, cleanUserId, cleanReferralCode, REFERRAL_REWARD]);

        await client.query(`
            INSERT INTO bonk_referral_rewards (user_id, pending_reward)
            VALUES ($1, $2)
            ON CONFLICT (user_id)
            DO UPDATE SET
                pending_reward = bonk_referral_rewards.pending_reward + EXCLUDED.pending_reward,
                updated_at = CURRENT_TIMESTAMP
        `, [referrerId, REFERRAL_REWARD]);

        await client.query('COMMIT');
        console.log(`[REFERRAL SUCCESS] Referrer: ${referrerId} | New User: ${cleanUserId} | Reward: ${REFERRAL_REWARD} ${TOKEN_NAME}`);
        return res.json({
            success: true,
            rewardAdded: true,
            reward: REFERRAL_REWARD,
            message: `Referral completed. ${REFERRAL_REWARD.toLocaleString()} ${TOKEN_NAME} added to referrer.`
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        if (err.code === '23505') {
            return res.json({ success: true, rewardAdded: false, message: 'Referral already processed' });
        }
        console.error('Referral Processing Error:', err.message);
        return res.status(500).json({ success: false, rewardAdded: false, message: 'Referral Database Error', error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/bonk/referral/claim', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, reward: 0, message: 'User ID is required' });
    const cleanUserId = String(userId).trim();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT pending_reward FROM bonk_referral_rewards WHERE user_id = $1 FOR UPDATE`,
            [cleanUserId]
        );
        if (result.rowCount === 0) {
            await client.query('COMMIT');
            return res.json({ success: true, reward: 0 });
        }
        const reward = Number(result.rows[0].pending_reward || 0);
        if (reward <= 0) {
            await client.query('COMMIT');
            return res.json({ success: true, reward: 0 });
        }
        await client.query(
            `UPDATE bonk_referral_rewards SET pending_reward = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`,
            [cleanUserId]
        );
        await client.query('COMMIT');
        console.log(`[REFERRAL CLAIM] User: ${cleanUserId} | Reward: ${reward} ${TOKEN_NAME}`);
        return res.json({ success: true, reward, message: 'Referral reward claimed' });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('Referral Claim Error:', err.message);
        return res.status(500).json({ success: false, reward: 0, message: 'Referral claim failed' });
    } finally {
        client.release();
    }
});

const referralStatsHandler = async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });
    try {
        const result = await pool.query(`
            SELECT COUNT(*)::INTEGER AS "referralCount",
                   COALESCE(SUM(reward), 0)::NUMERIC AS "referralEarned"
            FROM bonk_referrals
            WHERE referrer_id = $1 AND status = 'Completed'
        `, [userId]);
        const stats = result.rows[0] || {};
        res.json({
            success: true,
            referralCount: Number(stats.referralCount || 0),
            referralEarned: Number(stats.referralEarned || 0)
        });
    } catch (err) {
        console.error('Referral Stats Error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error', error: err.message });
    }
};
app.get('/api/bonk/referral/stats/:userId', referralStatsHandler);

const referralListHandler = async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required' });
    try {
        const result = await pool.query(`
            SELECT referred_user_id AS "userId", reward, status, created_at AS "createdAt"
            FROM bonk_referrals
            WHERE referrer_id = $1
            ORDER BY created_at DESC
        `, [userId]);
        res.json({ success: true, referrals: result.rows });
    } catch (err) {
        console.error('Referral List Error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error', error: err.message });
    }
};
app.get('/api/bonk/referral/list/:userId', referralListHandler);

// =====================================================
// 7. WEEKLY CONTEST
// =====================================================
const CONTEST_ADMIN_PASSWORD = process.env.CONTEST_ADMIN_PASSWORD;
const contestTableSql = `
CREATE TABLE IF NOT EXISTS bonk_weekly_contest (
    user_id VARCHAR(255) PRIMARY KEY,
    binance_id VARCHAR(255) NOT NULL,
    total_ads INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;
(async () => {
    try { await pool.query(contestTableSql); console.log('SUCCESS: Weekly contest database ready!'); }
    catch (err) { console.error('Contest database initialization error:', err.message); }
})();

app.get('/api/bonk/contest/stats/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT binance_id AS "binanceId", total_ads AS "totalAds" FROM bonk_weekly_contest WHERE user_id = $1',
            [String(req.params.userId).trim()]
        );
        const row = result.rows[0] || {};
        res.json({ success: true, binanceId: row.binanceId || null, totalAds: Number(row.totalAds || 0) });
    } catch (err) { res.status(500).json({ success: false, message: 'Database Error' }); }
});

app.post('/api/bonk/contest/ad', async (req, res) => {
    const userId = String(req.body.userId || '').trim();
    const binanceId = String(req.body.binanceId || '').trim();
    if (!userId || !/^[0-9]{5,20}$/.test(binanceId)) {
        return res.status(400).json({ success: false, message: 'Valid user ID and Binance UID are required.' });
    }
    try {
        const result = await pool.query(`
            INSERT INTO bonk_weekly_contest (user_id, binance_id, total_ads)
            VALUES ($1, $2, 1)
            ON CONFLICT (user_id)
            DO UPDATE SET binance_id = EXCLUDED.binance_id,
                          total_ads = bonk_weekly_contest.total_ads + 1,
                          updated_at = CURRENT_TIMESTAMP
            RETURNING binance_id AS "binanceId", total_ads AS "totalAds";
        `, [userId, binanceId]);
        res.json({ success: true, ...result.rows[0] });
    } catch (err) { res.status(500).json({ success: false, message: 'Database Error' }); }
});

app.get('/api/bonk/contest/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT binance_id AS "binanceId", total_ads AS "totalAds",
                   RANK() OVER (ORDER BY total_ads DESC, updated_at ASC) AS rank
            FROM bonk_weekly_contest
            ORDER BY total_ads DESC, updated_at ASC;
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ success: false, message: 'Database Error' }); }
});

app.post('/api/bonk/contest/reset', async (req, res) => {
    if (!CONTEST_ADMIN_PASSWORD) return res.status(503).json({ success: false, message: 'Admin password is not configured on the server.' });
    if (String(req.body.password || '') !== CONTEST_ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin password.' });
    try {
        await pool.query('UPDATE bonk_weekly_contest SET total_ads = 0, updated_at = CURRENT_TIMESTAMP');
        res.json({ success: true, message: 'Leaderboard reset successfully.' });
    } catch (err) { res.status(500).json({ success: false, message: 'Database Error' }); }
});

// =====================================================
// 8. NFT MEMBERSHIP
// =====================================================
const NFT_ADMIN_PASSWORD = process.env.CONTEST_ADMIN_PASSWORD;
const nftTableSql = `
CREATE TABLE IF NOT EXISTS bonk_nfts (
    user_id VARCHAR(255) PRIMARY KEY,
    nft_id VARCHAR(32) UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Inactive',
    activated_at TIMESTAMP NULL,
    expires_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;
(async () => {
    try { await pool.query(nftTableSql); console.log('SUCCESS: NFT database ready!'); }
    catch (err) { console.error('NFT database initialization error:', err.message); }
})();

function createNftId() {
    return `NFT-${Math.floor(10000 + Math.random() * 90000)}`;
}

app.get('/api/bonk/nft/status/:userId', async (req, res) => {
    const userId = String(req.params.userId || '').trim();
    if (!userId) return res.status(400).json({ success: false, message: 'User ID is required.' });
    try {
        let result = await pool.query(
            'SELECT nft_id AS "nftId", status, expires_at AS "expiresAt" FROM bonk_nfts WHERE user_id = $1',
            [userId]
        );
        if (result.rowCount === 0) {
            let nftId;
            for (let attempt = 0; attempt < 5; attempt++) {
                nftId = createNftId();
                try {
                    await pool.query('INSERT INTO bonk_nfts (user_id, nft_id) VALUES ($1, $2)', [userId, nftId]);
                    break;
                } catch (err) {
                    if (err.code !== '23505' || attempt === 4) throw err;
                }
            }
            result = await pool.query(
                'SELECT nft_id AS "nftId", status, expires_at AS "expiresAt" FROM bonk_nfts WHERE user_id = $1',
                [userId]
            );
        }
        const row = result.rows[0];
        const expired = row.status === 'Active' && row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now();
        if (expired) {
            await pool.query("UPDATE bonk_nfts SET status = 'Inactive', activated_at = NULL, expires_at = NULL WHERE user_id = $1", [userId]);
            return res.json({ success: true, nftId: row.nftId, status: 'Inactive', active: false, expiresAt: null });
        }
        res.json({ success: true, nftId: row.nftId, status: row.status, active: row.status === 'Active', expiresAt: row.expiresAt || null });
    } catch (err) {
        console.error('NFT status error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

app.post('/api/bonk/nft/activate', async (req, res) => {
    const nftId = String(req.body.nftId || '').trim().toUpperCase();
    const password = String(req.body.password || '');
    if (!NFT_ADMIN_PASSWORD) return res.status(503).json({ success: false, message: 'Admin password is not configured on the server.' });
    if (password !== NFT_ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Invalid admin password.' });
    if (!/^NFT-[A-Z0-9]{5,20}$/.test(nftId)) return res.status(400).json({ success: false, message: 'Invalid NFT ID.' });
    try {
        const result = await pool.query(`
            UPDATE bonk_nfts
            SET status = 'Active', activated_at = CURRENT_TIMESTAMP,
                expires_at = CURRENT_TIMESTAMP + INTERVAL '1 month'
            WHERE nft_id = $1
            RETURNING nft_id AS "nftId", status, expires_at AS "expiresAt";
        `, [nftId]);
        if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'NFT ID not found.' });
        res.json({ success: true, ...result.rows[0], message: 'NFT activated for 1 month.' });
    } catch (err) {
        console.error('NFT activation error:', err.message);
        res.status(500).json({ success: false, message: 'Database Error' });
    }
});

// =====================================================
// 9. NFT ADMIN PANEL
// =====================================================
app.get('/admin', (req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BABYDOGE NFT Admin Panel</title>
<style>
body{font-family:Arial,sans-serif;background:#111;color:#fff;max-width:520px;margin:40px auto;padding:20px}
.card{background:#1d1d1d;padding:24px;border-radius:16px;box-shadow:0 0 20px #000}
h1{color:#ffcc00;font-size:25px}label{display:block;margin-top:16px;margin-bottom:6px}
input,button{width:100%;box-sizing:border-box;padding:13px;border-radius:9px;border:1px solid #555;font-size:16px}
input{background:#292929;color:#fff}button{margin-top:20px;background:#ffcc00;color:#111;border:0;font-weight:bold;cursor:pointer}
#result{margin-top:18px;white-space:pre-wrap;line-height:1.5}
</style>
</head>
<body>
<div class="card">
<h1>🟡 BABYDOGE NFT Admin Panel</h1>
<p>Activate a user's NFT for 1 month.</p>
<form id="activateForm">
<label for="nftId">NFT ID</label>
<input id="nftId" name="nftId" placeholder="NFT-99599" required>
<label for="password">Admin Password</label>
<input id="password" name="password" type="password" placeholder="Enter admin password" required>
<button type="submit">Activate NFT</button>
</form>
<div id="result"></div>
</div>
<script>
document.getElementById('activateForm').addEventListener('submit', async function(event){
    event.preventDefault();
    const resultBox = document.getElementById('result');
    resultBox.textContent = 'Processing...';
    const nftId = document.getElementById('nftId').value.trim();
    const password = document.getElementById('password').value;
    try {
        const response = await fetch('/api/bonk/nft/activate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
            body: JSON.stringify({nftId, password})
        });
        const data = await response.json();
        resultBox.textContent = data.success
            ? 'Success: ' + data.message + '\nNFT: ' + data.nftId + '\nExpires: ' + (data.expiresAt || 'N/A')
            : 'Error: ' + (data.message || 'Request failed');
    } catch (error) {
        resultBox.textContent = 'Network error: ' + error.message;
    }
});
</script>
</body>
</html>`);
});


// =====================================================
// VB MINER COMPATIBILITY API
// Keeps the existing BONK/BABYDOGE backend intact while adding VB Miner routes.
// =====================================================
const VB_RATE = 1296000;
const VB_MIN_SWAP = 1296000;
const VB_MINER_SECONDS = 30 * 24 * 60 * 60;
const VB_REWARD_PER_SECOND = 1;
const VB_DEPOSIT_ADDRESS = 'UQAtwnP7Qt-DsZ9iFMY9ruuGdPDUUIPxP9zJ6qsekS2oljWz';
const VB_ADMIN_KEY = process.env.ADMIN_KEY || process.env.CONTEST_ADMIN_PASSWORD || '';

function vbAppId(){
    return 'VB-' + Math.random().toString(36).slice(2,12).toUpperCase() + Math.floor(100+Math.random()*900);
}
function vbRequestId(prefix='REQ'){ return prefix+'-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,7).toUpperCase(); }
async function ensureVBSchema(){
    await pool.query(`CREATE TABLE IF NOT EXISTS vb_users (
      app_id VARCHAR(64) PRIMARY KEY,
      vb_balance NUMERIC(30,9) NOT NULL DEFAULT 0,
      gram_balance NUMERIC(30,12) NOT NULL DEFAULT 0,
      miner_active BOOLEAN NOT NULL DEFAULT FALSE,
      miner_started_at TIMESTAMPTZ NULL,
      miner_expires_at TIMESTAMPTZ NULL,
      credited_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS vb_purchases (
      request_id VARCHAR(100) PRIMARY KEY,
      app_id VARCHAR(64) NOT NULL REFERENCES vb_users(app_id) ON DELETE CASCADE,
      proof_data TEXT,
      proof_type VARCHAR(120),
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS vb_withdrawals (
      withdrawal_id VARCHAR(100) PRIMARY KEY,
      app_id VARCHAR(64) NOT NULL REFERENCES vb_users(app_id) ON DELETE CASCADE,
      ton_address TEXT NOT NULL,
      gram_amount NUMERIC(30,12) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ NULL
    )`);
}
ensureVBSchema().then(()=>console.log('SUCCESS: VB Miner schema ready')).catch(e=>console.error('VB schema error:',e.message));

async function settleVBUser(appId){
    if(!appId) return null;
    const q=await pool.query('SELECT * FROM vb_users WHERE app_id=$1',[appId]);
    if(!q.rowCount) return null;
    const u=q.rows[0];
    if(!u.miner_active || !u.miner_started_at) return u;
    const start=new Date(u.miner_started_at).getTime();
    const now=Date.now();
    const elapsed=Math.max(0,Math.min(VB_MINER_SECONDS,Math.floor((now-start)/1000)));
    const credited=Number(u.credited_seconds||0);
    if(elapsed>credited){
      const add=elapsed-credited;
      const ended=elapsed>=VB_MINER_SECONDS;
      const nq=await pool.query(`UPDATE vb_users SET vb_balance=vb_balance+$1, credited_seconds=$2, miner_active=$3, updated_at=NOW() WHERE app_id=$4 RETURNING *`,[add,elapsed,!ended,appId]);
      return nq.rows[0];
    }
    return u;
}
function serializeVB(u){
    if(!u) return null;
    const elapsed=u.miner_started_at ? Math.max(0,Math.min(VB_MINER_SECONDS,Math.floor((Date.now()-new Date(u.miner_started_at).getTime())/1000))) : 0;
    return {appId:u.app_id,vbBalance:Number(u.vb_balance||0),gramBalance:Number(u.gram_balance||0),totalBalanceGram:Number(u.gram_balance||0)+Number(u.vb_balance||0)/VB_RATE,activeMiner:!!u.miner_active,activeMiners:u.miner_active?1:0,minerRewardPerSecond:VB_REWARD_PER_SECOND,remainingSeconds:Math.max(0,VB_MINER_SECONDS-elapsed),creditedSeconds:Number(u.credited_seconds||0),createdAt:u.created_at};
}
function adminVB(req,res,next){
    if(!VB_ADMIN_KEY) return res.status(503).json({success:false,error:'ADMIN_KEY is not configured on the server.'});
    const key=String(req.headers['x-admin-key']||req.query.key||'');
    if(key!==VB_ADMIN_KEY) return res.status(401).json({success:false,error:'Invalid admin key'});
    next();
}

app.get('/api/health',(req,res)=>res.json({ok:true,app:'VB Miner Backend',version:'2.0',legacy:'BONK/BABYDOGE routes retained'}));
app.get('/api/config',(req,res)=>res.json({RATE_VB_PER_GRAM:VB_RATE,MIN_SWAP_VB:VB_MIN_SWAP,DEPOSIT_ADDRESS:VB_DEPOSIT_ADDRESS,MINER_REWARD_PER_SECOND:VB_REWARD_PER_SECOND,MINER_DURATION_SECONDS:VB_MINER_SECONDS,MINER_DURATION_DAYS:30}));
app.post('/api/user/create',async(req,res)=>{try{await ensureVBSchema();let requested=String(req.body?.appId||'').trim();let id=requested||vbAppId();let q=await pool.query('SELECT * FROM vb_users WHERE app_id=$1',[id]);if(!q.rowCount){q=await pool.query('INSERT INTO vb_users(app_id) VALUES($1) RETURNING *',[id])}res.json({success:true,user:serializeVB(q.rows[0])});}catch(e){console.error('VB user create',e);res.status(500).json({success:false,error:'Could not create user'});}});
app.get('/api/user/:appId',async(req,res)=>{try{const u=await settleVBUser(req.params.appId);if(!u)return res.status(404).json({success:false,error:'User not found'});res.json({success:true,user:serializeVB(u)});}catch(e){res.status(500).json({success:false,error:'Could not load user'});}});

app.post('/api/purchase',async(req,res)=>{
    try{
      const {appId,proofData,proofType}=req.body||{};
      if(!appId||!proofData) return res.status(400).json({success:false,error:'App ID and payment proof are required'});
      const u=await settleVBUser(String(appId)); if(!u)return res.status(404).json({success:false,error:'User not found'});
      if(String(proofData).length>12*1024*1024)return res.status(413).json({success:false,error:'Proof image is too large'});
      const requestId=vbRequestId('PUR');
      await pool.query(`INSERT INTO vb_purchases(request_id,app_id,proof_data,proof_type,status) VALUES($1,$2,$3,$4,'pending')`,[requestId,appId,String(proofData),String(proofType||'image')]);
      res.json({success:true,requestId,status:'pending',appId});
    }catch(e){console.error('VB purchase',e);res.status(500).json({success:false,error:'Could not submit purchase request'});}
});
app.get('/api/purchases/:appId',async(req,res)=>{try{const q=await pool.query(`SELECT request_id AS "requestId",app_id AS "appId",status,note,created_at AS "createdAt",reviewed_at AS "reviewedAt" FROM vb_purchases WHERE app_id=$1 ORDER BY created_at DESC`,[req.params.appId]);res.json({success:true,purchases:q.rows});}catch(e){res.status(500).json({success:false,error:'Could not load purchases'});}});

app.post('/api/convert',async(req,res)=>{try{const appId=String(req.body?.appId||'').trim();const vbAmount=Number(req.body?.vbAmount||0);const u=await settleVBUser(appId);if(!u)return res.status(404).json({success:false,error:'User not found'});if(!Number.isInteger(vbAmount)||vbAmount<VB_MIN_SWAP||vbAmount>Number(u.vb_balance))return res.status(400).json({success:false,error:'Invalid VB amount'});const gram=vbAmount/VB_RATE;const q=await pool.query('UPDATE vb_users SET vb_balance=vb_balance-$1, gram_balance=gram_balance+$2, updated_at=NOW() WHERE app_id=$3 RETURNING *',[vbAmount,gram,appId]);res.json({success:true,convertedVB:vbAmount,convertedGram:gram,user:serializeVB(q.rows[0])});}catch(e){res.status(500).json({success:false,error:'Conversion failed'});}});

app.get('/api/withdrawals/:appId',async(req,res)=>{try{const q=await pool.query(`SELECT withdrawal_id AS "withdrawalId",app_id AS "appId",ton_address AS "tonAddress",gram_amount AS "gramAmount",status,note,created_at AS "createdAt",reviewed_at AS "reviewedAt" FROM vb_withdrawals WHERE app_id=$1 ORDER BY created_at DESC`,[req.params.appId]);res.json({success:true,withdrawals:q.rows.map(x=>({...x,gramAmount:Number(x.gramAmount)}))});}catch(e){res.status(500).json({success:false,error:'Could not load withdrawals'});}});

app.get('/api/admin/purchases',adminVB,async(req,res)=>{try{const q=await pool.query(`SELECT request_id AS "requestId",app_id AS "appId",status,note,created_at AS "createdAt",reviewed_at AS "reviewedAt" FROM vb_purchases ORDER BY created_at DESC`);res.json({success:true,purchases:q.rows});}catch(e){res.status(500).json({success:false,error:'Could not load purchase requests'});}});
app.get('/api/admin/purchases/:id/photo',adminVB,async(req,res)=>{try{const q=await pool.query('SELECT proof_data,proof_type FROM vb_purchases WHERE request_id=$1',[req.params.id]);if(!q.rowCount)return res.status(404).end();const data=String(q.rows[0].proof_data||'');const m=data.match(/^data:([^;]+);base64,(.*)$/s);if(!m)return res.status(404).end();res.setHeader('Content-Type',q.rows[0].proof_type||m[1]);res.setHeader('Cache-Control','no-store');res.send(Buffer.from(m[2],'base64'));}catch(e){res.status(500).end();}});
app.post('/api/admin/purchases/:id/activate',adminVB,async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const p=await client.query('SELECT * FROM vb_purchases WHERE request_id=$1 FOR UPDATE',[req.params.id]);if(!p.rowCount)return res.status(404).json({success:false,error:'Purchase not found'});if(p.rows[0].status!=='pending')return res.status(400).json({success:false,error:'Purchase is already '+p.rows[0].status});const appId=p.rows[0].app_id;await client.query(`UPDATE vb_users SET miner_active=true,miner_started_at=NOW(),miner_expires_at=NOW()+INTERVAL '30 days',credited_seconds=0,updated_at=NOW() WHERE app_id=$1`,[appId]);await client.query(`UPDATE vb_purchases SET status='approved',reviewed_at=NOW() WHERE request_id=$1`,[req.params.id]);await client.query('COMMIT');res.json({success:true,message:'Miner activated',appId});}catch(e){try{await client.query('ROLLBACK')}catch(_){}res.status(500).json({success:false,error:'Could not activate miner'});}finally{client.release();}});
app.post('/api/admin/purchases/:id/reject',adminVB,async(req,res)=>{try{const q=await pool.query(`UPDATE vb_purchases SET status='rejected',note=$2,reviewed_at=NOW() WHERE request_id=$1 AND status='pending' RETURNING request_id`,[req.params.id,String(req.body?.note||'Rejected')]);if(!q.rowCount)return res.status(404).json({success:false,error:'Pending purchase not found'});res.json({success:true});}catch(e){res.status(500).json({success:false,error:'Could not reject purchase'});}});
app.get('/api/admin/withdrawals',adminVB,async(req,res)=>{try{const q=await pool.query(`SELECT withdrawal_id AS "withdrawalId",app_id AS "appId",ton_address AS "tonAddress",gram_amount AS "gramAmount",status,note,created_at AS "createdAt" FROM vb_withdrawals ORDER BY created_at DESC`);res.json({success:true,withdrawals:q.rows.map(x=>({...x,gramAmount:Number(x.gramAmount)}))});}catch(e){res.status(500).json({success:false,error:'Could not load VB withdrawals'});}});
app.post('/api/admin/withdrawals/:id/approve',adminVB,async(req,res)=>{try{const q=await pool.query(`UPDATE vb_withdrawals SET status='approved',reviewed_at=NOW() WHERE withdrawal_id=$1 AND status='pending' RETURNING withdrawal_id`,[req.params.id]);if(!q.rowCount)return res.status(404).json({success:false,error:'Pending withdrawal not found'});res.json({success:true});}catch(e){res.status(500).json({success:false,error:'Could not approve withdrawal'});}});
app.post('/api/admin/withdrawals/:id/reject',adminVB,async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query(`SELECT * FROM vb_withdrawals WHERE withdrawal_id=$1 AND status='pending' FOR UPDATE`,[req.params.id]);if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,error:'Pending withdrawal not found'});}const w=q.rows[0];await client.query(`UPDATE vb_users SET gram_balance=gram_balance+$1,updated_at=NOW() WHERE app_id=$2`,[w.gram_amount,w.app_id]);await client.query(`UPDATE vb_withdrawals SET status='rejected',note=$2,reviewed_at=NOW() WHERE withdrawal_id=$1`,[req.params.id,String(req.body?.note||'Rejected by admin; GRAM refunded')]);await client.query('COMMIT');res.json({success:true});}catch(e){try{await client.query('ROLLBACK')}catch(_){}res.status(500).json({success:false,error:'Could not reject withdrawal'});}finally{client.release();}});
app.get('/api/admin/users',adminVB,async(req,res)=>{try{const q=await pool.query('SELECT * FROM vb_users ORDER BY created_at DESC');const users=[];for(const row of q.rows){const u=await settleVBUser(row.app_id);users.push({...serializeVB(u),minerStartedAt:u.miner_started_at,minerExpiresAt:u.miner_expires_at,minerActive:!!u.miner_active});}res.json({success:true,users});}catch(e){res.status(500).json({success:false,error:'Could not load users'});}});


// SERVER START
app.listen(PORT, () => {
  console.log(`BONK Tap / VB Miner backend running on port ${PORT}`);
});
