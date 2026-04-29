from flask import Flask, render_template, request, jsonify, Response, redirect, url_for, session
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from datetime import datetime, timedelta
from functools import wraps
import json, os, re, io, csv, hashlib, bleach, threading, smtplib, random
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

# Handle Railway/Render reverse proxy so HTTPS is detected correctly
try:
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
except ImportError:
    pass
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///inventory.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'aria-secret-change-in-production')
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024  # 5MB max upload
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
# Use secure cookies on Railway (HTTPS) but allow HTTP for local dev
app.config['SESSION_COOKIE_SECURE'] = os.environ.get('RAILWAY_ENVIRONMENT') is not None or os.environ.get('SESSION_COOKIE_SECURE', '').lower() == 'true'

db = SQLAlchemy(app)
migrate = Migrate(app, db)

# ─── Email Configuration ───────────────────────────────────────────────────────
# Set these in your .env file:
#   MAIL_SERVER   = smtp.gmail.com          (or your SMTP host)
#   MAIL_PORT     = 587
#   MAIL_USERNAME = you@gmail.com
#   MAIL_PASSWORD = your_app_password       (Gmail: use an App Password)
#   MAIL_USE_TLS  = true
#   MAIL_FROM     = you@gmail.com           (defaults to MAIL_USERNAME if omitted)

MAIL_SERVER   = os.environ.get('MAIL_SERVER',   'smtp.gmail.com')
MAIL_PORT     = int(os.environ.get('MAIL_PORT', 587))
MAIL_USERNAME = os.environ.get('MAIL_USERNAME', '')
MAIL_PASSWORD = os.environ.get('MAIL_PASSWORD', '')
MAIL_USE_TLS  = os.environ.get('MAIL_USE_TLS',  'true').lower() == 'true'
MAIL_FROM     = os.environ.get('MAIL_FROM', MAIL_USERNAME)

# Cooldown: don't resend an email for the same product+type within this many seconds (default 6 hours)
EMAIL_COOLDOWN_SECONDS = int(os.environ.get('EMAIL_COOLDOWN_SECONDS', 21600))

# In-memory cooldown tracker  { "uid:product_id:type": datetime_sent }
_email_cooldown: dict = {}

# OTP store for email verification  { "email": { "code": "482910", "expires_at": datetime } }
_otp_store: dict = {}
# ─── Simple in-memory cache ────────────────────────────────────────────────────
_cache = {}
def cache_get(key):
    entry = _cache.get(key)
    if entry and datetime.utcnow() < entry['exp']:
        return entry['val']
    return None

def cache_set(key, val, ttl_sec=30):
    _cache[key] = {'val': val, 'exp': datetime.utcnow() + timedelta(seconds=ttl_sec)}

def cache_bust(*keys):
    for k in keys:
        _cache.pop(k, None)

# ─── Models ───────────────────────────────────────────────────────────────────

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(200), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    role = db.Column(db.String(20), default='admin')  # admin, viewer
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    @staticmethod
    def hash_pw(password):
        return hashlib.sha256(password.encode()).hexdigest()

    def check_pw(self, password):
        return self.password_hash == hashlib.sha256(password.encode()).hexdigest()


class Warehouse(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    name = db.Column(db.String(200), nullable=False)
    location = db.Column(db.String(300), default='')
    manager = db.Column(db.String(200), default='')
    capacity = db.Column(db.Integer, default=0)
    description = db.Column(db.Text, default='')
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    lat = db.Column(db.Float, nullable=True)
    lng = db.Column(db.Float, nullable=True)

    def to_dict(self):
        product_count = Product.query.filter_by(warehouse_id=self.id, is_active=True).count() if self.id else 0
        return {
            'id': self.id,
            'user_id': self.user_id,
            'name': self.name,
            'location': self.location,
            'manager': self.manager,
            'capacity': self.capacity,
            'description': self.description,
            'is_active': self.is_active,
            'created_at': self.created_at.isoformat(),
            'updated_at': self.updated_at.isoformat(),
            'lat': self.lat,
            'lng': self.lng,
            'product_count': product_count,
        }


class Product(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    warehouse_id = db.Column(db.Integer, db.ForeignKey('warehouse.id'), nullable=True)
    name = db.Column(db.String(200), nullable=False)
    sku = db.Column(db.String(100), nullable=False)
    category = db.Column(db.String(100), default='General')
    quantity = db.Column(db.Integer, default=0)
    unit_price = db.Column(db.Float, default=0.0)
    cost_price = db.Column(db.Float, default=0.0)
    supplier = db.Column(db.String(200), default='')
    supplier_lead_days = db.Column(db.Integer, default=7)
    low_stock_threshold = db.Column(db.Integer, default=10)
    expiry_date = db.Column(db.DateTime, nullable=True)
    image_filename = db.Column(db.String(300), default='')
    description = db.Column(db.Text, default='')
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def status(self):
        if self.quantity == 0:
            return 'Out of Stock'
        elif self.quantity <= self.low_stock_threshold:
            return 'Low Stock'
        return 'In Stock'

    def expiry_status(self):
        if not self.expiry_date:
            return None
        days = (self.expiry_date - datetime.utcnow()).days
        if days < 0:
            return 'Expired'
        elif days <= 30:
            return f'Expiring in {days}d'
        return 'OK'

    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'warehouse_id': self.warehouse_id,
            'name': self.name,
            'sku': self.sku,
            'category': self.category,
            'quantity': self.quantity,
            'unit_price': self.unit_price,
            'cost_price': self.cost_price,
            'supplier': self.supplier,
            'supplier_lead_days': self.supplier_lead_days,
            'low_stock_threshold': self.low_stock_threshold,
            'expiry_date': self.expiry_date.isoformat() if self.expiry_date else None,
            'expiry_status': self.expiry_status(),
            'image_filename': self.image_filename,
            'description': self.description,
            'is_active': self.is_active,
            'created_at': self.created_at.isoformat(),
            'updated_at': self.updated_at.isoformat(),
            'status': self.status(),
            'total_value': round(self.quantity * self.unit_price, 2),
        }


class Transaction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey('product.id'), nullable=False)
    transaction_type = db.Column(db.String(50), nullable=False)
    quantity = db.Column(db.Integer, nullable=False)
    note = db.Column(db.Text, default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    created_by = db.Column(db.String(80), default='system')
    product = db.relationship('Product', backref='transactions')

    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'product_id': self.product_id,
            'product_name': self.product.name if self.product else 'Unknown',
            'product_sku': self.product.sku if self.product else '',
            'transaction_type': self.transaction_type,
            'quantity': self.quantity,
            'note': self.note,
            'created_at': self.created_at.isoformat(),
            'created_by': self.created_by,
        }


class Notification(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    type = db.Column(db.String(50))
    message = db.Column(db.Text)
    product_id = db.Column(db.Integer, nullable=True)
    is_read = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id, 'type': self.type, 'message': self.message,
            'product_id': self.product_id, 'is_read': self.is_read,
            'created_at': self.created_at.isoformat()
        }


# ─── Auth helpers ──────────────────────────────────────────────────────────────

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('user_id'):
            # Return JSON 401 for all /api/ routes or JSON requests, not a redirect
            if request.path.startswith('/api/') or request.is_json:
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect(url_for('login_page'))
        return f(*args, **kwargs)
    return decorated

def sanitize(val):
    if isinstance(val, str):
        return bleach.clean(val.strip(), tags=[], strip=True)[:500]
    return val

def current_user_id():
    return session.get('user_id')

# ─── Auth Routes ───────────────────────────────────────────────────────────────

@app.route('/login', methods=['GET'])
def login_page():
    if session.get('user_id'):
        return redirect(url_for('index'))
    return render_template('login.html')

@app.route('/signup', methods=['GET'])
def signup_page():
    if session.get('user_id'):
        return redirect(url_for('index'))
    return render_template('signup.html')

@app.route('/api/auth/signup', methods=['POST'])
def api_signup():
    d = request.json or {}
    username = sanitize(d.get('username', ''))
    email = sanitize(d.get('email', ''))
    password = d.get('password', '')
    confirm = d.get('confirm_password', '')

    if not username or not password:
        return jsonify({'error': 'Username and password are required'}), 400
    if len(username) < 3:
        return jsonify({'error': 'Username must be at least 3 characters'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters'}), 400
    if password != confirm:
        return jsonify({'error': 'Passwords do not match'}), 400
    if not email or not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', email):
        return jsonify({'error': 'A valid email address is required'}), 400
    if User.query.filter_by(username=username).first():
        return jsonify({'error': 'Username already taken'}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({'error': 'Email already registered'}), 400

    # Check OTP was verified
    otp_entry = _otp_store.get(email)
    if not otp_entry or not otp_entry.get('verified'):
        return jsonify({'error': 'Email not verified. Please verify your email first.'}), 400
    # Clear OTP after successful registration
    _otp_store.pop(email, None)

    user = User(
        username=username,
        email=email,
        password_hash=User.hash_pw(password),
        role='admin',
    )
    db.session.add(user)
    db.session.commit()

    # Auto-create a default warehouse for every new user
    default_warehouse = Warehouse(
        user_id=user.id,
        name='Default Warehouse',
        location='',
        manager='',
        capacity=0,
        description='Your default warehouse. Products added without a warehouse selection are stored here.',
    )
    db.session.add(default_warehouse)
    db.session.commit()

    session['user_id'] = user.id
    session['username'] = user.username
    session['role'] = user.role
    return jsonify({'message': 'Account created', 'username': user.username, 'role': user.role}), 201

@app.route('/api/auth/check-username', methods=['POST'])
def api_check_username():
    d = request.json or {}
    username = sanitize(d.get('username', ''))
    taken = User.query.filter_by(username=username).first() is not None
    return jsonify({'available': not taken})

@app.route('/api/auth/send-otp', methods=['POST'])
def api_send_otp():
    d = request.json or {}
    email = sanitize(d.get('email', ''))

    if not email or not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', email):
        return jsonify({'error': 'Valid email required'}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({'error': 'Email already registered'}), 400
    if not MAIL_USERNAME or not MAIL_PASSWORD:
        return jsonify({'error': 'Email service not configured'}), 500

    code = str(random.randint(100000, 999999))
    _otp_store[email] = {
        'code': code,
        'expires_at': datetime.utcnow() + timedelta(minutes=10)
    }

    html_body = f"""
    <div style="font-family:Arial,sans-serif;background:#0f0f1a;padding:40px;text-align:center">
      <div style="background:#1a1a2e;border-radius:16px;padding:40px;max-width:480px;margin:auto;border:1px solid #2d2d4e">
        <h2 style="color:#9b6dff;margin-bottom:8px">ARIA Inventory System</h2>
        <p style="color:#9a9bb0;margin-bottom:24px">Your email verification code</p>
        <div style="background:#0f0f1a;border:1px solid #9b6dff;border-radius:12px;padding:24px;margin:24px 0">
          <span style="font-size:36px;font-weight:800;letter-spacing:12px;color:#ffffff;font-family:monospace">{code}</span>
        </div>
        <p style="color:#9a9bb0;font-size:13px">This code expires in <strong style="color:#fff">10 minutes</strong>.<br>Do not share this code with anyone.</p>
      </div>
    </div>
    """

    def _send():
        try:
            msg = MIMEMultipart('alternative')
            msg['Subject'] = '🔐 Your ARIA Verification Code'
            msg['From']    = MAIL_FROM
            msg['To']      = email
            msg.attach(MIMEText(html_body, 'html'))
            try:
                with smtplib.SMTP_SSL(MAIL_SERVER, 465) as server:
                    server.login(MAIL_USERNAME, MAIL_PASSWORD)
                    server.sendmail(MAIL_FROM, email, msg.as_string())
            except Exception:
                with smtplib.SMTP(MAIL_SERVER, MAIL_PORT) as server:
                    if MAIL_USE_TLS:
                        server.starttls()
                    server.login(MAIL_USERNAME, MAIL_PASSWORD)
                    server.sendmail(MAIL_FROM, email, msg.as_string())
        except Exception as exc:
            app.logger.error(f'OTP email failed: {exc}')

    threading.Thread(target=_send, daemon=True).start()
    return jsonify({'message': 'OTP sent to your email'}), 200


@app.route('/api/auth/verify-otp', methods=['POST'])
def api_verify_otp():
    d = request.json or {}
    email = sanitize(d.get('email', ''))
    code  = d.get('code', '').strip()

    entry = _otp_store.get(email)
    if not entry:
        return jsonify({'error': 'No OTP sent for this email. Request a new code.'}), 400
    if datetime.utcnow() > entry['expires_at']:
        _otp_store.pop(email, None)
        return jsonify({'error': 'OTP expired. Request a new code.'}), 400
    if entry['code'] != code:
        return jsonify({'error': 'Incorrect code. Please try again.'}), 400

    # Mark as verified (keep in store so register can check it)
    _otp_store[email]['verified'] = True
    return jsonify({'verified': True}), 200


@app.route('/api/auth/register', methods=['POST'])
def api_register():
    """Full registration endpoint used by Register.html (requires email)."""
    d = request.json or {}
    first_name = sanitize(d.get('first_name', ''))
    last_name  = sanitize(d.get('last_name', ''))
    company    = sanitize(d.get('company', ''))
    email      = sanitize(d.get('email', ''))
    username   = sanitize(d.get('username', ''))
    password   = d.get('password', '')
    confirm    = d.get('confirm_password', password)  # confirm is validated client-side

    # Server-side validation
    if not first_name or not last_name:
        return jsonify({'error': 'First and last name are required'}), 400
    if not company:
        return jsonify({'error': 'Company name is required'}), 400
    if not email or not re.match(r'^[^\s@]+@[^\s@]+\.[^\s@]+$', email):
        return jsonify({'error': 'A valid email address is required'}), 400
    if not username or len(username) < 3:
        return jsonify({'error': 'Username must be at least 3 characters'}), 400
    if not re.match(r'^[a-zA-Z0-9_]+$', username):
        return jsonify({'error': 'Username can only contain letters, numbers, and underscores'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400
    if password != confirm:
        return jsonify({'error': 'Passwords do not match'}), 400
    if User.query.filter_by(username=username).first():
        return jsonify({'error': 'Username already taken'}), 400
    if User.query.filter_by(email=email).first():
        return jsonify({'error': 'Email already registered'}), 400
    # Check OTP was verified
    otp_entry = _otp_store.get(email)
    if not otp_entry or not otp_entry.get('verified'):
        return jsonify({'error': 'Email not verified. Please verify your email first.'}), 400
    # Clear OTP after successful registration
    _otp_store.pop(email, None)

    user = User(
        username=username,
        email=email,  # email is mandatory — required for low-stock alert emails
        password_hash=User.hash_pw(password),
        role='admin',
    )
    db.session.add(user)
    db.session.commit()

    # Auto-create a default warehouse for the new user
    default_warehouse = Warehouse(
        user_id=user.id,
        name='Default Warehouse',
        location='',
        manager=f'{first_name} {last_name}'.strip(),
        capacity=0,
        description='Your default warehouse. Products added without a warehouse selection are stored here.',
    )
    db.session.add(default_warehouse)
    db.session.commit()

    session['user_id']  = user.id
    session['username'] = user.username
    session['role']     = user.role
    return jsonify({'message': 'Account created', 'username': user.username, 'role': user.role}), 201

@app.route('/api/auth/login', methods=['POST'])
def api_login():
    d = request.json or {}
    username = sanitize(d.get('username', ''))
    password = d.get('password', '')
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    user = User.query.filter_by(username=username).first()
    if not user or not user.check_pw(password):
        return jsonify({'error': 'Invalid credentials'}), 401
    session['user_id'] = user.id
    session['username'] = user.username
    session['role'] = user.role
    return jsonify({'message': 'Login successful', 'username': user.username, 'role': user.role})

@app.route('/api/auth/logout', methods=['POST'])
def api_logout():
    session.clear()
    return jsonify({'message': 'Logged out'})

@app.route('/api/auth/me', methods=['GET'])
@login_required
def api_me():
    return jsonify({'username': session.get('username'), 'role': session.get('role')})

# ─── Main Routes ────────────────────────────────────────────────────────────────
@app.route('/')
def index():
    if session.get('user_id'):
        return redirect(url_for('page_chat'))
    return render_template('homepage.html')

@app.route('/home')
def homepage():
    if session.get('user_id'):
        return redirect(url_for('page_chat'))
    return render_template('homepage.html')

@app.route('/chat')
@login_required
def page_chat():
    return render_template('chat.html')

@app.route('/analytics')
@login_required
def page_analytics():
    return render_template('analytics.html')

@app.route('/products')
@login_required
def page_products():
    return render_template('products.html')

@app.route('/add-product')
@login_required
def page_add_product():
    return render_template('add_product.html')

@app.route('/transactions')
@login_required
def page_transactions():
    return render_template('transactions.html')

@app.route('/import-export')
@login_required
def page_import_export():
    return render_template('import_export.html')

@app.route('/warehouses')
@login_required
def page_warehouses():
    return render_template('warehouses.html')

@app.route('/scan-barcode')
@login_required
def page_scan_barcode():
    return render_template('scan_barcode.html')

# ─── Warehouse API Routes ──────────────────────────────────────────────────────

@app.route('/api/warehouses', methods=['GET'])
@login_required
def get_warehouses():
    uid = current_user_id()
    warehouses = Warehouse.query.filter_by(user_id=uid, is_active=True).all()
    return jsonify([w.to_dict() for w in warehouses])

@app.route('/api/warehouses', methods=['POST'])
@login_required
def create_warehouse():
    uid = current_user_id()
    data = request.json or {}
    if not data.get('name'):
        return jsonify({'error': 'Warehouse name is required'}), 400
    w = Warehouse(
        user_id=uid,
        name=sanitize(data['name']),
        location=sanitize(data.get('location', '')),
        manager=sanitize(data.get('manager', '')),
        capacity=max(0, int(data.get('capacity', 0))),
        description=sanitize(data.get('description', '')),
        lat=data.get('lat'),
        lng=data.get('lng'),
    )
    db.session.add(w)
    db.session.commit()
    return jsonify(w.to_dict()), 201

@app.route('/api/warehouses/<int:wid>', methods=['GET'])
@login_required
def get_warehouse(wid):
    uid = current_user_id()
    w = Warehouse.query.filter_by(id=wid, user_id=uid).first_or_404()
    return jsonify(w.to_dict())

@app.route('/api/warehouses/<int:wid>', methods=['PUT'])
@login_required
def update_warehouse(wid):
    uid = current_user_id()
    w = Warehouse.query.filter_by(id=wid, user_id=uid).first_or_404()
    data = request.json or {}
    for field in ['name', 'location', 'manager', 'description']:
        if field in data:
            setattr(w, field, sanitize(data[field]))
    if 'capacity' in data:
        w.capacity = max(0, int(data['capacity']))
    if 'lat' in data:
        w.lat = data.get('lat')
    if 'lng' in data:
        w.lng = data.get('lng')
    w.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify(w.to_dict())

@app.route('/api/warehouses/<int:wid>', methods=['DELETE'])
@login_required
def delete_warehouse(wid):
    uid = current_user_id()
    w = Warehouse.query.filter_by(id=wid, user_id=uid).first_or_404()
    w.is_active = False
    db.session.commit()
    return jsonify({'message': f"Warehouse '{w.name}' deleted successfully"})

# ─── Product Routes ────────────────────────────────────────────────────────────

@app.route('/api/products', methods=['GET'])
@login_required
def get_products():
    uid = current_user_id()
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)
    status_filter = request.args.get('status', '')
    warehouse_id = request.args.get('warehouse_id', None, type=int)

    query = Product.query.filter_by(is_active=True, user_id=uid)
    if warehouse_id:
        query = query.filter_by(warehouse_id=warehouse_id)
    if status_filter == 'low':
        query = query.filter(Product.quantity > 0, Product.quantity <= Product.low_stock_threshold)
    elif status_filter == 'out':
        query = query.filter(Product.quantity == 0)
    elif status_filter == 'ok':
        query = query.filter(Product.quantity > Product.low_stock_threshold)

    paginated = query.paginate(page=page, per_page=per_page, error_out=False)
    return jsonify({
        'products': [p.to_dict() for p in paginated.items],
        'total': paginated.total,
        'pages': paginated.pages,
        'current_page': page,
    })

@app.route('/api/products', methods=['POST'])
@login_required
def create_product():
    uid = current_user_id()
    data = request.json
    if not data.get('name') or not data.get('sku'):
        return jsonify({'error': 'Name and SKU are required'}), 400
    sku = sanitize(data['sku'])
    warehouse_id = data.get('warehouse_id', None)

    # SKU unique per user
    if Product.query.filter_by(sku=sku, user_id=uid, is_active=True).first():
        return jsonify({'error': f"SKU '{sku}' already exists in your inventory"}), 400

    # Validate warehouse belongs to user; fall back to default (first) warehouse if none selected
    if warehouse_id:
        wh = Warehouse.query.filter_by(id=warehouse_id, user_id=uid, is_active=True).first()
        if not wh:
            warehouse_id = None
    if not warehouse_id:
        default_wh = Warehouse.query.filter_by(user_id=uid, is_active=True).order_by(Warehouse.id.asc()).first()
        if default_wh:
            warehouse_id = default_wh.id

    expiry = None
    if data.get('expiry_date'):
        try:
            expiry = datetime.fromisoformat(data['expiry_date'])
        except:
            pass

    product = Product(
        user_id=uid,
        warehouse_id=warehouse_id,
        name=sanitize(data['name']),
        sku=sku,
        category=sanitize(data.get('category', 'General')),
        quantity=max(0, int(data.get('quantity', 0))),
        unit_price=max(0, float(data.get('unit_price', 0.0))),
        cost_price=max(0, float(data.get('cost_price', 0.0))),
        supplier=sanitize(data.get('supplier', '')),
        supplier_lead_days=max(1, int(data.get('supplier_lead_days', 7))),
        low_stock_threshold=max(0, int(data.get('low_stock_threshold', 10))),
        expiry_date=expiry,
        description=sanitize(data.get('description', '')),
    )
    db.session.add(product)
    db.session.commit()
    cache_bust(f'stats_{uid}')
    _check_and_notify(product)
    return jsonify(product.to_dict()), 201

@app.route('/api/products/by-barcode', methods=['GET'])
@login_required
def get_product_by_barcode():
    uid = current_user_id()
    code = request.args.get('code', '').strip()
    if not code:
        return jsonify({'error': 'code parameter required'}), 400
    # Barcodes are matched against SKU (exact match) or case-insensitive SKU
    product = Product.query.filter_by(sku=code, user_id=uid, is_active=True).first()
    if not product:
        # Try case-insensitive match as fallback
        product = Product.query.filter(
            Product.user_id == uid,
            Product.is_active == True,
            db.func.lower(Product.sku) == code.lower()
        ).first()
    if not product:
        return jsonify({'error': 'Product not found'}), 404
    return jsonify(product.to_dict())

@app.route('/api/products/<int:product_id>', methods=['GET'])
@login_required
def get_product(product_id):
    uid = current_user_id()
    product = Product.query.filter_by(id=product_id, user_id=uid).first_or_404()
    return jsonify(product.to_dict())

@app.route('/api/products/<int:product_id>', methods=['PUT'])
@login_required
def update_product(product_id):
    uid = current_user_id()
    product = Product.query.filter_by(id=product_id, user_id=uid).first_or_404()
    data = request.json
    for field in ['name', 'category', 'supplier', 'description']:
        if field in data:
            setattr(product, field, sanitize(data[field]))
    for field in ['unit_price', 'cost_price']:
        if field in data:
            setattr(product, field, max(0, float(data[field])))
    for field in ['low_stock_threshold', 'supplier_lead_days']:
        if field in data:
            setattr(product, field, max(0, int(data[field])))
    if 'sku' in data and data['sku'] != product.sku:
        sku = sanitize(data['sku'])
        if Product.query.filter_by(sku=sku, user_id=uid, is_active=True).first():
            return jsonify({'error': f"SKU '{sku}' already exists"}), 400
        product.sku = sku
    if 'warehouse_id' in data:
        wid = data['warehouse_id']
        if wid:
            wh = Warehouse.query.filter_by(id=wid, user_id=uid, is_active=True).first()
            product.warehouse_id = wh.id if wh else None
        else:
            product.warehouse_id = None
    if 'expiry_date' in data:
        try:
            product.expiry_date = datetime.fromisoformat(data['expiry_date']) if data['expiry_date'] else None
        except:
            pass
    product.updated_at = datetime.utcnow()
    db.session.commit()
    cache_bust(f'stats_{uid}')
    return jsonify(product.to_dict())

@app.route('/api/products/<int:product_id>', methods=['DELETE'])
@login_required
def delete_product(product_id):
    uid = current_user_id()
    product = Product.query.filter_by(id=product_id, user_id=uid).first_or_404()
    product.is_active = False
    db.session.commit()
    cache_bust(f'stats_{uid}')
    return jsonify({'message': f"Product '{product.name}' deleted successfully"})

@app.route('/api/products/<int:product_id>/stock', methods=['POST'])
@login_required
def update_stock(product_id):
    uid = current_user_id()
    product = Product.query.filter_by(id=product_id, user_id=uid).first_or_404()
    data = request.json
    action = data.get('action', 'add')
    qty = int(data.get('quantity', 0))
    note = sanitize(data.get('note', ''))
    old_qty = product.quantity

    if action == 'add':
        product.quantity += qty
        tx_type = 'add'
    elif action == 'remove':
        if product.quantity < qty:
            return jsonify({'error': f'Insufficient stock. Available: {product.quantity}'}), 400
        product.quantity -= qty
        tx_type = 'remove'
    elif action == 'set':
        product.quantity = max(0, qty)
        tx_type = 'adjust'
    else:
        return jsonify({'error': 'Invalid action'}), 400

    product.updated_at = datetime.utcnow()
    tx = Transaction(
        user_id=uid,
        product_id=product.id, transaction_type=tx_type,
        quantity=qty, note=note,
        created_by=session.get('username', 'system')
    )
    db.session.add(tx)
    db.session.commit()
    cache_bust(f'stats_{uid}')
    _check_and_notify(product)
    _detect_anomaly(product, tx_type, qty, old_qty)
    return jsonify({'product': product.to_dict(), 'old_quantity': old_qty, 'new_quantity': product.quantity})

# ─── Image Upload ──────────────────────────────────────────────────────────────

@app.route('/api/products/<int:product_id>/image', methods=['POST'])
@login_required
def upload_product_image(product_id):
    uid = current_user_id()
    product = Product.query.filter_by(id=product_id, user_id=uid).first_or_404()
    if 'image' not in request.files:
        return jsonify({'error': 'No image file'}), 400
    f = request.files['image']
    if not f.filename:
        return jsonify({'error': 'Empty filename'}), 400
    ext = f.filename.rsplit('.', 1)[-1].lower()
    if ext not in {'png', 'jpg', 'jpeg', 'webp', 'gif'}:
        return jsonify({'error': 'Invalid image type'}), 400
    filename = f'product_{uid}_{product_id}_{int(datetime.utcnow().timestamp())}.{ext}'
    upload_dir = os.path.join(app.root_path, 'static', 'uploads')
    os.makedirs(upload_dir, exist_ok=True)
    f.save(os.path.join(upload_dir, filename))
    product.image_filename = filename
    db.session.commit()
    return jsonify({'image_filename': filename})

# ─── Bulk Import/Export ────────────────────────────────────────────────────────

@app.route('/api/products/export/csv', methods=['GET'])
@login_required
def export_csv():
    uid = current_user_id()
    products = Product.query.filter_by(is_active=True, user_id=uid).all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['Name', 'SKU', 'Category', 'Quantity', 'Unit Price', 'Cost Price',
                     'Supplier', 'Lead Days', 'Low Stock Threshold', 'Description', 'Expiry Date'])
    for p in products:
        writer.writerow([p.name, p.sku, p.category, p.quantity, p.unit_price, p.cost_price,
                         p.supplier, p.supplier_lead_days, p.low_stock_threshold,
                         p.description, p.expiry_date.isoformat() if p.expiry_date else ''])
    output.seek(0)
    return Response(output.getvalue(), mimetype='text/csv',
                    headers={'Content-Disposition': 'attachment; filename=inventory_export.csv'})

@app.route('/api/products/import/csv', methods=['POST'])
@login_required
def import_csv():
    uid = current_user_id()
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    f = request.files['file']
    stream = io.StringIO(f.stream.read().decode('utf-8'))
    reader = csv.DictReader(stream)
    added, skipped, errors = 0, 0, []
    for row in reader:
        try:
            sku = sanitize(row.get('SKU', '').strip())
            name = sanitize(row.get('Name', '').strip())
            if not sku or not name:
                errors.append(f'Row missing Name or SKU: {row}')
                continue
            if Product.query.filter_by(sku=sku, user_id=uid, is_active=True).first():
                skipped += 1
                continue
            expiry = None
            if row.get('Expiry Date'):
                try:
                    expiry = datetime.fromisoformat(row['Expiry Date'])
                except:
                    pass
            p = Product(
                user_id=uid,
                name=name, sku=sku,
                category=sanitize(row.get('Category', 'General')),
                quantity=int(row.get('Quantity', 0)),
                unit_price=float(row.get('Unit Price', 0)),
                cost_price=float(row.get('Cost Price', 0)),
                supplier=sanitize(row.get('Supplier', '')),
                supplier_lead_days=int(row.get('Lead Days', 7)),
                low_stock_threshold=int(row.get('Low Stock Threshold', 10)),
                description=sanitize(row.get('Description', '')),
                expiry_date=expiry,
            )
            db.session.add(p)
            added += 1
        except Exception as e:
            errors.append(str(e))
    db.session.commit()
    cache_bust(f'stats_{uid}')
    return jsonify({'added': added, 'skipped': skipped, 'errors': errors})

# ─── Transactions ──────────────────────────────────────────────────────────────

@app.route('/api/transactions', methods=['GET'])
@login_required
def get_transactions():
    uid = current_user_id()
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)
    tx_type = request.args.get('type', '')
    product_id = request.args.get('product_id', None, type=int)
    date_from = request.args.get('from', '')
    date_to = request.args.get('to', '')

    query = Transaction.query.filter_by(user_id=uid)
    if tx_type:
        query = query.filter_by(transaction_type=tx_type)
    if product_id:
        query = query.filter_by(product_id=product_id)
    if date_from:
        try:
            query = query.filter(Transaction.created_at >= datetime.fromisoformat(date_from))
        except:
            pass
    if date_to:
        try:
            query = query.filter(Transaction.created_at <= datetime.fromisoformat(date_to))
        except:
            pass

    paginated = query.order_by(Transaction.created_at.desc()).paginate(page=page, per_page=per_page, error_out=False)
    return jsonify({
        'transactions': [t.to_dict() for t in paginated.items],
        'total': paginated.total,
        'pages': paginated.pages,
    })

# ─── Stats & Analytics ─────────────────────────────────────────────────────────

@app.route('/api/stats', methods=['GET'])
@login_required
def get_stats():
    uid = current_user_id()
    cache_key = f'stats_{uid}'
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    products = Product.query.filter_by(is_active=True, user_id=uid).all()
    total_products = len(products)
    total_value = sum(p.quantity * p.unit_price for p in products)
    total_cost = sum(p.quantity * p.cost_price for p in products)
    low_stock = [p.to_dict() for p in products if 0 < p.quantity <= p.low_stock_threshold]
    out_of_stock = [p.to_dict() for p in products if p.quantity == 0]

    categories = {}
    for p in products:
        if p.category not in categories:
            categories[p.category] = {'count': 0, 'value': 0}
        categories[p.category]['count'] += 1
        categories[p.category]['value'] += round(p.quantity * p.unit_price, 2)

    expiring_soon = [p.to_dict() for p in products
                     if p.expiry_date and (p.expiry_date - datetime.utcnow()).days <= 30]

    result = {
        'total_products': total_products,
        'total_value': round(total_value, 2),
        'total_cost': round(total_cost, 2),
        'estimated_profit': round(total_value - total_cost, 2),
        'low_stock_count': len(low_stock),
        'out_of_stock_count': len(out_of_stock),
        'low_stock_items': low_stock,
        'out_of_stock_items': out_of_stock,
        'categories': categories,
        'expiring_soon': expiring_soon,
    }
    cache_set(cache_key, result, ttl_sec=30)
    return jsonify(result)

@app.route('/api/analytics', methods=['GET'])
@login_required
def get_analytics():
    uid = current_user_id()
    days = request.args.get('days', 30, type=int)
    since = datetime.utcnow() - timedelta(days=days)

    txs = Transaction.query.filter(Transaction.created_at >= since, Transaction.user_id == uid).all()
    daily = {}
    product_movement = {}
    for tx in txs:
        day = tx.created_at.strftime('%Y-%m-%d')
        daily[day] = daily.get(day, 0) + tx.quantity
        pid = tx.product_id
        if pid not in product_movement:
            product_movement[pid] = {'add': 0, 'remove': 0}
        product_movement[pid][tx.transaction_type if tx.transaction_type in ('add', 'remove') else 'add'] += tx.quantity

    products = Product.query.filter_by(is_active=True, user_id=uid).all()
    product_map = {p.id: p for p in products}

    movers = []
    for pid, mv in product_movement.items():
        p = product_map.get(pid)
        if not p: continue
        movers.append({
            'id': pid, 'name': p.name, 'sku': p.sku,
            'units_out': mv['remove'], 'units_in': mv['add'],
            'current_qty': p.quantity,
        })

    movers.sort(key=lambda x: x['units_out'], reverse=True)
    fast_movers = movers[:5]
    slow_movers = sorted(movers, key=lambda x: x['units_out'])[:5]

    active_ids = set(product_movement.keys())
    dead_stock = [{'id': p.id, 'name': p.name, 'sku': p.sku, 'quantity': p.quantity,
                   'value': round(p.quantity * p.unit_price, 2)}
                  for p in products if p.id not in active_ids and p.quantity > 0]

    total_removed = sum(m['remove'] for m in product_movement.values())
    avg_inventory = sum(p.quantity for p in products) / max(1, len(products))
    turnover_rate = round(total_removed / max(1, avg_inventory), 2)

    cat_stats = {}
    for p in products:
        c = p.category
        if c not in cat_stats:
            cat_stats[c] = {'products': 0, 'total_qty': 0, 'total_value': 0}
        cat_stats[c]['products'] += 1
        cat_stats[c]['total_qty'] += p.quantity
        cat_stats[c]['total_value'] = round(cat_stats[c]['total_value'] + p.quantity * p.unit_price, 2)

    predictions = []
    for m in fast_movers:
        if m['units_out'] > 0 and m['current_qty'] > 0:
            daily_rate = m['units_out'] / days
            days_until_out = int(m['current_qty'] / daily_rate) if daily_rate > 0 else 999
            p = product_map.get(m['id'])
            lead = p.supplier_lead_days if p else 7
            predictions.append({
                'id': m['id'], 'name': m['name'], 'sku': m['sku'],
                'current_qty': m['current_qty'],
                'daily_usage': round(daily_rate, 2),
                'days_until_stockout': days_until_out,
                'reorder_in_days': max(0, days_until_out - lead),
                'suggested_reorder_qty': max(50, int(daily_rate * 30)),
                'urgency': 'critical' if days_until_out <= lead else 'soon' if days_until_out <= lead * 2 else 'normal',
            })

    return jsonify({
        'period_days': days,
        'daily_volume': daily,
        'fast_movers': fast_movers,
        'slow_movers': slow_movers,
        'dead_stock': dead_stock,
        'turnover_rate': turnover_rate,
        'category_stats': cat_stats,
        'stock_predictions': predictions,
        'total_transactions': len(txs),
    })

@app.route('/api/analytics/supplier', methods=['GET'])
@login_required
def supplier_analytics():
    uid = current_user_id()
    products = Product.query.filter_by(is_active=True, user_id=uid).all()
    suppliers = {}
    for p in products:
        s = p.supplier or 'Unknown'
        if s not in suppliers:
            suppliers[s] = {'products': 0, 'total_value': 0, 'low_stock_products': 0}
        suppliers[s]['products'] += 1
        suppliers[s]['total_value'] = round(suppliers[s]['total_value'] + p.quantity * p.unit_price, 2)
        if p.quantity <= p.low_stock_threshold:
            suppliers[s]['low_stock_products'] += 1
    return jsonify({'suppliers': suppliers})

# ─── Search ────────────────────────────────────────────────────────────────────

@app.route('/api/search', methods=['GET'])
@login_required
def search_products():
    uid = current_user_id()
    q = request.args.get('q', '')
    category = request.args.get('category', '')
    status = request.args.get('status', '')
    warehouse_id = request.args.get('warehouse_id', None, type=int)
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)

    query = Product.query.filter_by(is_active=True, user_id=uid)
    if warehouse_id:
        query = query.filter_by(warehouse_id=warehouse_id)
    if q:
        query = query.filter(db.or_(
            Product.name.ilike(f'%{q}%'),
            Product.sku.ilike(f'%{q}%'),
            Product.supplier.ilike(f'%{q}%'),
            Product.category.ilike(f'%{q}%'),
        ))
    if category:
        query = query.filter_by(category=category)
    if status == 'ok':
        query = query.filter(Product.quantity > Product.low_stock_threshold)
    elif status == 'low':
        query = query.filter(Product.quantity > 0, Product.quantity <= Product.low_stock_threshold)
    elif status == 'out':
        query = query.filter(Product.quantity == 0)

    paginated = query.paginate(page=page, per_page=per_page, error_out=False)
    return jsonify({'products': [p.to_dict() for p in paginated.items], 'total': paginated.total})

# ─── Notifications ─────────────────────────────────────────────────────────────

@app.route('/api/notifications', methods=['GET'])
@login_required
def get_notifications():
    uid = current_user_id()
    notifs = Notification.query.filter_by(is_read=False, user_id=uid).order_by(Notification.created_at.desc()).limit(20).all()
    return jsonify([n.to_dict() for n in notifs])

@app.route('/api/notifications/<int:nid>/read', methods=['POST'])
@login_required
def mark_notification_read(nid):
    uid = current_user_id()
    n = Notification.query.filter_by(id=nid, user_id=uid).first_or_404()
    n.is_read = True
    db.session.commit()
    return jsonify({'ok': True})

@app.route('/api/notifications/read-all', methods=['POST'])
@login_required
def mark_all_read():
    uid = current_user_id()
    Notification.query.filter_by(user_id=uid).update({'is_read': True})
    db.session.commit()
    return jsonify({'ok': True})

# ─── Email Alerts ──────────────────────────────────────────────────────────────

def _is_email_on_cooldown(uid: int, product_id: int, alert_type: str) -> bool:
    key = f'{uid}:{product_id}:{alert_type}'
    last_sent = _email_cooldown.get(key)
    if last_sent and (datetime.utcnow() - last_sent).total_seconds() < EMAIL_COOLDOWN_SECONDS:
        return True
    return False

def _mark_email_sent(uid: int, product_id: int, alert_type: str):
    _email_cooldown[f'{uid}:{product_id}:{alert_type}'] = datetime.utcnow()

def _send_email_async(to_addr: str, subject: str, html_body: str):
    """Send email in a background thread so it never blocks a request."""
    def _send():
        if not MAIL_USERNAME or not MAIL_PASSWORD:
            app.logger.warning('Email not configured: MAIL_USERNAME or MAIL_PASSWORD missing.')
            return
        try:
            msg = MIMEMultipart('alternative')
            msg['Subject'] = subject
            msg['From']    = MAIL_FROM
            msg['To']      = to_addr
            msg.attach(MIMEText(html_body, 'html'))
            try:
                with smtplib.SMTP_SSL(MAIL_SERVER, 465) as server:
                    server.login(MAIL_USERNAME, MAIL_PASSWORD)
                    server.sendmail(MAIL_FROM, to_addr, msg.as_string())
            except Exception:
                with smtplib.SMTP(MAIL_SERVER, MAIL_PORT) as server:
                    if MAIL_USE_TLS:
                        server.starttls()
                    server.login(MAIL_USERNAME, MAIL_PASSWORD)
                    server.sendmail(MAIL_FROM, to_addr, msg.as_string())
            app.logger.info(f'Low-stock email sent to {to_addr} — {subject}')
        except Exception as exc:
            app.logger.error(f'Failed to send email to {to_addr}: {exc}')
    threading.Thread(target=_send, daemon=True).start()

def _build_low_stock_email(product, warehouse_name: str, username: str) -> tuple[str, str]:
    """Return (subject, html_body) for a low-stock alert email."""
    is_out   = product.quantity == 0
    status   = 'OUT OF STOCK' if is_out else 'LOW STOCK'
    color    = '#e53e3e' if is_out else '#dd6b20'
    icon     = '🚨' if is_out else '⚠️'
    reorder_qty = max(50, int((product.low_stock_threshold * 3)))

    subject = f'{icon} [{status}] {product.name} — ARIA Inventory Alert'

    html = f"""
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f1a;padding:40px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1a1a2e;border-radius:16px;overflow:hidden;border:1px solid #2d2d4e">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#7b5ea7,#9b6dff);padding:32px 40px;text-align:center">
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px">
              📦 ARIA Inventory Alert
            </h1>
            <p style="margin:8px 0 0;color:rgba(255,255,255,0.8);font-size:14px">Automated Stock Notification</p>
          </td>
        </tr>

        <!-- Status Badge -->
        <tr>
          <td style="padding:32px 40px 0;text-align:center">
            <span style="display:inline-block;background:{color};color:#fff;font-size:13px;font-weight:700;
                         letter-spacing:1px;padding:8px 20px;border-radius:50px;text-transform:uppercase">
              {icon} {status}
            </span>
          </td>
        </tr>

        <!-- Product Details Card -->
        <tr>
          <td style="padding:24px 40px">
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="background:#0f0f1a;border-radius:12px;border:1px solid #2d2d4e;overflow:hidden">
              <tr>
                <td style="padding:20px 24px;border-bottom:1px solid #2d2d4e">
                  <p style="margin:0;color:#9a9bb0;font-size:12px;text-transform:uppercase;letter-spacing:0.8px">Product</p>
                  <p style="margin:6px 0 0;color:#ffffff;font-size:20px;font-weight:700">{product.name}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:0">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding:16px 24px;border-right:1px solid #2d2d4e;border-bottom:1px solid #2d2d4e">
                        <p style="margin:0;color:#9a9bb0;font-size:11px;text-transform:uppercase">SKU</p>
                        <p style="margin:4px 0 0;color:#9b6dff;font-size:14px;font-weight:600;font-family:monospace">{product.sku}</p>
                      </td>
                      <td style="padding:16px 24px;border-bottom:1px solid #2d2d4e">
                        <p style="margin:0;color:#9a9bb0;font-size:11px;text-transform:uppercase">Category</p>
                        <p style="margin:4px 0 0;color:#e2e8f0;font-size:14px;font-weight:600">{product.category}</p>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:16px 24px;border-right:1px solid #2d2d4e;border-bottom:1px solid #2d2d4e">
                        <p style="margin:0;color:#9a9bb0;font-size:11px;text-transform:uppercase">Current Stock</p>
                        <p style="margin:4px 0 0;color:{color};font-size:22px;font-weight:800">{product.quantity} units</p>
                      </td>
                      <td style="padding:16px 24px;border-bottom:1px solid #2d2d4e">
                        <p style="margin:0;color:#9a9bb0;font-size:11px;text-transform:uppercase">Low Stock Threshold</p>
                        <p style="margin:4px 0 0;color:#e2e8f0;font-size:22px;font-weight:800">{product.low_stock_threshold} units</p>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:16px 24px;border-right:1px solid #2d2d4e">
                        <p style="margin:0;color:#9a9bb0;font-size:11px;text-transform:uppercase">Supplier</p>
                        <p style="margin:4px 0 0;color:#e2e8f0;font-size:14px;font-weight:600">{product.supplier or '—'}</p>
                      </td>
                      <td style="padding:16px 24px">
                        <p style="margin:0;color:#9a9bb0;font-size:11px;text-transform:uppercase">Supplier Lead Time</p>
                        <p style="margin:4px 0 0;color:#e2e8f0;font-size:14px;font-weight:600">{product.supplier_lead_days} days</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:16px 24px">
                  <p style="margin:0;color:#9a9bb0;font-size:11px;text-transform:uppercase">Warehouse</p>
                  <p style="margin:4px 0 0;color:#e2e8f0;font-size:14px;font-weight:600">{warehouse_name}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Recommendation -->
        <tr>
          <td style="padding:0 40px 24px">
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="background:rgba(155,109,255,0.1);border:1px solid rgba(155,109,255,0.3);border-radius:12px">
              <tr>
                <td style="padding:20px 24px">
                  <p style="margin:0;color:#9b6dff;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">
                    💡 Recommended Action
                  </p>
                  <p style="margin:10px 0 0;color:#c4c4d4;font-size:14px;line-height:1.7">
                    {'This product is completely out of stock. Place a reorder immediately to avoid fulfillment delays.' if is_out else
                     f'Stock is critically low. We recommend reordering at least <strong style="color:#ffffff">{reorder_qty} units</strong> from <strong style="color:#ffffff">{product.supplier or "your supplier"}</strong> as soon as possible.'}
                    {''}
                    {f'<br><br>With a supplier lead time of <strong style="color:#ffffff">{product.supplier_lead_days} days</strong>, order now to prevent stockout.' if not is_out and product.supplier_lead_days else ''}
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 40px 32px;border-top:1px solid #2d2d4e;text-align:center">
            <p style="margin:0;color:#5a5a7a;font-size:12px;line-height:1.6">
              This alert was sent automatically by <strong style="color:#9b6dff">ARIA Inventory System</strong>
              for account <strong style="color:#9b6dff">{username}</strong>.<br>
              Sent at {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
"""
    return subject, html

def _send_stock_alert_email(product, alert_type: str):
    """
    Lookup the product owner's email and fire an alert email if:
      - the owner has an email address on file
      - email credentials are configured
      - the alert is not on cooldown for this product+type
    """
    user = User.query.get(product.user_id)
    if not user or not user.email:
        return
    if not MAIL_USERNAME or not MAIL_PASSWORD:
        return
    if _is_email_on_cooldown(user.id, product.id, alert_type):
        return

    warehouse_name = 'Unknown Warehouse'
    if product.warehouse_id:
        wh = Warehouse.query.get(product.warehouse_id)
        if wh:
            warehouse_name = wh.name

    subject, html_body = _build_low_stock_email(product, warehouse_name, user.username)
    _mark_email_sent(user.id, product.id, alert_type)
    _send_email_async(user.email, subject, html_body)

def _check_and_notify(product):
    if product.quantity == 0:
        _push_notif(product.user_id, 'out_stock', f'⚠️ {product.name} is OUT OF STOCK', product.id)
        _send_stock_alert_email(product, 'out_stock')
    elif product.quantity <= product.low_stock_threshold:
        _push_notif(product.user_id, 'low_stock', f'📉 {product.name} is low: {product.quantity} units remaining', product.id)
        _send_stock_alert_email(product, 'low_stock')
    if product.expiry_date:
        days = (product.expiry_date - datetime.utcnow()).days
        if days <= 30:
            _push_notif(product.user_id, 'expiry', f'🗓 {product.name} expires in {days} days', product.id)

def _push_notif(user_id, type, message, product_id=None):
    n = Notification(user_id=user_id, type=type, message=message, product_id=product_id)
    db.session.add(n)
    db.session.commit()

def _detect_anomaly(product, tx_type, qty, old_qty):
    if tx_type == 'remove' and old_qty > 0:
        drop_pct = (qty / old_qty) * 100
        if drop_pct >= 50:
            _push_notif(product.user_id, 'anomaly',
                f'🚨 Anomaly: {product.name} stock dropped {drop_pct:.0f}% ({old_qty}→{product.quantity}) in one transaction',
                product.id)

# ─── AI Context ────────────────────────────────────────────────────────────────

GROQ_API_KEY = os.environ.get('GROQ_API_KEY', '')

def get_inventory_context(uid, include_analytics=True):
    products = Product.query.filter_by(is_active=True, user_id=uid).all()
    stats = {
        'total_products': len(products),
        'total_value': round(sum(p.quantity * p.unit_price for p in products), 2),
        'total_cost': round(sum(p.quantity * p.cost_price for p in products), 2),
        'low_stock': [p.to_dict() for p in products if 0 < p.quantity <= p.low_stock_threshold],
        'out_of_stock': [p.to_dict() for p in products if p.quantity == 0],
        'expiring_soon': [p.to_dict() for p in products
                          if p.expiry_date and (p.expiry_date - datetime.utcnow()).days <= 30],
    }
    stats['estimated_profit'] = round(stats['total_value'] - stats['total_cost'], 2)
    product_list = [p.to_dict() for p in products]

    analytics_ctx = ''
    if include_analytics:
        since = datetime.utcnow() - timedelta(days=30)
        txs = Transaction.query.filter(Transaction.created_at >= since, Transaction.user_id == uid).all()
        usage = {}
        for tx in txs:
            if tx.transaction_type == 'remove':
                usage[tx.product_id] = usage.get(tx.product_id, 0) + tx.quantity
        top_used = sorted(usage.items(), key=lambda x: x[1], reverse=True)[:3]
        pid_map = {p.id: p.name for p in products}
        analytics_ctx = '\n## 30-Day Usage (top consumed):\n' + \
            '\n'.join([f'- {pid_map.get(pid,"?")} : {qty} units out' for pid, qty in top_used])

        predictions = []
        for pid, qty_out in usage.items():
            p_obj = next((p for p in products if p.id == pid), None)
            if p_obj and qty_out > 0 and p_obj.quantity > 0:
                daily = qty_out / 30
                days_left = int(p_obj.quantity / daily)
                if days_left <= 14:
                    predictions.append(f'- {p_obj.name}: ~{days_left} days of stock left (reorder in {max(0,days_left-p_obj.supplier_lead_days)}d)')
        if predictions:
            analytics_ctx += '\n## ⚠️ Stock Predictions (urgent):\n' + '\n'.join(predictions)

    return stats, product_list, analytics_ctx


SYSTEM_PROMPT = """You are ARIA (Automated Resource and Inventory Assistant) — an intelligent AI Inventory Copilot. You don't just execute commands; you proactively advise, predict, and surface insights.

## Your Dual Mode:
1. **EXECUTE mode**: Perform CRUD operations via JSON action blocks
2. **INSIGHT mode**: Give strategic recommendations, predictions, and analysis

## Available Actions (JSON blocks):

### Add a new product:
```json
{"action": "create_product", "data": {"name": "Product Name", "sku": "SKU001", "category": "Category", "quantity": 100, "unit_price": 9.99, "cost_price": 5.00, "supplier": "Supplier Name", "supplier_lead_days": 7, "low_stock_threshold": 10, "description": "..."}}
```

### Update stock:
```json
{"action": "update_stock", "product_id": 1, "stock_action": "add", "quantity": 50, "note": "Restock from supplier"}
```

### Delete a product:
```json
{"action": "delete_product", "product_id": 1}
```

### Update product details:
```json
{"action": "update_product", "product_id": 1, "data": {"name": "New Name", "unit_price": 15.99, "category": "Electronics", "supplier": "Supplier", "low_stock_threshold": 10}}
```

## INSIGHT MODE — Activate when users ask:
- "What should I restock?" → Analyze 30-day usage, identify items nearing stockout, recommend reorder quantities
- "Which products are dead stock?" → List items with no movement and high quantity
- "How is my inventory performing?" → Give a health score, top movers, concerns
- "What should I buy this week?" → Prioritize by urgency (days until stockout vs supplier lead time)
- "Anomalies?" or "Anything unusual?" → Flag unexpected drops, products with no movement
- Any open-ended question → Default to giving actionable insights, not just raw data

## INTELLIGENCE RULES:
- Always calculate: if daily usage is X and stock is Y, stockout in Y/X days. If supplier lead is Z days, reorder by day (Y/X - Z).
- When recommending restock, suggest: quantity = (daily_rate × 30) + safety_buffer (20%)
- For dead stock: items with 0 transactions in 30 days and qty > threshold → suggest promotion or markdown
- For anomalies: sudden drops of 50%+ in one transaction → flag it
- Always mention profit impact when relevant (use cost_price and unit_price data)

## CRUD RULES (same as before):
- name + sku MANDATORY for create_product. Ask if missing.
- NEVER delete without explicit confirmation ("yes, delete it")
- For updates, only change fields explicitly mentioned
- Always confirm actions taken

## Formatting:
- Use **bold** for product names and key numbers
- Use bullet points for lists of items
- Be conversational but data-driven
- For insights, structure as: 🔍 Finding → 💡 Recommendation
"""

VOICE_SYSTEM_PROMPT = """You are ARIA, a voice-enabled AI inventory assistant with intelligence. Reply as if talking out loud.

STRICT VOICE RULES:
- MAX 2-3 sentences for simple queries, 4-5 for complex insights.
- No markdown, bullets, asterisks — plain spoken sentences only.
- Summarize lists: "3 items are low on stock" not all 3 names unless asked.
- Get straight to the point — no filler phrases.
- For insights: give the single most important finding, not a full analysis.

INTELLIGENCE RULES (voice):
- If asked "what should I restock?", give the TOP 1 most urgent item with days remaining.
- If asked about dead stock, name the biggest one.
- Always relate numbers to action: not "stock is 8" but "only 8 left, should reorder soon."

CRUD RULES:
- name + SKU mandatory for create_product. If either is missing, ask for it before proceeding.
- Never delete without explicit confirmation: say "Just to confirm — delete [name]? Say yes to proceed." and wait.
- Stock changes: execute directly with JSON block, confirm in one sentence.
- For updates, only change fields the user explicitly mentioned.
- Always confirm what action was taken in one plain spoken sentence after executing it.

AVAILABLE ACTIONS — embed these JSON blocks in your reply (they are executed silently, never read aloud):

Add a new product:
```json
{"action": "create_product", "data": {"name": "Product Name", "sku": "SKU001", "category": "Category", "quantity": 0, "unit_price": 0.00, "cost_price": 0.00, "supplier": "Supplier Name", "supplier_lead_days": 7, "low_stock_threshold": 10, "description": ""}}
```

Update stock levels:
```json
{"action": "update_stock", "product_id": 1, "stock_action": "add", "quantity": 50, "note": "Restock"}
```
stock_action can be "add", "remove", or "set".

Edit product details:
```json
{"action": "update_product", "product_id": 1, "data": {"name": "New Name", "unit_price": 15.99, "category": "Electronics", "supplier": "Supplier", "low_stock_threshold": 10}}
```

Delete a product (only after user confirms with "yes"):
```json
{"action": "delete_product", "product_id": 1}
```

Use the product list in the inventory data to find the correct product_id when the user mentions a product by name.
"""

# ─── AI Chat Routes ────────────────────────────────────────────────────────────

@app.route('/api/chat', methods=['POST'])
@login_required
def chat():
    uid = current_user_id()
    data = request.json
    messages = data.get('messages', [])[-10:]

    if not GROQ_API_KEY:
        return jsonify({'error': 'Server API key not configured. Contact admin.'}), 400

    stats, product_list, analytics_ctx = get_inventory_context(uid, include_analytics=True)
    inventory_context = f"""
## Current Inventory Status:
- Total Products: {stats['total_products']}
- Total Inventory Value: ${stats['total_value']:.2f}
- Total Cost Basis: ${stats['total_cost']:.2f}
- Estimated Gross Profit: ${stats['estimated_profit']:.2f}
- Low Stock Items: {len(stats['low_stock'])}
- Out of Stock Items: {len(stats['out_of_stock'])}
- Expiring Soon: {len(stats['expiring_soon'])}

## Product Catalog:
{json.dumps(product_list, indent=2)}

## Low Stock Alerts:
{json.dumps(stats['low_stock'], indent=2) if stats['low_stock'] else 'None'}

## Expiring Soon:
{json.dumps(stats['expiring_soon'], indent=2) if stats['expiring_soon'] else 'None'}
{analytics_ctx}
"""

    system_with_context = SYSTEM_PROMPT + f"\n\n{inventory_context}"

    try:
        client = Groq(api_key=GROQ_API_KEY)
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "system", "content": system_with_context}] + messages,
            temperature=0.7,
            max_tokens=2048
        )
        ai_message = response.choices[0].message.content

        actions_taken = []
        for match in re.finditer(r'```json\s*(\{[^`]+\})\s*```', ai_message, re.DOTALL):
            try:
                action_data = json.loads(match.group(1))
                result = execute_ai_action(action_data, uid)
                actions_taken.append(result)
            except Exception as e:
                actions_taken.append({'error': str(e)})

        return jsonify({
            'message': ai_message,
            'actions_taken': actions_taken,
            'usage': {
                'prompt_tokens': response.usage.prompt_tokens,
                'completion_tokens': response.usage.completion_tokens
            }
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/voice/chat', methods=['POST'])
@login_required
def voice_chat():
    uid = current_user_id()
    data = request.json
    messages = data.get('messages', [])[-6:]

    if not GROQ_API_KEY:
        return jsonify({'error': 'Server API key not configured.'}), 400

    stats, product_list, analytics_ctx = get_inventory_context(uid, include_analytics=True)
    inventory_context = f"""
Current Inventory: {stats['total_products']} products, total value ${stats['total_value']:.2f}, profit ${stats['estimated_profit']:.2f}.
Low stock: {len(stats['low_stock'])} items. Out of stock: {len(stats['out_of_stock'])} items.
Expiring soon: {len(stats['expiring_soon'])} items.

Products (use 'id' field for action blocks):
{json.dumps(product_list)}

Low stock items: {json.dumps(stats['low_stock']) if stats['low_stock'] else 'none'}
{analytics_ctx}
"""

    try:
        client = Groq(api_key=GROQ_API_KEY)
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "system", "content": VOICE_SYSTEM_PROMPT + f"\n\nINVENTORY DATA:\n{inventory_context}"}] + messages,
            temperature=0.5,
            max_tokens=600
        )
        ai_message = response.choices[0].message.content

        actions_taken = []
        for match in re.finditer(r'```json\s*(\{[^`]+\})\s*```', ai_message, re.DOTALL):
            try:
                action_data = json.loads(match.group(1))
                result = execute_ai_action(action_data, uid)
                actions_taken.append(result)
            except Exception as e:
                actions_taken.append({'error': str(e)})

        return jsonify({'message': ai_message, 'actions_taken': actions_taken})

    except Exception as e:
        return jsonify({'error': str(e)}), 500


def execute_ai_action(action_data, uid):
    action = action_data.get('action')
    try:
        if action == 'create_product':
            d = action_data.get('data', {})
            if not d.get('name') or not d.get('sku'):
                return {'action': action, 'status': 'error', 'message': 'Name and SKU required'}
            sku = sanitize(d['sku'])
            if Product.query.filter_by(sku=sku, user_id=uid, is_active=True).first():
                return {'action': action, 'status': 'error', 'message': f"SKU '{sku}' already exists"}
            p = Product(
                user_id=uid,
                name=sanitize(d['name']),
                sku=sku,
                category=sanitize(d.get('category', 'General')),
                quantity=max(0, int(d.get('quantity', 0))),
                unit_price=max(0, float(d.get('unit_price', 0))),
                cost_price=max(0, float(d.get('cost_price', 0))),
                supplier=sanitize(d.get('supplier', '')),
                supplier_lead_days=max(1, int(d.get('supplier_lead_days', 7))),
                low_stock_threshold=max(0, int(d.get('low_stock_threshold', 10))),
                description=sanitize(d.get('description', '')),
            )
            db.session.add(p)
            db.session.commit()
            cache_bust(f'stats_{uid}')
            _check_and_notify(p)
            return {'action': action, 'status': 'success', 'product': p.to_dict()}

        elif action == 'update_stock':
            p = Product.query.filter_by(id=action_data['product_id'], user_id=uid).first()
            if not p:
                return {'action': action, 'status': 'error', 'message': 'Product not found'}
            stock_action = action_data.get('stock_action', 'add')
            qty = int(action_data.get('quantity', 0))
            note = sanitize(action_data.get('note', 'AI action'))
            old_qty = p.quantity
            if stock_action == 'add':
                p.quantity += qty
            elif stock_action == 'remove':
                if p.quantity < qty:
                    return {'action': action, 'status': 'error', 'message': 'Insufficient stock'}
                p.quantity -= qty
            elif stock_action == 'set':
                p.quantity = max(0, qty)
            p.updated_at = datetime.utcnow()
            tx = Transaction(user_id=uid, product_id=p.id, transaction_type=stock_action, quantity=qty, note=note,
                             created_by=session.get('username', 'ARIA'))
            db.session.add(tx)
            db.session.commit()
            cache_bust(f'stats_{uid}')
            _check_and_notify(p)
            _detect_anomaly(p, stock_action, qty, old_qty)
            return {'action': action, 'status': 'success', 'product_id': p.id, 'old_quantity': old_qty, 'new_quantity': p.quantity}

        elif action == 'delete_product':
            p = Product.query.filter_by(id=action_data['product_id'], user_id=uid).first()
            if not p:
                return {'action': action, 'status': 'error', 'message': 'Product not found'}
            name = p.name
            p.is_active = False
            db.session.commit()
            cache_bust(f'stats_{uid}')
            return {'action': action, 'status': 'success', 'message': f"Deleted {name}"}

        elif action == 'update_product':
            p = Product.query.filter_by(id=action_data['product_id'], user_id=uid).first()
            if not p:
                return {'action': action, 'status': 'error', 'message': 'Product not found'}
            d = action_data.get('data', {})
            for k in ['name', 'category', 'supplier', 'description']:
                if k in d:
                    setattr(p, k, sanitize(d[k]))
            for k in ['unit_price', 'cost_price']:
                if k in d:
                    setattr(p, k, max(0, float(d[k])))
            for k in ['low_stock_threshold', 'supplier_lead_days']:
                if k in d:
                    setattr(p, k, max(0, int(d[k])))
            p.updated_at = datetime.utcnow()
            db.session.commit()
            cache_bust(f'stats_{uid}')
            return {'action': action, 'status': 'success', 'product': p.to_dict()}

        return {'action': action, 'status': 'error', 'message': 'Unknown action'}
    except Exception as e:
        db.session.rollback()
        return {'action': action, 'status': 'error', 'message': str(e)}

# ─── Voice Routes ────────────────────────────────────────────────────────────────

def _clean_for_tts(text):
    t = re.sub(r'```[\s\S]*?```', '', text)
    t = re.sub(r'\*\*(.*?)\*\*', r'\1', t)
    t = re.sub(r'\*(.*?)\*', r'\1', t)
    t = re.sub(r'`([^`]+)`', r'\1', t)
    t = re.sub(r'^#{1,4}\s+', '', t, flags=re.MULTILINE)
    t = re.sub(r'\s+', ' ', t).strip()
    return t[:1000]

@app.route('/api/voice/transcribe', methods=['POST'])
@login_required
def voice_transcribe():
    if not GROQ_API_KEY:
        return jsonify({'error': 'GROQ_API_KEY not configured'}), 400
    if 'audio' not in request.files:
        return jsonify({'error': 'No audio file provided'}), 400
    f = request.files['audio']
    audio_bytes = f.read()
    filename = f.filename or 'voice.webm'
    try:
        client = Groq(api_key=GROQ_API_KEY)
        transcription = client.audio.transcriptions.create(
            file=(filename, audio_bytes, 'audio/webm'),
            model='whisper-large-v3',
            language='en',
            response_format='json'
        )
        return jsonify({'text': transcription.text.strip()})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/voice/speak', methods=['POST'])
@login_required
def voice_speak():
    if not GROQ_API_KEY:
        return jsonify({'error': 'GROQ_API_KEY not configured', 'use_browser_tts': True}), 400
    data = request.json or {}
    text = data.get('text', '').strip()
    if not text:
        return jsonify({'error': 'No text provided', 'use_browser_tts': True}), 400
    clean = _clean_for_tts(text)
    client = Groq(api_key=GROQ_API_KEY)
    try:
        resp = client.audio.speech.create(model='playai-tts', voice='Fritz-PlayAI', input=clean, response_format='mp3')
        return Response(resp.read(), mimetype='audio/mpeg', headers={'Content-Disposition': 'inline; filename="aria.mp3"'})
    except Exception:
        pass
    try:
        resp = client.audio.speech.create(model='canopylabs/orpheus-v1-english', voice='tara', input=clean, response_format='wav')
        return Response(resp.read(), mimetype='audio/wav', headers={'Content-Disposition': 'inline; filename="aria.wav"'})
    except Exception as e:
        return jsonify({'error': str(e), 'use_browser_tts': True}), 500

# ─── Seed Data ─────────────────────────────────────────────────────────────────

def seed_sample_data():
    if User.query.count() == 0:
        admin = User(username='admin', email='admin@aria.local', password_hash=User.hash_pw('admin123'), role='admin')
        viewer = User(username='viewer', email='viewer@aria.local', password_hash=User.hash_pw('viewer123'), role='viewer')
        db.session.add_all([admin, viewer])
        db.session.commit()

        # Seed warehouses for admin user only
        admin_id = admin.id
        wh1 = Warehouse(user_id=admin_id, name='Main Warehouse', location='123 Industrial Ave, Chicago, IL', manager='John Smith', capacity=10000, description='Primary storage facility for all electronics and furniture.')
        wh2 = Warehouse(user_id=admin_id, name='East Wing Storage', location='456 Commerce Blvd, New York, NY', manager='Jane Doe', capacity=5000, description='Secondary storage for stationery and overflow stock.')
        db.session.add_all([wh1, wh2])
        db.session.commit()

        # Seed products scoped to admin, assigned to warehouses
        samples = [
            
        ]
        for s in samples:
            db.session.add(s)
        db.session.commit()

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
        seed_sample_data()
    app.run(host="0.0.0.0", port=5000, debug=True)