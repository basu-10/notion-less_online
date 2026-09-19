import uuid
import time
import traceback
from flask import Blueprint, request, jsonify, make_response
from models.user import User

extension_bp = Blueprint('extension', __name__)

def cors_response(data, status=200):
    print(f"[DEBUG cors_response] data={data}, status={status}")
    response = make_response(jsonify(data), status)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-API-Key'
    response.headers['Access-Control-Allow-Credentials'] = 'true'
    print(f"[DEBUG cors_response] set headers: CORS=*, Credentials=true")
    return response

def require_api_key(f):
    def wrapper(*args, **kwargs):
        api_key_hdr = request.headers.get('X-API-Key')
        api_key_arg = request.args.get('api_key')
        print(f"[DEBUG require_api_key] X-API-Key header={api_key_hdr[:20] if api_key_hdr else 'None'}... | args={api_key_arg[:20] if api_key_arg else 'None'}...")
        print(f"[DEBUG require_api_key] headers={dict(request.headers)}")
        print(f"[DEBUG require_api_key] args={dict(request.args)}")
        api_key = api_key_hdr or api_key_arg
        if not api_key:
            print(f"[DEBUG require_api_key] ERROR: No API key found in header or args")
            return cors_response({'error': 'API key required'}, 401)
        print(f"[DEBUG require_api_key] Found api_key prefix={api_key[:20]}..., len={len(api_key)}")
        username = User.get_username_from_api_key(api_key)
        print(f"[DEBUG require_api_key] User.get_username_from_api_key returned={username}")
        if not username:
            print(f"[DEBUG require_api_key] ERROR: Invalid API key, no user found")
            return cors_response({'error': 'Invalid API key'}, 401)
        print(f"[DEBUG require_api_key] Authenticated username={username}, calling wrapped function")
        return f(username, *args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper

@extension_bp.route('/extension/whoami', methods=['GET', 'POST', 'OPTIONS'])
def whoami():
    print(f"[DEBUG whoami] Called method={request.method}")
    print(f"[DEBUG whoami] Cookies={dict(request.cookies)}")
    print(f"[DEBUG whoami] Headers={dict(request.headers)}")
    if request.method == 'OPTIONS':
        print(f"[DEBUG whoami] OPTIONS preflight request")
        return cors_response({})

    session_cookie = request.cookies.get('session')
    print(f"[DEBUG whoami] session_cookie present={bool(session_cookie)}, len={len(session_cookie) if session_cookie else 0}")

    if session_cookie:
        try:
            from itsdangerous import URLSafeTimedSerializer
            from config import SECRET_KEY
            print(f"[DEBUG whoami] SECRET_KEY present={bool(SECRET_KEY)}, len={len(SECRET_KEY) if SECRET_KEY else 0}")
            s = URLSafeTimedSerializer(SECRET_KEY)
            user_data = s.loads(session_cookie, max_age=31*24*60*60)
            print(f"[DEBUG whoami] Deserialized session cookie data={user_data}")
            username = user_data.get('user_id')
            print(f"[DEBUG whoami] username from cookie={username}")
            user_exists = User.exists(username) if username else False
            print(f"[DEBUG whoami] User.exists({username})={user_exists}")
            if username and user_exists:
                print(f"[DEBUG whoami] Session cookie valid for user={username}")
                response = make_response(jsonify({
                    'authenticated': True,
                    'username': username
                }))
                response.headers['Access-Control-Allow-Origin'] = '*'
                response.headers['Access-Control-Allow-Credentials'] = 'true'
                response.set_cookie('notionless_clipper_user', username, max_age=31*24*60*60, httponly=False, samesite='Lax', secure=False)
                print(f"[DEBUG whoami] Returning session-based auth for {username}, set clipper_user cookie")
                return response
        except Exception as e:
            print(f"[DEBUG whoami] Exception deserializing session cookie: {e}")
            traceback.print_exc()
            print(f"[DEBUG whoami] TRACEBACK above for cookie error")

    clipper_user = request.cookies.get('notionless_clipper_user')
    print(f"[DEBUG whoami] clipper_user cookie={clipper_user}, User.exists={User.exists(clipper_user) if clipper_user else 'N/A'}")
    if clipper_user and User.exists(clipper_user):
        print(f"[DEBUG whoami] Returning clipper_user cookie auth for {clipper_user}")
        response = make_response(jsonify({'authenticated': True, 'username': clipper_user}))
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-API-Key'
        response.headers['Access-Control-Allow-Credentials'] = 'true'
        print(f"[DEBUG whoami] Set CORS headers for clipper_user response")
        return response

    print(f"[DEBUG whoami] No valid session or clipper cookie. Returning not authenticated.")
    return cors_response({'authenticated': False})

@extension_bp.route('/extension/auth/verify', methods=['POST', 'OPTIONS'])
def verify_api_key():
    print(f"[DEBUG verify] === NEW REQUEST ===")
    print(f"[DEBUG verify] method={request.method}, url={request.url}, remote_addr={request.remote_addr}")
    if request.method == 'OPTIONS':
        print(f"[DEBUG verify] OPTIONS preflight")
        return cors_response({})

    raw_json = request.get_data(as_text=True)
    print(f"[DEBUG verify] Raw request body={raw_json}")
    print(f"[DEBUG verify] Content-Type={request.content_type}, is_json={request.is_json}")
    api_key = None
    if request.is_json:
        print(f"[DEBUG verify] request.json={request.json}")
        api_key = request.json.get('api_key') if request.json else None
    else:
        api_key = request.args.get('api_key')
    print(f"[DEBUG verify] Parsed api_key={api_key[:20] if api_key else 'None'}... (len={len(api_key) if api_key else 0})")
    print(f"[DEBUG verify] Headers={dict(request.headers)}")
    if not api_key:
        print(f"[DEBUG verify] ERROR: No API key provided")
        return cors_response({'error': 'API key required', 'valid': False}, 401)
    username = User.get_username_from_api_key(api_key)
    print(f"[DEBUG verify] User.get_username_from_api_key returned username={username}")
    result = {'valid': bool(username), 'username': username, 'key_prefix': api_key[:15] if api_key else None}
    print(f"[DEBUG verify] Returning result={result}")
    return cors_response(result)

@extension_bp.route('/extension/auth/login', methods=['POST', 'OPTIONS'])
def extension_login():
    print(f"[DEBUG login] === NEW REQUEST ===")
    print(f"[DEBUG login] method={request.method}, url={request.url}, remote_addr={request.remote_addr}")
    if request.method == 'OPTIONS':
        print(f"[DEBUG login] OPTIONS preflight")
        return cors_response({})

    raw_json = request.get_data(as_text=True)
    print(f"[DEBUG login] Raw request body={raw_json}")
    data = request.get_json() or {}
    print(f"[DEBUG login] Parsed JSON={data}")
    username = str(data.get('username', '')).strip()
    password = data.get('password', '')
    print(f"[DEBUG login] username={username}, password_length={len(password) if password else 0}")
    user = User.authenticate(username, password)
    print(f"[DEBUG login] User.authenticate({username}) returned={user}")
    if not user:
        print(f"[DEBUG login] ERROR: Invalid credentials for {username}")
        return cors_response({'error': 'Invalid credentials'}, 401)
    api_key = User.generate_api_key(username)
    print(f"[DEBUG login] Generated new api_key for {username}, prefix={api_key[:20]}..., len={len(api_key)}")
    result = {'api_key': api_key, 'username': username}
    print(f"[DEBUG login] Returning result={result}")
    return cors_response(result)

@extension_bp.route('/extension/save', methods=['POST', 'OPTIONS'])
@require_api_key
def save_clip(username):
    print(f"[DEBUG save_clip] Called for username={username}, method={request.method}, url={request.url}")
    if request.method == 'OPTIONS':
        print(f"[DEBUG save_clip] OPTIONS preflight")
        return cors_response({})

    raw_json = request.get_data(as_text=True)
    print(f"[DEBUG save_clip] Raw body={raw_json}")
    data = request.get_json() or {}
    print(f"[DEBUG save_clip] Parsed data={data}")
    content = data.get('content', {})
    url = data.get('url', '')
    title = data.get('title', 'Untitled')
    html_snapshot = data.get('html_snapshot', '')
    parent_id = data.get('parent_id', 'root')
    print(f"[DEBUG save_clip] url={url}, title={title}, parent_id={parent_id}, content_length={len(str(content))}, html_snapshot_length={len(html_snapshot)}")

    from services.db import get_user_db
    now = time.time()
    page_id = str(uuid.uuid4())
    print(f"[DEBUG save_clip] Generated page_id={page_id}, timestamp={now}")

    try:
        conn = get_user_db(username)
        print(f"[DEBUG save_clip] DB connection open for {username}")
        conn.execute(
            'INSERT INTO pages (id, title, content, html_snapshot, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (page_id, title, str(content), html_snapshot, parent_id, now, now)
        )
        print(f"[DEBUG save_clip] Inserted page into pages table")
        conn.execute(
            'INSERT OR IGNORE INTO authors (page_id, username, role, created_at) VALUES (?, ?, ?, ?)',
            (page_id, username, 'author', now)
        )
        print(f"[DEBUG save_clip] Inserted author record")
        conn.commit()
        conn.close()
        print(f"[DEBUG save_clip] DB commit and close done")
    except Exception as e:
        print(f"[DEBUG save_clip] DB ERROR: {e}")
        traceback.print_exc()
        return cors_response({'error': f'Database error: {e}', 'success': False}, 500)

    result = {'success': True, 'page_id': page_id, 'url': url}
    print(f"[DEBUG save_clip] Returning success={True}, page_id={page_id}")
    return cors_response(result)

@extension_bp.route('/extension/pages', methods=['GET', 'OPTIONS'])
@require_api_key
def list_pages(username):
    print(f"[DEBUG list_pages] Called for username={username}, method={request.method}, url={request.url}")
    if request.method == 'OPTIONS':
        print(f"[DEBUG list_pages] OPTIONS preflight")
        return cors_response({})

    from services.db import get_user_db
    try:
        conn = get_user_db(username)
        print(f"[DEBUG list_pages] DB connection open for {username}")
        rows = conn.execute(
            'SELECT id, title, created_at, updated_at FROM pages ORDER BY updated_at DESC LIMIT 50'
        ).fetchall()
        print(f"[DEBUG list_pages] Found {len(rows)} rows")
        conn.close()
        result = [dict(r) for r in rows]
        print(f"[DEBUG list_pages] Returning result with {len(result)} pages")
        return cors_response(result)
    except Exception as e:
        print(f"[DEBUG list_pages] DB ERROR: {e}")
        traceback.print_exc()
        return cors_response({'error': f'Database error: {e}'}, 500)

@extension_bp.route('/extension/clip_metadata', methods=['POST', 'OPTIONS'])
@require_api_key
def clip_metadata(username):
    print(f"[DEBUG clip_metadata] Called for username={username}, method={request.method}, url={request.url}")
    if request.method == 'OPTIONS':
        print(f"[DEBUG clip_metadata] OPTIONS preflight")
        return cors_response({})

    raw_json = request.get_data(as_text=True)
    print(f"[DEBUG clip_metadata] Raw body={raw_json}")
    data = request.get_json() or {}
    url = data.get('url', '')
    print(f"[DEBUG clip_metadata] url={url}")
    result = {'url': url, 'accessible': True}
    print(f"[DEBUG clip_metadata] Returning result={result}")
    return cors_response(result)
