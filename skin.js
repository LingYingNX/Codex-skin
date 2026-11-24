/* Codex 皮肤 — renderer payload, injected by skin-host.ps1 over CDP */
(function () {
  "use strict";
  var VERSION = "0.1";
  var GLOBAL_KEY = "__codexSkinRuntime";
  var LS_KEY = "codexSkin.v1";
  var DB_NAME = "codexSkin";
  var DB_STORE = "wallpapers";
  var SLOTS = 5;
  var STYLE_ID = "codex-skin-style";
  var WP_ID = "codex-skin-wallpaper";
  var PANEL_ID = "codex-skin-panel";
  var SWITCH_ID = "codex-skin-switch";
  var UPDATE_ID = "codex-skin-update";
  var UPDATE_REQ_KEY = "codexSkin.update.request";
  var UPDATE_STATE_KEY = "codexSkin.update.state";
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

  var previous = window[GLOBAL_KEY];
  if (previous) {
    if (previous.version === VERSION) { previous.ensure(); return; }
    /* 旧版本实例必须先收摊：否则它的 MutationObserver 和面板会一直活着 */
    try { if (previous.shutdown) previous.shutdown(); } catch (e) { }
  }

  var state = { activeSlot: null, controls: clone(DEFAULT_CONTROLS), enabled: true };
  var urls = {};
  var pendingSlot = null;
  var observer = null;
  var syncTimer = null;
  var fileInput = null;
  var dims = {};
  var onResize = null;
  var updateTimer = null;
  var updateBusy = false;

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
      if (o && typeof o.enabled === "boolean") state.enabled = o.enabled;
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
    var url = URL.createObjectURL(blob);
    urls[i] = url;
    var probe = new Image();
    probe.onload = function () {
      dims[i] = { w: probe.naturalWidth, h: probe.naturalHeight };
      probe.onload = null;
      if (state.activeSlot === i) applyWallpaper();
    };
    probe.onerror = function () { probe.onerror = null; };
    probe.src = url;
  }

  /* ---------- 壁纸层 ---------- */
  function ensureWallpaper() {
    var el = document.getElementById(WP_ID);
    if (el) {
      if (el.querySelector(".cs-blur")) return el;
      el.remove();
    }
    if (!document.body) return null;
    el = document.createElement("div");
    el.id = WP_ID;
    var layer = document.createElement("div");
    layer.className = "cs-blur";
    var img = document.createElement("div");
    img.className = "cs-img";
    layer.appendChild(img);
    var tint = document.createElement("div");
    tint.className = "cs-tint";
    el.appendChild(layer);
    el.appendChild(tint);
    document.body.appendChild(el);
    return el;
  }

  function applyWallpaper() {
    var el = ensureWallpaper();
    if (!el) return;
    var layer = el.querySelector(".cs-blur");
    var img = el.querySelector(".cs-img");
    var tint = el.querySelector(".cs-tint");
    var c = state.controls;
    var url = state.activeSlot === null ? "" : (urls[state.activeSlot] || "");
    var root = document.documentElement;
    if (!url || !state.enabled) {
      root.classList.remove(ON_CLASS);
      el.style.display = "none";
      return;
    }
    root.classList.add(ON_CLASS);
    el.style.display = "block";

    var blurPx = clamp(c.blur, 0, 40);
    var scale = clamp(c.scale, 50, 150) / 100;
    var px = clamp(c.positionX, 0, 100) / 100;
    var py = clamp(c.positionY, 0, 100) / 100;

    /* CSS 的 blur() 不会把像素往元素外延展，边缘会透出底色，所以必须外扩一层来"接住"扩散。
       但外扩只能加在模糊盒上：图像自己始终按视口算 cover，再加一层放大版填满外扩区，
       于是模糊半径怎么拉，取景都不会跟着变大（旧的写法按外扩后的盒子算 cover，40px 模糊能放大三成）。 */
    var bleed = blurPx > 0 ? Math.ceil(blurPx * 3) + 4 : 0;
    layer.style.inset = bleed ? ("-" + bleed + "px") : "0px";

    var d = dims[state.activeSlot];
    var vw = window.innerWidth, vh = window.innerHeight;
    if (d && d.w > 0 && d.h > 0) {
      var fit = Math.max(vw / d.w, vh / d.h);
      var w = d.w * fit * scale, h = d.h * fit * scale;
      var left = bleed - px * (w - vw);
      var top = bleed - py * (h - vh);
      img.style.backgroundImage = "url(\"" + url + "\")";
      img.style.backgroundSize = w + "px " + h + "px";
      img.style.backgroundPosition = left + "px " + top + "px";
      if (bleed > 0 && w >= vw && h >= vh) {
        /* 第二层：同一张图按外扩盒 cover，只负责填外扩区；视口内被第一层整块盖住 */
        img.style.backgroundImage = "url(\"" + url + "\"), url(\"" + url + "\")";
        img.style.backgroundSize = w + "px " + h + "px, cover";
        img.style.backgroundPosition = left + "px " + top + "px, " + (px * 100) + "% " + (py * 100) + "%";
      }
    } else {
      /* 图片尺寸还没量出来：先用 cover 顶着，onload 之后会按像素重画一次 */
      img.style.backgroundImage = "url(\"" + url + "\")";
      img.style.backgroundSize = "cover";
      img.style.backgroundPosition = (px * 100) + "% " + (py * 100) + "%";
    }

    layer.style.filter = "saturate(" + (clamp(c.saturation, 0, 200) / 100) + ") contrast(" + (clamp(c.contrast, 0, 200) / 100) + ")" + (blurPx > 0 ? " blur(" + blurPx + "px)" : "");
    el.style.opacity = String(clamp(c.opacity, 0, 100) / 100);

    var t = clamp(c.temperature, -100, 100) / 100;
    tint.style.background = t >= 0 ? "#ff8a3d" : "#3d8aff";
    tint.style.opacity = String(Math.abs(t) * 0.5);
  }

  /* ---------- 样式 ---------- */
  var CSS = [
    "#" + WP_ID + " { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }",
    "#" + WP_ID + " .cs-blur { position: absolute; inset: 0; }",
    "#" + WP_ID + " .cs-img { position: absolute; inset: 0; background-size: cover; background-repeat: no-repeat; background-position: 50% 50%; }",
    "#" + WP_ID + " .cs-tint { position: absolute; inset: 0; mix-blend-mode: soft-light; }",

      "html." + ON_CLASS + " [class*=\"app-shell-content-fade\"]:not([class*=\"contents\"]) { opacity: 0 !important; }",
    "html." + ON_CLASS + " { background-color: #14121a !important; }",
    "html." + ON_CLASS + " body { background-color: transparent !important; }",
    "html." + ON_CLASS + " main[data-app-shell-main-surface] { background-color: transparent !important; }",
    "html." + ON_CLASS + " [class~=\"electron:bg-surface\"] { background-color: transparent !important; }",
    "html." + ON_CLASS + " div[class~=\"bg-surface\"][class~=\"inset-y-0\"] { background-color: transparent !important; }",
    "html." + ON_CLASS + " { --app-shell-sidebar-docked-background: transparent; }",
    /* 16:9 为主；窄窗（<1000px 时不再限宽）下卡片会被压扁，min-height 兜住内容自然高度，overflow 防止溢出到卡片外 */
    ".cs-card { aspect-ratio: 16 / 9; min-height: 276px; overflow: hidden; padding: 10px; background: rgba(20,18,26,.66); backdrop-filter: blur(20px) saturate(120%); }",
    ".cs-card.cs-off { opacity: .45; }",
    ".cs-card.cs-off #" + PANEL_ID + " { pointer-events: none; }",
    "#" + SECTION_ID + " { max-width: 72%; }",
    "@media (max-width: 1000px) { #" + SECTION_ID + " { max-width: none; } }",
    "#" + PANEL_ID + " { display: grid; grid-template-columns: 228px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; gap: 10px 14px; height: 100%; }",
    "#" + PANEL_ID + " * { box-sizing: border-box; }",
    "#" + PANEL_ID + " .cs-slots { grid-column: 1; grid-row: 1 / 3; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-content: center; min-height: 0; }",
    "#" + PANEL_ID + " .cs-slot { position: relative; min-width: 0; aspect-ratio: 16 / 9; border-radius: 7px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.035); overflow: hidden; cursor: pointer; transition: border-color .15s ease, background .15s ease; }",
    "#" + PANEL_ID + " .cs-slot:hover { border-color: rgba(255,255,255,.3); }",
    "#" + PANEL_ID + " .cs-slot.cs-active { border-color: #5B6BFF; box-shadow: 0 0 0 1px #5B6BFF inset; }",
    "#" + PANEL_ID + " .cs-thumb { position: absolute; inset: 0; background-size: cover; background-position: center; }",
    "#" + PANEL_ID + " .cs-plus { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 300; color: rgba(255,255,255,.42); }",
    "#" + PANEL_ID + " .cs-del { position: absolute; top: 4px; right: 4px; width: 16px; height: 16px; padding: 0; display: none; align-items: center; justify-content: center; border: 0; border-radius: 4px; background: rgba(0,0,0,.6); color: #F2F4F8; cursor: pointer; }",
    "#" + PANEL_ID + " .cs-del svg { width: 10px; height: 10px; }",
    "#" + PANEL_ID + " .cs-slot:hover .cs-del, #" + PANEL_ID + " .cs-slot.cs-active .cs-del { display: flex; }",
    "#" + PANEL_ID + " .cs-del:hover { background: rgba(255,80,80,.85); }",
    "#" + PANEL_ID + " .cs-rows { grid-column: 2; grid-row: 1; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; align-content: center; min-height: 0; }",
    "#" + PANEL_ID + " .cs-row { display: grid; grid-template-columns: 56px minmax(0, 1fr) 34px; align-items: center; gap: 8px; }",
    "#" + PANEL_ID + " .cs-label { font-size: 13px; line-height: 18px; font-weight: 500; color: #DFDFDF; white-space: nowrap; }",
    "#" + PANEL_ID + " .cs-val { height: 22px; line-height: 22px; text-align: center; font-size: 13px; color: #F2F4F8; background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.14); border-radius: 5px; font-variant-numeric: tabular-nums; }",
    "#" + PANEL_ID + " .cs-range { -webkit-appearance: none; appearance: none; width: 100%; height: 22px; background: transparent; cursor: pointer; }",
    "#" + PANEL_ID + " .cs-range::-webkit-slider-runnable-track { height: 3px; border-radius: 999px; background: rgba(255,255,255,.16); }",
    "#" + PANEL_ID + " .cs-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 12px; height: 12px; margin-top: -5px; border: 0; border-radius: 50%; background: #5B6BFF; box-shadow: 0 0 0 1px rgba(0,0,0,.35); }",
    "#" + PANEL_ID + " .cs-range:hover::-webkit-slider-thumb { background: #7C89FF; }",
    "#" + PANEL_ID + " .cs-foot { grid-column: 2; grid-row: 2; display: flex; align-items: center; justify-content: space-between; gap: 8px; }",
    "#" + PANEL_ID + " .cs-hint { font-size: 13px; line-height: 18px; color: rgba(255,255,255,.6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    "#" + PANEL_ID + " .cs-hint.cs-hint-error { color: #FF9A9A; }",
    "#" + PANEL_ID + " .cs-reset { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 9px; font-size: 13px; color: #DFDFDF; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.14); border-radius: 5px; cursor: pointer; flex: 0 0 auto; }",
    "#" + PANEL_ID + " .cs-reset:hover { color: #F2F4F8; border-color: rgba(255,255,255,.28); }",
    "#" + PANEL_ID + " .cs-slot:focus-visible, #" + PANEL_ID + " .cs-reset:focus-visible, #" + PANEL_ID + " .cs-del:focus-visible, #" + PANEL_ID + " .cs-range:focus-visible { outline: 2px solid #5B6BFF; outline-offset: 2px; }",
    "#" + SECTION_ID + " .cs-switch { position: relative; flex: 0 0 auto; width: 34px; height: 20px; padding: 0; border: 1px solid rgba(255,255,255,.18); border-radius: 999px; background: rgba(255,255,255,.12); cursor: pointer; transition: background .15s ease, border-color .15s ease; }",
    "#" + SECTION_ID + " .cs-switch[aria-checked=\"true\"] { background: #5B6BFF; border-color: #5B6BFF; }",
    "#" + SECTION_ID + " .cs-switch .cs-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s ease; }",
    "#" + SECTION_ID + " .cs-switch[aria-checked=\"true\"] .cs-knob { transform: translateX(14px); }",
    "#" + SECTION_ID + " .cs-switch:focus-visible { outline: 2px solid #5B6BFF; outline-offset: 2px; }",
    "#" + SECTION_ID + " .cs-update { display: inline-flex; align-items: center; gap: 5px; height: 26px; min-width: 96px; justify-content: center; padding: 0 9px; border: 1px solid rgba(255,255,255,.14); border-radius: 5px; background: rgba(255,255,255,.06); font-size: 13px; color: #DFDFDF; cursor: pointer; }",
    "#" + SECTION_ID + " .cs-update svg { flex: 0 0 auto; }",
    "#" + SECTION_ID + " .cs-update:hover { color: #F2F4F8; border-color: rgba(255,255,255,.28); }",
    "#" + SECTION_ID + " .cs-update.cs-busy { opacity: .7; }",
    "#" + SECTION_ID + " .cs-update.cs-ok { color: #7BE0A3; border-color: rgba(123,224,163,.4); }",
    "#" + SECTION_ID + " .cs-update.cs-bad { color: #FF9A9A; border-color: rgba(255,154,154,.4); }",
    "#" + SECTION_ID + " .cs-update:focus-visible { outline: 2px solid #5B6BFF; outline-offset: 2px; }"
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

  var HINT_TEXT = "点 + 导入图片（\u2264 64MB）";

  var REFRESH_SVG = "<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M21 12a9 9 0 1 1-2.64-6.36\"/><path d=\"M21 3v6h-6\"/></svg>";

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
      "<div class=\"cs-rows\">" + rows + "</div>" +
      "<div class=\"cs-foot\"><span class=\"cs-hint\" aria-live=\"polite\">" + HINT_TEXT + "</span>" +
      "<button type=\"button\" class=\"cs-reset\">\u21ba 恢复默认</button></div>";
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
    delete dims[slot];
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

  function renderSwitch() {
    var btn = document.getElementById(SWITCH_ID);
    if (btn) btn.setAttribute("aria-checked", state.enabled ? "true" : "false");
    var card = document.querySelector("#" + SECTION_ID + " .cs-card");
    if (card) card.classList.toggle("cs-off", !state.enabled);
  }

  /* ---------- 检查更新：renderer 无法匿名读私有仓库，所以只把请求写进 localStorage，由宿主执行 git 拉取 ---------- */
  function setUpdLabel(text, cls, title) {
    var b = document.getElementById(UPDATE_ID);
    if (!b) return;
    var span = b.querySelector(".cs-upd-label");
    if (span) span.textContent = text;
    b.classList.remove("cs-ok", "cs-bad", "cs-busy");
    if (cls) b.classList.add(cls);
    b.title = title || text;
  }

  function restoreUpdateLabel() {
    var st = null;
    try { st = JSON.parse(localStorage.getItem(UPDATE_STATE_KEY) || "null"); } catch (e) { }
    if (!st || !st.at) return;
    /* 更新成功会换一个新实例重建面板，所以结果只能靠这里回读 */
    if (Date.now() - st.at > 120000) return;
    if (st.updated) setUpdLabel("已更新 " + (st.version || ""), "cs-ok", st.message || "刚拉取并热更新完成");
    else if (st.ok) setUpdLabel("已是最新", "cs-ok", st.message || "远端没有新提交");
    else setUpdLabel("更新失败", "cs-bad", st.message || "宿主没有返回原因");
  }

  function checkForUpdate() {
    if (updateBusy) return;
    updateBusy = true;
    var token = String(Date.now());
    try { localStorage.setItem(UPDATE_REQ_KEY, token); } catch (e) { }
    setUpdLabel("检查中…", "cs-busy", "宿主正在拉取远端");
    var startedAt = Date.now();
    if (updateTimer) clearInterval(updateTimer);
    updateTimer = setInterval(function () {
      var st = null;
      try { st = JSON.parse(localStorage.getItem(UPDATE_STATE_KEY) || "null"); } catch (e) { }
      if (st && st.for === token) {
        clearInterval(updateTimer); updateTimer = null; updateBusy = false;
        if (st.updated) setUpdLabel("已更新 " + (st.version || ""), "cs-ok", st.message || "已热更新");
        else if (st.ok) setUpdLabel("已是最新", "cs-ok", st.message || "远端没有新提交");
        else setUpdLabel("更新失败", "cs-bad", st.message || "宿主没有返回原因");
        return;
      }
      if (Date.now() - startedAt > 45000) {
        clearInterval(updateTimer); updateTimer = null; updateBusy = false;
        setUpdLabel("无响应", "cs-bad", "宿主没应答，看 skin-host.log");
      }
    }, 400);
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
    /* 父容器靠 gap 隔开每个区块；把这个 gap 用负 margin 抵掉，皮肤就紧贴上面那条分割线 */
    var gap = parseFloat(getComputedStyle(container).rowGap);
    var pull = "-" + (isFinite(gap) && gap > 0 ? gap : 0) + "px";
    var section = document.getElementById(SECTION_ID);
    if (section && section.parentElement === container) { section.style.marginTop = pull; renderSwitch(); return; }
    if (section && section.parentElement) section.parentElement.removeChild(section);

    section = document.createElement("section");
    section.id = SECTION_ID;
    section.className = "flex flex-col";
    var head = document.createElement("div");
    head.className = "flex justify-between gap-4 items-center pb-1.5 min-h-toolbar";
    head.innerHTML = "<div class=\"flex min-w-0 items-center gap-3\"><div class=\"font-medium text-default text-base\">皮肤</div></div>";
    var sw = document.createElement("button");
    sw.type = "button";
    sw.id = SWITCH_ID;
    sw.className = "cs-switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-label", "启用皮肤");
    sw.innerHTML = "<span class=\"cs-knob\"></span>";
    sw.addEventListener("click", function () {
      state.enabled = !state.enabled;
      saveState();
      renderSwitch();
      applyWallpaper();
    });
    var upd = document.createElement("button");
    upd.type = "button";
    upd.id = UPDATE_ID;
    upd.className = "cs-update";
    upd.title = "检查更新";
    upd.setAttribute("aria-label", "检查更新");
    upd.innerHTML = REFRESH_SVG + "<span class=\"cs-upd-label\">检查更新</span>";
    upd.addEventListener("click", checkForUpdate);
    /* 开关和更新按钮都跟着标题文字走，不再被 justify-between 推到最右边 */
    head.firstElementChild.appendChild(sw);
    head.firstElementChild.appendChild(upd);
    var body = document.createElement("div");
    body.className = "flex flex-col gap-1.5";
    var holder = document.createElement("div");
    holder.className = "rounded-2xl border border-default p-3 cs-card";
    holder.appendChild(buildPanel());
    body.appendChild(holder);
    section.appendChild(head);
    section.appendChild(body);
    section.style.marginTop = pull;
    container.appendChild(section);
    renderSlots();
    renderControls();
    renderSwitch();
    restoreUpdateLabel();
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

  function start() {
    loadState();
    ensureStyle();
    applyWallpaper();
    loadImages().then(function () {
      applyWallpaper();
      renderSlots();
      scheduleSync();
    });
    observer = new MutationObserver(function () { scheduleSync(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    /* 取景按视口算像素，窗口一变就得重画 */
    if (!onResize) {
      onResize = function () { try { applyWallpaper(); } catch (e) { } };
      window.addEventListener("resize", onResize);
    }
    scheduleSync();
  }

  window[GLOBAL_KEY] = {
    version: VERSION,
    ensure: function () { scheduleSync(); },
    /* 被新版本接管时由新实例调用：停观察者、清定时器、撤 object URL、拆掉自己的 DOM */
    shutdown: function () {
      if (observer) { observer.disconnect(); observer = null; }
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      if (onResize) { window.removeEventListener("resize", onResize); onResize = null; }
      if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
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