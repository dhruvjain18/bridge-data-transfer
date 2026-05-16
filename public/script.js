const socket = typeof io !== 'undefined' ? io() : { emit: ()=>{}, on: ()=>{} };

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const chatIdInput = document.getElementById('chatId');
const waPhoneInput = document.getElementById('waPhone');
const messageInput = document.getElementById('message');
const statusDiv = document.getElementById('status');
const fileListDiv = document.getElementById('file-list');
const sendBtn = document.getElementById('send-btn');
const sendBtnText = document.getElementById('send-btn-text');
const onboarding = document.getElementById('onboarding');
const dismissBtn = document.getElementById('dismiss-btn');
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const previewModal = document.getElementById('preview-modal');
const previewModalClose = document.getElementById('preview-modal-close');
const previewImage = document.getElementById('preview-image');
const helpFab = document.getElementById('help-fab');
const helpFabIcon = document.getElementById('help-fab-icon');
const helpChat = document.getElementById('help-chat');
const helpChatClose = document.getElementById('help-chat-close');
const historyFab = document.getElementById('history-fab');
const historyPanel = document.getElementById('history-panel');
const historyClose = document.getElementById('history-close');
const historyClear = document.getElementById('history-clear');
const historyBody = document.getElementById('history-body');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const scheduleToggle = document.getElementById('schedule-toggle');
const schedulePicker = document.getElementById('schedule-picker');
const scheduleTime = document.getElementById('schedule-time');
const scheduleCancel = document.getElementById('schedule-cancel');
const btnTelegram = document.getElementById('btn-telegram');
const btnWhatsapp = document.getElementById('btn-whatsapp');
const btnEmail = document.getElementById('btn-email');
const telegramInputDiv = document.getElementById('telegram-input');
const whatsappInputDiv = document.getElementById('whatsapp-input');
const emailInputDiv = document.getElementById('email-input');
const emailToInput = document.getElementById('emailTo');
const waQrOverlay = document.getElementById('wa-qr-overlay');
const waQrImage = document.getElementById('wa-qr-image');
const waQrLoading = document.getElementById('wa-qr-loading');
const countryBtn = document.getElementById('country-btn');
const countryFlag = document.getElementById('country-flag');
const countryCodeEl = document.getElementById('country-code');
const countryDropdown = document.getElementById('country-dropdown');
const phoneHint = document.getElementById('phone-hint');
const mainContent = document.getElementById('main-content');
const dropZoneText = document.getElementById('drop-zone-text');
const langToggle = document.getElementById('lang-toggle');
const langDropdown = document.getElementById('lang-dropdown');
const folderInput = document.getElementById('folder-input');
const offlineIndicator = document.getElementById('offline-indicator');
const admin2faSection = document.getElementById('admin-2fa-section');
const admin2faToken = document.getElementById('admin-2fa-token');
const admin2faVerifyBtn = document.getElementById('admin-2fa-verify-btn');
const adminDownloadLogsBtn = document.getElementById('admin-download-logs');
const admin2faSetupSection = document.getElementById('admin-2fa-setup-section');
const admin2faQrContainer = document.getElementById('admin-2fa-qr-container');
const admin2faQr = document.getElementById('admin-2fa-qr');
const admin2faStatus = document.getElementById('admin-2fa-status');
const previewContent = document.getElementById('preview-content');
const previewInfo = document.getElementById('preview-info');
const previewPrev = document.getElementById('preview-prev');
const previewNext = document.getElementById('preview-next');

let MAX_FILE_SIZE = 50 * 1024 * 1024;
let selectedFiles = [];
let activeChannel = 'telegram';
let waPollingInterval = null;
let waAccessVerified = false;
let verifiedPhone = '';

const channelState = {
    telegram: { message: '', files: [] },
    whatsapp: { message: '', files: [] },
    email: { message: '', files: [] }
};

let currentLanguage = localStorage.getItem('bridge_lang') || 'en';
let i18nData = {};
let currentPreviewIndex = 0;
let offlineQueue = JSON.parse(localStorage.getItem('bridge_offline_queue') || '[]');

// ==============================
// i18n: MULTI-LANGUAGE
// ==============================
async function initI18n() {
    try {
        const res = await fetch(`/i18n/${currentLanguage}.json`);
        i18nData = await res.json();
        applyI18n();
    } catch (e) { console.error('i18n load failed', e); }
}

function t(key, params = {}) {
    let str = i18nData[key] || key;
    for (const [k, v] of Object.entries(params)) {
        str = str.replace(`{${k}}`, v);
    }
    return str;
}

function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        el.innerHTML = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.placeholder = t(key);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        el.title = t(key);
    });

    // Highlight the active language
    document.querySelectorAll('[data-lang]').forEach(btn => {
        if (btn.getAttribute('data-lang') === currentLanguage) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Update dynamic text
    if (dropZoneText) dropZoneText.innerHTML = t('drop_subtitle', { size: activeChannel === 'telegram' ? 50 : 100 });
}

async function switchLanguage(lang) {
    currentLanguage = lang;
    localStorage.setItem('bridge_lang', lang);
    await initI18n();
    langDropdown.classList.add('hidden');
}

// ==============================
// TOAST NOTIFICATION
// ==============================
function showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.cssText = `
        padding:12px 20px;border-radius:10px;color:#fff;font-size:14px;font-weight:500;
        max-width:350px;box-shadow:0 8px 24px rgba(0,0,0,0.3);backdrop-filter:blur(12px);
        animation:slideInRight 0.3s ease;cursor:pointer;
        background:${type === 'error' ? 'rgba(220,38,38,0.9)' : type === 'info' ? 'rgba(59,130,246,0.9)' : 'rgba(34,197,94,0.9)'};
    `;
    toast.textContent = message;
    toast.onclick = () => toast.remove();
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 4000);
}

// Alias for clipboard paste handler
function handleFiles(files) { addFiles(files); }

// ==============================
// WHATSAPP SESSION INIT (QR scan = authentication)
// ==============================
async function initWhatsAppSession() {
    if (waAccessVerified) { startWaPolling(); return; }

    // Use a stored session ID or generate one
    let sessionPhone = localStorage.getItem('bridge_wa_session_phone');
    if (!sessionPhone) {
        sessionPhone = 'wa_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        localStorage.setItem('bridge_wa_session_phone', sessionPhone);
    }
    verifiedPhone = sessionPhone;

    try {
        const res = await fetch('/api/whatsapp/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionPhone })
        });
        const data = await res.json();
        if (data.valid) {
            waAccessVerified = true;
            startWaPolling();
        }
    } catch (e) {
        console.error('Failed to init WhatsApp session', e);
    }
}

// ==============================
// COUNTRY DATA
// ==============================
// ==============================
// CLIPBOARD PASTE
// ==============================
document.addEventListener('paste', async (e) => {
    const items = e.clipboardData.items;
    let pastedFiles = [];
    for (const item of items) {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) pastedFiles.push(file);
        }
    }
    if (pastedFiles.length > 0) {
        handleFiles(pastedFiles);
        dropZone.classList.add('paste-flash');
        setTimeout(() => dropZone.classList.remove('paste-flash'), 500);
        showToast(t('toast_paste', { count: pastedFiles.length }));
    }
});

// ==============================
// IMAGE COMPRESSION (Client-side)
// ==============================
async function compressImage(file) {
    return file; // Feature removed
}


// ==============================
// FOLDER UPLOAD (JSZip)
// ==============================
async function handleFolder(files) {
    if (files.length === 0) return;
    showToast(t('toast_folder_zipping') || 'Zipping folder...', 'info');

    try {
        if (typeof JSZip === 'undefined') throw new Error("JSZip library is not loaded.");
        const zip = new JSZip();
        const firstPath = files[0].webkitRelativePath;
        const folderName = (firstPath ? firstPath.split('/')[0] : 'folder') || 'folder';

        for (const file of files) {
            const path = file.webkitRelativePath || file.name;
            zip.file(path, file);
        }

        const content = await zip.generateAsync({ type: 'blob' });
        const zipFile = new File([content], `${folderName}.zip`, { type: 'application/zip' });
        handleFiles([zipFile]);
        showToast('Folder zipped successfully!', 'success');
    } catch (e) {
        console.error('Folder zipping failed:', e);
        showToast(`Failed to zip: ${e.message}`, 'error');
    } finally {
        if (folderInput) folderInput.value = '';
    }
}

// ==============================
// FILE TYPE ICONS
// ==============================
function getFileIcon(filename, mimetype) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
    if (ext === 'pdf') return '📄';
    if (['doc', 'docx'].includes(ext)) return '📝';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
    if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return '🎬';
    if (['mp3', 'wav', 'ogg'].includes(ext)) return '🎵';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '📦';
    if (['js', 'py', 'java', 'html', 'css', 'json', 'cpp', 'c', 'php'].includes(ext)) return '💻';
    return '📄';
}

function getIconClass(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return '';
    if (ext === 'pdf') return 'icon-pdf';
    if (['doc', 'docx'].includes(ext)) return 'icon-doc';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return 'icon-xls';
    if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return 'icon-video';
    if (['mp3', 'wav', 'ogg'].includes(ext)) return 'icon-audio';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'icon-zip';
    if (['js', 'py', 'java', 'html', 'css', 'json', 'cpp', 'c', 'php'].includes(ext)) return 'icon-code';
    return '';
}
const countries = [
    { name: 'India', code: '+91', flag: '🇮🇳', digits: 10 },
    { name: 'United States', code: '+1', flag: '🇺🇸', digits: 10 },
    { name: 'United Kingdom', code: '+44', flag: '🇬🇧', digits: 10 },
    { name: 'Canada', code: '+1', flag: '🇨🇦', digits: 10 },
    { name: 'Australia', code: '+61', flag: '🇦🇺', digits: 9 },
    { name: 'Germany', code: '+49', flag: '🇩🇪', digits: 11 },
    { name: 'France', code: '+33', flag: '🇫🇷', digits: 9 },
    { name: 'Brazil', code: '+55', flag: '🇧🇷', digits: 11 },
    { name: 'Japan', code: '+81', flag: '🇯🇵', digits: 10 },
    { name: 'South Korea', code: '+82', flag: '🇰🇷', digits: 10 },
    { name: 'UAE', code: '+971', flag: '🇦🇪', digits: 9 },
    { name: 'Saudi Arabia', code: '+966', flag: '🇸🇦', digits: 9 },
    { name: 'Singapore', code: '+65', flag: '🇸🇬', digits: 8 },
    { name: 'China', code: '+86', flag: '🇨🇳', digits: 11 },
    { name: 'Pakistan', code: '+92', flag: '🇵🇰', digits: 10 },
    { name: 'Bangladesh', code: '+880', flag: '🇧🇩', digits: 10 },
    { name: 'Nigeria', code: '+234', flag: '🇳🇬', digits: 10 },
    { name: 'South Africa', code: '+27', flag: '🇿🇦', digits: 9 },
    { name: 'Russia', code: '+7', flag: '🇷🇺', digits: 10 },
    { name: 'Mexico', code: '+52', flag: '🇲🇽', digits: 10 },
    { name: 'Indonesia', code: '+62', flag: '🇮🇩', digits: 11 },
    { name: 'Italy', code: '+39', flag: '🇮🇹', digits: 10 },
    { name: 'Spain', code: '+34', flag: '🇪🇸', digits: 9 },
    { name: 'Nepal', code: '+977', flag: '🇳🇵', digits: 10 },
    { name: 'Sri Lanka', code: '+94', flag: '🇱🇰', digits: 9 },
];

let selectedCountry = countries[0];

function initCountryDropdown() {
    countryDropdown.innerHTML = '';
    countries.forEach((c, i) => {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = 'country-option';
        opt.innerHTML = `<span class="co-flag">${c.flag}</span><span class="co-name">${c.name}</span><span class="co-code">${c.code}</span>`;
        opt.addEventListener('click', () => selectCountry(i));
        countryDropdown.appendChild(opt);
    });
}

function selectCountry(index) {
    selectedCountry = countries[index];
    countryFlag.textContent = selectedCountry.flag;
    countryCodeEl.textContent = selectedCountry.code;
    countryDropdown.classList.add('hidden');
    waPhoneInput.placeholder = '0'.repeat(selectedCountry.digits) + ', ...';
    validatePhone();
}

countryBtn.addEventListener('click', (e) => { e.stopPropagation(); countryDropdown.classList.toggle('hidden'); });
document.addEventListener('click', () => countryDropdown.classList.add('hidden'));

function validatePhone() {
    const rawPhones = waPhoneInput.value.split(',').map(s => s.trim()).filter(Boolean);
    if (rawPhones.length === 0) { phoneHint.textContent = ''; phoneHint.className = 'phone-hint'; return false; }

    if (rawPhones.length === 1) {
        const val = rawPhones[0].replace(/\D/g, '');
        if (val.length === selectedCountry.digits) {
            phoneHint.textContent = `✓ Valid ${selectedCountry.name} number`;
            phoneHint.className = 'phone-hint valid';
            return true;
        } else {
            phoneHint.textContent = `Enter ${selectedCountry.digits} digits (currently ${val.length})`;
            phoneHint.className = 'phone-hint invalid';
            return false;
        }
    } else {
        // Multiple numbers entered
        phoneHint.textContent = `Multiple numbers detected (${rawPhones.length})`;
        phoneHint.className = 'phone-hint valid';
        return true;
    }
}

waPhoneInput.addEventListener('input', () => {
    waPhoneInput.value = waPhoneInput.value.replace(/[^0-9,\s]/g, '');
    validatePhone();
});

initCountryDropdown();

// ==============================
// SOUND
// ==============================
function playWhoosh() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.4);
    } catch (e) { }
}

// ==============================
// THEME
// ==============================
function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
    localStorage.setItem('bridge_theme', theme);
}
themeToggle.addEventListener('click', () => {
    setTheme((document.documentElement.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark');
});
setTheme(localStorage.getItem('bridge_theme') || 'dark');

// XSS Protection
function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ==============================
// CHANNEL
// ==============================
function setChannel(channel) {
    // Save current state before switching
    channelState[activeChannel].message = messageInput.value;
    channelState[activeChannel].files = [...selectedFiles];

    activeChannel = channel;
    document.body.setAttribute('data-active-channel', channel);
    btnTelegram.classList.toggle('active', channel === 'telegram');
    btnWhatsapp.classList.toggle('active', channel === 'whatsapp');
    btnEmail.classList.toggle('active', channel === 'email');

    telegramInputDiv.classList.toggle('hidden', channel !== 'telegram');
    whatsappInputDiv.classList.toggle('hidden', channel !== 'whatsapp');
    emailInputDiv.classList.toggle('hidden', channel !== 'email');

    // Restore state for the new channel
    messageInput.value = channelState[activeChannel].message;
    selectedFiles = [...channelState[activeChannel].files];

    if (channel === 'whatsapp') {
        mainContent.classList.remove('hidden');
        initWhatsAppSession();
        startWaPolling();
        MAX_FILE_SIZE = 100 * 1024 * 1024;
        dropZoneText.textContent = 'or click to browse · max 100 MB · up to 10 files';
        // Hide Telegram QR if visible
        if (tgQrOverlay) tgQrOverlay.classList.add('hidden');
    } else if (channel === 'telegram') {
        mainContent.classList.remove('hidden');
        stopWaPolling();
        // Restore Telegram mode UI (QR or Bot) without re-initializing
        setTgMode(tgMode || 'qr');
    } else {
        mainContent.classList.remove('hidden');
        stopWaPolling();
        MAX_FILE_SIZE = 50 * 1024 * 1024;
        dropZoneText.textContent = 'or click to browse · max 50 MB · up to 10 files';
        // Hide both QR overlays
        if (tgQrOverlay) tgQrOverlay.classList.add('hidden');
    }
    renderFileList();
    updateSendButton();
}
btnTelegram.addEventListener('click', () => setChannel('telegram'));
btnWhatsapp.addEventListener('click', () => setChannel('whatsapp'));
btnEmail.addEventListener('click', () => setChannel('email'));

// ==============================
// WHATSAPP QR
// ==============================
function startWaPolling() { 
    const sid = localStorage.getItem('bridge_wa_session_phone') || '';
    if (sid) socket.emit('join_wa_session', sid);
    checkWaStatus(); 
}
function stopWaPolling() { }
let waWasConnected = false;

const topToast = document.getElementById('top-toast');
let topToastTimer = null;
function showTopToast(text, type = 'success', duration = 4000) {
    clearTimeout(topToastTimer);
    topToast.textContent = text;
    topToast.className = `top-toast ${type}`;
    topToastTimer = setTimeout(() => {
        topToast.classList.add('hiding');
        setTimeout(() => topToast.classList.add('hidden'), 300);
    }, duration);
}

socket.on('wa_status_update', (data) => {
    if (data.ready) {
        waQrOverlay.classList.add('hidden');
        if (!waWasConnected) {
            waWasConnected = true;
            showTopToast('✅ WhatsApp connected — ready to send!');
        }
    } else {
        waWasConnected = false;
        waQrOverlay.classList.remove('hidden');
        if (data.qr) { waQrImage.src = data.qr; waQrImage.classList.remove('hidden'); waQrLoading.classList.add('hidden'); }
        else { waQrImage.classList.add('hidden'); waQrLoading.classList.remove('hidden'); }
    }
});

socket.on('admin_dashboard_update', () => {
    const adminContent = document.getElementById('admin-content');
    if (adminContent && !adminContent.classList.contains('hidden')) {
        loadAdminData();
    }
});

async function checkWaStatus() {
    try {
        const sid = localStorage.getItem('bridge_wa_session_phone') || '';
        const res = await fetch(`/api/whatsapp/status?sessionId=${encodeURIComponent(sid)}`);
        const data = await res.json();
        if (data.ready) {
            waQrOverlay.classList.add('hidden');
            if (!waWasConnected) {
                waWasConnected = true;
                showTopToast('✅ WhatsApp connected — ready to send!');
            }
        } else {
            waWasConnected = false;
            waQrOverlay.classList.remove('hidden');
            if (data.qr) { waQrImage.src = data.qr; waQrImage.classList.remove('hidden'); waQrLoading.classList.add('hidden'); }
            else { waQrImage.classList.add('hidden'); waQrLoading.classList.remove('hidden'); }
        }
    } catch (e) { }
}

// ==============================
// WHATSAPP PAIRING CODE (for mobile)
// ==============================
const waPairingLink = document.getElementById('wa-pairing-link');
const waPairingSection = document.getElementById('wa-pairing-section');
const waPairingPhone = document.getElementById('wa-pairing-phone');
const waPairingSubmit = document.getElementById('wa-pairing-submit');
const waPairingCodeDiv = document.getElementById('wa-pairing-code');
const waPairingDigits = document.getElementById('wa-pairing-digits');
const waPairingError = document.getElementById('wa-pairing-error');
const waQrBox = document.getElementById('wa-qr-box');

waPairingLink.addEventListener('click', () => {
    const isActive = waPairingLink.classList.toggle('active');
    waPairingSection.classList.toggle('hidden', !isActive);
    waQrBox.classList.toggle('hidden', isActive);
    if (isActive) {
        waPairingLink.textContent = '📷 Show QR code instead';
    } else {
        waPairingLink.textContent = '📱 Can\'t scan? Use pairing code';
        waPairingCodeDiv.classList.add('hidden');
        waPairingError.classList.add('hidden');
    }
});

waPairingSubmit.addEventListener('click', async () => {
    const phone = waPairingPhone.value.trim().replace(/\D/g, '');
    if (phone.length < 10) {
        waPairingError.textContent = 'Please enter a valid phone number with country code (e.g. 919876543210)';
        waPairingError.classList.remove('hidden');
        return;
    }
    waPairingSubmit.disabled = true;
    waPairingSubmit.textContent = 'Connecting...';
    waPairingError.classList.add('hidden');
    waPairingCodeDiv.classList.add('hidden');
    try {
        const sid = localStorage.getItem('bridge_wa_session_phone') || '';
        const res = await fetch('/api/whatsapp/pairing-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, phoneNumber: phone })
        });
        const data = await res.json();
        if (data.pairingCode) {
            displayPairingCode(data.pairingCode);
        } else {
            waPairingError.textContent = data.error || 'Failed to get pairing code';
            waPairingError.classList.remove('hidden');
        }
    } catch (e) {
        console.error('Pairing code error:', e);
        waPairingError.textContent = 'Connection failed: ' + (e.message || 'Please check server is running and try again.');
        waPairingError.classList.remove('hidden');
    }
    waPairingSubmit.disabled = false;
    waPairingSubmit.textContent = 'Get Code';
});

function displayPairingCode(code) {
    waPairingDigits.innerHTML = '';
    const chars = code.split('');
    chars.forEach((ch, i) => {
        if (i === 4) {
            const sep = document.createElement('div');
            sep.className = 'wa-pairing-digit separator';
            sep.textContent = '-';
            waPairingDigits.appendChild(sep);
        }
        const digit = document.createElement('div');
        digit.className = 'wa-pairing-digit';
        digit.textContent = ch;
        digit.style.animationDelay = `${i * 0.05}s`;
        waPairingDigits.appendChild(digit);
    });
    waPairingCodeDiv.classList.remove('hidden');
}

// ==============================
// HELP / HISTORY
// ==============================
helpFab.addEventListener('click', () => {
    helpChat.classList.toggle('hidden'); helpFab.classList.toggle('active');
    helpFabIcon.textContent = helpChat.classList.contains('hidden') ? '?' : '✕';
});
helpChatClose.addEventListener('click', () => { helpChat.classList.add('hidden'); helpFab.classList.remove('active'); helpFabIcon.textContent = '?'; });
historyFab.addEventListener('click', () => { historyPanel.classList.toggle('hidden'); historyFab.classList.toggle('active'); renderHistory(); });
historyClose.addEventListener('click', () => { historyPanel.classList.add('hidden'); historyFab.classList.remove('active'); });
historyClear.addEventListener('click', () => {
    const h = getHistory();
    const now = new Date();
    // Keep only jobs that are scheduled for the future and haven't been canceled
    const activeJobs = h.filter(i => i.scheduled && !i.canceled && i.scheduledTime && new Date(i.scheduledTime) > now);
    saveHistory(activeJobs);
    renderHistory();
    if (h.length > activeJobs.length) {
        showStatus('History cleared (active jobs preserved).', 'success');
    }
});

function getHistory() { try { return JSON.parse(localStorage.getItem('bridge_history') || '[]'); } catch { return []; } }
function saveHistory(h) { localStorage.setItem('bridge_history', JSON.stringify(h.slice(-50))); }
function addHistoryEntry(e) { const h = getHistory(); h.unshift(e); saveHistory(h); }
let activeHistoryTab = 'messages';
let activeHistoryFilter = 'all';

document.querySelectorAll('.history-tab').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.history-tab').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        activeHistoryTab = e.target.dataset.tab;
        renderHistory();
    });
});

document.querySelectorAll('.history-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.history-filter-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        activeHistoryFilter = e.target.dataset.filter;
        renderHistory();
    });
});

function renderHistoryItem(item) {
    const files = (item.files || []).map(f => `<span>📎 ${escapeHTML(f)}</span>`).join('');
    const ch = item.channel || 'telegram';
    const isFuture = item.scheduledTime && new Date(item.scheduledTime) > new Date() && !item.canceled;
    const chLabel = ch === 'telegram' ? '📱 TG' : ch === 'whatsapp' ? '💬 WA' : '📧 Email';

    let statusHtml = `<span class="history-item-status ${item.scheduled ? 'scheduled' : 'success'}">${item.scheduled ? (item.canceled ? '🚫 Canceled' : '⏰ Scheduled') : '✅ Sent'}</span>`;
    if (isFuture) {
        statusHtml += `<button class="cancel-job-btn" data-id="${item.jobId}">Cancel</button>`;
    }

    // Cycle badge for recurring scheduled jobs
    let cycleBadge = '';
    if (item.scheduled && item.cyclePeriod && item.cyclePeriod !== 'none') {
        const cycleLabels = { daily: '🔄 Daily', weekly: '🔄 Weekly', monthly: '🔄 Monthly' };
        cycleBadge = `<span class="history-item-cycle">${cycleLabels[item.cyclePeriod] || item.cyclePeriod}</span>`;
    }

    return `<div class="history-item"><div class="history-item-header"><span class="history-item-to">${escapeHTML(item.to)}</span><span class="history-item-time">${escapeHTML(item.scheduledTime ? new Date(item.scheduledTime).toLocaleString() : item.time)}</span></div><div class="history-item-files">${item.message ? `<span>💬 ${escapeHTML(item.message.substring(0, 60))}</span>` : ''}${files}</div><span class="history-item-channel ${ch}">${chLabel}</span>${cycleBadge}${statusHtml}</div>`;
}

// Convert a server-side scheduled job to a history item for rendering
function serverJobToHistoryItem(job) {
    return {
        to: (job.targets || []).join(', '),
        files: job.fileCount > 0 ? [`${job.fileCount} file(s)`] : [],
        message: job.messagePreview || '',
        time: new Date(job.scheduledFor).toLocaleString(),
        scheduled: true,
        channel: job.channel || 'telegram',
        jobId: job.id,
        scheduledTime: job.scheduledFor,
        cyclePeriod: job.cyclePeriod || 'none',
        canceled: false,
        _fromServer: true
    };
}

async function renderHistory() {
    const localHistory = getHistory();

    // For the scheduled tab, fetch server-side jobs and merge
    let mergedHistory = [...localHistory];
    if (activeHistoryTab === 'scheduled') {
        try {
            const res = await fetch('/api/scheduled');
            if (res.ok) {
                const serverJobs = await res.json();
                const localJobIds = new Set(localHistory.filter(i => i.jobId).map(i => i.jobId));
                // Add server jobs that aren't already in local history
                for (const sj of serverJobs) {
                    if (!localJobIds.has(sj.id)) {
                        mergedHistory.push(serverJobToHistoryItem(sj));
                    }
                }
            }
        } catch (e) { console.warn('Failed to fetch server scheduled jobs:', e); }
    }

    if (!mergedHistory.length) { historyBody.innerHTML = '<p class="history-empty">No transfers yet.</p>'; return; }

    // Apply channel filter
    const filtered = activeHistoryFilter === 'all' ? mergedHistory : mergedHistory.filter(i => (i.channel || 'telegram') === activeHistoryFilter);

    let html = '';
    if (activeHistoryTab === 'messages') {
        const msgs = filtered.filter(i => !i.scheduled);
        if (!msgs.length) html = '<p class="history-empty">No instant messages.</p>';
        else html = msgs.map(renderHistoryItem).join('');
    } else {
        const sched = filtered.filter(i => i.scheduled);
        if (!sched.length) {
            html = '<p class="history-empty">No scheduled jobs.</p>';
        } else {
            const active = [], completed = [], canceled = [];
            const now = new Date();
            sched.forEach(i => {
                if (i.canceled) canceled.push(i);
                else if (i.scheduledTime && new Date(i.scheduledTime) > now) active.push(i);
                else completed.push(i);
            });
            if (active.length) html += `<div class="history-section-title">Active</div>` + active.map(renderHistoryItem).join('');
            if (completed.length) html += `<div class="history-section-title">Completed</div>` + completed.map(renderHistoryItem).join('');
            if (canceled.length) html += `<div class="history-section-title">Canceled</div>` + canceled.map(renderHistoryItem).join('');
        }
    }
    historyBody.innerHTML = html;
}

historyBody.addEventListener('click', async (e) => {
    if (e.target.classList.contains('cancel-job-btn')) {
        const jobId = e.target.dataset.id;
        const btn = e.target;
        btn.textContent = 'Canceling...';
        btn.disabled = true;
        try {
            const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok || res.status === 404) {
                btn.textContent = 'Canceled';
                btn.classList.add('canceled');
                const history = getHistory();
                const item = history.find(i => i.jobId === jobId);
                if (item) { item.canceled = true; saveHistory(history); }
                renderHistory();
                if (res.status === 404) {
                    showStatus('Job was not found on server, marked as canceled.', 'info');
                }
            } else {
                btn.textContent = 'Cancel';
                btn.disabled = false;
                alert(data.error || 'Failed to cancel job');
            }
        } catch {
            btn.textContent = 'Cancel';
            btn.disabled = false;
            alert('Failed to cancel job');
        }
    }
});

// ==============================
// ONBOARDING
// ==============================
dismissBtn.addEventListener('click', () => { onboarding.classList.add('hidden'); localStorage.setItem('bridge_onboarding_dismissed', 'true'); });
if (localStorage.getItem('bridge_onboarding_dismissed') === 'true') onboarding.classList.add('hidden');

// ==============================
// SCHEDULE
// ==============================
let isScheduled = false;
scheduleToggle.addEventListener('click', () => {
    isScheduled = !isScheduled;
    schedulePicker.classList.toggle('hidden', !isScheduled);
    scheduleToggle.classList.toggle('active', isScheduled);
    if (isScheduled) { const d = new Date(Date.now() + 5 * 60000); scheduleTime.value = d.toISOString().slice(0, 16); }
    updateSendButton();
});
scheduleCancel.addEventListener('click', () => { isScheduled = false; schedulePicker.classList.add('hidden'); scheduleToggle.classList.remove('active'); scheduleTime.value = ''; updateSendButton(); });

// ==============================
// DRAG & DROP
// ==============================
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }, false));
['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, () => dropZone.classList.add('dragover'), false));
['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, () => dropZone.classList.remove('dragover'), false));
dropZone.addEventListener('drop', e => addFiles(e.dataTransfer.files), false);
dropZone.addEventListener('click', (e) => {
    if (!e.target.closest('.cloud-pickers')) fileInput.click();
});
fileInput.addEventListener('change', e => { addFiles(e.target.files); fileInput.value = ''; });

function addFiles(fl) {
    for (const f of fl) { if (!selectedFiles.some(s => s.name === f.name && s.size === f.size)) selectedFiles.push(f); }
    if (selectedFiles.length > 10) { selectedFiles = selectedFiles.slice(0, 10); showStatus('Max 10 files.', 'error'); }
    renderFileList();
}
previewModalClose.addEventListener('click', () => {
    previewModal.classList.add('hidden');
    previewContent.innerHTML = '';
});

function renderFileList() {
    if (!selectedFiles.length) { fileListDiv.classList.add('hidden'); updateSendButton(); return; }
    fileListDiv.classList.remove('hidden'); fileListDiv.innerHTML = '';
    selectedFiles.forEach((file, i) => {
        const over = file.size > MAX_FILE_SIZE;
        const isImg = file.type.startsWith('image/');

        const item = document.createElement('div'); item.className = `file-item${over ? ' oversized' : ''}`;
        const safeName = escapeHTML(file.name);

        let thumbHtml = '';
        if (isImg) {
            thumbHtml = `<img class="file-item-thumb previewable" src="${URL.createObjectURL(file)}" data-index="${i}">`;
        } else {
            const icon = getFileIcon(file.name, file.type);
            const iconClass = getIconClass(file.name);
            thumbHtml = `<div class="file-item-icon previewable ${iconClass}" data-index="${i}">${icon}</div>`;
        }

        item.innerHTML = `
            <input type="checkbox" class="file-zip-checkbox" data-index="${i}" style="margin-right:10px; cursor:pointer;">
            ${thumbHtml}
            <div class="file-item-info"><span class="file-item-name" title="${safeName}">${safeName}</span>
            <span class="file-item-size">
                ${over ? '<span class="zip-badge">Auto-Zip</span> ' : ''}
                ${formatSize(file.size)}
            </span></div>
            <button class="file-item-remove" data-index="${i}">✕</button>`;
        fileListDiv.appendChild(item);
    });

    const fileActions = document.getElementById('file-actions');
    if (fileActions) {
        if (selectedFiles.length > 1) fileActions.classList.remove('hidden');
        else fileActions.classList.add('hidden');
    }

    fileListDiv.querySelectorAll('.file-item-remove').forEach(b => b.addEventListener('click', e => { selectedFiles.splice(parseInt(e.target.dataset.index), 1); renderFileList(); }));
    fileListDiv.querySelectorAll('.previewable').forEach(el => el.addEventListener('click', e => {
        openPreview(parseInt(e.currentTarget.dataset.index));
    }));
    updateSendButton();
}

function updateSendButton() {
    const hasFiles = selectedFiles.length > 0;
    const hasMsg = messageInput.value.trim().length > 0;
    if (hasFiles || hasMsg) {
        sendBtn.classList.remove('hidden');
        const parts = [];
        if (hasFiles) parts.push(`${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}`);
        if (hasMsg) parts.push('message');
        sendBtnText.textContent = `${isScheduled ? '📅 Schedule' : 'Send'} ${parts.join(' + ')}`;
    } else { sendBtn.classList.add('hidden'); }
}
messageInput.addEventListener('input', updateSendButton);

document.getElementById('btn-zip-selected')?.addEventListener('click', async () => {
    const checkboxes = document.querySelectorAll('.file-zip-checkbox:checked');
    if (checkboxes.length === 0) { showStatus('Select files to zip', 'error'); return; }
    showStatus('Zipping selected files...', 'info');
    try {
        if (typeof JSZip === 'undefined') throw new Error("JSZip not loaded");
        const zip = new JSZip();
        const indices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index)).sort((a, b) => b - a);
        
        indices.forEach(i => {
            const file = selectedFiles[i];
            zip.file(file.name, file);
        });

        const content = await zip.generateAsync({ type: 'blob' });
        const zipFile = new File([content], `archive_${Date.now()}.zip`, { type: 'application/zip' });
        
        // Remove zipped files and add the new zip
        indices.forEach(i => selectedFiles.splice(i, 1));
        selectedFiles.push(zipFile);
        
        renderFileList();
        showStatus('Files zipped successfully!', 'success');
    } catch (e) {
        console.error('Zipping failed:', e);
        showStatus(`Failed to zip: ${e.message}`, 'error');
    }
});

// ==============================
// AUTO-ZIP
// ==============================
async function prepareFiles() {
    const prepared = [];
    for (let file of selectedFiles) {
        if (file.size > MAX_FILE_SIZE && typeof JSZip !== 'undefined') {
            sendBtnText.textContent = t('status_zipping', { name: file.name });
            const zip = new JSZip(); zip.file(file.name, file);
            const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
            prepared.push(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.zip', { type: 'application/zip' }));
        } else prepared.push(file);
    }
    return prepared;
}

// ==============================
// SEND
// ==============================
sendBtn.addEventListener('click', handleSend);

async function handleSend() {
    let target;
    if (activeChannel === 'telegram') {
        if (tgMode === 'qr' && tgClientReady && tgRecipientInput) {
            target = tgRecipientInput.value.trim();
            if (!target) { showStatus('Enter a recipient', 'error'); tgRecipientInput.focus(); return; }
        } else {
            target = chatIdInput.value.trim();
            if (!target) { showStatus(t('status_enter_telegram'), 'error'); chatIdInput.focus(); return; }
        }
    } else if (activeChannel === 'email') {
        target = emailToInput.value.trim();
        if (!target) { showStatus(t('status_enter_email'), 'error'); emailToInput.focus(); return; }
    } else {
        const rawPhones = waPhoneInput.value.split(',').map(s => s.trim()).filter(Boolean);
        if (rawPhones.length === 0) { showStatus(t('status_enter_phone'), 'error'); waPhoneInput.focus(); return; }

        let validTargets = [];
        for (const p of rawPhones) {
            const digitsOnly = p.replace(/\D/g, '');
            if (digitsOnly.length !== selectedCountry.digits) {
                showStatus(t('status_invalid_phone', { p, digits: selectedCountry.digits, name: selectedCountry.name }), 'error');
                waPhoneInput.focus();
                return;
            }
            validTargets.push(selectedCountry.code.replace('+', '') + digitsOnly);
        }
        target = validTargets.join(',');
    }

    sendBtn.disabled = true;
    sendBtnText.textContent = t('status_securing');
    let filesToSend = await prepareFiles();
    let message = messageInput.value.trim();

    const formData = new FormData();
    try {
        const keyRes = await fetch('/api/security/key');
        const { publicKey } = await keyRes.json();
        const rsaPubKey = await importRsaPublicKey(publicKey);
        const aesKey = await generateAesKey();

        const encryptedAesKey = await encryptAesKeyWithRsa(rsaPubKey, aesKey);
        formData.append('encryptedAesKey', encryptedAesKey);

        if (message) {
            const encoder = new TextEncoder();
            const encryptedMsg = await encryptWithAes(aesKey, encoder.encode(message));
            formData.append('message', window.btoa(String.fromCharCode.apply(null, encryptedMsg)));
        }

        for (const f of filesToSend) {
            sendBtnText.textContent = t('status_encrypting', { name: f.name });
            const encryptedBlob = await encryptFileChunked(aesKey, f);
            const encFile = new File([encryptedBlob], f.name, { type: f.type || 'application/octet-stream' });
            formData.append('files', encFile);
        }
    } catch (e) {
        showStatus(t('status_encryption_failed', { error: e.message }), 'error');
        sendBtn.disabled = false;
        updateSendButton();
        return;
    }

    formData.append('channel', activeChannel);
    formData.append('chatId', target);

    if (activeChannel === 'email') {
        const senderName = document.getElementById('senderName').value.trim();
        if (senderName) formData.append('senderName', senderName);
    }
    if (isScheduled && scheduleTime.value) {
        formData.append('scheduledTime', new Date(scheduleTime.value).toISOString());
        const scheduleCycle = document.getElementById('schedule-cycle');
        if (scheduleCycle && scheduleCycle.value !== 'none') {
            formData.append('cyclePeriod', scheduleCycle.value);
        }
    }

    if (activeChannel === 'whatsapp' && verifiedPhone) {
        formData.append('waSessionId', verifiedPhone);
    }

    if (activeChannel === 'telegram' && tgMode === 'qr' && tgClientReady) {
        formData.append('tgSessionId', getTgSessionId());
    }

    // Handle Offline
    if (!navigator.onLine) {
        queueOfflineTransfer(formData);
        showStatus(t('status_offline_queued'), 'success');
        selectedFiles = []; renderFileList(); messageInput.value = '';
        sendBtn.disabled = false; updateSendButton();
        return;
    }

    progressContainer.classList.remove('hidden');
    progressBar.style.width = '0%'; progressText.textContent = '0%';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) { const p = Math.round(e.loaded / e.total * 100); progressBar.style.width = p + '%'; progressText.textContent = p + '%'; }
    });
    xhr.addEventListener('load', () => {
        progressContainer.classList.add('hidden');
        try {
            const result = JSON.parse(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) {
                playWhoosh();
                showStatus(`${result.message} 🚀`, 'success');
                const displayTarget = activeChannel === 'whatsapp' ? `${selectedCountry.code} ${waPhoneInput.value}` : target;
                saveContact(activeChannel, activeChannel === 'whatsapp' ? waPhoneInput.value : target);
                addHistoryEntry({
                    to: displayTarget,
                    files: filesToSend.map(f => f.name),
                    message: message,
                    time: new Date().toLocaleString(),
                    scheduled: !!result.scheduled,
                    channel: activeChannel,
                    jobId: result.jobId || null,
                    scheduledTime: result.scheduled ? new Date(scheduleTime.value).toISOString() : null,
                    cyclePeriod: (result.scheduled && document.getElementById('schedule-cycle')) ? document.getElementById('schedule-cycle').value : null
                });
                selectedFiles = []; renderFileList(); messageInput.value = '';
                if (isScheduled) { isScheduled = false; schedulePicker.classList.add('hidden'); scheduleToggle.classList.remove('active'); scheduleTime.value = ''; }
            } else {
                showStatus(`${t('status_error')}: ${result.error}`, 'error');
                if (xhr.status === 403) {
                    waAccessVerified = false;
                    verifiedPhone = '';
                    localStorage.removeItem('bridge_wa_session_phone');
                    setChannel('whatsapp');
                }
            }
        } catch { showStatus(t('status_unexpected'), 'error'); }
        sendBtn.disabled = false; updateSendButton();
    });
    xhr.addEventListener('error', () => { progressContainer.classList.add('hidden'); showStatus(t('status_network_error'), 'error'); sendBtn.disabled = false; updateSendButton(); });
    xhr.send(formData);
}

function showStatus(text, type) {
    statusDiv.textContent = text; statusDiv.className = `status ${type}`;
    if (type === 'success') setTimeout(() => statusDiv.classList.add('hidden'), 5000);
}
function formatSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });

// ==============================
// INIT
// ==============================
window.addEventListener('DOMContentLoaded', async () => {
    const s = localStorage.getItem('telegram_bridge_chat_id');
    if (s) chatIdInput.value = s;

    setupAutocomplete(chatIdInput, 'chatId-autocomplete', 'telegram');
    setupAutocomplete(waPhoneInput, 'waPhone-autocomplete', 'whatsapp');
    setupAutocomplete(document.getElementById('emailTo'), 'emailTo-autocomplete', 'email');

    // Initialize Telegram mode on first load (page always starts on Telegram tab)
    if (activeChannel === 'telegram') {
        // Wait for config check to complete first
        await checkTgClientConfig();
        setTgMode(tgMode || 'bot');
    }
});

// ==============================
// ADMIN PANEL
// ==============================
const adminToggle = document.getElementById('admin-toggle');
const adminPanel = document.getElementById('admin-panel');
const adminClose = document.getElementById('admin-close');
const adminLogin = document.getElementById('admin-login');
const adminContent = document.getElementById('admin-content');
const adminPasswordInput = document.getElementById('admin-password');
const adminLoginBtn = document.getElementById('admin-login-btn');
const adminLoginError = document.getElementById('admin-login-error');
const adminStats = document.getElementById('admin-stats');
const adminTgUsers = document.getElementById('admin-tg-users');
const adminLogs = document.getElementById('admin-logs');
const adminRefreshLogs = document.getElementById('admin-refresh-logs');

let adminPassword = localStorage.getItem('bridge_admin_pw') || '';
let adminInterval = null;

adminToggle.addEventListener('click', () => {
    adminPanel.classList.remove('hidden');
    adminToggle.classList.add('active');
    if (adminPassword) {
        verifyAdminSession();
    } else {
        showAdminLogin();
    }
});

adminClose.addEventListener('click', () => {
    adminPanel.classList.add('hidden');
    adminToggle.classList.remove('active');
    if (adminInterval) clearInterval(adminInterval);

    // Clear session on close so it asks for password again next time
    adminPassword = '';
    localStorage.removeItem('bridge_admin_pw');
    showAdminLogin();
});

adminLoginBtn.addEventListener('click', handleAdminLogin);
adminPasswordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdminLogin(); });

async function handleAdminLogin() {
    const pwd = adminPasswordInput.value;
    adminLoginBtn.disabled = true;
    try {
        const res = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd })
        });
        const data = await res.json();
        if (data.valid) {
            if (data.needs2fa) {
                adminLoginError.classList.add('hidden');
                admin2faSection.classList.remove('hidden');
                adminLoginBtn.classList.add('hidden');
                adminPasswordInput.disabled = true;
                showToast(t('toast_2fa_required'), 'info');
            } else {
                adminPassword = pwd;
                localStorage.setItem('bridge_admin_pw', pwd);
                adminLoginError.classList.add('hidden');
                showAdminContent();
                refreshAnalytics();
            }
        } else {
            adminLoginError.classList.remove('hidden');
        }
    } catch (e) {
        adminLoginError.textContent = 'Connection error';
        adminLoginError.classList.remove('hidden');
    }
    adminLoginBtn.disabled = false;
}

async function verifyAdminSession() {
    try {
        const res = await fetch('/api/admin/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPassword })
        });
        const data = await res.json();
        if (data.valid) {
            showAdminContent();
        } else {
            localStorage.removeItem('bridge_admin_pw');
            adminPassword = '';
            showAdminLogin();
        }
    } catch {
        showAdminLogin();
    }
}

function showAdminLogin() {
    adminLogin.classList.remove('hidden');
    adminContent.classList.add('hidden');
    adminPasswordInput.value = '';
    adminPasswordInput.focus();
    if (adminInterval) clearInterval(adminInterval);
}

function showAdminContent() {
    adminLogin.classList.add('hidden');
    adminContent.classList.remove('hidden');
    loadAdminData();
    if (adminInterval) clearInterval(adminInterval);
}

async function fetchAdminData(endpoint) {
    const res = await fetch(endpoint, { headers: { 'x-admin-password': adminPassword } });
    if (res.status === 401) { showAdminLogin(); throw new Error('Unauthorized'); }
    return await res.json();
}

async function loadAdminData() {
    try {
        // Dashboard
        const dash = await fetchAdminData('/api/admin/dashboard');
        adminStats.innerHTML = `
            <div class="admin-stat"><div class="admin-stat-value">${dash.uptime}</div><div class="admin-stat-label">Uptime</div></div>
            <div class="admin-stat"><div class="admin-stat-value">${dash.memoryMB} MB</div><div class="admin-stat-label">Memory</div></div>
            <div class="admin-stat ${dash.telegram.connected ? 'online' : 'offline'}"><div class="admin-stat-value">${dash.telegram.users}</div><div class="admin-stat-label">TG Users</div></div>
            <div class="admin-stat ${dash.whatsapp.activeSessions > 0 ? 'online' : 'offline'}"><div class="admin-stat-value">${dash.whatsapp.activeSessions}</div><div class="admin-stat-label">WA Active</div></div>
            <div class="admin-stat"><div class="admin-stat-value">${dash.whatsapp.totalAuthenticated}</div><div class="admin-stat-label">WA Authenticated</div></div>
        `;

        // Telegram Users
        const tg = await fetchAdminData('/api/admin/telegram-users');
        adminTgUsers.innerHTML = tg.users.length ? tg.users.map(u => `
            <div class="admin-list-item">
                <span class="admin-list-item-text">${u.username}</span>
                <span class="admin-list-item-sub">${u.chatId}</span>
            </div>
        `).join('') : '<div class="admin-list-empty">No users registered</div>';

        // Logs
        loadLogs();
        if (typeof refreshAnalytics === 'function') refreshAnalytics();
    } catch (e) { console.error('Admin data load error', e); }
}

async function loadLogs() {
    try {
        const logs = await fetchAdminData('/api/admin/logs');
        adminLogs.innerHTML = logs.logs.length ? logs.logs.map(line => {
            const isErr = line.includes('[ERROR]');
            const isWarn = line.includes('[WARN]');
            const isFatal = line.includes('[FATAL]');
            const cls = isFatal ? 'fatal' : isErr ? 'error' : isWarn ? 'warn' : 'info';
            return `<div class="admin-log-line ${cls}">${escapeHTML(line)}</div>`;
        }).join('') : '<div class="admin-log-line">No logs yet today.</div>';
    } catch (e) { }
}
adminRefreshLogs?.addEventListener('click', loadLogs);

// ==============================
// GOOGLE DRIVE PICKER
// ==============================
let gDriveApiKey = null;
let gDriveClientId = null;
let gDrivePickerInited = false;
let gDriveOAuthToken = null;

async function loadDriveConfig() {
    if (gDriveApiKey) return true;
    try {
        const res = await fetch('/api/gdrive/config');
        const data = await res.json();
        if (data.apiKey && data.clientId) {
            gDriveApiKey = data.apiKey;
            gDriveClientId = data.clientId;
            return true;
        }
    } catch (e) { console.error('Drive config error', e); }
    return false;
}

async function initGDrivePicker() {
    if (gDrivePickerInited) return true;
    return new Promise((resolve) => {
        gapi.load('picker', () => {
            gDrivePickerInited = true;
            resolve(true);
        });
    });
}

async function getGDriveOAuthToken() {
    if (gDriveOAuthToken) return gDriveOAuthToken;
    return new Promise((resolve, reject) => {
        const tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: gDriveClientId,
            scope: 'https://www.googleapis.com/auth/drive.readonly',
            callback: (response) => {
                if (response.error) { reject(response.error); return; }
                gDriveOAuthToken = response.access_token;
                resolve(gDriveOAuthToken);
            }
        });
        tokenClient.requestAccessToken({ prompt: 'consent' });
    });
}

document.getElementById('btn-gdrive')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const hasConfig = await loadDriveConfig();
    if (!hasConfig) {
        alert('Google Drive Picker: Please configure your API key in the server/environment to use this feature.');
        return;
    }

    try {
        showStatus('Loading Google Drive...', 'info');
        await initGDrivePicker();
        const token = await getGDriveOAuthToken();

        const picker = new google.picker.PickerBuilder()
            .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
            .addView(google.picker.ViewId.DOCS)
            .addView(google.picker.ViewId.RECENTLY_PICKED)
            .setOAuthToken(token)
            .setDeveloperKey(gDriveApiKey)
            .setCallback(async (data) => {
                if (data.action === google.picker.Action.PICKED) {
                    for (const doc of data.docs) {
                        try {
                            showStatus(`Downloading ${doc.name}...`, 'info');
                            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`, {
                                headers: { 'Authorization': `Bearer ${token}` }
                            });
                            if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
                            const blob = await res.blob();
                            const file = new File([blob], doc.name, { type: doc.mimeType || blob.type });
                            selectedFiles.push(file);
                        } catch (e) {
                            showStatus(`Failed to download ${doc.name}: ${e.message}`, 'error');
                        }
                    }
                    renderFileList();
                    updateSendButton();
                    showStatus(`${data.docs.length} file(s) added from Google Drive`, 'success');
                }
            })
            .setTitle('Select files from Google Drive')
            .build();
        picker.setVisible(true);
    } catch (e) {
        showStatus('Google Drive error: ' + e, 'error');
    }
});

// ==============================
// HYBRID ENCRYPTION (RSA + AES)
// ==============================

async function importRsaPublicKey(pem) {
    const pemContents = pem
        .replace("-----BEGIN PUBLIC KEY-----", "")
        .replace("-----END PUBLIC KEY-----", "")
        .replace(/\s/g, "");
    const binaryDer = window.atob(pemContents);
    const binaryDerBuffer = new ArrayBuffer(binaryDer.length);
    const binaryDerView = new Uint8Array(binaryDerBuffer);
    for (let i = 0; i < binaryDer.length; i++) {
        binaryDerView[i] = binaryDer.charCodeAt(i);
    }
    return window.crypto.subtle.importKey(
        "spki",
        binaryDerBuffer,
        { name: "RSA-OAEP", hash: "SHA-256" },
        true,
        ["encrypt"]
    );
}

async function generateAesKey() {
    return window.crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

// Encrypt a small buffer (messages) — single-shot
async function encryptWithAes(key, dataBuffer) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const cipher = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, dataBuffer);
    const combined = new Uint8Array(iv.length + cipher.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipher), iv.length);
    return combined;
}

// Chunked file encryption — processes file in 64KB blocks to avoid RAM crashes
// Format: [4-byte chunk length][12-byte IV][encrypted data + 16-byte GCM tag] per chunk
const CHUNK_SIZE = 64 * 1024; // 64KB

async function encryptFileChunked(aesKey, file) {
    const chunks = [];
    let offset = 0;
    const fileSize = file.size;

    while (offset < fileSize) {
        const end = Math.min(offset + CHUNK_SIZE, fileSize);
        const slice = file.slice(offset, end);
        const plainBuf = await slice.arrayBuffer();

        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const cipher = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            aesKey,
            plainBuf
        );

        // Each chunk: [4-byte length header][12-byte IV][ciphertext + GCM tag]
        const chunkPayload = new Uint8Array(iv.length + cipher.byteLength);
        chunkPayload.set(iv, 0);
        chunkPayload.set(new Uint8Array(cipher), iv.length);

        // 4-byte big-endian length prefix
        const lenHeader = new Uint8Array(4);
        const dv = new DataView(lenHeader.buffer);
        dv.setUint32(0, chunkPayload.length, false);

        chunks.push(lenHeader);
        chunks.push(chunkPayload);

        offset = end;
    }

    return new Blob(chunks);
}

async function encryptAesKeyWithRsa(rsaPubKey, aesKey) {
    const rawKey = await window.crypto.subtle.exportKey("raw", aesKey);
    const encryptedKey = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaPubKey, rawKey);
    return window.btoa(String.fromCharCode.apply(null, new Uint8Array(encryptedKey)));
}

// ==============================
// DROPBOX PICKER
// ==============================
document.getElementById('btn-dropbox')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof Dropbox === 'undefined') return alert('Dropbox SDK not loaded.');
    Dropbox.choose({
        success: function (files) {
            files.forEach(f => {
                fetch(f.link).then(r => r.blob()).then(blob => {
                    const file = new File([blob], f.name, { type: blob.type });
                    selectedFiles.push(file);
                    renderFileList();
                    updateSendButton();
                });
            });
        },
        cancel: function () { },
        linkType: 'direct',
        multiselect: true
    });
});

// ==============================
// v4.0 NEW LOGIC
// ==============================

// Admin Analytics
let analyticsChart = null;
async function refreshAnalytics() {
    try {
        const res = await fetch('/api/admin/analytics', {
            headers: { 'x-admin-password': adminPassword, 'x-admin-2fa': admin2faToken.value }
        });
        if (!res.ok) return;
        const data = await res.json();

        const ctx = document.getElementById('transfers-chart').getContext('2d');
        if (analyticsChart) analyticsChart.destroy();

        analyticsChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.history.map(h => h._id),
                datasets: [{
                    label: t('analytics_transfers'),
                    data: data.history.map(h => h.count),
                    borderColor: '#0088cc',
                    backgroundColor: 'rgba(0, 136, 204, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } },
                    x: { grid: { display: false } }
                },
                plugins: { legend: { display: false } }
            }
        });
    } catch (e) { console.error('Analytics error', e); }
}

// Admin 2FA Setup
async function setupAdmin2fa() {
    try {
        const res = await fetch('/api/admin/2fa/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: adminPasswordInput.value })
        });
        const data = await res.json();
        if (data.qrCode) {
            admin2faQrContainer.classList.remove('hidden');
            admin2faQr.innerHTML = `<img src="${data.qrCode}" style="width: 150px; height: 150px; border-radius: 8px;">`;
        }
    } catch (e) { console.error('2FA Setup failed', e); }
}

// PWA: Offline Queue
function queueOfflineTransfer(payload) {
    offlineQueue.push({ id: Date.now(), payload, timestamp: new Date().toISOString() });
    localStorage.setItem('bridge_offline_queue', JSON.stringify(offlineQueue));
    updateOfflineIndicator();
}

function updateOfflineIndicator() {
    if (offlineQueue.length > 0) {
        offlineIndicator.classList.remove('hidden');
        offlineIndicator.innerHTML = t('offline_queued', { count: offlineQueue.length });
    } else {
        offlineIndicator.classList.add('hidden');
    }
}

async function syncOfflineQueue() {
    if (!navigator.onLine || offlineQueue.length === 0) return;

    showToast(t('toast_syncing_queue'), 'info');
    const queue = [...offlineQueue];
    offlineQueue = [];
    localStorage.setItem('bridge_offline_queue', '[]');

    for (const item of queue) {
        try {
            await fetch('/api/upload', { method: 'POST', body: item.payload });
        } catch (e) {
            console.error('Failed to sync item', e);
            offlineQueue.push(item); // Put back
        }
    }
    localStorage.setItem('bridge_offline_queue', JSON.stringify(offlineQueue));
    updateOfflineIndicator();
}

window.addEventListener('online', syncOfflineQueue);

// PWA: Push Notifications
async function initPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    try {
        const registration = await navigator.serviceWorker.ready;
        const res = await fetch('/api/push/vapid-key');
        const { publicKey } = await res.json();
        if (!publicKey) return;

        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: publicKey
        });

        await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription)
        });
    } catch (e) { console.warn('Push registration failed', e); }
}

// Enhanced Preview
// Enhanced Preview
function openPreview(index) {
    currentPreviewIndex = index;
    const file = selectedFiles[index];
    if (!file) return;

    previewModal.classList.remove('hidden');
    previewContent.innerHTML = '<div class="wa-qr-loading">Loading...</div>';
    previewInfo.innerText = `${file.name} (${formatSize(file.size)}) - ${index + 1}/${selectedFiles.length}`;

    const url = URL.createObjectURL(file);
    previewContent.dataset.url = url; // Store for revocation
    const type = file.type;
    const name = file.name.toLowerCase();

    if (type.startsWith('image/')) {
        previewContent.innerHTML = `<img src="${url}" style="max-width:100%; max-height:100%; object-fit:contain;">`;
    } else if (type.startsWith('video/')) {
        previewContent.innerHTML = `<video src="${url}" controls autoplay style="max-width:100%; max-height:100%;"></video>`;
    } else if (type.startsWith('audio/')) {
        previewContent.innerHTML = `<audio src="${url}" controls autoplay style="width: 100%;"></audio>`;
    } else if (type === 'application/pdf' || name.endsWith('.pdf')) {
        previewContent.innerHTML = `<object data="${url}" type="application/pdf" style="width:100%; height:80vh; border:none; background:white;">
            <p>Unable to display PDF. <a href="${url}" target="_blank">Download instead</a></p>
        </object>`;
    } else if (name.endsWith('.docx')) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const result = await mammoth.convertToHtml({ arrayBuffer: e.target.result });
                previewContent.innerHTML = `<div style="background:white; color:black; padding:40px; text-align:left; height:80vh; overflow-y:auto; font-family: 'Times New Roman', serif;">${result.value}</div>`;
            } catch (err) {
                previewContent.innerHTML = `<div class="status error">Failed to preview DOCX: ${err.message}</div>`;
            }
        };
        reader.readAsArrayBuffer(file);
    } else {
        const reader = new FileReader();
        reader.onload = (e) => {
            const text = e.target.result;
            const safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            previewContent.innerHTML = `<pre class="line-numbers"><code class="language-auto">${safeText}</code></pre>`;
            Prism.highlightAllUnder(previewContent);
        };
        reader.readAsText(file.slice(0, 50000)); // First 50KB
    }
}

// Ensure object URLs are revoked to prevent memory leaks
function closePreview() {
    if (previewContent.dataset.url) {
        URL.revokeObjectURL(previewContent.dataset.url);
        delete previewContent.dataset.url;
    }
    previewModal.classList.add('hidden');
    previewContent.innerHTML = '';
}
previewModalClose.addEventListener('click', closePreview);

previewPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentPreviewIndex > 0) openPreview(currentPreviewIndex - 1);
});
previewNext.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentPreviewIndex < selectedFiles.length - 1) openPreview(currentPreviewIndex + 1);
});

// Event Listeners for v4.0
langToggle.addEventListener('click', () => langDropdown.classList.toggle('hidden'));
document.querySelectorAll('[data-lang]').forEach(btn => {
    btn.addEventListener('click', () => switchLanguage(btn.getAttribute('data-lang')));
});

document.getElementById('btn-folder')?.addEventListener('click', (e) => {
    e.stopPropagation();
    folderInput.click();
});
folderInput.addEventListener('change', (e) => handleFolder(Array.from(e.target.files)));

adminDownloadLogsBtn.addEventListener('click', () => {
    const pw = adminPasswordInput.value;
    const tkn = admin2faToken.value;
    window.location.href = `/api/admin/logs/export?adminPassword=${pw}&admin2faToken=${tkn}`;
});

admin2faVerifyBtn.addEventListener('click', async () => {
    const pwd = adminPasswordInput.value;
    const res = await fetch('/api/admin/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd, token: admin2faToken.value })
    });
    const data = await res.json();
    if (data.valid) {
        adminPassword = pwd;
        localStorage.setItem('bridge_admin_pw', pwd);
        adminLoginError.classList.add('hidden');
        showAdminContent();
        if (typeof refreshAnalytics === 'function') refreshAnalytics();
    } else {
        adminLoginError.classList.remove('hidden');
        adminLoginError.innerText = data.error || t('admin_login_error');
    }
});

// On Init
window.addEventListener('load', () => {
    initI18n();
    updateOfflineIndicator();
    if (navigator.onLine) syncOfflineQueue();
    initPush();
});

// Share Target API Handling
if ('serviceWorker' in navigator && window.location.search.includes('share_title')) {
    const params = new URLSearchParams(window.location.search);
    const title = params.get('share_title');
    const text = params.get('share_text');
    const url = params.get('share_url');
    if (title || text || url) {
        messageInput.value = `${title ? title + '\n' : ''}${text ? text + '\n' : ''}${url || ''}`;
        updateSendButton();
    }
}

// ==============================
// CONTACTS AUTOCOMPLETE
// ==============================
// PHONEBOOK (localStorage)
// ==============================
function getPhonebook() {
    return JSON.parse(localStorage.getItem('bridge_phonebook') || '[]');
}
function savePhonebook(contacts) {
    localStorage.setItem('bridge_phonebook', JSON.stringify(contacts));
}
function addPhonebookContact(name, value, channel) {
    const pb = getPhonebook();
    const exists = pb.find(c => c.name.toLowerCase() === name.toLowerCase() && c.channel === channel);
    if (exists) { exists.value = value; } else { pb.push({ name, value, channel }); }
    savePhonebook(pb);
}
function deletePhonebookContact(name, channel) {
    savePhonebook(getPhonebook().filter(c => !(c.name.toLowerCase() === name.toLowerCase() && c.channel === channel)));
}

function saveContact(channel, rawTarget) {
    const key = `bridge_contacts_${channel}`;
    let contacts = JSON.parse(localStorage.getItem(key) || '[]');
    const newContacts = rawTarget.split(',').map(t => t.trim()).filter(Boolean);
    let added = false;
    for (const c of newContacts) {
        if (!contacts.includes(c)) { contacts.push(c); added = true; }
    }
    if (added) localStorage.setItem(key, JSON.stringify(contacts));
}

// ==============================
// CONTACTS PANEL
// ==============================
const contactsPanel = document.getElementById('contacts-panel');
const contactsFab = document.getElementById('contacts-fab');
const contactsClose = document.getElementById('contacts-close');
const contactsBody = document.getElementById('contacts-body');
const contactsImport = document.getElementById('contacts-import');
const contactsSearchInput = document.getElementById('contacts-search-input');
const contactNameInput = document.getElementById('contact-name');
const contactValueInput = document.getElementById('contact-value');
const contactChannelSelect = document.getElementById('contact-channel');
const contactsAddBtn = document.getElementById('contacts-add-btn');

if (contactsFab) contactsFab.addEventListener('click', () => {
    contactsPanel.classList.toggle('hidden');
    contactsFab.classList.toggle('active');
    renderContactsPanel();
});
if (contactsClose) contactsClose.addEventListener('click', () => {
    contactsPanel.classList.add('hidden');
    contactsFab.classList.remove('active');
});
if (contactsAddBtn) contactsAddBtn.addEventListener('click', () => {
    const name = contactNameInput.value.trim();
    const value = contactValueInput.value.trim();
    const channel = contactChannelSelect.value;
    if (!name || !value) return;
    addPhonebookContact(name, value, channel);
    contactNameInput.value = '';
    contactValueInput.value = '';
    renderContactsPanel();
});
if (contactsImport) contactsImport.addEventListener('click', () => {
    let imported = 0;
    ['telegram', 'whatsapp', 'email'].forEach(ch => {
        const old = JSON.parse(localStorage.getItem(`bridge_contacts_${ch}`) || '[]');
        old.forEach(val => {
            const pb = getPhonebook();
            if (!pb.find(c => c.value === val && c.channel === ch)) {
                addPhonebookContact(val, val, ch);
                imported++;
            }
        });
    });
    renderContactsPanel();
    if (typeof showTopToast === 'function') showTopToast(`📥 Imported ${imported} contact(s) from history`, 'success');
});
if (contactsSearchInput) contactsSearchInput.addEventListener('input', () => renderContactsPanel());

function renderContactsPanel() {
    const pb = getPhonebook();
    const q = (contactsSearchInput?.value || '').toLowerCase();
    const filtered = q ? pb.filter(c => c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q)) : pb;
    if (filtered.length === 0) {
        contactsBody.innerHTML = '<p class="contacts-empty">No contacts saved yet.</p>';
        return;
    }
    const grouped = { whatsapp: [], telegram: [], email: [] };
    filtered.forEach(c => { if (grouped[c.channel]) grouped[c.channel].push(c); });
    const icons = { whatsapp: '💬', telegram: '📱', email: '📧' };
    const labels = { whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'Email' };
    let html = '';
    for (const [ch, contacts] of Object.entries(grouped)) {
        if (contacts.length === 0) continue;
        html += `<div class="contact-group-title">${icons[ch]} ${labels[ch]}</div>`;
        contacts.forEach(c => {
            html += `<div class="contact-item">
                <div class="contact-item-icon ${ch}">${icons[ch]}</div>
                <div class="contact-item-info">
                    <div class="contact-item-name">${escapeHTML(c.name)}</div>
                    <div class="contact-item-value">${escapeHTML(c.value)}</div>
                </div>
                <div class="contact-item-actions">
                    <button class="delete" onclick="deletePhonebookContact('${escapeHTML(c.name)}','${ch}');renderContactsPanel()">✕</button>
                </div>
            </div>`;
        });
    }
    contactsBody.innerHTML = html;
}

// ==============================
// ENHANCED AUTOCOMPLETE (name + value search)
// ==============================
function setupAutocomplete(inputEl, dropdownId, channelKey) {
    const dropdown = document.getElementById(dropdownId);
    if (!inputEl || !dropdown) return;

    document.addEventListener('click', (e) => {
        if (!inputEl.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.add('hidden');
    });

    inputEl.addEventListener('input', () => {
        const val = inputEl.value;
        const parts = val.split(',');
        const lastPart = parts[parts.length - 1].trimLeft();
        const query = lastPart.trim().toLowerCase();
        if (query.length < 1) { dropdown.classList.add('hidden'); return; }

        const items = [];

        // 1) Phonebook contacts (name-based search)
        const pb = getPhonebook().filter(c => c.channel === channelKey);
        pb.forEach(c => {
            if (c.name.toLowerCase().includes(query) || c.value.toLowerCase().includes(query)) {
                items.push({ type: 'phonebook', name: c.name, value: c.value });
            }
        });

        // 2) History-based contacts (value-only)
        const history = JSON.parse(localStorage.getItem(`bridge_contacts_${channelKey}`) || '[]');
        history.forEach(h => {
            if (h.toLowerCase().includes(query) && !items.find(i => i.value === h)) {
                items.push({ type: 'history', name: '', value: h });
            }
        });

        if (items.length > 0) {
            dropdown.innerHTML = '';
            items.slice(0, 10).forEach(item => {
                const li = document.createElement('li');
                li.className = 'autocomplete-item';
                if (item.type === 'phonebook') {
                    li.innerHTML = `<span class="ac-contact-badge">📇</span><span class="ac-contact-name">${escapeHTML(item.name)}</span><span class="ac-contact-value">— ${escapeHTML(item.value)}</span>`;
                } else {
                    const idx = item.value.toLowerCase().indexOf(query);
                    const before = item.value.substring(0, idx);
                    const matched = item.value.substring(idx, idx + query.length);
                    const after = item.value.substring(idx + query.length);
                    li.innerHTML = `<span>${before}<strong>${matched}</strong>${after}</span>`;
                }
                li.addEventListener('click', () => {
                    parts[parts.length - 1] = (parts.length > 1 ? ' ' : '') + item.value;
                    inputEl.value = parts.join(',') + (channelKey !== 'telegram' ? ', ' : '');
                    dropdown.classList.add('hidden');
                    inputEl.focus();
                });
                dropdown.appendChild(li);
            });
            dropdown.classList.remove('hidden');
        } else {
            dropdown.classList.add('hidden');
        }
    });
}

// ==============================
// TELEGRAM QR MODE
// ==============================
let tgMode = 'qr';
let tgClientReady = false;
let tgClientAvailable = false;
const tgQrOverlay = document.getElementById('tg-qr-overlay');
const tgQrImage = document.getElementById('tg-qr-image');
const tgQrLoading = document.getElementById('tg-qr-loading');
const tgQrError = document.getElementById('tg-qr-error');
const tgModeToggle = document.getElementById('tg-mode-toggle');
const tgBotInput = document.getElementById('tg-bot-input');
const tgQrInput = document.getElementById('tg-qr-input');
const tgModeQrBtn = document.getElementById('tg-mode-qr');
const tgModeBotBtn = document.getElementById('tg-mode-bot');
const tgRecipientInput = document.getElementById('tgRecipient');

// Check if Telegram MTProto client is available on server
async function checkTgClientConfig() {
    try {
        const res = await fetch('/api/telegram/config');
        const data = await res.json();
        tgClientAvailable = data.tgClientAvailable;
        if (!tgClientAvailable && tgModeToggle) tgModeToggle.style.display = 'none';
    } catch (e) { tgClientAvailable = false; }
}
// Don't auto-call here — called from DOMContentLoaded instead

const tgPairingLink = document.getElementById('tg-pairing-link');
const tgPairingLinkBack = document.getElementById('tg-pairing-link-back');

function setTgMode(mode) {
    tgMode = mode;
    
    
    if (activeChannel === 'telegram') {
        if (mode === 'qr') {
            MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB for MTProto client
            dropZoneText.textContent = 'or click to browse · max 2 GB · up to 10 files';
        } else {
            MAX_FILE_SIZE = 50 * 1024 * 1024;
            dropZoneText.textContent = 'or click to browse · max 50 MB · up to 10 files';
        }
    }

    if (tgBotInput) tgBotInput.classList.toggle('hidden', mode === 'qr' && tgClientAvailable);
    if (tgQrInput) tgQrInput.classList.toggle('hidden', mode !== 'qr' || !tgClientAvailable || !tgClientReady);
    if (tgQrOverlay) {
        if (mode === 'qr' && tgClientAvailable && !tgClientReady) {
            tgQrOverlay.classList.remove('hidden');
            // Only init once — don't re-create session on every tab switch
            if (!tgSessionInitialized) {
                initTelegramSession();
            }
        } else if (mode === 'qr' && tgClientReady) {
            tgQrOverlay.classList.add('hidden');
            if (tgQrInput) tgQrInput.classList.remove('hidden');
        } else {
            tgQrOverlay.classList.add('hidden');
        }
    }
}

if (tgPairingLink) {
    tgPairingLink.addEventListener('click', () => setTgMode('bot'));
}
if (tgPairingLinkBack) {
    tgPairingLinkBack.addEventListener('click', () => setTgMode('qr'));
}

function getTgSessionId() {
    let sid = localStorage.getItem('bridge_tg_session_id');
    if (!sid) { sid = 'tg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('bridge_tg_session_id', sid); }
    return sid;
}

let tgSessionInitialized = false;

async function initTelegramSession() {
    if (tgSessionInitialized) return; // Already initialized
    tgSessionInitialized = true;
    const sid = getTgSessionId();
    socket.emit('join_tg_session', sid);
    try {
        const res = await fetch('/api/telegram/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sid }) });
        const data = await res.json();
        if (!data.tgClientAvailable) { tgClientAvailable = false; tgSessionInitialized = false; if (tgModeToggle) tgModeToggle.style.display = 'none'; setTgMode('bot'); return; }
        pollTgStatus();
    } catch (e) { console.error('TG session init error:', e); tgSessionInitialized = false; }
}

async function pollTgStatus() {
    const sid = getTgSessionId();
    try {
        const res = await fetch(`/api/telegram/status?sessionId=${sid}`);
        const data = await res.json();
        handleTgStatus(data);
    } catch (e) { console.error('TG status poll error:', e); }
}

function handleTgStatus(data) {
    if (data.ready) {
        tgClientReady = true;
        if (tgQrOverlay) tgQrOverlay.classList.add('hidden');
        if (tgQrInput) tgQrInput.classList.remove('hidden');
        if (tgBotInput) tgBotInput.classList.add('hidden');
        // Upgrade file size limit to 2GB for MTProto client
        if (activeChannel === 'telegram') {
            MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
            dropZoneText.textContent = 'or click to browse · max 2 GB · up to 10 files';
        }
        if (typeof showTopToast === 'function') showTopToast('✅ Telegram connected — send files up to 2 GB!', 'success');
        fetchTelegramContacts();
    } else if (data.qr) {
        if (tgQrImage) { tgQrImage.src = data.qr; tgQrImage.classList.remove('hidden'); }
        if (tgQrLoading) tgQrLoading.style.display = 'none';
        if (tgQrError) tgQrError.classList.add('hidden');
    } else if (data.error) {
        if (tgQrError) { tgQrError.textContent = data.error; tgQrError.classList.remove('hidden'); }
    }
}

socket.on('tg_status_update', (data) => { handleTgStatus(data); });

async function fetchTelegramContacts() {
    const sid = getTgSessionId();
    try {
        const res = await fetch(`/api/telegram/contacts?sessionId=${sid}`);
        const data = await res.json();
        if (data.contacts && data.contacts.length > 0) {
            data.contacts.forEach(c => { addPhonebookContact(c.name, c.value, 'telegram'); });
            renderContactsPanel();
        }
    } catch (e) { console.error('Failed to fetch TG contacts:', e); }
}

// Setup autocomplete for tgRecipient
if (tgRecipientInput) setupAutocomplete(tgRecipientInput, 'tgRecipient-autocomplete', 'telegram');
