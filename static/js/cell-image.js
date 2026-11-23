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

export const cellImageSpec = createInlineContentSpec(
  {
    type: CELL_IMAGE_TYPE,
    content: "none",
    propSchema: {
      url: { default: "" },
      caption: { default: "" },
    },
  },
  {
    meta: { draggable: false },
    render(inlineContent) {
      const wrap = document.createElement("span");
      wrap.className = "nl-cell-image";
      const img = document.createElement("img");
      const url = inlineContent.props.url || "";
      const caption = inlineContent.props.caption || "";
      img.src = url;
      img.alt = caption || "image";
      img.title = caption || "";
      img.loading = "lazy";
      img.decoding = "async";
      img.draggable = false;
      wrap.appendChild(img);
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
