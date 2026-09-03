import os
import re
import sqlite3
import time
import random
from config import DATA_DIR
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
        for filename in os.listdir(DATA_DIR):
            if filename.endswith('.db'):
                users.append(filename[:-3])
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
