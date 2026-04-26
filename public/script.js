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
const telegramInputDiv = document.getElementById('telegram-input');
const whatsappInputDiv = document.getElementById('whatsapp-input');
const waQrOverlay = document.getElementById('wa-qr-overlay');
const waQrImage = document.getElementById('wa-qr-image');
const waQrLoading = document.getElementById('wa-qr-loading');
const countryBtn = document.getElementById('country-btn');
const countryFlag = document.getElementById('country-flag');
const countryCodeEl = document.getElementById('country-code');
const countryDropdown = document.getElementById('country-dropdown');
const phoneHint = document.getElementById('phone-hint');
const mainContent = document.getElementById('main-content');

const MAX_FILE_SIZE = 50 * 1024 * 1024;
let selectedFiles = [];
let activeChannel = 'telegram';
let waPollingInterval = null;
let waAccessVerified = false;
let verifiedPhone = '';

// ==============================
// WHATSAPP SESSION INIT (QR scan = authentication)
// ==============================
async function initWhatsAppSession() {
    if (waAccessVerified) return;

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
    waPhoneInput.maxLength = selectedCountry.digits;
    waPhoneInput.placeholder = '0'.repeat(selectedCountry.digits);
    validatePhone();
}

countryBtn.addEventListener('click', (e) => { e.stopPropagation(); countryDropdown.classList.toggle('hidden'); });
document.addEventListener('click', () => countryDropdown.classList.add('hidden'));

function validatePhone() {
    const val = waPhoneInput.value.replace(/\D/g, '');
    if (!val) { phoneHint.textContent = ''; phoneHint.className = 'phone-hint'; return false; }
    if (val.length === selectedCountry.digits) {
        phoneHint.textContent = `✓ Valid ${selectedCountry.name} number`;
        phoneHint.className = 'phone-hint valid';
        return true;
    } else {
        phoneHint.textContent = `Enter ${selectedCountry.digits} digits (currently ${val.length})`;
        phoneHint.className = 'phone-hint invalid';
        return false;
    }
}

waPhoneInput.addEventListener('input', () => {
    waPhoneInput.value = waPhoneInput.value.replace(/\D/g, '');
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
    } catch (e) {}
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
    activeChannel = channel;
    document.body.setAttribute('data-active-channel', channel);
    btnTelegram.classList.toggle('active', channel === 'telegram');
    btnWhatsapp.classList.toggle('active', channel === 'whatsapp');
    telegramInputDiv.classList.toggle('hidden', channel !== 'telegram');

    if (channel === 'whatsapp') {
        whatsappInputDiv.classList.remove('hidden');
        mainContent.classList.remove('hidden');
        initWhatsAppSession();
    } else {
        whatsappInputDiv.classList.add('hidden');
        mainContent.classList.remove('hidden');
        stopWaPolling();
        waQrOverlay.classList.add('hidden');
    }
    updateSendButton();
}
btnTelegram.addEventListener('click', () => setChannel('telegram'));
btnWhatsapp.addEventListener('click', () => setChannel('whatsapp'));

// ==============================
// WHATSAPP QR
// ==============================
function startWaPolling() { stopWaPolling(); checkWaStatus(); waPollingInterval = setInterval(checkWaStatus, 3000); }
function stopWaPolling() { if (waPollingInterval) { clearInterval(waPollingInterval); waPollingInterval = null; } }
async function checkWaStatus() {
    try {
        const sid = localStorage.getItem('bridge_wa_session_phone') || '';
        const res = await fetch(`/api/whatsapp/status?sessionId=${encodeURIComponent(sid)}`);
        const data = await res.json();
        if (data.ready) { waQrOverlay.classList.add('hidden'); stopWaPolling(); }
        else {
            waQrOverlay.classList.remove('hidden');
            if (data.qr) { waQrImage.src = data.qr; waQrImage.classList.remove('hidden'); waQrLoading.classList.add('hidden'); }
            else { waQrImage.classList.add('hidden'); waQrLoading.classList.remove('hidden'); }
        }
    } catch (e) {}
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
historyClear.addEventListener('click', () => { localStorage.removeItem('bridge_history'); renderHistory(); });

function getHistory() { try { return JSON.parse(localStorage.getItem('bridge_history') || '[]'); } catch { return []; } }
function saveHistory(h) { localStorage.setItem('bridge_history', JSON.stringify(h.slice(-50))); }
function addHistoryEntry(e) { const h = getHistory(); h.unshift(e); saveHistory(h); }
function renderHistory() {
    const history = getHistory();
    if (!history.length) { historyBody.innerHTML = '<p class="history-empty">No transfers yet.</p>'; return; }
    historyBody.innerHTML = history.map(item => {
        const files = (item.files || []).map(f => `<span>📎 ${escapeHTML(f)}</span>`).join('');
        const ch = item.channel || 'telegram';
        return `<div class="history-item"><div class="history-item-header"><span class="history-item-to">${escapeHTML(item.to)}</span><span class="history-item-time">${escapeHTML(item.time)}</span></div><div class="history-item-files">${item.message ? `<span>💬 ${escapeHTML(item.message.substring(0,60))}</span>` : ''}${files}</div><span class="history-item-channel ${ch}">${ch === 'telegram' ? '📱 TG' : '💬 WA'}</span><span class="history-item-status ${item.scheduled ? 'scheduled' : 'success'}">${item.scheduled ? '⏰ Scheduled' : '✅ Sent'}</span></div>`;
    }).join('');
}

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
    if (isScheduled) { const d = new Date(Date.now() + 5*60000); scheduleTime.value = d.toISOString().slice(0,16); }
    updateSendButton();
});
scheduleCancel.addEventListener('click', () => { isScheduled = false; schedulePicker.classList.add('hidden'); scheduleToggle.classList.remove('active'); scheduleTime.value = ''; updateSendButton(); });

// ==============================
// DRAG & DROP
// ==============================
['dragenter','dragover','dragleave','drop'].forEach(ev => dropZone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); }, false));
['dragenter','dragover'].forEach(ev => dropZone.addEventListener(ev, () => dropZone.classList.add('dragover'), false));
['dragleave','drop'].forEach(ev => dropZone.addEventListener(ev, () => dropZone.classList.remove('dragover'), false));
dropZone.addEventListener('drop', e => addFiles(e.dataTransfer.files), false);
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { addFiles(e.target.files); fileInput.value = ''; });

function addFiles(fl) {
    for (const f of fl) { if (!selectedFiles.some(s => s.name === f.name && s.size === f.size)) selectedFiles.push(f); }
    if (selectedFiles.length > 10) { selectedFiles = selectedFiles.slice(0,10); showStatus('Max 10 files.', 'error'); }
    renderFileList();
}
function renderFileList() {
    if (!selectedFiles.length) { fileListDiv.classList.add('hidden'); updateSendButton(); return; }
    fileListDiv.classList.remove('hidden'); fileListDiv.innerHTML = '';
    selectedFiles.forEach((file, i) => {
        const over = file.size > MAX_FILE_SIZE; const isImg = file.type.startsWith('image/');
        const item = document.createElement('div'); item.className = `file-item${over ? ' oversized' : ''}`;
        const safeName = escapeHTML(file.name);
        item.innerHTML = `${isImg ? `<img class="file-item-thumb" src="${URL.createObjectURL(file)}">` : ''}
            <div class="file-item-info"><span class="file-item-name" title="${safeName}">${safeName}</span>
            <span class="file-item-size">${over ? '<span class="zip-badge">Will auto-zip</span> ' : ''}${formatSize(file.size)}</span></div>
            <button class="file-item-remove" data-index="${i}">✕</button>`;
        fileListDiv.appendChild(item);
    });
    fileListDiv.querySelectorAll('.file-item-remove').forEach(b => b.addEventListener('click', e => { selectedFiles.splice(parseInt(e.target.dataset.index),1); renderFileList(); }));
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

// ==============================
// AUTO-ZIP
// ==============================
async function prepareFiles() {
    const prepared = [];
    for (const file of selectedFiles) {
        if (file.size > MAX_FILE_SIZE && typeof JSZip !== 'undefined') {
            showStatus(`Compressing ${file.name}...`, 'info');
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
        target = chatIdInput.value.trim();
        if (!target) { showStatus('Enter a Telegram username.', 'error'); chatIdInput.focus(); return; }
    } else {
        const phoneVal = waPhoneInput.value.replace(/\D/g, '');
        if (!phoneVal) { showStatus('Enter a phone number.', 'error'); waPhoneInput.focus(); return; }
        if (phoneVal.length !== selectedCountry.digits) {
            showStatus(`Phone number must be exactly ${selectedCountry.digits} digits for ${selectedCountry.name}.`, 'error');
            waPhoneInput.focus();
            return;
        }
        target = selectedCountry.code.replace('+', '') + phoneVal;
    }

    sendBtn.disabled = true;
    sendBtnText.textContent = isScheduled ? 'Scheduling...' : 'Sending...';
    const filesToSend = await prepareFiles();
    const message = messageInput.value.trim();

    const formData = new FormData();
    formData.append('channel', activeChannel);
    formData.append('chatId', target);
    formData.append('message', message);
    if (isScheduled && scheduleTime.value) formData.append('scheduledTime', new Date(scheduleTime.value).toISOString());
    filesToSend.forEach(f => formData.append('files', f));

    // Send session ID for server-side session lookup
    if (activeChannel === 'whatsapp' && verifiedPhone) {
        formData.append('waSessionId', verifiedPhone);
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
                addHistoryEntry({ to: displayTarget, files: filesToSend.map(f => f.name), message, time: new Date().toLocaleString(), scheduled: !!result.scheduled, channel: activeChannel });
                selectedFiles = []; renderFileList(); messageInput.value = '';
                if (isScheduled) { isScheduled = false; schedulePicker.classList.add('hidden'); scheduleToggle.classList.remove('active'); scheduleTime.value = ''; }
            } else {
                showStatus(`Error: ${result.error}`, 'error');
                if (xhr.status === 403) {
                    waAccessVerified = false;
                    verifiedPhone = '';
                    localStorage.removeItem('bridge_wa_session_phone');
                    setChannel('whatsapp');
                }
            }
        } catch { showStatus('Unexpected response.', 'error'); }
        sendBtn.disabled = false; updateSendButton();
    });
    xhr.addEventListener('error', () => { progressContainer.classList.add('hidden'); showStatus('Network error.', 'error'); sendBtn.disabled = false; updateSendButton(); });
    xhr.send(formData);
}

function showStatus(text, type) {
    statusDiv.textContent = text; statusDiv.className = `status ${type}`;
    if (type === 'success') setTimeout(() => statusDiv.classList.add('hidden'), 5000);
}
function formatSize(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return (b / 1024).toFixed(1) + ' KB'; return (b / 1048576).toFixed(1) + ' MB'; }

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ==============================
// INIT
// ==============================
window.addEventListener('DOMContentLoaded', async () => {
    const s = localStorage.getItem('telegram_bridge_chat_id');
    if (s) chatIdInput.value = s;
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
const adminWhitelist = document.getElementById('admin-whitelist');
const adminAddPhone = document.getElementById('admin-add-phone');
const adminAddBtn = document.getElementById('admin-add-btn');
const adminTgUsers = document.getElementById('admin-tg-users');
const adminScheduled = document.getElementById('admin-scheduled');
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
            adminPassword = pwd;
            localStorage.setItem('bridge_admin_pw', pwd);
            adminLoginError.classList.add('hidden');
            showAdminContent();
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
    adminInterval = setInterval(loadAdminData, 10000); // refresh every 10s
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
            <div class="admin-stat ${dash.whatsapp.activeSessions > 0 ? 'online' : 'offline'}"><div class="admin-stat-value">${dash.whatsapp.activeSessions}/${dash.whatsapp.allowedNumbers}</div><div class="admin-stat-label">WA Active/Allowed</div></div>
        `;

        // Whitelist
        const wa = await fetchAdminData('/api/admin/whitelist');
        adminWhitelist.innerHTML = wa.numbers.length ? wa.numbers.map(n => `
            <div class="admin-list-item">
                <span class="admin-list-item-text">📱 +${n}</span>
                <button class="admin-list-item-remove" onclick="removeWaNumber('${n}')">Remove</button>
            </div>
        `).join('') : '<div class="admin-list-empty">No numbers allowed yet</div>';

        // Telegram Users
        const tg = await fetchAdminData('/api/admin/telegram-users');
        adminTgUsers.innerHTML = tg.users.length ? tg.users.map(u => `
            <div class="admin-list-item">
                <span class="admin-list-item-text">${u.username}</span>
                <span class="admin-list-item-sub">${u.chatId}</span>
            </div>
        `).join('') : '<div class="admin-list-empty">No users registered</div>';

        // Scheduled Jobs
        const jobs = await fetchAdminData('/api/admin/scheduled');
        adminScheduled.innerHTML = jobs.jobs.length ? jobs.jobs.map(j => `
            <div class="admin-list-item" style="flex-direction: column; align-items: flex-start; gap: 4px;">
                <div style="display: flex; justify-content: space-between; width: 100%;">
                    <span class="admin-list-item-text">⏰ To: ${j.targets.join(', ')}</span>
                    <span class="admin-list-item-sub">${j.fileCount} files</span>
                </div>
                <div class="admin-list-item-sub">At: ${new Date(j.scheduledFor).toLocaleString()}</div>
            </div>
        `).join('') : '<div class="admin-list-empty">No scheduled jobs</div>';

        // Logs
        loadLogs();
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
    } catch(e){}
}
adminRefreshLogs.addEventListener('click', loadLogs);

adminAddBtn.addEventListener('click', async () => {
    const phone = adminAddPhone.value.trim();
    if (!phone) return;
    adminAddBtn.disabled = true;
    try {
        await fetch('/api/admin/whitelist/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
            body: JSON.stringify({ phone })
        });
        adminAddPhone.value = '';
        loadAdminData();
    } catch(e){}
    adminAddBtn.disabled = false;
});

async function removeWaNumber(phone) {
    if(!confirm(`Remove ${phone} from WhatsApp access?`)) return;
    try {
        await fetch('/api/admin/whitelist/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-password': adminPassword },
            body: JSON.stringify({ phone })
        });
        loadAdminData();
    } catch(e){}
}

