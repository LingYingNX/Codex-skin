// 载入 skin.js 需要的最小 DOM/localStorage 桩：只跑到 "DOMContentLoaded 还没到" 的分支，
// 这样 IIFE 只注册 window.__codexSkinRuntime，不碰真实渲染逻辑。
import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = globalThis;
globalThis.document = {
  body: null,
  addEventListener() {},
  getElementById() { return null; },
  createElement() { throw new Error("不是这条测试路径该创建 DOM"); }
};
globalThis.localStorage = {
  _v: new Map(),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v) { this._v.set(k, String(v)); },
  removeItem(k) { this._v.delete(k); }
};

await import(new URL("./skin.js", import.meta.url).href);

const rt = globalThis.__codexSkinRuntime;
const { toSlider, fromSlider } = rt;

const KEYS = ["temperature", "saturation", "contrast", "scale", "opacity", "blur", "positionX", "positionY"];

test("八个滑杆的 0..100 每个刻度都能原样往返", () => {
  for (const key of KEYS) {
    for (let s = 0; s <= 100; s++) {
      assert.equal(toSlider(key, fromSlider(key, s)), s, key + " 在刻度 " + s + " 上往返跑偏");
    }
  }
});

test("模糊保留 0.4px 精度，不再被取整碾成 0", () => {
  assert.equal(fromSlider("blur", 1), 0.4);
  assert.equal(fromSlider("blur", 3), 1.2);
  assert.equal(toSlider("blur", 0.4), 1);
  assert.equal(toSlider("blur", 0), 0);
});

test("脏数据被 clamp 兜住，不会让壁纸整个透明", () => {
  assert.equal(toSlider("opacity", NaN), 0);
  assert.equal(toSlider("opacity", "abc"), 0);
  assert.equal(toSlider("opacity", -50), 0);
  assert.equal(toSlider("scale", 999), 100);
  assert.equal(toSlider("temperature", -999), 0);
});

test("运行时对象只暴露版本、接管、收摊和两个纯映射", () => {
  assert.equal(rt.version, "1.0.23");
  assert.deepEqual(Object.keys(rt).sort(), ["ensure", "fromSlider", "shutdown", "toSlider", "version"]);
});
