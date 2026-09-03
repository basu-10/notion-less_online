
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
  manualSaveTimer: null
};

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

function makePage({ id=uid(), title="Untitled", parentId=ROOT, emoji="📄", blocks=defaultBlocks(title), collapsed=false }={}) {
  return { id, title, parentId, emoji, blocks, collapsed, updatedAt: Date.now() };
}

async function persistNotification(text) {
  try { await window.notifications.addNotification(text, "info"); } catch (e) { console.warn("Notification add failed:", e); }
}

async function setSaveState(text) {
  $("#saveState").textContent = text;
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
  const list = $("#notificationList");
  try {
    const notifications = await window.notifications.getNotifications(50);
    if (!notifications.length) {
      list.innerHTML = '<div class="notification-empty">No notifications</div>';
      return;
    }
    list.innerHTML = notifications.map(n => {
      const date = new Date(n.timestamp);
      const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const dateStr = date.toLocaleDateString();
      return `<div class="notification-item">
        <span class="notification-text">${escapeHtml(n.text)}</span>
        <span class="notification-time">${dateStr} ${time}</span>
      </div>`;
    }).join("");
  } catch (e) {
    list.innerHTML = '<div class="notification-empty">Failed to load</div>';
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

function markDirty() {
  state.dirty = true;
  setSaveState("Unsaved");
  $("#saveBtn").classList.add("visible");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCurrent, 3000);
}

async function saveCurrent() {
  if (state.isOpeningPage) return;
  const page = state.pages.get(state.currentPageId);
  if (!page || !state.editor) return;
  page.blocks = structuredClone(state.editor.document);
  page.title = $("#pageTitle").value.trim() || "Untitled";
  page.updatedAt = Date.now();
  state.pages.set(page.id, page);
  try {
    await window.api.updatePage(page.id, {
      title: page.title,
      content: JSON.stringify(page.blocks),
      parent_id: page.parentId
    });
  } catch (err) {
    console.error("Save failed:", err);
    setSaveState("Save failed");
    return;
  }
  state.dirty = false;
  $("#saveBtn").classList.remove("visible");
  setSaveState("Saved · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  renderTree();
  renderBreadcrumbs();
}

async function saveAll() {
  for (const page of state.pages.values()) {
    try {
      await window.api.updatePage(page.id, {
        title: page.title,
        content: JSON.stringify(page.blocks),
        parent_id: page.parentId
      });
    } catch (err) {
      console.error("Save failed:", err);
    }
  }
  state.dirty = false;
  $("#saveBtn").classList.remove("visible");
  setSaveState("All pages saved");
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
      const page = {
        id: p.id,
        title: p.title || "Untitled",
        content: p.content || p.blocks ? JSON.stringify(p.blocks || p.content) : "[]",
        parent_id: p.parentId || ROOT
      };
      state.pages.set(page.id, page);
      try {
        await window.api.createPage(page);
      } catch (err) {
        console.error("Failed to create page during import:", err, page);
      }
    }
    state.dirty = false; $("#saveBtn").classList.remove("visible");
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
    .sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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
      emoji.textContent = page.emoji;

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

      row.append(indent, checkbox, twisty, emoji, link, more);
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
  let cursor = state.pages.get(childId);
  while (cursor) {
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
  for (const id of ids) {
    state.pages.delete(id);
    try { await window.api.deletePage(id); } catch {}
  }
  state.selected.clear();
  if (!childrenOf(ROOT).length) {
    const welcome = makePage({ id: "welcome", title: "Welcome", parentId: ROOT, emoji: "👋" });
    state.pages.set(welcome.id, welcome);
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

function movePage(pageId, newParentId) {
  const page = state.pages.get(pageId);
  if (!page) return;
  if (isDescendant(pageId, newParentId)) return;
  page.parentId = newParentId;
  page.updatedAt = Date.now();
  state.pages.set(pageId, page);
  state.expanded.add(newParentId);
  window.api.updatePage(pageId, { parent_id: newParentId }).catch(console.error);
  renderTree();
  renderBreadcrumbs();
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
    const s = document.createElement("span");
    s.textContent = crumb.title || "Untitled";
    if (i === crumbs.length - 1) s.className = "crumb-current";
    el.appendChild(s);
    if (i < crumbs.length - 1) {
      const sep = document.createElement("span");
      sep.textContent = "/";
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
  });
  wireEditorInteractions();
}

async function openPage(id) {
  state.isOpeningPage = true;
  clearTimeout(state.saveTimer);
  if (state.dirty) await saveCurrent();
  const page = state.pages.get(id);
  if (!page) { state.isOpeningPage = false; return; }
  state.currentPageId = id;
  $("#pageTitle").value = page.title || "Untitled";
  await mountEditor(page.blocks);
  state.expanded.add(page.id);
  renderTree();
  renderBreadcrumbs();
  $("#workspace").scrollTop = 0;
  setSaveState("Loaded");
  state.isOpeningPage = false;
}

async function createPage(parentId=ROOT) {
  const page = makePage({ parentId, title: "Untitled", blocks: [{type:"paragraph", content:""}] });
  state.pages.set(page.id, page);
  state.expanded.add(parentId);
  try {
    await window.api.createPage({
      id: page.id,
      title: page.title,
      content: JSON.stringify(page.blocks),
      parent_id: page.parentId
    });
  } catch (err) {
    console.error("Failed to create page on server:", err);
  }
  await openPage(page.id);
  setTimeout(() => $("#pageTitle").focus(), 60);
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
    try { await window.api.deletePage(did); } catch {}
  }
  const remaining = childrenOf(ROOT);
  if (!remaining.length) {
    const welcome = makePage({ id: "welcome", title: "Welcome", parentId: ROOT, emoji: "👋" });
    state.pages.set(welcome.id, welcome);
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
    try {
      await window.api.createPage({
        id: newId,
        title: newPage.title,
        content: JSON.stringify(newPage.blocks),
        parent_id: newPage.parentId,
      });
    } catch (err) {
      console.error("Failed to create page during duplicate:", err);
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
    clearTimeout(state.manualSaveTimer);
    if (!state.saveInProgress && state.dirty) {
      state.saveInProgress = true;
      saveCurrent().finally(() => { state.saveInProgress = false; });
    } else if (!state.dirty) {
      setSaveState("Nothing to save");
    } else {
      state.manualSaveTimer = setTimeout(() => {
        if (!state.saveInProgress && state.dirty) {
          state.saveInProgress = true;
          saveCurrent().finally(() => { state.saveInProgress = false; });
        }
      }, 500);
    }
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

async function initialize() {
  try {
    const rows = await window.api.listPages();
    state.pages = new Map(rows.map(p => {
      let blocks = p.content;
      if (typeof blocks === "string") {
        try { blocks = JSON.parse(blocks); } catch { blocks = [{type:"paragraph"}]; }
      }
      return [p.id, {
        id: p.id,
        title: p.title || "Untitled",
        blocks: blocks,
        parentId: p.parent_id || ROOT,
        emoji: "📄",
        updatedAt: p.updated_at || Date.now()
      }];
    }));
  } catch (err) {
    console.error("Failed to load pages:", err);
  }

  if (!state.pages.size) {
    const welcome = makePage({ id: "welcome", title: "Welcome", emoji: "👋", parentId: ROOT });
    const project = makePage({ title: "Project Notes", emoji: "🗂️", parentId: welcome.id, blocks: [
      { type: "heading", props:{level:2}, content:"A nested page" },
      { type: "paragraph", content:"Create child pages from the sidebar's ••• menu." }
    ]});
    state.pages.set(welcome.id, welcome);
    state.pages.set(project.id, project);
    try {
      for (const p of [welcome, project]) {
        await window.api.createPage({
          id: p.id,
          title: p.title,
          content: JSON.stringify(p.blocks),
          parent_id: p.parentId
        });
      }
    } catch (err) {
      console.error("Failed to create initial pages:", err);
    }
  }

  state.expanded.add(ROOT);
  applyTheme(getTheme());
  initRootDropZone();
  const first = state.pages.get("welcome") || childrenOf(ROOT)[0];
  if (first) await openPage(first.id);
  setSaveState("Ready");
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
    $("#collapseAll").textContent = "−";
    $("#collapseAll").title = "Collapse all";
  } else {
    state.expanded = new Set([ROOT]);
    $("#collapseAll").textContent = "+";
    $("#collapseAll").title = "Show all";
  }
  renderTree();
});

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
$("#pageTitle").addEventListener("input", markDirty);
$("#pageTitle").addEventListener("blur", saveCurrent);
$("#pageTitle").addEventListener("keydown", (e) => {
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
window.addEventListener("beforeunload", () => {
  if (state.dirty) saveCurrent();
});

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

document.addEventListener("keydown", (e) => {
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

initialize();
