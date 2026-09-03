# Agent Onboarding — notion-less-cloud

Project: NotionLess Cloud — Flask-based BlockNote Workspace with multi-account support.

## What this is

- Flask backend with Flask-Login + bcrypt auth
- One SQLite file per user at `../notion-less-data/userdata/<username>.db`
- Frontend: vanilla JS + BlockNote v0.51.3 via esm.sh CDN
- No build step. Serve with `python app.py`.

## Save state & notifications

The sidebar label shows the current status (Ready, Unsaved, Saved · HH:MM, etc.). All status messages are persisted to IndexedDB and can be reviewed by clicking the label — a popup shows the scrollable notification history with timestamps. Max 100 notifications stored (oldest trimmed automatically).

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
│   └── user.py             # Profile export/import API
├── templates/
│   ├── auth/login.html
│   ├── auth/register.html
│   ├── index.html
│   ├── about.html
│   ├── faq.html
│   └── workspace.html      # Main app
└── static/
    ├── css/
    └── js/
        ├── notifications.js  # IndexedDB notification store
        └── app-module.js    # Main app logic
```

## Tech / dependencies

- BlockNote core + CSS + fonts loaded from `esm.sh` CDN (`@blocknote/core@0.51.3`)
- Flask + Flask-Login + bcrypt for backend
- Theme tokens in `static/css/theme.css`
- Accent color: `#d85b45`
- Monochrome neuromorphic surface rules: paired soft shadows, gentle gradients, one accent hue only

## Running / testing

```bash
pip install -r requirements.txt
python app.py
```

Open <http://localhost:5000>

## Keyboard shortcuts

- `Alt+PageUp` / `Alt+PageDown` — scroll through the "Your Pages" sidebar list, opening each page in turn (wraps around). Mirrors the ZIM wiki editor behavior.
- `Alt+Insert` — create a new subpage under the current page
- `Alt++` — expand all pages in the sidebar
- `Alt+-` — collapse all pages in the sidebar
- `Ctrl+S` — save current page
- `Ctrl+Z` / `Ctrl+Shift+Z` — undo / redo
- `/` in editor — open block command menu
- `Tab` / `Shift+Tab` — nest / unnest blocks

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
