
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
  saveInProgress: false,
  manualSaveTimer: null,
  // Robust save engine (Plan B): per-page verified gate + single-flight flusher.
  metaReady: false,
  flushTimer: null,
  flushing: false,
  flushQueued: false,
  sortOrder: (() => { try { return localStorage.getItem("notion-sort-order") || "modified"; } catch { return "modified"; } })()
};

// Tunables chosen for PythonAnywhere free tier: few, small requests.
const SAVE_DEBOUNCE_MS = 8000;
const VERIFY_TIMEOUT_MS = 8000;
const RETRY_DELAYS = [15000, 60000, 300000];

let editorWired = false;

const $ = (sel) => document.querySelector(sel);

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
    contentLoaded: true,
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
      updatedAt: page.updatedAt,
      rev: page.rev || 1,
      baseRev: page.baseRev ?? null,
      baseUpdatedAt: page.baseUpdatedAt ?? null,
      baseTitle: page.baseTitle ?? page.title,
      baseHash: page.baseHash ?? hashContent(page.blocks),
      dirty: !!page.dirty,
      isPublic: !!page.isPublic,
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
  // Don't spam IndexedDB with transient states; persist only meaningful ones.
  if (!persist) return;
  await persistNotification(text);
}

async function toggleNotificationPanel() {
  const panel = $("#notificationPanel");
  const isOpen = panel.classList.contains("open");
  if (isOpen) {
    panel.classList.remove("open");
  } else {
    panel.classList.add("open");
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
    alert("Export failed: " + err.message);
  });
}

function exportNote() {
  const page = state.pages.get(state.currentPageId);
  if (!page) return alert("No page open");
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
    alert("Import failed: " + (e.message || e));
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

function renderTree() {
  const root = $("#pageTree");
  root.innerHTML = "";
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
      checkbox.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSelection(page.id, e.ctrlKey || e.metaKey);
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
        if (e.ctrlKey || e.metaKey) {
          toggleSelection(page.id, true);
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

      const more = document.createElement("button");
      more.className = "page-more";
      more.textContent = "•••";
      more.title = "Page actions";
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, page.id);
      });
      const parts = [indent, checkbox, twisty, link, publicIndicator, more];
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

  root.addEventListener("click", (e) => {
    if (!e.target.closest(".tree-row")) {
      state.selected.clear();
      renderTree();
      renderSelectionBar();
    }
  });
}

function initRootDropZone() {
  const root = $("#pageTree");
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

function toggleSelection(pageId, additive) {
  if (additive) {
    if (state.selected.has(pageId)) {
      state.selected.delete(pageId);
    } else {
      state.selected.add(pageId);
    }
  } else {
    state.selected.clear();
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
  if (count === 0) {
    bar.innerHTML = "";
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML = `<span>${count} selected</span>
    <button class="sel-btn" data-action="delete">Delete</button>
    <button class="sel-btn" data-action="move">Move to...</button>
    <button class="sel-btn" data-action="clear">Clear</button>`;
  bar.querySelectorAll(".sel-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "delete") deleteSelected();
      else if (action === "move") moveSelectedPrompt();
      else if (action === "clear") { state.selected.clear(); renderTree(); renderSelectionBar(); }
    });
  });
}

async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} page(s)?`)) return;
  clearTimeout(state.flushTimer);
  for (const id of ids) {
    state.pages.delete(id);
    try { window.notifications.deleteDraft(id).catch(() => {}); } catch {}
    try { await window.api.deletePage(id); } catch {}
  }
  state.selected.clear();
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
  const pages = [...state.pages.values()].filter(p => !ids.includes(p.id));
  if (!pages.length) {
    const item = document.createElement("button");
    item.className = "context-item";
    item.textContent = "No pages available";
    item.disabled = true;
    menu.appendChild(item);
  } else {
    pages.forEach(p => {
      const item = document.createElement("button");
      item.className = "context-item";
      item.textContent = (p.parentId !== ROOT ? "  " : "") + (p.title || "Untitled");
      item.addEventListener("click", () => {
        closeContextMenu();
        ids.forEach(id => movePage(id, p.id));
        state.selected.clear();
        renderSelectionBar();
      });
      menu.appendChild(item);
    });
  }
  const rect = document.querySelector(".sidebar").getBoundingClientRect();
  menu.style.left = (rect.width / 2 - 90) + "px";
  menu.style.top = (rect.height / 2 - 100) + "px";
  menu.classList.add("open");
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
  });
  wireEditorInteractions();
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
  try { await idbOrFallback(window.notifications.saveState("lastPageId", id).catch(() => {}), 2000, null); } catch {}
  page.mountEpoch = (page.epoch || 0);
  // Mount cached copy instantly, locked until verified (stale-cache guard).
  const hadContent = page.blocks != null;
  page.contentLoaded = page.contentLoaded || hadContent;
  if (!page.blocks) page.blocks = [{type:"paragraph"}];
  $("#pageTitle").value = page.title || "Untitled";
  await mountEditor(page.blocks);
  setTimeout(() => renderAutoToc(), 80);
  state.expanded.add(page.id);
  renderTree();
  renderBreadcrumbs();
  updatePublicToggleUI();
  $("#workspace").scrollTop = 0;
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
          renderTree();
          renderBreadcrumbs();
          updatePublicToggleUI();
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
  const actions = [
    ["New sub-page", () => createPage(pageId)],
    ["Duplicate", () => duplicatePage(pageId)],
    ["Rename", () => { openPage(pageId).then(() => { const input = $("#pageTitle"); input.focus(); input.select(); }); }],
    ["Delete page", () => { if (confirm("Delete this page and all nested pages?")) deletePage(pageId); }],
  ];
  actions.forEach(([label, fn], idx) => {
    const b = document.createElement("button");
    b.className = "context-item" + (idx === 3 ? " context-danger" : "");
    b.textContent = label;
    b.addEventListener("click", () => { closeContextMenu(); fn(); });
    menu.appendChild(b);
  });
  menu.style.left = Math.min(x, window.innerWidth - 195) + "px";
  menu.style.top = Math.min(y, window.innerHeight - 130) + "px";
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
    const newParentId = p.parentId === pageId ? page.parentId : idMap.get(p.parentId);
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
function closeContextMenu() { $("#contextMenu").classList.remove("open"); }

function getCurrentBlock() {
  try { return state.editor?.getTextCursorPosition()?.block || null; } catch { return null; }
}

function currentBlockText(block) {
  if (!block) return "";
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) return block.content.map(x => typeof x === "string" ? x : (x?.text || "")).join("");
  return "";
}

function filteredCommands() {
  const f = state.slashFilter.toLowerCase();
  return BLOCKS.filter(b => !f || (b.label + " " + b.desc).toLowerCase().includes(f));
}

function positionSlashMenu() {
  const menu = $("#slashMenu");
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
  const left = Math.min(Math.max(12, r.left), window.innerWidth - 312);
  const top = Math.min(Math.max(12, r.bottom + 8), window.innerHeight - 350);
  menu.style.left = left + "px";
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
    menu.appendChild(item);
  });
  menu.classList.add("open");
  positionSlashMenu();
  requestAnimationFrame(() => {
    const selected = menu.querySelector(".slash-item.selected");
    if (selected) selected.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function closeSlashMenu() {
  const menu = $("#slashMenu");
  if (!menu.classList.contains("open")) return;
  menu.classList.remove("open");
  try {
    const block = getCurrentBlock();
    if (block) {
      const txt = currentBlockText(block);
      if (txt) {
        state.editor.updateBlock(block, { content: "" });
        state.editor.setTextCursorPosition(block.id, "start");
      }
    }
  } catch {}
  state.slashFilter = "";
  state.slashIndex = 0;
}

async function chooseSlash(command) {
  if (command.type === "page") {
    closeSlashMenu();
    if (state.dirty) await saveCurrent();
    await createPage(state.currentPageId);
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

function wireEditorInteractions() {
  if (editorWired) return;
  editorWired = true;
  const root = $("#editor");
  root.addEventListener("keydown", onEditorKeydown, true);
  root.addEventListener("keyup", onEditorKeyup, true);
  root.addEventListener("input", () => {
    const hint = document.querySelector(".hint");
    if (hint) hint.style.opacity = "0";
  }, { once: true });
  root.addEventListener("click", (e) => {
    closeSlashMenu();
    const blockOuter = e.target.closest(".bn-block-outer");
    if (blockOuter && e.target === blockOuter || e.target.closest(".bn-block-handle")) {
      const blockId = blockOuter?.dataset?.id;
      if (blockId) showBlockMenu(blockId, e.clientX, e.clientY);
    }
  });

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

const FORMAT_BUTTONS = [
  { label: "B", title: "Bold", shortcut: "Ctrl+B", action: () => document.execCommand("bold") },
  { label: "I", title: "Italic", shortcut: "Ctrl+I", action: () => document.execCommand("italic") },
  { label: "U", title: "Underline", shortcut: "Ctrl+U", action: () => document.execCommand("underline") },
  { label: "S", title: "Strikethrough", shortcut: "Ctrl+Shift+S", action: () => document.execCommand("strikeThrough") },
];

function showFormatToolbar() {
  const toolbar = $("#formatToolbar");
  toolbar.innerHTML = "";

  FORMAT_BUTTONS.forEach((btn, i) => {
    const button = document.createElement("button");
    button.className = "format-btn";
    button.textContent = btn.label;
    button.title = `${btn.title} (${btn.shortcut})`;
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    button.addEventListener("click", () => {
      btn.action();
    });
    toolbar.appendChild(button);

    if (i === 3) {
      const divider = document.createElement("div");
      divider.className = "format-divider";
      toolbar.appendChild(divider);
    }
  });

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  const left = Math.max(8, Math.min(rect.left + (rect.width / 2) - 100, window.innerWidth - 220));
  const top = rect.top - 45 + window.scrollY;

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
      epoch: 0, mountEpoch: 0, retryCount: 0, conflictServer: null,
      isPublic: Boolean(row.is_public ?? row.isPublic),
      _localOnly: fromServer ? false : !!row._localOnly,
      // Server-meta rows carry titles only; real blocks arrive via verify
      // fetch or drafts. false = never push this page until content loads.
      contentLoaded: fromServer ? false : !!row.blocks,
    });
    return;
  }
  if (fromServer) {
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
}

async function initialize() {
  // 1. Local drafts first: crash-safe truth, zero server cost.
  // Guarded with a timeout so a blocked IndexedDB upgrade (another open tab
  // holding the old version) can never hang boot with an empty sidebar.
  try {
    const drafts = await idbOrFallback(
      window.notifications.getAllDrafts().catch(() => []), 4000, []);
    for (const d of drafts || []) {
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
      });
    }
    if (drafts && drafts.length) renderTree();
  } catch (e) { console.warn("Draft load failed:", e); }

  let cachedMeta = null;
  // Same blocked-IDB guard as drafts: every IndexedDB await on the boot path
  // must time out, otherwise one wedged connection hangs the whole workspace.
  try { cachedMeta = await idbOrFallback(window.notifications.getState("pageListMeta").catch(() => null), 4000, null); } catch {}

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
    const serverIds = new Set((rows || []).map(r => r.id));
    for (const [id, pg] of [...state.pages]) {
      if (id === ROOT) continue;
      if (!serverIds.has(id) && !pg.dirty && !pg._localOnly && pg.baseRev != null) {
        state.pages.delete(id);
        // Fire-and-forget: must never stall boot on a wedged IndexedDB.
        try { window.notifications.deleteDraft(id).catch(() => {}); } catch {}
      }
    }
    try { await idbOrFallback(window.notifications.saveState("pageListMeta", rows).catch(() => {}), 4000, null); } catch {}
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
  let lastPageId = null;
  try { lastPageId = await idbOrFallback(window.notifications.getState("lastPageId").catch(() => null), 2000, null); } catch {}
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
    // Cascade to subpages in UI state so flow is clear
    function updateSubpages(parentId, isPublic) {
      const children = childrenOf(parentId);
      for (const child of children) {
        child.isPublic = isPublic;
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
          } else upsertPageMeta(sp, { fromServer: true });
        }
        try { await idbOrFallback(window.notifications.saveState("pageListMeta", syncPages).catch(() => {}), 2000, null); } catch {}
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
  const filter = filterText ? filterText.toLowerCase() : "";
  const filtered = filter ? allPages.filter(p => {
    const title = (p.title || "Untitled").toLowerCase();
    return title.includes(filter);
  }) : allPages;
  const sorted = filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 30);

  if (!sorted.length) {
    listEl.innerHTML = '<div class="quick-switch-empty">No pages found</div>';
    return;
  }
  listEl.innerHTML = sorted.map((p, i) => {
    const activeClass = i === 0 ? " selected" : "";
    const parentTitle = p.parentId !== ROOT ? (state.pages.get(p.parentId)?.title || "Root") : null;
    return `<button class="quick-switch-item${activeClass}" data-id="${escapeHtml(p.id)}" data-idx="${i}">
      <span class="qs-emoji">${escapeHtml(p.emoji || "")}</span>
      <span class="qs-title">${escapeHtml(p.title || "Untitled")}</span>
      ${parentTitle ? `<span class="qs-parent">${escapeHtml(parentTitle)}</span>` : ""}
    </button>`;
  }).join("");
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
    const selected = listEl.querySelector(".quick-switch-item.selected");
    if (selected) {
      const id = selected.dataset.id;
      closeQuickSwitch();
      if (id) openPage(id);
    }
    return true;
  }
  return false;
}

const listEl = $("#quickSwitchList");
$("#quickSwitchInput").addEventListener("input", (e) => renderQuickSwitch(e.target.value));
listEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".quick-switch-item");
  if (!btn) return;
  const id = btn.dataset.id;
  closeQuickSwitch();
  if (id) openPage(id);
});

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
  if (handleQuickSwitchKey(e)) return;
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

document.addEventListener("mousedown", (e) => {
  const slash = $("#slashMenu");
  if (slash.classList.contains("open") && !slash.contains(e.target)) closeSlashMenu();
  const ctx = $("#contextMenu");
  if (ctx.classList.contains("open") && !ctx.contains(e.target)) closeContextMenu();
});
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

const EMOJI_SEARCH_INDEX = Object.entries(EMOJI_CATEGORIES).flatMap(([cat, emojis]) =>
  emojis.map(e => ({ emoji: e, category: cat }))
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
    emojis = EMOJI_SEARCH_INDEX
      .filter(e => e.emoji.includes(q) || e.category.includes(q))
      .map(e => e.emoji);
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
  renderEmojiGrid(currentEmojiTab === "recent" || currentEmojiTab === "pinned" ? "" : currentEmojiTab, e.target.value);
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
