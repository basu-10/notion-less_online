# Agent Onboarding — notion-less

Project: Notion-like BlockNote Workspace. Static HTML, single-file editor app.

## What this is
- `app.html` — main workspace (BlockNote editor v0.51.3 via `esm.sh` CDN, vanilla JS, sidebar + panel layout).
- `index.html` / `about.html` — empty placeholders.
- No build step, no backend, no package.json. Open `app.html` in a browser or serve with `python -m http.server`.

## Directory layout (workspace convention)
This folder is `<project>-code`. Sibling dirs outside this tree:
- `../notion-less-venv/` — isolated env (use `uv`, never `pip install` globally).
- `../notion-less-data/` — runtime artifacts (Playwright screenshots, caches, models).
Keep `.gitignore` tiny; big mutable stuff lives in `-data` / `-venv`.

## Tech / dependencies
- BlockNote core + CSS + fonts loaded from `esm.sh` CDN (`@blocknote/core@0.51.3`).
- Theme tokens (accent `#d85b45`, borders, shadows) live in the `<style>` block inside `app.html`.
- Monochrome neuromorphic surface rules apply if you touch UI: paired soft shadows, gentle gradients, one accent hue only.

## Running / testing
- Direct: open `app.html`.
- Serve: `python -m http.server 8080` (or `npx serve`).
- Playwright / browser tests: target `app.html`; put screenshots/logs in `../notion-less-data/`, never commit them.

## Change rules
- Edit `app.html` for features. Keep sidebar, panel, and BlockNote initialization in sync.
- If you add pages, sync `index.html` / `about.html`.
- If you need Python: create `../notion-less-venv/` with `uv` first.
- Update docs if behavior changes: maintain `product.md` and `architecture.md` (prose only, no code snippets) per workspace doc discipline.

## Key links
- BlockNote docs: https://www.blocknotejs.org/
- Workspace conventions (theme, isolation, docs): `.kilo/agent/working-conventions.md` in `ds_ai_workspace` reference.
