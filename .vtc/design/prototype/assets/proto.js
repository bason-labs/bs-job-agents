/* Prototype behaviour: theme and state from the query string, icons, and small in-place interactions. No network, no scripts run from content. */
(function () {
  var q = new URLSearchParams(location.search);
  var theme = q.get("theme") || "light";
  if (["light", "dark", "grayscale"].indexOf(theme) < 0) theme = "light";
  document.documentElement.setAttribute("data-theme", theme);
  var states = (document.body.getAttribute("data-states") || "").split(" ");
  var state = q.get("state") || document.body.getAttribute("data-default-state");
  if (states.indexOf(state) < 0) state = document.body.getAttribute("data-default-state");
  document.body.setAttribute("data-state", state);

  document.querySelectorAll("[data-show]").forEach(function (el) {
    el.hidden = el.getAttribute("data-show").split(" ").indexOf(state) < 0;
  });

  var P = {
    key: "M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4",
    plug: "M12 22v-5M9 8V2m6 6V2M5 8h14v4a7 7 0 0 1-14 0z",
    window: "M3 4h18v16H3zM3 9h18",
    check: "M5 12l5 5 9-10",
    minus: "M5 12h14",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
    tri: "M12 3l10 18H2zM12 10v5M12 18h.01",
    chev: "M6 9l6 6 6-6",
    pencil: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
    x: "M6 6l12 12M18 6L6 18",
    wand: "M5 19L17 7m0 0l-2-2 2 2zM7 3v3M5.5 4.5h3M19 14v3M17.5 15.5h3"
  };
  document.querySelectorAll("i[data-icon]").forEach(function (el) {
    var d = P[el.getAttribute("data-icon")] || P.check;
    el.outerHTML = '<svg class="ic ' + el.className + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
  });

  // Keep the theme on every in-prototype link, and mark the active state link.
  var bar = document.querySelector(".proto");
  if (bar) {
    ["light", "dark", "grayscale"].forEach(function (t, i) {
      var a = document.createElement("a");
      a.href = "?state=" + state + "&theme=" + t;
      a.textContent = t + " theme";
      if (t === theme) a.setAttribute("aria-current", "true");
      if (i === 0) a.style.marginInlineStart = "auto";
      bar.appendChild(a);
    });
  }
  document.querySelectorAll("a[data-keeptheme]").forEach(function (a) {
    var u = new URL(a.getAttribute("href"), location.href);
    u.searchParams.set("theme", theme);
    a.setAttribute("href", u.pathname + u.search);
    if (u.searchParams.get("state") === state) a.setAttribute("aria-current", "true");
  });
  document.querySelectorAll("[data-goto-state]").forEach(function (b) {
    b.addEventListener("click", function () {
      location.search = "?state=" + b.getAttribute("data-goto-state") + "&theme=" + theme;
    });
  });

  // Source chips toggle in place.
  document.querySelectorAll(".chip").forEach(function (c) {
    c.addEventListener("click", function () {
      c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") === "true" ? "false" : "true");
    });
  });

  // Expand / collapse (activity entries, rejected drafts).
  document.querySelectorAll("[data-expands]").forEach(function (b) {
    var t = document.getElementById(b.getAttribute("data-expands"));
    b.setAttribute("aria-expanded", t && !t.hidden ? "true" : "false");
    b.addEventListener("click", function () {
      var open = b.getAttribute("aria-expanded") === "true";
      b.setAttribute("aria-expanded", open ? "false" : "true");
      if (t) t.hidden = open;
    });
  });

  // Drawer with focus return and Escape.
  var opener = null;
  function closeDrawer() {
    var d = document.querySelector("[data-drawer]");
    if (!d || d.hidden) return;
    d.hidden = true;
    if (opener) opener.focus();
  }
  document.querySelectorAll("[data-open-drawer]").forEach(function (b) {
    b.addEventListener("click", function () {
      opener = b;
      var d = document.querySelector("[data-drawer]");
      d.hidden = false;
      var h = d.querySelector("h2");
      if (h) h.focus();
    });
  });
  document.querySelectorAll("[data-close-drawer]").forEach(function (b) { b.addEventListener("click", closeDrawer); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
  if (state === "record-open") {
    var d0 = document.querySelector("[data-drawer]");
    if (d0) { d0.hidden = false; opener = document.querySelector("[data-open-drawer]"); }
  }

  // Inline edit in place.
  document.querySelectorAll("[data-edit]").forEach(function (b) {
    b.addEventListener("click", function () {
      var f = document.getElementById(b.getAttribute("data-edit"));
      f.setAttribute("data-editing", "");
      var t = f.querySelector("textarea"); if (t) t.focus();
    });
  });
  document.querySelectorAll("[data-done]").forEach(function (b) {
    b.addEventListener("click", function () {
      var f = document.getElementById(b.getAttribute("data-done"));
      var t = f.querySelector("textarea");
      var p = f.querySelector("[data-text]"); if (t && p) p.textContent = t.value;
      f.removeAttribute("data-editing");
      var e = f.querySelector("[data-edit-btn]"); if (e) e.focus();
    });
  });
  // Cited ids scroll to and focus the cited fact.
  document.querySelectorAll("[data-cite]").forEach(function (b) {
    b.addEventListener("click", function () {
      var f = document.getElementById("fact-" + b.getAttribute("data-cite"));
      if (f) { f.setAttribute("tabindex", "-1"); f.scrollIntoView(); f.focus(); }
    });
  });
  // Keep clears the flag in place.
  document.querySelectorAll("[data-keep]").forEach(function (b) {
    b.addEventListener("click", function () {
      var f = document.getElementById(b.getAttribute("data-keep"));
      f.removeAttribute("data-flag");
      f.querySelectorAll("[data-flagged]").forEach(function (x) { x.hidden = true; });
    });
  });
})();
