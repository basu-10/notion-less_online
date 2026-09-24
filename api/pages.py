import uuid
import time
import os
import json
import hashlib
from flask import Blueprint, request, jsonify, send_from_directory, make_response
from flask_login import current_user, login_required
from services.db import get_user_db
from config import UPLOADS_DIR

# Uploaded images are served publicly (see serve_upload): filenames are
# unguessable UUIDs, so obscurity is the access control — the same model as
# Notion's public image URLs. This is what lets public pages and copied pages
# render images for logged-out visitors.
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_UPLOAD_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp']

# Payload keys that constitute a real content change. A PATCH/beacon carrying
# none of these (e.g. an empty pagehide flush) must be a no-op: previously it
# still bumped rev + updated_at, silently invalidating other devices' bases
# and manufacturing false 409s.
WRITABLE_FIELDS = ('title', 'content', 'html_snapshot', 'parent_id', 'is_public')


def _normalize_content(value):
    """Store content as a JSON string. Accepts str (kept as-is), or
    list/dict (JSON-encoded). The clipper previously used str(dict), which
    produces single-quote Python repr that the frontend JSON parser rejects,
    wiping the clip to a blank paragraph."""
    if value is None:
        return value
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value)
    except Exception:
        return str(value)


def _parent_exists(conn, parent_id):
    if not parent_id or parent_id == 'root':
        return True
    try:
        return conn.execute('SELECT 1 FROM pages WHERE id = ?', (parent_id,)).fetchone() is not None
    except Exception:
        return False

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
    """Partial, conflict-checked write. Returns (row, status).

    Empty payloads are a no-op (status 200, no rev bump) so keepalive beacons
    with no data can never clobber newer server content or invalidate bases.
    """
    existing = _get_page(conn, page_id)
    if not existing:
        return None, 404
    if _is_stale(existing, data):
        return existing, 409
    if not isinstance(data, dict) or not any(k in data for k in WRITABLE_FIELDS):
        return existing, 200
    prev = dict(existing)
    now = time.time()
    # Partial update: only overwrite fields present in payload (legacy PUT with
    # missing keys previously wiped title/content/parent_id — no longer).
    title = data.get('title', prev.get('title', ''))
    content = _normalize_content(data.get('content', prev.get('content', '')))
    parent_id = data.get('parent_id', prev.get('parent_id', 'root')) or 'root'
    # Never create an instant orphan from a stale client move: unknown parents
    # fall back to root (visible) instead of a dangling id (invisible).
    if 'parent_id' in data and not _parent_exists(conn, parent_id):
        parent_id = 'root'
    # Refuse to reparent under one of our own descendants (cycle would detach
    # the subtree from the ROOT walk and hide it).
    if 'parent_id' in data and parent_id != 'root' and parent_id != prev.get('parent_id'):
        cursor, seen = parent_id, set()
        while cursor and cursor != 'root' and cursor not in seen:
            if cursor == page_id:
                parent_id = prev.get('parent_id', 'root') or 'root'
                break
            seen.add(cursor)
            try:
                prow = conn.execute('SELECT parent_id FROM pages WHERE id = ?', (cursor,)).fetchone()
            except Exception:
                break
            cursor = prow['parent_id'] if prow else None
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
        'SELECT id, title, parent_id, is_public, rev, created_at, updated_at, last_opened_at FROM pages'
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
    rows = conn.execute('SELECT id, title, content, html_snapshot, parent_id, is_public, rev, created_at, updated_at, last_opened_at FROM pages').fetchall()
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
        'content': _normalize_content(data.get('content', '')),
        'html_snapshot': data.get('html_snapshot'),
        'parent_id': data.get('parent_id') or 'root',
        'rev': 1,
        'created_at': now,
        'updated_at': now
    }
    conn = get_user_db(current_user.username)
    try:
        existing = _get_page(conn, page['id'])
        if existing:
            return jsonify(_row_to_dict(existing)), 200
        if not _parent_exists(conn, page['parent_id']):
            page['parent_id'] = 'root'
        conn.execute(
            'INSERT INTO pages (id, title, content, html_snapshot, parent_id, is_public, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
            (page['id'], page['title'], page['content'], page['html_snapshot'], page['parent_id'], page['rev'], page['created_at'], page['updated_at'])
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify(page), 201

@pages_bp.route('/pages/<page_id>', methods=['GET'])
@login_required
def get_page(page_id):
    conn = get_user_db(current_user.username)
    row = conn.execute('SELECT * FROM pages WHERE id = ?', (page_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Not found'}), 404
    # Cross-device recents: opening a page stamps last_opened_at. This rides
    # the verify fetch the client already makes per open — no new requests.
    # It never touches rev/updated_at, so modified-sort and conflict bases
    # stay clean.
    now = time.time()
    try:
        conn.execute('UPDATE pages SET last_opened_at = ? WHERE id = ?', (now, page_id))
        conn.commit()
    except Exception:
        pass
    conn.close()
    data = dict(row)
    data['last_opened_at'] = now
    # ETag excludes the open-stamp: otherwise every read would invalidate the
    # client's cache and 304s would never fire for unchanged content.
    etag = compute_etag({k: v for k, v in data.items() if k != 'last_opened_at'})
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
    """Beacon/keepalive target for pagehide: POST-only alias of conditional write.

    Crucially, an empty beacon (no writable fields, no base) is a pure
    keepalive: it returns the current row WITHOUT bumping rev, so a stale
    pagehide flush can never overwrite newer server content.
    """
    data = request.json or {}
    # sendBeacon posts FormData or text; accept both.
    if not data and request.form:
        try:
            data = {k: request.form.get(k) for k in request.form.keys()}
        except Exception:
            data = {}
    conn = get_user_db(current_user.username)
    if not isinstance(data, dict) or not any(k in data for k in WRITABLE_FIELDS):
        row = _get_page(conn, page_id)
        if not row:
            conn.close()
            return jsonify({'error': 'Not found'}), 404
        payload = _row_to_dict(row)
        conn.close()
        return jsonify(payload)
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

def _collect_subtree_ids(conn, root_id):
    """All page ids in the subtree rooted at root_id (inclusive), BFS."""
    ids, queue, seen = [], [root_id], {root_id}
    existing = conn.execute('SELECT id FROM pages WHERE id = ?', (root_id,)).fetchone()
    if not existing:
        return []
    while queue:
        cur = queue.pop(0)
        ids.append(cur)
        try:
            children = conn.execute('SELECT id FROM pages WHERE parent_id = ?', (cur,)).fetchall()
        except Exception:
            continue
        for child in children:
            cid = child['id']
            if cid not in seen:
                seen.add(cid)
                queue.append(cid)
    return ids


@pages_bp.route('/pages/<page_id>', methods=['DELETE'])
@login_required
def delete_page(page_id):
    conn = get_user_db(current_user.username)
    try:
        ids = _collect_subtree_ids(conn, page_id)
        if not ids:
            return '', 204
        placeholders = ','.join('?' for _ in ids)
        # One transaction: pages + their author rows vanish together. The old
        # single-row DELETE left children pointing at a missing parent, which
        # hid them from the ROOT tree walk while still syncing (phantom loss).
        conn.execute('BEGIN IMMEDIATE')
        try:
            conn.execute(f'DELETE FROM authors WHERE page_id IN ({placeholders})', ids)
        except Exception:
            pass
        conn.execute(f'DELETE FROM pages WHERE id IN ({placeholders})', ids)
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
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
    if ext not in ALLOWED_UPLOAD_EXTS:
        return jsonify({'error': 'Unsupported file type (use JPG, PNG, GIF or WebP)'}), 400
    # Bound phone photos: read with a cap instead of trusting Content-Length.
    try:
        blob = file.read(MAX_UPLOAD_BYTES + 1)
    except Exception:
        return jsonify({'error': 'Could not read file'}), 400
    if len(blob) > MAX_UPLOAD_BYTES:
        return jsonify({'error': 'File too large (max 10 MB)'}), 413
    user_dir = os.path.join(UPLOADS_DIR, current_user.username)
    os.makedirs(user_dir, exist_ok=True)
    filename = f"{uuid.uuid4()}{ext}"
    filepath = os.path.join(user_dir, filename)
    with open(filepath, 'wb') as f:
        f.write(blob)
    return jsonify({'url': f'/api/uploads/{current_user.username}/{filename}'})

@pages_bp.route('/uploads/<username>/<filename>')
def serve_upload(username, filename):
    # Public: logged-out visitors must see images on public pages, and
    # copies keep working after the original is deleted. Filenames are
    # UUIDv4 (unguessable); the username path segment is cosmetic routing.
    # Traversal guard: only serve a bare filename that exists on disk.
    if not filename or '/' in filename or '\\' in filename or '..' in filename:
        return jsonify({'error': 'Not found'}), 404
    if os.path.basename(filename) != filename:
        return jsonify({'error': 'Not found'}), 404
    return send_from_directory(os.path.join(UPLOADS_DIR, username), filename)
