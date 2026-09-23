# AGENTS.md — how we work here

Talk like a cute uwu human. Plain words, no jargon, definitely no robot/monotic tone. If you catch yourself sounding like docs, rewrite it. DO NOT BE CUTE IN THE CODE/USER INTERFACE. The cute persona is for replies in chat only.

## Agent Onboarding — notion-less-cloud

Project: NotionLess Cloud — Flask-based BlockNote Workspace with multi-account support.

## What this is

- Flask backend with Flask-Login + bcrypt auth
- One SQLite file per user at `../notion-less-data/userdata/<username>.db`
- Frontend: vanilla JS + BlockNote v0.51.3 via esm.sh CDN
- No build step. Serve with `python app.py`.

## Save state & notifications

Local-first robust saving (Plan B): every keystroke persists instantly to IndexedDB drafts (zero server cost). Server flush is debounced at 8s, single-flight (one request at a time), partial PATCH with hash-equality skip (title-only edits send bytes, not full docs). Each page carries `rev` + `base_updated_at`; stale pushes get `409` and raise a per-page conflict bar (Keep mine / Load server / Keep both) — never silent overwrite. Opening a cached page mounts instantly but locked as `Cached copy — checking for newer version…` until its own verify fetch completes; late fetches never clobber edits made while verifying (epoch guard). New pages are always creatable, even mid-sync/offline, and queue for later. `pagehide`/`visibilitychange` trigger a single keepalive beacon; offline shows `Offline — editing locally` and retries at 15s/60s/300s. The sidebar label shows status (Ready, Unsaved · will sync, Saving..., Saved · HH:MM, Conflict, Offline). Meaningful statuses persist to IndexedDB notification history (max 100).

## Directory layout

```
├── app.py                  # Flask entry point
├── auth.py                 # Login/register/logout routes
├── config.py               # Configuration
├── requirements.txt        # Python dependencies
├── models/user.py          # User model + per-user DB
├── services/
│   ├── db.py               # Per-user SQLite management
│   └── auth.py             # Password hashing
├── api/
│   ├── pages.py            # Pages CRUD API
│   ├── user.py             # Profile export/import API
│   └── social.py           # Social features API
├── templates/
│   ├── auth/login.html
│   ├── auth/register.html
│   ├── index.html
│   ├── about.html
│   ├── faq.html
│   ├── wall.html           # Public user profile/wall
│   ├── search.html         # User search page
│   ├── public_page.html    # Public page viewer
│   ├── 404.html            # Error page
│   └── workspace.html      # Main app
└── static/
    ├── css/
    └── js/
        ├── notifications.js  # IndexedDB notification store
        └── app-module.js    # Main app logic
├── android/                # Companion app (WebView wrapper, see android/README.md)
```

## Social Features

### User Search
- Visit `/search` to search for users by username or display name
- Click a user to view their public wall

### Public Profiles (Wall)
- Each user has a public wall at `/wall/<username>`
- Shows all pages the user has marked as public
- Click a page to view it publicly at `/p/<username>/<page_id>`

### Making Pages Public
- In the workspace, click the 🔒/🌐 button next to the page title to toggle public/private
- When a page is made public, all its subpages become public too (cascade)
- Making a subpage public does NOT make its parent public
- Public pages are visible to visitors without login

### Copying Pages
- Visitors can copy any public page to their own profile
- The original author(s) are tracked in the page's author list
- Copied pages are private by default (can be made public later)

### Profile
- Users have a display_name and bio stored in the main database
- Profile can be updated via the API (future UI)

## Tech / dependencies

- BlockNote core + CSS + fonts loaded from `esm.sh` CDN (`@blocknote/core@0.51.3`)
- Flask + Flask-Login + bcrypt for backend
- Theme tokens in `static/css/theme.css`
- Accent color: `#d85b45`
- Monochrome neuromorphic surface rules: paired soft shadows, gentle gradients, one accent hue only

## Running / testing

```bash
./setup_or_update.sh   # creates ../notion-less-venv if missing, installs/updates deps with the venv python, creates data dirs + NotionLess.desktop
./run.sh               # runs the app with the venv python (port 5001)
```

Open <http://localhost:5001>

### Auth
- Login has an in-field show/hide password toggle.
- Register has in-field dice buttons: username dice generates `adjective_noun_####`, password dice generates a 16-char password and reveals it so it can be saved. Auth cards are responsive down to small phones (44px+ touch targets).

### Workspace
- Content width toggle in the topbar cycles Narrow (800px) → Wide (1120px, default) → Full (fluid); persisted per user in IndexedDB (`state` store, scoped key) with a localStorage mirror + early `<head>` apply (no flash).
- Emoji picker with search, recent, and pinned tabs available in the editor
- Auto-TOC: right-side vertical bars from headings; hover expands animated list; click scrolls to heading. Built around existing heading block logic (type `heading`, props `level`).
- Multi-select move picker: searchable + scrollable destination list (`move-picker` in `#contextMenu`), includes Top-level option; bottom-sheet on mobile. Cancelling restores the selection bar. `Esc` clears multi-select (overlays/menus close first).
- Page rows show hover `+` (new subpage inside that page) alongside `•••` (page actions).
- Destructive/notice flows use the themed `nl-dialog` modal (`showDialog`/`confirmDialog`/`alertDialog` in `app-module.js`), never native `alert`/`confirm`. Public pages use the same themed notice dialog.
- Favicon: `static/favicon.svg`, linked from all templates.

## Keyboard shortcuts

- `Alt+PageUp` / `Alt+PageDown` — scroll through the "Your Pages" sidebar list, opening each page in turn (wraps around). Mirrors the ZIM wiki editor behavior.
- Shortcut HUD displays available shortcuts when holding `Alt` or `Ctrl`
- `Alt+Insert` — create a new subpage under the current page
- `Alt++` — expand all pages in the sidebar
- `Alt+-` — collapse all pages in the sidebar
- `Ctrl+S` — save current page (manual backup)
- `Ctrl+Z` / `Ctrl+Shift+Z` — undo / redo
- `Ctrl+K` — quick-switcher overlay to jump between pages
- `Esc` — clear multi-select (overlays/menus close first)
- Auto-save debounced at 8s with offline IndexedDB drafts; status shows Unsaved · will sync
- `/` in editor — open block command menu
- `Tab` / `Shift+Tab` — nest / unnest blocks
- Page created: brief highlight flash on sidebar row; breadcrumbs segments clickable for parent nav; keyboard focus ring: cyan/purple outline on sidebar items
- Conflict bar: `Keep mine` force-pushes, `Load server` discards local, `Keep both` duplicates server copy aside

## Change rules

- Edit `templates/workspace.html` for workspace UI
- Keep `static/js/app-module.js` in sync with workspace
- If you add pages, sync `templates/index.html` / `templates/about.html` / `templates/faq.html`
- Update this file if behavior changes

## Key links

- BlockNote docs: https://www.blocknotejs.org/
- Flask-Login: https://flask-login.readthedocs.io/

## Deployment — PythonAnywhere

### 1. Upload files
Upload via PythonAnywhere Files tab or git clone into `~/notion-less_online/`.

### 2. Set up virtual environment
```bash
mkvirtualenv --python=python3.11 venv
pip install -r requirements.txt
```

### 3. Create data directory
```bash
mkdir -p ~/notion-less-data/userdata
```

### 4. Set environment variable
In PythonAnywhere Web tab → Variables:
```
SECRET_KEY=<generate-a-secure-random-string>
```

### 5. Configure WSGI file
In PythonAnywhere Web tab → WSGI configuration:
```python
import sys

project_home = '/home/<username>/notion-less_online'
if project_home not in sys.path:
    sys.path = [project_home] + sys.path

from app import create_app
application = create_app()
```

### 6. Static files (optional)
In PythonAnywhere Web tab → Static files:
- URL: `/static/` → Directory: `/home/<username>/notion-less_online/static`

### 7. Reload
Click Reload in the PythonAnywhere Web tab.

**Notes:**
- PythonAnywhere free tier doesn't support background processes or WebSockets
- User SQLite databases are stored in `userdata/<username>.db`
- Python version: 3.11 recommended
