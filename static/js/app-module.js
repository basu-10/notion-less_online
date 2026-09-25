
import { BlockNoteEditor } from "https://esm.sh/@blocknote/core@0.51.3?bundle";

const ROOT = "root";

const BLOCKS = [
  { key: "page",   icon: "⊕", label: "Page",       desc: "Create nested child page", type: "page" },
  { key: "text",   icon: "T", label: "Text",       desc: "Plain text paragraph", type: "paragraph" },
  { key: "h1",     icon: "H1", label: "Heading 1",  desc: "Large section heading", type: "heading", props: { level: 1 } },
  { key: "h2",     icon: "H2", label: "Heading 2",  desc: "Medium section heading", type: "heading", props: { level: 2 } },
  { key: "h3",     icon: "H3", label: "Heading 3",  desc: "Small section heading", type: "heading", props: { level: 3 } },
  { key: "bullet", icon: "•",  label: "Bulleted list", desc: "Simple bullet list", type: "bulletListItem" },
  { key: "number", icon: "1.", label: "Numbered list", desc: "Ordered list", type: "numberedListItem" },
  { key: "todo",   icon: "☐", label: "To-do",       desc: "Task with checkbox", type: "checkListItem" },
  { key: "quote",  icon: "“", label: "Quote",       desc: "Quoted text", type: "quote" },
  { key: "code",   icon: "</>", label: "Code",      desc: "Monospace code block", type: "codeBlock" },
  { key: "table",  icon: "▦", label: "Table",     desc: "Insert a table", type: "table" },
  { key: "image",  icon: "🖼", label: "Image",       desc: "Upload or embed image/GIF", type: "image" },
];

const state = {
  pages: new Map(),
  currentPageId: null,
  editor: null,
  saveTimer: null,
  dirty: false,
  expanded: new Set([ROOT]),
  contextPageId: null,
  slashIndex: 0,
  slashFilter: "",
  isOpeningPage: false,
  selected: new Set(),
  selecting: false,
  saveInProgress: false,
  manualSaveTimer: null,
  // Robust save engine (Plan B): per-page verified gate + single-flight flusher.
  metaReady: false,
  flushTimer: null,
  flushing: false,
  flushQueued: false,
  sortOrder: (() => { try { return localStorage.getItem("notion-sort-order") || "modified"; } catch { return "modified"; } })(),
  pageFilter: "",
  sidebarTab: (() => { try { return localStorage.getItem("notion-sidebar-tab") || "library"; } catch { return "library"; } })(),
  recentIds: [],
};
const MAX_RECENTS = 30;

// Tunables chosen for PythonAnywhere free tier: few, small requests.
const SAVE_DEBOUNCE_MS = 8000;
const VERIFY_TIMEOUT_MS = 8000;
const RETRY_DELAYS = [15000, 60000, 300000];

let editorWired = false;

const $ = (sel) => document.querySelector(sel);

// IndexedDB is shared per browser profile, not per account. Every cached key
// and draft is therefore stamped/scoped with the logged-in username from
// <body data-username>, so a fresh account never inherits another user's
// sidebar, drafts, or last-opened page (which previously blocked demo
// seeding and left pages stuck on "Couldn't load content").
function currentUsername() {
  try { return document.body.dataset.username || ""; } catch { return ""; }
}

function scopedKey(key) {
  const u = currentUsername();
  return u ? key + ":" + u : key;
}

function applyTheme(mode) {
  const html = document.documentElement;
  html.removeAttribute("data-theme");
  if (mode === "light" || mode === "dark") {
    html.setAttribute("data-theme", mode);
  }
  try { localStorage.setItem("notion-theme", mode); } catch {}
  document.querySelectorAll(".theme-btn").forEach(b => b.classList.toggle("active", b.dataset.theme === mode));
}

function getTheme() {
  try { return localStorage.getItem("notion-theme") || "auto"; } catch { return "auto"; }
}

// ---------- Content width: narrow / wide / full, persisted per user ----------
const DOC_WIDTHS = ["narrow", "wide", "full"];
const DOC_WIDTH_LABELS = { narrow: "Narrow", wide: "Wide", full: "Full" };
const DEFAULT_DOC_WIDTH = "wide";

function docWidthStorageKey() {
  // Per-account so two logins on one browser keep their own width.
  try { return scopedKey("docWidth"); } catch { return "docWidth"; }
}

function docWidthLocalKey() {
  const u = currentUsername();
  return u ? "notion-doc-width:" + u : "notion-doc-width";
}

function validDocWidth(v) {
  return DOC_WIDTHS.includes(v) ? v : null;
}

function getDocWidth() {
  const cur = validDocWidth(document.documentElement.dataset.docWidth);
  if (cur) return cur;
  try {
    const ls = validDocWidth(localStorage.getItem(docWidthLocalKey()))
      || validDocWidth(localStorage.getItem("notion-doc-width"));
    if (ls) return ls;
  } catch {}
  return DEFAULT_DOC_WIDTH;
}

function updateDocWidthBtn(mode) {
  const btn = $("#docWidthBtn");
  if (!btn) return;
  const label = DOC_WIDTH_LABELS[mode] || mode;
  const next = DOC_WIDTHS[(DOC_WIDTHS.indexOf(mode) + 1) % DOC_WIDTHS.length];
  const nextLabel = DOC_WIDTH_LABELS[next] || next;
  btn.title = "Content width: " + label + " (click for " + nextLabel + ")";
  btn.setAttribute("aria-label", "Content width: " + label + ". Activate for " + nextLabel);
  btn.dataset.width = mode;
}

function applyDocWidth(mode, { persist=false }={}) {
  mode = validDocWidth(mode) || DEFAULT_DOC_WIDTH;
  document.documentElement.dataset.docWidth = mode;
  updateDocWidthBtn(mode);
  if (!persist) return;
  try { localStorage.setItem(docWidthLocalKey(), mode); } catch {}
  try { localStorage.setItem("notion-doc-width", mode); } catch {}
  // IndexedDB is the durable store; never let it stall the toggle.
  try {
    idbOrFallback(
      window.notifications.saveState(docWidthStorageKey(), mode).catch(() => {}),
      2000, null
    ).catch(() => {});
  } catch {}
}

function toggleDocWidth() {
  const cur = getDocWidth();
  const next = DOC_WIDTHS[(DOC_WIDTHS.indexOf(cur) + 1) % DOC_WIDTHS.length];
  applyDocWidth(next, { persist: true });
  setSaveState("Content width: " + (DOC_WIDTH_LABELS[next] || next), false);
}

async function initDocWidth() {
  // Instant: localStorage (head script already applied the global fallback).
  try {
    const ls = validDocWidth(localStorage.getItem(docWidthLocalKey()))
      || validDocWidth(localStorage.getItem("notion-doc-width"));
    applyDocWidth(ls || DEFAULT_DOC_WIDTH);
  } catch { applyDocWidth(DEFAULT_DOC_WIDTH); }
  // Durable: per-user IndexedDB wins when present.
  try {
    const saved = await idbOrFallback(
      window.notifications.getState(docWidthStorageKey()).catch(() => null),
      3000, null
    );
    const valid = validDocWidth(saved);
    if (valid && valid !== getDocWidth()) applyDocWidth(valid);
    else updateDocWidthBtn(getDocWidth());
  } catch { updateDocWidthBtn(getDocWidth()); }
  const btn = $("#docWidthBtn");
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = "1";
    btn.addEventListener("click", toggleDocWidth);
  }
}

function uid(prefix="page") {
  return prefix + "_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
}

function defaultBlocks(title) {
  return [
    { type: "paragraph", content: title === "Welcome" ? "This is a Notion-like block editor powered by NotionLess Cloud." : "" },
    ...(title === "Welcome" ? [
      { type: "heading", props: { level: 2 }, content: "Getting started" },
      { type: "bulletListItem", content: "Your notes are saved to the cloud" },
      { type: "bulletListItem", content: "Access from any device with your login" },
      { type: "bulletListItem", content: "Create nested pages using the ••• menu" },
    ] : [])
  ];
}

function makePage({ id=uid(), title="Untitled", parentId=ROOT, emoji="", blocks=defaultBlocks(title), collapsed=false }={}) {
  const now = Date.now();
  return {
    id, title, parentId, emoji, blocks, collapsed, updatedAt: now,
    rev: 1, baseRev: null, baseUpdatedAt: null, baseTitle: title, baseHash: hashContent(blocks),
    lastSyncedHash: null, dirty: false, verified: false, locked: false,
    epoch: 0, mountEpoch: 0, retryCount: 0, conflictServer: null, isPublic: false,
    contentLoaded: true, lastOpenedAt: null,
  };
}

function hashContent(blocks) {
  try {
    const s = typeof blocks === "string" ? blocks : JSON.stringify(blocks || []);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36) + ":" + s.length;
  } catch { return "0:0"; }
}

function pageContentHash(page) {
  try {
    const blocks = (page.id === state.currentPageId && state.editor)
      ? state.editor.document
      : page.blocks;
    return hashContent(blocks);
  } catch { return hashContent(page.blocks); }
}

function refreshGlobalDirty() {
  const anyDirty = [...state.pages.values()].some(p => p.dirty);
  state.dirty = anyDirty;
  return anyDirty;
}

function showSyncBanner(text, offline=false) {
  const el = $("#syncBanner");
  if (!el) return;
  if (!text) { el.style.display = "none"; el.textContent = ""; return; }
  el.style.display = "block";
  el.textContent = text;
  el.classList.toggle("is-offline", !!offline);
}

function hideSyncBanner() { showSyncBanner(null); }

function showConflictBar(page) {
  const bar = $("#conflictBar");
  if (!bar || !page || !page.conflictServer) return;
  bar.style.display = "flex";
  const srv = page.conflictServer;
  let when = "";
  try {
    const t = srv.updated_at ? new Date(srv.updated_at * 1000) : null;
    when = t ? " (server " + t.toLocaleString() + ")" : "";
  } catch {}
  $("#conflictText").textContent = "This page changed on another device" + when + ". Your local edits are kept — choose how to resolve.";
}

function hideConflictBar() {
  const bar = $("#conflictBar");
  if (bar) bar.style.display = "none";
}

function setLocked(page, locked, reason) {
  if (!page) return;
  page.locked = !!locked;
  const doc = document.querySelector(".document");
  const title = $("#pageTitle");
  if (page.id === state.currentPageId) {
    if (doc) doc.classList.toggle("is-locked", !!locked);
    if (title) title.readOnly = !!locked;
    if (locked && reason) showSyncBanner(reason, false);
    else if (!locked && !page.conflictServer) hideSyncBanner();
  }
}

async function writeDraft(page) {
  // Never let a hung IndexedDB (e.g. upgrade blocked by another tab) stall
  // the save queue: fall through after 3s, server remains source of truth.
  const payload = {
      id: page.id,
      title: page.title,
      blocks: null,
      parentId: page.parentId,
      emoji: page.emoji || "",
      owner: currentUsername() || null,
      updatedAt: page.updatedAt,
      rev: page.rev || 1,
      baseRev: page.baseRev ?? null,
      baseUpdatedAt: page.baseUpdatedAt ?? null,
      baseTitle: page.baseTitle ?? page.title,
      baseHash: page.baseHash ?? hashContent(page.blocks),
      dirty: !!page.dirty,
      isPublic: !!page.isPublic,
      lastOpenedAt: page.lastOpenedAt ?? null,
  };
  try { payload.blocks = structuredClone(page.blocks || []); }
  catch { try { payload.blocks = JSON.parse(JSON.stringify(page.blocks || [])); } catch { payload.blocks = []; } }
  try {
    await Promise.race([
      window.notifications.saveDraft(payload),
      new Promise(res => setTimeout(res, 3000)),
    ]);
  } catch (e) { console.warn("Draft write failed:", e); }
}

function idbOrFallback(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(res => setTimeout(() => res(fallback), ms)),
  ]);
}

async function persistNotification(text) {
  // Timeout-guarded: a hung IndexedDB must never stall save-state updates.
  try { await idbOrFallback(window.notifications.addNotification(text, "info").catch(() => {}), 2000, null); } catch (e) { console.warn("Notification add failed:", e); }
}

async function setSaveState(text, persist=true) {
  const el = $("#saveState");
  if (el) el.textContent = text;
  // Drive the status dot: ok (saved/ready) · busy (syncing) · bad (conflict/offline).
  try {
    const trig = $("#notificationTrigger");
    if (trig) {
      const t = (text || "").toLowerCase();
      trig.dataset.status = /conflict|offline|unsynced|attention|retry|resolve|not loaded|couldn|fail|error/.test(t) ? "bad"
        : /saving|unsaved|will sync|syncing|loading|recreating|retrying/.test(t) ? "busy" : "ok";
      // Polish: full timestamp + plain-words hint so the pill explains itself.
      const when = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      let tip = text || "Ready";
      if (/^saved/.test(text || "")) tip = text + " — all changes are safe. Click to see history.";
      else if (/^ready|^all pages saved/.test(t)) tip = "Ready — everything is saved (" + when + "). Click to see history.";
      else if (/unsaved|will sync/.test(t)) tip = "Unsaved changes — will sync automatically. Click to see history.";
      else if (/saving|syncing|loading|retrying|recreating/.test(t)) tip = text + " (" + when + "). Click to see history.";
      else if (/offline/.test(t)) tip = text + " — editing locally, will retry. Click to see history.";
      else if (/conflict/.test(t)) tip = text + " — pick Keep mine / Load server / Keep both. Click to see history.";
      trig.title = tip;
      trig.setAttribute("aria-label", "Sync status: " + tip);
    }
  } catch {}
  // Don't spam IndexedDB with transient states; persist only meaningful ones.
  if (!persist) return;
  await persistNotification(text);
}

async function toggleNotificationPanel() {
  const panel = $("#notificationPanel");
  const trig = $("#notificationTrigger");
  const isOpen = panel.classList.contains("open");
  if (isOpen) {
    panel.classList.remove("open");
    if (trig) trig.setAttribute("aria-expanded", "false");
  } else {
    panel.classList.add("open");
    if (trig) trig.setAttribute("aria-expanded", "true");
    await renderNotificationList();
  }
}

async function renderNotificationList() {
  const listEl = $("#notificationList");
  try {
    const notifications = await window.notifications.getNotifications(50);
    if (!notifications.length) {
      listEl.innerHTML = '<div class="notification-empty">No notifications</div>';
      return;
    }
    listEl.innerHTML = notifications.map(n => {
      const date = new Date(n.timestamp);
      const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const dateStr = date.toLocaleDateString();
      return `<div class="notification-item">
        <span class="notification-text">${escapeHtml(n.text)}</span>
        <span class="notification-time">${dateStr} ${time}</span>
      </div>`;
    }).join("");
  } catch (e) {
    listEl.innerHTML = '<div class="notification-empty">Failed to load</div>';
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ---------- Themed dialog (replaces native alert/confirm) ----------
let _dialogResolve = null;

function closeDialog(value) {
  const overlay = $("#nlDialogOverlay");
  if (!overlay || !overlay.classList.contains("open")) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", _dialogEsc, true);
  const resolve = _dialogResolve;
  _dialogResolve = null;
  if (resolve) resolve(value);
}

function _dialogEsc(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    // Cancel value is always false for confirms, undefined for alerts.
    const actions = $("#nlDialogActions");
    const cancelBtn = actions ? actions.querySelector('[data-value="false"], [data-value=""]') : null;
    closeDialog(cancelBtn ? cancelBtn.dataset.value === "true" : false);
  }
}

function showDialog({ title="Are you sure?", message="", actions=[{ label: "Cancel", kind: "ghost", value: false }, { label: "Confirm", kind: "primary", value: true }] }={}) {
  const overlay = $("#nlDialogOverlay");
  // Fallback to native dialogs if markup is missing (e.g. tests).
  if (!overlay) {
    if (actions.length <= 1) { window.alert(message || title); return Promise.resolve(actions[0]?.value); }
    return Promise.resolve(window.confirm((title ? title + "\n\n" : "") + message));
  }
  // If a dialog is already open, resolve it as cancelled before replacing.
  if (_dialogResolve) { const r = _dialogResolve; _dialogResolve = null; try { r(false); } catch {} }
  $("#nlDialogTitle").textContent = title;
  $("#nlDialogMessage").textContent = message;
  const box = $("#nlDialogActions");
  box.innerHTML = "";
  return new Promise((resolve) => {
    _dialogResolve = resolve;
    actions.forEach((a) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nl-dialog-btn " + (a.kind || "ghost");
      btn.textContent = a.label;
      btn.dataset.value = String(a.value ?? "");
      btn.addEventListener("click", () => closeDialog(a.value));
      box.appendChild(btn);
    });
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", _dialogEsc, true);
    overlay.onclick = (e) => { if (e.target === overlay) closeDialog(actions.length > 1 ? false : actions[0]?.value); };
    const first = box.querySelector(".nl-dialog-btn.danger, .nl-dialog-btn.primary") || box.querySelector(".nl-dialog-btn");
    setTimeout(() => { try { (first || box).focus({ preventScroll: true }); } catch { try { first.focus(); } catch {} } }, 30);
  });
}

function confirmDialog({ title="Delete?", message="", confirmLabel="Delete", cancelLabel="Cancel", danger=true }={}) {
  return showDialog({
    title, message,
    actions: [
      { label: cancelLabel, kind: "ghost", value: false },
      { label: confirmLabel, kind: danger ? "danger" : "primary", value: true },
    ],
  });
}

function alertDialog({ title="Notice", message="" }={}) {
  return showDialog({ title, message, actions: [{ label: "OK", kind: "primary", value: true }] });
}

async function clearAllNotifications() {
  try {
    await window.notifications.clearNotifications();
    await renderNotificationList();
  } catch (e) { console.warn("Failed to clear notifications:", e); }
}

function snapshotCurrentToPage() {
  const page = state.pages.get(state.currentPageId);
  if (!page) return null;
  try {
    if (state.editor) page.blocks = structuredClone(state.editor.document);
  } catch {}
  const titleEl = $("#pageTitle");
  if (titleEl) page.title = titleEl.value.trim() || "Untitled";
  // NOTE: do NOT touch page.updatedAt here. updatedAt drives the
  // "modified" sidebar sort, so it must only change on a real local edit
  // (see markDirty) or a confirmed server modification — never on a mere
  // view/navigation snapshot, or clicking through pages reorders the tree.
  page.epoch = (page.epoch || 0) + 1;
  return page;
}

function markDirty() {
  const page = state.pages.get(state.currentPageId);
  if (!page) return;
  if (!page.contentLoaded && !page._localOnly) {
    // Content never loaded (failed verify, empty placeholder): refuse to
    // snapshot, so a stray keystroke can never queue a blank doc over the
    // real server content.
    return;
  }
  if (page.locked) {
    // Locked = unverified cached copy. Count the attempt so a late fetch can
    // never clobber it (generation guard), then keep it queued.
    page.epoch = (page.epoch || 0) + 1;
  }
  snapshotCurrentToPage();
  const curHash = pageContentHash(page);
  if (!page.dirty) {
    // Skip server write entirely if nothing changed since last sync base.
    if (page.baseHash && curHash === page.baseHash && page.title === (page.baseTitle ?? page.title)) {
      refreshGlobalDirty();
      return;
    }
  }
  page.updatedAt = Date.now();
  page.dirty = true;
  refreshGlobalDirty();
  setSaveState("Unsaved · will sync", false);
  const btn = $("#saveBtn");
  if (btn) btn.classList.remove("visible");
  writeDraft(page);
  renderTree();
  try { updateDocMeta(); } catch {}
  scheduleFlush(SAVE_DEBOUNCE_MS);
}

function scheduleFlush(delay=SAVE_DEBOUNCE_MS) {
  clearTimeout(state.flushTimer);
  clearTimeout(state.saveTimer);
  state.flushTimer = setTimeout(() => { flushQueue(); }, delay);
}

function pickNextDirtyPage() {
  let best = null;
  for (const p of state.pages.values()) {
    if (!p.dirty || p.conflictServer) continue;
    // Safety net: never push a page whose content never loaded, unless it is
    // a local-only new page (its placeholder IS the content).
    if (!p.contentLoaded && !p._localOnly) continue;
    if (!best || (p.updatedAt || 0) < (best.updatedAt || 0)) best = p;
  }
  return best;
}

async function flushQueue() {
  clearTimeout(state.flushTimer);
  if (state.flushing) { state.flushQueued = true; return; }
  const page = pickNextDirtyPage();
  if (!page) { refreshGlobalDirty(); return; }
  // Snapshot live editor if this is the open page.
  if (page.id === state.currentPageId && state.editor) {
    try { page.blocks = structuredClone(state.editor.document); } catch {}
    const t = $("#pageTitle");
    if (t) page.title = t.value.trim() || "Untitled";
  }
  const curHash = pageContentHash(page);
  const titleChanged = page.title !== (page.baseTitle ?? page.title);
  const contentChanged = !page.baseHash || curHash !== page.baseHash;
  const parentChanged = page._parentChanged === true;
  if (!titleChanged && !contentChanged && !parentChanged) {
    page.dirty = false;
    page.retryCount = 0;
    await writeDraft(page);
    refreshGlobalDirty();
    if (pickNextDirtyPage()) scheduleFlush(2000);
    else setSaveState("Saved · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    return;
  }
  state.flushing = true;
  if (page.id === state.currentPageId) setSaveState("Saving...", false);
  const payload = {};
  if (titleChanged) payload.title = page.title;
  if (contentChanged) {
    const blocks = (page.id === state.currentPageId && state.editor) ? state.editor.document : page.blocks;
    payload.content = JSON.stringify(blocks || []);
  }
  if (parentChanged || payload.title || payload.content) payload.parent_id = page.parentId;
  if (page.baseRev != null) payload.base_rev = page.baseRev;
  if (page.baseUpdatedAt != null) payload.base_updated_at = page.baseUpdatedAt;
  // Local-only pages (never synced) have no base: create-or-repair then patch.
  try {
    let res = null;
    if (page._localOnly) {
      try {
        res = await window.api.createPage({
          id: page.id, title: page.title,
          content: JSON.stringify((page.id === state.currentPageId && state.editor) ? state.editor.document : (page.blocks || [])),
          parent_id: page.parentId,
        });
      } catch (e) {
        // Already exists server-side (e.g. created on another device): fall through to patch.
        res = null;
      }
    }
    if (!res) res = await window.api.updatePage(page.id, payload);
    page.rev = res.rev ?? ((page.rev || 1) + 1);
    page.baseRev = page.rev;
    page.baseUpdatedAt = res.updated_at ?? (Date.now() / 1000);
    page.baseTitle = page.title;
    page.baseHash = pageContentHash(page);
    page.lastSyncedHash = page.baseHash;
    page.updatedAt = Date.now();
    page.dirty = false;
    page.retryCount = 0;
    page._parentChanged = false;
    page._localOnly = false;
    await writeDraft(page);
    refreshGlobalDirty();
    if (page.id === state.currentPageId) {
      setSaveState("Saved · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      renderBreadcrumbs();
    }
    renderTree();
  } catch (err) {
    console.error("Save failed:", err);
    if (err && err.status === 404 && !page._localOnly) {
      // Page missing server-side (deleted on another device, or a stale
      // stub from a previous account on this browser): flip to local-only so
      // the next flush recreates it instead of retrying a PATCH that can
      // never succeed.
      page._localOnly = true;
      page.baseRev = null;
      page.baseUpdatedAt = null;
      await writeDraft(page);
      if (page.id === state.currentPageId) setSaveState("Recreating page...", false);
    }
    if (err && (err.status === 409 || err.server)) {
      const server = err.server || (err.data && err.data.server);
      page.conflictServer = server || null;
      page.retryCount = 0;
      await writeDraft(page);
      if (page.id === state.currentPageId) {
        showConflictBar(page);
        setSaveState("Conflict — action needed");
      } else {
        setSaveState("Conflict on '" + (page.title || "Untitled") + "'");
      }
      renderTree();
    } else {
      page.retryCount = (page.retryCount || 0) + 1;
      const delay = RETRY_DELAYS[Math.min(page.retryCount - 1, RETRY_DELAYS.length - 1)];
      if (page.id === state.currentPageId) setSaveState("Offline — retrying", false);
      else setSaveState("Offline — " + [...state.pages.values()].filter(p => p.dirty).length + " unsynced");
      scheduleFlush(delay);
    }
  } finally {
    state.flushing = false;
    if (state.flushQueued) {
      state.flushQueued = false;
      if (pickNextDirtyPage()) scheduleFlush(2000);
    } else if (pickNextDirtyPage()) {
      scheduleFlush(2000);
    }
  }
}

async function saveCurrent() {
  // Manual save: flush the current page immediately (single-flight safe).
  const page = state.pages.get(state.currentPageId);
  if (!page) return;
  if (!page.contentLoaded && !page._localOnly) {
    setSaveState("Content not loaded yet — retry", false);
    return;
  }
  if (page.conflictServer) {
    setSaveState("Resolve conflict first");
    showConflictBar(page);
    return;
  }
  snapshotCurrentToPage();
  page.dirty = true;
  refreshGlobalDirty();
  await writeDraft(page);
  clearTimeout(state.flushTimer);
  await flushQueue();
}

async function saveAll() {
  // Sequential single-flight drain (free-tier friendly: one request at a time).
  for (;;) {
    const next = pickNextDirtyPage();
    if (!next) break;
    if (next.id !== state.currentPageId) {
      // Non-open pages already have snapshots in memory + drafts.
    } else snapshotCurrentToPage();
    await flushQueue();
    if (next.conflictServer) continue; // leave conflicts for explicit resolution
  }
  refreshGlobalDirty();
  setSaveState(refreshGlobalDirty() ? "Some pages need attention" : "All pages saved");
}

function exportProfile() {
  window.api.exportProfile().then(data => {
    const payload = { meta: { exportedAt: Date.now(), version: 1 }, pages: data.pages };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "notionless-profile.json"; a.click(); URL.revokeObjectURL(url);
    setSaveState("Profile exported");
  }).catch(err => {
    alertDialog({ title: "Export failed", message: err && err.message ? err.message : "Could not export your profile. Please try again." });
  });
}

function exportNote() {
  const page = state.pages.get(state.currentPageId);
  if (!page) { alertDialog({ title: "No page open", message: "Open a page first, then export it." }); return; }
  const payload = { meta: { exportedAt: Date.now(), version: 1, id: page.id, title: page.title }, page };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = (page.title || "note") + ".json"; a.click(); URL.revokeObjectURL(url);
  setSaveState("Note exported");
}

async function importProfile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.pages || !Array.isArray(data.pages)) throw new Error("Invalid profile file");
    for (const p of data.pages) {
      const pid = p.id || uid("page");
      const blocks = p.blocks || (typeof p.content === "string" ? parseBlocks(p.content) : (p.content || [{type:"paragraph"}]));
      const local = makePage({
        id: pid,
        title: p.title || "Untitled",
        parentId: p.parentId || p.parent_id || ROOT,
        emoji: p.emoji || "",
        blocks,
      });
      local._localOnly = true;
      local.dirty = true;
      local.baseRev = null;
      state.pages.set(pid, local);
      await writeDraft(local);
      try {
        const res = await window.api.createPage({
          id: pid, title: local.title,
          content: JSON.stringify(local.blocks), parent_id: local.parentId,
        });
        if (res) {
          local.rev = res.rev ?? 1;
          local.baseRev = local.rev;
          local.baseUpdatedAt = res.updated_at ?? (Date.now() / 1000);
          local.baseTitle = local.title;
          local.baseHash = hashContent(local.blocks);
          local.dirty = false;
          local._localOnly = false;
          await writeDraft(local);
        }
      } catch (err) {
        console.error("Failed to create page during import:", err, pid);
      }
    }
    refreshGlobalDirty();
    $("#saveBtn").classList.remove("visible");
    setSaveState("Profile imported");
    renderTree(); renderBreadcrumbs();
    const first = childrenOf(ROOT)[0];
    if (first && first.id !== state.currentPageId) await openPage(first.id);
  } catch (e) {
    alertDialog({ title: "Import failed", message: e && e.message ? e.message : String(e) });
  }
}

function childrenOf(parentId) {
  return [...state.pages.values()]
    .filter(p => p.parentId === parentId)
    .sort((a,b) => {
      if (state.sortOrder === "alpha") {
        return (a.title || "Untitled").localeCompare(b.title || "Untitled");
      }
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
}

// ---------- Sidebar tabs: Recents / Library + recent-pages tracking ----------
function recentStorageKey() {
  try { return scopedKey("recentPageIds"); } catch { return "recentPageIds"; }
}

function recentLocalKey() {
  const u = currentUsername();
  return u ? "notion-recents:" + u : "notion-recents";
}

function sidebarTabLocalKey() {
  const u = currentUsername();
  return u ? "notion-sidebar-tab:" + u : "notion-sidebar-tab";
}

function getSidebarTab() {
  return state.sidebarTab === "recents" ? "recents" : "library";
}

function applySidebarTabUI() {
  const tab = getSidebarTab();
  const sb = document.querySelector(".sidebar");
  if (sb) sb.dataset.tab = tab;
  const rec = $("#tabRecents");
  const lib = $("#tabLibrary");
  if (rec) {
    rec.classList.toggle("active", tab === "recents");
    rec.setAttribute("aria-selected", tab === "recents" ? "true" : "false");
  }
  if (lib) {
    lib.classList.toggle("active", tab === "library");
    lib.setAttribute("aria-selected", tab === "library" ? "true" : "false");
  }
}

function setSidebarTab(tab) {
  state.sidebarTab = tab === "recents" ? "recents" : "library";
  try { localStorage.setItem("notion-sidebar-tab", state.sidebarTab); } catch {}
  try { localStorage.setItem(sidebarTabLocalKey(), state.sidebarTab); } catch {}
  try {
    idbOrFallback(
      window.notifications.saveState(scopedKey("sidebarTab"), state.sidebarTab).catch(() => {}),
      2000, null
    ).catch(() => {});
  } catch {}
  applySidebarTabUI();
  renderTree();
}

async function loadSidebarState() {
  // Tab preference: per-user IndexedDB wins, localStorage is the instant mirror.
  try {
    const savedTab = await idbOrFallback(
      window.notifications.getState(scopedKey("sidebarTab")).catch(() => null),
      2000, null
    );
    const lsTab = (() => {
      try {
        return localStorage.getItem(sidebarTabLocalKey())
          || localStorage.getItem("notion-sidebar-tab");
      } catch { return null; }
    })();
    const tab = savedTab === "recents" || savedTab === "library" ? savedTab
      : (lsTab === "recents" || lsTab === "library" ? lsTab : "library");
    state.sidebarTab = tab;
  } catch { state.sidebarTab = state.sidebarTab || "library"; }
  applySidebarTabUI();
  // Recents: newest-first id list, pruned to pages that still exist.
  let ids = [];
  try {
    const saved = await idbOrFallback(
      window.notifications.getState(recentStorageKey()).catch(() => null),
      2000, null
    );
    if (Array.isArray(saved)) ids = saved.filter(x => typeof x === "string");
  } catch {}
  if (!ids.length) {
    try {
      const raw = localStorage.getItem(recentLocalKey());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) ids = parsed.filter(x => typeof x === "string");
      }
    } catch {}
  }
  state.recentIds = ids.filter(id => state.pages.has(id)).slice(0, MAX_RECENTS);
  // Cross-device backfill: fold server-stamped opens (other devices) into
  // the list, newest first. Unstamped ids keep their relative order at the
  // end — they were opened before stamps existed.
  try {
    const rank = new Map(state.recentIds.map((id, i) => [id, i]));
    const missing = [...state.pages.values()]
      .filter(p => p && p.id !== ROOT && p.lastOpenedAt != null && !rank.has(p.id))
      .map(p => p.id);
    if (missing.length) {
      state.recentIds = [...state.recentIds, ...missing]
        .sort((a, b) => {
          const ta = state.pages.get(a)?.lastOpenedAt ?? -1;
          const tb = state.pages.get(b)?.lastOpenedAt ?? -1;
          if (tb !== ta) return tb - ta;
          return (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9);
        })
        .slice(0, MAX_RECENTS);
      persistRecents();
    }
  } catch {}
}

function persistRecents() {
  try { localStorage.setItem(recentLocalKey(), JSON.stringify(state.recentIds)); } catch {}
  try {
    idbOrFallback(
      window.notifications.saveState(recentStorageKey(), state.recentIds.slice()).catch(() => {}),
      2000, null
    ).catch(() => {});
  } catch {}
}

function pushRecent(id, { rerender = true } = {}) {
  if (!id || id === ROOT || !state.pages.has(id)) return;
  const page = state.pages.get(id);
  // Optimistic local stamp: orders the just-opened page first instantly.
  // The server's touch (same open) is shared truth and wins on next sync.
  if (page) {
    page.lastOpenedAt = Date.now() / 1000;
    try { writeDraft(page); } catch {}
  }
  state.recentIds = [id, ...state.recentIds.filter(x => x !== id)].slice(0, MAX_RECENTS);
  persistRecents();
  if (rerender && getSidebarTab() === "recents" && !(state.pageFilter || "").trim()) renderTree();
}

// Union of local recents + server-stamped opens from other devices,
// newest first. Stable for ties, so unstamped locals keep list order.
function recentPages() {
  const seen = new Set();
  const out = [];
  for (const id of state.recentIds) {
    const p = state.pages.get(id);
    if (p && p.id !== ROOT && !seen.has(id)) { seen.add(id); out.push(p); }
  }
  for (const p of state.pages.values()) {
    if (!p || p.id === ROOT || seen.has(p.id)) continue;
    if (p.lastOpenedAt != null) { seen.add(p.id); out.push(p); }
  }
  out.sort((a, b) => (b.lastOpenedAt ?? -1) - (a.lastOpenedAt ?? -1));
  return out.slice(0, MAX_RECENTS);
}

function evictRecents(ids) {
  if (!ids || !ids.length) return;
  const gone = new Set(ids);
  const next = state.recentIds.filter(id => !gone.has(id));
  if (next.length !== state.recentIds.length) {
    state.recentIds = next;
    persistRecents();
  }
}

function clearRecents() {
  state.recentIds = [];
  persistRecents();
  if (getSidebarTab() === "recents") renderTree();
}

function initSidebarTabs() {
  applySidebarTabUI();
  if (document.body.dataset.tabsBound) return;
  document.body.dataset.tabsBound = "1";
  $("#tabRecents")?.addEventListener("click", () => setSidebarTab("recents"));
  $("#tabLibrary")?.addEventListener("click", () => setSidebarTab("library"));
}
initSidebarTabs();

function renderTree() {
  const root = $("#pageTree");
  root.innerHTML = "";
  root.classList.toggle("selecting", isSelecting());
  // Filter mode: flat match list so a buried page is one click away.
  const q = (state.pageFilter || "").trim().toLowerCase();
  if (q) {
    const matches = [...state.pages.values()]
      .filter(p => p.id !== ROOT && (p.title || "Untitled").toLowerCase().includes(q))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 50);
    const count = document.createElement("div");
    count.className = "tree-filter-count";
    count.textContent = matches.length ? matches.length + " match" + (matches.length === 1 ? "" : "es") : "";
    root.appendChild(count);
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "tree-filter-empty";
      empty.textContent = "No pages match — press Enter to create it";
      root.appendChild(empty);
      return;
    }
    for (const page of matches) {
      const row = document.createElement("div");
      row.className = "tree-row" + (page.id === state.currentPageId ? " active" : "");
      row.dataset.id = page.id;
      const emoji = document.createElement("span");
      emoji.className = "page-emoji";
      emoji.textContent = page.emoji || "";
      const link = document.createElement("div");
      link.className = "page-link";
      link.textContent = page.title || "Untitled";
      link.title = page.title || "Untitled";
      link.addEventListener("click", () => openPage(page.id));
      const parentTitle = page.parentId && page.parentId !== ROOT ? (state.pages.get(page.parentId)?.title || "") : "";
      const parent = document.createElement("span");
      parent.style.cssText = "font-size:11px;color:var(--muted);flex-shrink:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      parent.textContent = parentTitle;
      row.append(emoji, link, parent);
      root.appendChild(row);
    }
    return;
  }
  // Recents tab: flat newest-first list of recently opened pages.
  if (getSidebarTab() === "recents") {
    const recents = recentPages();
    const head = document.createElement("div");
    head.className = "tree-recents-head";
    const label = document.createElement("span");
    label.textContent = recents.length ? recents.length + " recent" + (recents.length === 1 ? "" : "s") : "";
    head.appendChild(label);
    if (recents.length) {
      const clear = document.createElement("button");
      clear.className = "tree-recents-clear";
      clear.textContent = "Clear";
      clear.title = "Clear recent pages";
      clear.setAttribute("aria-label", "Clear recent pages");
      clear.addEventListener("click", clearRecents);
      head.appendChild(clear);
    }
    root.appendChild(head);
    if (!recents.length) {
      const empty = document.createElement("div");
      empty.className = "tree-recents-empty";
      empty.textContent = "Pages you open will show up here";
      root.appendChild(empty);
      return;
    }
    for (const page of recents) {
      const row = document.createElement("div");
      row.className = "tree-row" + (page.id === state.currentPageId ? " active" : "");
      row.dataset.id = page.id;
      const emoji = document.createElement("span");
      emoji.className = "page-emoji";
      emoji.textContent = page.emoji || "";
      const link = document.createElement("div");
      link.className = "page-link";
      link.textContent = page.title || "Untitled";
      link.title = page.title || "Untitled";
      link.addEventListener("click", () => openPage(page.id));
      const parentTitle = page.parentId && page.parentId !== ROOT ? (state.pages.get(page.parentId)?.title || "") : "";
      const parent = document.createElement("span");
      parent.style.cssText = "font-size:11px;color:var(--muted);flex-shrink:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      parent.textContent = parentTitle;
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, page.id);
      });
      if (page.emoji) row.append(emoji, link, parent);
      else row.append(link, parent);
      root.appendChild(row);
    }
    return;
  }
  const walk = (parentId, depth) => {
    for (const page of childrenOf(parentId)) {
      const children = childrenOf(page.id);
      const row = document.createElement("div");
      row.className = "tree-row" + (page.id === state.currentPageId ? " active" : "") + (state.selected.has(page.id) ? " selected" : "");
      row.dataset.id = page.id;
      row.draggable = true;

      const indent = document.createElement("div");
      indent.className = "tree-indent";
      indent.style.flexBasis = (depth * 18) + "px";

      const checkbox = document.createElement("button");
      checkbox.className = "tree-checkbox" + (state.selected.has(page.id) ? " checked" : "");
      checkbox.innerHTML = state.selected.has(page.id) ? "✓" : "";
      checkbox.setAttribute("aria-label", "Select " + (page.title || "Untitled"));
      checkbox.setAttribute("aria-pressed", state.selected.has(page.id) ? "true" : "false");
      checkbox.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSelection(page.id);
      });

      const twisty = document.createElement("button");
      twisty.className = "twisty" + (children.length ? "" : " placeholder");
      twisty.textContent = children.length ? (state.expanded.has(page.id) ? "▾" : "▸") : "";
      twisty.title = children.length ? "Expand / collapse" : "";
      if (children.length) {
        twisty.addEventListener("click", (e) => {
          e.stopPropagation();
          state.expanded.has(page.id) ? state.expanded.delete(page.id) : state.expanded.add(page.id);
          renderTree();
        });
      }

      const emoji = document.createElement("span");
      emoji.className = "page-emoji";
      emoji.textContent = page.emoji || "";

      const publicIndicator = document.createElement("span");
      publicIndicator.className = "page-public-indicator";
      publicIndicator.innerHTML = page.isPublic ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3Z"/></svg>' : "";
      publicIndicator.title = page.isPublic ? "Public (includes subpages)" : "Private";
      publicIndicator.style.fontSize = "10px";
      publicIndicator.style.color = "var(--accent)";
      publicIndicator.style.flexShrink = "0";
      publicIndicator.style.opacity = "0.9";

      const link = document.createElement("div");
      link.className = "page-link";
      link.textContent = page.title || "Untitled";
      link.title = page.title || "Untitled";
      link.addEventListener("click", (e) => {
        if (isSelecting() || e.ctrlKey || e.metaKey) {
          toggleSelection(page.id);
        } else {
          openPage(page.id);
        }
      });

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, page.id);
      });

      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", page.id);
        e.dataTransfer.effectAllowed = "move";
        row.classList.add("dragging");
      });

      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        document.querySelectorAll(".tree-row.drop-target").forEach(el => el.classList.remove("drop-target"));
        const dropZone = root.querySelector(".drop-root-zone");
        if (dropZone) dropZone.classList.remove("visible");
      });

      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        const dragId = e.dataTransfer?.types?.includes("text/plain") ? true : false;
        if (dragId) {
          e.dataTransfer.dropEffect = "move";
          row.classList.add("drop-target");
        }
      });

      row.addEventListener("dragleave", () => {
        row.classList.remove("drop-target");
      });

      row.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove("drop-target");
        const draggedId = e.dataTransfer.getData("text/plain");
        if (!draggedId || draggedId === page.id) return;
        if (isDescendant(draggedId, page.id)) return;
        if (isDescendant(page.id, draggedId)) return;
        movePage(draggedId, page.id);
      });

      const add = document.createElement("button");
      add.className = "page-add";
      add.textContent = "+";
      add.title = "New sub-page";
      add.setAttribute("aria-label", "New sub-page inside " + (page.title || "Untitled"));
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        createPage(page.id);
      });
      const more = document.createElement("button");
      more.className = "page-more";
      more.textContent = "•••";
      more.title = "Page actions";
      more.setAttribute("aria-label", "Page actions for " + (page.title || "Untitled"));
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, page.id);
      });
      const parts = [indent, checkbox, twisty, link, publicIndicator, add, more];
      if (page.emoji) parts.splice(3, 0, emoji);
      // If page is public, keep indicator visible; otherwise it stays empty string
      row.append(...parts);
      root.appendChild(row);

      if (children.length && state.expanded.has(page.id)) walk(page.id, depth + 1);
    }
  };
  walk(ROOT, 0);

  const dropZone = document.createElement("div");
  dropZone.className = "drop-root-zone";
  const dropLabel = document.createElement("span");
  dropLabel.textContent = "Move to root";
  dropZone.appendChild(dropLabel);
  root.appendChild(dropZone);

  root.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".tree-row")) return;
    e.preventDefault();
    openSidebarMenu(e.clientX, e.clientY);
  });

}

function initRootDropZone() {
  const root = $("#pageTree");
  // Bound once here, not in renderTree(): re-adding it on every render would
  // stack duplicate click handlers on the persistent #pageTree element.
  root.addEventListener("click", (e) => {
    if (!e.target.closest(".tree-row") && isSelecting()) {
      setSelecting(false);
    }
  });
  root.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.types?.includes("text/plain")) {
      e.dataTransfer.dropEffect = "move";
      const dropZone = root.querySelector(".drop-root-zone");
      if (!dropZone) return;
      const rect = root.getBoundingClientRect();
      const lastRow = root.querySelector(".tree-row:last-of-type");
      if (lastRow) {
        const lastRect = lastRow.getBoundingClientRect();
        if (e.clientY > lastRect.bottom) {
          dropZone.classList.add("visible");
        } else {
          dropZone.classList.remove("visible");
        }
      } else {
        dropZone.classList.add("visible");
      }
    }
  });

  root.addEventListener("dragleave", (e) => {
    if (!root.contains(e.relatedTarget)) {
      const dropZone = root.querySelector(".drop-root-zone");
      if (dropZone) dropZone.classList.remove("visible");
    }
  });

  root.addEventListener("drop", (e) => {
    e.preventDefault();
    const dropZone = root.querySelector(".drop-root-zone");
    if (dropZone) dropZone.classList.remove("visible");
    const draggedId = e.dataTransfer.getData("text/plain");
    if (!draggedId) return;
    movePage(draggedId, ROOT);
  });
}

function openSidebarMenu(x, y) {
  closeContextMenu();
  const menu = $("#contextMenu");
  menu.innerHTML = "";
  const actions = [
    ["New page", () => createPage(ROOT)],
    ["Expand all", () => { state.expanded = new Set([...state.pages.keys()]); renderTree(); }],
    ["Collapse all", () => { state.expanded = new Set([ROOT]); renderTree(); }],
  ];
  actions.forEach(([label, fn]) => {
    const b = document.createElement("button");
    b.className = "context-item";
    b.textContent = label;
    b.addEventListener("click", () => { closeContextMenu(); fn(); });
    menu.appendChild(b);
  });
  menu.style.left = Math.min(x, window.innerWidth - 195) + "px";
  menu.style.top = Math.min(y, window.innerHeight - 130) + "px";
  menu.classList.add("open");
}

function isDescendant(childId, parentId) {
  const visited = new Set();
  let cursor = state.pages.get(childId);
  while (cursor) {
    if (visited.has(cursor.id)) return false;
    visited.add(cursor.id);
    if (cursor.parentId === parentId) return true;
    cursor = state.pages.get(cursor.parentId);
  }
  return false;
}

function isSelecting() {
  return state.selecting || state.selected.size > 0;
}

function setSelecting(on) {
  state.selecting = !!on;
  if (!state.selecting) state.selected.clear();
  const btn = $("#selectModeBtn");
  if (btn) btn.setAttribute("aria-pressed", state.selecting ? "true" : "false");
  renderTree();
  renderSelectionBar();
}

function toggleSelection(pageId) {
  if (state.selected.has(pageId)) {
    state.selected.delete(pageId);
  } else {
    state.selected.add(pageId);
  }
  renderTree();
  renderSelectionBar();
}

function renderSelectionBar() {
  let bar = $("#selectionBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "selectionBar";
    bar.className = "selection-bar";
    const sidebar = document.querySelector(".sidebar");
    sidebar.insertBefore(bar, sidebar.querySelector(".sidebar-footer"));
  }
  const count = state.selected.size;
  if (!isSelecting()) {
    bar.innerHTML = "";
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  if (count === 0) {
    bar.innerHTML = `<span>Select pages</span>
      <button class="sel-btn" data-action="done">Done</button>`;
  } else {
    bar.innerHTML = `<span>${count} selected</span>
      <button class="sel-btn" data-action="delete">Delete</button>
      <button class="sel-btn" data-action="move">Move to...</button>
      <button class="sel-btn" data-action="clear">Clear</button>`;
  }
  bar.querySelectorAll(".sel-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "delete") deleteSelected();
      else if (action === "move") moveSelectedPrompt();
      else setSelecting(false);
    });
  });
}

async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const ok = await confirmDialog({
    title: `Delete ${ids.length} page${ids.length === 1 ? "" : "s"}?`,
    message: "This removes the selected pages and everything nested inside them. This cannot be undone.",
    confirmLabel: "Delete",
  });
  if (!ok) return;
  clearTimeout(state.flushTimer);
  for (const id of ids) {
    state.pages.delete(id);
    try { window.notifications.deleteDraft(id).catch(() => {}); } catch {}
    try { await window.api.deletePage(id); } catch {}
  }
  state.selected.clear();
  state.selecting = false;
  const btn = $("#selectModeBtn");
  if (btn) btn.setAttribute("aria-pressed", "false");
  if (!childrenOf(ROOT).length) {
    const welcome = makePage({ id: "welcome", title: "Welcome", parentId: ROOT, emoji: "👋" });
    welcome._localOnly = true; welcome.dirty = true;
    state.pages.set(welcome.id, welcome);
    await writeDraft(welcome);
    try { await window.api.createPage({ id: welcome.id, title: welcome.title, content: JSON.stringify(welcome.blocks), parent_id: welcome.parentId }); } catch {}
  }
  const first = childrenOf(ROOT)[0];
  if (first) await openPage(first.id);
  renderTree();
  renderSelectionBar();
}

function moveSelectedPrompt() {
  const ids = [...state.selected];
  if (!ids.length) return;
  closeSelectionBar();
  const menu = $("#contextMenu");
  menu.innerHTML = "";
  menu.classList.add("move-picker");
  const isMobile = window.matchMedia && window.matchMedia("(max-width: 768px)").matches;

  const header = document.createElement("div");
  header.className = "move-picker-header";
  const title = document.createElement("div");
  title.className = "move-picker-title";
  title.textContent = `Move ${ids.length} page${ids.length === 1 ? "" : "s"} to…`;
  const search = document.createElement("input");
  search.className = "move-search";
  search.type = "text";
  search.placeholder = "Search pages…";
  search.setAttribute("aria-label", "Search destination pages");
  search.autocomplete = "off";
  search.spellcheck = false;
  header.append(title, search);
  menu.appendChild(header);

  const list = document.createElement("div");
  list.className = "move-list";
  list.setAttribute("role", "listbox");
  menu.appendChild(list);

  // Eligible destinations: everything except the selection itself and their
  // descendants (moving into your own child would orphan the tree).
  const blocked = new Set(ids);
  for (const id of ids) {
    const collect = (pid) => {
      for (const child of childrenOf(pid)) {
        if (!blocked.has(child.id)) { blocked.add(child.id); collect(child.id); }
      }
    };
    collect(id);
  }
  const pages = [...state.pages.values()]
    .filter(p => !blocked.has(p.id))
    .sort((a, b) => (a.title || "Untitled").localeCompare(b.title || "Untitled"));

  function pick(id, label) {
    closeContextMenu();
    ids.forEach(pid => movePage(pid, id));
    setSelecting(false);
    setSaveState(label ? `Moved to ${label}` : "Moved", false);
  }

  function renderList(filter="") {
    list.innerHTML = "";
    const f = filter.trim().toLowerCase();
    const rootBtn = document.createElement("button");
    rootBtn.className = "move-item";
    rootBtn.setAttribute("role", "option");
    rootBtn.innerHTML = `<span class="move-title"></span>`;
    rootBtn.querySelector(".move-title").textContent = "Top level (no parent)";
    if (!f || "top level".includes(f) || "root".includes(f)) {
      rootBtn.addEventListener("click", () => pick(ROOT, "top level"));
      list.appendChild(rootBtn);
    }
    const matches = f
      ? pages.filter(p => (p.title || "Untitled").toLowerCase().includes(f) ||
          (state.pages.get(p.parentId)?.title || "").toLowerCase().includes(f))
      : pages;
    if (!matches.length && list.children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "move-empty";
      empty.textContent = "No matching pages";
      list.appendChild(empty);
      return;
    }
    for (const p of matches) {
      const item = document.createElement("button");
      item.className = "move-item";
      item.setAttribute("role", "option");
      const t = document.createElement("span");
      t.className = "move-title";
      t.textContent = (p.emoji ? p.emoji + " " : "") + (p.title || "Untitled");
      item.appendChild(t);
      if (p.parentId !== ROOT) {
        const parent = document.createElement("span");
        parent.className = "move-parent";
        parent.textContent = state.pages.get(p.parentId)?.title || "";
        item.appendChild(parent);
      }
      item.title = p.title || "Untitled";
      item.addEventListener("click", () => pick(p.id, p.title || "page"));
      list.appendChild(item);
    }
  }

  search.addEventListener("input", () => renderList(search.value));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = list.querySelector(".move-item");
      if (first) first.click();
    }
  });
  renderList("");

  if (isMobile) {
    menu.style.left = "";
    menu.style.top = "";
  } else {
    const rect = document.querySelector(".sidebar").getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.width / 2 - 140, window.innerWidth - 296)) + "px";
    menu.style.top = Math.max(8, Math.min(rect.height / 2 - 160, window.innerHeight - 460)) + "px";
  }
  menu.classList.add("open");
  setTimeout(() => { try { search.focus({ preventScroll: true }); } catch { try { search.focus(); } catch {} } }, 40);
}

function closeSelectionBar() {
  const bar = $("#selectionBar");
  if (bar) bar.style.display = "none";
}

async function movePage(pageId, newParentId) {
  const page = state.pages.get(pageId);
  if (!page) return;
  if (isDescendant(pageId, newParentId)) return;
  page.parentId = newParentId;
  page.updatedAt = Date.now();
  page.epoch = (page.epoch || 0) + 1;
  page.dirty = true;
  page._parentChanged = true;
  page._localOnly = page._localOnly || page.baseRev == null;
  state.pages.set(pageId, page);
  state.expanded.add(newParentId);
  refreshGlobalDirty();
  await writeDraft(page);
  renderTree();
  renderBreadcrumbs();
  scheduleFlush(3000);
  // Attempt immediate single-flight move; conflicts surface via flushQueue.
  flushQueue();
}

function renderBreadcrumbs() {
  const page = state.pages.get(state.currentPageId);
  if (!page) return;
  const crumbs = [];
  let cursor = page;
  while (cursor && cursor.id !== ROOT) {
    crumbs.unshift(cursor);
    cursor = state.pages.get(cursor.parentId);
  }
  const el = $("#breadcrumbs");
  el.innerHTML = "";
  crumbs.forEach((crumb, i) => {
    const isCurrent = i === crumbs.length - 1;
    const s = document.createElement(isCurrent ? "span" : "a");
    s.textContent = crumb.title || "Untitled";
    if (isCurrent) {
      s.className = "crumb-current";
    } else {
      s.href = "#";
      s.addEventListener("click", (e) => { e.preventDefault(); openPage(crumb.id); });
    }
    el.appendChild(s);
    if (i < crumbs.length - 1) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "›";
      el.appendChild(sep);
    }
  });
  try { updateDocMeta(); } catch {}
}

async function mountEditor(blocks) {
  if (state.editor) {
    try { state.editor.unmount(); } catch {}
    state.editor = null;
  }
  $("#editor").innerHTML = "";
  editorWired = false;
  let initialBlocks = blocks;
  if (typeof blocks === "string") {
    try { initialBlocks = JSON.parse(blocks); } catch { initialBlocks = [{type:"paragraph"}]; }
  }
  if (!initialBlocks || !initialBlocks.length) initialBlocks = [{type:"paragraph"}];
  state.editor = BlockNoteEditor.create({
    initialContent: initialBlocks,
    blockHandle: true,
    uploadFile: async (file) => {
      const { url } = await window.api.uploadFile(file);
      return url;
    }
  });
  state.editor.mount($("#editor"));
  state.editor.onChange(() => {
    if (state.currentPageId) markDirty();
    renderAutoToc();
    try { updateDocMeta(); } catch {}
    // IME path (mobile): no reliable "/" keydown, so sync from text.
    try { maybeSyncSlashFromText(); } catch {}
    try { keepCaretVisible(); } catch {}
  });
  wireEditorInteractions();
  try { updateDocMeta(); } catch {}
}

function parseBlocks(content) {
  let blocks = content;
  if (typeof blocks === "string") {
    try { blocks = JSON.parse(blocks); } catch { blocks = [{type:"paragraph"}]; }
  }
  if (!blocks || !blocks.length) blocks = [{type:"paragraph"}];
  return blocks;
}

function fetchWithTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function revealPage(id) {
  // Expand every ancestor so the row is actually visible in the sidebar.
  // renderTree only walks into children of expanded pages, so opening a
  // nested page without this leaves it mounted but invisible.
  const visited = new Set();
  let cursor = state.pages.get(id);
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const pid = cursor.parentId;
    if (!pid || pid === ROOT) break;
    state.expanded.add(pid);
    cursor = state.pages.get(pid);
  }
}

function scrollTreeRowIntoView(id) {
  try {
    requestAnimationFrame(() => {
      const row = document.querySelector(".tree-row[data-id='" + CSS.escape(id) + "']");
      if (row) row.scrollIntoView({ block: "nearest" });
    });
  } catch {
    try {
      const row = document.querySelector(".tree-row[data-id='" + id + "']");
      if (row) row.scrollIntoView({ block: "nearest" });
    } catch {}
  }
}

async function openPage(id) {
  // Queue current page snapshot locally (fast switch, no server wait).
  // NOTE: no updatedAt bump here — the previous page already got its
  // modified-time bump when it was actually edited (markDirty). Bumping on
  // every navigation would reorder the "modified" sort just by looking.
  const prev = state.pages.get(state.currentPageId);
  if (prev && prev.dirty && state.editor && state.currentPageId !== id) {
    try { prev.blocks = structuredClone(state.editor.document); } catch {}
    const t = $("#pageTitle");
    if (t) prev.title = t.value.trim() || "Untitled";
    await writeDraft(prev);
    scheduleFlush(SAVE_DEBOUNCE_MS);
  }
  state.isOpeningPage = true;
  hideConflictBar();
  const page = state.pages.get(id);
  if (!page) { state.isOpeningPage = false; return; }
  state.currentPageId = id;
  try { await idbOrFallback(window.notifications.saveState(scopedKey("lastPageId"), id).catch(() => {}), 2000, null); } catch {}
  pushRecent(id, { rerender: false });
  page.mountEpoch = (page.epoch || 0);
  // Mount cached copy instantly, locked until verified (stale-cache guard).
  const hadContent = page.blocks != null;
  page.contentLoaded = page.contentLoaded || hadContent;
  if (!page.blocks) page.blocks = [{type:"paragraph"}];
  $("#pageTitle").value = page.title || "Untitled";
  await mountEditor(page.blocks);
  setTimeout(() => renderAutoToc(), 80);
  state.expanded.add(page.id);
  revealPage(page.id);
  renderTree();
  renderBreadcrumbs();
  updatePublicToggleUI();
  scrollTreeRowIntoView(page.id);
  $("#workspace").scrollTop = 0;
  // On phones the sidebar is an overlay — always get it out of the way.
  try { if (isMobileLayout()) toggleSidebar(false); } catch {}
  if (page.conflictServer) {
    setLocked(page, false);
    showConflictBar(page);
    setSaveState("Conflict — action needed");
    state.isOpeningPage = false;
    return;
  }
  setLocked(page, true, "Cached copy — checking for newer version…");
  setSaveState("Loading...", false);
  // Local-only pages need no verification.
  if (page._localOnly && page.baseRev == null) {
    page.contentLoaded = true;
    setLocked(page, false);
    hideSyncBanner();
    setSaveState("New page — editing locally", false);
    state.isOpeningPage = false;
    return;
  }
  try {
    const data = await fetchWithTimeout(window.api.getPage(id), VERIFY_TIMEOUT_MS);
    // Navigated away while verifying: never touch the editor (stale-fetch guard).
    if (state.currentPageId !== id) { state.isOpeningPage = false; return; }
    // Adopt the server's open-stamp (written by this very fetch): shared
    // truth for cross-device recents, straight from the source.
    if (data && data.last_opened_at != null) page.lastOpenedAt = data.last_opened_at;
    const editedDuringVerify = (page.epoch || 0) !== (page.mountEpoch || 0);
    let serverBlocks = parseBlocks(data.content);
    const serverUpdated = parseFloat(data.updated_at || 0);
    const localBase = parseFloat(page.baseUpdatedAt || 0);
    const serverNewer = (serverUpdated - localBase > 0.001) ||
      (data.rev != null && page.baseRev != null && parseInt(data.rev, 10) !== parseInt(page.baseRev, 10));
    const serverHash = hashContent(serverBlocks);
    if (page.dirty || editedDuringVerify) {
      // NEVER overwrite local edits with a late fetch. Update base tracking
      // only; if server is also newer this is a real conflict.
      page.contentLoaded = true; // editor holds intentional local content
      if (serverNewer && serverHash !== pageContentHash(page)) {
        page.conflictServer = data;
        await writeDraft(page);
        setLocked(page, false);
        showConflictBar(page);
        setSaveState("Conflict — action needed");
      } else {
        page.baseRev = data.rev ?? page.baseRev;
        page.baseUpdatedAt = data.updated_at ?? page.baseUpdatedAt;
        page.rev = data.rev ?? page.rev ?? 1;
        setLocked(page, false);
        setSaveState(page.dirty ? "Unsaved · will sync" : "Ready", false);
        if (page.dirty) scheduleFlush(3000);
      }
    } else {
      // Meta-only pages (no body yet) always need the server copy, even when
      // rev/updated_at already match — the match is trivially true because we
      // have nothing to compare against. Applying is safe: the editor holds
      // only the empty placeholder and the page is not dirty (edit gate).
      if (serverNewer || !hadContent) {
        page.blocks = serverBlocks;
        page.title = data.title || page.title;
        page.parentId = data.parent_id || page.parentId;
        page.isPublic = Boolean(data.is_public);
        page.rev = data.rev ?? page.rev ?? 1;
        page.baseRev = page.rev;
        page.baseUpdatedAt = data.updated_at ?? page.baseUpdatedAt;
        page.baseTitle = page.title;
        page.baseHash = hashContent(serverBlocks);
        // Viewing must not change sort order: adopt the server's modified
        // time instead of Date.now(), so merely opening a page never
        // promotes it to the top of the "modified" sort.
        if (serverUpdated) page.updatedAt = serverUpdated * 1000;
        page.contentLoaded = true;
        await writeDraft(page);
        if (state.currentPageId === id) {
          $("#pageTitle").value = page.title || "Untitled";
          await mountEditor(page.blocks);
          setTimeout(() => renderAutoToc(), 80);
          revealPage(page.id);
          renderTree();
          renderBreadcrumbs();
          updatePublicToggleUI();
          scrollTreeRowIntoView(page.id);
        }
        setSaveState(hadContent ? "Updated to latest" : "Ready", false);
      } else {
        page.rev = data.rev ?? page.rev ?? 1;
        page.baseRev = page.baseRev ?? page.rev;
        page.baseUpdatedAt = page.baseUpdatedAt ?? data.updated_at;
        page.baseTitle = page.baseTitle ?? page.title;
        page.baseHash = page.baseHash ?? hashContent(page.blocks);
        if (page.blocks != null) page.contentLoaded = true;
        setSaveState("Ready", false);
      }
      setLocked(page, false);
    }
  } catch (err) {
    console.warn("Verify failed, staying on local copy:", err);
    if (state.currentPageId !== id) { state.isOpeningPage = false; return; }
    if (err && err.status === 404 && !page.dirty && !page._localOnly) {
      // Stale stub: cached from another account or deleted on the server.
      // Evict it instead of locking the editor forever on "Couldn't load
      // content" — then fall through to a surviving page, or a blank
      // Welcome when nothing remains (initialize() seeds demos on boot).
      try { window.notifications.deleteDraft(id).catch(() => {}); } catch {}
      state.pages.delete(id);
      renderTree();
      renderBreadcrumbs();
      const fallback = childrenOf(ROOT)[0] || null;
      if (fallback && fallback.id !== id) {
        state.isOpeningPage = false;
        await openPage(fallback.id);
        return;
      }
      const welcome = makePage({ id: "welcome", title: "Welcome", parentId: ROOT, emoji: "👋" });
      welcome._localOnly = true; welcome.dirty = true;
      state.pages.set(welcome.id, welcome);
      await writeDraft(welcome);
      try {
        await window.api.createPage({
          id: welcome.id,
          title: welcome.title,
          content: JSON.stringify(welcome.blocks),
          parent_id: welcome.parentId
        });
      } catch {}
      state.isOpeningPage = false;
      await openPage(welcome.id);
      return;
    }
    if (!page.contentLoaded) {
      // Content was never loaded (no draft, fetch failed): keep the editor
      // locked on the empty placeholder. Unlocking here would let a keystroke
      // queue a near-blank doc over the real server content — the exact
      // blank-overwrite path. Click the page to retry once online.
      setLocked(page, true, "Couldn't load content — check connection, then click this page to retry");
      setSaveState("Content not loaded — retry", false);
    } else {
      // Offline escape: unlock for local editing, edits queue in drafts.
      setLocked(page, false);
      showSyncBanner("Offline — editing local copy, will sync later", true);
      setSaveState("Offline — editing locally", false);
    }
  }
  state.isOpeningPage = false;
}

async function createPage(parentId=ROOT) {
  // During initial meta sync, force root parenting: parent links are unverified.
  if (!state.metaReady) parentId = ROOT;
  if (state.currentPageId) {
    const cur = state.pages.get(state.currentPageId);
    if (cur && state.editor) {
      try { cur.blocks = structuredClone(state.editor.document); } catch {}
      const t = $("#pageTitle");
      if (t) cur.title = t.value.trim() || "Untitled";
      if (cur.dirty || pageContentHash(cur) !== (cur.baseHash || "")) {
        cur.updatedAt = Date.now();
        cur.dirty = true;
        await writeDraft(cur);
      }
    }
  }
  const page = makePage({ parentId, title: "Untitled", blocks: [{type:"paragraph", content:""}] });
  page.verified = true;
  page.dirty = true;
  page._localOnly = true;
  page.baseRev = null;
  page.baseUpdatedAt = null;
  page.baseHash = null;
  state.pages.set(page.id, page);
  state.expanded.add(parentId);
  refreshGlobalDirty();
  await writeDraft(page);
  renderTree();
  try {
    const res = await window.api.createPage({
      id: page.id,
      title: page.title,
      content: JSON.stringify(page.blocks),
      parent_id: page.parentId
    });
    page.rev = res.rev ?? 1;
    page.baseRev = page.rev;
    page.baseUpdatedAt = res.updated_at ?? (Date.now() / 1000);
    page.baseTitle = page.title;
    page.baseHash = hashContent(page.blocks);
    page.dirty = false;
    page._localOnly = false;
    await writeDraft(page);
    refreshGlobalDirty();
  } catch (err) {
    console.warn("Create queued offline:", err);
    setSaveState("Offline — new page saved locally", false);
    scheduleFlush(15000);
  }
  await openPage(page.id);
  setTimeout(() => { $("#pageTitle").focus(); }, 60);
  setTimeout(() => {
    const row = document.querySelector(".tree-row[data-id='" + page.id + "']");
    if (row) { row.classList.add("page-created-flash"); setTimeout(() => row.classList.remove("page-created-flash"), 600); }
  }, 150);
}

async function deletePage(id) {
  if (id === state.currentPageId) {
    const fallback = childrenOf(ROOT).find(p => p.id !== id);
    if (!fallback) return;
    await openPage(fallback.id);
  }
  const descendants = [];
  const collect = (parentId) => {
    for (const child of childrenOf(parentId)) {
      descendants.push(child.id);
      collect(child.id);
    }
  };
  collect(id);
  for (const did of [id, ...descendants]) {
    state.pages.delete(did);
    try { window.notifications.deleteDraft(did).catch(() => {}); } catch {}
    try { await window.api.deletePage(did); } catch {}
  }
  evictRecents([id, ...descendants]);
  const remaining = childrenOf(ROOT);
  if (!remaining.length) {
    const welcome = makePage({ id: "welcome", title: "Welcome", parentId: ROOT, emoji: "👋" });
    welcome._localOnly = true; welcome.dirty = true;
    state.pages.set(welcome.id, welcome);
    await writeDraft(welcome);
    try {
      await window.api.createPage({
        id: welcome.id,
        title: welcome.title,
        content: JSON.stringify(welcome.blocks),
        parent_id: welcome.parentId
      });
    } catch {}
  }
  await openPage(state.currentPageId || (childrenOf(ROOT)[0]?.id ?? null));
  renderTree();
}

function openContextMenu(x, y, pageId) {
  const menu = $("#contextMenu");
  state.contextPageId = pageId;
  menu.innerHTML = "";
  menu.classList.remove("move-picker");
  const page = state.pages.get(pageId);
  const pageTitle = page ? (page.title || "Untitled") : "this page";
  const actions = [
    ["New sub-page", () => createPage(pageId)],
    ["Duplicate", () => duplicatePage(pageId)],
    ["Rename", () => { openPage(pageId).then(() => { const input = $("#pageTitle"); input.focus(); input.select(); }); }],
    ["Delete page", async () => {
      const ok = await confirmDialog({
        title: `Delete "${pageTitle.length > 40 ? pageTitle.slice(0, 40) + "…" : pageTitle}"?`,
        message: "This removes the page and all of its nested pages. This cannot be undone.",
        confirmLabel: "Delete",
      });
      if (ok) deletePage(pageId);
    }],
  ];
  actions.forEach(([label, fn], idx) => {
    const b = document.createElement("button");
    b.className = "context-item" + (idx === 3 ? " context-danger" : "");
    b.textContent = label;
    b.addEventListener("click", () => { closeContextMenu(); fn(); });
    menu.appendChild(b);
  });
  menu.style.left = Math.min(x, window.innerWidth - 235) + "px";
  menu.style.top = Math.min(y, window.innerHeight - 200) + "px";
  menu.classList.add("open");
}

async function duplicatePage(pageId) {
  const page = state.pages.get(pageId);
  if (!page) return;
  if (!page.blocks) {
    try {
      const data = await window.api.getPage(pageId);
      let blocks = data.content;
      if (typeof blocks === "string") {
        try { blocks = JSON.parse(blocks); } catch { blocks = [{type:"paragraph"}]; }
      }
      page.blocks = blocks;
    } catch {
      page.blocks = [{type:"paragraph"}];
    }
  }
  const collectDescendants = (pid) => {
    const children = childrenOf(pid);
    const result = [];
    for (const child of children) {
      result.push(child);
      result.push(...collectDescendants(child.id));
    }
    return result;
  };
  const allPages = [page, ...collectDescendants(pageId)];
  for (const p of allPages) {
    if (!p.blocks) {
      try {
        const data = await window.api.getPage(p.id);
        let blocks = data.content;
        if (typeof blocks === "string") {
          try { blocks = JSON.parse(blocks); } catch { blocks = [{type:"paragraph"}]; }
        }
        p.blocks = blocks;
      } catch {
        p.blocks = [{type:"paragraph"}];
      }
    }
  }
  const idMap = new Map();
  for (const p of allPages) {
    const newId = uid("page");
    idMap.set(p.id, newId);
  }
  for (const p of allPages) {
    const newId = idMap.get(p.id);
    // Root of the duplicated subtree becomes a sibling of the original;
    // descendants keep their relative parents via the id map. The old
    // `p.parentId === pageId` check inverted this: it orphaned the root
    // (idMap has no entry for its outside parent) and flattened children
    // onto the grandparent.
    const newParentId = p.id === pageId ? page.parentId : (idMap.get(p.parentId) || page.parentId);
    const newPage = makePage({
      id: newId,
      title: p.title + " (copy)",
      parentId: newParentId,
      emoji: p.emoji,
      blocks: JSON.parse(JSON.stringify(p.blocks)),
    });
    state.pages.set(newId, newPage);
    state.expanded.add(newParentId);
    newPage._localOnly = true;
    newPage.dirty = true;
    newPage.baseRev = null;
    await writeDraft(newPage);
    try {
      const res = await window.api.createPage({
        id: newId,
        title: newPage.title,
        content: JSON.stringify(newPage.blocks),
        parent_id: newPage.parentId,
      });
      if (res) {
        newPage.rev = res.rev ?? 1;
        newPage.baseRev = newPage.rev;
        newPage.baseUpdatedAt = res.updated_at ?? (Date.now() / 1000);
        newPage.baseTitle = newPage.title;
        newPage.baseHash = hashContent(newPage.blocks);
        newPage.dirty = false;
        newPage._localOnly = false;
        await writeDraft(newPage);
      }
    } catch (err) {
      console.error("Failed to create page during duplicate:", err);
      scheduleFlush(15000);
    }
  }
  renderTree();
}
function closeContextMenu() {
  const menu = $("#contextMenu");
  if (!menu) return;
  const wasMovePicker = menu.classList.contains("move-picker");
  menu.classList.remove("open");
  menu.classList.remove("move-picker");
  menu.style.left = "";
  menu.style.top = "";
  // Cancelling the move picker must not strand the selection with no bar.
  if (wasMovePicker && state.selected && state.selected.size) {
    try { renderSelectionBar(); } catch {}
  }
}

function getCurrentBlock() {
  try { return state.editor?.getTextCursorPosition()?.block || null; } catch { return null; }
}

function currentBlockText(block) {
  if (!block) return "";
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.map(x => typeof x === "string" ? x : (x?.text || "")).join("");
  return "";
}

function updateDocMeta() {
  const el = $("#docMeta");
  if (!el) return;
  const page = state.pages.get(state.currentPageId);
  if (!page) { el.textContent = ""; return; }
  let words = 0;
  try {
    const docs = (state.currentPageId && state.editor) ? state.editor.document : (page.blocks || []);
    const title = ($("#pageTitle")?.value || page.title || "");
    const all = title + "\n" + (docs || []).map(b => currentBlockText(b)).join("\n");
    words = (all.trim().match(/\S+/g) || []).length;
  } catch { words = 0; }
  let edited = "";
  try {
    const ts = page.updatedAt || (page.baseUpdatedAt ? page.baseUpdatedAt * 1000 : 0);
    if (ts) {
      const d = new Date(ts);
      const today = new Date();
      const sameDay = d.toDateString() === today.toDateString();
      edited = sameDay
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
  } catch {}
  el.textContent = words + (words === 1 ? " word" : " words") + (edited ? " · Edited " + edited : "");
}

function filteredCommands() {
  const f = state.slashFilter.toLowerCase();
  return BLOCKS.filter(b => !f || (b.label + " " + b.desc).toLowerCase().includes(f));
}

function isMobileLayout() {
  try { return window.matchMedia && window.matchMedia("(max-width: 768px)").matches; } catch { return false; }
}

function isCoarsePointer() {
  try { return window.matchMedia && window.matchMedia("(hover: none), (pointer: coarse)").matches; } catch { return false; }
}

// IME-friendly slash trigger: mobile keyboards (Gboard/Samsung/iOS) often
// deliver keydown as key=229/"Unidentified", so the "/" keydown path never
// fires. Derive the trigger from block text instead: a "/" starting the
// block or following whitespace, with the filter being whatever trails it.
function slashTriggerFromText(text) {
  const t = text || "";
  const m = /(?:^|\s)\/([A-Za-z0-9_-]*)$/.exec(t);
  if (m) return m[1] ?? "";
  return null;
}

let _slashSyncQueued = false;
function maybeSyncSlashFromText() {
  if (!state.editor || state.isOpeningPage) return;
  if (_slashSyncQueued) return;
  _slashSyncQueued = true;
  requestAnimationFrame(() => {
    _slashSyncQueued = false;
    try {
      const block = getCurrentBlock();
      if (!block) return;
      const text = currentBlockText(block);
      const filter = slashTriggerFromText(text);
      const menuOpen = $("#slashMenu").classList.contains("open");
      if (filter != null) {
        state.slashFilter = filter;
        state.slashIndex = 0;
        renderSlashMenu();
      } else if (menuOpen && !(text || "").includes("/")) {
        closeSlashMenu({ keepText: true });
      }
    } catch {}
  });
}

function positionSlashMenu() {
  const menu = $("#slashMenu");
  // Mobile uses the bottom-sheet CSS (above the keyboard). Inline caret
  // coordinates would strand it off-screen, so don't set them there.
  if (isMobileLayout()) {
    menu.style.maxHeight = "";
    return;
  }
  let r = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    r = sel.getRangeAt(0).getBoundingClientRect();
  }
  if ((!r || (r.width === 0 && r.height === 0)) && document.activeElement) {
    const active = document.activeElement;
    if (active && active.getBoundingClientRect) {
      const rect = active.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        r = rect;
      }
    }
  }
  if (!r) return;
  const GAP = 8;
  const MARGIN = 8;
  const vw = window.innerWidth || document.documentElement.clientWidth || 800;
  const vh = window.innerHeight || document.documentElement.clientHeight || 600;
  // Constrain height so the menu can never be taller than the viewport.
  const maxAllowedH = Math.max(120, vh - MARGIN * 2);
  menu.style.maxHeight = Math.min(380, maxAllowedH) + "px";
  const menuH = menu.offsetHeight || Math.min(380, maxAllowedH);
  const menuW = menu.offsetWidth || 320;
  // Horizontal: clamp into viewport, fall back to margin on tiny screens.
  let left = Math.max(MARGIN, Math.min(r.left, vw - menuW - MARGIN));
  if (vw - menuW - MARGIN < MARGIN) left = MARGIN;
  menu.style.left = left + "px";
  // Vertical: prefer below the caret, flip above when there is no room.
  const spaceBelow = vh - r.bottom - GAP;
  const spaceAbove = r.top - GAP;
  let top;
  if (spaceBelow >= menuH || spaceBelow >= spaceAbove) {
    top = r.bottom + GAP;
    if (top + menuH > vh - MARGIN) top = Math.max(MARGIN, vh - menuH - MARGIN);
  } else {
    top = r.top - menuH - GAP;
    if (top < MARGIN) top = Math.max(MARGIN, vh - menuH - MARGIN);
  }
  menu.style.top = top + "px";
}

function renderSlashMenu() {
  const menu = $("#slashMenu");
  const cmds = filteredCommands();
  menu.innerHTML = "<div class='slash-header'>Basic blocks</div>";
  if (!cmds.length) {
    const empty = document.createElement("div");
    empty.className = "slash-header";
    empty.textContent = "No matching blocks";
    menu.appendChild(empty);
  }
  state.slashIndex = Math.max(0, Math.min(state.slashIndex, Math.max(0, cmds.length - 1)));
  cmds.forEach((cmd, i) => {
    const item = document.createElement("button");
    item.className = "slash-item" + (i === state.slashIndex ? " selected" : "");
    item.innerHTML = `<span class="slash-icon"></span><span class="slash-copy"><div class="slash-label"></div><div class="slash-desc"></div></span>`;
    item.querySelector(".slash-icon").textContent = cmd.icon;
    item.querySelector(".slash-label").textContent = cmd.label;
    item.querySelector(".slash-desc").textContent = cmd.desc;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      chooseSlash(cmd);
    });
    // Touch (mobile) doesn't always deliver mousedown before the tap ends.
    item.addEventListener("click", (e) => {
      try {
        if (isMobileLayout() || isCoarsePointer()) { e.preventDefault(); chooseSlash(cmd); }
      } catch {}
    });
    menu.appendChild(item);
  });
  menu.classList.add("open");
  positionSlashMenu();
  requestAnimationFrame(() => {
    const selected = menu.querySelector(".slash-item.selected");
    if (selected) {
      // Keep scrolling inside the menu so the page doesn't jump.
      const st = menu.scrollTop;
      const sh = menu.clientHeight;
      const ot = selected.offsetTop;
      const oh = selected.offsetHeight;
      if (ot < st) menu.scrollTop = ot - 6;
      else if (ot + oh > st + sh) menu.scrollTop = ot + oh - sh + 6;
    }
  });
}

function closeSlashMenu({ keepText=false }={}) {
  const menu = $("#slashMenu");
  if (!menu.classList.contains("open")) { state.slashFilter = ""; state.slashIndex = 0; return; }
  menu.classList.remove("open");
  // Dismissing the menu should only strip the "/filter" trigger text, never
  // wipe the block. (The old code cleared the whole block content.)
  if (!keepText) {
    try {
      const block = getCurrentBlock();
      if (block) {
        const txt = currentBlockText(block);
        const m = /(?:^|\s)\/[A-Za-z0-9_-]*$/.exec(txt || "");
        if (m) {
          const stripped = (txt || "").slice(0, (txt || "").length - m[0].length + (m[0].startsWith(" ") || m[0].startsWith("\n") ? 1 : 0));
          state.editor.updateBlock(block, { content: stripped });
          try { state.editor.setTextCursorPosition(block.id, "end"); } catch {}
        }
      }
    } catch {}
  }
  state.slashFilter = "";
  state.slashIndex = 0;
}

// Keep the caret inside the .workspace scroller with room for the keyboard,
// without ever scrolling the window (which is what used to push the topbar
// + title row out of view until a manual refresh).
let _caretScrollQueued = false;
function keepCaretVisible() {
  if (_caretScrollQueued) return;
  _caretScrollQueued = true;
  requestAnimationFrame(() => {
    _caretScrollQueued = false;
    try {
      const ws = $("#workspace");
      if (!ws) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return;
      const wsRect = ws.getBoundingClientRect();
      const kbPad = 140;
      if (r.bottom > wsRect.bottom - kbPad) {
        ws.scrollTop += (r.bottom - (wsRect.bottom - kbPad)) + 12;
      } else if (r.top < wsRect.top + 8) {
        ws.scrollTop -= (wsRect.top + 8 - r.top) + 12;
      }
    } catch {}
  });
}

// Mobile "/" button: focus the editor and open the block menu at the caret.
// Works even when the keyboard never emits a "/" key event.
function openSlashFromButton() {
  try {
    if (!state.editor) return;
    try { state.editor.focus(); } catch {}
    const block = getCurrentBlock();
    if (!block) { state.slashFilter = ""; state.slashIndex = 0; renderSlashMenu(); return; }
    const text = currentBlockText(block);
    // If the block doesn't already carry a trigger, arm one so IME text
    // sync and choose/close stripping stay consistent.
    if (slashTriggerFromText(text) == null && (text || "").trim() === "") {
      try {
        state.editor.updateBlock(block, { content: "/" });
        try { state.editor.setTextCursorPosition(block.id, "end"); } catch {}
      } catch {}
    }
    state.slashFilter = slashTriggerFromText(currentBlockText(getCurrentBlock())) ?? "";
    state.slashIndex = 0;
    renderSlashMenu();
  } catch (e) { console.warn("slash button failed", e); }
}

async function chooseSlash(command) {
  if (command.type === "page") {
    closeSlashMenu();
    if (state.dirty) await saveCurrent();
    await createPage(state.currentPageId);
    return;
  }
  if (command.type === "image") {
    // Images need a file or URL first — a bare type-switch would leave an
    // empty block. Strip the "/filter" trigger, then run the shared chooser
    // (same flow as the 📷 topbar button, desktop and mobile).
    closeSlashMenu();
    await openImageChooser();
    return;
  }
  if (command.type === "table") {
    // A table is not a plain type-swap: it needs tableContent, and an empty
    // string content would make BlockNote reject the node. Match the schema's
    // own default (3 columns x 2 rows) so it renders its add-row/column UI.
    const block = getCurrentBlock();
    if (!block) return closeSlashMenu();
    try {
      state.editor.updateBlock(block, {
        type: "table",
        props: {},
        content: {
          type: "tableContent",
          columnWidths: [],
          headerRows: 0,
          headerCols: 0,
          rows: [
            { cells: ["", "", ""] },
            { cells: ["", "", ""] }
          ]
        }
      });
      try { state.editor.focus(); } catch {}
    } catch (err) {
      console.warn("Could not insert table", err);
    }
    closeSlashMenu();
    return;
  }
  const block = getCurrentBlock();
  if (!block) return closeSlashMenu();
  try {
    state.editor.updateBlock(block, { type: command.type, props: command.props || {}, content: "" });
    state.editor.setTextCursorPosition(block.id, "start");
  } catch (err) {
    console.warn("Could not apply slash command", err);
  }
  closeSlashMenu();
}

// ---------- Images: one shared flow for slash, button, block menu ----------
// Desktop paste / drag-drop is handled natively by BlockNote via uploadFile.
// Mobile has no file-paste, so every entry point lands here: pick a file
// (system picker = camera roll on phones) or embed a link (GIFs included).
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function insertImageWithUrl(url, caption="") {
  try {
    if (!state.editor || !url) return false;
    const props = { url };
    if (caption) props.caption = caption;
    const ref = getCurrentBlock();
    // Convert an empty paragraph in place so "/image" leaves no residue.
    try {
      if (ref && isEmptyBlockText(currentBlockText(ref))) {
        state.editor.updateBlock(ref, { type: "image", props });
        try { state.editor.focus(); } catch {}
        return true;
      }
    } catch {}
    try {
      if (ref && typeof state.editor.insertBlocks === "function") {
        state.editor.insertBlocks([{ type: "image", props }], ref, "after");
        try { state.editor.focus(); } catch {}
        return true;
      }
    } catch {}
    try {
      if (typeof state.editor.insertBlocks === "function") {
        state.editor.insertBlocks([{ type: "image", props }]);
        return true;
      }
    } catch {}
  } catch (e) { console.warn("insert image failed", e); }
  return false;
}

function insertEmptyImageBlock() {
  // Fallback when no file picker is available: BlockNote's own file panel
  // (upload tab + URL tab) takes over from the empty image block.
  try {
    const ref = getCurrentBlock();
    if (ref && isEmptyBlockText(currentBlockText(ref))) {
      try { state.editor.updateBlock(ref, { type: "image", props: {} }); return; } catch {}
    }
    if (ref && typeof state.editor.insertBlocks === "function") {
      try { state.editor.insertBlocks([{ type: "image" }], ref, "after"); return; } catch {}
    }
    if (typeof state.editor.insertBlocks === "function") state.editor.insertBlocks([{ type: "image" }]);
  } catch {}
}

async function uploadImageFile(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith("image/")) {
    alertDialog({ title: "Not an image", message: "Please choose an image file (JPG, PNG, GIF or WebP)." });
    return;
  }
  if (file.size && file.size > IMAGE_MAX_BYTES) {
    alertDialog({ title: "File too large", message: "Images must be 10 MB or smaller." });
    return;
  }
  setSaveState("Uploading image...", false);
  try {
    const { url } = await window.api.uploadFile(file);
    insertImageWithUrl(url);
    setSaveState("Image added", false);
  } catch (e) {
    console.warn("image upload failed", e);
    alertDialog({ title: "Upload failed", message: (e && e.message) || "Could not upload the image. Please try again." });
    setSaveState("Upload failed", false);
  }
}

async function openImageChooser() {
  if (!state.editor) return;
  const pick = await showDialog({
    title: "Add image",
    message: "Upload from this device (camera roll on mobile) or embed a link — GIFs play inline.",
    actions: [
      { label: "Cancel", kind: "ghost", value: "cancel" },
      { label: "From link", kind: "ghost", value: "url" },
      { label: "Upload file", kind: "primary", value: "upload" },
    ],
  });
  if (pick === "upload") {
    const inp = document.getElementById("imageUploadInput");
    if (inp) { inp.value = ""; inp.click(); }
    else insertEmptyImageBlock();
  } else if (pick === "url") {
    const url = await promptImageUrl();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      alertDialog({ title: "Invalid link", message: "Image links must start with http:// or https://." });
      return;
    }
    insertImageWithUrl(url);
  }
}

function promptImageUrl() {
  // Themed URL input reusing the nl-dialog overlay (never native prompt).
  return new Promise((resolve) => {
    const overlay = document.getElementById("nlDialogOverlay");
    if (!overlay) { try { resolve(window.prompt("Image URL:") || null); } catch { resolve(null); } return; }
    if (_dialogResolve) { const r = _dialogResolve; _dialogResolve = null; try { r(false); } catch {} }
    document.getElementById("nlDialogTitle").textContent = "Embed image link";
    const msg = document.getElementById("nlDialogMessage");
    msg.textContent = "";
    const input = document.createElement("input");
    input.type = "url";
    input.placeholder = "https://… (.jpg, .png, .gif, .webp)";
    input.setAttribute("aria-label", "Image URL");
    input.autocomplete = "off";
    input.spellcheck = false;
    input.className = "nl-dialog-input";
    input.style.cssText = "width:100%;min-height:44px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:14px;";
    msg.appendChild(input);
    const box = document.getElementById("nlDialogActions");
    box.innerHTML = "";
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      const v = (val === true) ? (input.value || "").trim() : null;
      overlay.classList.remove("open");
      overlay.setAttribute("aria-hidden", "true");
      document.removeEventListener("keydown", _dialogEsc, true);
      overlay.onclick = null;
      _dialogResolve = null;
      resolve(v || null);
    };
    _dialogResolve = finish;
    [["Cancel", "ghost", false], ["Add image", "primary", true]].forEach(([label, kind, val]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nl-dialog-btn " + kind;
      btn.textContent = label;
      btn.addEventListener("click", () => finish(val));
      box.appendChild(btn);
    });
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", _dialogEsc, true);
    overlay.onclick = (e) => { if (e.target === overlay) finish(false); };
    setTimeout(() => { try { input.focus({ preventScroll: true }); } catch { try { input.focus(); } catch {} } }, 40);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
    });
  });
}

function isEmptyBlockText(txt) {
  return !((txt || "").trim());
}

function focusBlockById(blockId, place="end") {
  try {
    if (!blockId || !state.editor) return false;
    try { state.editor.setTextCursorPosition(blockId, place); } catch {}
    try { state.editor.focus(); } catch {}
    return true;
  } catch { return false; }
}

function findBlockById(blockId) {
  try {
    const docs = state.editor ? state.editor.document : null;
    if (Array.isArray(docs)) {
      const hit = docs.find(b => b && b.id === blockId);
      if (hit) return hit;
    }
  } catch {}
  return null;
}

function openInsertMenuAt(x, y) {
  try {
    if (!state.editor) return;
    state.slashFilter = "";
    state.slashIndex = 0;
    renderSlashMenu();
    if (isMobileLayout()) return;
    const menu = $("#slashMenu");
    if (!menu || typeof x !== "number" || typeof y !== "number") return;
    const GAP = 8;
    const MARGIN = 8;
    const vw = window.innerWidth || document.documentElement.clientWidth || 800;
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    const menuW = menu.offsetWidth || 320;
    const menuH = menu.offsetHeight || 300;
    let left = Math.max(MARGIN, Math.min(x, vw - menuW - MARGIN));
    if (vw - menuW - MARGIN < MARGIN) left = MARGIN;
    let top = y + GAP;
    if (top + menuH > vh - MARGIN) top = Math.max(MARGIN, y - menuH - GAP);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  } catch {}
}

// Right-click on an empty line opens the insert menu, on a filled block it
// opens the block options instead. Shared by mouse contextmenu + mobile
// long-press so both gestures behave the same.
function openBlockGestureAt(blockId, x, y) {
  try {
    if (blockId) {
      try {
        const cur = getCurrentBlock();
        if (!cur || cur.id !== blockId) focusBlockById(blockId, "end");
        else try { state.editor.focus(); } catch {}
      } catch {}
    }
    const target = (blockId && findBlockById(blockId)) || getCurrentBlock();
    if (isEmptyBlockText(currentBlockText(target))) {
      openInsertMenuAt(x, y);
    } else if (blockId) {
      showBlockMenu(blockId, x, y);
    } else {
      openInsertMenuAt(x, y);
    }
    return true;
  } catch { return false; }
}

function resolveBlockIdFromEventTarget(target) {
  try {
    const outer = target && target.closest ? target.closest(".bn-block-outer") : null;
    const id = outer && outer.dataset ? outer.dataset.id : null;
    if (id) return id;
  } catch {}
  try { return getCurrentBlock()?.id || null; } catch { return null; }
}

let _longPressTimer = null;
let _longPressFiredAt = 0;
let _longPressX = 0;
let _longPressY = 0;
let _suppressNextEditorClick = false;

function cancelLongPressTimer() {
  if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; }
}

function wireEditorInteractions() {
  if (editorWired) return;
  editorWired = true;
  const root = $("#editor");
  root.addEventListener("keydown", onEditorKeydown, true);
  root.addEventListener("keyup", onEditorKeyup, true);
  // Composition/input path: covers Gboard/Samsung/iOS where keydown is 229.
  root.addEventListener("input", () => { try { maybeSyncSlashFromText(); } catch {} }, true);
  root.addEventListener("compositionend", () => { try { maybeSyncSlashFromText(); } catch {} }, true);
  root.addEventListener("input", () => {
    const hint = document.querySelector(".hint");
    if (hint) hint.style.opacity = "0";
  }, { once: true });
  root.addEventListener("click", (e) => {
    if (_suppressNextEditorClick) { _suppressNextEditorClick = false; e.preventDefault(); e.stopPropagation(); return; }
    closeSlashMenu();
    const blockOuter = e.target.closest(".bn-block-outer");
    if (blockOuter && e.target === blockOuter || e.target.closest(".bn-block-handle")) {
      const blockId = blockOuter?.dataset?.id;
      if (blockId) showBlockMenu(blockId, e.clientX, e.clientY);
    }
  });
  // Desktop: right-click on a new (empty) line opens the insert menu.
  root.addEventListener("contextmenu", (e) => {
    try {
      if (!root.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      // Android fires contextmenu right after our long-press timer already
      // opened the menu: don't open it twice.
      if (Date.now() - _longPressFiredAt < 900) return;
      const blockId = resolveBlockIdFromEventTarget(e.target);
      openBlockGestureAt(blockId, e.clientX, e.clientY);
    } catch {}
  });
  // Mobile: long-press (~550ms, no move) on a new line opens the insert menu.
  root.addEventListener("touchstart", (e) => {
    try {
      if (!e.touches || e.touches.length !== 1) { cancelLongPressTimer(); return; }
      if ($("#slashMenu")?.classList.contains("open")) return;
      const t = e.touches[0];
      _longPressX = t.clientX;
      _longPressY = t.clientY;
      const target = e.target;
      cancelLongPressTimer();
      _longPressTimer = setTimeout(() => {
        _longPressTimer = null;
        try {
          const el = (document.elementFromPoint(_longPressX, _longPressY) || target);
          if (!el || !root.contains(el)) return;
          const blockId = resolveBlockIdFromEventTarget(el);
          _longPressFiredAt = Date.now();
          _suppressNextEditorClick = true;
          setTimeout(() => { _suppressNextEditorClick = false; }, 600);
          try { if (navigator.vibrate) navigator.vibrate(12); } catch {}
          openBlockGestureAt(blockId, _longPressX, _longPressY);
        } catch {}
      }, 550);
    } catch {}
  }, { passive: true });
  root.addEventListener("touchmove", (e) => {
    try {
      if (!_longPressTimer) return;
      const t = e.touches && e.touches[0];
      if (!t) { cancelLongPressTimer(); return; }
      if (Math.hypot(t.clientX - _longPressX, t.clientY - _longPressY) > 12) cancelLongPressTimer();
    } catch {}
  }, { passive: true });
  const _cancelTouch = () => { cancelLongPressTimer(); };
  root.addEventListener("touchend", _cancelTouch, { passive: true });
  root.addEventListener("touchcancel", _cancelTouch, { passive: true });

  document.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        showFormatToolbar();
      }
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    const blockMenu = $("#blockMenu");
    const formatToolbar = $("#formatToolbar");
    if (!blockMenu.contains(e.target)) {
      blockMenu.classList.remove("open");
    }
    if (!formatToolbar.contains(e.target)) {
      formatToolbar.classList.remove("open");
    }
  });
}

const BLOCK_TYPES = [
  { label: "Text", icon: "T", type: "paragraph" },
  { label: "Heading 1", icon: "H1", type: "heading", props: { level: 1 } },
  { label: "Heading 2", icon: "H2", type: "heading", props: { level: 2 } },
  { label: "Heading 3", icon: "H3", type: "heading", props: { level: 3 } },
  { label: "Bullet List", icon: "•", type: "bulletListItem" },
  { label: "Numbered List", icon: "1.", type: "numberedListItem" },
  { label: "To-do", icon: "☐", type: "checkListItem" },
  { label: "Quote", icon: '"', type: "quote" },
  { label: "Code", icon: "</>", type: "codeBlock" },
];

function showBlockMenu(blockId, x, y) {
  const menu = $("#blockMenu");
  menu.innerHTML = "";

  BLOCK_TYPES.forEach(bt => {
    const item = document.createElement("button");
    item.className = "block-menu-item";
    item.innerHTML = `<span class="block-menu-icon">${bt.icon}</span>${bt.label}`;
    item.addEventListener("click", () => {
      try {
        state.editor.updateBlock(blockId, { type: bt.type, props: bt.props || {} });
      } catch (e) { console.warn(e); }
      menu.classList.remove("open");
    });
    menu.appendChild(item);
  });

  menu.appendChild(createBlockMenuDivider());

  const imageBtn = document.createElement("button");
  imageBtn.className = "block-menu-item";
  imageBtn.innerHTML = `<span class="block-menu-icon">🖼</span>Insert image below`;
  imageBtn.addEventListener("click", () => {
    menu.classList.remove("open");
    try { focusBlockById(blockId, "end"); } catch {}
    setTimeout(() => { try { openImageChooser(); } catch (e) { console.warn(e); } }, 30);
  });
  menu.appendChild(imageBtn);

  menu.appendChild(createBlockMenuDivider());

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "block-menu-item danger";
  deleteBtn.innerHTML = "Delete block";
  deleteBtn.addEventListener("click", () => {
    try {
      state.editor.removeBlock(blockId);
    } catch (e) { console.warn(e); }
    menu.classList.remove("open");
  });
  menu.appendChild(deleteBtn);

  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - 350);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  menu.classList.add("open");
}

function createBlockMenuDivider() {
  const div = document.createElement("div");
  div.className = "block-menu-divider";
  return div;
}

function bnToggleStyles(styles) {
  const ed = state.editor;
  try {
    if (ed && typeof ed.toggleStyles === "function") {
      ed.toggleStyles(styles);
      try { ed.focus(); } catch {}
      return true;
    }
  } catch (e) { console.warn("toggleStyles failed", e); }
  return false;
}

function getActiveBnStyles() {
  try {
    if (state.editor && typeof state.editor.getActiveStyles === "function") {
      return state.editor.getActiveStyles() || {};
    }
  } catch {}
  return {};
}

function toggleBasicStyle(styleKey, execCmd) {
  if (bnToggleStyles({ [styleKey]: true })) return;
  try { document.execCommand(execCmd); } catch {}
}

function applyHighlight(colorName) {
  // colorName: BlockNote backgroundColor name, or null/"default" to clear.
  if (!colorName || colorName === "default") {
    try {
      const active = getActiveBnStyles();
      if (state.editor && typeof state.editor.removeStyles === "function" && active.backgroundColor) {
        state.editor.removeStyles({ backgroundColor: active.backgroundColor });
        try { state.editor.focus(); } catch {}
        return;
      }
    } catch {}
    if (bnToggleStyles({ backgroundColor: "default" })) return;
    try { document.execCommand("hiliteColor", false, "transparent"); } catch {}
    try { document.execCommand("backColor", false, "transparent"); } catch {}
    return;
  }
  if (bnToggleStyles({ backgroundColor: colorName })) return;
  try { document.execCommand("hiliteColor", false, colorName); } catch {}
  try { document.execCommand("backColor", false, colorName); } catch {}
}

const FORMAT_BUTTONS = [
  { label: "B", title: "Bold", shortcut: "Ctrl+B", style: "bold", execCmd: "bold", styleLabel: "bold" },
  { label: "I", title: "Italic", shortcut: "Ctrl+I", style: "italic", execCmd: "italic", styleLabel: "italic" },
  { label: "U", title: "Underline", shortcut: "Ctrl+U", style: "underline", execCmd: "underline", styleLabel: "underline" },
  { label: "S", title: "Strikethrough", shortcut: "Ctrl+Shift+S", style: "strike", execCmd: "strikeThrough", styleLabel: "line-through" },
];

// BlockNote default backgroundColor names. `css` is only the swatch preview;
// the editor itself resolves the name to its themed highlight color.
const HIGHLIGHT_COLORS = [
  { name: "yellow", title: "Yellow highlight", css: "#fef08a" },
  { name: "green", title: "Green highlight", css: "#bbf7d0" },
  { name: "blue", title: "Blue highlight", css: "#bfdbfe" },
  { name: "pink", title: "Pink highlight", css: "#fecdd3" },
  { name: "orange", title: "Orange highlight", css: "#fed7aa" },
];
const HIGHLIGHT_DEFAULT = "yellow";

function refreshFormatToolbarActive() {
  const toolbar = $("#formatToolbar");
  if (!toolbar || !toolbar.classList.contains("open")) return;
  const active = getActiveBnStyles();
  toolbar.querySelectorAll(".format-btn[data-style]").forEach((btn) => {
    const key = btn.getAttribute("data-style");
    btn.classList.toggle("active", Boolean(key && active[key]));
  });
  toolbar.querySelectorAll(".hl-swatch[data-color]").forEach((sw) => {
    sw.classList.toggle("active", active.backgroundColor === sw.getAttribute("data-color"));
  });
  const clearBtn = toolbar.querySelector(".hl-clear");
  if (clearBtn) clearBtn.classList.toggle("active", !active.backgroundColor);
}

function showFormatToolbar() {
  const toolbar = $("#formatToolbar");
  toolbar.innerHTML = "";

  FORMAT_BUTTONS.forEach((btn, i) => {
    const button = document.createElement("button");
    button.className = "format-btn";
    button.dataset.style = btn.style;
    button.textContent = btn.label;
    if (btn.styleLabel) button.style.fontWeight = btn.style === "bold" ? "700" : "500";
    if (btn.style === "italic") button.style.fontStyle = "italic";
    if (btn.style === "underline") button.style.textDecoration = "underline";
    if (btn.style === "strike") button.style.textDecoration = "line-through";
    button.title = `${btn.title} (${btn.shortcut})`;
    button.setAttribute("aria-label", `${btn.title} (${btn.shortcut})`);
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    button.addEventListener("click", () => {
      toggleBasicStyle(btn.style, btn.execCmd);
      setTimeout(refreshFormatToolbarActive, 0);
    });
    toolbar.appendChild(button);

    if (i === 3) {
      const divider = document.createElement("div");
      divider.className = "format-divider";
      toolbar.appendChild(divider);
    }
  });

  // Highlight swatches live in the same toolbar, right after B/I/U/S.
  const activeStyles = getActiveBnStyles();
  HIGHLIGHT_COLORS.forEach((hl) => {
    const sw = document.createElement("button");
    sw.className = "hl-swatch" + (activeStyles.backgroundColor === hl.name ? " active" : "");
    sw.dataset.color = hl.name;
    sw.title = `${hl.title} (Ctrl+H for yellow)`;
    sw.setAttribute("aria-label", hl.title);
    sw.style.setProperty("--hl", hl.css);
    sw.innerHTML = `<span class="hl-dot" aria-hidden="true"></span>`;
    sw.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    sw.addEventListener("click", () => {
      applyHighlight(hl.name);
      setTimeout(refreshFormatToolbarActive, 0);
    });
    toolbar.appendChild(sw);
  });

  const clearBtn = document.createElement("button");
  clearBtn.className = "format-btn hl-clear" + (!activeStyles.backgroundColor ? " active" : "");
  clearBtn.textContent = "∅";
  clearBtn.title = "Remove highlight";
  clearBtn.setAttribute("aria-label", "Remove highlight");
  clearBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });
  clearBtn.addEventListener("click", () => {
    applyHighlight(null);
    setTimeout(refreshFormatToolbarActive, 0);
  });
  toolbar.appendChild(clearBtn);

  // Mark B/I/U/S active state on open.
  refreshFormatToolbarActive();

  // Touch layouts dock the toolbar above the keyboard (see CSS bottom
  // sheet). Caret-anchored math goes stale under the keyboard and painted
  // the old "thick bar at the screen bottom".
  if (isMobileLayout() || isCoarsePointer()) {
    toolbar.style.left = "";
    toolbar.style.top = "";
    toolbar.style.bottom = "";
    toolbar.classList.add("open");
    refreshFormatToolbarActive();
    return;
  }

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  // position:fixed is viewport-relative — never add window.scrollY (the old
  // code did, pushing the bar far down inside our internal .workspace
  // scroller). Clamp against the visual viewport so the keyboard can't
  // strand it off-screen.
  const vw = (window.visualViewport && window.visualViewport.width) || window.innerWidth;
  const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  const menuW = Math.min(360, vw - 16);
  const left = Math.max(8, Math.min(rect.left + (rect.width / 2) - menuW / 2, vw - menuW - 8));
  let top = rect.top - 48;
  if (top < 8) top = Math.min(rect.bottom + 8, Math.max(8, vh - 60));

  toolbar.style.left = left + "px";
  toolbar.style.top = top + "px";
  toolbar.classList.add("open");
}

function onEditorKeydown(e) {
  if (!state.editor) return;

  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    const pg = state.pages.get(state.currentPageId);
    if (!pg || !pg.dirty) {
      setSaveState("Nothing to save", false);
      return;
    }
    saveCurrent();
    return;
  }

  if ((e.ctrlKey || e.metaKey) && (e.key === "h" || e.key === "H")) {
    e.preventDefault();
    applyHighlight(HIGHLIGHT_DEFAULT);
    setTimeout(refreshFormatToolbarActive, 0);
    return;
  }

  const block = getCurrentBlock();
  const text = currentBlockText(block);
  const menuOpen = $("#slashMenu").classList.contains("open");

  if (menuOpen) {
    if (e.key === "ArrowDown") { e.preventDefault(); state.slashIndex++; renderSlashMenu(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); state.slashIndex--; renderSlashMenu(); return; }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const cmds = filteredCommands();
      if (!cmds.length) { closeSlashMenu(); return; }
      const cmd = cmds[state.slashIndex];
      if (cmd) chooseSlash(cmd);
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); closeSlashMenu(); return; }
    if (e.key === "Backspace") {
      const next = text.length ? text.slice(0, -1) : "";
      state.slashFilter = next;
      state.slashIndex = 0;
      setTimeout(() => renderSlashMenu(), 0);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      state.slashFilter += e.key;
      state.slashIndex = 0;
      setTimeout(() => renderSlashMenu(), 0);
      return;
    }
  }

  if (e.key === "/") {
    const isStart = text.trim() === "" || text.trim() === "/";
    if (isStart) {
      e.preventDefault();
      state.slashFilter = "";
      state.slashIndex = 0;
      setTimeout(renderSlashMenu, 0);
    }
  }

  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) {
      if (state.editor.canUnnestBlock()) state.editor.unnestBlock();
    } else {
      if (state.editor.canNestBlock()) state.editor.nestBlock();
    }
  }

  if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const atEnd = block && text.length > 0 &&
      (sel?.anchorOffset === text.length || sel?.anchorNode?.textContent?.length === sel?.anchorOffset);
    if (atEnd) {
      setTimeout(() => {
        const newBlock = state.editor.insertBlock({ type: "paragraph", content: "" });
        if (newBlock) {
          state.editor.setTextCursorPosition(newBlock.id, "start");
        }
      }, 0);
    }
  }
}

function onEditorKeyup() {
  if (!$("#slashMenu").classList.contains("open")) return;
  const block = getCurrentBlock();
  const text = currentBlockText(block);
  const next = text || "";
  if (next !== state.slashFilter) {
    state.slashFilter = next;
    state.slashIndex = 0;
    renderSlashMenu();
  } else {
    positionSlashMenu();
  }
}

function upsertPageMeta(row, { fromServer=false }={}) {
  const id = row.id;
  if (!id) return;
  const existing = state.pages.get(id);
  if (!existing) {
    state.pages.set(id, {
      id,
      title: row.title || "Untitled",
      blocks: null,
      parentId: row.parent_id || row.parentId || ROOT,
      emoji: row.emoji || "",
      updatedAt: row.updated_at ? row.updated_at * 1000 : Date.now(),
      rev: row.rev ?? 1,
      baseRev: fromServer ? (row.rev ?? 1) : (row.baseRev ?? null),
      baseUpdatedAt: fromServer ? (row.updated_at ?? null) : (row.baseUpdatedAt ?? null),
      baseTitle: fromServer ? (row.title || "Untitled") : (row.baseTitle ?? row.title),
      baseHash: fromServer ? (existing?.baseHash ?? null) : (row.baseHash ?? null),
      lastSyncedHash: null,
      dirty: fromServer ? false : !!row.dirty,
      verified: false,
      locked: false,
      epoch: 0, mountEpoch: 0, retryCount: 0,       conflictServer: null,
      isPublic: Boolean(row.is_public ?? row.isPublic),
      _localOnly: fromServer ? false : !!row._localOnly,
      // Cross-device recents stamp (server seconds). Local drafts carry it
      // under the same camelCase key.
      lastOpenedAt: row.last_opened_at ?? row.lastOpenedAt ?? null,
      // Server-meta rows carry titles only; real blocks arrive via verify
      // fetch or drafts. false = never push this page until content loads.
      contentLoaded: fromServer ? false : !!row.blocks,
    });
    return;
  }
  if (fromServer) {
    // Cross-device recents: the server stamp is shared truth, so it wins
    // even on dirty pages (it never conflicts with content). This runs
    // before the dirty early-return below on purpose.
    if (row.last_opened_at != null) existing.lastOpenedAt = row.last_opened_at;
    // Merge, never clobber: dirty pages and local-only pages keep local truth.
    if (existing.dirty || existing._localOnly) {
      existing.rev = existing.rev ?? row.rev ?? 1;
      existing.isPublic = existing.isPublic;
      return;
    }
    existing.title = row.title || existing.title;
    existing.parentId = row.parent_id || existing.parentId;
    existing.isPublic = Boolean(row.is_public ?? existing.isPublic);
    existing.rev = row.rev ?? existing.rev ?? 1;
    existing.baseRev = existing.rev;
    existing.baseUpdatedAt = row.updated_at ?? existing.baseUpdatedAt;
    existing.baseTitle = existing.title;
    existing.updatedAt = row.updated_at ? row.updated_at * 1000 : existing.updatedAt;
    return;
  }
  // Local cache/draft source.
  existing.title = row.title || existing.title;
  if (row.blocks) existing.blocks = row.blocks;
  if (row.parentId || row.parent_id) existing.parentId = row.parentId || row.parent_id;
  if (row.emoji) existing.emoji = row.emoji;
  if (row.dirty) existing.dirty = true;
  if (row.baseRev != null) existing.baseRev = row.baseRev;
  if (row.baseUpdatedAt != null) existing.baseUpdatedAt = row.baseUpdatedAt;
  if (row.baseTitle != null) existing.baseTitle = row.baseTitle;
  if (row.baseHash != null) existing.baseHash = row.baseHash;
  if (row.rev != null) existing.rev = row.rev;
  if (row.isPublic != null) existing.isPublic = Boolean(row.is_public ?? row.isPublic);
  if (row._localOnly) existing._localOnly = true;
  if (row.lastOpenedAt != null) existing.lastOpenedAt = row.lastOpenedAt;
  if (row.last_opened_at != null) existing.lastOpenedAt = row.last_opened_at;
}

async function initialize() {
  // Content width first: instant local apply, IndexedDB value follows.
  try { initDocWidth(); } catch {}
  // 1. Local drafts first: crash-safe truth, zero server cost.
  // Guarded with a timeout so a blocked IndexedDB upgrade (another open tab
  // holding the old version) can never hang boot with an empty sidebar.
  try {
    const drafts = await idbOrFallback(
      window.notifications.getAllDrafts().catch(() => []), 4000, []);
    const me = currentUsername();
    for (const d of drafts || []) {
      // Skip drafts owned by a different account on this browser. Ownerless
      // drafts predate per-user stamping; load them and let the server-list
      // reconciliation below evict anything that isn't actually ours.
      if (me && d.owner && d.owner !== me) continue;
      state.pages.set(d.id, {
        id: d.id,
        title: d.title || "Untitled",
        blocks: d.blocks || null,
        parentId: d.parentId || ROOT,
        emoji: d.emoji || "",
        updatedAt: d.updatedAt || Date.now(),
        rev: d.rev ?? 1,
        baseRev: d.baseRev ?? null,
        baseUpdatedAt: d.baseUpdatedAt ?? null,
        baseTitle: d.baseTitle ?? d.title,
        baseHash: d.baseHash ?? (d.blocks ? hashContent(d.blocks) : null),
        lastSyncedHash: null,
        dirty: !!d.dirty,
        verified: false,
        locked: false,
        epoch: 0, mountEpoch: 0, retryCount: 0, conflictServer: null,
        isPublic: Boolean(d.isPublic),
        _localOnly: (d.baseRev == null && !!d.dirty),
        contentLoaded: !!(d.blocks),
        lastOpenedAt: d.lastOpenedAt ?? null,
      });
    }
    if (drafts && drafts.length) renderTree();
  } catch (e) { console.warn("Draft load failed:", e); }

  let cachedMeta = null;
  // Same blocked-IDB guard as drafts: every IndexedDB await on the boot path
  // must time out, otherwise one wedged connection hangs the whole workspace.
  // The meta cache is per-account; legacy unscoped entries are ignored and
  // neutralized so a previous account's sidebar can never leak in.
  try { cachedMeta = await idbOrFallback(window.notifications.getState(scopedKey("pageListMeta")).catch(() => null), 4000, null); } catch {}
  try { await idbOrFallback(window.notifications.saveState("pageListMeta", null).catch(() => {}), 2000, null); } catch {}
  try { await idbOrFallback(window.notifications.saveState("lastPageId", null).catch(() => {}), 2000, null); } catch {}

  if (cachedMeta && Array.isArray(cachedMeta)) {
    for (const p of cachedMeta) {
      if (state.pages.has(p.id)) {
        const ex = state.pages.get(p.id);
        if (!ex.dirty && !ex.blocks) {
          ex.title = p.title || ex.title;
          ex.parentId = p.parent_id || ex.parentId;
          ex.isPublic = Boolean(p.is_public ?? ex.isPublic);
          if (p.rev != null) ex.rev = p.rev;
        }
        continue;
      }
      upsertPageMeta(p, { fromServer: false });
    }
    renderTree();
  }

  try {
    const rows = await window.api.listPagesMeta();
    for (const p of rows || []) upsertPageMeta(p, { fromServer: true });
    // Drop deleted-on-server stubs that are clean (keep dirty/local-only).
    // No baseRev requirement: title-only cached stubs from another account
    // carry no base tracking and must be evicted too, otherwise they pin
    // state.pages non-empty, block demo seeding, and 404 on every open.
    const serverIds = new Set((rows || []).map(r => r.id));
    for (const [id, pg] of [...state.pages]) {
      if (id === ROOT) continue;
      if (!serverIds.has(id) && !pg.dirty && !pg._localOnly) {
        state.pages.delete(id);
        // Fire-and-forget: must never stall boot on a wedged IndexedDB.
        try { window.notifications.deleteDraft(id).catch(() => {}); } catch {}
      }
    }
    try { await idbOrFallback(window.notifications.saveState(scopedKey("pageListMeta"), rows).catch(() => {}), 4000, null); } catch {}
    state.metaReady = true;
    refreshGlobalDirty();
    renderTree();
    if ([...state.pages.values()].some(p => p.dirty)) scheduleFlush(4000);
  } catch (err) {
    console.error("Failed to load pages:", err);
    state.metaReady = true;
  }

  if (!state.pages.size) {
    const welcome = makePage({ id: "welcome", title: "👋 Welcome to NotionLess", emoji: "", parentId: ROOT, blocks: [
      { type: "paragraph", content: "This is your personal cloud workspace. Everything you create here is automatically saved and accessible from any device." },
      { type: "heading", props: { level: 2 }, content: "What you can do here" },
      { type: "bulletListItem", content: "Create rich notes with headings, lists, tables, and more" },
      { type: "bulletListItem", content: "Organize pages into nested hierarchies" },
      { type: "bulletListItem", content: "Toggle content as public to share with anyone" },
      { type: "bulletListItem", content: "Copy public pages from other users to your workspace" },
      { type: "heading", props: { level: 2 }, content: "Explore the sidebar" },
      { type: "paragraph", content: "Use the sidebar to navigate between pages. Click + to create new top-level pages, or use the ••• menu on any page to create subpages." },
      { type: "heading", props: { level: 2 }, content: "Getting Started" },
      { type: "paragraph", content: "Start with the tutorials below to learn the basics. Each section demonstrates a key feature!" }
    ]});

    const gettingStarted = makePage({ id: "getting-started", title: "🚀 Getting Started", emoji: "", parentId: welcome.id, blocks: [
      { type: "paragraph", content: "New here? Start with these essentials." },
      { type: "heading", props: { level: 2 }, content: "Your Learning Path" },
      { type: "numberedListItem", content: "Start with First Steps to learn the editor basics" },
      { type: "numberedListItem", content: "Try Writing & Formatting to explore text styles" },
      { type: "numberedListItem", content: "Learn Organization to structure your pages" },
      { type: "numberedListItem", content: "Explore Sharing to collaborate with others" },
      { type: "heading", props: { level: 2 }, content: "Quick Tips" },
      { type: "bulletListItem", content: "Press / in the editor to open the block command menu" },
      { type: "bulletListItem", content: "Use Tab / Shift+Tab to nest or unnest blocks" },
      { type: "bulletListItem", content: "Press Ctrl+S to save, or just keep typing — auto-save has you covered" },
      { type: "bulletListItem", content: "Click Private in the toolbar to share a page publicly" }
    ]});

    const firstSteps = makePage({ id: "first-steps", title: "✨ First Steps", emoji: "", parentId: gettingStarted.id, blocks: [
      { type: "heading", props: { level: 1 }, content: "First Steps" },
      { type: "paragraph", content: "Let's start with the basics. Click anywhere in this block and start typing to replace the text. Try it!" },
      { type: "heading", props: { level: 2 }, content: "Creating Content" },
      { type: "paragraph", content: "Click below this paragraph and press Enter to create a new block. Then start typing any of these:" },
      { type: "bulletListItem", content: "Type # for headings" },
      { type: "bulletListItem", content: "Type - for bullet lists" },
      { type: "bulletListItem", content: "Type [] for checklists" },
      { type: "bulletListItem", content: "Type / to open the full command menu" },
      { type: "heading", props: { level: 2 }, content: "Try It Now" },
      { type: "paragraph", content: "Click below and type: # My Heading" },
      { type: "paragraph", content: "" },
      { type: "paragraph", content: "Now delete this and try: - My bullet point" }
    ]});

    const keyboardShortcuts = makePage({ id: "keyboard-shortcuts", title: "⌨️ Keyboard Shortcuts", emoji: "", parentId: gettingStarted.id, blocks: [
      { type: "heading", props: { level: 1 }, content: "Keyboard Shortcuts" },
      { type: "paragraph", content: "Work faster with these keyboard shortcuts:" },
      { type: "heading", props: { level: 2 }, content: "Navigation" },
      { type: "bulletListItem", content: "Alt + PageUp / PageDown — Navigate through your pages" },
      { type: "bulletListItem", content: "Alt + Insert — Create a new subpage under the current page" },
      { type: "bulletListItem", content: "Alt + + — Expand all pages in the sidebar" },
      { type: "bulletListItem", content: "Alt + - — Collapse all pages in the sidebar" },
      { type: "heading", props: { level: 2 }, content: "Editing" },
      { type: "bulletListItem", content: "Ctrl + S — Save current page" },
      { type: "bulletListItem", content: "Ctrl + Z — Undo" },
      { type: "bulletListItem", content: "Ctrl + Shift + Z — Redo" },
      { type: "bulletListItem", content: "Tab — Nest block (indent)" },
      { type: "bulletListItem", content: "Shift + Tab — Unnest block (outdent)" },
      { type: "heading", props: { level: 2 }, content: "Slash Commands" },
      { type: "paragraph", content: "Type / in the editor to open the block menu. Start typing to filter." }
    ]});

    const writingFormatting = makePage({ id: "writing-formatting", title: "📝 Writing & Formatting", emoji: "", parentId: welcome.id, blocks: [
      { type: "paragraph", content: "NotionLess supports rich text formatting to make your notes expressive and organized." },
      { type: "heading", props: { level: 2 }, content: "What's Inside" },
      { type: "bulletListItem", content: "Headings & Text — Structure your writing" },
      { type: "bulletListItem", content: "Lists — Bullet, numbered, and checklists" },
      { type: "bulletListItem", content: "Tables — Organize data in rows and columns" },
      { type: "bulletListItem", content: "Code Blocks — Share code snippets" },
      { type: "bulletListItem", content: "Quotes — Highlight important text" }
    ]});

    const headingsText = makePage({ id: "headings-text", title: "📄 Headings & Text", emoji: "", parentId: writingFormatting.id, blocks: [
      { type: "heading", props: { level: 1 }, content: "Heading 1 — Page Title" },
      { type: "heading", props: { level: 2 }, content: "Heading 2 — Section Header" },
      { type: "heading", props: { level: 3 }, content: "Heading 3 — Subsection" },
      { type: "paragraph", content: "This is a regular paragraph. Use them for body text to keep your content readable and well-paced." },
      { type: "heading", props: { level: 2 }, content: "How to Create Headings" },
      { type: "paragraph", content: "Type the command menu with / and select a heading, or use markdown-style shortcuts:" },
      { type: "bulletListItem", content: "# followed by space = Heading 1" },
      { type: "bulletListItem", content: "## followed by space = Heading 2" },
      { type: "bulletListItem", content: "### followed by space = Heading 3" },
      { type: "paragraph", content: "Try it! Create a new block and type ### to start a heading 3." }
    ]});

    const listsCheckboxes = makePage({ id: "lists-checkboxes", title: "☑️ Lists & Checkboxes", emoji: "", parentId: writingFormatting.id, blocks: [
      { type: "heading", props: { level: 1 }, content: "Lists & Checkboxes" },
      { type: "heading", props: { level: 2 }, content: "Bullet Lists" },
      { type: "paragraph", content: "Use bullet lists for unordered items:" },
      { type: "bulletListItem", content: "Meeting notes" },
      { type: "bulletListItem", content: "Brainstorming ideas" },
      { type: "bulletListItem", content: "Random thoughts" },
      { type: "heading", props: { level: 2 }, content: "Numbered Lists" },
      { type: "paragraph", content: "Use numbered lists for sequences:" },
      { type: "numberedListItem", content: "First, do this" },
      { type: "numberedListItem", content: "Then, do that" },
      { type: "numberedListItem", content: "Finally, celebrate!" },
      { type: "heading", props: { level: 2 }, content: "Checklists (Task Lists)" },
      { type: "paragraph", content: "Track todos with checkboxes. Type [] to create one:" },
      { type: "checkListItem", content: "Learn NotionLess basics", props: { checked: true } },
      { type: "checkListItem", content: "Create my first page", props: { checked: true } },
      { type: "checkListItem", content: "Try tables", props: { checked: false } },
      { type: "checkListItem", content: "Share a page publicly", props: { checked: false } }
    ]});

    const tablesDemo = makePage({ id: "tables-demo", title: "📊 Tables", emoji: "", parentId: writingFormatting.id, blocks: [
      { type: "heading", props: { level: 1 }, content: "Tables" },
      { type: "paragraph", content: "Organize information in rows and columns. Tables are perfect for tracking data, comparing options, or structuring structured content." },
      { type: "heading", props: { level: 2 }, content: "Example: Project Tracker" },
      { type: "table", content: {
        type: "tableContent",
        rows: [
          { cells: ["Task", "Status", "Priority"] },
          { cells: ["Design homepage", "Done", "High"] },
          { cells: ["Write docs", "In Progress", "Medium"] },
          { cells: ["Bug fixes", "To Do", "Low"] }
        ]
      }},
      { type: "heading", props: { level: 2 }, content: "How to Create Tables" },
      { type: "paragraph", content: "Type /table in the editor, or use the slash command menu to insert a table. Click + to add columns, and use the menu to add or remove rows." }
    ]});

    const codeBlocksDemo = makePage({ id: "code-blocks", title: "💻 Code Blocks", emoji: "", parentId: writingFormatting.id, blocks: [
      { type: "heading", props: { level: 1 }, content: "Code Blocks" },
      { type: "paragraph", content: "Share code snippets with syntax highlighting. Perfect for documentation, tutorials, or keeping code snippets handy." },
      { type: "heading", props: { level: 2 }, content: "Example: JavaScript" },
      { type: "codeBlock", props: { language: "javascript" }, content: "function greet(name) {\n  return `Hello, ${name}!`;\n}\n\ngreet('World');" },
      { type: "heading", props: { level: 2 }, content: "Example: Python" },
      { type: "codeBlock", props: { language: "python" }, content: "def fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n\nfor i in range(10):\n    print(fibonacci(i))" },
      { type: "heading", props: { level: 2 }, content: "Example: CSS" },
      { type: "codeBlock", props: { language: "css" }, content: ".button {\n  background: #d85b45;\n  color: white;\n  padding: 0.75rem 1.5rem;\n  border-radius: 8px;\n  cursor: pointer;\n}" },
      { type: "paragraph", content: "Type /code to insert a code block, then select the language from the block menu." }
    ]});

    const quotesCallouts = makePage({ id: "quotes-callouts", title: "💬 Quotes & Callouts", emoji: "", parentId: writingFormatting.id, blocks: [
      { type: "heading", props: { level: 1 }, content: "Quotes & Callouts" },
      { type: "paragraph", content: "Use quotes to highlight important passages or memorable quotes from others." },
      { type: "heading", props: { level: 2 }, content: "A Famous Quote" },
      { type: "quote", content: "The only way to do great work is to love what you do. — Steve Jobs" },
      { type: "heading", props: { level: 2 }, content: "Callouts" },
      { type: "paragraph", content: "Callouts are great for tips, warnings, or important notes that deserve attention." },
      { type: "paragraph", content: "💡 Tip: Use the slash command /quote to add blockquotes to your pages." }
    ]});

    const organization = makePage({ id: "organization", title: "🗂️ Organization", emoji: "", parentId: welcome.id, blocks: [
      { type: "paragraph", content: "Structure your workspace to fit how you think." },
      { type: "heading", props: { level: 2 }, content: "Page Hierarchy" },
      { type: "paragraph", content: "Create nested pages to organize related content. This page you're reading is nested under a parent called Organization, which is nested under the root." },
      { type: "heading", props: { level: 2 }, content: "What's Inside" },
      { type: "bulletListItem", content: "Nested Pages — See the structure in action" },
      { type: "bulletListItem", content: "Links & References — Connect pages together" },
      { type: "bulletListItem", content: "Your Space — Start building your own" }
    ]});

    const nestedPagesDemo = makePage({ id: "nested-pages-demo", title: "📁 Nested Pages", emoji: "", parentId: organization.id, blocks: [
      { type: "heading", props: { level: 1 }, content: "Nested Pages" },
      { type: "paragraph", content: "This page is nested inside the Organization section. Notice the indentation in the sidebar." },
      { type: "heading", props: { level: 2 }, content: "Why Nest Pages?" },
      { type: "bulletListItem", content: "Group related content together" },
      { type: "bulletListItem", content: "Create a natural hierarchy (like folders)" },
      { type: "bulletListItem", content: "Keep the sidebar manageable" },
      { type: "heading", props: { level: 2 }, content: "How to Create Subpages" },
      { type: "numberedListItem", content: "Hover over a page in the sidebar" },
      { type: "numberedListItem", content: "Click the ••• menu that appears" },
      { type: "numberedListItem", content: "Select New sub-page" },
      { type: "numberedListItem", content: "Or press Alt + Insert while viewing a page" },
      { type: "paragraph", content: "↓ This page you're reading is a subpage. Look in the sidebar to see the hierarchy!" }
    ]});

    const yourSpace = makePage({ id: "your-space", title: "🏠 Your Space", emoji: "", parentId: organization.id, blocks: [
      { type: "heading", props: { level: 1 }, content: "Your Space" },
      { type: "paragraph", content: "Ready to make it yours? Delete these tutorial pages and start creating!" },
      { type: "heading", props: { level: 2 }, content: "Ideas for Your Workspace" },
      { type: "bulletListItem", content: "📚 Personal knowledge base" },
      { type: "bulletListItem", content: "📋 Project management" },
      { type: "bulletListItem", content: "📝 Meeting notes" },
      { type: "bulletListItem", content: "🎯 Goals & OKRs" },
      { type: "bulletListItem", content: "📖 Writing & drafts" },
      { type: "bulletListItem", content: "🔖 Bookmarks & resources" },
      { type: "heading", props: { level: 2 }, content: "Getting Started Tips" },
      { type: "paragraph", content: "Don't overthink structure at first. Start with a few pages and let the organization evolve naturally." },
      { type: "paragraph", content: "You can always reorganize later — your content travels with you." }
    ]});

    const sharing = makePage({ id: "sharing", title: "🌐 Sharing", emoji: "", parentId: welcome.id, blocks: [
      { type: "heading", props: { level: 1 }, content: "Sharing & Collaboration" },
      { type: "paragraph", content: "NotionLess makes it easy to share your knowledge with the world, or copy useful pages from others." },
      { type: "heading", props: { level: 2 }, content: "Making Pages Public" },
      { type: "bulletListItem", content: "Click Private in the top toolbar to make the open page public" },
      { type: "bulletListItem", content: "The page becomes visible to anyone with the link" },
      { type: "bulletListItem", content: "Making a page public also makes all its subpages public" },
      { type: "bulletListItem", content: "Making a subpage public does NOT make its parent public" },
      { type: "heading", props: { level: 2 }, content: "Visiting Public Pages" },
      { type: "paragraph", content: "Anyone can view public pages at /p/username/page-id (shown when viewing a public page). No login required!" },
      { type: "heading", props: { level: 2 }, content: "Copying Pages" },
      { type: "bulletListItem", content: "Found a useful public page?" },
      { type: "bulletListItem", content: "Click Copy to my space on any public page" },
      { type: "bulletListItem", content: "The page (and its subpages) are copied to your workspace" },
      { type: "bulletListItem", content: "Original authors are credited in the page metadata" },
      { type: "paragraph", content: "This is how knowledge spreads — share your notes, learn from others!" }
    ]});

    const allPages = [welcome, gettingStarted, firstSteps, keyboardShortcuts, writingFormatting, headingsText, listsCheckboxes, tablesDemo, codeBlocksDemo, quotesCallouts, organization, nestedPagesDemo, yourSpace, sharing];

    for (const p of allPages) {
      p.baseTitle = p.title;
      p.baseHash = hashContent(p.blocks);
      p.baseRev = 1;
      state.pages.set(p.id, p);
      writeDraft(p);
    }

    try {
      for (const p of allPages) {
        const res = await window.api.createPage({
          id: p.id,
          title: p.title,
          content: JSON.stringify(p.blocks),
          parent_id: p.parentId
        });
        if (res) {
          p.rev = res.rev ?? 1;
          p.baseRev = p.rev;
          p.baseUpdatedAt = res.updated_at ?? (Date.now() / 1000);
          await writeDraft(p);
        }
      }
    } catch (err) {
      console.error("Failed to create initial pages:", err);
    }
  }

  state.expanded.add(ROOT);
  applyTheme(getTheme());
  initRootDropZone();
  initSidebarTabs();
  await loadSidebarState();
  let lastPageId = null;
  try { lastPageId = await idbOrFallback(window.notifications.getState(scopedKey("lastPageId")).catch(() => null), 2000, null); } catch {}
  const lastPage = lastPageId && state.pages.has(lastPageId) ? state.pages.get(lastPageId) : null;
  const first = lastPage || state.pages.get("welcome") || childrenOf(ROOT)[0];
  if (first) await openPage(first.id);
  else setSaveState("Ready");
  initPublicToggle();
  initAutoToc();
}

function initPublicToggle() {
  const btn = document.getElementById('publicToggleBtn');
  if (!btn) return;
  btn.addEventListener('click', toggleCurrentPagePublic);
}

async function toggleCurrentPagePublic() {
  const page = state.pages.get(state.currentPageId);
  if (!page) return;
  try {
    const res = await fetch(`/api/pages/${state.currentPageId}/toggle-public`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();
    page.isPublic = data.is_public;
    if (data.rev != null) { page.rev = data.rev; page.baseRev = data.rev; }
    if (data.updated_at != null) page.baseUpdatedAt = data.updated_at;
    await writeDraft(page);
    // Apply server revs for every cascaded subpage so the next edit carries
    // a fresh base_rev instead of tripping a false 409.
    const affectedById = new Map((data.affected || []).map(a => [a.id, a]));
    // Cascade to subpages in UI state so flow is clear
    function updateSubpages(parentId, isPublic) {
      const children = childrenOf(parentId);
      for (const child of children) {
        child.isPublic = isPublic;
        const a = affectedById.get(child.id);
        if (a) {
          if (a.rev != null) { child.rev = a.rev; child.baseRev = a.rev; }
          if (a.updated_at != null) child.baseUpdatedAt = a.updated_at;
        }
        writeDraft(child);
        updateSubpages(child.id, isPublic);
      }
    }
    if (data.is_public) {
      updateSubpages(page.id, true);
      setSaveState('Made public — subpages included');
    } else {
      // When making private, only this page; subpages stay as they were or become private based on DB
      // Re-fetch metadata from server to sync exact DB state for children.
      // Merge, never clobber dirty local titles.
      try {
        const syncPages = await window.api.listPagesMeta();
        for (const sp of syncPages) {
          const existing = state.pages.get(sp.id);
          if (existing) {
            if (!existing.dirty) {
              existing.isPublic = Boolean(sp.is_public);
              if (sp.rev != null) { existing.rev = sp.rev; existing.baseRev = sp.rev; }
              if (sp.updated_at != null) existing.baseUpdatedAt = sp.updated_at;
            }
            // Cross-device recents stamp: shared truth, applies even to
            // dirty pages (never conflicts with content).
            if (sp.last_opened_at != null) existing.lastOpenedAt = sp.last_opened_at;
          } else upsertPageMeta(sp, { fromServer: true });
        }
        try { await idbOrFallback(window.notifications.saveState(scopedKey("pageListMeta"), syncPages).catch(() => {}), 2000, null); } catch {}
      } catch {}
      setSaveState('Made private');
    }
    updatePublicToggleUI();
    renderTree();
  } catch (err) {
    console.error('Toggle public failed:', err);
    setSaveState('Failed to toggle public');
  }
}

async function resolveConflictKeepMine() {
  const page = state.pages.get(state.currentPageId);
  if (!page || !page.conflictServer) return;
  // Force-push local copy: drop base so server accepts (last-writer-wins by choice).
  page.baseRev = null;
  page.baseUpdatedAt = null;
  page.conflictServer = null;
  hideConflictBar();
  setLocked(page, false);
  snapshotCurrentToPage();
  page.dirty = true;
  refreshGlobalDirty();
  await writeDraft(page);
  setSaveState("Resolving — keeping your copy...", false);
  await flushQueue();
}

async function resolveConflictLoadServer() {
  const page = state.pages.get(state.currentPageId);
  if (!page || !page.conflictServer) return;
  const srv = page.conflictServer;
  page.blocks = parseBlocks(srv.content);
  page.title = srv.title || page.title;
  page.parentId = srv.parent_id || page.parentId;
  page.isPublic = Boolean(srv.is_public);
  page.rev = srv.rev ?? page.rev ?? 1;
  page.baseRev = page.rev;
  page.baseUpdatedAt = srv.updated_at ?? null;
  page.baseTitle = page.title;
  page.baseHash = hashContent(page.blocks);
  page.dirty = false;
  page.retryCount = 0;
  page.conflictServer = null;
  page.epoch = (page.epoch || 0) + 1;
  page.mountEpoch = page.epoch;
  await writeDraft(page);
  refreshGlobalDirty();
  hideConflictBar();
  $("#pageTitle").value = page.title || "Untitled";
  await mountEditor(page.blocks);
  setLocked(page, false);
  setSaveState("Loaded server copy");
  renderTree();
  renderBreadcrumbs();
}

async function resolveConflictDuplicate() {
  const page = state.pages.get(state.currentPageId);
  if (!page || !page.conflictServer) return;
  const srv = page.conflictServer;
  // Keep current editor (mine) as-is; stash server copy as a new sibling page.
  const copyBlocks = parseBlocks(srv.content);
  const copy = makePage({
    title: (srv.title || page.title || "Untitled") + " (server copy)",
    parentId: page.parentId,
    blocks: copyBlocks,
  });
  copy.verified = true;
  copy.dirty = true;
  copy._localOnly = true;
  copy.baseRev = null;
  copy.baseUpdatedAt = null;
  copy.baseHash = null;
  state.pages.set(copy.id, copy);
  await writeDraft(copy);
  try {
    const res = await window.api.createPage({
      id: copy.id, title: copy.title,
      content: JSON.stringify(copy.blocks), parent_id: copy.parentId,
    });
    copy.rev = res.rev ?? 1;
    copy.baseRev = copy.rev;
    copy.baseUpdatedAt = res.updated_at ?? (Date.now() / 1000);
    copy.baseTitle = copy.title;
    copy.baseHash = hashContent(copy.blocks);
    copy.dirty = false;
    copy._localOnly = false;
    await writeDraft(copy);
  } catch (e) { scheduleFlush(15000); }
  page.conflictServer = null;
  hideConflictBar();
  snapshotCurrentToPage();
  page.dirty = true;
  page.baseRev = null;
  page.baseUpdatedAt = null;
  await writeDraft(page);
  refreshGlobalDirty();
  renderTree();
  setSaveState("Kept both — resolving your copy...", false);
  await flushQueue();
}

function updatePublicToggleUI() {
  const page = state.pages.get(state.currentPageId);
  const btn = document.getElementById('publicToggleBtn');
  const icon = document.getElementById('publicIcon');
  const label = document.getElementById('publicLabel');
  if (!btn || !page) return;
  btn.style.display = 'inline-flex';
  if (page.isPublic) {
    icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3Z"/></svg>';
    label.textContent = 'Public';
    btn.classList.add('public');
    btn.title = 'Page is public — subpages are public too';
  } else {
    icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
    label.textContent = 'Private';
    btn.classList.remove('public');
    btn.title = 'Make page public (includes subpages)';
  }
}

$("#newPageBtn").addEventListener("click", () => createPage(ROOT));
$("#selectModeBtn").addEventListener("click", () => setSelecting(!state.selecting));
$("#saveBtn").addEventListener("click", saveCurrent);
$("#undoBtn").addEventListener("click", () => state.editor?.undo());
$("#redoBtn").addEventListener("click", () => state.editor?.redo());
$("#collapseAll").addEventListener("click", () => {
  const allIds = new Set([...state.pages.values()].map(p => p.id));
  const collapsed = state.expanded.size === 1 && state.expanded.has(ROOT);
  if (collapsed) {
    state.expanded = new Set(allIds);
    $("#collapseAll").textContent = "⌄";
    $("#collapseAll").title = "Collapse all";
  } else {
    state.expanded = new Set([ROOT]);
    $("#collapseAll").textContent = "›";
    $("#collapseAll").title = "Show all";
  }
  renderTree();
});

function openQuickSwitch() {
  const overlay = $("#quickSwitchOverlay");
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  $("#quickSwitchInput").value = "";
  $("#quickSwitchInput").focus();
  renderQuickSwitch("");
  document.body.style.overflow = "hidden";
}

function closeQuickSwitch() {
  const overlay = $("#quickSwitchOverlay");
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function renderQuickSwitch(filterText) {
  const listEl = $("#quickSwitchList");
  const allPages = [...state.pages.values()].filter(p => p.id !== ROOT);
  const filter = (filterText || "").trim().toLowerCase();
  const raw = filter ? (filterText || "").trim() : "";
  const filtered = filter ? allPages.filter(p => {
    const title = (p.title || "Untitled").toLowerCase();
    return title.includes(filter);
  }) : allPages;
  const sorted = filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 30);
  const groupLabel = filter ? "Matches" : "Recent pages";

  if (!sorted.length) {
    listEl.innerHTML = '<div class="quick-switch-empty">No pages found</div>'
      + (raw ? `<button class="quick-switch-create" data-create="${escapeHtml(raw)}">⊕ Create "${escapeHtml(raw)}" ↵</button>` : "");
    return;
  }
  listEl.innerHTML = `<div class="quick-switch-group">${groupLabel}</div>` + sorted.map((p, i) => {
    const activeClass = i === 0 ? " selected" : "";
    const parentTitle = p.parentId !== ROOT ? (state.pages.get(p.parentId)?.title || "Root") : null;
    return `<button class="quick-switch-item${activeClass}" data-id="${escapeHtml(p.id)}" data-idx="${i}">
      <span class="qs-emoji">${escapeHtml(p.emoji || "")}</span>
      <span class="qs-title">${escapeHtml(p.title || "Untitled")}</span>
      ${parentTitle ? `<span class="qs-parent">${escapeHtml(parentTitle)}</span>` : ""}
    </button>`;
  }).join("")
  + (raw ? `<button class="quick-switch-create" data-create="${escapeHtml(raw)}">⊕ Create "${escapeHtml(raw)}" ↵</button>` : "");
}

async function quickSwitchCreate(title) {
  closeQuickSwitch();
  // Reuse createPage then rename — keeps offline queue + sync logic intact.
  const clean = (title || "").trim() || "Untitled";
  await createPage(ROOT);
  try {
    const page = state.pages.get(state.currentPageId);
    if (page) {
      $("#pageTitle").value = clean;
      page.title = clean;
      page.baseTitle = page.baseTitle === "Untitled" ? page.baseTitle : page.baseTitle;
      markDirty();
      renderTree();
      renderBreadcrumbs();
    }
  } catch {}
}

function handleQuickSwitchKey(e) {
  const overlay = $("#quickSwitchOverlay");
  if (!overlay.classList.contains("open")) return false;
  const listEl = $("#quickSwitchList");
  if (e.key === "Escape") { e.preventDefault(); closeQuickSwitch(); return true; }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const selected = listEl.querySelector(".quick-switch-item.selected") || listEl.querySelector(".quick-switch-item");
    if (!selected) return true;
    const next = selected.nextElementSibling;
    if (next) { selected.classList.remove("selected"); next.classList.add("selected"); next.scrollIntoView({ block: "nearest" }); }
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    const selected = listEl.querySelector(".quick-switch-item.selected") || listEl.querySelector(".quick-switch-item");
    if (!selected) return true;
    const prev = selected.previousElementSibling;
    if (prev) { selected.classList.remove("selected"); prev.classList.add("selected"); prev.scrollIntoView({ block: "nearest" }); }
    return true;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const createBtn = listEl.querySelector(".quick-switch-create");
    const selected = listEl.querySelector(".quick-switch-item.selected");
    // If user typed a fresh name, Enter creates it (even when matches exist,
    // the top match stays selected — create row is reachable by click or
    // by typing an exact new name with no matches).
    if (createBtn && !selected) {
      quickSwitchCreate(createBtn.dataset.create || $("#quickSwitchInput").value);
      return true;
    }
    if (selected?.classList?.contains("quick-switch-create") || selected?.dataset?.create) {
      quickSwitchCreate(selected.dataset.create || $("#quickSwitchInput").value);
      return true;
    }
    if (selected) {
      const id = selected.dataset.id;
      closeQuickSwitch();
      if (id) openPage(id);
    } else if (createBtn) {
      quickSwitchCreate(createBtn.dataset.create || $("#quickSwitchInput").value);
    }
    return true;
  }
  return false;
}

const listEl = $("#quickSwitchList");
$("#quickSwitchInput").addEventListener("input", (e) => renderQuickSwitch(e.target.value));
listEl.addEventListener("click", (e) => {
  const create = e.target.closest(".quick-switch-create");
  if (create) { quickSwitchCreate(create.dataset.create || $("#quickSwitchInput").value); return; }
  const btn = e.target.closest(".quick-switch-item");
  if (!btn) return;
  const id = btn.dataset.id;
  closeQuickSwitch();
  if (id) openPage(id);
});

// Sidebar filter: instant local filtering + Enter-to-create.
function initPageFilter() {
  const input = $("#pageFilter");
  const clear = $("#pageFilterClear");
  if (!input) return;
  const syncClear = () => { if (clear) clear.hidden = !input.value; };
  input.addEventListener("input", () => {
    state.pageFilter = input.value || "";
    syncClear();
    renderTree();
  });
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape" && input.value) {
      e.stopPropagation();
      input.value = "";
      state.pageFilter = "";
      syncClear();
      renderTree();
      return;
    }
    if (e.key === "Enter" && (state.pageFilter || "").trim()) {
      e.preventDefault();
      const existing = [...state.pages.values()].find(p => p.id !== ROOT && (p.title || "").toLowerCase() === state.pageFilter.trim().toLowerCase());
      if (existing) { openPage(existing.id); return; }
      const title = state.pageFilter.trim();
      input.value = "";
      state.pageFilter = "";
      syncClear();
      renderTree();
      await createPage(ROOT);
      try {
        $("#pageTitle").value = title;
        const page = state.pages.get(state.currentPageId);
        if (page) { page.title = title; markDirty(); renderTree(); renderBreadcrumbs(); }
      } catch {}
    }
  });
  if (clear) clear.addEventListener("click", () => {
    input.value = "";
    state.pageFilter = "";
    syncClear();
    renderTree();
    input.focus();
  });
  syncClear();
}
initPageFilter();

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openQuickSwitch();
    return;
  }
  if (e.key === "Escape" && $("#quickSwitchOverlay").classList.contains("open")) {
    closeQuickSwitch();
    return;
  }
  // Dialog handles its own Escape (capture phase); only close menus here.
  if (e.key === "Escape" && $("#contextMenu")?.classList.contains("open")) {
    e.preventDefault();
    closeContextMenu();
    return;
  }
  if (handleQuickSwitchKey(e)) return;
  if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // Already handled by a focused overlay on this same press: editor slash
    // menu calls preventDefault() when it closes, so don't also wipe selection.
    if (e.defaultPrevented) return;
    if ($("#nlDialogOverlay")?.classList.contains("open")) return;
    if ($("#emojiPicker")?.classList.contains("open")) return;
    if ($("#slashMenu")?.classList.contains("open")) {
      e.preventDefault();
      closeSlashMenu();
      return;
    }
    if ($("#blockMenu")?.classList.contains("open")) {
      e.preventDefault();
      $("#blockMenu").classList.remove("open");
      return;
    }
    if ($("#formatToolbar")?.classList.contains("open")) {
      e.preventDefault();
      $("#formatToolbar").classList.remove("open");
      return;
    }
    if (isSelecting()) {
      e.preventDefault();
      setSelecting(false);
      return;
    }
  }
});

function updateSortBtn() {
  const btn = $("#sortOrderBtn");
  if (!btn) return;
  if (state.sortOrder === "alpha") {
    btn.textContent = "AZ";
    btn.title = "Sorted alphabetically (click for modified)";
  } else {
    btn.textContent = "⇅";
    btn.title = "Sorted by modified (click for alphabetical)";
  }
}

$("#sortOrderBtn").addEventListener("click", () => {
  state.sortOrder = state.sortOrder === "modified" ? "alpha" : "modified";
  try { localStorage.setItem("notion-sort-order", state.sortOrder); } catch {}
  updateSortBtn();
  renderTree();
});

updateSortBtn();

const sidebarMenuBtn = $("#sidebarMenuBtn");
const sidebarUserMenu = $("#sidebarUserMenu");
// Sidebar avatar shows the logged-in user's initial (not a hardcoded "U").
try {
  const _av = $("#userAvatar");
  const _un = (document.body.dataset.username || "").trim();
  if (_av && _un) _av.textContent = _un.charAt(0).toUpperCase();
} catch {}
sidebarMenuBtn.addEventListener("click", () => {
  const isOpen = sidebarUserMenu.classList.contains("open");
  sidebarUserMenu.classList.toggle("open");
  sidebarMenuBtn.setAttribute("aria-expanded", !isOpen);
});
document.addEventListener("click", (e) => {
  if (!sidebarMenuBtn.contains(e.target) && !sidebarUserMenu.contains(e.target)) {
    sidebarUserMenu.classList.remove("open");
    sidebarMenuBtn.setAttribute("aria-expanded", "false");
  }
});
$("#footerSettingsBtn").addEventListener("click", () => {
  sidebarUserMenu.classList.remove("open");
  sidebarMenuBtn.setAttribute("aria-expanded", "false");
  $("#settingsPanel").classList.add("open");
});
$("#footerExportBtn").addEventListener("click", () => {
  sidebarUserMenu.classList.remove("open");
  sidebarMenuBtn.setAttribute("aria-expanded", "false");
  exportProfile();
});
$("#myWallBtn").addEventListener("click", () => {
  sidebarUserMenu.classList.remove("open");
  sidebarMenuBtn.setAttribute("aria-expanded", "false");
  const username = document.body.dataset.username || "";
  if (username) {
    window.location.href = "/wall/" + encodeURIComponent(username);
  }
});
$("#pageTitle").addEventListener("input", markDirty);
$("#pageTitle").addEventListener("blur", () => {
  const page = state.pages.get(state.currentPageId);
  if (!page) return;
  const titleEl = $("#pageTitle");
  const nextTitle = titleEl ? titleEl.value.trim() || "Untitled" : page.title;
  let nextBlocks = page.blocks;
  try { if (state.editor) nextBlocks = structuredClone(state.editor.document); } catch {}
  const titleChanged = nextTitle !== (page.baseTitle ?? page.title);
  const contentChanged = !page.baseHash || hashContent(nextBlocks) !== page.baseHash;
  // Blurring (e.g. clicking another page in the sidebar) is not an edit —
  // only queue a save when something actually changed.
  if (!titleChanged && !contentChanged && !page.dirty) return;
  snapshotCurrentToPage();
  if (titleChanged || contentChanged) page.updatedAt = Date.now();
  page.dirty = true;
  refreshGlobalDirty();
  writeDraft(page);
  scheduleFlush(1500);
});
$("#pageTitle").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    const page = state.pages.get(state.currentPageId);
    if (!page || (!page.dirty && !refreshGlobalDirty())) {
      setSaveState("Nothing to save", false);
      return;
    }
    saveCurrent();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const titleInput = $("#pageTitle");
    const value = titleInput.value;
    const pos = titleInput.selectionStart;
    const afterCursor = value.slice(pos);
    const beforeCursor = value.slice(0, pos).trim() || "Untitled";

    titleInput.value = beforeCursor;
    markDirty();

    if (afterCursor) {
      const block = state.editor.document[0];
      if (block) {
        const blockText = currentBlockText(block);
        state.editor.updateBlock(block, { content: afterCursor + (blockText ? " " + blockText : "") });
      }
    }

    state.editor.focus();
  }
});

function _outsideTapClosesMenus(e) {
  const slash = $("#slashMenu");
  if (slash.classList.contains("open") && !slash.contains(e.target) && !$("#mobileSlashBtn")?.contains(e.target)) closeSlashMenu({ keepText: true });
  const ctx = $("#contextMenu");
  if (ctx.classList.contains("open") && !ctx.contains(e.target)) closeContextMenu();
}
document.addEventListener("mousedown", _outsideTapClosesMenus);
document.addEventListener("touchstart", _outsideTapClosesMenus, { passive: true });
window.addEventListener("resize", () => {
  if ($("#slashMenu").classList.contains("open")) positionSlashMenu();
});
function flushBeacon() {
  // Drafts are already in IndexedDB from markDirty; best-effort server push.
  const dirty = [...state.pages.values()].filter(p => p.dirty && !p.conflictServer);
  if (!dirty.length) return;
  const cur = state.pages.get(state.currentPageId);
  if (cur && cur.dirty && state.editor) {
    try { cur.blocks = structuredClone(state.editor.document); } catch {}
    const t = $("#pageTitle");
    if (t) cur.title = t.value.trim() || "Untitled";
    writeDraft(cur);
  }
  // One keepalive request max on hide (free-tier friendly). Rest stays queued.
  const page = dirty.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))[0];
  try {
    const blocks = (page.id === state.currentPageId && state.editor) ? state.editor.document : page.blocks;
    const payload = { title: page.title, content: JSON.stringify(blocks || []), parent_id: page.parentId };
    if (page.baseRev != null) payload.base_rev = page.baseRev;
    if (page.baseUpdatedAt != null) payload.base_updated_at = page.baseUpdatedAt;
    fetch(`/api/pages/${encodeURIComponent(page.id)}/save-beacon`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
window.addEventListener("pagehide", flushBeacon);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    const anyDirty = refreshGlobalDirty();
    if (anyDirty) {
      const cur = state.pages.get(state.currentPageId);
      if (cur && state.editor) {
        try { cur.blocks = structuredClone(state.editor.document); } catch {}
        const t = $("#pageTitle");
        if (t) cur.title = t.value.trim() || "Untitled";
        cur.dirty = true;
        writeDraft(cur);
      }
      flushBeacon();
      scheduleFlush(15000);
    }
  } else if (document.visibilityState === "visible") {
    if ([...state.pages.values()].some(p => p.dirty)) scheduleFlush(2000);
  }
});
window.addEventListener("online", () => {
  hideSyncBanner();
  setSaveState("Back online — syncing...", false);
  scheduleFlush(1000);
});
window.addEventListener("offline", () => {
  showSyncBanner("Offline — editing local copy, will sync later", true);
});
window.addEventListener("beforeunload", flushBeacon);

document.querySelectorAll(".theme-btn").forEach(b => b.addEventListener("click", () => applyTheme(b.dataset.theme)));
$("#closeSettings").addEventListener("click", () => $("#settingsPanel").classList.remove("open"));
document.addEventListener("mousedown", (e) => {
  const panel = $("#settingsPanel");
  const sidebarMenu = $("#sidebarUserMenu");
  const notifPanel = $("#notificationPanel");
  if (panel.classList.contains("open") && !panel.contains(e.target)) panel.classList.remove("open");
  if (sidebarMenu.classList.contains("open") && !sidebarMenu.contains(e.target) && !$("#sidebarMenuBtn").contains(e.target)) {
    sidebarMenu.classList.remove("open");
    $("#sidebarMenuBtn").setAttribute("aria-expanded", "false");
  }
  if (notifPanel.classList.contains("open") && !notifPanel.contains(e.target) && !$("#notificationTrigger").contains(e.target)) {
    notifPanel.classList.remove("open");
    $("#notificationTrigger")?.setAttribute("aria-expanded", "false");
  }
});

$("#exportProfile").addEventListener("click", exportProfile);
$("#exportNote").addEventListener("click", exportNote);
$("#importProfile").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", (e) => { if (e.target.files && e.target.files[0]) importProfile(e.target.files[0]); e.target.value = ""; });
$("#notificationTrigger").addEventListener("click", toggleNotificationPanel);
$("#clearNotifications").addEventListener("click", clearAllNotifications);
$("#conflictKeepMine")?.addEventListener("click", resolveConflictKeepMine);
$("#conflictLoadServer")?.addEventListener("click", resolveConflictLoadServer);
$("#conflictDuplicate")?.addEventListener("click", resolveConflictDuplicate);

document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "Insert") {
    e.preventDefault();
    createPage(state.currentPageId);
    return;
  }
  if (e.altKey && (e.key === "+" || e.key === "Add")) {
    e.preventDefault();
    state.expanded = new Set([...state.pages.keys()]);
    renderTree();
    return;
  }
  if (e.altKey && (e.key === "-" || e.key === "Subtract")) {
    e.preventDefault();
    state.expanded = new Set([ROOT]);
    renderTree();
    return;
  }
  if (!e.altKey) return;
  if (e.key !== "PageUp" && e.key !== "PageDown") return;
  e.preventDefault();

  const rows = [...document.querySelectorAll("#pageTree .tree-row")];
  if (rows.length < 2) return;

  const currentRow = rows.find(r => r.dataset.id === state.currentPageId);
  let currentIdx = currentRow ? rows.indexOf(currentRow) : -1;

  let nextRow;
  if (e.key === "PageUp") {
    nextRow = currentIdx <= 0 ? rows[rows.length - 1] : rows[currentIdx - 1];
  } else {
    nextRow = currentIdx >= rows.length - 1 ? rows[0] : rows[currentIdx + 1];
  }

  if (nextRow) {
    nextRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
    openPage(nextRow.dataset.id);
  }
});

function toggleSidebar(force) {
  const sb = document.querySelector(".sidebar");
  const bd = $("#mobileBackdrop");
  if (force === true) { sb.classList.add("open"); bd.classList.add("open"); }
  else if (force === false) { sb.classList.remove("open"); bd.classList.remove("open"); }
  else { sb.classList.toggle("open"); bd.classList.toggle("open"); }
}
$("#mobileMenuBtn").addEventListener("click", () => toggleSidebar());
$("#mobileBackdrop").addEventListener("click", () => toggleSidebar(false));
$("#mobileSlashBtn")?.addEventListener("click", openSlashFromButton);
$("#imageBtn")?.addEventListener("click", () => {
  try {
    if (!state.editor) return;
    try { state.editor.focus(); } catch {}
    openImageChooser();
  } catch (e) { console.warn("image button failed", e); }
});
document.getElementById("imageUploadInput")?.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) uploadImageFile(f);
  e.target.value = "";
});

// Dismiss floating bars when the doc scrolls so they never freeze mid-screen.
document.getElementById("workspace")?.addEventListener("scroll", () => {
  try {
    if ($("#formatToolbar")?.classList.contains("open") && (isMobileLayout() || isCoarsePointer())) {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) $("#formatToolbar").classList.remove("open");
    }
  } catch {}
}, { passive: true });

// Keyboard show/hide (visualViewport) re-pins open menus; without this the
// keyboard resize strands fixed popovers as bars at the wrong offset.
try {
  if (window.visualViewport) {
    let _vvT = null;
    window.visualViewport.addEventListener("resize", () => {
      clearTimeout(_vvT);
      _vvT = setTimeout(() => {
        try {
          if ($("#slashMenu")?.classList.contains("open")) positionSlashMenu();
          try { keepCaretVisible(); } catch {}
        } catch {}
      }, 120);
    });
  }
} catch {}

// Custom pull-to-refresh on the internal .workspace scroller (body scroll is
// locked, so the native gesture can never fire). Pull past the threshold at
// scrollTop 0 shows the indicator; release re-verifies the open page.
(function initPullToRefresh() {
  const ws = document.getElementById("workspace");
  const ind = document.getElementById("ptrIndicator");
  const label = document.getElementById("ptrLabel");
  if (!ws || !ind) return;
  let startY = null, pulling = false, ready = false, refreshing = false;
  const THRESHOLD = 72;
  ws.addEventListener("touchstart", (e) => {
    if (refreshing) return;
    if (ws.scrollTop <= 0 && e.touches && e.touches.length === 1) {
      startY = e.touches[0].clientY;
      pulling = false; ready = false;
    } else startY = null;
  }, { passive: true });
  ws.addEventListener("touchmove", (e) => {
    if (startY == null || refreshing) return;
    const dy = (e.touches[0]?.clientY ?? 0) - startY;
    if (dy > 12 && ws.scrollTop <= 0) {
      pulling = true;
      ind.classList.add("pulling");
      ready = dy >= THRESHOLD;
      ind.classList.toggle("ready", ready);
      if (label) label.textContent = ready ? "Release to refresh" : "Pull to refresh";
    } else if (dy <= 0) {
      pulling = false;
      ind.classList.remove("pulling", "ready");
    }
  }, { passive: true });
  async function endPull() {
    if (startY == null) return;
    const wasReady = ready;
    startY = null; pulling = false; ready = false;
    if (!wasReady || refreshing) { ind.classList.remove("pulling", "ready"); return; }
    refreshing = true;
    ind.classList.remove("pulling", "ready");
    ind.classList.add("refreshing");
    if (label) label.textContent = "Refreshing…";
    try {
      if (state.currentPageId) await openPage(state.currentPageId);
      else window.location.reload();
    } catch { try { window.location.reload(); } catch {} }
    refreshing = false;
    ind.classList.remove("refreshing");
    if (label) label.textContent = "Pull to refresh";
  }
  ws.addEventListener("touchend", endPull, { passive: true });
  ws.addEventListener("touchcancel", () => {
    startY = null; pulling = false; ready = false;
    ind.classList.remove("pulling", "ready");
  }, { passive: true });
})();

try {
  const mql = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (mql && mql.addEventListener) mql.addEventListener("change", () => { if (getTheme() === "auto") applyTheme("auto"); });
} catch {}

(function initSidebarResize() {
  const handle = $("#sidebarResizeHandle");
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 600;
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  try {
    const saved = localStorage.getItem("notion-sidebar-width");
    if (saved) {
      const w = parseInt(saved, 10);
      if (w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) {
        document.documentElement.style.setProperty("--sidebar-width", w + "px");
      }
    }
  } catch {}

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    const sidebar = document.querySelector(".sidebar");
    startWidth = sidebar.getBoundingClientRect().width;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + dx));
    document.documentElement.style.setProperty("--sidebar-width", newWidth + "px");
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      const sidebar = document.querySelector(".sidebar");
      localStorage.setItem("notion-sidebar-width", sidebar.getBoundingClientRect().width);
    } catch {}
  });
})();

function renderAutoToc() {
  const container = $("#autoToc");
  if (!container) return;
  const blocks = state.editor?.document || [];
  const headings = blocks.filter(b => b.type === "heading" && b.props && typeof b.props.level === "number");
  if (!headings.length) {
    container.innerHTML = "";
    return;
  }
  // Preserve the hovered .toc-list across re-renders: touch only the dots.
  container.querySelectorAll(".toc-bar").forEach(b => b.remove());
  const list = container.querySelector(".toc-list");
  headings.forEach((h, i) => {
    const bar = document.createElement("div");
    const level = h.props.level || 2;
    bar.className = "toc-bar is-h" + level;
    bar.title = (currentBlockText(h) || "Heading").trim();
    bar.dataset.index = i;
    bar.addEventListener("click", () => {
      scrollToHeading(i, headings);
    });
    if (list) container.insertBefore(bar, list);
    else container.appendChild(bar);
  });

  if (!container.querySelector(".toc-list")) {
    const list = document.createElement("div");
    list.className = "toc-list";
    list.innerHTML = '<div class="toc-header">Contents</div>';
    headings.forEach((h, i) => {
      const btn = document.createElement("button");
      const level = h.props.level || 2;
      const text = (currentBlockText(h) || "Heading").trim();
      btn.className = "toc-item is-h" + level;
      btn.textContent = text;
      btn.title = text;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        scrollToHeading(i, headings);
      });
      list.appendChild(btn);
    });
    container.appendChild(list);
  } else {
    const list = container.querySelector(".toc-list");
    const items = list.querySelectorAll(".toc-item");
    headings.forEach((h, i) => {
      if (items[i]) {
        const level = h.props.level || 2;
        items[i].className = "toc-item is-h" + level;
        const text = (currentBlockText(h) || "Heading").trim();
        items[i].textContent = text;
        items[i].title = text;
      }
    });
    let extra = list.querySelectorAll(".toc-item");
    while (extra.length > headings.length) {
      extra[extra.length - 1].remove();
      extra = list.querySelectorAll(".toc-item");
    }
    for (let i = items.length; i < headings.length; i++) {
      const h = headings[i];
      const btn = document.createElement("button");
      const level = h.props.level || 2;
      const text = (currentBlockText(h) || "Heading").trim();
      btn.className = "toc-item is-h" + level;
      btn.textContent = text;
      btn.title = text;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        scrollToHeading(i, headings);
      });
      list.appendChild(btn);
    }
  }
}

function scrollToHeading(index, headings) {
  if (!state.editor) return;
  const h = headings[index];
  if (!h || !h.id) return;
  try {
    state.editor.setTextCursorPosition(h.id, "start");
  } catch {}
  const el = document.querySelector('[data-id="' + h.id + '"]');
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function initAutoToc() {
  const observer = new MutationObserver(() => {
    clearTimeout(window._tocTimer);
    window._tocTimer = setTimeout(() => renderAutoToc(), 120);
  });
  observer.observe(document.getElementById("editor") || document.body, { childList: true, subtree: true });

  const toc = document.getElementById("autoToc");
  if (!toc) return;
  let hideTimer = null;
  const HIDE_DELAY = 350;

  function showToc() {
    clearTimeout(hideTimer);
    hideTimer = null;
    toc.classList.add("toc-hovered");
  }
  function hideToc() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      toc.classList.remove("toc-hovered");
    }, HIDE_DELAY);
  }

  toc.addEventListener("mouseenter", showToc);
  toc.addEventListener("mouseleave", hideToc);
}

(function initShortcutHud() {
  const hud = $("#shortcutHud");
  if (!hud) return;
  let hideTimer = null;

  document.addEventListener("keydown", (e) => {
    if (e.key === "Alt" || e.key === "Control") {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      hud.classList.add("visible");
    }
  });

  document.addEventListener("keyup", (e) => {
    if (e.key === "Alt" || e.key === "Control") {
      hud.classList.remove("visible");
      hideTimer = setTimeout(() => { hud.classList.remove("visible"); }, 800);
    }
  });

  document.addEventListener("blur", () => {
    hud.classList.remove("visible");
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  });
})();

const EMOJI_CATEGORIES = {
  smileys: ["😀","😃","😄","😁","😆","😅","🤣","😂","🙂","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","🤥","😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🤧","🥵","🥶","🥴","😵","🤯","🤠","🥳","🥸","😎","🤓","🧐","😕","😟","🙁","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫","🥱","😤","😡","😠","🤬","😈","👿","💀","☠️","💩","🤡","👹","👺","👻","👽","👾","🤖"],
  people: ["👋","🤚","🖐️","✋","🖖","👌","🤌","🤏","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","✍️","💅","🤳","💪","🦾","🦿","🦵","🦶","👂","🦻","👃","🧠","🫀","🫁","🦷","🦴","👀","👁️","👅","👄","👶","🧒","👦","👧","🧑","👱","👨","🧔","👩","🧓","👴","👵","🙍","🙎","🙅","🙆","💁","🙋","🧏","🙇","🤦","🤷","👮","🕵️","💂","🥷","👷","🤴","👸","👳","👲","🧕","🤵","👰","🤰","🤱","👼","🎒","👑","📿","💄","💍","💎"],
  animals: ["🐱","🐶","🐕","🐩","🐺","🦊","🦄","🐴","🐎","🦄","🦓","🦌","🦒","🦏","🦛","🐘","🦣","🦏","🐁","🐀","🐹","🐰","🐇","🐿️","🦔","🦇","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐽","🐸","🐵","🙈","🙉","🙊","🐒","🐔","🐧","🐦","🐤","🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🪱","🐛","🦋","🐌","🐞","🐜","🪰","🪲","🪳","🦟","🦗","🕷️","🕸️","🦂","🐢","🐍","🦎","🦖","🦕","🐙","🦑","🦐","🦞","🦀","🐡","🐠","🐟","🐬","🐳","🐋","🦈","🐊","🐅","🐆","🦓","🦍","🦧","🦣"],
  food: ["🍔","🍕","🌭","🍟","🍿","🧂","🥓","🥚","🍳","🧇","🥞","🧈","🍞","🥐","🥨","🥯","🥖","🧀","🥗","🥙","🥪","🌮","🌯","🫔","🥫","🍝","🍜","🍲","🍛","🍣","🍱","🥟","🦪","🍤","🍙","🍚","🍘","🍥","🥠","🥮","🍢","🍡","🍧","🍨","🍦","🥧","🧁","🍰","🎂","🍮","🍭","🍬","🍫","🍿","🍩","🍪","🌰","🥜","🍯","🥛","🍼","☕","🫖","🍵","🧃","🥤","🧋","🍶","🍺","🍻","🥂","🍷","🥃","🍸","🍹","🧉","🍾","🧊"],
  travel: ["✈️","🚀","🛸","🚁","🛶","⛵","🚤","🛥️","🛳️","🚢","🚂","🚃","🚄","🚅","🚆","🚇","🚈","🚉","🚊","🚝","🚞","🚋","🚌","🚍","🚎","🚐","🚑","🚒","🚓","🚔","🚕","🚖","🚗","🚘","🚙","🛻","🚚","🚛","🚜","🏎️","🏍️","🛵","🚲","🛴","🛹","🛼","🚏","🛤️","🛣️","🗺️","🗿","🗽","🗼","🏰","🏯","🏟️","🎡","🎢","🎠","⛲","⛱️","🏖️","🏝️","🏜️","🌋","⛰️","🏔️","🗻","🏕️","⛺","🛖","🏠","🏡","🏘️","🏚️","🏗️","🏭","🏢","🏬","🏣","🏤","🏥","🏦","🏨","🏪","🏫","🏩","💒","🏛️","⛪","🕌","🕍","🛕","🕋","⛩️"],
  activities: ["⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🪀","🏓","🏸","🏒","🏑","🥍","🏏","🪃","🥅","⛳","🪁","🏹","🎣","🤿","🥊","🥋","🎽","🛹","🛼","🛷","⛸️","🥌","🎿","⛷️","🏂","🪂","🏋️","🤼","🤸","⛹️","🤺","🤾","🏌️","🏇","🧘","🏄","🏊","🤽","🚣","🧗","🚵","🚴","🏆","🥇","🥈","🥉","🏅","🎖️","🏵️","🎗️","🎫","🎟️","🎪","🤹","🎭","🩰","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🪘","🎷","🎺","🪗","🎸","🪕","🎻","🎲","♟️","🎯","🎳","🎮","🕹️","🎰"],
  objects: ["💡","🔦","🏮","🪔","📱","💻","🖥️","🖨️","⌨️","🖱️","🖲️","💽","💾","💿","📀","📼","📷","📸","📹","🎥","📽️","🎞️","📞","☎️","📟","📠","📺","📻","🧭","⏱️","⏲️","🕰️","⌛","⏳","⏰","⏱️","🕓","📡","🔋","🔌","💵","💴","💶","💷","💰","💳","💎","⚖️","🪜","🧰","🪛","🔧","🔨","⚒️","🛠️","⛏️","🪚","🔩","⚙️","🪤","🧱","⛓️","🧲","🔫","💣","🧨","🪓","🔪","🗡️","⚔️","🛡️","🚬","⚰️","🪦","⚱️","🏺","🔮","📿","🧿","💈","⚗️","🔭","🔬","🕳️","🩹","🩺","💊","💉","🩸","🧬","🦠","🧫","🧪"],
  symbols: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟","☮️","✝️","☪️","🕉️","☸️","✡️","🔯","🕎","☯️","☦️","🛐","⛎","♈","♉","♊","♋","♌","♍","♎","♏","♐","♑","♒","♓","🆔","⚛️","🉑","☢️","☣️","📴","📳","🈶","🈚","🈸","🈺","🈷️","✴️","🆚","💮","🉐","㊙️","㊗️","🈴","🈵","🈹","🈲","🅰️","🅱️","🆎","🆑","🅾️","🆘","⛔","📛","🔞","🔃","🔄","🔙","🔛","🔝","✅","❎","🈯","💹","❇️","✳️","❎","✅","✔️","☑️","🔘","🔰","🈳","🈂️","♻️","🈷️","🔱"],
  flags: ["🏁","🚩","🎌","🏴","🏳️","🏳️‍🌈","🏳️‍⚧️","🏴‍☠️","🇦🇨","🇦🇩","🇦🇪","🇦🇫","🇦🇬","🇦🇮","🇦🇱","🇦🇲","🇦🇴","🇦🇶","🇦🇷","🇦🇸","🇦🇹","🇦🇺","🇦🇼","🇦🇽","🇦🇿","🇧🇦","🇧🇧","🇧🇩","🇧🇪","🇧🇫","🇧🇬","🇧🇭","🇧🇮","🇧🇯","🇧🇱","🇧🇲","🇧🇳","🇧🇴","🇧🇶","🇧🇷","🇧🇸","🇧🇹","🇧🇻","🇧🇼","🇧🇾","🇧🇿","🇨🇦","🇨🇨","🇨🇩","🇨🇫","🇨🇬","🇨🇭","🇨🇮","🇨🇰","🇨🇱","🇨🇲","🇨🇳","🇨🇴","🇨🇵","🇨🇷","🇨🇺","🇨🇻","🇨🇼","🇨🇽","🇨🇾","🇨🇿"]
};

const EMOJI_KEYWORDS = {"😀":"grinning face smileys smile happy emotion grin","😃":"smiling face with open mouth smileys smile happy emotion grin","😄":"smiling face with open mouth and eyes smileys smile happy emotion grin laugh","😁":"grinning face with smiling eyes smileys smile happy emotion grin","😆":"smiling face with open mouth and tightly-closed eyes smileys smile happy emotion","😅":"smiling face with open mouth and cold sweat smileys smile happy emotion","🤣":"rolling on the floor laughing smileys smile happy face emotion laugh lol","😂":"face with tears of joy smileys smile happy emotion laugh lol tear cry","🙂":"slightly smiling face smileys smile happy emotion","😉":"winking face smileys smile happy emotion","😊":"smiling face with eyes smileys smile happy emotion","😇":"smiling face with halo smileys smile happy emotion","🥰":"smiling face with eyes and three hearts smileys smile happy emotion","😍":"smiling face with heart-shaped eyes smileys smile happy emotion","🤩":"grinning face with star eyes smileys smile happy emotion","😘":"face throwing a kiss smileys smile happy emotion","😗":"kissing face smileys smile happy emotion","😚":"kissing face with closed eyes smileys smile happy emotion","😋":"face savouring delicious food smileys smile happy emotion","😛":"face with stuck-out tongue smileys smile happy emotion","😜":"face with stuck-out tongue and winking eye smileys smile happy emotion","🤪":"grinning face with one large and small eye smileys smile happy emotion","😝":"face with stuck-out tongue and tightly-closed eyes smileys smile happy emotion","🤑":"money-mouth face smileys smile happy emotion","🤗":"hugging face smileys smile happy emotion","🤭":"smiling face with eyes and hand covering mouth smileys smile happy emotion","🤫":"face with finger covering closed lips smileys smile happy emotion","🤔":"thinking face smileys smile happy emotion","🤐":"zipper-mouth face smileys smile happy emotion","🤨":"face with one eyebrow raised smileys smile happy emotion","😐":"neutral face smileys smile happy emotion","😑":"expressionless face smileys smile happy emotion","😶":"face without mouth smileys smile happy emotion","😏":"smirking face smileys smile happy emotion","😒":"unamused face smileys smile happy emotion","🙄":"face with rolling eyes smileys smile happy emotion","😬":"grimacing face smileys smile happy emotion","🤥":"lying face smileys smile happy emotion","😌":"relieved face smileys smile happy emotion","😔":"pensive face smileys smile happy emotion","😪":"sleepy face smileys smile happy emotion","🤤":"drooling face smileys smile happy emotion","😴":"sleeping face smileys smile happy emotion","😷":"face with medical mask smileys smile happy emotion","🤒":"face with thermometer smileys smile happy emotion","🤕":"face with head-bandage smileys smile happy emotion","🤢":"nauseated face smileys smile happy emotion","🤮":"face with open mouth vomiting smileys smile happy emotion","🤧":"sneezing face smileys smile happy emotion","🥵":"overheated face smileys smile happy emotion","🥶":"freezing face smileys smile happy emotion","🥴":"face with uneven eyes and wavy mouth smileys smile happy emotion","😵":"dizzy face smileys smile happy emotion","🤯":"shocked face with exploding head smileys smile happy emotion","🤠":"face with cowboy hat smileys smile happy emotion","🥳":"face with party horn and hat smileys smile happy emotion","🥸":"disguised face smileys smile happy emotion","😎":"smiling face with sunglasses smileys smile happy emotion","🤓":"nerd face smileys smile happy emotion","🧐":"face with monocle smileys smile happy emotion","😕":"confused face smileys smile happy emotion","😟":"worried face smileys smile happy emotion","🙁":"slightly frowning face smileys smile happy emotion","😮":"face with open mouth smileys smile happy emotion","😯":"hushed face smileys smile happy emotion","😲":"astonished face smileys smile happy emotion","😳":"flushed face smileys smile happy emotion","🥺":"face with pleading eyes smileys smile happy emotion","😦":"frowning face with open mouth smileys smile happy emotion","😧":"anguished face smileys smile happy emotion","😨":"fearful face smileys smile happy emotion","😰":"face with open mouth and cold sweat smileys smile happy emotion","😥":"disappointed but relieved face smileys smile happy emotion","😢":"crying face smileys smile happy emotion cry tear sad","😭":"loudly crying face smileys smile happy emotion cry tear sad sob","😱":"face screaming in fear smileys smile happy emotion","😖":"confounded face smileys smile happy emotion","😣":"persevering face smileys smile happy emotion","😞":"disappointed face smileys smile happy emotion","😓":"face with cold sweat smileys smile happy emotion","😩":"weary face smileys smile happy emotion","😫":"tired face smileys smile happy emotion","🥱":"yawning face smileys smile happy emotion","😤":"face with look of triumph smileys smile happy emotion","😡":"pouting face smileys smile happy emotion","😠":"angry face smileys smile happy emotion","🤬":"serious face withs covering mouth smileys smile happy emotion","😈":"smiling face with horns smileys smile happy emotion","👿":"imp smileys smile happy face emotion","💀":"skull smileys smile happy face emotion","☠️":"skull and crossbones smileys smile happy face emotion","💩":"pile of poo smileys smile happy face emotion poop funny","🤡":"clown face smileys smile happy emotion","👹":"japanese ogre smileys smile happy face emotion","👺":"japanese goblin smileys smile happy face emotion","👻":"ghost smileys smile happy face emotion","👽":"extraterrestrial alien smileys smile happy face emotion","👾":"alien monster smileys smile happy face emotion","🤖":"robot face smileys smile happy emotion","👋":"waving hand people person human wave hi hello hey bye","🤚":"raised back of hand people person human","🖐️":"raised hand with fingers splayed people person human","✋":"raised hand people person human","🖖":"raised hand with part between middle and ring fingers people person human","👌":"ok hand people person human","🤌":"pinched fingers people person human","🤏":"pinching hand people person human","✌️":"victory hand people person human","🤞":"hand with index and middle fingers crossed people person human","🤟":"i love you hand people person human","🤘":"sign of the horns people person human","🤙":"call me hand people person human","👈":"white left pointing backhand index people person human","👉":"white right pointing backhand index people person human","👆":"white up pointing backhand index people person human","🖕":"reversed hand with middle finger extended people person human","👇":"white down pointing backhand index people person human","☝️":"white up pointing index people person human","👍":"thumbs up people person human like yes approve","👎":"thumbs down people person human dislike no","✊":"raised fist people person human","👊":"fisted hand people person human","🤛":"left-facing fist people person human","🤜":"right-facing fist people person human","👏":"clapping hands people person human","🙌":"person raising both hands in celebration people human","👐":"open hands people person human","🤲":"palms up together people person human","🤝":"handshake people person human","🙏":"person with folded hands people human","✍️":"writing hand people person human","💅":"nail polish people person human","🤳":"selfie people person human","💪":"flexed biceps people person human","🦾":"mechanical arm people person human","🦿":"mechanical leg people person human","🦵":"leg people person human","🦶":"foot people person human","👂":"ear people person human","🦻":"ear with hearing aid people person human","👃":"nose people person human","🧠":"brain people person human","🫀":"anatomical heart people person human","🫁":"lungs people person human","🦷":"tooth people person human","🦴":"bone people person human","👀":"eyes people person human","👁️":"eye people person human","👅":"tongue people person human","👄":"mouth people person human","👶":"baby people person human","🧒":"child people person human","👦":"boy people person human","👧":"girl people person human","🧑":"adult people person human","👱":"person with blond hair people human","👨":"man people person human","🧔":"bearded person people human","👩":"woman people person human","🧓":"older adult people person human","👴":"older man people person human","👵":"older woman people person human","🙍":"person frowning people human","🙎":"person with pouting face people human","🙅":"face with no good gesture people person human","🙆":"face with ok gesture people person human","💁":"information desk person people human","🙋":"happy person raising one hand people human","🧏":"deaf person people human","🙇":"person bowing deeply people human","🤦":"face palm people person human","🤷":"shrug people person human","👮":"police officer people person human","🕵️":"sleuth or spy people person human","💂":"guardsman people person human","🥷":"ninja people person human","👷":"construction worker people person human","🤴":"prince people person human","👸":"princess people person human","👳":"man with turban people person human","👲":"man with gua pi mao people person human","🧕":"person with headscarf people human","🤵":"man in tuxedo people person human","👰":"bride with veil people person human","🤰":"pregnant woman people person human","🤱":"breast-feeding people person human","👼":"baby angel people person human","🎒":"school satchel people person human","👑":"crown people person human","📿":"prayer beads people person human","💄":"lipstick people person human","💍":"ring people person human","💎":"gem stone people person human","🐱":"cat face animals animal kitty kitten","🐶":"dog face animals animal puppy","🐕":"dog animals animal","🐩":"poodle animals animal","🐺":"wolf face animals animal","🦊":"fox face animals animal","🦄":"unicorn face animals animal","🐴":"horse face animals animal","🐎":"horse animals animal","🦓":"zebra face animals animal","🦌":"deer animals animal","🦒":"giraffe face animals animal","🦏":"rhinoceros animals animal","🦛":"hippopotamus animals animal","🐘":"elephant animals animal","🦣":"mammoth animals animal","🐁":"mouse animals animal","🐀":"rat animals animal","🐹":"hamster face animals animal","🐰":"rabbit face animals animal","🐇":"rabbit animals animal","🐿️":"chipmunk animals animal","🦔":"hedgehog animals animal","🦇":"bat animals animal","🐻":"bear face animals animal","🐼":"panda face animals animal","🐨":"koala animals animal","🐯":"tiger face animals animal","🦁":"lion face animals animal","🐮":"cow face animals animal","🐷":"pig face animals animal","🐽":"pig nose animals animal","🐸":"frog face animals animal","🐵":"monkey face animals animal","🙈":"see-no-evil monkey animals animal","🙉":"hear-no-evil monkey animals animal","🙊":"speak-no-evil monkey animals animal","🐒":"monkey animals animal","🐔":"chicken animals animal","🐧":"penguin animals animal","🐦":"bird animals animal","🐤":"baby chick animals animal","🦆":"duck animals animal","🦅":"eagle animals animal","🦉":"owl animals animal","🐗":"boar animals animal","🐝":"honeybee animals animal","🪱":"worm animals animal","🐛":"bug animals animal","🦋":"butterfly animals animal","🐌":"snail animals animal","🐞":"lady beetle animals animal","🐜":"ant animals animal","🪰":"fly animals animal","🪲":"beetle animals animal","🪳":"cockroach animals animal","🦟":"mosquito animals animal","🦗":"cricket animals animal","🕷️":"spider animals animal","🕸️":"spider web animals animal","🦂":"scorpion animals animal","🐢":"turtle animals animal","🐍":"snake animals animal","🦎":"lizard animals animal","🦖":"t-rex animals animal","🦕":"sauropod animals animal","🐙":"octopus animals animal","🦑":"squid animals animal","🦐":"shrimp animals animal","🦞":"lobster animals animal","🦀":"crab animals animal","🐡":"blowfish animals animal","🐠":"tropical fish animals animal","🐟":"fish animals animal","🐬":"dolphin animals animal","🐳":"spouting whale animals animal","🐋":"whale animals animal","🦈":"shark animals animal","🐊":"crocodile animals animal","🐅":"tiger animals animal","🐆":"leopard animals animal","🦍":"gorilla animals animal","🦧":"orangutan animals animal","🍔":"hamburger food drink eat burger","🍕":"slice of pizza food drink eat","🌭":"hot dog food drink eat","🍟":"french fries food drink eat","🍿":"popcorn food drink eat","🧂":"salt shaker food drink eat","🥓":"bacon food drink eat","🥚":"egg food drink eat","🍳":"cooking food drink eat","🧇":"waffle food drink eat","🥞":"pancakes food drink eat","🧈":"butter food drink eat","🍞":"bread food drink eat","🥐":"croissant food drink eat","🥨":"pretzel food drink eat","🥯":"bagel food drink eat","🥖":"baguette bread food drink eat","🧀":"cheese wedge food drink eat","🥗":"green salad food drink eat","🥙":"stuffed flatbread food drink eat","🥪":"sandwich food drink eat","🌮":"taco food drink eat","🌯":"burrito food drink eat","🫔":"tamale food drink eat","🥫":"canned food drink eat","🍝":"spaghetti food drink eat","🍜":"steaming bowl food drink eat","🍲":"pot of food drink eat","🍛":"curry and rice food drink eat","🍣":"sushi food drink eat","🍱":"bento box food drink eat","🥟":"dumpling food drink eat","🦪":"oyster food drink eat","🍤":"fried shrimp food drink eat","🍙":"rice ball food drink eat","🍚":"cooked rice food drink eat","🍘":"rice cracker food drink eat","🍥":"fish cake with swirl design food drink eat","🥠":"fortune cookie food drink eat","🥮":"moon cake food drink eat","🍢":"oden food drink eat","🍡":"dango food drink eat","🍧":"shaved ice food drink eat","🍨":"ice cream food drink eat","🍦":"soft ice cream food drink eat","🥧":"pie food drink eat","🧁":"cupcake food drink eat","🍰":"shortcake food drink eat","🎂":"birthday cake food drink eat","🍮":"custard food drink eat","🍭":"lollipop food drink eat","🍬":"candy food drink eat","🍫":"chocolate bar food drink eat","🍩":"doughnut food drink eat","🍪":"cookie food drink eat","🌰":"chestnut food drink eat","🥜":"peanuts food drink eat","🍯":"honey pot food drink eat","🥛":"glass of milk food drink eat","🍼":"baby bottle food drink eat","☕":"hot beverage food drink eat","🫖":"teapot food drink eat","🍵":"teacup without handle food drink eat","🧃":"beverage box food drink eat","🥤":"cup with straw food drink eat","🧋":"bubble tea food drink eat","🍶":"sake bottle and cup food drink eat","🍺":"beer mug food drink eat","🍻":"clinking beer mugs food drink eat","🥂":"clinking glasses food drink eat","🍷":"wine glass food drink eat","🥃":"tumbler glass food drink eat","🍸":"cocktail glass food drink eat","🍹":"tropical drink food eat","🧉":"mate drink food eat","🍾":"bottle with popping cork food drink eat","🧊":"ice cube food drink eat","✈️":"airplane travel transport plane flight","🚀":"rocket travel transport space ship launch","🛸":"flying saucer travel transport","🚁":"helicopter travel transport","🛶":"canoe travel transport","⛵":"sailboat travel transport","🚤":"speedboat travel transport","🛥️":"motor boat travel transport","🛳️":"passenger ship travel transport","🚢":"ship travel transport","🚂":"steam locomotive travel transport","🚃":"railway car travel transport","🚄":"high-speed train travel transport","🚅":"high-speed train with bullet nose travel transport","🚆":"train travel transport","🚇":"metro travel transport","🚈":"light rail travel transport","🚉":"station travel transport","🚊":"tram travel transport","🚝":"monorail travel transport","🚞":"mountain railway travel transport","🚋":"tram car travel transport","🚌":"bus travel transport","🚍":"oncoming bus travel transport","🚎":"trolleybus travel transport","🚐":"minibus travel transport","🚑":"ambulance travel transport","🚒":"fire engine travel transport","🚓":"police car travel transport","🚔":"oncoming police car travel transport","🚕":"taxi travel transport","🚖":"oncoming taxi travel transport","🚗":"automobile travel transport","🚘":"oncoming automobile travel transport","🚙":"recreational vehicle travel transport","🛻":"pickup truck travel transport","🚚":"delivery truck travel transport","🚛":"articulated lorry travel transport","🚜":"tractor travel transport","🏎️":"racing car travel transport","🏍️":"racing motorcycle travel transport","🛵":"motor scooter travel transport","🚲":"bicycle travel transport","🛴":"scooter travel transport","🛹":"skateboard travel transport","🛼":"roller skate travel transport","🚏":"bus stop travel transport","🛤️":"railway track travel transport","🛣️":"motorway travel transport","🗺️":"world map travel transport","🗿":"moyai travel transport","🗽":"statue of liberty travel transport","🗼":"tokyo tower travel transport","🏰":"european castle travel transport","🏯":"japanese castle travel transport","🏟️":"stadium travel transport","🎡":"ferris wheel travel transport","🎢":"roller coaster travel transport","🎠":"carousel horse travel transport","⛲":"fountain travel transport","⛱️":"umbrella on ground travel transport","🏖️":"beach with umbrella travel transport","🏝️":"desert island travel transport","🏜️":"desert travel transport","🌋":"volcano travel transport","⛰️":"mountain travel transport","🏔️":"snow capped mountain travel transport","🗻":"mount fuji travel transport","🏕️":"camping travel transport","⛺":"tent travel transport","🛖":"hut travel transport","🏠":"house building travel transport","🏡":"house with garden travel transport","🏘️":"house buildings travel transport","🏚️":"derelict house building travel transport","🏗️":"building construction travel transport","🏭":"factory travel transport","🏢":"office building travel transport","🏬":"department store travel transport","🏣":"japanese post office travel transport","🏤":"european post office travel transport","🏥":"hospital travel transport","🏦":"bank travel transport","🏨":"hotel travel transport","🏪":"convenience store travel transport","🏫":"school travel transport","🏩":"love hotel travel transport","💒":"wedding travel transport","🏛️":"classical building travel transport","⛪":"church travel transport","🕌":"mosque travel transport","🕍":"synagogue travel transport","🛕":"hindu temple travel transport","🕋":"kaaba travel transport","⛩️":"shinto shrine travel transport","⚽":"soccer ball activities sport game play football","🏀":"basketball and hoop activities sport game play","🏈":"american football activities sport game play","⚾":"baseball activities sport game play","🥎":"softball activities sport game play","🎾":"tennis racquet and ball activities sport game play","🏐":"volleyball activities sport game play","🏉":"rugby football activities sport game play","🥏":"flying disc activities sport game play","🎱":"billiards activities sport game play","🪀":"yo-yo activities sport game play","🏓":"table tennis paddle and ball activities sport game play","🏸":"badminton racquet and shuttlecock activities sport game play","🏒":"ice hockey stick and puck activities sport game play","🏑":"field hockey stick and ball activities sport game play","🥍":"lacrosse stick and ball activities sport game play","🏏":"cricket bat and ball activities sport game play","🪃":"boomerang activities sport game play","🥅":"goal net activities sport game play","⛳":"flag in hole activities sport game play","🪁":"kite activities sport game play","🏹":"bow and arrow activities sport game play","🎣":"fishing pole and fish activities sport game play","🤿":"diving mask activities sport game play","🥊":"boxing glove activities sport game play","🥋":"martial arts uniform activities sport game play","🎽":"running shirt with sash activities sport game play","🛷":"sled activities sport game play","⛸️":"ice skate activities sport game play","🥌":"curling stone activities sport game play","🎿":"ski and boot activities sport game play","⛷️":"skier activities sport game play","🏂":"snowboarder activities sport game play","🪂":"parachute activities sport game play","🏋️":"weight lifter activities sport game play","🤼":"wrestlers activities sport game play","🤸":"person doing cartwheel activities sport game play","⛹️":"person with ball activities sport game play","🤺":"fencer activities sport game play","🤾":"handball activities sport game play","🏌️":"golfer activities sport game play","🏇":"horse racing activities sport game play","🧘":"person in lotus position activities sport game play","🏄":"surfer activities sport game play","🏊":"swimmer activities sport game play","🤽":"water polo activities sport game play","🚣":"rowboat activities sport game play","🧗":"person climbing activities sport game play","🚵":"mountain bicyclist activities sport game play","🚴":"bicyclist activities sport game play","🏆":"trophy activities sport game play","🥇":"first place medal activities sport game play","🥈":"second place medal activities sport game play","🥉":"third place medal activities sport game play","🏅":"sports medal activities sport game play","🎖️":"military medal activities sport game play","🏵️":"rosette activities sport game play","🎗️":"reminder ribbon activities sport game play","🎫":"ticket activities sport game play","🎟️":"admission tickets activities sport game play","🎪":"circus tent activities sport game play","🤹":"juggling activities sport game play","🎭":"performing arts activities sport game play","🩰":"ballet shoes activities sport game play","🎨":"artist palette activities sport game play","🎬":"clapper board activities sport game play","🎤":"microphone activities sport game play","🎧":"headphone activities sport game play","🎼":"musical score activities sport game play","🎹":"musical keyboard activities sport game play","🥁":"drum with drumsticks activities sport game play","🪘":"long drum activities sport game play","🎷":"saxophone activities sport game play","🎺":"trumpet activities sport game play","🪗":"accordion activities sport game play","🎸":"guitar activities sport game play","🪕":"banjo activities sport game play","🎻":"violin activities sport game play","🎲":"game die activities sport play","♟️":"black chess pawn activities sport game play","🎯":"direct hit activities sport game play","🎳":"bowling activities sport game play","🎮":"video game activities sport play","🕹️":"joystick activities sport game play","🎰":"slot machine activities sport game play","💡":"electric light bulb objects object tool idea","🔦":"electric torch objects object tool","🏮":"izakaya lantern objects object tool","🪔":"diya lamp objects object tool","📱":"mobile phone objects object tool","💻":"personal computer objects object tool","🖥️":"desktop computer objects object tool","🖨️":"printer objects object tool","⌨️":"keyboard objects object tool","🖱️":"three button mouse objects object tool","🖲️":"trackball objects object tool","💽":"minidisc objects object tool","💾":"floppy disk objects object tool","💿":"optical disc objects object tool","📀":"dvd objects object tool","📼":"videocassette objects object tool","📷":"camera objects object tool","📸":"camera with flash objects object tool","📹":"video camera objects object tool","🎥":"movie camera objects object tool","📽️":"film projector objects object tool","🎞️":"film frames objects object tool","📞":"telephone receiver objects object tool","☎️":"black telephone objects object tool","📟":"pager objects object tool","📠":"fax machine objects object tool","📺":"television objects object tool","📻":"radio objects object tool","🧭":"compass objects object tool","⏱️":"stopwatch objects object tool","⏲️":"timer clock objects object tool","🕰️":"mantelpiece clock objects object tool","⌛":"hourglass objects object tool","⏳":"hourglass with flowing sand objects object tool","⏰":"alarm clock objects object tool","🕓":"clock face four oclock objects object tool","📡":"satellite antenna objects object tool","🔋":"battery objects object tool","🔌":"electric plug objects object tool","💵":"banknote with dollar objects object tool","💴":"banknote with yen objects object tool","💶":"banknote with euro objects object tool","💷":"banknote with pound objects object tool","💰":"money bag objects object tool","💳":"credit card objects object tool","⚖️":"scales objects object tool","🪜":"ladder objects object tool","🧰":"toolbox objects object tool","🪛":"screwdriver objects object tool","🔧":"wrench objects object tool","🔨":"hammer objects object tool","⚒️":"hammer and pick objects object tool","🛠️":"hammer and wrench objects object tool","⛏️":"pick objects object tool","🪚":"carpentry saw objects object tool","🔩":"nut and bolt objects object tool","⚙️":"gear objects object tool","🪤":"mouse trap objects object tool","🧱":"brick objects object tool","⛓️":"chains objects object tool","🧲":"magnet objects object tool","🔫":"pistol objects object tool","💣":"bomb objects object tool","🧨":"firecracker objects object tool","🪓":"axe objects object tool","🔪":"hocho objects object tool","🗡️":"dagger knife objects object tool","⚔️":"crossed swords objects object tool","🛡️":"shield objects object tool","🚬":"smoking objects object tool","⚰️":"coffin objects object tool","🪦":"headstone objects object tool","⚱️":"funeral urn objects object tool","🏺":"amphora objects object tool","🔮":"crystal ball objects object tool","🧿":"nazar amulet objects object tool","💈":"barber pole objects object tool","⚗️":"alembic objects object tool","🔭":"telescope objects object tool","🔬":"microscope objects object tool","🕳️":"hole objects object tool","🩹":"adhesive bandage objects object tool","🩺":"stethoscope objects object tool","💊":"pill objects object tool","💉":"syringe objects object tool","🩸":"drop of blood objects object tool","🧬":"dna double helix objects object tool","🦠":"microbe objects object tool","🧫":"petri dish objects object tool","🧪":"test tube objects object tool","❤️":"heavy black heart symbols symbol sign love red","🧡":"orange heart symbols symbol sign","💛":"yellow heart symbols symbol sign","💚":"green heart symbols symbol sign","💙":"blue heart symbols symbol sign","💜":"purple heart symbols symbol sign","🖤":"black heart symbols symbol sign","🤍":"white heart symbols symbol sign","🤎":"brown heart symbols symbol sign","💔":"broken heart symbols symbol sign heartbreak sad","❣️":"heavy heart exclamation mark ornament symbols symbol sign","💕":"two hearts symbols symbol sign","💞":"revolving hearts symbols symbol sign","💓":"beating heart symbols symbol sign","💗":"growing heart symbols symbol sign","💖":"sparkling heart symbols symbol sign","💘":"heart with arrow symbols symbol sign","💝":"heart with ribbon symbols symbol sign","💟":"heart decoration symbols symbol sign","☮️":"peace symbols symbol sign","✝️":"latin cross symbols symbol sign","☪️":"star and crescent symbols symbol sign","🕉️":"om symbols symbol sign","☸️":"wheel of dharma symbols symbol sign","✡️":"star of david symbols symbol sign","🔯":"six pointed star with middle dot symbols symbol sign","🕎":"menorah with nine branches symbols symbol sign","☯️":"yin yang symbols symbol sign","☦️":"orthodox cross symbols symbol sign","🛐":"place of worship symbols symbol sign","⛎":"ophiuchus symbols symbol sign","♈":"aries symbols symbol sign","♉":"taurus symbols symbol sign","♊":"gemini symbols symbol sign","♋":"cancer symbols symbol sign","♌":"leo symbols symbol sign","♍":"virgo symbols symbol sign","♎":"libra symbols symbol sign","♏":"scorpius symbols symbol sign","♐":"sagittarius symbols symbol sign","♑":"capricorn symbols symbol sign","♒":"aquarius symbols symbol sign","♓":"pisces symbols symbol sign","🆔":"squared id symbols symbol sign","⚛️":"atom symbols symbol sign","🉑":"circled ideograph accept symbols symbol sign","☢️":"radioactive symbols symbol sign","☣️":"biohazard symbols symbol sign","📴":"mobile phone off symbols symbol sign","📳":"vibration mode symbols symbol sign","🈶":"squared cjk unified ideograph-6709 symbols symbol sign","🈚":"squared cjk unified ideograph-7121 symbols symbol sign","🈸":"squared cjk unified ideograph-7533 symbols symbol sign","🈺":"squared cjk unified ideograph-55b6 symbols symbol sign","🈷️":"squared cjk unified ideograph-6708 symbols symbol sign","✴️":"eight pointed black star symbols symbol sign","🆚":"squared vs symbols symbol sign","💮":"white flower symbols symbol sign","🉐":"circled ideograph advantage symbols symbol sign","㊙️":"circled ideograph secret symbols symbol sign","㊗️":"circled ideograph congratulation symbols symbol sign","🈴":"squared cjk unified ideograph-5408 symbols symbol sign","🈵":"squared cjk unified ideograph-6e80 symbols symbol sign","🈹":"squared cjk unified ideograph-5272 symbols symbol sign","🈲":"squared cjk unified ideograph-7981 symbols symbol sign","🅰️":"negative squared latin capital letter a symbols symbol sign","🅱️":"negative squared latin capital letter b symbols symbol sign","🆎":"negative squared ab symbols symbol sign","🆑":"squared cl symbols symbol sign","🅾️":"negative squared latin capital letter o symbols symbol sign","🆘":"squared sos symbols symbol sign","⛔":"no entry symbols symbol sign","📛":"name badge symbols symbol sign","🔞":"no one under eighteen symbols symbol sign","🔃":"clockwise downwards and upwards open circle arrows symbols symbol sign","🔄":"anticlockwise downwards and upwards open circle arrows symbols symbol sign","🔙":"back with leftwards arrow above symbols symbol sign","🔛":"on with exclamation mark left right arrow above symbols symbol sign","🔝":"top with upwards arrow above symbols symbol sign","✅":"white heavy check mark symbols symbol sign","❎":"negative squared cross mark symbols symbol sign","🈯":"squared cjk unified ideograph-6307 symbols symbol sign","💹":"chart with upwards trend and yen symbols symbol sign","❇️":"sparkle symbols symbol sign","✳️":"eight spoked asterisk symbols symbol sign","✔️":"heavy check mark symbols symbol sign","☑️":"ballot box with check symbols symbol sign","🔘":"radio button symbols symbol sign","🔰":"japanese for beginner symbols symbol sign","🈳":"squared cjk unified ideograph-7a7a symbols symbol sign","🈂️":"squared katakana sa symbols symbol sign","♻️":"black universal recycling symbols symbol sign","🔱":"trident emblem symbols symbol sign","🏁":"chequered flag flags country","🚩":"triangular flag on post flags country","🎌":"crossed flags flag country","🏴":"waving black flag flags country","🏳️":"waving white flag flags country","🏳️‍🌈":"waving white flag rainbow flags country","🏳️‍⚧️":"waving white flag male with stroke and female flags country","🏴‍☠️":"waving black flag skull and crossbones flags country","🇦🇨":"flags flag country ac","🇦🇩":"flags flag country ad","🇦🇪":"flags flag country ae","🇦🇫":"flags flag country af","🇦🇬":"flags flag country ag","🇦🇮":"flags flag country ai","🇦🇱":"flags flag country al","🇦🇲":"flags flag country am","🇦🇴":"flags flag country ao","🇦🇶":"flags flag country aq","🇦🇷":"flags flag country ar","🇦🇸":"flags flag country as","🇦🇹":"flags flag country at","🇦🇺":"flags flag country au","🇦🇼":"flags flag country aw","🇦🇽":"flags flag country ax","🇦🇿":"flags flag country az","🇧🇦":"flags flag country ba","🇧🇧":"flags flag country bb","🇧🇩":"flags flag country bd","🇧🇪":"flags flag country be","🇧🇫":"flags flag country bf","🇧🇬":"flags flag country bg","🇧🇭":"flags flag country bh","🇧🇮":"flags flag country bi","🇧🇯":"flags flag country bj","🇧🇱":"flags flag country bl","🇧🇲":"flags flag country bm","🇧🇳":"flags flag country bn","🇧🇴":"flags flag country bo","🇧🇶":"flags flag country bq","🇧🇷":"flags flag country br","🇧🇸":"flags flag country bs","🇧🇹":"flags flag country bt","🇧🇻":"flags flag country bv","🇧🇼":"flags flag country bw","🇧🇾":"flags flag country by","🇧🇿":"flags flag country bz","🇨🇦":"flags flag country ca","🇨🇨":"flags flag country cc","🇨🇩":"flags flag country cd","🇨🇫":"flags flag country cf","🇨🇬":"flags flag country cg","🇨🇭":"flags flag country ch","🇨🇮":"flags flag country ci","🇨🇰":"flags flag country ck","🇨🇱":"flags flag country cl","🇨🇲":"flags flag country cm","🇨🇳":"flags flag country cn","🇨🇴":"flags flag country co","🇨🇵":"flags flag country cp","🇨🇷":"flags flag country cr","🇨🇺":"flags flag country cu","🇨🇻":"flags flag country cv","🇨🇼":"flags flag country cw","🇨🇽":"flags flag country cx","🇨🇾":"flags flag country cy","🇨🇿":"flags flag country cz"};

const EMOJI_SEARCH_INDEX = Object.entries(EMOJI_CATEGORIES).flatMap(([cat, emojis]) =>
  emojis.map(e => ({ emoji: e, keywords: (EMOJI_KEYWORDS[e] || cat).toLowerCase() }))
);

function getEmojiStorage(key, fallback = []) {
  try {
    const raw = localStorage.getItem("notion-emoji-" + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function setEmojiStorage(key, value) {
  try { localStorage.setItem("notion-emoji-" + key, JSON.stringify(value)); } catch {}
}

function addToRecent(emoji) {
  let recent = getEmojiStorage("recent");
  recent = recent.filter(e => e !== emoji);
  recent.unshift(emoji);
  if (recent.length > 32) recent = recent.slice(0, 32);
  setEmojiStorage("recent", recent);
}

function togglePinned(emoji) {
  let pinned = getEmojiStorage("pinned");
  if (pinned.includes(emoji)) {
    pinned = pinned.filter(e => e !== emoji);
  } else {
    if (pinned.length >= 32) pinned = pinned.slice(1);
    pinned.push(emoji);
  }
  setEmojiStorage("pinned", pinned);
  return pinned;
}

function renderEmojiGrid(tab, search = "") {
  const grid = $("#emojiGrid");
  let emojis = [];

  if (search) {
    const q = search.toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const seen = new Set();
    emojis = EMOJI_SEARCH_INDEX
      .filter(e => {
        const toks = e.keywords.split(" ");
        return terms.every(t => e.emoji.includes(t) || toks.some(k => k.startsWith(t)));
      })
      .map(e => e.emoji)
      .filter(e => !seen.has(e) && (seen.add(e), true));
  } else if (tab === "recent") {
    emojis = getEmojiStorage("recent");
  } else if (tab === "pinned") {
    emojis = getEmojiStorage("pinned");
  } else if (EMOJI_CATEGORIES[tab]) {
    emojis = EMOJI_CATEGORIES[tab];
  }

  if (!emojis.length) {
    grid.innerHTML = `<div class="emoji-empty">${search ? "No emojis found" : "No " + tab + " emojis yet"}</div>`;
    return;
  }

  const pinned = getEmojiStorage("pinned");
  grid.innerHTML = emojis.map(e => {
    const isPinned = pinned.includes(e);
    return `<button class="emoji-item${isPinned ? " pinned" : ""}" data-emoji="${e}" title="${e}">${e}</button>`;
  }).join("");
}

let currentEmojiTab = "recent";

function openEmojiPicker() {
  const picker = $("#emojiPicker");
  picker.classList.add("open");
  $("#emojiSearch").value = "";
  const startTab = getEmojiStorage("recent").length ? "recent" : "smileys";
  renderEmojiGrid(startTab);
  currentEmojiTab = startTab;
  document.querySelectorAll(".emoji-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === startTab));
}

function closeEmojiPicker() {
  $("#emojiPicker").classList.remove("open");
}

async function copyEmoji(emoji) {
  try {
    await navigator.clipboard.writeText(emoji);
    addToRecent(emoji);
    setSaveState(`Copied ${emoji}`);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = emoji;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    addToRecent(emoji);
    setSaveState(`Copied ${emoji}`);
  }
}

$("#footerEmojiBtn").addEventListener("click", () => {
  sidebarUserMenu.classList.remove("open");
  sidebarMenuBtn.setAttribute("aria-expanded", "false");
  openEmojiPicker();
});

$("#emojiClose").addEventListener("click", closeEmojiPicker);

document.querySelectorAll(".emoji-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".emoji-tab").forEach(t => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab ? "true" : "false");
    });
    currentEmojiTab = tab.dataset.tab;
    renderEmojiGrid(tab.dataset.tab, $("#emojiSearch").value);
  });
});

$("#emojiSearch").addEventListener("input", (e) => {
  renderEmojiGrid(currentEmojiTab, e.target.value.trim().toLowerCase());
});

$("#emojiGrid").addEventListener("click", (e) => {
  const item = e.target.closest(".emoji-item");
  if (!item) return;
  const emoji = item.dataset.emoji;
  if (e.shiftKey) {
    const pinned = togglePinned(emoji);
    const isPinned = pinned.includes(emoji);
    item.classList.toggle("pinned", isPinned);
  } else {
    copyEmoji(emoji);
    closeEmojiPicker();
  }
});

document.addEventListener("mousedown", (e) => {
  const picker = $("#emojiPicker");
  if (picker.classList.contains("open") && !picker.contains(e.target) && !$("#footerEmojiBtn").contains(e.target)) {
    closeEmojiPicker();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#emojiPicker").classList.contains("open")) {
    closeEmojiPicker();
  }
});

initialize();
