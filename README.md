# NotionLess

> Notion, but less. A lightweight, block-based note-taking workspace that runs entirely in your browser.

NotionLess is a local-first, offline-capable note-taking app built with vanilla JavaScript and the [BlockNote](https://www.blocknotejs.org/) editor. There are no accounts, no cloud sync, and no AI — just a fast, private writing workspace where your data never leaves your device.

## Features

- **Block-based editing** — Rich block types (paragraphs, headings, lists, quotes, code, images, and more) driven by a `/` slash-command menu. Tab / Shift+Tab to nest or unnest blocks.
- **Hierarchical pages** — Organize notes in a collapsible page tree. Create pages, nest them under folders, and collapse sections to keep context.
- **Local-first storage** — Everything saves to IndexedDB in the browser. Your data stays on your device, works offline, and is never uploaded anywhere.
- **PWA** — Installable as a standalone app via `manifest.json` and a service worker (`sw.js`) that caches assets for offline use.
- **Themes** — Light, dark, and auto (follows your system) modes, with a single warm accent color across the monochrome neuromorphic UI.
- **Export / Import** — Move pages in and out of the workspace as JSON.

## Tech stack

- **Editor:** [BlockNote core v0.51.3](https://www.blocknotejs.org/) loaded from the `esm.sh` CDN.
- **Styling:** Vanilla CSS with custom design tokens (`css/theme.css`) and a monochrome neuromorphic theme.
- **Storage:** IndexedDB (browser-native, no backend, no build step).
- **Runtime:** Pure client-side JavaScript — open it directly or serve with any static server.

## Getting started

### Option 1 — Open directly

Double-click `index.html` (or `app.html`) to launch the workspace in your browser. No installation required.

### Option 2 — Serve locally

Run a static server from the project root:

```bash
python -m http.server 8080
```

Then open <http://localhost:8080/app.html>.

### Option 3 — Install as a PWA

Open the app in a Chromium-based browser and install it from the address bar, or add it to your home screen on mobile.

## Project layout

```
notion-less/
├── index.html          # Landing page
├── app.html            # Main workspace (editor + sidebar + panels)
├── about.html          # About / project page
├── manifest.json        # PWA manifest
├── sw.js                # Service worker (offline caching)
├── css/
│   ├── theme.css        # Design tokens (single source of truth)
│   └── app.css          # Application styles
├── js/
│   └── app-module.js    # Workspace logic, editor init, storage
├── components/          # Reusable HTML fragments
├── icons/               # PWA icons (192×192, 512×512)
└── pages/               # (reserved) page templates
```

## How it works

- On load, the app reads the page tree and document contents from IndexedDB.
- The BlockNote editor renders the currently open page; edits are debounced and persisted back to IndexedDB.
- The sidebar lists the workspace pages; pages can be created, renamed, deleted, and reordered.
- Export serializes a page (and optionally its children) to JSON; import restores it.

## Contributing

This is a small, single-file-style app with no build step. Pull requests are welcome:

- Keep all UI tokens centralized in `css/theme.css` — `app.css` should not hardcode colors.
- Maintain the monochrome neuromorphic look: paired soft shadows, gentle gradients, one accent hue (`#d85b45`).
- Run `python -m http.server` locally to sanity-check changes before submitting.

## License

NotionLess is open source. Contributions are welcome — see [Contributing](#contributing).