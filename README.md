# Codex 皮肤

给 Codex 桌面版加壁纸，并在「设置 → 外观」里加一个皮肤面板。

## 安装 / 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1            # 安装；再跑一次 = 重启宿主
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall # 卸载
```

## 使用

`Ctrl+,` → 设置 → 外观 →「高级」下面是「皮肤」。

- 点左侧槽位导入壁纸（PNG / JPG / WEBP，≤64MB），再点切换。
- 标题旁的开关关掉整个皮肤，面板留灰但不会消失。
- 右侧 8 个滑杆实时生效，「恢复默认」只重置滑杆。
- 槽位右上角的垃圾桶删掉该壁纸。

## 更新

标题行右侧「检查更新」：有新提交会自己换上，不用重启 Codex。

## 文件

`skin.js` 皮肤本体 · `skin-host.ps1` 后台宿主 · `install.ps1` 安装卸载 · `skin-host.log` 日志
