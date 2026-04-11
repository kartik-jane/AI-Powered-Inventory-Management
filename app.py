from flask import Flask, render_template, request, jsonify, Response
from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
import json
import os
import re
import io
from groq import Groq
from dotenv import load_dotenv
load_dotenv()

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///inventory.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY')

db = SQLAlchemy(app)

# ─── Models ───────────────────────────────────────────────────────────────────

class Product(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(200), nullable=False)
    sku = db.Column(db.String(100), unique=True, nullable=False)
    category = db.Column(db.String(100), default='General')
    quantity = db.Column(db.Integer, default=0)
    unit_price = db.Column(db.Float, default=0.0)
    supplier = db.Column(db.String(200), default='')
    low_stock_threshold = db.Column(db.Integer, default=10)
    description = db.Column(db.Text, default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'sku': self.sku,
            'category': self.category,
            'quantity': self.quantity,
            'unit_price': self.unit_price,
            'supplier': self.supplier,
            'low_stock_threshold': self.low_stock_threshold,
            'description': self.description,
            'created_at': self.created_at.isoformat(),
            'updated_at': self.updated_at.isoformat(),
            'status': 'Low Stock' if self.quantity <= self.low_stock_threshold else 'In Stock' if self.quantity > 0 else 'Out of Stock'
        }

class Transaction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    product_id = db.Column(db.Integer, db.ForeignKey('product.id'), nullable=False)
    transaction_type = db.Column(db.String(50), nullable=False)  # 'add', 'remove', 'adjust'
    quantity = db.Column(db.Integer, nullable=False)
    note = db.Column(db.Text, default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    product = db.relationship('Product', backref='transactions')

    def to_dict(self):
        return {
            'id': self.id,
            'product_id': self.product_id,
            'product_name': self.product.name if self.product else 'Unknown',
            'transaction_type': self.transaction_type,
            'quantity': self.quantity,
            'note': self.note,
            'created_at': self.created_at.isoformat()
        }

# ─── Inventory API Routes ──────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/products', methods=['GET'])
def get_products():
    products = Product.query.all()
    return jsonify([p.to_dict() for p in products])

@app.route('/api/products', methods=['POST'])
def create_product():
    data = request.json
    if not data.get('name') or not data.get('sku'):
        return jsonify({'error': 'Name and SKU are required'}), 400
    if Product.query.filter_by(sku=data['sku']).first():
        return jsonify({'error': f"SKU '{data['sku']}' already exists"}), 400
    product = Product(
        name=data['name'],
        sku=data['sku'],
        category=data.get('category', 'General'),
        quantity=int(data.get('quantity', 0)),
        unit_price=float(data.get('unit_price', 0.0)),
        supplier=data.get('supplier', ''),
        low_stock_threshold=int(data.get('low_stock_threshold', 10)),
        description=data.get('description', '')
    )
    db.session.add(product)
    db.session.commit()
    return jsonify(product.to_dict()), 201

@app.route('/api/products/<int:product_id>', methods=['GET'])
def get_product(product_id):
    product = Product.query.get_or_404(product_id)
    return jsonify(product.to_dict())

@app.route('/api/products/<int:product_id>', methods=['PUT'])
def update_product(product_id):
    product = Product.query.get_or_404(product_id)
    data = request.json
    for field in ['name', 'category', 'unit_price', 'supplier', 'low_stock_threshold', 'description']:
        if field in data:
            setattr(product, field, data[field])
    if 'sku' in data and data['sku'] != product.sku:
        if Product.query.filter_by(sku=data['sku']).first():
            return jsonify({'error': f"SKU '{data['sku']}' already exists"}), 400
        product.sku = data['sku']
    product.updated_at = datetime.utcnow()
    db.session.commit()
    return jsonify(product.to_dict())

@app.route('/api/products/<int:product_id>', methods=['DELETE'])
def delete_product(product_id):
    product = Product.query.get_or_404(product_id)
    db.session.delete(product)
    db.session.commit()
    return jsonify({'message': f"Product '{product.name}' deleted successfully"})

@app.route('/api/products/<int:product_id>/stock', methods=['POST'])
def update_stock(product_id):
    product = Product.query.get_or_404(product_id)
    data = request.json
    action = data.get('action', 'add')
    qty = int(data.get('quantity', 0))
    note = data.get('note', '')
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
        product.quantity = qty
        tx_type = 'adjust'
    else:
        return jsonify({'error': 'Invalid action'}), 400
    product.updated_at = datetime.utcnow()
    tx = Transaction(product_id=product.id, transaction_type=tx_type,
                     quantity=qty, note=note)
    db.session.add(tx)
    db.session.commit()
    return jsonify({'product': product.to_dict(), 'old_quantity': old_qty, 'new_quantity': product.quantity})

@app.route('/api/transactions', methods=['GET'])
def get_transactions():
    limit = request.args.get('limit', 50, type=int)
    txs = Transaction.query.order_by(Transaction.created_at.desc()).limit(limit).all()
    return jsonify([t.to_dict() for t in txs])

@app.route('/api/stats', methods=['GET'])
def get_stats():
    products = Product.query.all()
    total_products = len(products)
    total_value = sum(p.quantity * p.unit_price for p in products)
    low_stock = [p.to_dict() for p in products if 0 < p.quantity <= p.low_stock_threshold]
    out_of_stock = [p.to_dict() for p in products if p.quantity == 0]
    categories = {}
    for p in products:
        categories[p.category] = categories.get(p.category, 0) + 1
    return jsonify({
        'total_products': total_products,
        'total_value': round(total_value, 2),
        'low_stock_count': len(low_stock),
        'out_of_stock_count': len(out_of_stock),
        'low_stock_items': low_stock,
        'out_of_stock_items': out_of_stock,
        'categories': categories
    })

@app.route('/api/search', methods=['GET'])
def search_products():
    q = request.args.get('q', '')
    category = request.args.get('category', '')
    products = Product.query
    if q:
        products = products.filter(
            db.or_(Product.name.ilike(f'%{q}%'), Product.sku.ilike(f'%{q}%'),
                   Product.supplier.ilike(f'%{q}%'))
        )
    if category:
        products = products.filter_by(category=category)
    return jsonify([p.to_dict() for p in products.all()])

# ─── AI Chat Route ─────────────────────────────────────────────────────────────

GROQ_API_KEY = os.environ.get('GROQ_API_KEY', '')

def get_inventory_context():
    products = Product.query.all()
    stats = {
        'total_products': len(products),
        'total_value': sum(p.quantity * p.unit_price for p in products),
        'low_stock': [p.to_dict() for p in products if 0 < p.quantity <= p.low_stock_threshold],
        'out_of_stock': [p.to_dict() for p in products if p.quantity == 0],
    }
    product_list = [p.to_dict() for p in products]
    return stats, product_list

SYSTEM_PROMPT = """You are ARIA (Automated Resource and Inventory Assistant), an intelligent AI assistant for an inventory management system. You help users manage their inventory through natural language.

You have access to the current inventory data provided in each message. You can perform the following actions by responding with special JSON commands embedded in your response.

## Available Actions (use JSON blocks):

### Add a new product:
```json
{"action": "create_product", "data": {"name": "Product Name", "sku": "SKU001", "category": "Category", "quantity": 100, "unit_price": 9.99, "supplier": "Supplier Name", "low_stock_threshold": 10, "description": "..."}}
```

### Update stock (add/remove/set):
```json
{"action": "update_stock", "product_id": 1, "stock_action": "add", "quantity": 50, "note": "Restock from supplier"}
```

### Delete a product:
```json
{"action": "delete_product", "product_id": 1}
```

### Update product details:
```json
{"action": "update_product", "product_id": 1, "data": {"name": "New Name", "unit_price": 15.99, "category": "Electronics", "supplier": "Supplier", "low_stock_threshold": 10, "description": "..."}}
```

## CRITICAL RULES FOR CRUD OPERATIONS:

### Adding a product — REQUIRED fields check:
- **name** and **sku** are MANDATORY. If either is missing, ASK the user before doing anything.
- For **quantity**, **unit_price**, **category**, **supplier** — if not provided, ask for them one by one in a friendly way. Do NOT use placeholder values like 0 or "General" silently; always confirm with the user first.
- Only embed the ```json create_product``` block AFTER you have all required information.
- Example: If user says "add a new laptop", respond: "I'd be happy to add that! Could you give me: the SKU, category, quantity, price, and supplier?"

### Updating a product — smart field handling:
- If the user says "update [product]" without specifying what to change, ask: "What would you like to update — name, price, category, supplier, or description?"
- Only update the fields the user explicitly mentioned.
- Always confirm the update: "Updated [Product Name]: [what changed]."
- After update, always include the full updated product details in your reply.

### Deleting a product — MUST confirm first:
- NEVER delete without explicit user confirmation.
- First ask: "Are you sure you want to delete '[product name]'? This cannot be undone. Reply 'yes, delete it' to confirm."
- Only embed the ```json delete_product``` block AFTER the user confirms with 'yes', 'confirm', 'delete it', or similar.

### Retrieving / searching products:
- When user asks to find, search, or get details about a product, look it up in the current inventory data and present the full details: name, SKU, category, quantity, price, supplier, status, and description.
- If not found by exact name, do a fuzzy match and suggest the closest match.

### Stock updates:
- If user says "add X units to [product]" or "remove X from [product]", do it directly — no confirmation needed for stock changes.
- If quantity not specified, ask: "How many units would you like to add/remove?"

## General Guidelines:
- Be conversational, helpful, and proactive
- When asked to add/update/delete items, ALWAYS include the JSON action block at the right time
- Suggest reordering for low-stock items
- Provide insights about inventory health
- If a product isn't found, suggest similar ones
- Format currency with $ symbol
- Be concise but thorough
- You can perform multiple actions in one response if needed
- Always acknowledge what action you performed after including the JSON block
- When a CRUD operation succeeds, always show the final product details so the UI can reflect the change
"""

VOICE_SYSTEM_PROMPT = """You are ARIA, a voice-enabled AI inventory assistant. The user is speaking to you — reply as if talking out loud.

STRICT VOICE RULES:
- Be SHORT. Max 2-3 sentences for simple queries. Max 4-5 sentences for complex ones.
- Answer ONLY what was asked. Do NOT volunteer extra info, tips, or suggestions unless asked.
- Do NOT read out long lists. Instead summarise: e.g. "You have 8 products. 2 are low on stock."
- Do NOT use markdown, bullet points, asterisks, or headers — plain spoken sentences only.
- Do NOT say "Great question!" or filler phrases. Get straight to the point.
- For numbers, say them naturally: "$1,999" → "nineteen ninety-nine dollars".
- When you perform an action (add/update/delete), confirm it in ONE short sentence.
- You can still embed JSON action blocks for inventory operations — they are processed silently.

CRUD RULES FOR VOICE:

Adding a product:
- Name and SKU are mandatory. If missing, ask: "What's the product name and SKU?" before doing anything.
- If quantity or price is missing, ask for it before creating.
- Only create after you have name, SKU, quantity, and price at minimum.

Updating a product:
- If the user doesn't say what to update, ask: "What should I update — the price, quantity, supplier, or something else?"
- Only update the fields they mentioned.

Deleting a product:
- Never delete without confirmation. Say: "Just to confirm — delete [product name]? Say yes to proceed."
- Only embed the delete JSON after the user confirms.

Retrieving a product:
- Read out the key details: name, quantity, price, status. Keep it brief for voice.

Stock updates:
- If quantity not specified, ask: "How many units?"

Examples of good voice replies:
  Query: "How many products do we have?"
  Reply: "You have 8 products in total, worth around twelve thousand four hundred dollars."

  Query: "Which items are low on stock?"
  Reply: "Two items are running low: USB-C Hub with 8 units and Ergonomic Mouse with 6 units."

  Query: "Add 50 keyboards"
  Reply: [JSON block] "Done — I've added 50 units to Wireless Keyboard. Stock is now 95."

  Query: "Add a new product"
  Reply: "Sure! What's the product name and SKU?"

  Query: "Delete the USB hub"
  Reply: "Just to confirm — delete USB-C Hub? Say yes to proceed."

You have access to inventory data in each message. Same JSON action blocks apply.
"""

@app.route('/api/chat', methods=['POST'])
def chat():
    data = request.json
    messages = data.get('messages', [])
    api_key = GROQ_API_KEY

    if not api_key:
        return jsonify({'error': 'Server API key not configured. Contact admin.'}), 400

    stats, product_list = get_inventory_context()
    inventory_context = f"""
## Current Inventory Status:
- Total Products: {stats['total_products']}
- Total Inventory Value: ${stats['total_value']:.2f}
- Low Stock Items: {len(stats['low_stock'])}
- Out of Stock Items: {len(stats['out_of_stock'])}

## Product Catalog:
{json.dumps(product_list, indent=2)}

## Low Stock Alerts:
{json.dumps(stats['low_stock'], indent=2) if stats['low_stock'] else 'None'}
"""

    system_with_context = SYSTEM_PROMPT + f"\n\n{inventory_context}"

    try:
        client = Groq(api_key=api_key)
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "system", "content": system_with_context}] + messages,
            temperature=0.7,
            max_tokens=2048
        )
        ai_message = response.choices[0].message.content

        # Parse and execute actions
        actions_taken = []
        action_pattern = r'```json\s*(\{[^`]+\})\s*```'
        matches = re.finditer(action_pattern, ai_message, re.DOTALL)

        for match in matches:
            try:
                action_data = json.loads(match.group(1))
                result = execute_ai_action(action_data)
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
def voice_chat():
    """Voice-optimised chat — returns concise spoken responses."""
    data = request.json
    messages = data.get('messages', [])
    api_key = GROQ_API_KEY

    if not api_key:
        return jsonify({'error': 'Server API key not configured.'}), 400

    stats, product_list = get_inventory_context()
    inventory_context = f"""
Current Inventory: {stats['total_products']} products, total value ${stats['total_value']:.2f}.
Low stock: {len(stats['low_stock'])} items. Out of stock: {len(stats['out_of_stock'])} items.

Products: {json.dumps(product_list)}
Low stock items: {json.dumps(stats['low_stock']) if stats['low_stock'] else 'none'}
"""

    system_with_context = VOICE_SYSTEM_PROMPT + f"\n\nINVENTORY DATA:\n{inventory_context}"

    try:
        client = Groq(api_key=api_key)
        response = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[{"role": "system", "content": system_with_context}] + messages,
            temperature=0.5,
            max_tokens=300   # Hard cap for voice brevity
        )
        ai_message = response.choices[0].message.content

        # Parse and execute actions (same as main chat)
        actions_taken = []
        action_pattern = r'```json\s*(\{[^`]+\})\s*```'
        matches = re.finditer(action_pattern, ai_message, re.DOTALL)
        for match in matches:
            try:
                action_data = json.loads(match.group(1))
                result = execute_ai_action(action_data)
                actions_taken.append(result)
            except Exception as e:
                actions_taken.append({'error': str(e)})

        return jsonify({
            'message': ai_message,
            'actions_taken': actions_taken,
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500

def execute_ai_action(action_data):
    action = action_data.get('action')
    try:
        if action == 'create_product':
            d = action_data['data']
            if Product.query.filter_by(sku=d['sku']).first():
                return {'action': action, 'status': 'error', 'message': f"SKU {d['sku']} already exists"}
            p = Product(**{k: v for k, v in d.items() if hasattr(Product, k)})
            db.session.add(p)
            db.session.commit()
            return {'action': action, 'status': 'success', 'product': p.to_dict()}

        elif action == 'update_stock':
            p = Product.query.get(action_data['product_id'])
            if not p:
                return {'action': action, 'status': 'error', 'message': 'Product not found'}
            stock_action = action_data.get('stock_action', 'add')
            qty = int(action_data.get('quantity', 0))
            note = action_data.get('note', 'AI action')
            old_qty = p.quantity
            if stock_action == 'add':
                p.quantity += qty
            elif stock_action == 'remove':
                if p.quantity < qty:
                    return {'action': action, 'status': 'error', 'message': 'Insufficient stock'}
                p.quantity -= qty
            elif stock_action == 'set':
                p.quantity = qty
            p.updated_at = datetime.utcnow()
            tx = Transaction(product_id=p.id, transaction_type=stock_action, quantity=qty, note=note)
            db.session.add(tx)
            db.session.commit()
            return {'action': action, 'status': 'success', 'product_id': p.id, 'old_quantity': old_qty, 'new_quantity': p.quantity}

        elif action == 'delete_product':
            p = Product.query.get(action_data['product_id'])
            if not p:
                return {'action': action, 'status': 'error', 'message': 'Product not found'}
            name = p.name
            db.session.delete(p)
            db.session.commit()
            return {'action': action, 'status': 'success', 'message': f"Deleted {name}"}

        elif action == 'update_product':
            p = Product.query.get(action_data['product_id'])
            if not p:
                return {'action': action, 'status': 'error', 'message': 'Product not found'}
            for k, v in action_data.get('data', {}).items():
                if hasattr(p, k):
                    setattr(p, k, v)
            p.updated_at = datetime.utcnow()
            db.session.commit()
            return {'action': action, 'status': 'success', 'product': p.to_dict()}

        return {'action': action, 'status': 'error', 'message': 'Unknown action'}
    except Exception as e:
        db.session.rollback()
        return {'action': action, 'status': 'error', 'message': str(e)}


# ─── Voice Routes ──────────────────────────────────────────────────────────────

def _clean_for_tts(text):
    """Strip markdown formatting so TTS reads cleanly."""
    t = re.sub(r'```[\s\S]*?```', '', text)
    t = re.sub(r'\*\*(.*?)\*\*', r'\1', t)
    t = re.sub(r'\*(.*?)\*', r'\1', t)
    t = re.sub(r'`([^`]+)`', r'\1', t)
    t = re.sub(r'^#{1,4}\s+', '', t, flags=re.MULTILINE)
    t = re.sub(r'\s+', ' ', t).strip()
    return t[:1000]


@app.route('/api/voice/transcribe', methods=['POST'])
def voice_transcribe():
    """Audio -> text via Groq Whisper. Returns: { "text": "..." }"""
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
def voice_speak():
    """
    Text -> speech. Tries playai-tts first, then orpheus, then signals
    the frontend to fall back to browser Web Speech API.
    Returns: audio stream  OR  JSON { "error": "...", "use_browser_tts": true }
    """
    if not GROQ_API_KEY:
        return jsonify({'error': 'GROQ_API_KEY not configured', 'use_browser_tts': True}), 400

    data = request.json or {}
    text = data.get('text', '').strip()
    if not text:
        return jsonify({'error': 'No text provided', 'use_browser_tts': True}), 400

    clean = _clean_for_tts(text)
    client = Groq(api_key=GROQ_API_KEY)

    # Attempt 1: playai-tts (Fritz-PlayAI voice)
    try:
        resp = client.audio.speech.create(
            model='playai-tts',
            voice='Fritz-PlayAI',
            input=clean,
            response_format='mp3'
        )
        return Response(resp.read(), mimetype='audio/mpeg',
                        headers={'Content-Disposition': 'inline; filename="aria.mp3"'})
    except Exception:
        pass

    # Attempt 2: canopylabs/orpheus-v1-english (replacement for playai-tts)
    try:
        resp = client.audio.speech.create(
            model='canopylabs/orpheus-v1-english',
            voice='tara',
            input=clean,
            response_format='wav'
        )
        return Response(resp.read(), mimetype='audio/wav',
                        headers={'Content-Disposition': 'inline; filename="aria.wav"'})
    except Exception as e:
        # Both Groq TTS models failed → tell the browser to use its own TTS
        return jsonify({'error': str(e), 'use_browser_tts': True}), 500


# ─── Seed Data ─────────────────────────────────────────────────────────────────

def seed_sample_data():
    if Product.query.count() == 0:
        samples = [
            Product(name='Wireless Keyboard', sku='ELEC-001', category='Electronics',
                    quantity=45, unit_price=79.99, supplier='TechSupplies Co.', low_stock_threshold=10),
            Product(name='USB-C Hub', sku='ELEC-002', category='Electronics',
                    quantity=8, unit_price=49.99, supplier='TechSupplies Co.', low_stock_threshold=10),
            Product(name='Office Chair', sku='FURN-001', category='Furniture',
                    quantity=12, unit_price=299.99, supplier='OfficeWorld', low_stock_threshold=5),
            Product(name='Standing Desk', sku='FURN-002', category='Furniture',
                    quantity=3, unit_price=599.99, supplier='OfficeWorld', low_stock_threshold=5),
            Product(name='Notebook Pack', sku='STAT-001', category='Stationery',
                    quantity=150, unit_price=12.99, supplier='PaperMart', low_stock_threshold=20),
            Product(name='Ballpoint Pens (50pk)', sku='STAT-002', category='Stationery',
                    quantity=0, unit_price=8.99, supplier='PaperMart', low_stock_threshold=15),
            Product(name='Monitor 27"', sku='ELEC-003', category='Electronics',
                    quantity=22, unit_price=399.99, supplier='DisplayTech', low_stock_threshold=8),
            Product(name='Ergonomic Mouse', sku='ELEC-004', category='Electronics',
                    quantity=6, unit_price=59.99, supplier='TechSupplies Co.', low_stock_threshold=10),
        ]
        for s in samples:
            db.session.add(s)
        db.session.commit()

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
        seed_sample_data()
    app.run(debug=True, port=5000)