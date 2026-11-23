/* Codex 皮肤 — renderer payload, injected by skin-host.ps1 over CDP */
(function () {
  "use strict";
  var VERSION = "1.0.15";
  var GLOBAL_KEY = "__codexSkinRuntime";
  var LS_KEY = "codexSkin.v1";
  var DB_NAME = "codexSkin";
  var DB_STORE = "wallpapers";
  var SLOTS = 5;
  var STYLE_ID = "codex-skin-style";
  var WP_ID = "codex-skin-wallpaper";
  var PANEL_ID = "codex-skin-panel";
  var SECTION_ID = "codex-skin-section";
  var ON_CLASS = "codex-skin-on";
  var MAX_BYTES = 64 * 1024 * 1024;
  var DEFAULT_CONTROLS = { temperature: 0, saturation: 100, contrast: 100, scale: 100, opacity: 50, blur: 0, positionX: 50, positionY: 50 };
  var CONTROLS = [
    { key: "temperature", label: "色温" },
    { key: "saturation", label: "饱和度" },
    { key: "contrast", label: "对比度" },
    { key: "scale", label: "缩放" },
    { key: "opacity", label: "透明度" },
    { key: "blur", label: "模糊度" },
    { key: "positionX", label: "左右移动" },
    { key: "positionY", label: "上下移动" }
  ];

  /* 内置预设壁纸：纯 canvas 生成，不占插件文件也不进仓库 */
  var PRESETS = [
    { a: "#241a33", b: "#4a3566", c: "#8a6bb5", glow: "rgba(255,146,88,.22)" },
    { a: "#0d1a2b", b: "#1d4360", c: "#3f8fb0", glow: "rgba(120,200,255,.18)" },
    { a: "#241b14", b: "#4d3a25", c: "#8f6b42", glow: "rgba(255,190,110,.20)" },
    { a: "#101d18", b: "#22463a", c: "#3f7a62", glow: "rgba(140,255,200,.14)" }
  ];

  var previous = window[GLOBAL_KEY];
  if (previous) {
    if (previous.version === VERSION) { previous.ensure(); return; }
    /* 旧版本实例必须先收摊：否则它的 MutationObserver 和面板会一直活着 */
    try { if (previous.shutdown) previous.shutdown(); } catch (e) { }
  }

  var state = { activeSlot: null, controls: clone(DEFAULT_CONTROLS) };
  var urls = {};
  var pendingSlot = null;
  var observer = null;
  var syncTimer = null;
  var fileInput = null;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function clamp(n, a, b) { n = Number(n); if (!isFinite(n)) n = a; return Math.min(b, Math.max(a, n)); }
  function round(n) { return Math.round(n); }

  /* ---------- 滑杆值 ↔ 真实值（与 DNF AppearanceDialog 的 NUMERIC_CONTROLS 一致） ---------- */
  function toSlider(key, v) {
    switch (key) {
      case "temperature": return round((clamp(v, -100, 100) + 100) / 2);
      case "saturation": return round(clamp(v, 0, 200) / 2);
      case "contrast": return round(clamp(v, 0, 200) / 2);
      case "scale": return round(clamp(v, 50, 150) - 50);
      case "blur": return round(clamp(v, 0, 40) / 0.4);
      default: return round(clamp(v, 0, 100));
    }
  }
  function fromSlider(key, s) {
    s = clamp(s, 0, 100);
    switch (key) {
      case "temperature": return s * 2 - 100;
      case "saturation": return s * 2;
      case "contrast": return s * 2;
      case "scale": return s + 50;
      /* 整数先乘后除，避免 3*0.4 = 1.2000000000000002 这种脏值写进 localStorage */
      case "blur": return (s * 2) / 5;
      default: return s;
    }
  }

  /* ---------- 持久化：参数进 localStorage，壁纸进 IndexedDB ---------- */
  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && o.controls) {
        for (var k in DEFAULT_CONTROLS) {
          if (Object.prototype.hasOwnProperty.call(o.controls, k)) state.controls[k] = Number(o.controls[k]);
        }
      }
      if (o && typeof o.activeSlot === "number" && o.activeSlot >= 0 && o.activeSlot < SLOTS) state.activeSlot = o.activeSlot;
    } catch (e) { }
  }
  function saveState() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { }
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function dbRun(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, mode);
        var out = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : true); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      }).then(function (v) { db.close(); return v; }, function (e) { db.close(); throw e; });
    });
  }
  function dbGet(key) { return dbRun("readonly", function (s) { return s.get(key); }); }
  function dbPut(key, blob) { return dbRun("readwrite", function (s) { s.put(blob, key); return null; }); }
  function dbDel(key) { return dbRun("readwrite", function (s) { s.delete(key); return null; }); }
  function slotKey(i) { return "slot" + i; }

  function loadImages() {
    var jobs = [];
    for (var i = 0; i < SLOTS; i++) jobs.push(i);
    return Promise.all(jobs.map(function (i) {
      return dbGet(slotKey(i)).then(function (blob) {
        if (blob && blob.size) setUrl(i, blob);
      }).catch(function () { });
    }));
  }
  function setUrl(i, blob) {
    if (urls[i]) { try { URL.revokeObjectURL(urls[i]); } catch (e) { } }
    urls[i] = URL.createObjectURL(blob);
  }

  /* ---------- 壁纸层 ---------- */
  function ensureWallpaper() {
    var el = document.getElementById(WP_ID);
    if (el) return el;
    if (!document.body) return null;
    el = document.createElement("div");
    el.id = WP_ID;
    var img = document.createElement("div");
    img.className = "cs-img";
    var tint = document.createElement("div");
    tint.className = "cs-tint";
    el.appendChild(img);
    el.appendChild(tint);
    document.body.appendChild(el);
    return el;
  }

  function applyWallpaper() {
    var el = ensureWallpaper();
    if (!el) return;
    var img = el.querySelector(".cs-img");
    var tint = el.querySelector(".cs-tint");
    var c = state.controls;
    var url = state.activeSlot === null ? "" : (urls[state.activeSlot] || "");
    var root = document.documentElement;
    if (!url) {
      root.classList.remove(ON_CLASS);
      el.style.display = "none";
      return;
    }
    root.classList.add(ON_CLASS);
    el.style.display = "block";
    img.style.backgroundImage = "url(\"" + url + "\")";
    img.style.backgroundPosition = clamp(c.positionX, 0, 100) + "% " + clamp(c.positionY, 0, 100) + "%";
    img.style.transform = "scale(" + (clamp(c.scale, 50, 150) / 100) + ")";
    img.style.filter = "saturate(" + (clamp(c.saturation, 0, 200) / 100) + ") contrast(" + (clamp(c.contrast, 0, 200) / 100) + ") blur(" + clamp(c.blur, 0, 40) + "px)";
    var alpha = clamp(c.opacity, 0, 100) / 100;
    el.style.opacity = String(alpha);
    var blurPx = clamp(c.blur, 0, 40);
    /* 只为模糊扩散留外扩；缩放低于 100 就老老实实缩小、露出底色 */
    var bleed = blurPx > 0 ? Math.ceil(blurPx * 3) + 4 : 0;
    img.style.inset = bleed > 0 ? ("-" + bleed + "px") : "0px";
    var t = clamp(c.temperature, -100, 100) / 100;
    tint.style.background = t >= 0 ? "#ff8a3d" : "#3d8aff";
    tint.style.opacity = String(Math.abs(t) * 0.5);
  }

  /* ---------- 样式 ---------- */
  var CSS = [
    "#" + WP_ID + " { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }",
    "#" + WP_ID + " .cs-img { position: absolute; inset: 0; background-size: cover; background-repeat: no-repeat; background-position: 50% 50%; transform-origin: center center; }",
    "#" + WP_ID + " .cs-tint { position: absolute; inset: 0; mix-blend-mode: soft-light; }",

      "html." + ON_CLASS + " [class*=\"app-shell-content-fade\"]:not([class*=\"contents\"]) { opacity: 0 !important; }",
    "html." + ON_CLASS + " { background-color: #14121a !important; }",
    "html." + ON_CLASS + " body { background-color: transparent !important; }",
    "html." + ON_CLASS + " main[data-app-shell-main-surface] { background-color: transparent !important; }",
    "html." + ON_CLASS + " [class~=\"electron:bg-surface\"] { background-color: transparent !important; }",
    "html." + ON_CLASS + " div[class~=\"bg-surface\"][class~=\"inset-y-0\"] { background-color: transparent !important; }",
    "html." + ON_CLASS + " { --app-shell-sidebar-docked-background: transparent; }",
    ".cs-card { background: rgba(20,18,26,.66); backdrop-filter: blur(20px) saturate(120%); }",
    "#" + PANEL_ID + " { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 20px; align-items: start; padding: 4px 4px 2px; }",
    "#" + PANEL_ID + " * { box-sizing: border-box; }",
    "#" + PANEL_ID + " .cs-slots { display: flex; flex-direction: column; gap: 10px; max-height: 306px; overflow-y: auto; overflow-x: hidden; padding-right: 2px; scrollbar-width: thin; }",
    "#" + PANEL_ID + " .cs-slots::-webkit-scrollbar { width: 6px; }",
    "#" + PANEL_ID + " .cs-slots::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 999px; }",
    "#" + PANEL_ID + " .cs-slot { position: relative; flex: 0 0 auto; width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.035); overflow: hidden; cursor: pointer; transition: border-color .15s ease, background .15s ease; }",
    "#" + PANEL_ID + " .cs-slot:hover { border-color: rgba(255,255,255,.3); }",
    "#" + PANEL_ID + " .cs-slot.cs-active { border-color: #5B6BFF; box-shadow: 0 0 0 1px #5B6BFF inset; }",
    "#" + PANEL_ID + " .cs-thumb { position: absolute; inset: 0; background-size: cover; background-position: center; }",
    "#" + PANEL_ID + " .cs-plus { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 300; color: rgba(255,255,255,.42); }",
    "#" + PANEL_ID + " .cs-del { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; padding: 0; display: none; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: rgba(0,0,0,.55); color: #F2F4F8; cursor: pointer; }",
    "#" + PANEL_ID + " .cs-slot:hover .cs-del, #" + PANEL_ID + " .cs-slot.cs-active .cs-del { display: flex; }",
    "#" + PANEL_ID + " .cs-del:hover { background: rgba(255,80,80,.85); }",
    "#" + PANEL_ID + " .cs-controls { display: flex; flex-direction: column; gap: 10px; min-width: 0; }",
    "#" + PANEL_ID + " .cs-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }",
    "#" + PANEL_ID + " .cs-title { font-size: 13px; color: #F2F4F8; }",
    "#" + PANEL_ID + " .cs-reset { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; font-size: 12px; color: #C7CBD3; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); border-radius: 6px; cursor: pointer; }",
    "#" + PANEL_ID + " .cs-reset:hover { color: #F2F4F8; border-color: rgba(255,255,255,.28); }",
    "#" + PANEL_ID + " .cs-rows { display: flex; flex-direction: column; gap: 6px; }",
    "#" + PANEL_ID + " .cs-row { display: grid; grid-template-columns: 60px minmax(0, 1fr) 40px; align-items: center; gap: 12px; }",
    "#" + PANEL_ID + " .cs-label { font-size: 12px; color: #D3D7DE; white-space: nowrap; }",
    "#" + PANEL_ID + " .cs-val { height: 20px; line-height: 20px; text-align: center; font-size: 11px; color: #F2F4F8; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.14); border-radius: 5px; font-variant-numeric: tabular-nums; }",
    "#" + PANEL_ID + " .cs-range { -webkit-appearance: none; appearance: none; width: 100%; height: 18px; background: transparent; cursor: pointer; }",
    "#" + PANEL_ID + " .cs-range::-webkit-slider-runnable-track { height: 3px; border-radius: 999px; background: rgba(255,255,255,.16); }",
    "#" + PANEL_ID + " .cs-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 12px; height: 12px; margin-top: -4.5px; border: 0; border-radius: 50%; background: #5B6BFF; box-shadow: 0 0 0 1px rgba(0,0,0,.35); }",
    "#" + PANEL_ID + " .cs-range:hover::-webkit-slider-thumb { background: #7C89FF; }",
    "#" + PANEL_ID + " .cs-hint { font-size: 11px; line-height: 16px; color: rgba(255,255,255,.52); }",
    "#" + PANEL_ID + " .cs-hint.cs-hint-error { color: #FF9A9A; }",
    "#" + PANEL_ID + " .cs-slot:focus-visible, #" + PANEL_ID + " .cs-reset:focus-visible, #" + PANEL_ID + " .cs-del:focus-visible, #" + PANEL_ID + " .cs-range:focus-visible { outline: 2px solid #5B6BFF; outline-offset: 2px; }"
  ].join("");

  function ensureStyle() {
    var el = document.getElementById(STYLE_ID);
    if (el) { if (el.textContent !== CSS) el.textContent = CSS; return; }
    if (!document.head) return;
    el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  var HINT_TEXT = "点击槽位选择壁纸，点 + 导入本地图片（PNG / JPG / WEBP，单张 \u2264 64MB）。";

  var TRASH_SVG = "<svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M3 6h18\"/><path d=\"M8 6V4h8v2\"/><path d=\"M19 6l-1 14H6L5 6\"/><path d=\"M10 11v5\"/><path d=\"M14 11v5\"/></svg>";

  function panelHtml() {
    var slots = "";
    for (var i = 0; i < SLOTS; i++) {
      slots += "<div class=\"cs-slot\" role=\"button\" tabindex=\"0\" data-slot=\"" + i + "\" aria-label=\"壁纸槽位 " + (i + 1) + "\"><div class=\"cs-thumb\"></div><div class=\"cs-plus\">+</div><button type=\"button\" class=\"cs-del\" data-del=\"" + i + "\" title=\"删除壁纸\" aria-label=\"删除壁纸槽位 " + (i + 1) + "\">" + TRASH_SVG + "</button></div>";
    }
    var rows = CONTROLS.map(function (c) {
      return "<div class=\"cs-row\"><div class=\"cs-label\">" + c.label + "</div><input type=\"range\" class=\"cs-range\" min=\"0\" max=\"100\" step=\"1\" data-key=\"" + c.key + "\" aria-label=\"" + c.label + "\"><div class=\"cs-val\" data-val=\"" + c.key + "\" aria-hidden=\"true\">0</div></div>";
    }).join("");
    return "<div class=\"cs-slots\">" + slots + "</div>" +
      "<div class=\"cs-controls\"><div class=\"cs-head\"><div class=\"cs-title\">壁纸微调参数</div>" +
      "<button type=\"button\" class=\"cs-reset\">\u21ba 恢复默认</button></div>" +
      "<div class=\"cs-rows\">" + rows + "</div>" +
      "<div class=\"cs-hint\" aria-live=\"polite\">" + HINT_TEXT + "</div></div>";
  }

  function useSlot(idx) {
    if (urls[idx]) activateSlot(idx); else pickFile(idx);
  }

  function setHint(msg) {
    var host = document.getElementById(PANEL_ID);
    var el = host && host.querySelector(".cs-hint");
    if (!el) return;
    el.textContent = msg || HINT_TEXT;
    if (msg) el.classList.add("cs-hint-error"); else el.classList.remove("cs-hint-error");
  }

  function buildPanel() {
    var host = document.createElement("div");
    host.id = PANEL_ID;
    host.innerHTML = panelHtml();

    host.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var del = t.closest(".cs-del");
      if (del) { ev.stopPropagation(); deleteSlot(Number(del.getAttribute("data-del"))); return; }
      if (t.closest(".cs-reset")) { resetControls(); return; }
      var slot = t.closest(".cs-slot");
      if (slot) useSlot(Number(slot.getAttribute("data-slot")));
    });

    host.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      var t = ev.target;
      if (!t || !t.classList || !t.classList.contains("cs-slot")) return;
      ev.preventDefault();
      useSlot(Number(t.getAttribute("data-slot")));
    });

    host.addEventListener("input", function (ev) {
      var input = ev.target;
      if (!input || !input.classList || !input.classList.contains("cs-range")) return;
      var key = input.getAttribute("data-key");
      if (!key) return;
      state.controls[key] = fromSlider(key, Number(input.value));
      var box = host.querySelector(".cs-val[data-val=\"" + key + "\"]");
      if (box) box.textContent = String(round(Number(input.value)));
      saveState();
      applyWallpaper();
    });

    return host;
  }

  function pickFile(slot) {
    pendingSlot = slot;
    if (!fileInput) {
      fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp";
      fileInput.style.display = "none";
      fileInput.addEventListener("change", function () {
        var f = fileInput.files && fileInput.files[0];
        var target = pendingSlot;
        fileInput.value = "";
        pendingSlot = null;
        if (!f || target === null) return;
        importBlob(target, f).then(setHint);
      });
      document.body.appendChild(fileInput);
    }
    fileInput.click();
  }

  /* 返回 Promise<string|null>：null = 成功，字符串 = 直接给用户看的失败原因 */
  function importBlob(slot, blob) {
    if (!blob || !blob.size) return Promise.resolve("空文件");
    if (blob.type && blob.type.indexOf("image/") !== 0) return Promise.resolve("不支持的格式：" + (blob.type || blob.name || "未知"));
    if (blob.size > MAX_BYTES) return Promise.resolve("图片超过 64MB（当前 " + (blob.size / 1048576).toFixed(1) + "MB）");
    return dbPut(slotKey(slot), blob).then(function () {
      setUrl(slot, blob);
      activateSlot(slot);
      return null;
    }).catch(function (e) {
      try { console.warn("[codex-skin] 保存壁纸失败", e); } catch (x) { }
      return "本地存储写入失败（空间不足或存储被占用）";
    });
  }

  function deleteSlot(slot) {
    dbDel(slotKey(slot)).catch(function () { });
    if (urls[slot]) { try { URL.revokeObjectURL(urls[slot]); } catch (e) { } }
    delete urls[slot];
    if (state.activeSlot === slot) state.activeSlot = null;
    saveState();
    renderSlots();
    applyWallpaper();
  }

  function activateSlot(slot) {
    if (!urls[slot]) return;
    state.activeSlot = slot;
    saveState();
    renderSlots();
    applyWallpaper();
  }

  function resetControls() {
    state.controls = clone(DEFAULT_CONTROLS);
    saveState();
    renderControls();
    applyWallpaper();
  }

  function renderSlots() {
    var host = document.getElementById(PANEL_ID);
    if (!host) return;
    for (var i = 0; i < SLOTS; i++) {
      var card = host.querySelector(".cs-slot[data-slot=\"" + i + "\"]");
      if (!card) continue;
      var thumb = card.querySelector(".cs-thumb");
      var plus = card.querySelector(".cs-plus");
      var url = urls[i] || "";
      thumb.style.backgroundImage = url ? "url(\"" + url + "\")" : "none";
      plus.style.display = url ? "none" : "flex";
      card.setAttribute("aria-label", "壁纸槽位 " + (i + 1) + (url ? (state.activeSlot === i ? "，当前使用" : "，已设置") : "，空，点击导入"));
      if (state.activeSlot === i) card.classList.add("cs-active"); else card.classList.remove("cs-active");
    }
  }

  function renderControls() {
    var host = document.getElementById(PANEL_ID);
    if (!host) return;
    CONTROLS.forEach(function (c) {
      var input = host.querySelector(".cs-range[data-key=\"" + c.key + "\"]");
      var box = host.querySelector(".cs-val[data-val=\"" + c.key + "\"]");
      var s = toSlider(c.key, state.controls[c.key]);
      if (input && Number(input.value) !== s) input.value = String(s);
      if (box) box.textContent = String(s);
    });
  }

  /* ---------- 挂到「设置 → 外观」页尾部 ---------- */
  function findAppearanceContainer() {
    /* 便宜的先判：不在「外观」页就直接返回，避免整篇 div 扫描 */
    if (!document.getElementById("appearance-theme")) return null;
    var gs = document.querySelector("div.group\\/settings");
    if (!gs) return null;
    var kids = gs.children;
    for (var j = 0; j < kids.length; j++) {
      var k = kids[j];
      if (k.tagName === "DIV" && k.querySelector(":scope > section")) return k;
    }
    return null;
  }

  function ensureSection() {
    var container = findAppearanceContainer();
    if (!container) return;
    var section = document.getElementById(SECTION_ID);
    if (section && section.parentElement === container) return;
    if (section && section.parentElement) section.parentElement.removeChild(section);

    section = document.createElement("section");
    section.id = SECTION_ID;
    section.className = "flex flex-col";
    var head = document.createElement("div");
    head.className = "flex justify-between gap-4 items-center pb-1.5 min-h-toolbar";
    head.innerHTML = "<div class=\"flex min-w-0 flex-1 flex-col gap-0.5\"><div class=\"font-medium text-default text-base\">皮肤</div></div>";
    var body = document.createElement("div");
    body.className = "flex flex-col gap-1.5";
    var holder = document.createElement("div");
    holder.className = "rounded-2xl border border-default p-3 cs-card";
    holder.appendChild(buildPanel());
    body.appendChild(holder);
    section.appendChild(head);
    section.appendChild(body);
    container.appendChild(section);
    renderSlots();
    renderControls();
  }

  function sync() {
    ensureStyle();
    ensureWallpaper();
    ensureSection();
  }

  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = null;
      try { sync(); } catch (e) { }
    }, 120);
  }

  function presetBlob(pr) {
    return new Promise(function (resolve) {
      try {
        var w = 1920, h = 1080;
        var cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        var g = cv.getContext("2d");
        if (!g || !cv.toBlob) { resolve(null); return; }
        var lg = g.createLinearGradient(0, 0, w, h);
        lg.addColorStop(0, pr.a); lg.addColorStop(0.55, pr.b); lg.addColorStop(1, pr.c);
        g.fillStyle = lg; g.fillRect(0, 0, w, h);
        var rg = g.createRadialGradient(w * 0.76, h * 0.18, 0, w * 0.76, h * 0.18, h * 1.1);
        rg.addColorStop(0, pr.glow); rg.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = rg; g.fillRect(0, 0, w, h);
        cv.toBlob(function (b) { resolve(b); }, "image/jpeg", 0.92);
      } catch (e) { resolve(null); }
    });
  }

  function seedPresets() {
    var any = false;
    for (var i = 0; i < SLOTS; i++) if (urls[i]) any = true;
    if (any) return Promise.resolve(false);
    try { if (localStorage.getItem(LS_KEY + ".seeded") === "1") return Promise.resolve(false); } catch (e) { }
    var jobs = [];
    var wrote = 0;
    for (var j = 0; j < Math.min(PRESETS.length, SLOTS - 1); j++) {
      (function (slot, pr) {
        jobs.push(presetBlob(pr).then(function (blob) {
          if (!blob) return null;
          return dbPut(slotKey(slot), blob).then(function () { setUrl(slot, blob); wrote = wrote + 1; });
        }).catch(function () { }));
      })(j, PRESETS[j]);
    }
    return Promise.all(jobs).then(function () {
      /* 一张都没写进去就别打标记，否则用户永远拿不到预设、也看不出为什么 */
      if (wrote > 0) { try { localStorage.setItem(LS_KEY + ".seeded", "1"); } catch (e) { } }
      if (state.activeSlot === null && urls[0]) { state.activeSlot = 0; saveState(); }
      renderSlots();
      return wrote > 0;
    });
  }

  function start() {
    loadState();
    ensureStyle();
    applyWallpaper();
    loadImages().then(function () {
      applyWallpaper();
      renderSlots();
      scheduleSync();
      return seedPresets();
    }).then(function () { applyWallpaper(); });
    observer = new MutationObserver(function () { scheduleSync(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleSync();
  }

  window[GLOBAL_KEY] = {
    version: VERSION,
    ensure: function () { scheduleSync(); },
    /* 被新版本接管时由新实例调用：停观察者、清定时器、撤 object URL、拆掉自己的 DOM */
    shutdown: function () {
      if (observer) { observer.disconnect(); observer = null; }
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      for (var k in urls) { try { URL.revokeObjectURL(urls[k]); } catch (e) { } }
      urls = {};
      if (fileInput) { try { fileInput.remove(); } catch (e) { } fileInput = null; }
      [WP_ID, SECTION_ID, STYLE_ID].forEach(function (id) {
        var node = document.getElementById(id);
        if (node) node.remove();
      });
    },
    /* 纯映射，供 node --test 直接验算 */
    toSlider: toSlider,
    fromSlider: fromSlider
  };

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();