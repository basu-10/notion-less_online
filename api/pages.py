import uuid
import time
from flask import Blueprint, request, jsonify
from flask_login import current_user, login_required
from services.db import get_user_db

pages_bp = Blueprint('pages', __name__)

@pages_bp.route('/pages', methods=['GET'])
@login_required
def list_pages():
    conn = get_user_db(current_user.username)
    rows = conn.execute('SELECT id, title, content, parent_id, created_at, updated_at FROM pages').fetchall()
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
        'parent_id': data.get('parent_id'),
        'created_at': now,
        'updated_at': now
    }
    conn = get_user_db(current_user.username)
    conn.execute(
        'INSERT INTO pages (id, title, content, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        (page['id'], page['title'], page['content'], page['parent_id'], page['created_at'], page['updated_at'])
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
    return jsonify(dict(row))

@pages_bp.route('/pages/<page_id>', methods=['PUT'])
@login_required
def update_page(page_id):
    data = request.json or {}
    now = time.time()
    conn = get_user_db(current_user.username)
    conn.execute(
        'UPDATE pages SET title = ?, content = ?, parent_id = ?, updated_at = ? WHERE id = ?',
        (data.get('title', ''), data.get('content', ''), data.get('parent_id'), now, page_id)
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
