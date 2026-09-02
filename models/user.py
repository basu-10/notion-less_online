import os
from config import DATA_DIR
from services.db import get_user_db, init_user_db
from services.auth import hash_password, check_password

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
    def create(username, password):
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
        init_user_db(conn)
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
        conn = get_user_db(username)
        row = conn.execute(
            'SELECT password_hash FROM auth WHERE username = ?',
            (username,)
        ).fetchone()
        conn.close()
        if row and check_password(password, row['password_hash']):
            return User(username)
        return None

    @staticmethod
    def exists(username):
        db_path = os.path.join(DATA_DIR, f'{username}.db')
        return os.path.exists(db_path)
