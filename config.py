import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'userdata')
SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-change-in-production')
BCRYPT_ROUNDS = 12
