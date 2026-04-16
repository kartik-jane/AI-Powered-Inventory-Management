# ARIA — AI Inventory Management System

An intelligent, AI-powered inventory management system using Flask + Groq (Llama 3.1).

## Features
- 🤖 **AI Chat Interface** — natural language inventory management via ARIA
- 📦 **Full CRUD** — add, edit, delete products through UI or chat
- 📊 **Real-time Stats** — live dashboard with value, stock alerts
- 🔄 **Stock Management** — add/remove/set stock with transaction history
- 🔍 **Search & Filter** — by name, SKU, supplier, category
- 💾 **SQLite Database** — no external DB needed
- ✨ **Glass UI** — dark theme with glassmorphism design

## Setup

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Get a Groq API Key
- Go to https://console.groq.com
- Create a free account and generate an API key

### 3. Run the app
```bash
python app.py
```
Or with your API key as environment variable:
```bash
GROQ_API_KEY=gsk_your_key python app.py
```

### 4. Open in browser
```
http://localhost:5000
```


---

## ✅ What Was Added (vs. Your Original)

### 1. 🔐 Authentication System (`app.py`)
- **Login page** (`/login`) with username + password
- Session-based auth — all API routes now require login
- Two default users seeded: `admin / admin123` and `viewer / viewer123`
- Audit trail: every stock transaction records `created_by` username
- **Input sanitization** using `bleach` — protects against XSS in all user inputs
- Soft-delete for products (`is_active=False`) instead of hard delete

### 2. 📊 Analytics Panel (new sidebar item)
- **4 KPI cards**: Total Value, Estimated Gross Profit, Turnover Rate, Dead Stock count
- **Category doughnut chart** and **Stock Status bar chart** (Chart.js)
- **Restock Predictions**: calculates daily usage rate → days until stockout → urgency level
- **Fast Movers** (top 5 most consumed products in the period)
- **Dead Stock Detection** (products with zero movement, value tied up)
- **Supplier Overview** (per-supplier product count, value, low-stock warnings)
- Period selector: 7 / 30 / 90 days

### 3. 🤖 Upgraded AI Copilot (smarter system prompt)
ARIA now has **dual mode**:
- **EXECUTE mode**: CRUD operations (same JSON action blocks as before)
- **INSIGHT mode**: activates on open-ended questions:
  - "What should I restock?" → predicts stockout dates, recommends reorder quantities
  - "Dead stock?" → identifies and advises (markdown/promotion)
  - "Anomalies?" → flags sudden drops
  - "Health report?" → full inventory analysis
- System prompt now includes: 30-day usage data, stock predictions, profit info
- Voice prompt also upgraded with insight mode (still concise for voice)

### 4. 📈 Data Intelligence (same SQLite, no external tools)
New `/api/analytics` endpoint returns:
- `fast_movers` / `slow_movers` (by units consumed in period)
- `dead_stock` (zero movement items)
- `stock_predictions` (days until stockout, urgency, suggested reorder qty)
- `turnover_rate` (units sold / avg inventory)
- `daily_volume` dict (activity per day)
- `category_stats` (per-category breakdown)

New `/api/analytics/supplier` for supplier health overview.

### 5. 🔔 In-App Notifications
- Auto-created on stock events: low stock, out of stock, expiry warnings, anomalies
- Bell icon in header with unread count badge
- Notifications panel with color-coded types
- Mark individual or all as read
- **Anomaly detection**: flags stock drops of 50%+ in a single transaction

### 6. 🖼 Product Images
- Image upload zone in the Add Product form (click to browse)
- Stored in `static/uploads/`
- Shown as thumbnail in the Products table

### 7. 📤 Bulk Import / Export
- **Export CSV**: one-click download of full inventory
- **Import CSV**: upload CSV with validation; duplicates skipped, errors reported
- **Drag-and-drop** import zone
- **Template download**: blank CSV with correct headers

### 8. 🏷 New Product Fields
- `cost_price`: enables profit margin calculation
- `supplier_lead_days`: used for reorder timing predictions
- `expiry_date`: tracked and shown in Products table with color-coded status

### 9. 🔍 Better Search & Filters
- Products table now has a **Status filter** (In Stock / Low Stock / Out of Stock)
- API search accepts `?status=low|out|ok`
- Transactions filter by type, date range, and paginated

### 10. ⚡ Performance
- Simple in-memory cache for `/api/stats` (30s TTL, busted on any write)
- All product/transaction APIs paginated
- Chat history trimmed to last 10 messages for context window efficiency

### 11. 🔒 Basic Security
- `bleach.clean()` on all string inputs (XSS prevention)
- `login_required` decorator on all API endpoints
- File upload type validation (images only, 5MB limit)
- Input range clamping (no negative quantities or prices)

---

## 📁 File Structure

```
aria_upgraded/
├── app.py                    ← Main Flask app (all routes)
├── requirements.txt
├── .env.example
├── templates/
│   ├── login.html           
│   ├── base.html           
│   ├── chat.html           
│   ├── add_product.html           
│   ├── analytics.html           
│   ├── homepage.html           
│   ├── import_export.html          
│   ├── products.html           
│   ├── transactions.html           
│   └── index.html            
└── static/
    ├── css/
    │   └── style.css         ← Original + new styles appended
    ├── js/
    │   └── app.js            ← Upgraded: analytics, notifications, import/export
    └── uploads/              ← NEW: product images stored here
```

---

## 🗂 New API Endpoints

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/login` | Login page |
| POST | `/api/auth/login` | Authenticate |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/auth/me` | Current user |
| GET | `/api/analytics?days=30` | Full analytics data |
| GET | `/api/analytics/supplier` | Supplier performance |
| GET | `/api/products/export/csv` | Export all products as CSV |
| POST | `/api/products/import/csv` | Bulk import from CSV |
| POST | `/api/products/<id>/image` | Upload product image |
| GET | `/api/notifications` | Unread notifications |
| POST | `/api/notifications/<id>/read` | Mark one read |
| POST | `/api/notifications/read-all` | Mark all read |

---

## 💡 Example AI Insight Queries (try these in chat)

```
"Give me a full inventory health report"
"Which products will run out first? Predict based on usage."
"What should I order this week?"
"Find all dead stock and tell me what to do"
"Are there any anomalies in my stock movements?"
"What's my profit margin on Electronics category?"
"Which supplier needs attention?"
```

---

## 🔧 What Was NOT Changed
- Flask + SQLite architecture (same)
- Voice system (100% preserved — same UX, same routes)
- Existing CRUD operations and AI action JSON format
- Overall UI design language (same dark theme, same sidebar layout)
- Product table display (only new columns added)
