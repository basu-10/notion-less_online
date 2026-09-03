import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.path.dirname(BASE_DIR), 'notion-less-data', 'userdata')
UPLOADS_DIR = os.path.join(os.path.dirname(BASE_DIR), 'notion-less-data', 'uploads')
SECRET_KEY = os.environ.get('SECRET_KEY', 'dev-secret-change-in-production')
BCRYPT_ROUNDS = 12
