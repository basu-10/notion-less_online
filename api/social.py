import uuid
import time
import json
import random
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
    # Build nested tree. Wall lists ONLY top-level pages — subpages are
    # reachable solely via their parent's public page (nesting).
    # A public subpage whose parent is private/missing has no public parent
    # available, so it is promoted to top-level to stay reachable.
    public_ids = {p['id'] for p in pages}
    pages.sort(key=lambda p: (p.get('created_at') or 0, p.get('title') or ''))

    def count_descendants(node_id, children_map):
        total = 0
        for child in children_map.get(node_id, []):
            total += 1 + count_descendants(child['id'], children_map)
        return total

    children_map = {}
    for p in pages:
        children_map.setdefault(p.get('parent_id'), []).append(p)
    for child_list in children_map.values():
        child_list.sort(key=lambda p: (p.get('created_at') or 0, p.get('title') or ''))

    def build_subtree(page):
        node = dict(page)
        kids = [build_subtree(c) for c in children_map.get(page['id'], [])]
        node['children'] = kids
        node['subpage_count'] = sum(1 + k.get('subpage_count', 0) for k in kids)
        return node

    nested_pages = []
    for p in pages:
        pid = p.get('parent_id')
        if pid == 'root' or not pid or pid not in public_ids:
            nested_pages.append(build_subtree(p))
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
    # Random cards of other public articles by same author (excluding current).
    # NOTE: must run before conn.close() — previously crashed with
    # "Cannot operate on a closed database".
    other_rows = conn.execute(
        'SELECT id, title, parent_id, content, is_public, created_at, updated_at FROM pages WHERE id != ? AND is_public = 1',
        (page_id,)
    ).fetchall()
    conn.close()
    if not row:
        return jsonify({'error': 'Page not found or not public'}), 404
    page = dict(row)
    page['is_public'] = bool(page['is_public'])
    page['author'] = username
    page['author_profile'] = User.get_profile(username)
    other_articles = []
    public_ids_all = {dict(r)['id'] for r in other_rows} | {page['id']}
    for r in other_rows:
        d = dict(r)
        d['is_public'] = bool(d['is_public'])
        # Only top-level articles here: subpages with a public parent are
        # reachable solely via nesting, not via flat recommendation cards.
        pid = d.get('parent_id')
        if pid == 'root' or not pid or pid not in public_ids_all:
            other_articles.append(d)
    random.shuffle(other_articles)
    page['other_articles'] = other_articles[:3]
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
    try:
        row = conn.execute('SELECT id, is_public, parent_id, rev, updated_at FROM pages WHERE id = ?', (page_id,)).fetchone()
        if not row:
            return jsonify({'error': 'Page not found'}), 404
        is_public = bool(row['is_public'])
        new_public = not is_public
        now = time.time()
        try:
            cur_rev = int(row['rev']) if 'rev' in row.keys() and row['rev'] is not None else 1
        except Exception:
            cur_rev = 1
        affected = []
        conn.execute('BEGIN IMMEDIATE')
        try:
            conn.execute('UPDATE pages SET is_public = ?, rev = ?, updated_at = ? WHERE id = ?', (1 if new_public else 0, cur_rev + 1, now, page_id))
            affected.append({'id': page_id, 'rev': cur_rev + 1, 'updated_at': now})
            if new_public:
                def cascade_public(parent_id):
                    children = conn.execute('SELECT id, rev FROM pages WHERE parent_id = ?', (parent_id,)).fetchall()
                    for child in children:
                        try:
                            r = int(child['rev']) if 'rev' in child.keys() and child['rev'] is not None else 1
                        except Exception:
                            r = 1
                        conn.execute('UPDATE pages SET is_public = 1, rev = ?, updated_at = ? WHERE id = ?', (r + 1, now, child['id']))
                        affected.append({'id': child['id'], 'rev': r + 1, 'updated_at': now})
                        cascade_public(child['id'])
                cascade_public(page_id)
                conn.execute('INSERT OR REPLACE INTO authors (page_id, username, role, created_at) VALUES (?, ?, ?, ?)',
                            (page_id, current_user.username, 'author', now))
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        updated = conn.execute('SELECT rev, updated_at FROM pages WHERE id = ?', (page_id,)).fetchone()
    finally:
        conn.close()
    try:
        out_rev = int(updated['rev']) if updated and updated['rev'] is not None else cur_rev + 1
    except Exception:
        out_rev = cur_rev + 1
    try:
        out_updated = float(updated['updated_at']) if updated and updated['updated_at'] else now
    except Exception:
        out_updated = now
    # `affected` lets the client refresh baseRev/baseUpdatedAt for every
    # cascaded subpage; without it the next edit sends a stale base_rev and
    # trips a false 409.
    return jsonify({'is_public': new_public, 'rev': out_rev, 'updated_at': out_updated, 'affected': affected})

@social_bp.route('/pages/<page_id>/copy', methods=['POST'])
@login_required
def copy_page(page_id):
    data = request.json or {}
    source_username = data.get('source_username')
    if not source_username or not User.exists(source_username):
        return jsonify({'error': 'Source user not found'}), 404
    source_conn = get_user_db(source_username)
    try:
        source_row = source_conn.execute(
            'SELECT id, title, content, html_snapshot, parent_id, is_public, created_at, updated_at FROM pages WHERE id = ?',
            (page_id,)
        ).fetchone()
        if not source_row:
            return jsonify({'error': 'Page not found'}), 404
        source_page = dict(source_row)
        # Privacy gate: only public pages may be copied. Same 404 as missing
        # so private page ids can't be probed.
        if not source_page.get('is_public'):
            return jsonify({'error': 'Page not found'}), 404
        # Collect the full subtree (public cascade means children are public,
        # but copy the whole hierarchy regardless so the copy isn't partial).
        # BFS with cycle guard; cap at 500 to bound one request.
        subtree = [source_page]
        queue = [source_page['id']]
        seen = {source_page['id']}
        while queue and len(subtree) < 500:
            cur = queue.pop(0)
            try:
                children = source_conn.execute(
                    'SELECT id, title, content, html_snapshot, parent_id, is_public, created_at, updated_at FROM pages WHERE parent_id = ?',
                    (cur,)
                ).fetchall()
            except Exception:
                children = []
            for child in children:
                cid = child['id']
                if cid in seen:
                    continue
                seen.add(cid)
                queue.append(cid)
                subtree.append(dict(child))
        try:
            source_authors = source_conn.execute(
                'SELECT username, role FROM authors WHERE page_id = ?', (page_id,)
            ).fetchall()
            source_authors = [dict(a) for a in source_authors]
        except Exception:
            source_authors = []
    finally:
        source_conn.close()
    now = time.time()
    dest_conn = get_user_db(current_user.username)
    try:
        id_map = {p['id']: str(uuid.uuid4()) for p in subtree}
        new_root_id = id_map[source_page['id']]
        conn_existing = {r['id'] for r in dest_conn.execute('SELECT id FROM pages').fetchall()}
        for old, new in list(id_map.items()):
            while new in conn_existing:
                new = str(uuid.uuid4())
                id_map[old] = new
            conn_existing.add(new)
        dest_conn.execute('BEGIN IMMEDIATE')
        try:
            for src in subtree:
                new_id = id_map[src['id']]
                if src['id'] == source_page['id']:
                    new_parent = 'root'
                else:
                    new_parent = id_map.get(src.get('parent_id'), 'root')
                    if new_parent not in id_map.values():
                        new_parent = new_root_id
                dest_conn.execute(
                    '''INSERT INTO pages (id, title, content, html_snapshot, parent_id, is_public, rev, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)''',
                    (new_id, src.get('title', ''), src.get('content', ''),
                     src.get('html_snapshot'), new_parent, now, now)
                )
                for author in source_authors:
                    try:
                        dest_conn.execute(
                            'INSERT OR REPLACE INTO authors (page_id, username, role, created_at) VALUES (?, ?, ?, ?)',
                            (new_id, author['username'], author.get('role') or 'author', now)
                        )
                    except Exception:
                        pass
                if not any(a.get('username') == source_username for a in source_authors):
                    dest_conn.execute(
                        'INSERT OR REPLACE INTO authors (page_id, username, role, created_at) VALUES (?, ?, ?, ?)',
                        (new_id, source_username, 'original_author', now)
                    )
            dest_conn.commit()
        except Exception:
            try:
                dest_conn.rollback()
            except Exception:
                pass
            raise
    finally:
        dest_conn.close()
    return jsonify({'id': new_root_id, 'title': source_page['title'], 'copied': True, 'copied_pages': len(subtree)})

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