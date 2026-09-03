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

@pages_bp.route('/pages/list', methods=['GET'])
@login_required
def list_pages_meta():
    conn = get_user_db(current_user.username)
    rows = conn.execute(
        'SELECT id, title, parent_id, is_public, created_at, updated_at FROM pages'
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
    rows = conn.execute('SELECT id, title, content, html_snapshot, parent_id, is_public, created_at, updated_at FROM pages').fetchall()
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
        'created_at': now,
        'updated_at': now
    }
    conn = get_user_db(current_user.username)
    conn.execute(
        'INSERT INTO pages (id, title, content, html_snapshot, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        (page['id'], page['title'], page['content'], page['html_snapshot'], page['parent_id'], page['created_at'], page['updated_at'])
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

@pages_bp.route('/pages/<page_id>', methods=['PUT'])
@login_required
def update_page(page_id):
    data = request.json or {}
    now = time.time()
    conn = get_user_db(current_user.username)
    conn.execute(
        'UPDATE pages SET title = ?, content = ?, parent_id = ?, updated_at = ? WHERE id = ?',
        (data.get('title', ''), data.get('content', ''), data.get('parent_id', 'root'), now, page_id)
    )
    conn.commit()
    row = conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(dict(row))

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
