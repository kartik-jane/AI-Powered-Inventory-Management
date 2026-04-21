// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  chatHistory: [],
  currentStockAction: 'add',
  products: [],
  txPage: 1,
  charts: {},
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadMe();
  loadStats();
  setupNav();
  setupSearch();
  setupStockModal();
  // Page-specific inits are handled by each template's inline <script>
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
async function loadMe() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { window.location.href = '/login'; return; }
    const d = await res.json();
    const el = document.getElementById('usernameDisplay');
    if (el) el.textContent = d.username + ' (' + d.role + ')';
  } catch (e) { console.error(e); }
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function setupNav() {
  const sidebar = document.getElementById('sidebar');
  const main = document.querySelector('.main');

  // Restore saved state on every page load
  if (localStorage.getItem('sidebarCollapsed') === 'true') {
    sidebar?.classList.add('collapsed');
    main?.classList.add('sidebar-collapsed');
  }

  document.getElementById('sidebarToggle')?.addEventListener('click', () => {
    const isCollapsed = sidebar.classList.toggle('collapsed');
    main?.classList.toggle('sidebar-collapsed', isCollapsed);
    localStorage.setItem('sidebarCollapsed', isCollapsed);
  });

  document.getElementById('mobileMenu')?.addEventListener('click', () => {
    sidebar?.classList.toggle('open');
  });
}

// switchPanel: kept for any internal calls; maps panel names → page URLs
function switchPanel(name) {
  const routes = {
    chat: '/chat',
    analytics: '/analytics',
    products: '/products',
    add: '/add-product',
    transactions: '/transactions',
    import: '/import-export',
    warehouses: '/warehouses',
    notifications: '/chat',  // notifications shown on chat page (bell icon)
  };
  if (routes[name]) window.location.href = routes[name];
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

    // Update KPI row if analytics panel has been initialized
    const kpiVal = document.getElementById('kpiValue');
    if (kpiVal) kpiVal.textContent = formatCurrency(data.total_value);
    const kpiProfit = document.getElementById('kpiProfit');
    if (kpiProfit) kpiProfit.textContent = formatCurrency(data.estimated_profit);

    const alertCount = data.low_stock_count + data.out_of_stock_count + (data.expiring_soon?.length || 0);
    const el = document.getElementById('alertCount');
    el.textContent = alertCount;
    el.style.display = alertCount > 0 ? 'flex' : 'none';
  } catch (e) { console.error(e); }
}

// ─── Analytics ────────────────────────────────────────────────────────────────
async function loadAnalytics() {
  const days = document.getElementById('analyticsPeriod')?.value || 30;
  try {
    const [statsRes, analyticsRes, supplierRes] = await Promise.all([
      fetch('/api/stats'),
      fetch(`/api/analytics?days=${days}`),
      fetch('/api/analytics/supplier'),
    ]);
    const stats = await statsRes.json();
    const analytics = await analyticsRes.json();
    const supplierData = await supplierRes.json();

    // KPI cards
    document.getElementById('kpiValue').textContent = formatCurrency(stats.total_value);
    document.getElementById('kpiProfit').textContent = formatCurrency(stats.estimated_profit);
    document.getElementById('kpiTurnover').textContent = analytics.turnover_rate + 'x';
    document.getElementById('kpiDead').textContent = analytics.dead_stock.length;

    // Category chart
    buildCategoryChart(stats.categories);

    // Status chart
    buildStatusChart(
      stats.total_products - stats.low_stock_count - stats.out_of_stock_count,
      stats.low_stock_count,
      stats.out_of_stock_count
    );

    // Predictions
    renderPredictions(analytics.stock_predictions);

    // Fast movers
    renderFastMovers(analytics.fast_movers);

    // Dead stock
    renderDeadStock(analytics.dead_stock);

    // Suppliers
    renderSuppliers(supplierData.suppliers);

  } catch (e) { console.error(e); }
}

function buildCategoryChart(categories) {
  const ctx = document.getElementById('categoryChart');
  if (!ctx) return;
  if (state.charts.category) state.charts.category.destroy();

  const labels = Object.keys(categories);
  const vals = labels.map(k => categories[k].count);
  const colors = ['#7b5ea7','#4ecdc4','#52e3a8','#ffd166','#ff6b6b','#9b6dff','#45b7d1'];

  state.charts.category = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: vals, backgroundColor: colors.slice(0, labels.length), borderWidth: 0, hoverOffset: 6 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#9a9bb0', font: { size: 12 } } },
        tooltip: { callbacks: { label: (c) => ` ${c.label}: ${c.raw} products` } }
      },
      cutout: '65%',
    }
  });
}

function buildStatusChart(inStock, low, out) {
  const ctx = document.getElementById('statusChart');
  if (!ctx) return;
  if (state.charts.status) state.charts.status.destroy();

  state.charts.status = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['In Stock', 'Low Stock', 'Out of Stock'],
      datasets: [{
        data: [inStock, low, out],
        backgroundColor: ['rgba(82,227,168,0.7)', 'rgba(255,209,102,0.7)', 'rgba(255,107,107,0.7)'],
        borderRadius: 8, borderWidth: 0,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: '#9a9bb0' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#9a9bb0' }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
      },
      plugins: { legend: { display: false } }
    }
  });
}

function renderPredictions(predictions) {
  const el = document.getElementById('predictionList');
  if (!predictions.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:0.85rem">No urgent predictions. Inventory looks healthy!</p>';
    return;
  }
  el.innerHTML = predictions.map(p => {
    const urgencyColor = p.urgency === 'critical' ? 'var(--red)' : p.urgency === 'soon' ? 'var(--yellow)' : 'var(--cyan)';
    const urgencyIcon = p.urgency === 'critical' ? '🔴' : p.urgency === 'soon' ? '🟡' : '🟢';
    return `<div class="intel-item">
      <div class="intel-item-name">${urgencyIcon} <strong>${esc(p.name)}</strong></div>
      <div class="intel-item-detail">
        ${p.days_until_stockout} days of stock left · Reorder in <strong>${p.reorder_in_days}d</strong>
      </div>
      <div class="intel-item-sub" style="color:${urgencyColor}">
        Suggested: <strong>${p.suggested_reorder_qty} units</strong> · Daily usage: ${p.daily_usage}/day
      </div>
    </div>`;
  }).join('');
}

function renderFastMovers(movers) {
  const el = document.getElementById('fastMoverList');
  if (!movers.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:0.85rem">No movement data yet. Add some transactions!</p>';
    return;
  }
  el.innerHTML = movers.map((m, i) => `
    <div class="intel-item">
      <div class="intel-item-name"><span style="color:var(--text3)">#${i+1}</span> <strong>${esc(m.name)}</strong></div>
      <div class="intel-item-detail">${m.units_out} units out · ${m.units_in} units in</div>
      <div class="intel-item-sub">Current stock: ${m.current_qty}</div>
    </div>
  `).join('');
}

function renderDeadStock(dead) {
  const el = document.getElementById('deadStockList');
  if (!dead.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:0.85rem">No dead stock detected. Great!</p>';
    return;
  }
  el.innerHTML = dead.map(d => `
    <div class="intel-item">
      <div class="intel-item-name">💀 <strong>${esc(d.name)}</strong></div>
      <div class="intel-item-detail">${d.quantity} units · ${formatCurrency(d.value)} tied up</div>
      <div class="intel-item-sub" style="color:var(--yellow)">No movement in period — consider markdown or promotion</div>
    </div>
  `).join('');
}

function renderSuppliers(suppliers) {
  const el = document.getElementById('supplierList');
  const entries = Object.entries(suppliers);
  if (!entries.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:0.85rem">No supplier data.</p>';
    return;
  }
  el.innerHTML = entries.map(([name, data]) => `
    <div class="intel-item">
      <div class="intel-item-name">🏭 <strong>${esc(name)}</strong></div>
      <div class="intel-item-detail">${data.products} products · ${formatCurrency(data.total_value)} value</div>
      ${data.low_stock_products > 0
        ? `<div class="intel-item-sub" style="color:var(--yellow)">${data.low_stock_products} product(s) low — consider reordering</div>`
        : `<div class="intel-item-sub" style="color:var(--green)">All products adequately stocked</div>`}
    </div>
  `).join('');
}

// ─── Products ─────────────────────────────────────────────────────────────────
async function loadProducts() {
  try {
    let url = '/api/products?per_page=200';
    if (typeof _activeWarehouseId !== 'undefined' && _activeWarehouseId) {
      url += `&warehouse_id=${_activeWarehouseId}`;
    }
    const res = await fetch(url);
    const data = await res.json();
    state.products = data.products || data;
    renderProductTable(state.products);
    populateCategoryFilter(state.products);
  } catch (e) { console.error(e); }
}

function renderProductTable(products) {
  const tbody = document.getElementById('productTableBody');
  if (!products.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="loading-cell">No products found. Ask ARIA to add some!</td></tr>`;
    return;
  }
  tbody.innerHTML = products.map(p => {
    const expiryBadge = p.expiry_status
      ? `<span class="badge ${p.expiry_status === 'Expired' ? 'out-stock' : p.expiry_status.startsWith('Expiring') ? 'low-stock' : 'in-stock'}">${esc(p.expiry_status)}</span>`
      : '<span style="color:var(--text3)">—</span>';
    const img = p.image_filename
      ? `<img src="/static/uploads/${esc(p.image_filename)}" style="width:32px;height:32px;object-fit:cover;border-radius:6px;margin-right:8px;vertical-align:middle">`
      : '';
    return `
    <tr>
      <td><div style="display:flex;align-items:center">${img}<div><strong style="color:var(--text)">${esc(p.name)}</strong><br><small style="color:var(--text3)">${esc(p.supplier || '')}</small></div></div></td>
      <td><code style="font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--cyan)">${esc(p.sku)}</code></td>
      <td>${esc(p.category)}</td>
      <td><strong style="color:${p.quantity === 0 ? 'var(--red)' : p.quantity <= p.low_stock_threshold ? 'var(--yellow)' : 'var(--text)'}">${p.quantity}</strong></td>
      <td>${formatCurrency(p.unit_price)}</td>
      <td style="color:var(--text3)">${formatCurrency(p.cost_price)}</td>
      <td style="color:var(--accent2)">${formatCurrency(p.total_value)}</td>
      <td>${expiryBadge}</td>
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function populateCategoryFilter(products) {
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
  const sel = document.getElementById('categoryFilter');
  const current = sel.value;
  sel.innerHTML = '<option value="">All Categories</option>' + cats.map(c => `<option value="${esc(c)}" ${c===current?'selected':''}>${esc(c)}</option>`).join('');
}

function editProduct(id) {
  // Navigate to Add Product page with the product id as a query param
  window.location.href = `/add-product?edit=${id}`;
}

// loadProductForEdit: called on Add Product page when ?edit=ID is present
async function loadProductForEdit(id) {
  try {
    const res = await fetch(`/api/products/${id}`);
    if (!res.ok) return;
    const p = await res.json();
    populateEditForm(p);
  } catch (e) { console.error(e); }
}

async function saveProduct() {
  const editId = document.getElementById('editProductId').value;
  const warehouseEl = document.getElementById('fWarehouse');
  const data = {
    name: document.getElementById('fName').value.trim(),
    sku: document.getElementById('fSku').value.trim(),
    category: document.getElementById('fCategory').value.trim() || 'General',
    quantity: parseInt(document.getElementById('fQty').value) || 0,
    unit_price: parseFloat(document.getElementById('fPrice').value) || 0,
    cost_price: parseFloat(document.getElementById('fCostPrice').value) || 0,
    supplier: document.getElementById('fSupplier').value.trim(),
    supplier_lead_days: parseInt(document.getElementById('fLeadDays').value) || 7,
    low_stock_threshold: parseInt(document.getElementById('fThreshold').value) || 10,
    expiry_date: document.getElementById('fExpiry').value || null,
    description: document.getElementById('fDescription').value.trim(),
    warehouse_id: warehouseEl ? (parseInt(warehouseEl.value) || null) : null,
  };

  if (!data.name || !data.sku) { showToast('Name and SKU are required', 'error'); return; }

  try {
    const url = editId ? `/api/products/${editId}` : '/api/products';
    const method = editId ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await res.json();
    if (!res.ok) { showToast(result.error || 'Failed to save product', 'error'); return; }

    // Upload image if selected
    const imageFile = document.getElementById('imageFileInput').files[0];
    if (imageFile) {
      const fd = new FormData();
      fd.append('image', imageFile);
      await fetch(`/api/products/${result.id}/image`, { method: 'POST', body: fd });
    }

    showToast(editId ? `Updated: ${result.name}` : `Added: ${result.name}`, 'success');
    clearForm();
    loadStats();
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

function clearForm() {
  document.getElementById('editProductId').value = '';
  ['fName','fSku','fCategory','fSupplier','fDescription'].forEach(id => document.getElementById(id).value = '');
  ['fQty','fPrice','fCostPrice','fLeadDays','fThreshold'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('fExpiry').value = '';
  const whSel = document.getElementById('fWarehouse');
  if (whSel) whSel.value = '';
  document.getElementById('formTitle').textContent = 'Add New Product';
  document.getElementById('saveProductBtn').textContent = 'Save Product';
  document.getElementById('productImagePreview').style.display = 'none';
  document.getElementById('imageUploadPrompt').style.display = 'flex';
  document.getElementById('imageFileInput').value = '';
}

function populateEditForm(p) {
  document.getElementById('editProductId').value = p.id;
  document.getElementById('fName').value = p.name || '';
  document.getElementById('fSku').value = p.sku || '';
  document.getElementById('fCategory').value = p.category || '';
  document.getElementById('fQty').value = p.quantity ?? 0;
  document.getElementById('fPrice').value = p.unit_price ?? 0;
  document.getElementById('fCostPrice').value = p.cost_price ?? 0;
  document.getElementById('fSupplier').value = p.supplier || '';
  document.getElementById('fLeadDays').value = p.supplier_lead_days ?? 7;
  document.getElementById('fThreshold').value = p.low_stock_threshold ?? 10;
  document.getElementById('fExpiry').value = p.expiry_date ? p.expiry_date.split('T')[0] : '';
  document.getElementById('fDescription').value = p.description || '';
  const whSel = document.getElementById('fWarehouse');
  if (whSel) whSel.value = p.warehouse_id || '';
  document.getElementById('formTitle').textContent = `Edit: ${p.name}`;
  document.getElementById('saveProductBtn').textContent = 'Update Product';
  if (p.image_filename) {
    document.getElementById('productImagePreview').src = `/static/uploads/${p.image_filename}`;
    document.getElementById('productImagePreview').style.display = 'block';
    document.getElementById('imageUploadPrompt').style.display = 'none';
  }
}

// ─── Image Upload ─────────────────────────────────────────────────────────────
function setupImageUpload() {
  const zone = document.getElementById('imageUploadZone');
  const input = document.getElementById('imageFileInput');
  if (!zone) return;

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      document.getElementById('productImagePreview').src = e.target.result;
      document.getElementById('productImagePreview').style.display = 'block';
      document.getElementById('imageUploadPrompt').style.display = 'none';
    };
    reader.readAsDataURL(file);
  });
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
    loadStats(); loadProducts(); loadNotifications();
  } catch (e) { showToast('Error updating stock', 'error'); }
}

// ─── Transactions ─────────────────────────────────────────────────────────────
async function loadTransactions() {
  try {
    const txType = document.getElementById('txTypeFilter')?.value || '';
    const fromDate = document.getElementById('txFromDate')?.value || '';
    const toDate = document.getElementById('txToDate')?.value || '';
    let url = `/api/transactions?page=${state.txPage}&per_page=50`;
    if (txType) url += `&type=${txType}`;
    if (fromDate) url += `&from=${fromDate}`;
    if (toDate) url += `&to=${toDate}T23:59:59`;

    const res = await fetch(url);
    const data = await res.json();
    const txs = data.transactions || data;
    const tbody = document.getElementById('transactionTableBody');

    if (!txs.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="loading-cell">No transactions found</td></tr>`;
      return;
    }
    tbody.innerHTML = txs.map(t => `
      <tr>
        <td style="white-space:nowrap">${formatDate(t.created_at)}</td>
        <td>${esc(t.product_name)}</td>
        <td><code style="font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--cyan)">${esc(t.product_sku||'')}</code></td>
        <td><span class="badge ${t.transaction_type}">${t.transaction_type}</span></td>
        <td><strong>${t.quantity}</strong></td>
        <td style="color:var(--text3)">${esc(t.created_by||'system')}</td>
        <td style="color:var(--text3)">${esc(t.note || '—')}</td>
      </tr>
    `).join('');

    // Pagination
    if (data.pages > 1) {
      document.getElementById('txPagination').innerHTML = `
        <button class="btn-ghost" onclick="txChangePage(${state.txPage - 1})" ${state.txPage <= 1 ? 'disabled' : ''}>← Prev</button>
        <span style="color:var(--text2)">Page ${state.txPage} / ${data.pages}</span>
        <button class="btn-ghost" onclick="txChangePage(${state.txPage + 1})" ${state.txPage >= data.pages ? 'disabled' : ''}>Next →</button>
      `;
    }
  } catch (e) { console.error(e); }
}

function txChangePage(page) {
  state.txPage = page;
  loadTransactions();
}

async function exportTxCSV() {
  const txType = document.getElementById('txTypeFilter')?.value || '';
  const fromDate = document.getElementById('txFromDate')?.value || '';
  const toDate = document.getElementById('txToDate')?.value || '';

  let url = '/api/transactions?per_page=10000';
  if (txType) url += `&type=${txType}`;
  if (fromDate) url += `&from=${fromDate}`;
  if (toDate) url += `&to=${toDate}T23:59:59`;

  try {
    showToast('Preparing Excel file…', 'info');

    const res = await fetch(url);
    if (!res.ok) { showToast('Failed to fetch transactions', 'error'); return; }
    const data = await res.json();
    const txs = data.transactions || data;

    if (!txs.length) { showToast('No transactions to export', 'info'); return; }

    // Load SheetJS from CDN if not already loaded
    if (typeof XLSX === 'undefined') {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load SheetJS'));
        document.head.appendChild(script);
      });
    }

    // Build rows
    const rows = txs.map(t => ({
      'Date':             t.created_at ? new Date(t.created_at).toLocaleString() : '',
      'Product Name':     t.product_name || '',
      'SKU':              t.product_sku || '',
      'Type':             t.transaction_type || '',
      'Quantity':         t.quantity,
      'Performed By':     t.created_by || 'system',
      'Note':             t.note || '',
    }));

    const ws = XLSX.utils.json_to_sheet(rows);

    // Column widths
    ws['!cols'] = [
      { wch: 22 }, // Date
      { wch: 28 }, // Product Name
      { wch: 16 }, // SKU
      { wch: 12 }, // Type
      { wch: 10 }, // Quantity
      { wch: 18 }, // Performed By
      { wch: 32 }, // Note
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions');

    const timestamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `transactions_${timestamp}.xlsx`);
    showToast('Excel file downloaded!', 'success');

  } catch (e) {
    console.error(e);
    showToast('Export failed: ' + e.message, 'error');
  }
}

// ─── Import / Export ──────────────────────────────────────────────────────────
function exportCSV() {
  window.open('/api/products/export/csv', '_blank');
}

async function importCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const resultEl = document.getElementById('importResult');
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<p style="color:var(--text2)">Importing…</p>';

  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/products/import/csv', { method: 'POST', body: fd });
    const data = await res.json();
    const errorHtml = data.errors.length
      ? `<ul style="color:var(--red);font-size:0.82rem;margin-top:8px">${data.errors.slice(0,5).map(e => `<li>${esc(e)}</li>`).join('')}</ul>`
      : '';
    resultEl.innerHTML = `
      <div style="background:rgba(82,227,168,0.1);border:1px solid rgba(82,227,168,0.3);border-radius:10px;padding:12px;color:var(--green)">
        ✅ Imported <strong>${data.added}</strong> products · Skipped <strong>${data.skipped}</strong> duplicates
        ${errorHtml}
      </div>`;
    if (data.added > 0) { loadStats(); }
  } catch (e) {
    resultEl.innerHTML = `<div style="color:var(--red)">Import failed: ${e.message}</div>`;
  }
  input.value = '';
}

function downloadTemplate() {
  const csv = 'Name,SKU,Category,Quantity,Unit Price,Cost Price,Supplier,Lead Days,Low Stock Threshold,Description,Expiry Date\nSample Product,SKU-001,Electronics,100,29.99,15.00,Supplier Name,7,10,Product description,2025-12-31\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'aria_import_template.csv';
  a.click();
}

function setupImportDrop() {
  const zone = document.getElementById('importDropZone');
  if (!zone) return;
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.csv')) {
      const input = document.getElementById('csvFileInput');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      importCSV(input);
    } else {
      showToast('Please drop a CSV file', 'error');
    }
  });
}

// ─── Search ───────────────────────────────────────────────────────────────────
function setupSearch() {
  const globalSearch = document.getElementById('globalSearch');
  globalSearch.addEventListener('input', debounce(async () => {
    const q = globalSearch.value.trim();
    if (!q) { renderProductTable(state.products); return; }
    let url = `/api/search?q=${encodeURIComponent(q)}`;
    if (typeof _activeWarehouseId !== 'undefined' && _activeWarehouseId) {
      url += `&warehouse_id=${_activeWarehouseId}`;
    }
    const res = await fetch(url);
    const data = await res.json();
    // If not on products page, navigate there to show results
    if (!document.getElementById('productTableBody')) {
      window.location.href = `/products?q=${encodeURIComponent(q)}`;
      return;
    }
    renderProductTable(data.products || data);
  }, 300));

  document.getElementById('productSearch')?.addEventListener('input', debounce(doProductFilter, 300));
  document.getElementById('categoryFilter')?.addEventListener('change', doProductFilter);
  document.getElementById('statusFilter')?.addEventListener('change', doProductFilter);
}

async function doProductFilter() {
  const q = document.getElementById('productSearch').value.trim();
  const cat = document.getElementById('categoryFilter').value;
  const status = document.getElementById('statusFilter').value;
  let url = `/api/search?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}&status=${encodeURIComponent(status)}`;
  if (typeof _activeWarehouseId !== 'undefined' && _activeWarehouseId) {
    url += `&warehouse_id=${_activeWarehouseId}`;
  }
  const res = await fetch(url);
  const data = await res.json();
  renderProductTable(data.products || data);
}

// ─── Notifications ────────────────────────────────────────────────────────────
async function loadNotifications() {
  try {
    const res = await fetch('/api/notifications');
    const notifs = await res.json();
    const el = document.getElementById('notificationList');
    if (!el) return;
    if (!notifs.length) {
      el.innerHTML = '<p style="color:var(--text3);padding:20px">No unread notifications. All clear! 🎉</p>';
      return;
    }
    el.innerHTML = notifs.map(n => `
      <div class="notif-item notif-${n.type}" onclick="markNotifRead(${n.id}, this)">
        <div class="notif-msg">${esc(n.message)}</div>
        <div class="notif-time">${formatDate(n.created_at)}</div>
      </div>
    `).join('');
  } catch (e) { console.error(e); }
}

async function markNotifRead(id, el) {
  await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
  el.classList.add('read');
  setTimeout(() => el.remove(), 400);
}

async function markAllRead() {
  await fetch('/api/notifications/read-all', { method: 'POST' });
  loadNotifications();
  document.getElementById('alertCount').style.display = 'none';
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function setupChat() {
  const input = document.getElementById('chatInput');
  const sendBtn = document.getElementById('sendBtn');

  function updateSendBtn() {
    if (!voice.active) sendBtn.style.display = input.value.trim() ? '' : 'none';
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

  const welcome = document.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  appendMessage('user', text);
  state.chatHistory.push({ role: 'user', content: text });
  input.value = '';
  input.style.height = 'auto';
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
    voice.speakIfActive(data.message);

    if (data.actions_taken?.length) {
      await Promise.all([loadStats(), loadNotifications(), loadProducts()]);
      syncFormFromActions(data.actions_taken);
    }
  } catch (e) {
    removeTyping(typingId);
    appendMessage('ai', '⚠️ Network error. Please check your connection.');
  } finally {
    document.getElementById('sendBtn').disabled = false;
  }
}

function syncFormFromActions(actions) {
  for (const a of actions) {
    if (a.status !== 'success') continue;
    if (a.action === 'create_product' && a.product) {
      const fresh = a.product;
      populateEditForm(fresh);
    } else if (a.action === 'update_product' && a.product) {
      const fresh = a.product;
      populateEditForm(fresh);
    } else if (a.action === 'delete_product') {
      clearForm();
    } else if (a.action === 'update_stock') {
      if (a.product) {
        populateEditForm(a.product);   // ✅ ALWAYS use backend response
      }
    }
  }
}

function appendMessage(role, text, actions = []) {
  const container = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  const avatar = role === 'user'
    ? '<div class="msg-avatar">You</div>'
    : '<div class="msg-avatar">AI</div>';

  const cleanText = text.replace(/```json[\s\S]*?```/g, '').trim();
  const formattedText = formatMarkdown(cleanText);

  let actionBadges = '';
  if (actions?.length) {
    actionBadges = actions.map(a => {
      if (a.status === 'success') {
        let label = '', productCard = '';
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

function buildProductCard(p, mode) {
  const statusClass = p.status === 'In Stock' ? 'in-stock' : p.status === 'Low Stock' ? 'low-stock' : 'out-stock';
  const modeLabel = mode === 'created' ? '🆕 New Product' : '✏️ Updated Product';
  const profitMargin = p.unit_price > 0 && p.cost_price > 0
    ? ` · Margin: ${(((p.unit_price - p.cost_price) / p.unit_price) * 100).toFixed(0)}%` : '';
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
        <div class="pic-row"><span class="pic-label">Price</span><span class="pic-val">${formatCurrency(p.unit_price)}${profitMargin}</span></div>
        ${p.supplier ? `<div class="pic-row"><span class="pic-label">Supplier</span><span class="pic-val">${esc(p.supplier)}</span></div>` : ''}
      </div>
      <button class="pic-edit-btn" onclick="editProduct(${p.id})">✏️ Edit in Form</button>
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
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
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
// ─── VOICE MODULE (unchanged — full original preserved) ───────────────────────
// ══════════════════════════════════════════════════════════════════════════════

const voice = {
  active: false,
  mediaRecorder: null,
  chunks: [],
  currentAudio: null,
  history: [],
  isOpen: false,
  isBusy: false,
  audioCtx: null,
  analyser: null,
  silenceTimer: null,
  stream: null,
  SILENCE_THRESHOLD: 10,
  SILENCE_DELAY_MS: 2500,
};

voice.speakIfActive = function() {};

function openVoiceDialog() {
  voice.isOpen = true;
  const bar = document.getElementById('voiceInlineBar');
  const stopBtn = document.getElementById('voiceStopInlineBtn');
  const sendBtn = document.getElementById('sendBtn');
  if (bar) bar.classList.add('active');
  if (stopBtn) stopBtn.style.display = '';
  if (sendBtn) sendBtn.style.display = 'none';
  setVoiceDialogState('idle');
  // If not on chat page, navigate there
  if (!document.getElementById('chatMessages')) {
    window.location.href = '/chat';
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

function startVoiceSession() {
  if (voice.active) return;
  voice.active = true;
  _syncInlineBtn('active');
  _setStopBtn(true);
  _voiceListen();
}

function stopVoiceSession() {
  voice.active = false;
  voice.isBusy = false;
  _clearSilenceDetection();
  if (voice.mediaRecorder) {
    try { voice.mediaRecorder.stop(); } catch {}
    voice.stream?.getTracks().forEach(t => t.stop());
    voice.mediaRecorder = null;
    voice.stream = null;
  }
  if (voice.currentAudio) { voice.currentAudio.pause(); voice.currentAudio = null; }
  window.speechSynthesis?.cancel();
  _syncInlineBtn('idle');
  _setStopBtn(false);
  setVoiceDialogState('idle');
}

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
    _startSilenceDetection(voice.stream);
  } catch {
    showToast('Microphone access denied', 'error');
    stopVoiceSession();
  }
}

function _startSilenceDetection(stream) {
  try {
    voice.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    voice.analyser = voice.audioCtx.createAnalyser();
    voice.analyser.fftSize = 512;
    const source = voice.audioCtx.createMediaStreamSource(stream);
    source.connect(voice.analyser);
    const buf = new Uint8Array(voice.analyser.fftSize);
    let silenceStart = null;
    let hasSpeech = false;
    const check = () => {
      if (!voice.mediaRecorder || voice.mediaRecorder.state !== 'recording') return;
      voice.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length) * 255;
      if (rms > voice.SILENCE_THRESHOLD) {
        hasSpeech = true; silenceStart = null;
      } else if (hasSpeech) {
        if (!silenceStart) silenceStart = Date.now();
        if (Date.now() - silenceStart >= voice.SILENCE_DELAY_MS) {
          _clearSilenceDetection(); _stopRecording(); return;
        }
      }
      voice.silenceTimer = requestAnimationFrame(check);
    };
    voice.silenceTimer = requestAnimationFrame(check);
  } catch {
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
  if (voice.mediaRecorder.state === 'recording') voice.mediaRecorder.stop();
  voice.stream?.getTracks().forEach(t => t.stop());
  voice.mediaRecorder = null;
  voice.stream = null;
  setVoiceDialogState('transcribing');
}

async function _onListenDone() {
  if (!voice.active) return;
  voice.isBusy = true;
  const mimeType = getSupportedMime();
  const blob = new Blob(voice.chunks, { type: mimeType || 'audio/webm' });
  voice.chunks = [];
  if (blob.size < 1000) { voice.isBusy = false; if (voice.active) _voiceListen(); return; }
  try {
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
    const fd = new FormData();
    fd.append('audio', blob, `voice.${ext}`);
    const res = await fetch('/api/voice/transcribe', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || data.error || !data.text?.trim()) {
      voice.isBusy = false; if (voice.active) _voiceListen(); return;
    }
    const text = data.text.trim();
    appendVoiceTranscript('user', text);
    setVoiceDialogState('thinking');
    voice.history.push({ role: 'user', content: text });
    const aiRes = await fetch('/api/voice/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: voice.history })
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok || aiData.error) {
      voice.isBusy = false; showToast('AI error: ' + (aiData.error || 'unknown'), 'error');
      if (voice.active) _voiceListen(); return;
    }
    const reply = aiData.message || '';
    voice.history.push({ role: 'assistant', content: reply });
    appendVoiceTranscript('aria', reply);
    appendMessage('user', text);
    state.chatHistory.push({ role: 'user', content: text });
    appendMessage('ai', reply, aiData.actions_taken);
    state.chatHistory.push({ role: 'assistant', content: reply });
    if (aiData.actions_taken?.length) {
      await Promise.all([loadStats(), loadNotifications(), loadProducts()]);
      syncFormFromActions(aiData.actions_taken);
    }
    await speakVoiceReply(reply);
  } catch (err) {
    voice.isBusy = false; showToast('Voice error: ' + err.message, 'error');
    if (voice.active) _voiceListen();
  }
}

async function speakVoiceReply(text) {
  setVoiceDialogState('speaking');
  const cleanText = text.replace(/```[\s\S]*?```/g, '').replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/#{1,4}\s+/g, '').replace(/\s+/g, ' ').trim().slice(0, 800);
  const onDone = () => {
    voice.isBusy = false;
    if (voice.active) _voiceListen(); else setVoiceDialogState('idle');
  };
  try {
    const res = await fetch('/api/voice/speak', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cleanText })
    });
    const contentType = res.headers.get('Content-Type') || '';
    if (!res.ok || contentType.includes('application/json')) { await res.json().catch(() => {}); browserTTS(cleanText, onDone); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    voice.currentAudio = audio;
    audio.onended = () => { URL.revokeObjectURL(url); voice.currentAudio = null; onDone(); };
    audio.onerror = () => { URL.revokeObjectURL(url); voice.currentAudio = null; browserTTS(cleanText, onDone); };
    audio.play().catch(() => browserTTS(cleanText, onDone));
  } catch { browserTTS(cleanText, onDone); }
}

function browserTTS(text, onDone) {
  if (!window.speechSynthesis) { onDone?.(); return; }
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text.slice(0, 500));
  utt.rate = 1.0; utt.pitch = 1.05; utt.lang = 'en-US';
  const voices = window.speechSynthesis.getVoices();
  const female = voices.find(v => /female|woman|zira|samantha|karen|victoria/i.test(v.name));
  if (female) utt.voice = female;
  utt.onend = () => onDone?.(); utt.onerror = () => onDone?.();
  window.speechSynthesis.speak(utt);
}

function setVoiceDialogState(st) {
  const avatar = document.getElementById('voiceAvatar');
  const label = document.getElementById('voiceStateLabel');
  const waveform = document.getElementById('voiceWaveform');
  if (avatar) avatar.className = 'voice-avatar';
  if (waveform) waveform.className = 'voice-waveform';
  const inlineAvatar = document.getElementById('voiceInlineAvatar');
  const inlineLabel = document.getElementById('voiceInlineLabel');
  const inlineWave = document.getElementById('voiceInlineWave');
  const states = {
    idle:         { label: 'Click 🎙️ to start conversation', avatarClass: '',           waveClass: '' },
    listening:    { label: '🎙️ Listening…',                  avatarClass: 'recording',  waveClass: 'active recording' },
    transcribing: { label: '⏳ Processing…',                  avatarClass: 'processing', waveClass: 'active processing' },
    thinking:     { label: '💭 ARIA is thinking…',            avatarClass: 'thinking',   waveClass: 'active thinking' },
    speaking:     { label: '🔊 ARIA is speaking…',            avatarClass: 'speaking',   waveClass: 'active speaking' },
  };
  const s = states[st] || states.idle;
  if (label) label.textContent = s.label;
  if (s.avatarClass && avatar) avatar.classList.add(s.avatarClass);
  if (s.waveClass && waveform) s.waveClass.split(' ').forEach(c => waveform.classList.add(c));
  if (inlineLabel) inlineLabel.textContent = s.label;
  if (inlineAvatar) { inlineAvatar.className = 'voice-inline-avatar'; if (s.avatarClass) inlineAvatar.classList.add(s.avatarClass); }
  if (inlineWave) { inlineWave.className = 'voice-waveform voice-inline-wave'; if (s.waveClass) s.waveClass.split(' ').forEach(c => inlineWave.classList.add(c)); }
}

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

function setupVoice() {
  document.getElementById('voiceInlineBtn')?.addEventListener('click', () => {
    if (!voice.isOpen) { openVoiceDialog(); setTimeout(() => startVoiceSession(), 200); }
    else if (!voice.active) { startVoiceSession(); }
  });
  document.getElementById('voiceStopInlineBtn')?.addEventListener('click', closeVoiceDialog);
  document.getElementById('voiceDialogClose')?.addEventListener('click', closeVoiceDialog);
  document.getElementById('voiceStopBtn')?.addEventListener('click', stopVoiceSession);
  document.getElementById('voiceDialogClear')?.addEventListener('click', clearVoiceConversation);
  document.getElementById('voiceOverlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('voiceOverlay')) closeVoiceDialog();
  });
}

function clearVoiceConversation() {
  const wasActive = voice.active;
  stopVoiceSession();
  voice.history = [];
  const inner = document.getElementById('voiceTranscriptInner');
  if (inner) inner.innerHTML = '<p class="voice-hint-text">Speak your question — ARIA will auto-reply and keep listening</p>';
  showToast('Voice conversation cleared', 'info');
  if (wasActive) setTimeout(() => startVoiceSession(), 300);
}

function _syncInlineBtn(st) {
  const btn = document.getElementById('voiceInlineBtn');
  if (!btn) return;
  const idle = btn.querySelector('.mic-idle-i');
  const rec = btn.querySelector('.mic-rec-i');
  btn.classList.remove('recording', 'busy', 'active');
  if (st === 'active') {
    btn.classList.add('active');
    if (idle) idle.style.display = 'none';
    if (rec) rec.style.display = '';
  } else {
    if (idle) idle.style.display = '';
    if (rec) rec.style.display = 'none';
  }
}

function _setStopBtn(active) {
  const btn = document.getElementById('voiceStopBtn');
  if (!btn) return;
  btn.classList.toggle('active', active);
  btn.disabled = !active;
}

function getSupportedMime() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of types) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

// Legacy stubs
function setVoiceStatus() {}
function voiceStart() {}
function voiceStop() {}
function voiceDialogToggle() {}
function voiceDialogStart() { startVoiceSession(); }
function voiceDialogStop() { stopVoiceSession(); }