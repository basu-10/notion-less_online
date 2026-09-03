function applyTheme(mode) {
  const html = document.documentElement;
  if (mode === "auto") {
    html.setAttribute("data-theme", "auto");
  } else {
    html.removeAttribute("data-theme");
    if (mode === "light" || mode === "dark") {
      html.setAttribute("data-theme", mode);
    }
  }
  try { localStorage.setItem("notion-theme", mode); } catch {}
  document.querySelectorAll(".theme-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.theme === mode);
  });
}

function getTheme() {
  try { return localStorage.getItem("notion-theme") || "light"; } catch { return "light"; }
}

function initTheme() {
  applyTheme(getTheme());
  document.querySelectorAll(".theme-btn").forEach(b => {
    b.addEventListener("click", () => applyTheme(b.dataset.theme));
  });
  try {
    const mql = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (mql && mql.addEventListener) {
      mql.addEventListener("change", () => { if (getTheme() === "auto") applyTheme("auto"); });
    }
  } catch {}
}

document.addEventListener("DOMContentLoaded", initTheme);
