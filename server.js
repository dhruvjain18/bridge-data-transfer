require('dotenv').config();
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const { DisconnectReason, initAuthCreds, BufferJSON, proto, fetchLatestBaileysVersion, Browsers } = baileys;
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const webpush = require('web-push');

// GramJS (Telegram MTProto Client) for QR-based login
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const TG_API_ID = parseInt(process.env.TELEGRAM_API_ID || '0');
const TG_API_HASH = (process.env.TELEGRAM_API_HASH || '').trim();

// Generate RSA Keypair for Client-to-Server Encryption
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const port = process.env.PORT || 3000;
app.set('trust proxy', 1);

io.on('connection', (socket) => {
    socket.on('join_wa_session', (sessionId) => {
        if (sessionId) socket.join(sessionId);
    });
    socket.on('join_tg_session', (sessionId) => {
        if (sessionId) socket.join('tg_' + sessionId);
    });
});

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
                    '/admin/telegram-users', '/admin/logs'];
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
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://apis.google.com https://accounts.google.com https://www.dropbox.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://accounts.google.com https://fonts.googleapis.com; img-src 'self' data: blob:; connect-src 'self' https://www.googleapis.com https://accounts.google.com; font-src 'self' https://fonts.gstatic.com; frame-src 'self' blob: https://docs.google.com https://accounts.google.com https://content.googleapis.com; object-src 'self' blob:;");
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
    limits: { fileSize: 2000 * 1024 * 1024 }, // 2 GB limit (up from 100MB) to support TG client mode
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

function getMimeType(filename, providedMime) {
    if (providedMime && providedMime !== 'application/octet-stream') return providedMime;
    const ext = path.extname(filename).toLowerCase();
    const map = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
        '.pdf': 'application/pdf', '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
        '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json'
    };
    return map[ext] || 'application/octet-stream';
}

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
        await db.collection('scheduled_jobs').createIndex({ id: 1 }, { unique: true });
    } catch (e) {
        log('ERROR', `MongoDB connection failed: ${e.message}`);
    }
}

async function persistJob(jobData) {
    if (db) await db.collection('scheduled_jobs').updateOne({ id: jobData.id }, { $set: jobData }, { upsert: true });
}

async function removeJob(jobId) {
    if (db) await db.collection('scheduled_jobs').deleteOne({ id: jobId });
}

async function restoreScheduledJobs() {
    if (!db) return;
    try {
        const jobs = await db.collection('scheduled_jobs').find({}).toArray();
        for (const job of jobs) {
            const delayMs = new Date(job.scheduledFor).getTime() - Date.now();
            if (delayMs < 0 && job.cyclePeriod === 'none') {
                executeJobNow(job);
            } else {
                reScheduleJob(job, Math.max(delayMs, 0));
            }
        }
        log('INFO', `Restored ${jobs.length} scheduled jobs`);
    } catch (e) {
        log('ERROR', `Failed to restore jobs: ${e.message}`);
    }
}

async function executeJobNow(job) {
    if (job.channel === 'telegram') {
        for (const t of job.resolvedTargets) await sendTelegram(t.chatId, job.textMessage, job.files, job.selfDestruct);
    } else if (job.channel === 'whatsapp') {
        for (const t of job.resolvedTargets) await sendWhatsApp(job.sessionId, t.chatId, job.textMessage, job.files, job.selfDestruct);
    }
    
    if (job.cyclePeriod !== 'none') {
        const nextDate = new Date();
        if (job.cyclePeriod === 'daily') nextDate.setDate(nextDate.getDate() + 1);
        else if (job.cyclePeriod === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
        else if (job.cyclePeriod === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
        job.scheduledFor = nextDate.toISOString();
        await persistJob(job);
        reScheduleJob(job, nextDate.getTime() - Date.now());
    } else {
        await removeJob(job.id);
        cleanupFiles(job.files);
    }
}

function reScheduleJob(job, delayMs) {
    scheduledJobs.push({
        id: job.id, targets: job.targets, fileCount: job.files.length, scheduledFor: job.scheduledFor,
        timer: setTimeout(async () => {
            await executeJobNow(job);
            scheduledJobs.splice(scheduledJobs.findIndex(j => j.id === job.id), 1);
        }, delayMs)
    });
}

async function cleanupStaleUploads() {
    try {
        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) return;
        const stale = fs.readdirSync(uploadsDir);
        let activePaths = new Set();
        if (db) {
            const jobs = await db.collection('scheduled_jobs').find({}).toArray();
            for (const j of jobs) {
                if (j.files) j.files.forEach(f => activePaths.add(path.resolve(f.path)));
            }
        }
        let cleaned = 0;
        for (const f of stale) {
            const p = path.join(uploadsDir, f);
            if (!activePaths.has(p)) { fs.unlinkSync(p); cleaned++; }
        }
        if (cleaned > 0) log('INFO', `Cleaned ${cleaned} stale upload(s)`);
    } catch (e) {
        log('WARN', `Cleanup uploads failed: ${e.message}`);
    }
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
            for (const doc of docs) userMap[doc.username] = { chatId: doc.chatId, firstName: doc.firstName || '' };
            if (Object.keys(userMap).length > 0) {
                log('INFO', `Telegram users from DB: ${Object.keys(userMap).length}`);
                return;
            }
        } catch (e) { log('ERROR', `DB user map load failed: ${e.message}`); }
    }
    // File fallback
    if (fs.existsSync(USER_MAP_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(USER_MAP_FILE, 'utf-8'));
            userMap = {};
            for (const [u, v] of Object.entries(raw)) {
                userMap[u] = typeof v === 'object' ? v : { chatId: v, firstName: '' };
            }
            log('INFO', `Telegram users from file: ${Object.keys(userMap).length}`);
            if (db && Object.keys(userMap).length > 0) {
                for (const [u, data] of Object.entries(userMap)) {
                    await db.collection('telegram_users').updateOne({ username: u }, { $set: { username: u, chatId: data.chatId, firstName: data.firstName, updatedAt: new Date() } }, { upsert: true });
                }
                log('INFO', 'Migrated Telegram users to MongoDB');
            }
        } catch (e) { userMap = {}; }
    }
}

async function saveUserMapping(username, chatId, firstName = '') {
    userMap[username] = { chatId, firstName };
    if (db) {
        await db.collection('telegram_users').updateOne(
            { username }, { $set: { username, chatId, firstName, updatedAt: new Date() } }, { upsert: true }
        );
    } else {
        const flat = {};
        for (const [u, v] of Object.entries(userMap)) flat[u] = v;
        fs.writeFileSync(USER_MAP_FILE, JSON.stringify(flat, null, 2));
    }
}

// ==============================
// SECURITY: Sessions, Limits
// ==============================
const waDailyUsage = {};
const WA_DAILY_LIMIT = 50;

function checkDailyLimit(sessionId) {
    const today = new Date().toISOString().split('T')[0];
    if (!waDailyUsage[sessionId] || waDailyUsage[sessionId].date !== today) waDailyUsage[sessionId] = { count: 0, date: today };
    return waDailyUsage[sessionId].count < WA_DAILY_LIMIT;
}
function incrementDailyUsage(sessionId) {
    const today = new Date().toISOString().split('T')[0];
    if (!waDailyUsage[sessionId] || waDailyUsage[sessionId].date !== today) waDailyUsage[sessionId] = { count: 0, date: today };
    waDailyUsage[sessionId].count++;
}

const scheduledJobs = [];

// ==============================
// VAPID PUSH NOTIFICATIONS SETUP
// ==============================
let vapidConfigured = false;
const pushSubscriptions = [];

function setupVapid() {
    let publicVapid = process.env.VAPID_PUBLIC_KEY || '';
    let privateVapid = process.env.VAPID_PRIVATE_KEY || '';
    const vapidEmail = process.env.VAPID_EMAIL || 'mailto:admin@bridge.app';
    if (!publicVapid || !privateVapid) {
        const keys = webpush.generateVAPIDKeys();
        publicVapid = keys.publicKey;
        privateVapid = keys.privateKey;
        log('INFO', 'Auto-generated VAPID keys (set in .env to persist)');
    }
    try {
        webpush.setVapidDetails(`mailto:${vapidEmail}`, publicVapid, privateVapid);
        vapidConfigured = true;
        log('INFO', 'VAPID push notifications configured');
    } catch (e) { log('WARN', `VAPID setup failed: ${e.message}`); }
}

// ==============================
// ADMIN 2FA (TOTP)
// ==============================
const admin2faSecret = (process.env.ADMIN_2FA_SECRET || '').trim();
const admin2faEnabled = admin2faSecret.length > 0;

// ==============================
// HEALTH MONITORING
// ==============================
const HEALTH_MEMORY_THRESHOLD = parseInt(process.env.HEALTH_MEMORY_THRESHOLD_MB || '512');
const ADMIN_TG_CHAT = (process.env.ADMIN_TELEGRAM_CHAT_ID || '').trim();
const healthAlertCooldowns = {};

function sendHealthAlert(type, message) {
    const now = Date.now();
    if (healthAlertCooldowns[type] && (now - healthAlertCooldowns[type]) < 15 * 60 * 1000) return;
    healthAlertCooldowns[type] = now;
    log('WARN', `HEALTH ALERT [${type}]: ${message}`);
    if (telegramBot && ADMIN_TG_CHAT) {
        telegramBot.sendMessage(ADMIN_TG_CHAT, `⚠️ *Bridge Health Alert*\n\n*${type}*: ${message}`, { parse_mode: 'Markdown' }).catch(() => {});
    }
    if (db) {
        db.collection('health_alerts').insertOne({ type, message, timestamp: new Date() }).catch(() => {});
    }
}

let rateLimitViolations = 0;
setInterval(() => {
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (memMB > HEALTH_MEMORY_THRESHOLD) sendHealthAlert('MEMORY', `RSS at ${memMB}MB (threshold: ${HEALTH_MEMORY_THRESHOLD}MB)`);
    if (rateLimitViolations > 20) sendHealthAlert('RATE_LIMIT', `${rateLimitViolations} rate-limit violations in the last minute`);
    rateLimitViolations = 0;
}, 60 * 1000);

// ==============================
// ANALYTICS: Transfer Logging
// ==============================
async function logTransfer(channel, recipientCount, fileCount, totalSizeBytes) {
    if (!db) return;
    try {
        await db.collection('transfer_logs').insertOne({
            channel, recipientCount, fileCount, totalSizeBytes,
            timestamp: new Date(),
            hour: new Date().getHours()
        });
    } catch (e) { log('ERROR', `Analytics log failed: ${e.message}`); }
}

// ==============================
// TELEGRAM BOT
// ==============================
const telegramToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
let telegramBot = null;

if (telegramToken && telegramToken !== 'YOUR_BOT_TOKEN_HERE') {
    telegramBot = new TelegramBot(telegramToken, { polling: { params: { timeout: 30 }, interval: 2000 } });
    
    telegramBot.on('polling_error', (err) => {
        if (err?.message?.includes('409 Conflict')) log('WARN', 'Telegram polling conflict (another instance running)');
        else log('ERROR', `Telegram polling error: ${err.message}`);
    });

    telegramBot.on('error', (error) => log('ERROR', `Telegram bot error: ${error.message}`));
    telegramBot.getMe().then(info => log('INFO', `Telegram Bot connected: @${info.username}`))
        .catch(err => log('ERROR', `Telegram Bot connection check failed: ${err.message} (Bot still active)`));

    telegramBot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from.username;
        const firstName = msg.from.first_name || 'there';
        if (username) {
            await saveUserMapping(username.toLowerCase(), chatId, firstName);
            log('INFO', `Registered Telegram user @${username} (${firstName}) → ${chatId}`);
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
// NODEMAILER (Email functionality)
// ==============================
const smtpConfig = {
    host: (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
    port: parseInt((process.env.SMTP_PORT || '587').trim()),
    secure: parseInt((process.env.SMTP_PORT || '587').trim()) === 465,
    auth: {
        user: (process.env.SMTP_USER || '').trim(),
        pass: (process.env.SMTP_PASS || '').trim()
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
};
let transporter = null;
if (smtpConfig.auth.user && smtpConfig.auth.pass) {
    transporter = nodemailer.createTransport(smtpConfig);
    transporter.verify().then(() => log('INFO', 'Nodemailer connected')).catch(err => log('WARN', `Nodemailer failed: ${err.message}`));
} else {
    log('WARN', 'SMTP not configured. Email channel will fail.');
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
        session = { socket: null, qr: null, ready: false, lastActivity: Date.now(), connecting: true, pairingCode: null };
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

        const { version } = await fetchLatestBaileysVersion();
        log('INFO', `Using WhatsApp Web version: ${version}`);

        const sock = makeWASocket({
            auth: authState.state,
            version,
            printQRInTerminal: false,
            logger: pino({ level: 'warn' }),
            browser: Browsers.windows('Chrome'),
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
                    io.to(phoneId).emit('wa_status_update', { ready: false, qr: session.qr });
                } catch (e) { log('ERROR', `QR render error: ${e.message}`); }
            }

            if (connection === 'open') {
                session.ready = true;
                session.connecting = false;
                session.qr = null;
                sessionRetries.delete(phoneId);
                log('INFO', `WhatsApp connected for user ${phoneId}`);
                io.to(phoneId).emit('wa_status_update', { ready: true });
                io.emit('admin_dashboard_update');
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
                    io.to(phoneId).emit('wa_status_update', { ready: false, error: 'Session ended' });
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

// Request pairing code for phone-based linking (mobile users)
// Pairing code needs a fresh connection — you can't switch from QR to pairing mid-session
async function requestSessionPairingCode(sessionId, phoneNumber) {
    let session = activeSessions.get(sessionId);
    if (session && session.ready) {
        return { error: 'Already connected. No pairing needed.' };
    }
    if (!db) {
        return { error: 'Database not connected. Please try again later.' };
    }

    try {
        // Close existing socket if any (QR session) — need fresh connection for pairing
        if (session && session.socket) {
            try { session.socket.end(); } catch (e) {}
            session.socket = null;
        }
        // Remove old session
        activeSessions.delete(sessionId);
        // Clear any stored auth state for this session so we get a fresh registration
        await clearSessionFromDB(sessionId);

        // Create fresh session
        const authState = await useMongoDBAuthState(sessionId);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: authState.state,
            version,
            printQRInTerminal: false,
            logger: pino({ level: 'warn' }),
            browser: Browsers.windows('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
        });

        session = { socket: sock, qr: null, ready: false, lastActivity: Date.now(), connecting: true, pairingCode: null };
        activeSessions.set(sessionId, session);

        // Wait for the socket to be ready for pairing (connection.update → connecting)
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);
            sock.ev.on('connection.update', (update) => {
                const { connection, qr: qrCode } = update;
                log('INFO', `WA pairing connection update for ${sessionId}`, { connection, hasQR: !!qrCode });
                if (connection === 'open') {
                    session.ready = true;
                    session.connecting = false;
                    clearTimeout(timeout);
                    resolve();
                }
                if (qrCode) {
                    // QR received means socket is ready — now request pairing code
                    clearTimeout(timeout);
                    resolve();
                }
                if (connection === 'close') {
                    clearTimeout(timeout);
                    reject(new Error('Connection closed'));
                }
            });
            sock.ev.on('creds.update', authState.saveCreds);
        });

        if (session.ready) {
            return { error: 'Already connected. No pairing needed.' };
        }

        // Now request pairing code
        const cleanNumber = phoneNumber.replace(/\D/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        session.pairingCode = code;

        // Set up connection handling for the pairing session
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                session.ready = true;
                session.connecting = false;
                session.qr = null;
                log('INFO', `WhatsApp connected via pairing for ${sessionId}`);
                io.to(sessionId).emit('wa_status_update', { ready: true });
                io.emit('admin_dashboard_update');
            }
            if (connection === 'close') {
                session.ready = false;
                session.socket = null;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut) {
                    log('INFO', `WhatsApp pairing session reconnecting for ${sessionId}`);
                    setTimeout(() => createOrRestoreSession(sessionId), 3000);
                } else {
                    activeSessions.delete(sessionId);
                    io.to(sessionId).emit('wa_status_update', { ready: false, error: 'Session ended' });
                    await clearSessionFromDB(sessionId);
                }
            }
        });

        log('INFO', `Pairing code generated for ${sessionId}: ${code}`);
        return { pairingCode: code };
    } catch (e) {
        log('ERROR', `Pairing code error for ${sessionId}: ${e.message}`);
        return { error: 'Failed to generate pairing code: ' + e.message };
    }
}

// Idle session cleanup every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of activeSessions) {
        if (now - session.lastActivity > SESSION_IDLE_TIMEOUT) {
            log('INFO', `Disconnecting idle WA session: ${id}`);
            try { session.socket?.end(); } catch (e) {}
            activeSessions.delete(id);
        }
    }
    // Also clean idle Telegram sessions
    for (const [id, session] of tgActiveSessions) {
        if (now - session.lastActivity > SESSION_IDLE_TIMEOUT) {
            log('INFO', `Disconnecting idle TG session: ${id}`);
            try { if (session._authPoller) clearInterval(session._authPoller); } catch (e) {}
            try { if (session._qrTimer) clearTimeout(session._qrTimer); } catch (e) {}
            try { session.client?.disconnect(); } catch (e) {}
            tgActiveSessions.delete(id);
        }
    }
}, 5 * 60 * 1000);

// ==============================
// TELEGRAM GRAMJS: Per-User MTProto Session Manager
// ==============================
const tgActiveSessions = new Map();
const MAX_TG_SESSIONS = 10;
const tgSessionRetries = new Map();

async function loadTgSessionString(sessionId) {
    if (!db) return '';
    try {
        const doc = await db.collection('tg_sessions').findOne({ sessionId });
        return doc ? doc.sessionString : '';
    } catch (e) {
        log('ERROR', `Failed to load TG session: ${e.message}`);
        return '';
    }
}

async function saveTgSessionString(sessionId, sessionString) {
    if (!db) return;
    try {
        await db.collection('tg_sessions').updateOne(
            { sessionId },
            { $set: { sessionId, sessionString, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (e) {
        log('ERROR', `Failed to save TG session: ${e.message}`);
    }
}

async function clearTgSession(sessionId) {
    if (!db) return;
    await db.collection('tg_sessions').deleteOne({ sessionId });
    log('INFO', `Cleared TG session for ${sessionId}`);
}

async function createOrRestoreTelegramSession(sessionId) {
    let session = tgActiveSessions.get(sessionId);
    
    // Already active and connected
    if (session && session.ready && session.client?.connected) {
        session.lastActivity = Date.now();
        return session;
    }

    if (!session) {
        // Evict oldest if at capacity
        if (tgActiveSessions.size >= MAX_TG_SESSIONS) {
            let oldestKey = null, oldestTime = Infinity;
            for (const [key, sess] of tgActiveSessions) {
                if (sess.lastActivity < oldestTime) { oldestTime = sess.lastActivity; oldestKey = key; }
            }
            if (oldestKey) {
                log('INFO', `Evicting idle TG session: ${oldestKey}`);
                try { tgActiveSessions.get(oldestKey).client?.disconnect(); } catch (e) {}
                tgActiveSessions.delete(oldestKey);
            }
        }
        session = { client: null, qr: null, ready: false, lastActivity: Date.now(), connecting: true };
        tgActiveSessions.set(sessionId, session);
    }

    if (!TG_API_ID || !TG_API_HASH) {
        log('WARN', 'Telegram API ID/Hash not configured for MTProto');
        tgActiveSessions.delete(sessionId);
        return null;
    }

    session.connecting = true;
    session.ready = false;
    session.lastActivity = Date.now();

    // Helper to finalize a successful login
    const finalizeLogin = async (client, sessionId, session) => {
        if (session.ready) return; // Already done
        session.ready = true;
        session.connecting = false;
        session.qr = null;
        if (session._qrTimer) clearTimeout(session._qrTimer);
        if (session._authPoller) clearInterval(session._authPoller);

        try {
            const savedSession = client.session.save();
            await saveTgSessionString(sessionId, savedSession);
        } catch (e) { log('WARN', `Failed to save TG session: ${e.message}`); }

        log('INFO', `Telegram connected for ${sessionId}`);
        io.to('tg_' + sessionId).emit('tg_status_update', { ready: true });
    };

    try {
        // Load stored session string from MongoDB
        const storedSession = await loadTgSessionString(sessionId);
        const stringSession = new StringSession(storedSession);

        const client = new TelegramClient(stringSession, TG_API_ID, TG_API_HASH, {
            connectionRetries: 5,
            baseLogger: pino({ level: 'error' }),
        });

        session.client = client;

        // Check if we already have a valid stored session
        if (storedSession) {
            try {
                await client.connect();
                if (await client.checkAuthorization()) {
                    await finalizeLogin(client, sessionId, session);
                    return session;
                }
            } catch (e) {
                log('WARN', `Telegram stored session invalid for ${sessionId}: ${e.message}`);
            }
        }

        // No valid session — start QR login flow
        if (!client.connected) await client.connect();

        // QR Token generation loop
        const loginLoop = async () => {
            if (session.ready) return; // Already connected
            try {
                // First: quick authorization check (catches scan between polls)
                try {
                    if (await client.checkAuthorization()) {
                        await finalizeLogin(client, sessionId, session);
                        return;
                    }
                } catch (e) { /* not authorized yet */ }

                const result = await client.invoke(
                    new Api.auth.ExportLoginToken({
                        apiId: TG_API_ID,
                        apiHash: TG_API_HASH,
                        exceptIds: [],
                    })
                );

                const resultName = result.className || result.constructor?.name || '';

                if (resultName === 'auth.LoginTokenSuccess' || resultName === 'LoginTokenSuccess') {
                    await finalizeLogin(client, sessionId, session);
                } else if (resultName === 'auth.LoginTokenMigrateTo' || resultName === 'LoginTokenMigrateTo') {
                    log('INFO', `Telegram QR migration needed for ${sessionId} → DC ${result.dcId}`);
                    await client._switchDC(result.dcId);
                    
                    // After DC migration, try importing the token
                    try {
                        const imported = await client.invoke(
                            new Api.auth.ImportLoginToken({ token: result.token })
                        );
                        const impName = imported.className || imported.constructor?.name || '';
                        if (impName.includes('LoginTokenSuccess') || impName.includes('Authorization')) {
                            await finalizeLogin(client, sessionId, session);
                            return;
                        }
                    } catch (e) { /* import failed, will generate new QR */ }

                    // Generate new QR after migration
                    if (!session.ready) setTimeout(loginLoop, 500);
                } else {
                    // LoginToken — generate QR code
                    const tokenBase64 = result.token.toString('base64url');
                    const qrUrl = `tg://login?token=${tokenBase64}`;
                    session.qr = await qrcode.toDataURL(qrUrl, { margin: 2, scale: 8 });
                    session.connecting = false;
                    log('INFO', `Telegram QR ready for ${sessionId}`);
                    io.to('tg_' + sessionId).emit('tg_status_update', { ready: false, qr: session.qr });

                    // Refresh QR in 20 seconds (token expires ~30s)
                    session._qrTimer = setTimeout(loginLoop, 20000);
                }
            } catch (e) {
                if (e.message?.includes('SESSION_PASSWORD_NEEDED')) {
                    log('WARN', `Telegram 2FA required for ${sessionId}`);
                    session.connecting = false;
                    io.to('tg_' + sessionId).emit('tg_status_update', { ready: false, error: '2FA is enabled on this account. Please use the Bot method instead.' });
                } else {
                    log('ERROR', `Telegram QR login error for ${sessionId}: ${e.message}`);
                    if (!session.ready) {
                        session._qrTimer = setTimeout(loginLoop, 5000);
                    }
                }
            }
        };

        // Listen for successful scan via event handler (backup)
        client.addEventHandler(async (update) => {
            const updateName = update.className || update.constructor?.name || '';
            if (updateName === 'UpdateLoginToken' || updateName === 'updateLoginToken') {
                log('INFO', `Telegram UpdateLoginToken received for ${sessionId}`);
                try {
                    if (await client.checkAuthorization()) {
                        await finalizeLogin(client, sessionId, session);
                        return;
                    }
                    // Try ExportLoginToken again
                    const result = await client.invoke(
                        new Api.auth.ExportLoginToken({
                            apiId: TG_API_ID,
                            apiHash: TG_API_HASH,
                            exceptIds: [],
                        })
                    );
                    const rName = result.className || result.constructor?.name || '';
                    if (rName.includes('LoginTokenSuccess') || rName.includes('Authorization')) {
                        await finalizeLogin(client, sessionId, session);
                    }
                } catch (e) {
                    if (e.message?.includes('SESSION_PASSWORD_NEEDED')) {
                        session.connecting = false;
                        io.to('tg_' + sessionId).emit('tg_status_update', { ready: false, error: '2FA is enabled. Please use the Bot method.' });
                    } else {
                        log('ERROR', `Telegram login token update error: ${e.message}`);
                    }
                }
            }
        });

        // Start the QR generation loop
        loginLoop();

        // Also poll checkAuthorization every 3 seconds as a safety net
        session._authPoller = setInterval(async () => {
            if (session.ready) { clearInterval(session._authPoller); return; }
            try {
                if (client.connected && await client.checkAuthorization()) {
                    await finalizeLogin(client, sessionId, session);
                }
            } catch (e) { /* not authorized yet */ }
        }, 3000);

    } catch (e) {
        log('ERROR', `Failed to create TG session for ${sessionId}: ${e.message}`);
        tgActiveSessions.delete(sessionId);
        return null;
    }

    return session;
}

async function getTelegramContacts(sessionId) {
    const session = tgActiveSessions.get(sessionId);
    if (!session || !session.ready || !session.client) return [];

    try {
        const result = await session.client.invoke(
            new Api.contacts.GetContacts({ hash: BigInt(0) })
        );
        
        if (!result.users) return [];
        
        return result.users.map(user => ({
            name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'Unknown',
            value: user.username ? `@${user.username}` : (user.phone ? user.phone : String(user.id)),
            phone: user.phone || '',
            username: user.username || '',
            channel: 'telegram'
        })).filter(c => c.value);
    } catch (e) {
        log('ERROR', `Failed to fetch TG contacts: ${e.message}`);
        return [];
    }
}

async function sendTelegramClient(sessionId, target, text, files) {
    const session = tgActiveSessions.get(sessionId);
    if (!session || !session.ready || !session.client) {
        return { textSent: false, filesSent: 0, errors: ['Telegram client not connected'] };
    }

    const results = { textSent: false, filesSent: 0, errors: [] };
    session.lastActivity = Date.now();

    try {
        // Resolve target — could be @username, phone number, or user ID
        let peer;
        if (target.startsWith('@')) {
            peer = target;
        } else if (/^\d+$/.test(target)) {
            // Could be a user ID or phone number — try resolving
            try {
                const resolved = await session.client.invoke(
                    new Api.contacts.ResolvePhone({ phone: target })
                );
                peer = resolved.users[0];
            } catch (e) {
                // Try as user ID
                peer = BigInt(target);
            }
        } else {
            peer = target;
        }

        if (text) {
            try {
                await session.client.sendMessage(peer, { message: text });
                results.textSent = true;
            } catch (e) { results.errors.push(`Text: ${e.message}`); }
        }

        for (const file of files) {
            try {
                const filePath = path.resolve(file.path);
                await session.client.sendFile(peer, {
                    file: filePath,
                    caption: file.originalname,
                    forceDocument: true,
                });
                results.filesSent++;
            } catch (e) { results.errors.push(`${file.originalname}: ${e.message}`); }
        }
    } catch (e) {
        results.errors.push(`Send failed: ${e.message}`);
    }

    return results;
}

// ==============================
// HELPERS
// ==============================
function resolveTelegramTarget(target) {
    target = target.trim();
    if (/^\d+$/.test(target)) return target;
    const username = target.startsWith('@') ? target.slice(1).toLowerCase() : target.toLowerCase();
    const entry = userMap[username];
    return entry ? (typeof entry === 'object' ? entry.chatId : entry) : null;
}

function formatWhatsAppNumber(phone) {
    let num = phone.replace(/\D/g, '');
    if (num.length === 10) num = '91' + num;
    return num + '@s.whatsapp.net';
}

async function sendTelegram(chatId, text, files, selfDestruct = false) {
    const results = { textSent: false, filesSent: 0, errors: [] };
    const textMsg = selfDestruct ? `🔥 *SELF-DESTRUCT MESSAGE*\n\n${text}` : text;
    
    if (textMsg) {
        try { 
            await telegramBot.sendMessage(chatId, textMsg, { parse_mode: 'Markdown' }); 
            results.textSent = true; 
        }
        catch (e) { results.errors.push(`Text: ${e.message}`); }
    }
    for (const file of files) {
        try {
            const filePath = path.resolve(file.path);
            const mime = getMimeType(file.originalname, file.mimetype);
            const caption = selfDestruct ? `🔥 Self-destruct: ${file.originalname}` : file.originalname;
            const options = { caption, protect_content: selfDestruct, parse_mode: 'Markdown' };

            if (mime.startsWith('image/') && !file.originalname.toLowerCase().endsWith('.gif')) {
                await telegramBot.sendPhoto(chatId, filePath, options);
            } else if (mime.startsWith('video/')) {
                await telegramBot.sendVideo(chatId, filePath, options);
            } else if (mime.startsWith('audio/')) {
                await telegramBot.sendAudio(chatId, filePath, options);
            } else {
                await telegramBot.sendDocument(chatId, filePath, options, { 
                    filename: file.originalname, 
                    contentType: mime 
                });
            }
            results.filesSent++;
        } catch (e) { results.errors.push(`${file.originalname}: ${e.message}`); }
    }
    return results;
}

async function sendEmail(emailTo, text, files, senderName) {
    const results = { textSent: false, filesSent: 0, errors: [] };
    if (!transporter) return { textSent: false, filesSent: 0, errors: ['SMTP Server not configured'] };

    const attachments = files.map(f => ({ filename: f.originalname, path: path.resolve(f.path) }));
    const displayName = senderName ? `${senderName} (via Bridge)` : 'Bridge Secure Transfer';
    const escapedText = text ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') : '';
    
    try {
        await transporter.sendMail({
            from: `"${displayName}" <${smtpConfig.auth.user}>`, 
            to: emailTo,
            replyTo: smtpConfig.auth.user,
            subject: `${senderName ? senderName + ' sent you' : 'You received'} a secure transfer via Bridge`,
            text: text || 'You have received files via Bridge.',
            html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
                <div style="background:linear-gradient(135deg,#0088cc,#00c6ff);padding:20px 24px;border-radius:12px 12px 0 0;">
                    <h2 style="color:#fff;margin:0;font-size:20px;">📨 Bridge Secure Transfer</h2>
                </div>
                <div style="background:#f9fafb;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
                    ${escapedText ? `<p style="font-size:15px;line-height:1.6;color:#333;white-space:pre-wrap;">${escapedText}</p>` : ''}
                    ${attachments.length ? `<div style="margin-top:16px;padding:12px 16px;background:#e8f4fd;border-radius:8px;">
                        <p style="margin:0;color:#0088cc;font-weight:600;">📎 ${attachments.length} file${attachments.length > 1 ? 's' : ''} attached</p>
                    </div>` : ''}
                    ${!escapedText && !attachments.length ? '<p style="color:#666;">You have received a transfer via Bridge.</p>' : ''}
                    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;">
                    <p style="color:#9ca3af;font-size:11px;margin:0;">Sent securely via Bridge · Files are encrypted in transit</p>
                </div>
            </div>`,
            attachments: attachments
        });
        results.textSent = !!text;
        results.filesSent = files.length;
    } catch (e) {
        results.errors.push(`Email error: ${e.message}`);
    }
    return results;
}

async function sendWhatsApp(sessionId, chatId, text, files, selfDestruct = false) {
    const session = activeSessions.get(sessionId);
    if (!session || !session.ready || !session.socket) {
        return { textSent: false, filesSent: 0, errors: ['WhatsApp not connected. Please scan QR and try again.'] };
    }

    session.lastActivity = Date.now();
    const sock = session.socket;
    const results = { textSent: false, filesSent: 0, errors: [] };

    if (text) {
        try {
            const textMsg = selfDestruct ? `🔥 *SELF-DESTRUCT MESSAGE*\n\n${text}` : text;
            await sock.sendMessage(chatId, { text: textMsg });
            results.textSent = true;
        } catch (e) { results.errors.push(`Text: ${e.message}`); }
    }

    for (const file of files) {
        try {
            const buffer = fs.readFileSync(path.resolve(file.path));
            const mime = getMimeType(file.originalname, file.mimetype);
            const caption = selfDestruct ? `🔥 Self-destruct: ${file.originalname}` : file.originalname;
            const common = { caption, mimetype: mime, viewOnce: selfDestruct };

            if (mime.startsWith('image/')) {
                await sock.sendMessage(chatId, { image: buffer, ...common });
            } else if (mime.startsWith('video/')) {
                await sock.sendMessage(chatId, { video: buffer, ...common });
            } else if (mime.startsWith('audio/')) {
                await sock.sendMessage(chatId, { audio: buffer, mimetype: mime, viewOnce: selfDestruct });
            } else {
                await sock.sendMessage(chatId, { document: buffer, mimetype: mime, fileName: file.originalname, viewOnce: selfDestruct });
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


// ==============================
// API ROUTES
// ==============================

// Provide the Server's RSA Public Key for Client-to-Server Encryption
app.get('/api/security/key', (req, res) => {
    res.json({ publicKey });
});

// Google Drive Picker configuration
app.get('/api/gdrive/config', (req, res) => {
    const apiKey = process.env.GOOGLE_API_KEY || '';
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    if (!apiKey || !clientId) {
        return res.json({ apiKey: null, clientId: null });
    }
    res.json({ apiKey, clientId });
});

// WhatsApp session — creates/restores session by client-provided sessionId
app.post('/api/whatsapp/verify', verifyLimiter, async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId || String(sessionId).length < 5) return res.json({ valid: false });

    const sid = String(sessionId).trim();
    log('INFO', 'WhatsApp session requested', { sessionId: sid, ip: req.ip });

    // Create or restore Baileys session
    if (db) {
        const session = await createOrRestoreSession(sid);
        if (!session) {
            return res.json({ valid: true, waError: 'Could not initialize WhatsApp session. Check server logs.' });
        }
    }

    return res.json({ valid: true });
});

app.get('/api/whatsapp/config', (req, res) => {
    res.json({ restricted: false });
});

// Per-user WhatsApp status — client provides sessionId
app.get('/api/whatsapp/status', (req, res) => {
    const sid = req.query.sessionId;
    if (!sid) {
        return res.json({ ready: false, qr: null, error: 'No session ID' });
    }

    if (!db) {
        return res.json({ ready: false, qr: null });
    }

    const session = activeSessions.get(sid);
    if (!session) {
        return res.json({ ready: false, qr: null });
    }

    session.lastActivity = Date.now();
    res.json({
        ready: session.ready,
        qr: session.ready ? null : session.qr,
        pairingCode: session.ready ? null : session.pairingCode
    });
});

// Request pairing code (for mobile users who can't scan QR)
app.post('/api/whatsapp/pairing-code', async (req, res) => {
    const { sessionId, phoneNumber } = req.body || {};
    if (!sessionId || !phoneNumber) {
        return res.status(400).json({ error: 'Session ID and phone number required.' });
    }
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (cleanPhone.length < 10) {
        return res.status(400).json({ error: 'Invalid phone number.' });
    }
    const result = await requestSessionPairingCode(sessionId, cleanPhone);
    if (result.error) {
        return res.status(400).json({ error: result.error });
    }
    res.json({ pairingCode: result.pairingCode });
});

// ==============================
// TELEGRAM MTProto QR API ROUTES
// ==============================

// Init/restore Telegram QR session
app.post('/api/telegram/verify', verifyLimiter, async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId || String(sessionId).length < 5) return res.json({ valid: false });

    if (!TG_API_ID || !TG_API_HASH) {
        return res.json({ valid: false, tgClientAvailable: false });
    }

    const sid = String(sessionId).trim();
    log('INFO', 'Telegram MTProto session requested', { sessionId: sid, ip: req.ip });

    if (db) {
        const session = await createOrRestoreTelegramSession(sid);
        if (!session) {
            return res.json({ valid: true, tgClientAvailable: true, error: 'Could not initialize Telegram session.' });
        }
    }

    return res.json({ valid: true, tgClientAvailable: true });
});

// Telegram MTProto session status
app.get('/api/telegram/status', (req, res) => {
    const sid = req.query.sessionId;
    if (!sid) return res.json({ ready: false, qr: null });

    const session = tgActiveSessions.get(sid);
    if (!session) return res.json({ ready: false, qr: null });

    session.lastActivity = Date.now();
    res.json({
        ready: session.ready,
        qr: session.ready ? null : session.qr,
        error: session.error || null,
        tgClientAvailable: !!(TG_API_ID && TG_API_HASH)
    });
});

// Fetch Telegram contacts (from MTProto client session)
app.get('/api/telegram/contacts', async (req, res) => {
    const sid = req.query.sessionId;
    if (!sid) return res.json({ contacts: [] });

    const contacts = await getTelegramContacts(sid);
    res.json({ contacts });
});

// Check if Telegram MTProto client is available
app.get('/api/telegram/config', (req, res) => {
    res.json({ tgClientAvailable: !!(TG_API_ID && TG_API_HASH) });
});

// Clear Telegram MTProto session (logout)
app.post('/api/telegram/logout', async (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

    const session = tgActiveSessions.get(sessionId);
    if (session && session.client) {
        try {
            if (session._qrTimer) clearTimeout(session._qrTimer);
            await session.client.invoke(new Api.auth.LogOut());
            session.client.disconnect();
        } catch (e) { log('WARN', `TG logout error: ${e.message}`); }
    }
    tgActiveSessions.delete(sessionId);
    await clearTgSession(sessionId);
    res.json({ success: true });
});

app.delete('/api/jobs/:id', async (req, res) => {
    const jobId = req.params.id;
    const index = scheduledJobs.findIndex(j => j.id === jobId);
    if (index === -1) {
        return res.status(404).json({ error: 'Job not found or already executed' });
    }
    clearTimeout(scheduledJobs[index].timer);
    scheduledJobs.splice(index, 1);
    await removeJob(jobId);
    res.json({ success: true, message: 'Job canceled successfully' });
});

app.get('/api/users', (req, res) => {
    const users = Object.entries(userMap).map(([u, data]) => {
        const d = typeof data === 'object' ? data : { chatId: data, firstName: '' };
        return { username: `@${u}`, chatId: d.chatId, firstName: d.firstName || '' };
    });
    res.json(users);
});

// Search registered Telegram users by name or username (for contacts autocomplete)
app.get('/api/contacts/search', (req, res) => {
    const q = (req.query.q || '').toLowerCase().trim();
    const channel = req.query.channel || 'telegram';
    if (!q || q.length < 1) return res.json([]);
    
    if (channel === 'telegram') {
        const results = [];
        for (const [username, data] of Object.entries(userMap)) {
            const d = typeof data === 'object' ? data : { chatId: data, firstName: '' };
            const name = (d.firstName || '').toLowerCase();
            if (username.includes(q) || name.includes(q)) {
                results.push({ name: d.firstName || username, value: `@${username}`, channel: 'telegram' });
            }
        }
        return res.json(results.slice(0, 10));
    }
    res.json([]);
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
    const pw = req.headers['x-admin-password'] || req.body?.adminPassword || req.query?.adminPassword || '';
    if (!adminPassword) return res.status(503).json({ error: 'Admin password not configured.' });
    if (pw !== adminPassword) { log('WARN', 'Admin auth failed', { ip: req.ip }); return res.status(401).json({ error: 'Invalid admin password.' }); }
    
    // Check 2FA if enabled
    if (admin2faEnabled) {
        const token = req.headers['x-admin-2fa'] || req.body?.admin2faToken || req.query?.admin2faToken || '';
        if (!token) return res.status(403).json({ error: '2FA token required.', needs2fa: true });
        const verified = speakeasy.totp.verify({
            secret: admin2faSecret,
            encoding: 'base64',
            token: token
        });
        if (!verified) return res.status(401).json({ error: 'Invalid 2FA token.' });
    }
    
    next();
}

app.post('/api/admin/verify', (req, res) => {
    const { password } = req.body || {};
    if (!adminPassword) return res.json({ valid: false });
    if (password === adminPassword) { 
        log('INFO', 'Admin login step 1 success', { ip: req.ip }); 
        return res.json({ valid: true, needs2fa: admin2faEnabled }); 
    }
    log('WARN', 'Admin login failed', { ip: req.ip });
    return res.json({ valid: false });
});

app.post('/api/admin/verify-2fa', (req, res) => {
    const { password, token } = req.body || {};
    if (password !== adminPassword) return res.status(401).json({ valid: false });
    if (!admin2faEnabled) return res.json({ valid: true });
    
    const verified = speakeasy.totp.verify({
        secret: admin2faSecret,
        encoding: 'base64',
        token: token
    });
    if (verified) {
        log('INFO', 'Admin login 2FA success', { ip: req.ip });
        return res.json({ valid: true });
    }
    return res.json({ valid: false, error: 'Invalid 2FA token' });
});

app.get('/api/admin/analytics', adminAuth, async (req, res) => {
    if (!db) return res.json({ history: [], channels: {}, hours: [] });
    try {
        const last30Days = new Date();
        last30Days.setDate(last30Days.getDate() - 30);
        
        const history = await db.collection('transfer_logs').aggregate([
            { $match: { timestamp: { $gte: last30Days } } },
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]).toArray();
        
        const channels = await db.collection('transfer_logs').aggregate([
            { $group: { _id: "$channel", count: { $sum: 1 } } }
        ]).toArray();
        
        const hours = await db.collection('transfer_logs').aggregate([
            { $group: { _id: "$hour", count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]).toArray();
        
        res.json({ history, channels: Object.fromEntries(channels.map(c => [c._id, c.count])), hours });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/logs/export', adminAuth, (req, res) => {
    try {
        const logFile = path.join(LOG_DIR, getLogFileName());
        if (!fs.existsSync(logFile)) return res.status(404).send('No logs today.');
        
        const content = fs.readFileSync(logFile, 'utf-8');
        const csvRows = ['Timestamp,Level,Message,Metadata'];
        content.trim().split('\n').forEach(line => {
            const match = line.match(/^\[(.*?)\] \[(.*?)\] (.*?) (\{.*\}|)$/);
            if (match) {
                const [_, ts, lvl, msg, meta] = match;
                csvRows.push(`"${ts}","${lvl}","${msg.replace(/"/g, '""')}","${meta.replace(/"/g, '""')}"`);
            }
        });
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=bridge-logs-${new Date().toISOString().split('T')[0]}.csv`);
        res.send(csvRows.join('\n'));
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/admin/health', adminAuth, (req, res) => {
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    res.json({
        status: 'ok',
        memory: { used: memMB, threshold: HEALTH_MEMORY_THRESHOLD },
        db: db ? 'connected' : 'disconnected',
        whatsapp: activeSessions.size,
        uptime: process.uptime()
    });
});

app.get('/api/push/vapid-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

app.post('/api/push/subscribe', (req, res) => {
    const subscription = req.body;
    pushSubscriptions.push(subscription);
    res.status(201).json({});
});

app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
    const uptimeSec = Math.round(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);

    // Count total authenticated WA sessions from MongoDB
    let totalAuthenticated = 0;
    if (db) {
        try {
            // Each authenticated session has a 'creds' document
            totalAuthenticated = await db.collection('wa_auth').countDocuments({ _id: { $regex: /:creds$/ } });
        } catch (e) { log('ERROR', `Failed to count WA sessions: ${e.message}`); }
    }

    res.json({
        uptime: `${hours}h ${mins}m`,
        telegram: { connected: !!telegramBot, users: Object.keys(userMap).length },
        whatsapp: { activeSessions: activeSessions.size, totalAuthenticated, mongodb: !!db },
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
});

app.get('/api/admin/telegram-users', adminAuth, (req, res) => {
    const users = Object.entries(userMap).map(([u, data]) => {
        const d = typeof data === 'object' ? data : { chatId: data, firstName: '' };
        return { username: `@${u}`, chatId: d.chatId, firstName: d.firstName || '' };
    });
    res.json({ users });
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
        let textMessage = sanitizeInput(req.body.message || '');
        const encryptedAesKeyB64 = req.body.encryptedAesKey || '';
        const scheduledTime = req.body.scheduledTime || '';
        const cyclePeriod = req.body.cyclePeriod || 'none';
        const selfDestruct = req.body.selfDestruct === 'true';

        const targets = rawTargets.split(',').map(t => t.trim()).filter(Boolean);
        let totalSizeBytes = files.reduce((acc, f) => acc + f.size, 0);

        if (encryptedAesKeyB64) {
            try {
                const encryptedAesKeyBuf = Buffer.from(encryptedAesKeyB64, 'base64');
                const aesKeyBuf = crypto.privateDecrypt(
                    {
                        key: privateKey,
                        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
                        oaepHash: "sha256"
                    },
                    encryptedAesKeyBuf
                );

                if (textMessage) {
                    const msgBuf = Buffer.from(textMessage, 'base64');
                    const iv = msgBuf.subarray(0, 12);
                    const cipherText = msgBuf.subarray(12);
                    const authTag = cipherText.subarray(cipherText.length - 16);
                    const actualCipher = cipherText.subarray(0, cipherText.length - 16);
                    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKeyBuf, iv);
                    decipher.setAuthTag(authTag);
                    let decryptedMsg = decipher.update(actualCipher, undefined, 'utf8');
                    decryptedMsg += decipher.final('utf8');
                    textMessage = decryptedMsg;
                }

                // Chunked file decryption
                // Format: [4-byte chunk length][12-byte IV][ciphertext + 16-byte GCM tag] per chunk
                for (const f of files) {
                    const filePath = path.resolve(f.path);
                    const fileBuf = fs.readFileSync(filePath);
                    
                    // Detect chunked format: first 4 bytes are a length header
                    // A chunked file always starts with a 4-byte big-endian uint32
                    const possibleLen = fileBuf.readUInt32BE(0);
                    const isChunked = possibleLen > 0 && possibleLen < fileBuf.length && (possibleLen + 4) <= fileBuf.length;
                    
                    if (isChunked) {
                        // Chunked decryption
                        const decryptedChunks = [];
                        let offset = 0;
                        while (offset < fileBuf.length) {
                            if (offset + 4 > fileBuf.length) break;
                            const chunkLen = fileBuf.readUInt32BE(offset);
                            offset += 4;
                            if (offset + chunkLen > fileBuf.length) break;
                            
                            const chunkPayload = fileBuf.subarray(offset, offset + chunkLen);
                            const chunkIV = chunkPayload.subarray(0, 12);
                            const chunkCipher = chunkPayload.subarray(12);
                            const chunkAuthTag = chunkCipher.subarray(chunkCipher.length - 16);
                            const chunkActualCipher = chunkCipher.subarray(0, chunkCipher.length - 16);
                            
                            const decipher = crypto.createDecipheriv('aes-256-gcm', aesKeyBuf, chunkIV);
                            decipher.setAuthTag(chunkAuthTag);
                            decryptedChunks.push(decipher.update(chunkActualCipher));
                            decryptedChunks.push(decipher.final());
                            
                            offset += chunkLen;
                        }
                        fs.writeFileSync(filePath, Buffer.concat(decryptedChunks));
                    } else {
                        // Legacy single-shot decryption (backward compat)
                        const iv = fileBuf.subarray(0, 12);
                        const cipherText = fileBuf.subarray(12);
                        const authTag = cipherText.subarray(cipherText.length - 16);
                        const actualCipher = cipherText.subarray(0, cipherText.length - 16);
                        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKeyBuf, iv);
                        decipher.setAuthTag(authTag);
                        const decryptedBuf = Buffer.concat([decipher.update(actualCipher), decipher.final()]);
                        fs.writeFileSync(filePath, decryptedBuf);
                    }
                }
            } catch (e) {
                cleanupFiles(files);
                return res.status(400).json({ error: 'Client-to-Server Decryption failed: ' + e.message });
            }
        }

        if (targets.length === 0) { cleanupFiles(files); return res.status(400).json({ error: 'At least one recipient is required.' }); }
        if (targets.length > MAX_RECIPIENTS) { cleanupFiles(files); return res.status(400).json({ error: `Maximum ${MAX_RECIPIENTS} recipients.` }); }
        if (textMessage.length > MAX_MESSAGE_LENGTH) { cleanupFiles(files); return res.status(400).json({ error: `Message too long. Max ${MAX_MESSAGE_LENGTH} chars.` }); }
        if (files.length === 0 && !textMessage.trim()) return res.status(400).json({ error: 'Provide a file or message.' });

        const MAX_SIZE = channel === 'telegram' ? 50 * 1024 * 1024 : 100 * 1024 * 1024;
        const oversized = files.filter(f => f.size > MAX_SIZE);
        if (oversized.length > 0) { cleanupFiles(files); return res.status(400).json({ error: `${oversized.length} file(s) exceed ${channel === 'telegram' ? '50MB' : '100MB'}.` }); }

        log('INFO', 'Upload request', { channel, targets: targets.length, files: files.length, ip: requestIP });

        // ─── TELEGRAM ───
        if (channel === 'telegram') {
            const tgSessionId = req.body.tgSessionId || '';
            const tgSession = tgSessionId ? tgActiveSessions.get(tgSessionId) : null;
            const useTgClient = tgSession && tgSession.ready && tgSession.client;

            if (!useTgClient && !telegramBot) { cleanupFiles(files); return res.status(503).json({ error: 'Telegram not configured.' }); }

            if (useTgClient) {
                // ─── TELEGRAM CLIENT (MTProto) MODE ───
                log('INFO', 'Using Telegram client mode for send', { sessionId: tgSessionId });

                if (scheduledTime) {
                    // Scheduled sends still use bot for reliability (client may disconnect)
                    if (!telegramBot) {
                        cleanupFiles(files);
                        return res.status(400).json({ error: 'Scheduled sends require the bot. Please /start the bot first.' });
                    }
                    // Fall through to bot-based scheduling below
                } else {
                    let totalSent = 0, allErrors = [];
                    for (const t of targets) {
                        const r = await sendTelegramClient(tgSessionId, t, textMessage, files);
                        totalSent += r.filesSent;
                        if (r.textSent) totalSent++;
                        if (r.errors.length) { log('ERROR', `TG client errors for ${t}`, { errors: r.errors }); allErrors.push(...r.errors); }
                    }
                    cleanupFiles(files);
                    logTransfer('telegram', targets.length, files.length, totalSizeBytes);
                    
                    if (totalSent === 0 && allErrors.length > 0) {
                        return res.status(502).json({ error: `Telegram failed: ${allErrors[0]}` });
                    }
                    return res.json({ success: true, message: `${totalSent} item(s) sent to ${targets.length} recipient(s) via Telegram!` });
                }
            }

            // ─── TELEGRAM BOT MODE (fallback or no client) ───
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
                const scheduleTelegramJob = async (delayMs, currentScheduledTime, jobId) => {
                    if (delayMs < 0) return;
                    if (!jobId) jobId = Date.now().toString(36);
                    
                    const jobData = {
                        id: jobId, channel: 'telegram', targets: resolved.map(r => r.label), resolvedTargets: resolved,
                        files, textMessage, selfDestruct, scheduledFor: new Date(currentScheduledTime).toISOString(), cyclePeriod
                    };
                    await persistJob(jobData);

                    scheduledJobs.push({
                        id: jobId, targets: jobData.targets, fileCount: files.length, scheduledFor: jobData.scheduledFor,
                        timer: setTimeout(async () => {
                            for (const t of resolved) await sendTelegram(t.chatId, textMessage, files, selfDestruct);
                            scheduledJobs.splice(scheduledJobs.findIndex(j => j.id === jobId), 1);
                            
                            if (cyclePeriod !== 'none') {
                                const nextDate = new Date();
                                if (cyclePeriod === 'daily') nextDate.setDate(nextDate.getDate() + 1);
                                else if (cyclePeriod === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
                                else if (cyclePeriod === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
                                await scheduleTelegramJob(nextDate.getTime() - Date.now(), nextDate, jobId);
                            } else {
                                await removeJob(jobId);
                                cleanupFiles(files);
                            }
                        }, delayMs)
                    });
                };
                const initialDelayMs = new Date(scheduledTime).getTime() - Date.now();
                if (initialDelayMs < 0) { cleanupFiles(files); return res.status(400).json({ error: 'Scheduled time must be in the future.' }); }
                const jobId = Date.now().toString(36);
                scheduleTelegramJob(initialDelayMs, scheduledTime, jobId);
                return res.json({ success: true, scheduled: true, jobId, message: `Scheduled for ${resolved.length} recipient(s)!` });
            }

            let totalSent = 0;
            for (const t of resolved) {
                const r = await sendTelegram(t.chatId, textMessage, files, selfDestruct);
                totalSent += r.filesSent;
                if (r.errors.length) log('ERROR', `Telegram errors for ${t.label}`, { errors: r.errors });
            }
            cleanupFiles(files);
            logTransfer('telegram', resolved.length, files.length, totalSizeBytes);
            return res.json({ success: true, message: `${totalSent + (textMessage ? resolved.length : 0)} item(s) sent to ${resolved.length} recipient(s) via Telegram!` });

        // ─── EMAIL ───
        } else if (channel === 'email') {
            if (!transporter) { cleanupFiles(files); return res.status(503).json({ error: 'Email SMTP not configured.' }); }

            let totalSent = 0;
            let totalErrors = [];
            const senderName = sanitizeInput(req.body.senderName || '');
            for (const t of targets) {
                const r = await sendEmail(t, textMessage, files, senderName);
                totalSent += r.filesSent;
                if (r.errors.length) totalErrors.push(...r.errors);
            }
            cleanupFiles(files);
            
            if (totalErrors.length === targets.length && totalSent === 0 && !textMessage) {
                return res.status(500).json({ error: 'Failed to send emails: ' + totalErrors[0] });
            }
            
            logTransfer('email', targets.length, files.length, totalSizeBytes);
            return res.json({ success: true, message: `${totalSent + (textMessage ? targets.length : 0)} item(s) sent to ${targets.length} recipient(s) via Email!` });

        // ─── WHATSAPP ───
        } else if (channel === 'whatsapp') {
            // Session ID comes from the client (stored in localStorage)
            const sessionPhone = req.body.waSessionId;
            if (!sessionPhone) {
                cleanupFiles(files);
                return res.status(403).json({ error: 'No WhatsApp session. Please click the WhatsApp tab to connect.' });
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

            // Audit log
            log('INFO', 'WhatsApp send audit', {
                sender: sessionPhone.slice(-4).padStart(sessionPhone.length, '*'),
                recipients: targets.length, hasMessage: !!textMessage, fileCount: files.length, ip: requestIP
            });

            const resolved = targets.map(t => ({ label: t, chatId: formatWhatsAppNumber(t) }));

            if (scheduledTime) {
                const scheduleWAJob = (delayMs, currentScheduledTime, jobId) => {
                    if (delayMs < 0) return;
                    if (!jobId) jobId = Date.now().toString(36);
                    scheduledJobs.push({
                        id: jobId, targets: resolved.map(r => r.label), fileCount: files.length, scheduledFor: new Date(currentScheduledTime).toISOString(),
                        timer: setTimeout(async () => {
                            for (const t of resolved) await sendWhatsApp(sessionPhone, t.chatId, textMessage, files, selfDestruct);
                            scheduledJobs.splice(scheduledJobs.findIndex(j => j.id === jobId), 1);
                            if (cyclePeriod !== 'none') {
                                const nextDate = new Date();
                                if (cyclePeriod === 'daily') nextDate.setDate(nextDate.getDate() + 1);
                                else if (cyclePeriod === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
                                else if (cyclePeriod === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
                                scheduleWAJob(nextDate.getTime() - Date.now(), nextDate);
                            } else {
                                cleanupFiles(files);
                            }
                        }, delayMs)
                    });
                };
                const initialDelayMs = new Date(scheduledTime).getTime() - Date.now();
                if (initialDelayMs < 0) { cleanupFiles(files); return res.status(400).json({ error: 'Scheduled time must be in the future.' }); }
                const jobId = Date.now().toString(36);
                scheduleWAJob(initialDelayMs, scheduledTime, jobId);
                return res.json({ success: true, scheduled: true, jobId, message: `Scheduled for ${resolved.length} recipient(s)!` });
            }

            let totalSent = 0, allErrors = [];
            for (const t of resolved) {
                const r = await sendWhatsApp(sessionPhone, t.chatId, textMessage, files, selfDestruct);
                totalSent += r.filesSent;
                if (r.textSent) totalSent++;
                if (r.errors.length) { log('ERROR', `WhatsApp errors for ${t.label}`, { errors: r.errors }); allErrors.push(...r.errors); }
            }
            cleanupFiles(files);
            logTransfer('whatsapp', resolved.length, files.length, totalSizeBytes);

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
// HEALTH CHECK & KEEP-ALIVE
// ==============================
app.get('/health', (req, res) => res.status(200).send('OK'));

// Self-ping to prevent sleep on Render/Railway Free Tiers
const APP_URL = process.env.APP_URL; 
if (APP_URL) {
    const https = require('https');
    setInterval(() => {
        https.get(`${APP_URL}/health`, (res) => {
            if (res.statusCode === 200) log('DEBUG', 'Self-ping successful (Keep-Alive)');
        }).on('error', (err) => {
            log('WARN', 'Self-ping failed', { error: err.message });
        });
    }, 10 * 60 * 1000); // Ping every 10 minutes
}

// ==============================
// STARTUP
// ==============================
async function startServer() {
    await connectDB();
    await loadUserMap();
    setupVapid();
    await restoreScheduledJobs();
    await cleanupStaleUploads();

    server.listen(port, () => {
        log('INFO', `Bridge Server running at http://localhost:${port}`);
        log('INFO', `MongoDB: ${db ? 'connected' : 'file-fallback'} | Telegram: ${telegramBot ? 'active' : 'disabled'} | WA: open (QR auth)`);
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
