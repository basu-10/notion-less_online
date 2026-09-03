# NotionLess Cloud

> A lightweight, block-based note-taking workspace with cloud sync and multi-account support.

NotionLess Cloud is a Flask-based note-taking app with a Notion-like block editor. Create an account, log in, and access your notes from anywhere.

## Features

- **Block-based editing** — Rich block types (paragraphs, headings, lists, quotes, code, and more) via `/` slash-command menu. Tab / Shift+Tab to nest or unnest blocks.
- **Hierarchical pages** — Organize notes in a collapsible page tree.
- **Multi-account** — Register, login, and logout. Each user has their own SQLite database.
- **Cloud storage** — Data persists on the server; access from any device.
- **Themes** — Light, dark, and auto (follows system) modes.
- **Notifications** — Status messages persisted to IndexedDB with scrollable history.
- **Keyboard shortcuts** — Alt+PageUp/PageDown navigation, Alt+Insert subpages, expand/collapse, undo/redo. Shortcut HUD displays available shortcuts when holding `Alt` or `Ctrl`.
- **Social features** — User search, public profiles (`/wall/<username>`), public pages (`/p/<username>/<page_id>`), page copying.
- **Emoji picker** — Searchable emoji picker with recent and pinned tabs.
- **Export / Import** — Backup your entire profile as JSON.

## Tech stack

- **Backend:** Flask + Flask-Login + bcrypt
- **Storage:** One SQLite file per user (`../notion-less-data/userdata/<username>.db`)
- **Frontend:** Vanilla JS + [BlockNote core v0.51.3](https://www.blocknotejs.org/) (CDN)
- **Styling:** Vanilla CSS with monochrome neuromorphic theme

## Getting started

```bash
pip install -r requirements.txt
python app.py
```

Open <http://localhost:5000> in your browser.

## Project layout

```
├── app.py                  # Flask entry point
├── auth.py                 # Login/register/logout routes
├── config.py               # Configuration
├── requirements.txt        # Python dependencies
├── models/
│   └── user.py             # User model + per-user DB
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
    ├── css/                # Stylesheets
    └── js/
        ├── notifications.js  # IndexedDB notification store
        └── app-module.js    # Main app logic
```

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/register` | Create account |
| POST | `/auth/login` | Login |
| GET | `/auth/logout` | Logout |
| GET | `/api/me` | Current user |
| GET | `/api/pages` | List pages |
| POST | `/api/pages` | Create page |
| GET | `/api/pages/<id>` | Get page |
| PUT | `/api/pages/<id>` | Update page |
| DELETE | `/api/pages/<id>` | Delete page |
| GET | `/api/export` | Export profile |
| POST | `/api/import` | Import profile |
| GET | `/search` | User search |
| GET | `/wall/<username>` | Public user wall |
| GET | `/p/<username>/<page_id>` | Public page view |

## Contributing

- Keep UI tokens in `static/css/theme.css`
- Maintain monochrome neuromorphic look: paired soft shadows, gentle gradients, one accent hue (`#d85b45`)
- Run `python app.py` to test locally
