import os
import sqlite3
from config import DATA_DIR

def get_user_db(username):
    os.makedirs(DATA_DIR, exist_ok=True)
    db_path = os.path.join(DATA_DIR, f'{username}.db')
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute('SELECT is_public FROM pages LIMIT 1')
    except sqlite3.OperationalError:
        try:
            conn.execute('ALTER TABLE pages ADD COLUMN is_public INTEGER DEFAULT 0')
        except sqlite3.OperationalError:
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
    return conn

def init_user_db(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS pages (
            id TEXT PRIMARY KEY,
            title TEXT,
            content TEXT,
            parent_id TEXT DEFAULT 'root',
            is_public INTEGER DEFAULT 0,
            created_at REAL,
            updated_at REAL
        )
    ''')
    try:
        conn.execute('SELECT is_public FROM pages LIMIT 1')
    except sqlite3.OperationalError:
        conn.execute('ALTER TABLE pages ADD COLUMN is_public INTEGER DEFAULT 0')
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
