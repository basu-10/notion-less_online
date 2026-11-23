// Inline image support for table cells (and any other inline content area).
// BlockNote's default schema only allows text + links inside table cells, so
// we register a tiny atomic inline node that renders an <img>. The exported
// schema is shared by the workspace editor and the public page viewer so the
// same JSON round-trips in both places.

import {
  BlockNoteSchema,
  createInlineContentSpec,
} from "https://esm.sh/@blocknote/core@0.51.3?bundle";

export const CELL_IMAGE_TYPE = "cellImage";
const MIN_WIDTH = 48;

function applyWidth(img, width) {
  const w = Number(width) || 0;
  img.style.width = w > 0 ? `${Math.round(w)}px` : "";
}

function buildImage(props) {
  const img = document.createElement("img");
  const url = props.url || "";
  const caption = props.caption || "";
  img.src = url;
  img.alt = caption || "image";
  img.title = caption || "";
  img.loading = "lazy";
  img.decoding = "async";
  img.draggable = false;
  applyWidth(img, props.width);
  return img;
}

// Resize handles mirror BlockNote's block-image handles, but live inside the
// inline wrapper. Drag updates the image visually and stores the px width in
// the node's `width` prop on release so it survives save/reload and the
// public page.
function addResizeHandles(wrap, img, inlineContent, updateInlineContent) {
  let cleanup = null;

  const startResize = (event, side) => {
    try {
      event.preventDefault();
      event.stopPropagation();
    } catch {}
    const startX = event.clientX;
    const startWidth = img.getBoundingClientRect().width;
    const host = wrap.closest("p") || wrap.parentElement || wrap;
    const maxWidth = Math.max(
      MIN_WIDTH,
      (host && host.clientWidth ? host.clientWidth : 600) - 4
    );
    let width = startWidth;
    let pointerId = event.pointerId;
    wrap.classList.add("resizing");

    const onMove = (ev) => {
      if (pointerId != null && ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      let next = side === "left" ? startWidth - dx : startWidth + dx;
      next = Math.max(MIN_WIDTH, Math.min(maxWidth, next));
      width = next;
      img.style.width = `${Math.round(next)}px`;
    };
    const finish = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      wrap.classList.remove("resizing");
      cleanup = null;
      try {
        updateInlineContent({
          ...inlineContent,
          props: { ...inlineContent.props, width: Math.round(width) },
        });
      } catch (err) { console.warn("cell image resize failed", err); }
    };

    cleanup = finish;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  ["left", "right"].forEach((side) => {
    const handle = document.createElement("span");
    handle.className = `nl-cell-image-handle ${side}`;
    handle.setAttribute("contenteditable", "false");
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (e) => startResize(e, side));
    wrap.appendChild(handle);
  });

  return () => { if (cleanup) cleanup(); };
}

export const cellImageSpec = createInlineContentSpec(
  {
    type: CELL_IMAGE_TYPE,
    content: "none",
    propSchema: {
      url: { default: "" },
      caption: { default: "" },
      width: { default: 0 },
    },
  },
  {
    meta: { draggable: false },
    render(inlineContent, updateInlineContent, editor) {
      const wrap = document.createElement("span");
      wrap.className = "nl-cell-image";
      wrap.setAttribute("contenteditable", "false");
      const img = buildImage(inlineContent.props);
      wrap.appendChild(img);

      // Never show handles in the public viewer or in non-editable editors.
      const inPublicViewer = !!document.getElementById("publicEditor");
      if (editor && editor.isEditable && !inPublicViewer) {
        const destroyHandles = addResizeHandles(wrap, img, inlineContent, updateInlineContent);
        // Touch has no hover; a tap reveals the handles for a moment.
        let hideTimer = null;
        const reveal = () => {
          wrap.classList.add("show-handles");
          clearTimeout(hideTimer);
          hideTimer = setTimeout(() => wrap.classList.remove("show-handles"), 2500);
        };
        wrap.addEventListener("pointerdown", reveal);
        return {
          dom: wrap,
          destroy() {
            clearTimeout(hideTimer);
            wrap.removeEventListener("pointerdown", reveal);
            destroyHandles();
          },
        };
      }
      return { dom: wrap };
    },
    toExternalHTML(inlineContent) {
      const wrap = document.createElement("span");
      wrap.className = "nl-cell-image";
      wrap.appendChild(buildImage(inlineContent.props));
      return { dom: wrap };
    },
    parse(el) {
      // Only adopt bare <img> tags that already sit inside a table cell, so
      // pasted clipboard HTML lands as an inline cell image instead of a
      // stray block-level image. Our own serialized wrapper is handled by the
      // data-inline-content-type rule before this fallback runs.
      if (el.tagName !== "IMG") return undefined;
      if (typeof el.closest === "function" && !el.closest("td, th")) return undefined;
      return {
        url: el.getAttribute("src") || "",
        caption: el.getAttribute("alt") || "",
        width: Number(el.getAttribute("width")) || 0,
      };
    },
  }
);

let sharedSchema = null;

export function getCellImageSchema() {
  if (!sharedSchema) {
    sharedSchema = BlockNoteSchema.create().extend({
      inlineContentSpecs: { [CELL_IMAGE_TYPE]: cellImageSpec },
    });
  }
  return sharedSchema;
}
