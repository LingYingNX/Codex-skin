<!-- FOR AI AGENTS - Human readability is a side effect, not a goal -->
<!-- Managed by agent: keep sections and order; edit content, not structure -->
<!-- Last updated: 2026-11-24 | Last verified: 2026-11-24 -->
# AGENTS.md

**Precedence:** the closest `AGENTS.md` to the files you're changing wins. This root file holds global defaults only.
User instructions override this file. Verified state lives in `skin-host.log` and the running host process, not in prose.

## Commands
> Verified by running them on 2026-11-24. No CI, no package manager; one node test file.

| Task | Command | ~Time |
|------|---------|-------|
| JS syntax check | `node --check skin.js` | ~0.2s |
| Slider / API tests | `node --test skin.test.mjs` | ~0.2s |
| Install / restart host | `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1` | ~5s |
| Uninstall + stop host | same command + `-Uninstall` | ~1s |
| Is host alive | `(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" \| ? { $_.CommandLine -like '*skin-host.ps1*' }).ProcessId` | ~0.5s |
| Task registered? | `(Get-ScheduledTask -TaskName "Codex Skin Host").State` | ~0.3s |
| Tail log | `Get-Content skin-host.log -Tail 10` | instant |

No linter, no build step. **Done** = `node --check skin.js` and `node --test skin.test.mjs` pass, the host pid changes, and `skin-host.log` shows `injected, probe={"v":"<VERSION>"}`.

## Workflow
1. **Before editing** `skin.js`: it is injected into a live renderer — read the whole file; `start()`, `applyWallpaper()`, `CSS[]` and the panel handlers are one state machine.
2. **After editing** `skin.js`: bump `VERSION`, run the tests, restart the host (`install.ps1`), then `Ctrl+R` in Codex. A different version hands the old instance a `shutdown()` call, so the DOM never holds two panels.
3. **Before claiming done**: show the log line and a screenshot; never say "should work".

## File Map
| File | Role |
|------|------|
| `skin.js` | Inject payload: wallpaper layer, transparency CSS, 外观-page panel (16:9 card, skin switch, check-for-update button), persistence. UTF-8, Chinese UI strings. |
| `skin-host.ps1` | CDP host: waits for Codex, attaches on :9229, injects, re-attaches on reload/crash; also runs the update pull the panel asks for. ASCII only. |
| `skin-host.vbs` | Windowless launcher used by the scheduled task (`wscript //B`). |
| `install.ps1` | Registers / unregisters the `Codex Skin Host` task; kills the old host first so a re-run really restarts it. ASCII only. |
| `skin.test.mjs` | `node --test` suite: slider mapping round-trip, clamp on dirty input, public runtime surface. |
| `README.md` | User-facing install / usage notes. |
| `skin-host.log` | Runtime log, append-only, not source. |
| `CLAUDE.md` | `@AGENTS.md` pointer, for hosts that read that name. |

## Boundaries
- **ASCII only** in every `.ps1`/`.vbs`: PowerShell 5.1 reads BOM-less UTF-8 as ANSI and mangles CJK paths. `skin.js` is the opposite — UTF-8, parsed by Chromium.
- **Never modify** Codex's install directory or `app.asar`; injection is CDP-only and never touches the process list.
- **Never kill the user's Codex** to test. Switching windows is fine; killing is not.
- The host needs user env vars `BUILD_FLAVOR=dev` + `CODEX_ELECTRON_CHROMIUM_SWITCHES` (port 9229). Missing them means it attaches to nothing — say so, don't fake a fix.
- Single instance is a `CodexSkinHost-<ProcessName>` mutex; the loser exits silently and deliberately writes no log line (a fallback task firing every 5 minutes lands there every time and used to bury real events).
- Resident cost is a budget, not a shrug: waiting for the CDP port and sitting attached both measure ~0.05% of one core, and the launcher exits in ~9ms without starting `powershell.exe` while `skin-host.pid` is locked. A full PS 5.1 start costs ~0.9s of CPU, `Invoke-RestMethod` against a closed port 10.2ms, and `GetProcessesByName` 7ms — never put any of them on a hot path. Wait on the CDP port with the 0.5ms `Test-CdpPort` check; block on the websocket instead of polling it.
- Wallpapers live in IndexedDB `codexSkin/wallpapers` (`slot0..slot4`), controls in `localStorage` key `codexSkin.v1`. Wiping test data means clearing both.
- 透明度 is pure alpha: at temperature 0, 100 = pixel-identical to the source, 50 = half-blend with `#14121a`. Do not reintroduce a scrim or overlay. Temperature adds a `soft-light` layer, so 100 is "image + tint" there.
- 缩放 below 100 shrinks the wallpaper and shows `#14121a` at the edges; the layer only bleeds outward for `blur > 0`. Do not reintroduce a fixed bleed for scale — it silently zoomed the framing at 99.
- 模糊 bleeds the `.cs-blur` wrapper only. `.cs-img` keeps a viewport-sized `cover` computed by hand (`dims` + `resize`), with a second `cover` layer filling the bleed ring. Bleeding the image box instead zooms the framing ~32% at 40px blur.
- The panel sits flush under the previous block via `margin-top: -<container row-gap>`, is `max-width: 72%`, and the card is `aspect-ratio: 16 / 9` (524x295 at 1143px). Re-measure the DOM before touching layout and keep the inner budget under `clientHeight`: grid is `228px | minmax(0,1fr)`, slots 2-column on the left, 8 sliders single-column (260px wide, 154px range) plus the foot row on the right.
- Panel typography matches the appearance page, not a private scale: labels 13px/500 (native rows measure `13px / 500 / lh 18.57`), values and footer 13px, section title 14px (`text-base`). Do not go below 13px.
- 检查更新 is the host's job and is user-triggered only: the renderer cannot read a private repo and CSP blocks `fetch` to loopback, so the panel calls `window.codexSkinUpdate(token)`, a CDP binding the host installs with `Runtime.addBinding`. The host blocks on the socket and wakes only for that call, then runs `git fetch` + `merge --ff-only` with the machine's credentials and writes `codexSkin.update.state`. Do not reintroduce a timer probe, and do not `Runtime.enable`/`Page.enable` — Codex emits hundreds of console events per second and they would land in this blocking loop. On a failed inject, checkout the old `skin.js` back and re-inject; `skin-host.ps1` itself only updates through `install.ps1`.
- No built-in wallpapers. The canvas preset generator was deleted on request; slots start empty and the user imports their own. Do not reintroduce seeded content.
- The 皮肤 switch lives in the section head, inside the same flex row as the 「皮肤」 label with a 12px gap (`role="switch"`, `aria-checked`, id `codex-skin-switch`) — not pushed to the far right. Off = `html` loses `codex-skin-on`, wallpaper `display:none`, card gets `.cs-off` (dimmed + `pointer-events:none`); the panel itself must stay visible or it could never be turned back on. `state.enabled` persists in `codexSkin.v1`.
- **Changelog:** none — this repo keeps no changelog; `git log` is the record, and every change lands as a single commit on `main`.

## Git
Single branch `main`, no CI. `skin-host.log` is git-ignored (runtime output with absolute local paths). Do not commit or push unless asked.
