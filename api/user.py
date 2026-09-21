import json
import time
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
    try:
        pages = data.get('pages', []) or []
        existing_ids = {r['id'] for r in conn.execute('SELECT id FROM pages').fetchall()}
        # Pass 1: allocate fresh ids so imports never collide with (or REPLACE)
        # live pages, and build an old->new map to preserve nesting.
        id_map = {}
        for page in pages:
            if not isinstance(page, dict):
                continue
            old_id = page.get('id')
            new_id = str(uuid.uuid4())
            while new_id in existing_ids or new_id in id_map.values():
                new_id = str(uuid.uuid4())
            existing_ids.add(new_id)
            if old_id:
                id_map[old_id] = new_id
            else:
                id_map[id(page)] = new_id

        def _coerce_content(value):
            if value is None:
                return ''
            if isinstance(value, str):
                return value
            try:
                return json.dumps(value)
            except Exception:
                return str(value)

        imported, orphaned = 0, 0
        conn.execute('BEGIN IMMEDIATE')
        try:
            for page in pages:
                if not isinstance(page, dict):
                    continue
                old_id = page.get('id')
                new_id = id_map.get(old_id, id_map.get(id(page)))
                if not new_id:
                    continue
                old_parent = page.get('parent_id', page.get('parentId', 'root')) or 'root'
                if old_parent in id_map:
                    new_parent = id_map[old_parent]
                elif old_parent == 'root' or old_parent in existing_ids:
                    new_parent = old_parent
                else:
                    # Parent unknown (cross-account export, trimmed file):
                    # reparent to root so the page stays visible instead of
                    # becoming a dangling orphan.
                    new_parent = 'root'
                    orphaned += 1
                try:
                    rev = int(page.get('rev') or 1)
                except Exception:
                    rev = 1
                try:
                    is_public = 1 if page.get('is_public', page.get('isPublic', 0)) else 0
                except Exception:
                    is_public = 0
                conn.execute('''
                    INSERT INTO pages (id, title, content, html_snapshot, parent_id, is_public, rev, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (new_id, page.get('title', ''),
                      _coerce_content(page.get('content', '')),
                      page.get('html_snapshot'),
                      new_parent, is_public, rev,
                      page.get('created_at', time.time()), page.get('updated_at', time.time())))
                imported += 1
            for key, value in (data.get('settings', {}) or {}).items():
                conn.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', (key, value))
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
    finally:
        conn.close()
    return jsonify({'status': 'ok', 'imported': imported, 'reparented_to_root': orphaned})
