
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
  isOpeningPage: false
};

let editorWired = false;

const $ = (sel) => document.querySelector(sel);

function applyTheme(mode) {
  const html = document.documentElement;
  html.removeAttribute("data-theme");
  if (mode === "light") html.setAttribute("data-theme", "light");
  else if (mode === "dark") html.setAttribute("data-theme", "dark");
  else {
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    if (prefersDark) html.setAttribute("data-theme", "dark");
    else html.setAttribute("data-theme", "light");
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

function setSaveState(text) { $("#saveState").textContent = text; }

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
      row.className = "tree-row" + (page.id === state.currentPageId ? " active" : "");
      row.dataset.id = page.id;

      const indent = document.createElement("div");
      indent.className = "tree-indent";
      indent.style.width = (depth * 18) + "px";

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
      link.addEventListener("click", () => openPage(page.id));

      const more = document.createElement("button");
      more.className = "page-more";
      more.textContent = "•••";
      more.title = "Page actions";
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, page.id);
      });

      row.append(indent, twisty, emoji, link, more);
      root.appendChild(row);

      if (children.length && state.expanded.has(page.id)) walk(page.id, depth + 1);
    }
  };
  walk(ROOT, 0);
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
    ["Rename", () => { openPage(pageId).then(() => { const input = $("#pageTitle"); input.focus(); input.select(); }); }],
    ["Delete page", () => { if (confirm("Delete this page and all nested pages?")) deletePage(pageId); }],
  ];
  actions.forEach(([label, fn], idx) => {
    const b = document.createElement("button");
    b.className = "context-item" + (idx === 2 ? " context-danger" : "");
    b.textContent = label;
    b.addEventListener("click", () => { closeContextMenu(); fn(); });
    menu.appendChild(b);
  });
  menu.style.left = Math.min(x, window.innerWidth - 195) + "px";
  menu.style.top = Math.min(y, window.innerHeight - 130) + "px";
  menu.classList.add("open");
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
        const blockText = state.editor.getText(block.id);
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
$("#settingsBtn").addEventListener("click", () => $("#settingsPanel").classList.add("open"));
$("#closeSettings").addEventListener("click", () => $("#settingsPanel").classList.remove("open"));
document.addEventListener("mousedown", (e) => {
  const panel = $("#settingsPanel");
  if (panel.classList.contains("open") && !panel.contains(e.target) && !$("#settingsBtn").contains(e.target)) panel.classList.remove("open");
});

$("#exportProfile").addEventListener("click", exportProfile);
$("#exportNote").addEventListener("click", exportNote);
$("#importProfile").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", (e) => { if (e.target.files && e.target.files[0]) importProfile(e.target.files[0]); e.target.value = ""; });

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

initialize();
