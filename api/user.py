import json
import uuid
from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required
from services.db import get_user_db

user_bp = Blueprint('user', __name__)

@user_bp.route('/me', methods=['GET'])
@login_required
def me():
    return jsonify({'username': current_user.username})

@user_bp.route('/export', methods=['GET'])
@login_required
def export_profile():
    conn = get_user_db(current_user.username)
    pages = [dict(r) for r in conn.execute('SELECT * FROM pages').fetchall()]
    settings = {r['key']: r['value'] for r in conn.execute('SELECT * FROM settings').fetchall()}
    conn.close()
    return jsonify({'pages': pages, 'settings': settings})

@user_bp.route('/import', methods=['POST'])
@login_required
def import_profile():
    data = request.json
    if not data:
        return jsonify({'error': 'No data'}), 400
    conn = get_user_db(current_user.username)
    existing_ids = {r['id'] for r in conn.execute('SELECT id FROM pages').fetchall()}
    for page in data.get('pages', []):
        new_id = str(uuid.uuid4())
        while new_id in existing_ids:
            new_id = str(uuid.uuid4())
        existing_ids.add(new_id)
        conn.execute('''
            INSERT OR REPLACE INTO pages (id, title, content, parent_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (new_id, page.get('title', ''), page.get('content', ''),
              page.get('parent_id', 'root'), page.get('created_at', 0), page.get('updated_at', 0)))
    for key, value in data.get('settings', {}).items():
        conn.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', (key, value))
    conn.commit()
    conn.close()
    return jsonify({'status': 'ok'})
