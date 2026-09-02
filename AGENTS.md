# Agent Onboarding — notion-less-cloud

Project: NotionLess Cloud — Flask-based BlockNote Workspace with multi-account support.

## What this is

- Flask backend with Flask-Login + bcrypt auth
- One SQLite file per user at `userdata/<username>.db`
- Frontend: vanilla JS + BlockNote v0.51.3 via esm.sh CDN
- No build step. Serve with `python app.py`.

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
│   └── workspace.html      # Main app
└── static/
    ├── css/
    └── js/
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

## Change rules

- Edit `templates/workspace.html` for workspace UI
- Keep `static/js/app-module.js` in sync with workspace
- If you add pages, sync `templates/index.html` / `templates/about.html`
- Update this file if behavior changes

## Key links

- BlockNote docs: https://www.blocknotejs.org/
- Flask-Login: https://flask-login.readthedocs.io/
