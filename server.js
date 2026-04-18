require('dotenv').config();
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const TelegramBot = require('node-telegram-bot-api');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;

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

    // Console output
    if (level === 'ERROR') console.error(line.trim());
    else console.log(line.trim());

    // File output
    try {
        fs.appendFileSync(path.join(LOG_DIR, getLogFileName()), line);
    } catch (e) { /* silently fail */ }
}

// Catch uncaught exceptions
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

// General API rate limit: 30 requests per minute per IP
const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a minute before trying again.' },
    handler: (req, res, next, options) => {
        log('WARN', `Rate limit exceeded`, { ip: req.ip, path: req.path });
        res.status(429).json(options.message);
    }
});

// Stricter upload limit: 10 uploads per minute per IP
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Upload limit reached. Maximum 10 transfers per minute. Please wait.' },
    handler: (req, res, next, options) => {
        log('WARN', `Upload rate limit exceeded`, { ip: req.ip });
        res.status(429).json(options.message);
    }
});

// Apply general limiter to all API routes
app.use('/api/', apiLimiter);

// ==============================
// MULTER & MIDDLEWARE
// ==============================
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB hard limit
});
app.use(express.static('public'));
app.use(express.json());

// ==============================
// USER MAP
// ==============================
const USER_MAP_FILE = path.join(__dirname, 'user-map.json');
let userMap = {};
if (fs.existsSync(USER_MAP_FILE)) {
    try { userMap = JSON.parse(fs.readFileSync(USER_MAP_FILE, 'utf-8')); } catch (e) { userMap = {}; }
    log('INFO', `Loaded ${Object.keys(userMap).length} saved Telegram user(s)`);
}
function saveUserMap() { fs.writeFileSync(USER_MAP_FILE, JSON.stringify(userMap, null, 2)); }

const scheduledJobs = [];

// WhatsApp phone whitelist
const WA_ALLOWED_FILE = path.join(__dirname, 'whatsapp-allowed.json');
let waAllowedNumbers = [];
function loadWaAllowed() {
    try {
        if (fs.existsSync(WA_ALLOWED_FILE)) {
            waAllowedNumbers = JSON.parse(fs.readFileSync(WA_ALLOWED_FILE, 'utf-8'));
            // Normalize: strip +, spaces, dashes
            waAllowedNumbers = waAllowedNumbers.map(n => String(n).replace(/[^\d]/g, ''));
            log('INFO', `WhatsApp whitelist loaded: ${waAllowedNumbers.length} number(s) authorized`);
        } else {
            log('WARN', 'whatsapp-allowed.json not found — WhatsApp is open to all users');
        }
    } catch (e) {
        log('ERROR', `Failed to load WhatsApp whitelist: ${e.message}`);
    }
}
loadWaAllowed();

function isWaAllowed(phone) {
    if (waAllowedNumbers.length === 0) return true; // No whitelist = open access
    const normalized = String(phone).replace(/[^\d]/g, '');
    return waAllowedNumbers.includes(normalized);
}

// ==============================
// TELEGRAM BOT
// ==============================
const telegramToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
let telegramBot = null;

if (telegramToken && telegramToken !== 'YOUR_BOT_TOKEN_HERE') {
    telegramBot = new TelegramBot(telegramToken, { polling: true });
    telegramBot.getMe().then((info) => {
        log('INFO', `Telegram Bot connected: @${info.username}`);
    }).catch((err) => {
        log('ERROR', `Telegram Bot Token invalid: ${err.message}`);
        telegramBot = null;
    });

    telegramBot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from.username;
        const firstName = msg.from.first_name || 'there';
        if (username) {
            userMap[username.toLowerCase()] = chatId;
            saveUserMap();
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
// WHATSAPP CLIENT
// ==============================
let whatsappClient = null;
let whatsappReady = false;
let whatsappQR = null;

try {
    whatsappClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: { args: ['--no-sandbox'] }
    });
    whatsappClient.on('qr', async (qr) => {
        try {
            whatsappQR = await qrcode.toDataURL(qr, { margin: 2, scale: 8 });
            log('INFO', 'WhatsApp QR generated');
        } catch (e) { log('ERROR', `QR generation error: ${e.message}`); }
    });
    whatsappClient.on('ready', () => { log('INFO', 'WhatsApp connected and ready'); whatsappReady = true; whatsappQR = null; });
    whatsappClient.on('authenticated', () => { log('INFO', 'WhatsApp authenticated'); });
    whatsappClient.on('auth_failure', () => { log('ERROR', 'WhatsApp auth failed'); whatsappReady = false; });
    whatsappClient.on('disconnected', () => { log('WARN', 'WhatsApp disconnected'); whatsappReady = false; });
    whatsappClient.initialize();
} catch (e) {
    log('ERROR', `WhatsApp client could not start: ${e.message}`);
}

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
    return num + '@c.us';
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

async function sendWhatsApp(chatId, text, files) {
    const results = { textSent: false, filesSent: 0, errors: [] };
    if (text) {
        try { await whatsappClient.sendMessage(chatId, text); results.textSent = true; }
        catch (e) { results.errors.push(`Text: ${e.message}`); }
    }
    for (const file of files) {
        try {
            const media = MessageMedia.fromFilePath(path.resolve(file.path));
            media.filename = file.originalname;
            await whatsappClient.sendMessage(chatId, media);
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

// Cleanup stale uploads on startup (in case of crash)
try {
    const uploadsDir = path.join(__dirname, 'uploads');
    if (fs.existsSync(uploadsDir)) {
        const staleFiles = fs.readdirSync(uploadsDir);
        if (staleFiles.length > 0) {
            staleFiles.forEach(f => fs.unlinkSync(path.join(uploadsDir, f)));
            log('INFO', `Cleaned up ${staleFiles.length} stale upload(s) from previous session`);
        }
    }
} catch (e) { /* ignore */ }

// ==============================
// API ROUTES
// ==============================

// WhatsApp phone number verification
app.post('/api/whatsapp/verify', (req, res) => {
    const { phone } = req.body || {};
    if (waAllowedNumbers.length === 0) return res.json({ valid: true }); // No whitelist = open
    if (phone && isWaAllowed(phone)) {
        log('INFO', 'WhatsApp access granted', { phone: phone.slice(-4).padStart(phone.length, '*'), ip: req.ip });
        return res.json({ valid: true });
    }
    log('WARN', 'WhatsApp access denied (number not whitelisted)', { ip: req.ip });
    return res.json({ valid: false });
});

// Check if WhatsApp requires verification
app.get('/api/whatsapp/config', (req, res) => {
    res.json({ restricted: waAllowedNumbers.length > 0 });
});

app.get('/api/whatsapp/status', (req, res) => {
    res.json({ ready: whatsappReady, qr: whatsappReady ? null : whatsappQR });
});

app.get('/api/users', (req, res) => {
    const users = Object.entries(userMap).map(([u, c]) => ({ username: `@${u}`, chatId: c }));
    res.json(users);
});

app.get('/api/scheduled', (req, res) => {
    res.json(scheduledJobs.map(j => ({ id: j.id, targets: j.targets, fileCount: j.fileCount, scheduledFor: j.scheduledFor })));
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.round(process.uptime()),
        telegram: !!telegramBot,
        whatsapp: whatsappReady,
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
    if (pw !== adminPassword) {
        log('WARN', 'Admin auth failed', { ip: req.ip });
        return res.status(401).json({ error: 'Invalid admin password.' });
    }
    next();
}

// Verify admin password
app.post('/api/admin/verify', (req, res) => {
    const { password } = req.body || {};
    if (!adminPassword) return res.json({ valid: false });
    if (password === adminPassword) {
        log('INFO', 'Admin login successful', { ip: req.ip });
        return res.json({ valid: true });
    }
    log('WARN', 'Admin login failed', { ip: req.ip });
    return res.json({ valid: false });
});

// Dashboard data
app.get('/api/admin/dashboard', adminAuth, (req, res) => {
    const uptimeSec = Math.round(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);

    res.json({
        uptime: `${hours}h ${mins}m`,
        telegram: { connected: !!telegramBot, users: Object.keys(userMap).length },
        whatsapp: { connected: whatsappReady, allowedNumbers: waAllowedNumbers.length },
        scheduledJobs: scheduledJobs.length,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
});

// Get WhatsApp whitelist
app.get('/api/admin/whitelist', adminAuth, (req, res) => {
    res.json({ numbers: waAllowedNumbers });
});

// Add number to whitelist
app.post('/api/admin/whitelist/add', adminAuth, (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Phone number required.' });
    const normalized = String(phone).replace(/[^\d]/g, '');
    if (normalized.length < 8) return res.status(400).json({ error: 'Invalid phone number.' });
    if (waAllowedNumbers.includes(normalized)) return res.json({ success: true, message: 'Already whitelisted.' });

    waAllowedNumbers.push(normalized);
    fs.writeFileSync(WA_ALLOWED_FILE, JSON.stringify(waAllowedNumbers, null, 2));
    log('INFO', `Admin added ${normalized} to WhatsApp whitelist`);
    res.json({ success: true, message: `${normalized} added.` });
});

// Remove number from whitelist
app.post('/api/admin/whitelist/remove', adminAuth, (req, res) => {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Phone number required.' });
    const normalized = String(phone).replace(/[^\d]/g, '');
    const index = waAllowedNumbers.indexOf(normalized);
    if (index === -1) return res.status(404).json({ error: 'Number not found in whitelist.' });

    waAllowedNumbers.splice(index, 1);
    fs.writeFileSync(WA_ALLOWED_FILE, JSON.stringify(waAllowedNumbers, null, 2));
    log('INFO', `Admin removed ${normalized} from WhatsApp whitelist`);
    res.json({ success: true, message: `${normalized} removed.` });
});

// Get Telegram users
app.get('/api/admin/telegram-users', adminAuth, (req, res) => {
    const users = Object.entries(userMap).map(([u, c]) => ({ username: `@${u}`, chatId: c }));
    res.json({ users });
});

// Get scheduled jobs
app.get('/api/admin/scheduled', adminAuth, (req, res) => {
    res.json({ jobs: scheduledJobs.map(j => ({ id: j.id, targets: j.targets, fileCount: j.fileCount, scheduledFor: j.scheduledFor })) });
});

// Get recent logs
app.get('/api/admin/logs', adminAuth, (req, res) => {
    try {
        const logFile = path.join(LOG_DIR, getLogFileName());
        if (!fs.existsSync(logFile)) return res.json({ logs: [] });
        const content = fs.readFileSync(logFile, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean).slice(-50).reverse();
        res.json({ logs: lines });
    } catch (e) {
        res.json({ logs: [] });
    }
});

// UPLOAD — with stricter rate limit
app.post('/api/upload', uploadLimiter, upload.array('files', 10), async (req, res) => {
    const channel = req.body.channel || 'telegram';
    const requestIP = req.ip;

    try {
        const files = req.files || [];
        const rawTargets = req.body.chatId || '';
        const textMessage = req.body.message || '';
        const scheduledTime = req.body.scheduledTime || '';

        const targets = rawTargets.split(',').map(t => t.trim()).filter(Boolean);

        if (targets.length === 0) {
            cleanupFiles(files);
            return res.status(400).json({ error: 'At least one recipient is required.' });
        }
        if (files.length === 0 && !textMessage.trim()) {
            return res.status(400).json({ error: 'Provide at least a file or a message.' });
        }

        // File size validation (belt + suspenders)
        const MAX_SIZE = 50 * 1024 * 1024;
        const oversized = files.filter(f => f.size > MAX_SIZE);
        if (oversized.length > 0) {
            cleanupFiles(files);
            return res.status(400).json({ error: `${oversized.length} file(s) exceed 50MB.` });
        }

        log('INFO', `Upload request`, {
            channel, targets: targets.length, files: files.length,
            totalSize: files.reduce((s, f) => s + f.size, 0),
            ip: requestIP, scheduled: !!scheduledTime
        });

        if (channel === 'telegram') {
            if (!telegramBot) { cleanupFiles(files); return res.status(503).json({ error: 'Telegram Bot not configured.' }); }

            const resolved = [];
            const notFound = [];
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
                log('INFO', `Scheduled Telegram job ${jobId} for ${new Date(scheduledTime).toISOString()}`);
                scheduledJobs.push({
                    id: jobId, targets: resolved.map(r => r.label), fileCount: files.length, scheduledFor: new Date(scheduledTime).toISOString(),
                    timer: setTimeout(async () => {
                        log('INFO', `Executing scheduled job ${jobId}`);
                        for (const t of resolved) await sendTelegram(t.chatId, textMessage, files);
                        cleanupFiles(files);
                        scheduledJobs.splice(scheduledJobs.findIndex(j => j.id === jobId), 1);
                    }, delayMs)
                });
                return res.json({ success: true, scheduled: true, message: `Scheduled for ${resolved.length} recipient(s)!`, filesSent: 0, totalFiles: files.length });
            }

            let totalSent = 0;
            for (const t of resolved) {
                const r = await sendTelegram(t.chatId, textMessage, files);
                totalSent += r.filesSent;
                if (r.errors.length) log('ERROR', `Telegram send errors for ${t.label}`, { errors: r.errors });
            }
            cleanupFiles(files);
            log('INFO', `Telegram delivery complete`, { recipients: resolved.length, filesSent: totalSent });
            return res.json({ success: true, message: `${totalSent + (textMessage ? resolved.length : 0)} item(s) sent to ${resolved.length} recipient(s)!`, filesSent: totalSent });

        } else if (channel === 'whatsapp') {
            if (!whatsappReady) { cleanupFiles(files); return res.status(503).json({ error: 'WhatsApp not connected. Scan the QR code first.' }); }

            // Verify user is whitelisted
            const verifyPhone = req.body.waVerifiedPhone || '';
            if (waAllowedNumbers.length > 0 && !isWaAllowed(verifyPhone)) {
                cleanupFiles(files);
                log('WARN', 'WhatsApp upload rejected (number not whitelisted)', { ip: requestIP });
                return res.status(403).json({ error: 'Your number is not authorized for WhatsApp.' });
            }

            const resolved = targets.map(t => ({ label: t, chatId: formatWhatsAppNumber(t) }));

            if (scheduledTime) {
                const delayMs = new Date(scheduledTime).getTime() - Date.now();
                if (delayMs < 0) { cleanupFiles(files); return res.status(400).json({ error: 'Scheduled time must be in the future.' }); }
                const jobId = Date.now().toString(36);
                log('INFO', `Scheduled WhatsApp job ${jobId} for ${new Date(scheduledTime).toISOString()}`);
                scheduledJobs.push({
                    id: jobId, targets: resolved.map(r => r.label), fileCount: files.length, scheduledFor: new Date(scheduledTime).toISOString(),
                    timer: setTimeout(async () => {
                        log('INFO', `Executing scheduled job ${jobId}`);
                        for (const t of resolved) await sendWhatsApp(t.chatId, textMessage, files);
                        cleanupFiles(files);
                        scheduledJobs.splice(scheduledJobs.findIndex(j => j.id === jobId), 1);
                    }, delayMs)
                });
                return res.json({ success: true, scheduled: true, message: `Scheduled for ${resolved.length} recipient(s)!`, filesSent: 0, totalFiles: files.length });
            }

            let totalSent = 0;
            for (const t of resolved) {
                const r = await sendWhatsApp(t.chatId, textMessage, files);
                totalSent += r.filesSent;
                if (r.errors.length) log('ERROR', `WhatsApp send errors for ${t.label}`, { errors: r.errors });
            }
            cleanupFiles(files);
            log('INFO', `WhatsApp delivery complete`, { recipients: resolved.length, filesSent: totalSent });
            return res.json({ success: true, message: `${totalSent + (textMessage ? resolved.length : 0)} item(s) sent via WhatsApp!`, filesSent: totalSent });
        }

    } catch (error) {
        log('ERROR', `Upload failed: ${error.message}`, { stack: error.stack });
        if (req.files) cleanupFiles(req.files);
        res.status(500).json({ error: `Failed: ${error.message}` });
    }
});

app.listen(port, () => {
    log('INFO', `Bridge Server running at http://localhost:${port}`);
});
