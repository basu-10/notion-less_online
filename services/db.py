import os
import re
import sqlite3
from config import DATA_DIR

# Usernames are restricted at registration (auth.py / models/user.py), but DB
# helpers are reachable with arbitrary login input, so enforce the same rule
# here. Without this, `../`-style names resolve outside DATA_DIR and create /
# overwrite arbitrary SQLite files.
USERNAME_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{3,32}$')
MAIN_DB_FILENAME = 'notionless_main.db'


def is_valid_username(username):
    return bool(username) and bool(USERNAME_PATTERN.match(username))


def resolve_user_db_path(username):
    if not is_valid_username(username):
        raise ValueError('Invalid username')
    os.makedirs(DATA_DIR, exist_ok=True)
    base = os.path.abspath(DATA_DIR)
    db_path = os.path.abspath(os.path.join(base, f'{username}.db'))
    if db_path != os.path.join(base, f'{username}.db') or not db_path.startswith(base + os.sep):
        raise ValueError('Invalid username')
    return db_path


def _configure_conn(conn):
    # Free-tier Flask serves threaded requests against one SQLite file per
    # user. WAL + a generous busy timeout avoids "database is locked" errors
    # when a PUT races a toggle-public cascade; rollback-journal + 5s default
    # was losing writes under concurrency.
    try:
        conn.execute('PRAGMA journal_mode=WAL')
    except Exception:
        pass
    try:
        conn.execute('PRAGMA busy_timeout=30000')
    except Exception:
        pass
    try:
        conn.execute('PRAGMA foreign_keys=ON')
    except Exception:
        pass
    return conn

def _ensure_pages_columns(conn):
    # Base table (includes rev + published_at for new DBs). Existing DBs migrate via ALTER below.
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
            updated_at REAL,
            published_at REAL DEFAULT NULL
        )
    ''')
    for col, ddl in [
        ('is_public', 'ALTER TABLE pages ADD COLUMN is_public INTEGER DEFAULT 0'),
        ('html_snapshot', 'ALTER TABLE pages ADD COLUMN html_snapshot TEXT DEFAULT NULL'),
        ('rev', 'ALTER TABLE pages ADD COLUMN rev INTEGER DEFAULT 1'),
        ('published_at', 'ALTER TABLE pages ADD COLUMN published_at REAL DEFAULT NULL'),
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
    # Backfill other NULL-prone columns on old DBs. Additive only: never
    # rewrites existing non-NULL values, so current user data is untouched.
    # published_at = when the page was made public. Existing public pages
    # predate the column, so fall back to updated_at (set at publish time by
    # toggle-public) then created_at. Private pages keep NULL.
    for stmt in [
        'UPDATE pages SET is_public = 0 WHERE is_public IS NULL',
        "UPDATE pages SET parent_id = 'root' WHERE parent_id IS NULL OR parent_id = ''",
        'UPDATE pages SET published_at = COALESCE(updated_at, created_at) WHERE is_public = 1 AND published_at IS NULL',
    ]:
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError:
            pass

def get_user_db(username):
    db_path = resolve_user_db_path(username)
    print(f"[DEBUG get_user_db] db_path={db_path}, exists={os.path.exists(db_path)}")
    conn = sqlite3.connect(db_path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    _configure_conn(conn)
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
    # Old DBs predate the settings table that /api/export reads; ensure it so
    # export/import don't crash with "no such table".
    try:
        conn.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)')
    except Exception:
        pass
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
            updated_at REAL,
            published_at REAL DEFAULT NULL
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

def _ensure_main_columns(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS user_profiles (
            username TEXT PRIMARY KEY,
            display_name TEXT,
            bio TEXT,
            created_at REAL,
            avatar_url TEXT DEFAULT ''
        )
    ''')
    try:
        conn.execute('SELECT avatar_url FROM user_profiles LIMIT 1')
    except sqlite3.OperationalError:
        try:
            conn.execute("ALTER TABLE user_profiles ADD COLUMN avatar_url TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass

def get_main_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    db_path = os.path.join(DATA_DIR, MAIN_DB_FILENAME)
    conn = sqlite3.connect(db_path, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    _configure_conn(conn)
    return conn

def init_main_db():
    conn = get_main_db()
    _ensure_main_columns(conn)
    conn.commit()
    conn.close()
