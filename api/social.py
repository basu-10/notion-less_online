import os
import re
import shutil
import uuid
import time
import json
import random
from flask import Blueprint, request, jsonify
from flask_login import current_user, login_required
from models.user import User
from services.db import get_user_db
from config import UPLOADS_DIR

social_bp = Blueprint('social', __name__)

def _copy_uploads_for_content(content, src_username, dst_username):
    """Give copied pages their own file bytes + URLs.

    Without this, a copy keeps pointing at /api/uploads/<src>/... — which
    still renders now that uploads are public, but breaks the moment the
    original author deletes the file. Copy-on-write keeps copies independent.
    """
    if not content or not isinstance(content, str):
        return content
    marker = f'/api/uploads/{src_username}/'
    if marker not in content:
        return content
    try:
        src_dir = os.path.join(UPLOADS_DIR, src_username)
        dst_dir = os.path.join(UPLOADS_DIR, dst_username)
        os.makedirs(dst_dir, exist_ok=True)

        def _repl(m):
            fname = m.group(1)
            if '/' in fname or '\\' in fname or '..' in fname:
                return m.group(0)
            src_path = os.path.join(src_dir, fname)
            if not os.path.isfile(src_path):
                return m.group(0)
            ext = os.path.splitext(fname)[1].lower()
            new_name = f"{uuid.uuid4()}{ext}"
            try:
                shutil.copyfile(src_path, os.path.join(dst_dir, new_name))
            except Exception:
                return m.group(0)
            return f'/api/uploads/{dst_username}/{new_name}'

        return re.sub(
            r'/api/uploads/' + re.escape(src_username) + r'/([A-Za-z0-9_.\-]+)',
            _repl, content)
    except Exception:
        return content

def _feed_block_text(blocks, out, limit=600):
    """Collect plain text from BlockNote blocks (recursive)."""
    if out is None:
        out = []
    try:
        current_len = sum(len(s) for s in out)
    except Exception:
        current_len = 0
    if current_len >= limit or not isinstance(blocks, list):
        return out
    for b in blocks:
        if not isinstance(b, dict):
            continue
        content = b.get('content')
        if isinstance(content, str):
            if content.strip():
                out.append(content.strip())
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, str):
                    if item.strip():
                        out.append(item.strip())
                elif isinstance(item, dict):
                    t = item.get('text')
                    if isinstance(t, str) and t.strip():
                        out.append(t.strip())
        children = b.get('children')
        if isinstance(children, list) and children:
            _feed_block_text(children, out, limit)
        try:
            if sum(len(s) for s in out) >= limit:
                break
        except Exception:
            break
    return out


def _feed_first_image(blocks):
    """Find the first image URL in BlockNote blocks (recursive)."""
    if not isinstance(blocks, list):
        return None
    for b in blocks:
        if not isinstance(b, dict):
            continue
        try:
            props = b.get('props') or {}
            if b.get('type') == 'image' and isinstance(props, dict):
                for key in ('url', 'src'):
                    url = props.get(key)
                    if isinstance(url, str) and url:
                        return url
        except Exception:
            pass
        children = b.get('children')
        if isinstance(children, list) and children:
            found = _feed_first_image(children)
            if found:
                return found
    return None


def _feed_excerpt_and_image(content, max_len=180):
    """Parse stored page content into a short excerpt + first image URL.

    Content is a JSON string of BlockNote blocks. Never raises: malformed
    content yields an empty excerpt.
    """
    if not content or not isinstance(content, str):
        return '', None
    try:
        blocks = json.loads(content)
    except Exception:
        text = content.strip()
        return (text[:max_len] if len(text) > max_len else text), None
    if isinstance(blocks, dict):
        blocks = [blocks]
    if not isinstance(blocks, list):
        return '', None
    parts = _feed_block_text(blocks, [], limit=max_len + 60)
    text = ' '.join(parts).strip()
    text = re.sub(r'\s+', ' ', text)
    if len(text) > max_len:
        text = text[:max_len].rstrip() + '…'
    try:
        image = _feed_first_image(blocks)
    except Exception:
        image = None
    return text, image


@social_bp.route('/feed', methods=['GET'])
def public_feed():
    """Global public feed: newest public posts first, sorted by publish date.

    Simple algorithm: every top-level public page (subpages stay nested
    under their parent, same rule as walls) sorted by
    published_at DESC, falling back to updated_at / created_at for
    pages published before the column existed.
    Paginated with ?limit=&offset= (limit clamped to 1..50).
    """
    try:
        limit = int(request.args.get('limit', 20))
    except Exception:
        limit = 20
    try:
        offset = int(request.args.get('offset', 0))
    except Exception:
        offset = 0
    limit = max(1, min(limit, 50))
    offset = max(0, offset)

    all_posts = []
    try:
        usernames = User.get_all_users()
    except Exception:
        usernames = []
    for username in usernames:
        try:
            conn = get_user_db(username)
        except Exception:
            continue
        try:
            try:
                rows = conn.execute(
                    'SELECT id, title, content, parent_id, is_public, created_at, updated_at, published_at FROM pages WHERE is_public = 1'
                ).fetchall()
            except Exception:
                # Extremely old DB where migration somehow didn't apply.
                rows = conn.execute(
                    'SELECT id, title, content, parent_id, is_public, created_at, updated_at FROM pages WHERE is_public = 1'
                ).fetchall()
            pages = [dict(r) for r in rows]
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            continue
        try:
            conn.close()
        except Exception:
            pass
        if not pages:
            continue
        # Top-level only: a publish cascades to subpages, so listing every
        # subpage would flood the feed with one author's tree.
        public_ids = {p['id'] for p in pages}
        children_map = {}
        for p in pages:
            children_map.setdefault(p.get('parent_id'), []).append(p)

        def _count_descendants(node_id):
            total = 0
            for child in children_map.get(node_id, []):
                total += 1 + _count_descendants(child['id'])
            return total

        try:
            profile = User.get_profile(username)
        except Exception:
            profile = {'username': username, 'display_name': username, 'bio': '', 'avatar_url': ''}
        for p in pages:
            pid = p.get('parent_id')
            if pid != 'root' and pid and pid in public_ids:
                continue
            excerpt, image = _feed_excerpt_and_image(p.get('content'))
            published_at = p.get('published_at')
            try:
                sort_key = float(published_at) if published_at else float(p.get('updated_at') or p.get('created_at') or 0)
            except Exception:
                sort_key = 0
            all_posts.append({
                'id': p.get('id'),
                'title': p.get('title') or 'Untitled',
                'excerpt': excerpt,
                'image': image,
                'author': username,
                'author_display_name': (profile.get('display_name') or username),
                'author_avatar_url': (profile.get('avatar_url') or ''),
                'published_at': published_at,
                'updated_at': p.get('updated_at'),
                'created_at': p.get('created_at'),
                '_sort': sort_key,
                'subpage_count': _count_descendants(p.get('id')),
            })
    all_posts.sort(key=lambda p: (p.pop('_sort', 0), p.get('title') or ''), reverse=True)
    total = len(all_posts)
    page = all_posts[offset:offset + limit]
    return jsonify({
        'posts': page,
        'total': total,
        'limit': limit,
        'offset': offset,
        'has_more': offset + limit < total,
    })


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
    try:
        rows = conn.execute(
            'SELECT id, title, parent_id, is_public, created_at, updated_at, published_at FROM pages WHERE is_public = 1'
        ).fetchall()
    except Exception:
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
    if not row:
        try:
            conn.close()
        except Exception:
            pass
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
    # Breadcrumb chain: walk parent_id up while parents are public.
    # Stops at private/missing parent so visitors can't probe hidden titles.
    breadcrumbs = []
    seen_ids = {page['id']}
    parent_id = page.get('parent_id')
    parent_info = None
    try:
        while parent_id and parent_id != 'root' and parent_id not in seen_ids and len(breadcrumbs) < 20:
            seen_ids.add(parent_id)
            prow = conn.execute(
                'SELECT id, title, parent_id, is_public FROM pages WHERE id = ?',
                (parent_id,)
            ).fetchone()
            if not prow:
                break
            pdict = dict(prow)
            if not pdict.get('is_public'):
                break
            breadcrumbs.insert(0, {'id': pdict['id'], 'title': pdict.get('title') or 'Untitled'})
            if parent_info is None:
                parent_info = {'id': pdict['id'], 'title': pdict.get('title') or 'Untitled'}
            parent_id = pdict.get('parent_id')
    except Exception:
        pass
    page['breadcrumbs'] = breadcrumbs
    page['parent'] = parent_info
    # Siblings: other public pages sharing the same parent (for in-section nav).
    siblings = []
    try:
        current_parent = page.get('parent_id') or 'root'
        sib_rows = conn.execute(
            'SELECT id, title, updated_at FROM pages WHERE parent_id = ? AND id != ? AND is_public = 1 ORDER BY created_at, title',
            (current_parent, page['id'])
        ).fetchall()
        for s in sib_rows:
            sd = dict(s)
            siblings.append({'id': sd['id'], 'title': sd.get('title') or 'Untitled',
                             'updated_at': sd.get('updated_at')})
    except Exception:
        siblings = []
    page['siblings'] = siblings
    try:
        conn.close()
    except Exception:
        pass
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
            if new_public:
                conn.execute('UPDATE pages SET is_public = 1, rev = ?, updated_at = ?, published_at = ? WHERE id = ?', (cur_rev + 1, now, now, page_id))
            else:
                # Unpublishing keeps published_at as history; feed filters is_public=1.
                conn.execute('UPDATE pages SET is_public = 0, rev = ?, updated_at = ? WHERE id = ?', (cur_rev + 1, now, page_id))
            affected.append({'id': page_id, 'rev': cur_rev + 1, 'updated_at': now})
            if new_public:
                def cascade_public(parent_id):
                    children = conn.execute('SELECT id, rev FROM pages WHERE parent_id = ?', (parent_id,)).fetchall()
                    for child in children:
                        try:
                            r = int(child['rev']) if 'rev' in child.keys() and child['rev'] is not None else 1
                        except Exception:
                            r = 1
                        conn.execute('UPDATE pages SET is_public = 1, rev = ?, updated_at = ?, published_at = ? WHERE id = ?', (r + 1, now, now, child['id']))
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
                new_content = _copy_uploads_for_content(
                    src.get('content', ''), source_username, current_user.username)
                new_snapshot = _copy_uploads_for_content(
                    src.get('html_snapshot'), source_username, current_user.username)
                dest_conn.execute(
                    '''INSERT INTO pages (id, title, content, html_snapshot, parent_id, is_public, rev, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)''',
                    (new_id, src.get('title', ''), new_content,
                     new_snapshot, new_parent, now, now)
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