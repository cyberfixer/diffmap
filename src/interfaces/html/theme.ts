/**
 * Light / dark / auto. The choice is kept in the browser (localStorage key
 * "diffmap:theme") and applied as data-theme on <html>; "auto" follows the system.
 */

export const THEME_KEY = "diffmap:theme";

/** Runs in <head> before the page paints, so a saved choice never flashes the wrong colours. */
export const THEME_BOOT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

const ICONS = {
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 4v16" ></path><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"></path></svg>',
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"></path></svg>',
};

/** The header button: cycles Auto -> Light -> Dark. */
export const THEME_BUTTON = `<button class="theme" id="theme" type="button" title="Colour theme: follows your system" aria-label="Colour theme: Auto">${ICONS.auto}<span>Auto</span></button>
<script>
(function () {
  var KEY = "${THEME_KEY}", ORDER = ["auto", "light", "dark"], LABEL = { auto: "Auto", light: "Light", dark: "Dark" };
  var ICONS = ${JSON.stringify(ICONS)};
  var b = document.getElementById("theme"), root = document.documentElement;
  function current() { var t = root.getAttribute("data-theme"); return t === "light" || t === "dark" ? t : "auto"; }
  function show(t) {
    b.innerHTML = ICONS[t] + "<span>" + LABEL[t] + "</span>";
    b.setAttribute("aria-label", "Colour theme: " + LABEL[t]);
    b.title = t === "auto" ? "Colour theme: follows your system" : "Colour theme: " + LABEL[t].toLowerCase();
  }
  b.addEventListener("click", function () {
    var t = ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length];
    if (t === "auto") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", t);
    try { if (t === "auto") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch (e) { /* private mode */ }
    show(t);
  });
  show(current());
})();
</script>`;
