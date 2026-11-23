<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-11-23 | Last verified: 2026-11-23 -->
# AGENTS.md

**Precedence:** the **closest `AGENTS.md`** to the files you're changing wins. Root holds global defaults only.
User instructions override this file. Verified state lives in `skin-host.log` and the running host process, not in prose.

## Commands
> Source: verified by running them on 2026-11-23 (no CI, no package manager; one node test file).

| Task | Command | ~Time |
|------|---------|-------|
| JS syntax check | `node --check skin.js` | ~0.2s |
| Slider / API tests | `node --test skin.test.mjs` | ~0.2s |
| Install / restart host | `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` | ~2s |
| Uninstall + stop host | `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall` | ~1s |
| Is host alive | `(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" \| ? { $_.CommandLine -like '*skin-host.ps1*' }).ProcessId` | ~0.5s |
| Task registered? | `(Get-ScheduledTask -TaskName "Codex Skin Host").State` | ~0.3s |
| Restart host | `install.ps1` (it now stops the old host first; a bare re-register is a silent no-op) | ~5s |
| Tail log | `Get-Content skin-host.log -Tail 10` | instant |

No linter, no build step. "Done" means: `node --check skin.js` and `node --test skin.test.mjs` pass, the host pid changes, and `skin-host.log` shows `injected, probe={"v":"<VERSION>"}`.

## Workflow
1. **Before editing** `skin.js`: it is injected into a live renderer; read the whole file — `start()`, `applyWallpaper()`, `CSS[]` and the panel handlers are one state machine.
2. **After editing** `skin.js`: bump `VERSION`, run `node --test skin.test.mjs`, restart the host (`install.ps1`), then `Ctrl+R` in Codex. A different version hands the old instance a `shutdown()` call, so the DOM never holds two panels.
3. **Before claiming done**: show the log line and a screenshot; never say "should work".

## File Map

| File | Role |
|------|------|
| `skin.js` | Inject payload: wallpaper layer, transparency CSS, 外观-page panel, preset seeding, persistence. UTF-8, Chinese UI strings. |
| `skin-host.ps1` | CDP host: waits for Codex, attaches on :9229, injects, reconnects on reload/crash. ASCII only. |
| `skin-host.vbs` | Windowless launcher used by the scheduled task (`wscript //B`). |
| `install.ps1` | Registers/unregisters the `Codex Skin Host` scheduled task; kills the old host first so a re-run really restarts it. ASCII only. |
| `skin.test.mjs` | `node --test` suite: slider mapping round-trip, clamp on dirty input, public runtime surface. |
| `README.md` | User-facing install/usage notes. |
| `skin-host.log` | Runtime log, append-only, not source. |

## Hard Constraints
- **ASCII only** in all `.ps1`/`.vbs` files: PowerShell 5.1 reads BOM-less UTF-8 as ANSI and mangles CJK paths. `skin.js` is the opposite — UTF-8, it is parsed by Chromium.
- **Never modify** Codex's install directory or `app.asar`; injection is CDP-only, process list untouched.
- **Never kill the user's Codex** to test; switching windows/logging is acceptable, killing is not.
- The host depends on user env vars `BUILD_FLAVOR=dev` + `CODEX_ELECTRON_CHROMIUM_SWITCHES` (port 9229). If they are missing the host attaches to nothing — say so, don't fake a fix.
- Single instance is enforced by the `CodexSkinHost-<ProcessName>` mutex. The loser exits silently and deliberately writes no log line: the one-minute task hits that path every time, and it used to bury real events (139 of 209 lines).
- Wallpapers live in IndexedDB `codexSkin/wallpapers` (keys `slot0..slot4`), controls in `localStorage` key `codexSkin.v1`. Wiping test data means clearing both.
- 透明度 is pure alpha: at temperature 0, 100 = pixel-identical to the source image, 50 = half-blend with `#14121a`. Do not reintroduce a scrim or overlay; that was removed because it broke this guarantee. Temperature adds a `soft-light` layer inside the wallpaper, so 100 is "image + tint" there.
- 缩放 below 100 shrinks the wallpaper and shows `#14121a` at the edges; the layer only bleeds outward for `blur > 0`. Do not reintroduce a fixed bleed for scale — it silently zoomed the framing at 99.

## Git
Single branch `main`, no CI. `skin-host.log` is git-ignored: it is runtime output with absolute local paths. Do not commit or push unless asked.
