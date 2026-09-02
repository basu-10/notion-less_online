import bcrypt
from config import BCRYPT_ROUNDS

def hash_password(password):
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode()

def check_password(password, hashed):
    return bcrypt.checkpw(password.encode(), hashed.encode())
