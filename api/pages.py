import uuid
import time
import os
import hashlib
from flask import Blueprint, request, jsonify, send_from_directory, make_response
from flask_login import current_user, login_required
from services.db import get_user_db
from config import UPLOADS_DIR

pages_bp = Blueprint('pages', __name__)

def compute_etag(data):
    content = str(data).encode('utf-8')
    return hashlib.md5(content).hexdigest()

def _row_to_dict(row):
    d = dict(row)
    try:
        d['is_public'] = bool(d.get('is_public'))
    except Exception:
        pass
    return d

def _get_page(conn, page_id):
    return conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()

def _conflict_response(server_row):
    return jsonify({'error': 'Conflict: server has newer version', 'server': _row_to_dict(server_row)}), 409

def _is_stale(existing, data):
    """Optimistic concurrency: True if client's base is older than server."""
    if not existing:
        return False
    try:
        base_rev = data.get('base_rev')
        if base_rev is not None:
            server_rev = existing['rev'] if 'rev' in existing.keys() else 1
            if int(base_rev) != int(server_rev or 1):
                return True
    except Exception:
        pass
    try:
        base_updated = data.get('base_updated_at')
        if base_updated is not None:
            server_updated = float(existing['updated_at'] or 0)
            if float(base_updated) < server_updated - 0.001:
                return True
    except Exception:
        pass
    return False

def _apply_write(conn, page_id, data):
    """Partial, conflict-checked write. Returns (row, status)."""
    existing = _get_page(conn, page_id)
    if not existing:
        return None, 404
    if _is_stale(existing, data):
        return existing, 409
    prev = dict(existing)
    now = time.time()
    # Partial update: only overwrite fields present in payload (legacy PUT with
    # missing keys previously wiped title/content/parent_id — no longer).
    title = data.get('title', prev.get('title', ''))
    content = data.get('content', prev.get('content', ''))
    parent_id = data.get('parent_id', prev.get('parent_id', 'root')) or 'root'
    html_snapshot = data.get('html_snapshot', prev.get('html_snapshot'))
    is_public = prev.get('is_public', 0)
    if 'is_public' in data:
        is_public = 1 if data.get('is_public') else 0
    try:
        server_rev = int(prev.get('rev') or 1)
    except Exception:
        server_rev = 1
    new_rev = server_rev + 1
    conn.execute(
        'UPDATE pages SET title = ?, content = ?, html_snapshot = ?, parent_id = ?, is_public = ?, rev = ?, updated_at = ? WHERE id = ?',
        (title, content, html_snapshot, parent_id, is_public, new_rev, now, page_id)
    )
    conn.commit()
    row = _get_page(conn, page_id)
    return row, 200

@pages_bp.route('/pages/list', methods=['GET'])
@login_required
def list_pages_meta():
    conn = get_user_db(current_user.username)
    rows = conn.execute(
        'SELECT id, title, parent_id, is_public, rev, created_at, updated_at FROM pages'
    ).fetchall()
    conn.close()
    result = [dict(r) for r in rows]
    etag = compute_etag(result)
    if request.headers.get('If-None-Match') == etag:
        return '', 304
    response = make_response(jsonify(result))
    response.set_etag(etag)
    return response

@pages_bp.route('/pages', methods=['GET'])
@login_required
def list_pages():
    conn = get_user_db(current_user.username)
    rows = conn.execute('SELECT id, title, content, html_snapshot, parent_id, is_public, rev, created_at, updated_at FROM pages').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@pages_bp.route('/pages', methods=['POST'])
@login_required
def create_page():
    data = request.json or {}
    now = time.time()
    page = {
        'id': data.get('id') or str(uuid.uuid4()),
        'title': data.get('title', ''),
        'content': data.get('content', ''),
        'html_snapshot': data.get('html_snapshot'),
        'parent_id': data.get('parent_id') or 'root',
        'rev': 1,
        'created_at': now,
        'updated_at': now
    }
    conn = get_user_db(current_user.username)
    existing = _get_page(conn, page['id'])
    if existing:
        conn.close()
        return jsonify(_row_to_dict(existing)), 200
    conn.execute(
        'INSERT INTO pages (id, title, content, html_snapshot, parent_id, is_public, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
        (page['id'], page['title'], page['content'], page['html_snapshot'], page['parent_id'], page['rev'], page['created_at'], page['updated_at'])
    )
    conn.commit()
    conn.close()
    return jsonify(page), 201

@pages_bp.route('/pages/<page_id>', methods=['GET'])
@login_required
def get_page(page_id):
    conn = get_user_db(current_user.username)
    row = conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    data = dict(row)
    etag = compute_etag(data)
    if request.headers.get('If-None-Match') == etag:
        return '', 304
    response = make_response(jsonify(data))
    response.set_etag(etag)
    return response

@pages_bp.route('/pages/<page_id>', methods=['PUT', 'PATCH'])
@login_required
def update_page(page_id):
    data = request.json or {}
    conn = get_user_db(current_user.username)
    row, status = _apply_write(conn, page_id, data)
    if status == 404:
        conn.close()
        return jsonify({'error': 'Not found'}), 404
    if status == 409:
        payload = _row_to_dict(row)
        conn.close()
        return jsonify({'error': 'Conflict: server has newer version', 'server': payload}), 409
    payload = _row_to_dict(row)
    conn.close()
    return jsonify(payload)

@pages_bp.route('/pages/<page_id>/save-beacon', methods=['POST'])
@login_required
def save_beacon(page_id):
    """Beacon/keepalive target for pagehide: POST-only alias of conditional write."""
    data = request.json or {}
    # sendBeacon posts FormData or text; accept both.
    if not data and request.form:
        try:
            data = {k: request.form.get(k) for k in request.form.keys()}
        except Exception:
            data = {}
    conn = get_user_db(current_user.username)
    row, status = _apply_write(conn, page_id, data if isinstance(data, dict) else {})
    if status == 404:
        conn.close()
        return jsonify({'error': 'Not found'}), 404
    if status == 409:
        payload = _row_to_dict(row)
        conn.close()
        # Beacon has no useful 409 handling; report conflict so next flush resolves.
        return jsonify({'error': 'Conflict: server has newer version', 'server': payload}), 409
    payload = _row_to_dict(row)
    conn.close()
    return jsonify(payload)

@pages_bp.route('/pages/<page_id>', methods=['DELETE'])
@login_required
def delete_page(page_id):
    conn = get_user_db(current_user.username)
    conn.execute('DELETE FROM pages WHERE id = ?', (page_id,))
    conn.commit()
    conn.close()
    return '', 204

@pages_bp.route('/upload', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    file = request.files['file']
    if not file.filename:
        return jsonify({'error': 'No file selected'}), 400
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']:
        return jsonify({'error': 'Unsupported file type'}), 400
    user_dir = os.path.join(UPLOADS_DIR, current_user.username)
    os.makedirs(user_dir, exist_ok=True)
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(user_dir, filename)
    file.save(filepath)
    return jsonify({'url': f'/api/uploads/{current_user.username}/{filename}'})

@pages_bp.route('/uploads/<username>/<filename>')
@login_required
def serve_upload(username, filename):
    if username != current_user.username:
        return jsonify({'error': 'Forbidden'}), 403
    return send_from_directory(os.path.join(UPLOADS_DIR, username), filename)
