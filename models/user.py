import os
import re
import sqlite3
import time
import random
import secrets
import hashlib
from config import DATA_DIR, BASE_DIR
from services.db import get_user_db, init_user_db, get_main_db, init_main_db
from services.auth import hash_password, check_password

USERNAME_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{3,32}$')
PROFILE_AVATARS = [f'/static/images/profiles/avatar-{i}.png' for i in range(1, 13)]

class User:
    def __init__(self, username):
        self.id = username
        self.username = username

    @property
    def is_active(self):
        return True

    @property
    def is_authenticated(self):
        return True

    def get_id(self):
        return self.id

    @property
    def is_anonymous(self):
        return False

    @staticmethod
    def get_all_users():
        os.makedirs(DATA_DIR, exist_ok=True)
        users = []
        print(f"[DEBUG get_all_users] DATA_DIR={DATA_DIR}")
        print(f"[DEBUG get_all_users] BASE_DIR={BASE_DIR}")
        print(f"[DEBUG get_all_users] CWD={os.getcwd()}")
        try:
            files = os.listdir(DATA_DIR)
            print(f"[DEBUG get_all_users] files in DATA_DIR: {files}")
        except Exception as e:
            print(f"[DEBUG get_all_users] Error listing DATA_DIR: {e}")
        for filename in os.listdir(DATA_DIR):
            if filename.endswith('.db'):
                users.append(filename[:-3])
        print(f"[DEBUG get_all_users] found users: {users}")
        return users

    @staticmethod
    def search_users(query, limit=20):
        init_main_db()
        conn = get_main_db()
        pattern = f'%{query}%'
        rows = conn.execute(
            '''SELECT username, display_name, bio FROM user_profiles
               WHERE username LIKE ? OR display_name LIKE ?
               LIMIT ?''',
            (pattern, pattern, limit)
        ).fetchall()
        conn.close()
        if not rows:
            all_users = User.get_all_users()
            matching = [u for u in all_users if query.lower() in u.lower()][:limit]
            return [{'username': u, 'display_name': u, 'bio': ''} for u in matching]
        return [dict(r) for r in rows]

    @staticmethod
    def get_profile(username):
        init_main_db()
        conn = get_main_db()
        # Ensure avatar_url column exists
        try:
            conn.execute('SELECT avatar_url FROM user_profiles LIMIT 1')
        except sqlite3.OperationalError:
            conn.execute('ALTER TABLE user_profiles ADD COLUMN avatar_url TEXT DEFAULT \'\'')
            conn.commit()
        row = conn.execute(
            'SELECT username, display_name, bio, created_at, avatar_url FROM user_profiles WHERE username = ?',
            (username,)
        ).fetchone()
        conn.close()
        if not row:
            return {'username': username, 'display_name': username, 'bio': '', 'avatar_url': random.choice(PROFILE_AVATARS)}
        result = dict(row)
        if not result.get('avatar_url'):
            result['avatar_url'] = random.choice(PROFILE_AVATARS)
        return result

    @staticmethod
    def update_profile(username, display_name=None, bio=None, avatar_url=None):
        init_main_db()
        conn = get_main_db()
        try:
            conn.execute('SELECT avatar_url FROM user_profiles LIMIT 1')
        except sqlite3.OperationalError:
            conn.execute('ALTER TABLE user_profiles ADD COLUMN avatar_url TEXT DEFAULT \'\'')
        existing = conn.execute('SELECT username FROM user_profiles WHERE username = ?', (username,)).fetchone()
        now = time.time()
        if existing:
            sets = []
            params = []
            if display_name is not None:
                sets.append('display_name = ?')
                params.append(display_name)
            if bio is not None:
                sets.append('bio = ?')
                params.append(bio)
            if avatar_url is not None:
                sets.append('avatar_url = ?')
                params.append(avatar_url)
            if sets:
                params.append(username)
                conn.execute(f"UPDATE user_profiles SET {', '.join(sets)} WHERE username = ?", params)
        else:
            conn.execute(
                'INSERT INTO user_profiles (username, display_name, bio, created_at, avatar_url) VALUES (?, ?, ?, ?, ?)',
                (username, display_name or username, bio or '', now, avatar_url or random.choice(PROFILE_AVATARS))
            )
        conn.commit()
        conn.close()

    @staticmethod
    def create(username, password):
        if not USERNAME_PATTERN.match(username):
            return None
        db_path = os.path.join(DATA_DIR, f'{username}.db')
        if os.path.exists(db_path):
            return None
        conn = get_user_db(username)
        conn.execute(
            'CREATE TABLE IF NOT EXISTS auth (username TEXT PRIMARY KEY, password_hash TEXT)'
        )
        conn.execute(
            'INSERT INTO auth (username, password_hash) VALUES (?, ?)',
            (username, hash_password(password))
        )
        conn.commit()
        init_user_db(conn)
        init_main_db()
        main_conn = get_main_db()
        main_conn.execute(
            'INSERT OR IGNORE INTO user_profiles (username, display_name, bio, created_at, avatar_url) VALUES (?, ?, ?, ?, ?)',
            (username, username, '', time.time(), random.choice(PROFILE_AVATARS))
        )
        main_conn.commit()
        main_conn.close()
        conn.close()
        return User(username)

    @staticmethod
    def get(username):
        db_path = os.path.join(DATA_DIR, f'{username}.db')
        if not os.path.exists(db_path):
            return None
        return User(username)

    @staticmethod
    def authenticate(username, password):
        if not User.exists(username):
            return None
        conn = get_user_db(username)
        try:
            row = conn.execute(
                'SELECT password_hash FROM auth WHERE username = ?',
                (username,)
            ).fetchone()
        except sqlite3.OperationalError:
            conn.close()
            return None
        conn.close()
        if row and check_password(password, row['password_hash']):
            return User(username)
        return None

    @staticmethod
    def exists(username):
        db_path = os.path.join(DATA_DIR, f'{username}.db')
        return os.path.exists(db_path)

    @staticmethod
    def generate_api_key(username):
        conn = get_user_db(username)
        try:
            conn.execute('SELECT api_key FROM user_settings LIMIT 1')
        except sqlite3.OperationalError:
            conn.execute('CREATE TABLE IF NOT EXISTS user_settings (api_key TEXT PRIMARY KEY, api_key_hash TEXT)')
        api_key = f"nla_{secrets.token_urlsafe(32)}"
        api_key_hash = hashlib.sha256(api_key.encode()).hexdigest()
        print(f"[DEBUG generate_api_key] username={username}, api_key={api_key[:20]}..., hash={api_key_hash[:20]}...")
        conn.execute('INSERT OR REPLACE INTO user_settings (api_key, api_key_hash) VALUES (?, ?)',
                     (api_key, api_key_hash))
        conn.commit()
        conn.close()
        return api_key

    @staticmethod
    def get_api_key_hash(username):
        conn = get_user_db(username)
        try:
            row = conn.execute('SELECT api_key_hash FROM user_settings LIMIT 1').fetchone()
        except sqlite3.OperationalError:
            row = None
        conn.close()
        return row['api_key_hash'] if row else None

    @staticmethod
    def validate_api_key(username, api_key):
        if not api_key or not api_key.startswith('nla_'):
            return False
        stored_hash = User.get_api_key_hash(username)
        if not stored_hash:
            return False
        input_hash = hashlib.sha256(api_key.encode()).hexdigest()
        return secrets.compare_digest(input_hash, stored_hash)

    @staticmethod
    def get_username_from_api_key(api_key):
        if not api_key or not api_key.startswith('nla_'):
            print(f"[DEBUG get_username_from_api_key] Key format invalid: {api_key[:20] if api_key else 'None'}")
            return None
        api_key_hash = hashlib.sha256(api_key.encode()).hexdigest()
        print(f"[DEBUG get_username_from_api_key] Looking for hash: {api_key_hash[:20]}...")
        all_users = User.get_all_users()
        print(f"[DEBUG get_username_from_api_key] All users: {all_users}")
        for username in all_users:
            conn = get_user_db(username)
            try:
                row = conn.execute('SELECT api_key_hash FROM user_settings LIMIT 1').fetchone()
                stored_hash = row['api_key_hash'] if row else None
                print(f"[DEBUG get_username_from_api_key] User {username}, stored_hash: {stored_hash[:20] if stored_hash else 'None'}...")
                if stored_hash:
                    try:
                        if secrets.compare_digest(stored_hash, api_key_hash):
                            conn.close()
                            print(f"[DEBUG get_username_from_api_key] MATCH found for {username}")
                            return username
                    except Exception as e:
                        print(f"[DEBUG get_username_from_api_key] compare_digest error: {e}")
            except sqlite3.OperationalError as e:
                print(f"[DEBUG get_username_from_api_key] Error for {username}: {e}")
                pass
            conn.close()
        print("[DEBUG get_username_from_api_key] No match found")
        return None
