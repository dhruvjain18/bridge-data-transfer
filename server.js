require('dotenv').config();
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const { DisconnectReason, initAuthCreds, BufferJSON, proto } = baileys;
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
app.set('trust proxy', 1);

// ==============================
// ERROR MONITORING & LOGGING
// ==============================
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function getLogFileName() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
}

function log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    const line = `[${timestamp}] [${level}] ${message}${metaStr}\n`;
    if (level === 'ERROR' || level === 'FATAL') console.error(line.trim());
    else console.log(line.trim());
    try { fs.appendFileSync(path.join(LOG_DIR, getLogFileName()), line); } catch (e) {}
}

process.on('uncaughtException', (err) => {
    log('FATAL', `Uncaught exception: ${err.message}`, { stack: err.stack });
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    log('ERROR', `Unhandled rejection: ${reason}`);
});

// ==============================
// RATE LIMITING
// ==============================
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a minute.' },
    handler: (req, res, next, options) => { log('WARN', 'Rate limit exceeded', { ip: req.ip, path: req.path }); res.status(429).json(options.message); }
});
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Upload limit reached. Max 10 per minute.' },
    handler: (req, res, next, options) => { log('WARN', 'Upload rate limit exceeded', { ip: req.ip }); res.status(429).json(options.message); }
});
const verifyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many verification attempts. Try again in 15 minutes.' },
    handler: (req, res, next, options) => { log('WARN', 'Verify brute-force blocked', { ip: req.ip }); res.status(429).json(options.message); }
});

app.use('/api/', (req, res, next) => {
    // Exclude high-frequency polling endpoints from rate limiting
    const exempt = ['/whatsapp/status', '/whatsapp/config', '/admin/dashboard',
                    '/admin/whitelist', '/admin/telegram-users', '/admin/scheduled', '/admin/logs'];
    if (exempt.some(p => req.path.startsWith(p))) return next();
    apiLimiter(req, res, next);
});

// ==============================
// SECURITY MIDDLEWARE
// ==============================
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self';");
    next();
});

app.use('/api/', (req, res, next) => {
    const origin = req.headers.origin || req.headers.referer || '';
    const host = req.headers.host || '';
    if (!origin || origin.includes(host)) return next();
    log('WARN', 'Cross-origin request blocked', { origin, ip: req.ip });
    return res.status(403).json({ error: 'Cross-origin requests not allowed.' });
});

const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const blocked = /\.(exe|bat|cmd|sh|ps1|vbs|js|msi|scr|com|pif|hta|cpl|inf|reg)$/i;
        if (blocked.test(file.originalname)) {
            log('WARN', `Blocked dangerous file: ${file.originalname}`, { ip: req.ip });
            return cb(new Error(`File type not allowed: ${file.originalname}`));
        }
        cb(null, true);
    }
});
app.use(express.static('public'));
app.use(express.json({ limit: '1mb' }));

const MAX_MESSAGE_LENGTH = 2000;
const MAX_RECIPIENTS = 5;
function sanitizeInput(str) { return str ? String(str).replace(/[<>]/g, '').trim() : ''; }

// ==============================
// MONGODB
// ==============================
let db;

async function connectDB() {
    const uri = process.env.MONGODB_URI;
    if (!uri || uri.includes('YOUR_USER')) {
        log('WARN', 'MONGODB_URI not configured — using file-based fallback');
        return;
    }
    try {
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
        await client.connect();
        db = client.db();
        log('INFO', 'Connected to MongoDB Atlas');
        await db.collection('wa_auth').createIndex({ sessionId: 1 });
        await db.collection('telegram_users').createIndex({ username: 1 }, { unique: true });
    } catch (e) {
        log('ERROR', `MongoDB connection failed: ${e.message}`);
    }
}

// ==============================
// WHATSAPP WHITELIST (MongoDB-backed with file fallback)
// ==============================
let waAllowedNumbers = [];
const WA_ALLOWED_FILE = path.join(__dirname, 'whatsapp-allowed.json');

async function loadWhitelist() {
    if (db) {
        try {
            const doc = await db.collection('settings').findOne({ _id: 'wa_whitelist' });
            if (doc && doc.numbers && doc.numbers.length > 0) {
                waAllowedNumbers = doc.numbers.map(n => String(n).replace(/[^\d]/g, '')).filter(Boolean);
                log('INFO', `WhatsApp whitelist from DB: ${waAllowedNumbers.length} number(s)`);
                return;
            }
        } catch (e) { log('ERROR', `DB whitelist load failed: ${e.message}`); }
    }
    // File fallback
    try {
        if (fs.existsSync(WA_ALLOWED_FILE)) {
            waAllowedNumbers = JSON.parse(fs.readFileSync(WA_ALLOWED_FILE, 'utf-8'))
                .map(n => String(n).replace(/[^\d]/g, '')).filter(Boolean);
            log('INFO', `WhatsApp whitelist from file: ${waAllowedNumbers.length} number(s)`);
            if (db) await saveWhitelistToDB(); // Migrate to DB
        } else {
            log('WARN', 'No WhatsApp whitelist found — WhatsApp LOCKED');
        }
    } catch (e) { log('ERROR', `File whitelist load failed: ${e.message}`); }
}

async function saveWhitelistToDB() {
    if (!db) {
        fs.writeFileSync(WA_ALLOWED_FILE, JSON.stringify(waAllowedNumbers, null, 2));
        return;
    }
    await db.collection('settings').updateOne(
        { _id: 'wa_whitelist' }, { $set: { numbers: waAllowedNumbers, updatedAt: new Date() } }, { upsert: true }
    );
}

function isWaAllowed(phone) {
    if (waAllowedNumbers.length === 0) return false;
    const normalized = String(phone).replace(/[^\d]/g, '');
    return waAllowedNumbers.includes(normalized);
}

// ==============================
// TELEGRAM USER MAP (MongoDB-backed with file fallback)
// ==============================
let userMap = {};
const USER_MAP_FILE = path.join(__dirname, 'user-map.json');

async function loadUserMap() {
    if (db) {
        try {
            const docs = await db.collection('telegram_users').find({}).toArray();
            userMap = {};
            for (const doc of docs) userMap[doc.username] = doc.chatId;
            if (Object.keys(userMap).length > 0) {
                log('INFO', `Telegram users from DB: ${Object.keys(userMap).length}`);
                return;
            }
        } catch (e) { log('ERROR', `DB user map load failed: ${e.message}`); }
    }
    // File fallback
    if (fs.existsSync(USER_MAP_FILE)) {
        try {
            userMap = JSON.parse(fs.readFileSync(USER_MAP_FILE, 'utf-8'));
            log('INFO', `Telegram users from file: ${Object.keys(userMap).length}`);
            if (db && Object.keys(userMap).length > 0) {
                for (const [u, c] of Object.entries(userMap)) {
                    await db.collection('telegram_users').updateOne({ username: u }, { $set: { username: u, chatId: c } }, { upsert: true });
                }
                log('INFO', 'Migrated Telegram users to MongoDB');
            }
        } catch (e) { userMap = {}; }
    }
}

async function saveUserMapping(username, chatId) {
    userMap[username] = chatId;
    if (db) {
        await db.collection('telegram_users').updateOne(
            { username }, { $set: { username, chatId, updatedAt: new Date() } }, { upsert: true }
        );
    } else {
        fs.writeFileSync(USER_MAP_FILE, JSON.stringify(userMap, null, 2));
    }
}

// ==============================
// SECURITY: Sessions, Limits
// ==============================
const waDailyUsage = {};
const WA_DAILY_LIMIT = 50;
const waVerifiedSessions = {};
const WA_SESSION_TTL = 2 * 60 * 60 * 1000;

function checkDailyLimit(phone) {
    const n = String(phone).replace(/[^\d]/g, '');
    const today = new Date().toISOString().split('T')[0];
    if (!waDailyUsage[n] || waDailyUsage[n].date !== today) waDailyUsage[n] = { count: 0, date: today };
    return waDailyUsage[n].count < WA_DAILY_LIMIT;
}
function incrementDailyUsage(phone) {
    const n = String(phone).replace(/[^\d]/g, '');
    const today = new Date().toISOString().split('T')[0];
    if (!waDailyUsage[n] || waDailyUsage[n].date !== today) waDailyUsage[n] = { count: 0, date: today };
    waDailyUsage[n].count++;
}
function isSessionVerified(ip) {
    const s = waVerifiedSessions[ip];
    if (!s) return false;
    if (Date.now() > s.expiresAt) { delete waVerifiedSessions[ip]; return false; }
    return true;
}
function getVerifiedPhone(ip) {
    const s = waVerifiedSessions[ip];
    return s ? s.phone : null;
}

const scheduledJobs = [];

// ==============================
// TELEGRAM BOT
// ==============================
const telegramToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
let telegramBot = null;

if (telegramToken && telegramToken !== 'YOUR_BOT_TOKEN_HERE') {
    telegramBot = new TelegramBot(telegramToken, { polling: { params: { timeout: 30 }, interval: 2000 } });
    telegramBot.getMe().then(info => log('INFO', `Telegram Bot connected: @${info.username}`))
        .catch(err => { log('ERROR', `Telegram Bot invalid: ${err.message}`); telegramBot = null; });

    telegramBot.on('polling_error', (err) => {
        if (err?.message?.includes('409 Conflict')) log('WARN', 'Telegram polling conflict (another instance running)');
        else log('ERROR', `Telegram polling error: ${err.message}`);
    });

    telegramBot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from.username;
        const firstName = msg.from.first_name || 'there';
        if (username) {
            await saveUserMapping(username.toLowerCase(), chatId);
            log('INFO', `Registered Telegram user @${username} → ${chatId}`);
        }
        telegramBot.sendMessage(chatId,
            `👋 Hey ${firstName}!\n✅ Registered with Bridge.\nChat ID: \`${chatId}\`${username ? `\nUsername: @${username}` : ''}`,
            { parse_mode: 'Markdown' }
        );
    });
} else {
    log('WARN', 'Telegram Bot Token not configured.');
}

// ==============================
// BAILEYS: MongoDB Auth State
// ==============================
async function useMongoDBAuthState(sessionId) {
    const collection = db.collection('wa_auth');

    const readData = async (id) => {
        const doc = await collection.findOne({ _id: `${sessionId}:${id}` });
        if (!doc) return null;
        return JSON.parse(doc.value, BufferJSON.reviver);
    };

    const writeData = async (id, data) => {
        const serialized = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne(
            { _id: `${sessionId}:${id}` },
            { $set: { value: serialized, sessionId, updatedAt: new Date() } },
            { upsert: true }
        );
    };

    const removeData = async (id) => {
        await collection.deleteOne({ _id: `${sessionId}:${id}` });
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const result = {};
                    await Promise.all(ids.map(async (id) => {
                        let val = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && val) {
                            val = proto.Message.AppStateSyncKeyData.fromObject(val);
                        }
                        if (val) result[id] = val;
                    }));
                    return result;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const [category, entries] of Object.entries(data)) {
                        for (const [id, value] of Object.entries(entries)) {
                            tasks.push(value ? writeData(`${category}-${id}`, value) : removeData(`${category}-${id}`));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    };
}

async function clearSessionFromDB(sessionId) {
    if (!db) return;
    await db.collection('wa_auth').deleteMany({ sessionId });
    log('INFO', `Cleared stored session for ${sessionId}`);
}

// ==============================
// BAILEYS: Per-User Session Manager
// ==============================
const activeSessions = new Map();
const MAX_ACTIVE_SESSIONS = 10;
const SESSION_IDLE_TIMEOUT = 30 * 60 * 1000;
const sessionRetries = new Map();

async function createOrRestoreSession(phoneId) {
    let session = activeSessions.get(phoneId);

    // Already active with a working socket — just return it
    if (session && session.socket) {
        session.lastActivity = Date.now();
        return session;
    }

    // Session exists but socket is gone (reconnecting) — reuse the session object
    if (!session) {
        if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
            let oldestKey = null, oldestTime = Infinity;
            for (const [key, sess] of activeSessions) {
                if (sess.lastActivity < oldestTime) { oldestTime = sess.lastActivity; oldestKey = key; }
            }
            if (oldestKey) {
                log('INFO', `Evicting idle session: ${oldestKey}`);
                try { activeSessions.get(oldestKey).socket?.end(); } catch (e) {}
                activeSessions.delete(oldestKey);
            }
        }
        session = { socket: null, qr: null, ready: false, lastActivity: Date.now(), connecting: true };
        activeSessions.set(phoneId, session);
    }

    if (!db) {
        log('ERROR', 'Cannot create WhatsApp session — MongoDB not connected');
        activeSessions.delete(phoneId);
        return null;
    }

    // Reset state for new connection attempt
    session.connecting = true;
    session.ready = false;
    session.lastActivity = Date.now();

    try {
        const authState = await useMongoDBAuthState(phoneId);

        const sock = makeWASocket({
            auth: authState.state,
            printQRInTerminal: false,
            logger: pino({ level: 'warn' }),
            browser: ['Bridge', 'Desktop', '3.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
        });

        session.socket = sock;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr: qrCode } = update;

            // Log every connection update for debugging
            log('INFO', `WA connection update for ${phoneId}`, {
                connection: connection || 'none',
                hasQR: !!qrCode,
                error: lastDisconnect?.error?.message || null,
                statusCode: lastDisconnect?.error?.output?.statusCode || null
            });
            if (qrCode) {
                try {
                    session.qr = await qrcode.toDataURL(qrCode, { margin: 2, scale: 8 });
                    session.connecting = false;
                    log('INFO', `WhatsApp QR ready for ${phoneId}`);
                } catch (e) { log('ERROR', `QR render error: ${e.message}`); }
            }

            if (connection === 'open') {
                session.ready = true;
                session.connecting = false;
                session.qr = null;
                sessionRetries.delete(phoneId);
                log('INFO', `WhatsApp connected for user ${phoneId}`);
            }

            if (connection === 'close') {
                session.ready = false;
                session.connecting = true;
                session.socket = null; // Clear socket but KEEP session in activeSessions
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                const retries = sessionRetries.get(phoneId) || 0;

                if (shouldReconnect && retries < 5) {
                    sessionRetries.set(phoneId, retries + 1);
                    log('INFO', `WhatsApp reconnecting for ${phoneId} (attempt ${retries + 1}/5)...`);
                    setTimeout(() => createOrRestoreSession(phoneId), 3000);
                } else {
                    // Only remove session from map on final failure
                    sessionRetries.delete(phoneId);
                    activeSessions.delete(phoneId);
                    log('INFO', `WhatsApp session ended for ${phoneId} (${shouldReconnect ? 'max retries' : 'logged out'})`);
                    if (!shouldReconnect) await clearSessionFromDB(phoneId);
                }
            }
        });

        sock.ev.on('creds.update', authState.saveCreds);

    } catch (e) {
        log('ERROR', `Failed to create session for ${phoneId}: ${e.message}`);
        activeSessions.delete(phoneId);
        return null;
    }

    return session;
}

// Idle session cleanup every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of activeSessions) {
        if (now - session.lastActivity > SESSION_IDLE_TIMEOUT) {
            log('INFO', `Disconnecting idle session: ${id}`);
            try { session.socket?.end(); } catch (e) {}
            activeSessions.delete(id);
        }
    }
}, 5 * 60 * 1000);

// ==============================
// HELPERS
// ==============================
function resolveTelegramTarget(target) {
    target = target.trim();
    if (/^\d+$/.test(target)) return target;
    const username = target.startsWith('@') ? target.slice(1).toLowerCase() : target.toLowerCase();
    return userMap[username] || null;
}

function formatWhatsAppNumber(phone) {
    let num = phone.replace(/\D/g, '');
    if (num.length === 10) num = '91' + num;
    return num + '@s.whatsapp.net';
}

async function sendTelegram(chatId, text, files) {
    const results = { textSent: false, filesSent: 0, errors: [] };
    if (text) {
        try { await telegramBot.sendMessage(chatId, text); results.textSent = true; }
        catch (e) { results.errors.push(`Text: ${e.message}`); }
    }
    for (const file of files) {
        try {
            await telegramBot.sendDocument(chatId, path.resolve(file.path), { caption: file.originalname }, {
                filename: file.originalname, contentType: file.mimetype || 'application/octet-stream'
            });
            results.filesSent++;
        } catch (e) { results.errors.push(`${file.originalname}: ${e.message}`); }
    }
    return results;
}

async function sendWhatsApp(sessionId, chatId, text, files) {
    const session = activeSessions.get(sessionId);
    if (!session || !session.ready || !session.socket) {
        return { textSent: false, filesSent: 0, errors: ['WhatsApp not connected. Please scan QR and try again.'] };
    }

    session.lastActivity = Date.now();
    const sock = session.socket;
    const results = { textSent: false, filesSent: 0, errors: [] };

    if (text) {
        try {
            await sock.sendMessage(chatId, { text });
            results.textSent = true;
        } catch (e) { results.errors.push(`Text: ${e.message}`); }
    }

    for (const file of files) {
        try {
            const buffer = fs.readFileSync(path.resolve(file.path));
            const mime = file.mimetype || 'application/octet-stream';

            if (mime.startsWith('image/')) {
                await sock.sendMessage(chatId, { image: buffer, caption: file.originalname, mimetype: mime });
            } else if (mime.startsWith('video/')) {
                await sock.sendMessage(chatId, { video: buffer, caption: file.originalname, mimetype: mime });
            } else if (mime.startsWith('audio/')) {
                await sock.sendMessage(chatId, { audio: buffer, mimetype: mime });
            } else {
                await sock.sendMessage(chatId, { document: buffer, mimetype: mime, fileName: file.originalname });
            }
            results.filesSent++;
        } catch (e) { results.errors.push(`${file.originalname}: ${e.message}`); }
    }
    return results;
}

function cleanupFiles(files) {
    for (const file of files) {
        const p = path.resolve(file.path);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
}

// Cleanup stale uploads on startup
try {
    const uploadsDir = path.join(__dirname, 'uploads');
    if (fs.existsSync(uploadsDir)) {
        const stale = fs.readdirSync(uploadsDir);
        if (stale.length > 0) { stale.forEach(f => fs.unlinkSync(path.join(uploadsDir, f))); log('INFO', `Cleaned ${stale.length} stale upload(s)`); }
    }
} catch (e) {}

// ==============================
// API ROUTES
// ==============================

// WhatsApp verification — creates/restores per-user session
app.post('/api/whatsapp/verify', verifyLimiter, async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.json({ valid: false });

    if (waAllowedNumbers.length === 0) {
        log('WARN', 'WhatsApp denied (no whitelist)', { ip: req.ip });
        return res.json({ valid: false });
    }

    if (!isWaAllowed(phone)) {
        log('WARN', 'WhatsApp denied (not whitelisted)', { ip: req.ip });
        return res.json({ valid: false });
    }

    const normalized = String(phone).replace(/[^\d]/g, '');

    // Create verified session
    waVerifiedSessions[req.ip] = { phone: normalized, expiresAt: Date.now() + WA_SESSION_TTL };
    log('INFO', 'WhatsApp access granted', { phone: normalized.slice(-4).padStart(normalized.length, '*'), ip: req.ip });

    // Create or restore Baileys session for this user
    if (db) {
        const session = await createOrRestoreSession(normalized);
        if (!session) {
            return res.json({ valid: true, waError: 'Could not initialize WhatsApp session. Check server logs.' });
        }
    }

    return res.json({ valid: true });
});

app.get('/api/whatsapp/config', (req, res) => {
    res.json({ restricted: true });
});

// Per-user WhatsApp status
app.get('/api/whatsapp/status', (req, res) => {
    if (!isSessionVerified(req.ip)) {
        return res.json({ ready: false, qr: null, error: 'Not verified' });
    }

    const phoneId = getVerifiedPhone(req.ip);
    if (!phoneId || !db) {
        return res.json({ ready: false, qr: null });
    }

    const session = activeSessions.get(phoneId);
    if (!session) {
        return res.json({ ready: false, qr: null });
    }

    session.lastActivity = Date.now();
    res.json({
        ready: session.ready,
        qr: session.ready ? null : session.qr
    });
});

app.get('/api/users', (req, res) => {
    const users = Object.entries(userMap).map(([u, c]) => ({ username: `@${u}`, chatId: c }));
    res.json(users);
});

app.get('/api/scheduled', (req, res) => {
    res.json(scheduledJobs.map(j => ({ id: j.id, targets: j.targets, fileCount: j.fileCount, scheduledFor: j.scheduledFor })));
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        telegram: !!telegramBot,
        whatsappSessions: activeSessions.size,
        mongodb: !!db,
        registeredUsers: Object.keys(userMap).length,
        scheduledJobs: scheduledJobs.length
    });
});

// ==============================
// ADMIN PANEL API
// ==============================
const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();

function adminAuth(req, res, next) {
    const pw = req.headers['x-admin-password'] || req.body?.adminPassword || '';
    if (!adminPassword) return res.status(503).json({ error: 'Admin password not configured.' });
    if (pw !== adminPassword) { log('WARN', 'Admin auth failed', { ip: req.ip }); return res.status(401).json({ error: 'Invalid admin password.' }); }
    next();
}

app.post('/api/admin/verify', (req, res) => {
    const { password } = req.body || {};
    if (!adminPassword) return res.json({ valid: false });
    if (password === adminPassword) { log('INFO', 'Admin login', { ip: req.ip }); return res.json({ valid: true }); }
    log('WARN', 'Admin login failed', { ip: req.ip });
    return res.json({ valid: false });
});

app.get('/api/admin/dashboard', adminAuth, (req, res) => {
    const uptimeSec = Math.round(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    res.json({
        uptime: `${hours}h ${mins}m`,
        telegram: { connected: !!telegramBot, users: Object.keys(userMap).length },
        whatsapp: { activeSessions: activeSessions.size, allowedNumbers: waAllowedNumbers.length, mongodb: !!db },
        scheduledJobs: scheduledJobs.length,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
});

app.get('/api/admin/whitelist', adminAuth, (req, res) => {
    res.json({ numbers: waAllowedNumbers });
});

app.post('/api/admin/whitelist/add', adminAuth, async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Phone number required.' });
    const normalized = String(phone).replace(/[^\d]/g, '');
    if (normalized.length < 8) return res.status(400).json({ error: 'Invalid phone number.' });
    if (waAllowedNumbers.includes(normalized)) return res.json({ success: true, message: 'Already whitelisted.' });
    waAllowedNumbers.push(normalized);
    await saveWhitelistToDB();
    log('INFO', `Admin added ${normalized} to whitelist`);
    res.json({ success: true, message: `${normalized} added.` });
});

app.post('/api/admin/whitelist/remove', adminAuth, async (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Phone number required.' });
    const normalized = String(phone).replace(/[^\d]/g, '');
    const index = waAllowedNumbers.indexOf(normalized);
    if (index === -1) return res.status(404).json({ error: 'Number not found.' });
    waAllowedNumbers.splice(index, 1);
    await saveWhitelistToDB();
    log('INFO', `Admin removed ${normalized} from whitelist`);
    res.json({ success: true, message: `${normalized} removed.` });
});

app.get('/api/admin/telegram-users', adminAuth, (req, res) => {
    const users = Object.entries(userMap).map(([u, c]) => ({ username: `@${u}`, chatId: c }));
    res.json({ users });
});

app.get('/api/admin/scheduled', adminAuth, (req, res) => {
    res.json({ jobs: scheduledJobs.map(j => ({ id: j.id, targets: j.targets, fileCount: j.fileCount, scheduledFor: j.scheduledFor })) });
});

app.get('/api/admin/logs', adminAuth, (req, res) => {
    try {
        const logFile = path.join(LOG_DIR, getLogFileName());
        if (!fs.existsSync(logFile)) return res.json({ logs: [] });
        const content = fs.readFileSync(logFile, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean).slice(-50).reverse();
        res.json({ logs: lines });
    } catch (e) { res.json({ logs: [] }); }
});

// Clear all WhatsApp sessions from MongoDB (fixes corrupted auth data)
app.post('/api/admin/wa-clear-sessions', adminAuth, async (req, res) => {
    try {
        // Disconnect all active sessions
        for (const [id, session] of activeSessions) {
            try { session.socket?.end(); } catch (e) {}
        }
        activeSessions.clear();
        sessionRetries.clear();

        // Wipe all auth data from MongoDB
        if (db) {
            const result = await db.collection('wa_auth').deleteMany({});
            log('INFO', `Admin cleared all WhatsApp sessions (${result.deletedCount} records)`);
            res.json({ success: true, message: `Cleared ${result.deletedCount} session records. Users can now scan fresh QR codes.` });
        } else {
            res.json({ success: false, message: 'MongoDB not connected.' });
        }
    } catch (e) {
        log('ERROR', `Failed to clear WA sessions: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ==============================
// UPLOAD
// ==============================
app.post('/api/upload', uploadLimiter, upload.array('files', 10), async (req, res) => {
    const channel = req.body.channel || 'telegram';
    const requestIP = req.ip;

    try {
        const files = req.files || [];
        const rawTargets = sanitizeInput(req.body.chatId || '');
        const textMessage = sanitizeInput(req.body.message || '');
        const scheduledTime = req.body.scheduledTime || '';

        const targets = rawTargets.split(',').map(t => t.trim()).filter(Boolean);

        if (targets.length === 0) { cleanupFiles(files); return res.status(400).json({ error: 'At least one recipient is required.' }); }
        if (targets.length > MAX_RECIPIENTS) { cleanupFiles(files); return res.status(400).json({ error: `Maximum ${MAX_RECIPIENTS} recipients.` }); }
        if (textMessage.length > MAX_MESSAGE_LENGTH) { cleanupFiles(files); return res.status(400).json({ error: `Message too long. Max ${MAX_MESSAGE_LENGTH} chars.` }); }
        if (files.length === 0 && !textMessage.trim()) return res.status(400).json({ error: 'Provide a file or message.' });

        const MAX_SIZE = 50 * 1024 * 1024;
        const oversized = files.filter(f => f.size > MAX_SIZE);
        if (oversized.length > 0) { cleanupFiles(files); return res.status(400).json({ error: `${oversized.length} file(s) exceed 50MB.` }); }

        log('INFO', 'Upload request', { channel, targets: targets.length, files: files.length, ip: requestIP });

        // ─── TELEGRAM ───
        if (channel === 'telegram') {
            if (!telegramBot) { cleanupFiles(files); return res.status(503).json({ error: 'Telegram not configured.' }); }

            const resolved = [], notFound = [];
            for (const t of targets) {
                const cid = resolveTelegramTarget(t);
                if (cid) resolved.push({ label: t, chatId: cid });
                else notFound.push(t);
            }
            if (notFound.length > 0) {
                cleanupFiles(files);
                return res.status(400).json({ error: `Username(s) not found: ${notFound.join(', ')}. They must /start the bot first.` });
            }

            if (scheduledTime) {
                const delayMs = new Date(scheduledTime).getTime() - Date.now();
                if (delayMs < 0) { cleanupFiles(files); return res.status(400).json({ error: 'Scheduled time must be in the future.' }); }
                const jobId = Date.now().toString(36);
                scheduledJobs.push({
                    id: jobId, targets: resolved.map(r => r.label), fileCount: files.length, scheduledFor: new Date(scheduledTime).toISOString(),
                    timer: setTimeout(async () => {
                        for (const t of resolved) await sendTelegram(t.chatId, textMessage, files);
                        cleanupFiles(files);
                        scheduledJobs.splice(scheduledJobs.findIndex(j => j.id === jobId), 1);
                    }, delayMs)
                });
                return res.json({ success: true, scheduled: true, message: `Scheduled for ${resolved.length} recipient(s)!` });
            }

            let totalSent = 0;
            for (const t of resolved) {
                const r = await sendTelegram(t.chatId, textMessage, files);
                totalSent += r.filesSent;
                if (r.errors.length) log('ERROR', `Telegram errors for ${t.label}`, { errors: r.errors });
            }
            cleanupFiles(files);
            return res.json({ success: true, message: `${totalSent + (textMessage ? resolved.length : 0)} item(s) sent to ${resolved.length} recipient(s)!` });

        // ─── WHATSAPP ───
        } else if (channel === 'whatsapp') {
            // SECURITY: Verify session
            if (!isSessionVerified(requestIP)) {
                cleanupFiles(files);
                return res.status(403).json({ error: 'Session expired. Please verify your phone number again.' });
            }

            const sessionPhone = getVerifiedPhone(requestIP);
            if (!sessionPhone || !isWaAllowed(sessionPhone)) {
                cleanupFiles(files);
                delete waVerifiedSessions[requestIP];
                return res.status(403).json({ error: 'Your number is no longer authorized.' });
            }

            // Check WhatsApp connection
            const session = activeSessions.get(sessionPhone);
            if (!session || !session.ready) {
                cleanupFiles(files);
                return res.status(503).json({ error: 'WhatsApp not connected. Please scan the QR code first.' });
            }

            // Daily limit
            if (!checkDailyLimit(sessionPhone)) {
                cleanupFiles(files);
                return res.status(429).json({ error: `Daily limit reached (${WA_DAILY_LIMIT}/day). Try tomorrow.` });
            }

            // Recipient restriction — only whitelisted numbers
            for (const t of targets) {
                const rn = String(t).replace(/\D/g, '');
                const fullNum = rn.length === 10 ? '91' + rn : rn;
                if (!waAllowedNumbers.includes(fullNum)) {
                    cleanupFiles(files);
                    log('WARN', `Blocked send to non-whitelisted: ${fullNum}`, { sender: sessionPhone, ip: requestIP });
                    return res.status(403).json({ error: `Recipient ${t} is not authorized. Only whitelisted numbers allowed.` });
                }
            }

            // Audit log
            log('INFO', 'WhatsApp send audit', {
                sender: sessionPhone.slice(-4).padStart(sessionPhone.length, '*'),
                recipients: targets.length, hasMessage: !!textMessage, fileCount: files.length, ip: requestIP
            });

            const resolved = targets.map(t => ({ label: t, chatId: formatWhatsAppNumber(t) }));

            if (scheduledTime) {
                const delayMs = new Date(scheduledTime).getTime() - Date.now();
                if (delayMs < 0) { cleanupFiles(files); return res.status(400).json({ error: 'Scheduled time must be in the future.' }); }
                const jobId = Date.now().toString(36);
                scheduledJobs.push({
                    id: jobId, targets: resolved.map(r => r.label), fileCount: files.length, scheduledFor: new Date(scheduledTime).toISOString(),
                    timer: setTimeout(async () => {
                        for (const t of resolved) await sendWhatsApp(sessionPhone, t.chatId, textMessage, files);
                        cleanupFiles(files);
                        scheduledJobs.splice(scheduledJobs.findIndex(j => j.id === jobId), 1);
                    }, delayMs)
                });
                return res.json({ success: true, scheduled: true, message: `Scheduled for ${resolved.length} recipient(s)!` });
            }

            let totalSent = 0, allErrors = [];
            for (const t of resolved) {
                const r = await sendWhatsApp(sessionPhone, t.chatId, textMessage, files);
                totalSent += r.filesSent;
                if (r.textSent) totalSent++;
                if (r.errors.length) { log('ERROR', `WhatsApp errors for ${t.label}`, { errors: r.errors }); allErrors.push(...r.errors); }
            }
            cleanupFiles(files);

            if (totalSent === 0 && allErrors.length > 0) {
                return res.status(502).json({ error: `WhatsApp failed: ${allErrors[0]}` });
            }

            if (totalSent > 0) incrementDailyUsage(sessionPhone);
            const warn = allErrors.length > 0 ? ` (${allErrors.length} warning(s))` : '';
            return res.json({ success: true, message: `${totalSent} item(s) sent via WhatsApp!${warn}` });
        }

    } catch (error) {
        log('ERROR', `Upload failed: ${error.message}`, { stack: error.stack });
        if (req.files) cleanupFiles(req.files);
        res.status(500).json({ error: `Failed: ${error.message}` });
    }
});

// ==============================
// STARTUP
// ==============================
async function startServer() {
    await connectDB();
    await loadWhitelist();
    await loadUserMap();

    app.listen(port, () => {
        log('INFO', `Bridge Server running at http://localhost:${port}`);
        log('INFO', `MongoDB: ${db ? 'connected' : 'file-fallback'} | Telegram: ${telegramBot ? 'active' : 'disabled'} | WA whitelist: ${waAllowedNumbers.length}`);
    });
}

startServer().catch(err => {
    log('FATAL', `Server startup failed: ${err.message}`);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    log('INFO', 'Graceful shutdown...');
    for (const [id, session] of activeSessions) {
        try { session.socket?.end(); } catch (e) {}
    }
    process.exit(0);
});
process.on('SIGINT', async () => {
    log('INFO', 'Graceful shutdown (SIGINT)...');
    for (const [id, session] of activeSessions) {
        try { session.socket?.end(); } catch (e) {}
    }
    process.exit(0);
});
