import uuid
import time
import json
from flask import Blueprint, request, jsonify
from flask_login import current_user, login_required
from models.user import User
from services.db import get_user_db

social_bp = Blueprint('social', __name__)

@social_bp.route('/users/search', methods=['GET'])
def search_users():
    query = request.args.get('q', '').strip()
    if not query or len(query) < 1:
        return jsonify([])
    limit = min(int(request.args.get('limit', 20)), 50)
    users = User.search_users(query, limit)
    return jsonify(users)

@social_bp.route('/users/<username>', methods=['GET'])
def get_user_wall(username):
    if not User.exists(username):
        return jsonify({'error': 'User not found'}), 404
    profile = User.get_profile(username)
    conn = get_user_db(username)
    rows = conn.execute(
        'SELECT id, title, parent_id, is_public, created_at, updated_at FROM pages WHERE is_public = 1'
    ).fetchall()
    conn.close()
    pages = []
    for row in rows:
        page_dict = dict(row)
        page_dict['is_public'] = bool(page_dict['is_public'])
        pages.append(page_dict)
    # Build nested tree from flat list for nesting preservation
    def build_tree(parent_id):
        result = []
        for p in pages:
            if p.get('parent_id') == parent_id:
                node = dict(p)
                node['children'] = build_tree(p['id'])
                result.append(node)
        return result
    nested_pages = build_tree('root')
    return jsonify({
        'profile': profile,
        'pages': pages,
        'nested_pages': nested_pages
    })

@social_bp.route('/users/<username>/pages/<page_id>', methods=['GET'])
def get_public_page(username, page_id):
    if not User.exists(username):
        return jsonify({'error': 'User not found'}), 404
    conn = get_user_db(username)
    row = conn.execute(
        'SELECT id, title, content, parent_id, is_public, created_at, updated_at FROM pages WHERE id = ? AND is_public = 1',
        (page_id,)
    ).fetchone()
    # Fetch all public subpages (nested) so nesting is preserved for visitors
    sub_rows = conn.execute(
        'SELECT id, title, parent_id, content, is_public, created_at, updated_at FROM pages WHERE parent_id = ? AND is_public = 1',
        (page_id,)
    ).fetchall()
    conn.close()
    if not row:
        return jsonify({'error': 'Page not found or not public'}), 404
    page = dict(row)
    page['is_public'] = bool(page['is_public'])
    page['author'] = username
    page['author_profile'] = User.get_profile(username)
    # Include nested subpages to preserve nesting in shared pages
    page['subpages'] = []
    for sub in sub_rows:
        sub_dict = dict(sub)
        sub_dict['is_public'] = bool(sub_dict['is_public'])
        page['subpages'].append(sub_dict)
    return jsonify(page)

@social_bp.route('/pages/<page_id>/toggle-public', methods=['POST'])
@login_required
def toggle_public(page_id):
    conn = get_user_db(current_user.username)
    row = conn.execute('SELECT id, is_public, parent_id FROM pages WHERE id = ?', (page_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Page not found'}), 404
    is_public = bool(row['is_public'])
    new_public = not is_public
    now = time.time()
    conn.execute('UPDATE pages SET is_public = ?, updated_at = ? WHERE id = ?', (1 if new_public else 0, now, page_id))
    if new_public:
        def cascade_public(parent_id):
            children = conn.execute('SELECT id FROM pages WHERE parent_id = ?', (parent_id,)).fetchall()
            for child in children:
                conn.execute('UPDATE pages SET is_public = 1, updated_at = ? WHERE id = ?', (now, child['id']))
                cascade_public(child['id'])
        cascade_public(page_id)
        conn.execute('INSERT OR REPLACE INTO authors (page_id, username, role, created_at) VALUES (?, ?, ?, ?)',
                    (page_id, current_user.username, 'author', now))
    conn.commit()
    conn.close()
    return jsonify({'is_public': new_public})

@social_bp.route('/pages/<page_id>/copy', methods=['POST'])
@login_required
def copy_page(page_id):
    data = request.json or {}
    source_username = data.get('source_username')
    if not source_username or not User.exists(source_username):
        return jsonify({'error': 'Source user not found'}), 404
    source_conn = get_user_db(source_username)
    source_row = source_conn.execute(
        'SELECT id, title, content, parent_id, is_public, created_at, updated_at FROM pages WHERE id = ?',
        (page_id,)
    ).fetchone()
    if not source_row:
        source_conn.close()
        return jsonify({'error': 'Page not found'}), 404
    source_page = dict(source_row)
    source_conn.close()
    now = time.time()
    new_id = str(uuid.uuid4())
    dest_conn = get_user_db(current_user.username)
    dest_conn.execute(
        '''INSERT INTO pages (id, title, content, parent_id, is_public, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)''',
        (new_id, source_page['title'], source_page['content'], 'root', now, now)
    )
    authors = dest_conn.execute('SELECT username FROM authors WHERE page_id = ?', (page_id,)).fetchall()
    for author in authors:
        dest_conn.execute(
            'INSERT OR REPLACE INTO authors (page_id, username, role, created_at) VALUES (?, ?, ?, ?)',
            (new_id, author['username'], 'author', now)
        )
    if not any(a['username'] == source_username for a in authors):
        dest_conn.execute(
            'INSERT OR REPLACE INTO authors (page_id, username, role, created_at) VALUES (?, ?, ?, ?)',
            (new_id, source_username, 'original_author', now)
        )
    dest_conn.commit()
    dest_conn.close()
    return jsonify({'id': new_id, 'title': source_page['title'], 'copied': True})

@social_bp.route('/pages/<page_id>/authors', methods=['GET'])
def get_authors(page_id):
    conn = get_user_db(current_user.username) if current_user.is_authenticated else None
    if conn:
        authors = conn.execute('SELECT username, role, created_at FROM authors WHERE page_id = ?', (page_id,)).fetchall()
        conn.close()
        return jsonify([dict(a) for a in authors])
    return jsonify([])

@social_bp.route('/profile', methods=['GET'])
@login_required
def get_my_profile():
    profile = User.get_profile(current_user.username)
    return jsonify(profile)

@social_bp.route('/profile', methods=['PUT'])
@login_required
def update_my_profile():
    data = request.json or {}
    User.update_profile(
        current_user.username,
        display_name=data.get('display_name'),
        bio=data.get('bio')
    )
    return jsonify({'success': True})