import os
import sqlite3
from config import DATA_DIR

def _ensure_pages_columns(conn):
    # Base table (includes rev for new DBs). Existing DBs migrate via ALTER below.
    conn.execute('''
        CREATE TABLE IF NOT EXISTS pages (
            id TEXT PRIMARY KEY,
            title TEXT,
            content TEXT,
            html_snapshot TEXT DEFAULT NULL,
            parent_id TEXT DEFAULT 'root',
            is_public INTEGER DEFAULT 0,
            rev INTEGER DEFAULT 1,
            created_at REAL,
            updated_at REAL
        )
    ''')
    for col, ddl in [
        ('is_public', 'ALTER TABLE pages ADD COLUMN is_public INTEGER DEFAULT 0'),
        ('html_snapshot', 'ALTER TABLE pages ADD COLUMN html_snapshot TEXT DEFAULT NULL'),
        ('rev', 'ALTER TABLE pages ADD COLUMN rev INTEGER DEFAULT 1'),
    ]:
        try:
            conn.execute(f'SELECT {col} FROM pages LIMIT 1')
        except sqlite3.OperationalError:
            try:
                conn.execute(ddl)
            except sqlite3.OperationalError:
                pass
    try:
        conn.execute('UPDATE pages SET rev = 1 WHERE rev IS NULL')
    except sqlite3.OperationalError:
        pass

def get_user_db(username):
    os.makedirs(DATA_DIR, exist_ok=True)
    db_path = os.path.join(DATA_DIR, f'{username}.db')
    print(f"[DEBUG get_user_db] db_path={db_path}, exists={os.path.exists(db_path)}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    _ensure_pages_columns(conn)
    try:
        conn.commit()
    except Exception:
        pass
    try:
        conn.execute('SELECT page_id FROM authors LIMIT 1')
    except sqlite3.OperationalError:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS authors (
                page_id TEXT,
                username TEXT,
                role TEXT DEFAULT 'author',
                created_at REAL,
                PRIMARY KEY (page_id, username)
            )
        ''')
    # Check user_settings table
    try:
        result = conn.execute('SELECT * FROM user_settings LIMIT 1').fetchone()
        print(f"[DEBUG get_user_db] user_settings for {username}: {dict(result) if result else 'empty'}")
    except sqlite3.OperationalError as e:
        print(f"[DEBUG get_user_db] user_settings table error: {e}")
    return conn

def init_user_db(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS pages (
            id TEXT PRIMARY KEY,
            title TEXT,
            content TEXT,
            html_snapshot TEXT DEFAULT NULL,
            parent_id TEXT DEFAULT 'root',
            is_public INTEGER DEFAULT 0,
            rev INTEGER DEFAULT 1,
            created_at REAL,
            updated_at REAL
        )
    ''')
    _ensure_pages_columns(conn)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    ''')
    try:
        conn.execute('SELECT page_id FROM authors LIMIT 1')
    except sqlite3.OperationalError:
        conn.execute('''
            CREATE TABLE authors (
                page_id TEXT,
                username TEXT,
                role TEXT DEFAULT 'author',
                created_at REAL,
                PRIMARY KEY (page_id, username)
            )
        ''')
    conn.commit()

def get_main_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    db_path = os.path.join(DATA_DIR, 'notionless_main.db')
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn

def init_main_db():
    conn = get_main_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS user_profiles (
            username TEXT PRIMARY KEY,
            display_name TEXT,
            bio TEXT,
            created_at REAL
        )
    ''')
    conn.commit()
    conn.close()
