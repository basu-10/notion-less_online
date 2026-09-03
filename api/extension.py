import uuid
import time
from flask import Blueprint, request, jsonify, make_response
from models.user import User

extension_bp = Blueprint('extension', __name__)

def cors_response(data, status=200):
    response = make_response(jsonify(data), status)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-API-Key'
    response.headers['Access-Control-Allow-Credentials'] = 'true'
    return response

def require_api_key(f):
    def wrapper(*args, **kwargs):
        api_key = request.headers.get('X-API-Key') or request.args.get('api_key')
        if not api_key:
            return cors_response({'error': 'API key required'}, 401)
        username = User.get_username_from_api_key(api_key)
        if not username:
            return cors_response({'error': 'Invalid API key'}, 401)
        return f(username, *args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper

@extension_bp.route('/extension/whoami', methods=['GET', 'POST', 'OPTIONS'])
def whoami():
    if request.method == 'OPTIONS':
        return cors_response({})

    session_cookie = request.cookies.get('session')

    if session_cookie:
        try:
            from itsdangerous import URLSafeTimedSerializer
            from config import SECRET_KEY
            s = URLSafeTimedSerializer(SECRET_KEY)
            user_data = s.loads(session_cookie, max_age=31*24*60*60)
            username = user_data.get('user_id')
            if username and User.exists(username):
                response = make_response(jsonify({
                    'authenticated': True,
                    'username': username
                }))
                response.headers['Access-Control-Allow-Origin'] = '*'
                response.headers['Access-Control-Allow-Credentials'] = 'true'
                response.set_cookie('notionless_clipper_user', username, max_age=31*24*60*60, httponly=False, samesite='Lax')
                return response
        except Exception as e:
            pass

    clipper_user = request.cookies.get('notionless_clipper_user')
    if clipper_user and User.exists(clipper_user):
        response = make_response(jsonify({'authenticated': True, 'username': clipper_user}))
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response

    return cors_response({'authenticated': False})

@extension_bp.route('/extension/auth/verify', methods=['POST', 'OPTIONS'])
def verify_api_key():
    if request.method == 'OPTIONS':
        return cors_response({})

    api_key = request.json.get('api_key') if request.is_json else request.args.get('api_key')
    if not api_key:
        return cors_response({'error': 'API key required'}, 401)
    username = User.get_username_from_api_key(api_key)
    if not username:
        return cors_response({'error': 'Invalid API key'}, 401)
    return cors_response({'valid': True, 'username': username})

@extension_bp.route('/extension/auth/login', methods=['POST', 'OPTIONS'])
def extension_login():
    if request.method == 'OPTIONS':
        return cors_response({})

    data = request.get_json() or {}
    username = data.get('username', '').strip()
    password = data.get('password', '')
    user = User.authenticate(username, password)
    if not user:
        return cors_response({'error': 'Invalid credentials'}, 401)
    api_key = User.generate_api_key(username)
    return cors_response({'api_key': api_key, 'username': username})

@extension_bp.route('/extension/save', methods=['POST', 'OPTIONS'])
@require_api_key
def save_clip(username):
    if request.method == 'OPTIONS':
        return cors_response({})

    data = request.get_json() or {}
    content = data.get('content', {})
    url = data.get('url', '')
    title = data.get('title', 'Untitled')
    html_snapshot = data.get('html_snapshot', '')
    parent_id = data.get('parent_id', 'root')

    from services.db import get_user_db
    now = time.time()
    page_id = str(uuid.uuid4())

    conn = get_user_db(username)
    conn.execute(
        'INSERT INTO pages (id, title, content, html_snapshot, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        (page_id, title, str(content), html_snapshot, parent_id, now, now)
    )
    conn.execute(
        'INSERT OR IGNORE INTO authors (page_id, username, role, created_at) VALUES (?, ?, ?, ?)',
        (page_id, username, 'author', now)
    )
    conn.commit()
    conn.close()

    return cors_response({'success': True, 'page_id': page_id, 'url': url})

@extension_bp.route('/extension/pages', methods=['GET', 'OPTIONS'])
@require_api_key
def list_pages(username):
    if request.method == 'OPTIONS':
        return cors_response({})

    from services.db import get_user_db
    conn = get_user_db(username)
    rows = conn.execute(
        'SELECT id, title, created_at, updated_at FROM pages ORDER BY updated_at DESC LIMIT 50'
    ).fetchall()
    conn.close()
    return cors_response([dict(r) for r in rows])

@extension_bp.route('/extension/clip_metadata', methods=['POST', 'OPTIONS'])
@require_api_key
def clip_metadata(username):
    if request.method == 'OPTIONS':
        return cors_response({})

    data = request.get_json() or {}
    url = data.get('url', '')
    return cors_response({'url': url, 'accessible': True})
