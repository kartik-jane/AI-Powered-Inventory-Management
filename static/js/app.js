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

  function updateSendBtn() {
    // Only show send btn if not in voice mode and there's text
    if (!voice.active) {
      sendBtn.style.display = input.value.trim() ? '' : 'none';
    }
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    updateSendBtn();
  });
  sendBtn.addEventListener('click', sendMessage);

  document.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.prompt;
      updateSendBtn();
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
  // hide send btn since input is now empty
  document.getElementById('sendBtn').style.display = 'none';

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
      await Promise.all([loadStats(), loadProducts(), loadTransactions()]);
      // Sync the Add/Edit Product form for any successful CRUD action
      syncFormFromActions(data.actions_taken);
    }
  } catch (e) {
    removeTyping(typingId);
    appendMessage('ai', '⚠️ Network error. Please check your connection.');
  } finally {
    document.getElementById('sendBtn').disabled = false;
  }
}

/**
 * After AI executes a CRUD action, populate the Add Product form
 * so the Products section always reflects the latest state.
 * Call this AFTER await loadProducts() so state.products is fresh.
 */
function syncFormFromActions(actions) {
  for (const a of actions) {
    if (a.status !== 'success') continue;

    if (a.action === 'create_product' && a.product) {
      // After loadProducts() the product is now in state.products — populate form
      const fresh = state.products.find(x => x.id === a.product.id) || a.product;
      populateEditForm(fresh);

    } else if (a.action === 'update_product' && a.product) {
      // Always refresh the form with updated data
      const fresh = state.products.find(x => x.id === a.product.id) || a.product;
      populateEditForm(fresh);

    } else if (a.action === 'delete_product') {
      // Clear the form — product no longer exists
      clearForm();

    } else if (a.action === 'update_stock') {
      // Find the product in the freshly loaded list by matching the form's current edit id
      // or by product_id in the action
      const targetId = a.product_id || parseInt(document.getElementById('editProductId').value);
      if (targetId) {
        const fresh = state.products.find(x => x.id === targetId);
        if (fresh) populateEditForm(fresh);
      }
    }
  }
}

/**
 * Populate the Add Product form in edit mode with a product object.
 * Mirrors editProduct() but works from a product dict directly.
 */
function populateEditForm(p) {
  document.getElementById('editProductId').value  = p.id;
  document.getElementById('fName').value          = p.name || '';
  document.getElementById('fSku').value           = p.sku  || '';
  document.getElementById('fCategory').value      = p.category || '';
  document.getElementById('fQty').value           = p.quantity ?? 0;
  document.getElementById('fPrice').value         = p.unit_price ?? 0;
  document.getElementById('fSupplier').value      = p.supplier || '';
  document.getElementById('fThreshold').value     = p.low_stock_threshold ?? 10;
  document.getElementById('fDescription').value   = p.description || '';
  document.getElementById('formTitle').textContent       = `Edit: ${p.name}`;
  document.getElementById('saveProductBtn').textContent  = 'Update Product';
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

  // Build action badges + product cards
  let actionBadges = '';
  if (actions?.length) {
    actionBadges = actions.map(a => {
      if (a.status === 'success') {
        let label = '';
        let productCard = '';

        if (a.action === 'create_product' && a.product) {
          label = `✓ Created: ${a.product.name}`;
          productCard = buildProductCard(a.product, 'created');
        } else if (a.action === 'update_stock') {
          label = `✓ Stock: ${a.old_quantity} → ${a.new_quantity}`;
        } else if (a.action === 'delete_product') {
          label = `✓ ${a.message}`;
        } else if (a.action === 'update_product' && a.product) {
          label = `✓ Updated: ${a.product.name}`;
          productCard = buildProductCard(a.product, 'updated');
        } else {
          label = `✓ ${a.action}`;
        }

        return `<span class="action-badge">${label}</span>${productCard}`;
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

/**
 * Build a compact product detail card shown inline in the chat after CRUD.
 */
function buildProductCard(p, mode) {
  const statusClass = p.status === 'In Stock' ? 'in-stock' : p.status === 'Low Stock' ? 'low-stock' : 'out-stock';
  const modeLabel   = mode === 'created' ? '🆕 New Product' : '✏️ Updated Product';
  return `
    <div class="product-inline-card">
      <div class="pic-header">
        <span class="pic-mode">${modeLabel}</span>
        <span class="badge ${statusClass}">${p.status}</span>
      </div>
      <div class="pic-body">
        <div class="pic-row"><span class="pic-label">Name</span><span class="pic-val">${esc(p.name)}</span></div>
        <div class="pic-row"><span class="pic-label">SKU</span><code class="pic-code">${esc(p.sku)}</code></div>
        <div class="pic-row"><span class="pic-label">Category</span><span class="pic-val">${esc(p.category)}</span></div>
        <div class="pic-row"><span class="pic-label">Quantity</span><span class="pic-val">${p.quantity}</span></div>
        <div class="pic-row"><span class="pic-label">Price</span><span class="pic-val">${formatCurrency(p.unit_price)}</span></div>
        ${p.supplier ? `<div class="pic-row"><span class="pic-label">Supplier</span><span class="pic-val">${esc(p.supplier)}</span></div>` : ''}
      </div>
      <button class="pic-edit-btn" onclick="editProduct(${p.id});switchPanel('add')">✏️ Edit in Form</button>
    </div>`;
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
// ─── VOICE MODULE (Auto-cycle conversation — ChatGPT/Gemini style) ────────────
// ══════════════════════════════════════════════════════════════════════════════
//
//  NEW FLOW:
//    1. User clicks inline 🎙️ button → dialog opens, session starts
//    2. ARIA auto-starts listening via MediaRecorder + Web Audio silence detection
//    3. When user stops speaking for ~2.5s → recording stops automatically
//    4. Audio → POST /api/voice/transcribe  (Groq Whisper STT)
//    5. Text shown on screen → POST /api/voice/chat  (concise AI reply)
//    6. AI reply shown + spoken via Groq TTS / browser TTS
//    7. After speaking → auto-starts listening again (loop continues)
//    8. User clicks "Stop Conversation" button → session ends cleanly
//
//  The inline button ONLY starts/ends the session — no per-message clicks needed.
//
// ─────────────────────────────────────────────────────────────────────────────

const voice = {
  active: false,           // true = session is running (auto-cycle loop active)
  mediaRecorder: null,
  chunks: [],
  currentAudio: null,
  history: [],             // voice-specific chat history
  isOpen: false,
  isBusy: false,           // true while processing (transcribe/think/speak)
  // Web Audio silence detection
  audioCtx: null,
  analyser: null,
  silenceTimer: null,
  stream: null,
  SILENCE_THRESHOLD: 10,   // RMS below this = silence (0–255 scale)
  SILENCE_DELAY_MS: 2500,  // ms of silence before auto-stop
};

// Stub so sendMessage() won't break
voice.speakIfActive = function() {};

// ─── Dialog open / close ──────────────────────────────────────────────────────
function openVoiceDialog() {
  voice.isOpen = true;
  // Show inline voice bar, hide send btn, show stop btn
  const bar = document.getElementById('voiceInlineBar');
  const stopBtn = document.getElementById('voiceStopInlineBtn');
  const sendBtn = document.getElementById('sendBtn');
  if (bar) bar.classList.add('active');
  if (stopBtn) stopBtn.style.display = '';
  if (sendBtn) sendBtn.style.display = 'none';
  setVoiceDialogState('idle');
  // Switch to chat panel so messages are visible
  if (!document.getElementById('panel-chat').classList.contains('active')) {
    switchPanel('chat');
  }
}

function closeVoiceDialog() {
  stopVoiceSession();
  voice.isOpen = false;
  const bar = document.getElementById('voiceInlineBar');
  const stopBtn = document.getElementById('voiceStopInlineBtn');
  if (bar) bar.classList.remove('active');
  if (stopBtn) stopBtn.style.display = 'none';
  _syncInlineBtn('idle');
}

// ─── Session start / stop ─────────────────────────────────────────────────────
function startVoiceSession() {
  if (voice.active) return;
  voice.active = true;
  _syncInlineBtn('active');
  _setStopBtn(true);
  // Kick off the first listen cycle
  _voiceListen();
}

function stopVoiceSession() {
  voice.active  = false;
  voice.isBusy  = false;
  // Stop silence detection
  _clearSilenceDetection();
  // Stop recorder
  if (voice.mediaRecorder) {
    try { voice.mediaRecorder.stop(); } catch {}
    voice.stream?.getTracks().forEach(t => t.stop());
    voice.mediaRecorder = null;
    voice.stream = null;
  }
  // Stop audio
  if (voice.currentAudio) { voice.currentAudio.pause(); voice.currentAudio = null; }
  window.speechSynthesis?.cancel();
  _syncInlineBtn('idle');
  _setStopBtn(false);
  setVoiceDialogState('idle');
}

// ─── Core listen cycle ────────────────────────────────────────────────────────
async function _voiceListen() {
  if (!voice.active) return;

  setVoiceDialogState('listening');
  voice.chunks = [];

  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = getSupportedMime();
    voice.mediaRecorder = new MediaRecorder(voice.stream, mimeType ? { mimeType } : {});
    voice.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) voice.chunks.push(e.data); };
    voice.mediaRecorder.onstop = _onListenDone;
    voice.mediaRecorder.start();

    // Start silence detection using Web Audio API
    _startSilenceDetection(voice.stream);

  } catch {
    showToast('Microphone access denied', 'error');
    stopVoiceSession();
  }
}

// ─── Silence detection via Web Audio ─────────────────────────────────────────
function _startSilenceDetection(stream) {
  try {
    voice.audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
    voice.analyser  = voice.audioCtx.createAnalyser();
    voice.analyser.fftSize = 512;
    const source = voice.audioCtx.createMediaStreamSource(stream);
    source.connect(voice.analyser);

    const buf = new Uint8Array(voice.analyser.fftSize);
    let silenceStart = null;
    let hasSpeech    = false;   // must detect speech before triggering silence-stop

    const check = () => {
      if (!voice.mediaRecorder || voice.mediaRecorder.state !== 'recording') return;

      voice.analyser.getByteTimeDomainData(buf);
      // RMS energy
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buf.length) * 255;

      if (rms > voice.SILENCE_THRESHOLD) {
        hasSpeech    = true;
        silenceStart = null;
      } else if (hasSpeech) {
        // Speech detected before — now counting silence
        if (!silenceStart) silenceStart = Date.now();
        if (Date.now() - silenceStart >= voice.SILENCE_DELAY_MS) {
          // Auto-stop recording
          _clearSilenceDetection();
          _stopRecording();
          return;
        }
      }
      voice.silenceTimer = requestAnimationFrame(check);
    };
    voice.silenceTimer = requestAnimationFrame(check);
  } catch {
    // Web Audio not available — fall back to a fixed 8s max recording
    voice.silenceTimer = setTimeout(() => _stopRecording(), 8000);
  }
}

function _clearSilenceDetection() {
  if (voice.silenceTimer) {
    cancelAnimationFrame(voice.silenceTimer);
    clearTimeout(voice.silenceTimer);
    voice.silenceTimer = null;
  }
  if (voice.audioCtx) {
    try { voice.audioCtx.close(); } catch {}
    voice.audioCtx = null;
    voice.analyser = null;
  }
}

function _stopRecording() {
  if (!voice.mediaRecorder) return;
  if (voice.mediaRecorder.state === 'recording') {
    voice.mediaRecorder.stop();
  }
  voice.stream?.getTracks().forEach(t => t.stop());
  voice.mediaRecorder = null;
  voice.stream = null;
  setVoiceDialogState('transcribing');
}

// ─── After recording stops ────────────────────────────────────────────────────
async function _onListenDone() {
  if (!voice.active) return;  // Session was stopped mid-flight

  voice.isBusy = true;
  const mimeType = getSupportedMime();
  const blob = new Blob(voice.chunks, { type: mimeType || 'audio/webm' });
  voice.chunks = [];

  if (blob.size < 1000) {
    // Too short / silence only — restart listening
    voice.isBusy = false;
    if (voice.active) _voiceListen();
    return;
  }

  try {
    // ── Step 1: Transcribe ────────────────────────────────────────────────────
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
    const fd  = new FormData();
    fd.append('audio', blob, `voice.${ext}`);

    const res  = await fetch('/api/voice/transcribe', { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok || data.error || !data.text?.trim()) {
      // Transcription failed or empty — silently restart listening
      voice.isBusy = false;
      if (voice.active) _voiceListen();
      return;
    }

    const text = data.text.trim();
    appendVoiceTranscript('user', text);

    // ── Step 2: AI response ───────────────────────────────────────────────────
    setVoiceDialogState('thinking');
    voice.history.push({ role: 'user', content: text });

    const aiRes  = await fetch('/api/voice/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: voice.history })
    });
    const aiData = await aiRes.json();

    if (!aiRes.ok || aiData.error) {
      voice.isBusy = false;
      showToast('AI error: ' + (aiData.error || 'unknown'), 'error');
      if (voice.active) _voiceListen();
      return;
    }

    const reply = aiData.message || '';
    voice.history.push({ role: 'assistant', content: reply });
    appendVoiceTranscript('aria', reply);

    // Mirror to main chat
    appendMessage('user', text);
    state.chatHistory.push({ role: 'user', content: text });
    appendMessage('ai', reply, aiData.actions_taken);
    state.chatHistory.push({ role: 'assistant', content: reply });

    if (aiData.actions_taken?.length) {
      await Promise.all([loadStats(), loadProducts(), loadTransactions()]);
      // Sync the Add/Edit Product form for any successful voice CRUD action
      syncFormFromActions(aiData.actions_taken);
    }

    // ── Step 3: Speak, then loop back to listen ───────────────────────────────
    await speakVoiceReply(reply);

  } catch (err) {
    voice.isBusy = false;
    showToast('Voice error: ' + err.message, 'error');
    if (voice.active) _voiceListen();
  }
}

// ─── TTS — after speaking, auto-restart listening ────────────────────────────
async function speakVoiceReply(text) {
  setVoiceDialogState('speaking');
  const cleanText = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,4}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);

  const onDone = () => {
    voice.isBusy = false;
    // Auto-restart listening for next question
    if (voice.active) {
      _voiceListen();
    } else {
      setVoiceDialogState('idle');
    }
  };

  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cleanText })
    });

    const contentType = res.headers.get('Content-Type') || '';
    if (!res.ok || contentType.includes('application/json')) {
      await res.json().catch(() => ({}));
      browserTTS(cleanText, onDone);
      return;
    }

    const blob  = await res.blob();
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    voice.currentAudio = audio;

    audio.onended = () => {
      URL.revokeObjectURL(url);
      voice.currentAudio = null;
      onDone();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      voice.currentAudio = null;
      browserTTS(cleanText, onDone);
    };
    audio.play().catch(() => browserTTS(cleanText, onDone));
  } catch {
    browserTTS(cleanText, onDone);
  }
}

function browserTTS(text, onDone) {
  if (!window.speechSynthesis) { onDone?.(); return; }
  window.speechSynthesis.cancel();
  const utt   = new SpeechSynthesisUtterance(text.slice(0, 500));
  utt.rate    = 1.0;
  utt.pitch   = 1.05;
  utt.lang    = 'en-US';
  const voices = window.speechSynthesis.getVoices();
  const female = voices.find(v => /female|woman|zira|samantha|karen|victoria/i.test(v.name));
  if (female) utt.voice = female;
  utt.onend   = () => onDone?.();
  utt.onerror = () => onDone?.();
  window.speechSynthesis.speak(utt);
}

// ─── State labels ─────────────────────────────────────────────────────────────
function setVoiceDialogState(state) {
  // Legacy overlay elements (hidden but kept for compat)
  const avatar   = document.getElementById('voiceAvatar');
  const label    = document.getElementById('voiceStateLabel');
  const waveform = document.getElementById('voiceWaveform');
  if (avatar)   avatar.className   = 'voice-avatar';
  if (waveform) waveform.className = 'voice-waveform';

  // Inline bar elements
  const inlineAvatar = document.getElementById('voiceInlineAvatar');
  const inlineLabel  = document.getElementById('voiceInlineLabel');
  const inlineWave   = document.getElementById('voiceInlineWave');

  const states = {
    idle:         { label: 'Click 🎙️ to start conversation', avatarClass: '',           waveClass: '' },
    listening:    { label: '🎙️ Listening…',                  avatarClass: 'recording',  waveClass: 'active recording' },
    transcribing: { label: '⏳ Processing…',                  avatarClass: 'processing', waveClass: 'active processing' },
    thinking:     { label: '💭 ARIA is thinking…',            avatarClass: 'thinking',   waveClass: 'active thinking' },
    speaking:     { label: '🔊 ARIA is speaking…',            avatarClass: 'speaking',   waveClass: 'active speaking' },
  };
  const s = states[state] || states.idle;

  if (label) label.textContent = s.label;
  if (s.avatarClass && avatar) avatar.classList.add(s.avatarClass);
  if (s.waveClass && waveform) s.waveClass.split(' ').forEach(c => waveform.classList.add(c));

  // Drive inline bar
  if (inlineLabel) inlineLabel.textContent = s.label;
  if (inlineAvatar) {
    inlineAvatar.className = 'voice-inline-avatar';
    if (s.avatarClass) inlineAvatar.classList.add(s.avatarClass);
  }
  if (inlineWave) {
    inlineWave.className = 'voice-waveform voice-inline-wave';
    if (s.waveClass) s.waveClass.split(' ').forEach(c => inlineWave.classList.add(c));
  }
}

// ─── Transcript helpers ───────────────────────────────────────────────────────
function appendVoiceTranscript(role, text) {
  const inner = document.getElementById('voiceTranscriptInner');
  if (!inner) return;
  inner.querySelector('.voice-hint-text')?.remove();

  const cleanText = text.replace(/```json[\s\S]*?```/g, '').trim();
  const div = document.createElement('div');
  div.className = `vtx-msg vtx-${role}`;
  div.innerHTML = `<span class="vtx-label">${role === 'user' ? 'You' : 'ARIA'}</span><p>${esc(cleanText)}</p>`;
  inner.appendChild(div);
  inner.scrollTop = inner.scrollHeight;
}

// ─── UI Setup ─────────────────────────────────────────────────────────────────
function setupVoice() {
  // Inline mic button — one click starts the whole session
  document.getElementById('voiceInlineBtn')?.addEventListener('click', () => {
    if (!voice.isOpen) {
      openVoiceDialog();
      setTimeout(() => startVoiceSession(), 200);
    } else if (!voice.active) {
      startVoiceSession();
    }
    // If session already active, do nothing (stop is the inline stop btn)
  });

  // Inline stop button (replaces send btn during voice)
  document.getElementById('voiceStopInlineBtn')?.addEventListener('click', closeVoiceDialog);

  // Legacy dialog buttons (overlay is hidden but keep so JS doesn't break)
  document.getElementById('voiceDialogClose')?.addEventListener('click', closeVoiceDialog);
  document.getElementById('voiceStopBtn')?.addEventListener('click', stopVoiceSession);
  document.getElementById('voiceDialogClear')?.addEventListener('click', clearVoiceConversation);
  document.getElementById('voiceOverlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('voiceOverlay')) closeVoiceDialog();
  });
}

// ─── Clear voice conversation ─────────────────────────────────────────────────
function clearVoiceConversation() {
  const wasActive = voice.active;
  stopVoiceSession();
  voice.history = [];
  const inner = document.getElementById('voiceTranscriptInner');
  if (inner) inner.innerHTML = '<p class="voice-hint-text">Speak your question — ARIA will auto-reply and keep listening</p>';
  showToast('Voice conversation cleared', 'info');
  // If session was running, restart it
  if (wasActive) setTimeout(() => startVoiceSession(), 300);
}

// ─── Sync inline button visual ────────────────────────────────────────────────
function _syncInlineBtn(state) {
  const btn = document.getElementById('voiceInlineBtn');
  if (!btn) return;
  const idle = btn.querySelector('.mic-idle-i');
  const rec  = btn.querySelector('.mic-rec-i');
  btn.classList.remove('recording', 'busy', 'active');
  if (state === 'active') {
    btn.classList.add('active');
    if (idle) idle.style.display = 'none';
    if (rec)  rec.style.display  = '';
  } else if (state === 'busy') {
    btn.classList.add('busy');
    if (idle) idle.style.display = '';
    if (rec)  rec.style.display  = 'none';
  } else {
    if (idle) idle.style.display = '';
    if (rec)  rec.style.display  = 'none';
  }
}

// ─── Enable / disable Stop button ────────────────────────────────────────────
function _setStopBtn(active) {
  const btn = document.getElementById('voiceStopBtn');
  if (!btn) return;
  btn.classList.toggle('active', active);
  btn.disabled = !active;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getSupportedMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of types) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

// Legacy stubs — keep so nothing elsewhere breaks
function setVoiceStatus() {}
function voiceStart() {}
function voiceStop() {}
function voiceDialogToggle() {}
function voiceDialogStart() { startVoiceSession(); }
function voiceDialogStop()  { stopVoiceSession(); }