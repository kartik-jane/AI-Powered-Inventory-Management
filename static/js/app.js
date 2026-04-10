// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  chatHistory: [],
  apiKey: null,
  currentStockAction: 'add',
  products: [],
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadProducts();
  loadTransactions();
  setupNav();
  setupChat();
  setupSearch();
  setupStockModal();
  setupVoice();   // ← voice module init
  if (state.apiKey) document.getElementById('apiKeyInput').value = state.apiKey;
});

// ─── Navigation ───────────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchPanel(btn.dataset.panel));
  });
  document.getElementById('sidebarToggle')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });
  document.getElementById('mobileMenu')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
}

function switchPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById(`panel-${name}`);
  if (panel) panel.classList.add('active');
  const btn = document.querySelector(`[data-panel="${name}"]`);
  if (btn) btn.classList.add('active');

  const titles = { chat: 'AI Assistant', products: 'Products', add: 'Add Product', transactions: 'Transactions' };
  document.getElementById('pageTitle').textContent = titles[name] || name;

  if (name === 'products') loadProducts();
  if (name === 'transactions') loadTransactions();

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    document.getElementById('statTotal').textContent = data.total_products;
    document.getElementById('statValue').textContent = formatCurrency(data.total_value);
    document.getElementById('statLow').textContent = data.low_stock_count;
    document.getElementById('statOut').textContent = data.out_of_stock_count;
    const alertCount = data.low_stock_count + data.out_of_stock_count;
    const el = document.getElementById('alertCount');
    el.textContent = alertCount;
    el.style.display = alertCount > 0 ? 'flex' : 'none';
  } catch (e) { console.error(e); }
}

// ─── Products ─────────────────────────────────────────────────────────────────
async function loadProducts() {
  try {
    const res = await fetch('/api/products');
    state.products = await res.json();
    renderProductTable(state.products);
    populateCategoryFilter(state.products);
  } catch (e) { console.error(e); }
}

function renderProductTable(products) {
  const tbody = document.getElementById('productTableBody');
  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="loading-cell">No products found. Ask ARIA to add some!</td></tr>`;
    return;
  }
  tbody.innerHTML = products.map(p => `
    <tr>
      <td><strong style="color:var(--text)">${esc(p.name)}</strong><br><small style="color:var(--text3)">${esc(p.supplier || '')}</small></td>
      <td><code style="font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--cyan)">${esc(p.sku)}</code></td>
      <td>${esc(p.category)}</td>
      <td><strong style="color:${p.quantity === 0 ? 'var(--red)' : p.quantity <= p.low_stock_threshold ? 'var(--yellow)' : 'var(--text)'}">${p.quantity}</strong></td>
      <td>${formatCurrency(p.unit_price)}</td>
      <td style="color:var(--accent2)">${formatCurrency(p.quantity * p.unit_price)}</td>
      <td><span class="badge ${p.status === 'In Stock' ? 'in-stock' : p.status === 'Low Stock' ? 'low-stock' : 'out-stock'}">${p.status}</span></td>
      <td>
        <div class="action-btns">
          <button class="icon-btn" title="Update Stock" onclick="openStockModal(${p.id}, '${esc(p.name)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7-7 7 7"/></svg>
          </button>
          <button class="icon-btn" title="Edit" onclick="editProduct(${p.id})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn danger" title="Delete" onclick="deleteProduct(${p.id}, '${esc(p.name)}')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function populateCategoryFilter(products) {
  const cats = [...new Set(products.map(p => p.category))].sort();
  const sel = document.getElementById('categoryFilter');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Categories</option>' +
    cats.map(c => `<option value="${esc(c)}" ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

// ─── Add / Edit Product ───────────────────────────────────────────────────────
function clearForm() {
  ['fName', 'fSku', 'fCategory', 'fQty', 'fPrice', 'fSupplier', 'fThreshold', 'fDescription'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('editProductId').value = '';
  document.getElementById('formTitle').textContent = 'Add New Product';
  document.getElementById('saveProductBtn').textContent = 'Save Product';
}

function editProduct(id) {
  const p = state.products.find(x => x.id === id);
  if (!p) return;
  document.getElementById('editProductId').value = p.id;
  document.getElementById('fName').value = p.name;
  document.getElementById('fSku').value = p.sku;
  document.getElementById('fCategory').value = p.category;
  document.getElementById('fQty').value = p.quantity;
  document.getElementById('fPrice').value = p.unit_price;
  document.getElementById('fSupplier').value = p.supplier;
  document.getElementById('fThreshold').value = p.low_stock_threshold;
  document.getElementById('fDescription').value = p.description;
  document.getElementById('formTitle').textContent = `Edit: ${p.name}`;
  document.getElementById('saveProductBtn').textContent = 'Update Product';
  switchPanel('add');
}

async function saveProduct() {
  const editId = document.getElementById('editProductId').value;
  const data = {
    name: document.getElementById('fName').value.trim(),
    sku: document.getElementById('fSku').value.trim(),
    category: document.getElementById('fCategory').value.trim() || 'General',
    quantity: parseInt(document.getElementById('fQty').value) || 0,
    unit_price: parseFloat(document.getElementById('fPrice').value) || 0,
    supplier: document.getElementById('fSupplier').value.trim(),
    low_stock_threshold: parseInt(document.getElementById('fThreshold').value) || 10,
    description: document.getElementById('fDescription').value.trim(),
  };
  if (!data.name || !data.sku) { showToast('Name and SKU are required', 'error'); return; }
  try {
    const url = editId ? `/api/products/${editId}` : '/api/products';
    const method = editId ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await res.json();
    if (!res.ok) { showToast(result.error || 'Failed to save product', 'error'); return; }
    showToast(editId ? `Updated: ${result.name}` : `Added: ${result.name}`, 'success');
    clearForm();
    loadStats();
    loadProducts();
  } catch (e) { showToast('Error saving product', 'error'); }
}

async function deleteProduct(id, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
    const result = await res.json();
    showToast(result.message || 'Deleted', 'success');
    loadStats(); loadProducts();
  } catch (e) { showToast('Error deleting product', 'error'); }
}

// ─── Stock Modal ──────────────────────────────────────────────────────────────
function setupStockModal() {
  document.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentStockAction = btn.dataset.action;
    });
  });
}

function openStockModal(productId, productName) {
  document.getElementById('stockProductId').value = productId;
  document.getElementById('stockModalTitle').textContent = `Update Stock — ${productName}`;
  document.getElementById('stockQty').value = '';
  document.getElementById('stockNote').value = '';
  document.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
  document.querySelector('.btn-toggle[data-action="add"]').classList.add('active');
  state.currentStockAction = 'add';
  document.getElementById('stockModal').classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

async function submitStockUpdate() {
  const productId = document.getElementById('stockProductId').value;
  const qty = parseInt(document.getElementById('stockQty').value);
  const note = document.getElementById('stockNote').value.trim();
  if (!qty || qty <= 0) { showToast('Enter a valid quantity', 'error'); return; }
  try {
    const res = await fetch(`/api/products/${productId}/stock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: state.currentStockAction, quantity: qty, note })
    });
    const result = await res.json();
    if (!res.ok) { showToast(result.error || 'Stock update failed', 'error'); return; }
    showToast(`Stock updated: ${result.old_quantity} → ${result.new_quantity}`, 'success');
    closeModal('stockModal');
    loadStats(); loadProducts();
  } catch (e) { showToast('Error updating stock', 'error'); }
}

// ─── Transactions ─────────────────────────────────────────────────────────────
async function loadTransactions() {
  try {
    const res = await fetch('/api/transactions?limit=100');
    const txs = await res.json();
    const tbody = document.getElementById('transactionTableBody');
    if (!txs.length) { tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">No transactions yet</td></tr>`; return; }
    tbody.innerHTML = txs.map(t => `
      <tr>
        <td style="white-space:nowrap">${formatDate(t.created_at)}</td>
        <td>${esc(t.product_name)}</td>
        <td><span class="badge ${t.transaction_type}">${t.transaction_type}</span></td>
        <td><strong>${t.quantity}</strong></td>
        <td style="color:var(--text3)">${esc(t.note || '—')}</td>
      </tr>
    `).join('');
  } catch (e) { console.error(e); }
}

// ─── Search ───────────────────────────────────────────────────────────────────
function setupSearch() {
  const globalSearch = document.getElementById('globalSearch');
  globalSearch.addEventListener('input', debounce(async () => {
    const q = globalSearch.value.trim();
    if (!q) { renderProductTable(state.products); return; }
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const results = await res.json();
    renderProductTable(results);
    if (document.getElementById('panel-products').classList.contains('active')) return;
    switchPanel('products');
  }, 300));

  document.getElementById('productSearch').addEventListener('input', debounce(async () => {
    const q = document.getElementById('productSearch').value.trim();
    const cat = document.getElementById('categoryFilter').value;
    const url = `/api/search?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}`;
    const res = await fetch(url);
    renderProductTable(await res.json());
  }, 300));

  document.getElementById('categoryFilter').addEventListener('change', async () => {
    const q = document.getElementById('productSearch').value.trim();
    const cat = document.getElementById('categoryFilter').value;
    const url = `/api/search?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}`;
    const res = await fetch(url);
    renderProductTable(await res.json());
  });
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function setupChat() {
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  sendBtn.addEventListener('click', sendMessage);

  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.prompt;
      sendMessage();
    });
  });
}

async function sendMessage(opts = {}) {
  const input = document.getElementById('chatInput');
  const text = opts.text || input.value.trim();
  if (!text) return;

  // Clear welcome screen
  const welcome = document.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  appendMessage('user', text);
  state.chatHistory.push({ role: 'user', content: text });
  input.value = '';
  input.style.height = 'auto';

  const typingId = appendTyping();
  document.getElementById('sendBtn').disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.chatHistory })
    });
    const data = await res.json();
    removeTyping(typingId);

    if (!res.ok) { appendMessage('ai', `⚠️ ${data.error || 'Something went wrong'}`); return; }

    state.chatHistory.push({ role: 'assistant', content: data.message });
    appendMessage('ai', data.message, data.actions_taken);

    // Voice hook: speaks reply if user sent this message via voice
    voice.speakIfActive(data.message);

    if (data.actions_taken?.length) {
      loadStats(); loadProducts(); loadTransactions();
    }
  } catch (e) {
    removeTyping(typingId);
    appendMessage('ai', '⚠️ Network error. Please check your connection.');
  } finally {
    document.getElementById('sendBtn').disabled = false;
  }
}

function appendMessage(role, text, actions = []) {
  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  const avatar = role === 'user'
    ? '<div class="msg-avatar">You</div>'
    : '<div class="msg-avatar">AI</div>';

  // Clean action JSON blocks from display text
  const cleanText = text.replace(/```json[\s\S]*?```/g, '').trim();
  const formattedText = formatMarkdown(cleanText);

  // Build action badges
  let actionBadges = '';
  if (actions?.length) {
    actionBadges = actions.map(a => {
      if (a.status === 'success') {
        const label = a.action === 'create_product' ? `✓ Created: ${a.product?.name}`
          : a.action === 'update_stock' ? `✓ Stock: ${a.old_quantity} → ${a.new_quantity}`
          : a.action === 'delete_product' ? `✓ ${a.message}`
          : a.action === 'update_product' ? `✓ Updated: ${a.product?.name}`
          : `✓ ${a.action}`;
        return `<span class="action-badge">${label}</span>`;
      } else {
        return `<span class="action-badge error">✗ ${a.message || a.action}</span>`;
      }
    }).join('');
    actionBadges = `<div style="margin-top:10px">${actionBadges}</div>`;
  }

  div.innerHTML = `${avatar}<div class="msg-bubble">${formattedText}${actionBadges}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function appendTyping() {
  const container = document.getElementById('chatMessages');
  const id = 'typing-' + Date.now();
  const div = document.createElement('div');
  div.className = 'msg ai'; div.id = id;
  div.innerHTML = '<div class="msg-avatar">AI</div><div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeTyping(id) {
  document.getElementById(id)?.remove();
}

function formatMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h4 style="color:#fff;margin:12px 0 6px;font-family:Syne,sans-serif">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 style="color:#fff;margin:14px 0 8px;font-family:Syne,sans-serif">$1</h3>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function confirmClearData() {
  if (confirm('This will DELETE ALL products and transactions. Are you sure?')) {
    showToast('Reset not implemented in demo mode', 'error');
  }
}

function showStatus(elId, msg, type) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.className = `status-msg ${type}`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  setTimeout(() => toast.classList.remove('show'), 3200);
}

function formatCurrency(val) {
  return '$' + (parseFloat(val) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function esc(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}



// ══════════════════════════════════════════════════════════════════════════════
// ─── VOICE MODULE ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
//
//  RULE: text input → text reply only (no change to existing behaviour)
//        voice input → AI reply shown as text in chat AND spoken aloud
//
//  Flow:
//    1. User presses 🎙️ mic button → MediaRecorder captures audio
//    2. Audio  → POST /api/voice/transcribe  (Groq Whisper STT)
//    3. Transcribed text → existing sendMessage() → /api/chat  (unchanged)
//    4. AI reply text → shown in chat bubble (existing appendMessage)
//       AND → POST /api/voice/speak  (Groq TTS, or browser Speech fallback)
//    5. Browser plays audio response
//
// ─────────────────────────────────────────────────────────────────────────────

const voice = {
  active: false,         // true while a voice-originated message is in flight
  mediaRecorder: null,
  chunks: [],
  currentAudio: null,
};

// Called by sendMessage() after every AI reply.
// Only speaks if the current message was sent via voice.
voice.speakIfActive = function(text) {
  if (!voice.active) return;
  voice.active = false;
  speakReply(text);
};

// ─── UI setup ────────────────────────────────────────────────────────────────
function setupVoice() {
  const wrap = document.querySelector('.chat-input-wrap');
  if (!wrap) return;

  // Mic button — hold to record
  const micBtn = document.createElement('button');
  micBtn.id    = 'micBtn';
  micBtn.className = 'mic-btn';
  micBtn.title = 'Hold to speak — ARIA will reply with voice';
  micBtn.innerHTML = `
    <svg class="mic-idle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
      <rect x="9" y="2" width="6" height="12" rx="3"/>
      <path d="M5 10a7 7 0 0014 0M12 19v3M8 22h8"/>
    </svg>
    <svg class="mic-rec" viewBox="0 0 24 24" fill="currentColor" style="display:none">
      <circle cx="12" cy="12" r="8" opacity="0.25"/>
      <circle cx="12" cy="12" r="4"/>
    </svg>`;

  // Status label shown above the input while recording / processing
  const pill = document.createElement('div');
  pill.id        = 'voiceStatus';
  pill.className = 'voice-status';
  pill.style.display = 'none';

  // Insert mic before send button; pill above the input area
  wrap.insertBefore(micBtn, wrap.querySelector('#sendBtn'));
  document.querySelector('.chat-input-area').prepend(pill);

  // Hold to record (mouse + touch)
  micBtn.addEventListener('mousedown',  voiceStart);
  micBtn.addEventListener('touchstart', e => { e.preventDefault(); voiceStart(); }, { passive: false });
  micBtn.addEventListener('mouseup',    voiceStop);
  micBtn.addEventListener('mouseleave', voiceStop);
  micBtn.addEventListener('touchend',   voiceStop);
}

// ─── Recording ───────────────────────────────────────────────────────────────
async function voiceStart() {
  if (voice.mediaRecorder) return;   // already recording
  // Stop any currently playing reply so we don't record it
  if (voice.currentAudio) { voice.currentAudio.pause(); voice.currentAudio = null; }

  try {
    const stream   = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = getSupportedMime();
    voice.chunks   = [];
    voice.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    voice.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) voice.chunks.push(e.data); };
    voice.mediaRecorder.onstop = onRecordingDone;
    voice.mediaRecorder.start();

    setVoiceStatus('🔴 Listening… release to send', 'recording');
    document.getElementById('micBtn').classList.add('recording');
    document.getElementById('micBtn').querySelector('.mic-idle').style.display = 'none';
    document.getElementById('micBtn').querySelector('.mic-rec').style.display  = '';
  } catch {
    showToast('Microphone access denied', 'error');
  }
}

function voiceStop() {
  if (!voice.mediaRecorder) return;
  voice.mediaRecorder.stop();
  voice.mediaRecorder.stream.getTracks().forEach(t => t.stop());
  voice.mediaRecorder = null;

  setVoiceStatus('⏳ Transcribing…', 'processing');
  document.getElementById('micBtn').classList.remove('recording');
  document.getElementById('micBtn').querySelector('.mic-idle').style.display = '';
  document.getElementById('micBtn').querySelector('.mic-rec').style.display  = 'none';
}

async function onRecordingDone() {
  const mimeType = getSupportedMime();
  const blob = new Blob(voice.chunks, { type: mimeType || 'audio/webm' });
  voice.chunks = [];

  if (blob.size < 1000) {
    setVoiceStatus('', '');
    showToast('Recording too short — hold the mic longer', 'error');
    return;
  }

  // ── Step 1: Transcribe ───────────────────────────────────────────────────
  try {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
    const fd  = new FormData();
    fd.append('audio', blob, `voice.${ext}`);

    const res  = await fetch('/api/voice/transcribe', { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok || data.error) {
      setVoiceStatus('', '');
      showToast('Transcription failed: ' + (data.error || 'unknown error'), 'error');
      return;
    }

    const text = (data.text || '').trim();
    if (!text) {
      setVoiceStatus('', '');
      showToast('Could not understand speech', 'error');
      return;
    }

    // Show what was heard in the status pill briefly
    setVoiceStatus(`🎙️ "${text}"`, 'heard');

    // ── Step 2: Send to AI via existing sendMessage() ─────────────────────
    //    We flag voice.active = true so speakIfActive() fires on the reply
    voice.active = true;
    document.getElementById('chatInput').value = text;

    setTimeout(() => {
      setVoiceStatus('', '');
      sendMessage({ text });           // existing function, unchanged
    }, 500);

  } catch (err) {
    setVoiceStatus('', '');
    showToast('Voice error: ' + err.message, 'error');
  }
}

// ─── TTS: speak the AI reply ─────────────────────────────────────────────────
async function speakReply(text) {
  setVoiceStatus('🔊 ARIA is speaking…', 'speaking');

  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    // If server returned JSON (error / fallback signal), use browser TTS
    const contentType = res.headers.get('Content-Type') || '';
    if (!res.ok || contentType.includes('application/json')) {
      const errData = await res.json().catch(() => ({}));
      // use_browser_tts flag means Groq TTS unavailable → fall back gracefully
      if (errData.use_browser_tts || errData.error) {
        setVoiceStatus('', '');
        browserTTS(text);
        return;
      }
      setVoiceStatus('', '');
      showToast('TTS failed', 'error');
      return;
    }

    // Got audio stream → play it
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const audio = new Audio(url);
    voice.currentAudio = audio;

    audio.onended = () => {
      URL.revokeObjectURL(url);
      voice.currentAudio = null;
      setVoiceStatus('', '');
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      voice.currentAudio = null;
      setVoiceStatus('', '');
      showToast('Audio playback error — trying browser voice', 'error');
      browserTTS(text);
    };
    audio.play().catch(() => {
      // Autoplay blocked → fall back to browser TTS
      setVoiceStatus('', '');
      browserTTS(text);
    });

  } catch {
    setVoiceStatus('', '');
    browserTTS(text);
  }
}

// ─── Browser Web Speech API fallback ─────────────────────────────────────────
function browserTTS(text) {
  if (!window.speechSynthesis) return;
  // Clean markdown before speaking
  const clean = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,4}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  window.speechSynthesis.cancel();
  const utt  = new SpeechSynthesisUtterance(clean);
  utt.rate   = 1.0;
  utt.pitch  = 1.05;
  utt.lang   = 'en-US';
  // Prefer a female voice if available
  const voices = window.speechSynthesis.getVoices();
  const female = voices.find(v => /female|woman|girl|zira|samantha|karen|victoria/i.test(v.name));
  if (female) utt.voice = female;
  setVoiceStatus('🔊 Speaking (browser)…', 'speaking');
  utt.onend = () => setVoiceStatus('', '');
  window.speechSynthesis.speak(utt);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setVoiceStatus(msg, type) {
  const el = document.getElementById('voiceStatus');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; el.className = 'voice-status'; return; }
  el.textContent = msg;
  el.className   = `voice-status ${type}`;
  el.style.display = 'block';
}

function getSupportedMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of types) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}