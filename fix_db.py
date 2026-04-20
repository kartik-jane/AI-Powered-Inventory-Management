import sqlite3, os

db_path = os.path.join('instance', 'inventory.db')
conn = sqlite3.connect(db_path)

# Show all warehouses
rows = conn.execute('SELECT id, name, location, lat, lng FROM warehouse').fetchall()
print('Warehouses:')
for r in rows:
    print(r)

# Set Nagpur coords for the warehouse (Kalmeshwar, Nagpur)
conn.execute('UPDATE warehouse SET lat=21.2897, lng=79.0567 WHERE name LIKE "%Logistics%"')
conn.commit()

# Verify
rows = conn.execute('SELECT id, name, lat, lng FROM warehouse').fetchall()
print('\nAfter update:')
for r in rows:
    print(r)

conn.close()
print('Done!')