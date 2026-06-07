# BrowserAI Mobile UX

Catalogue of every mobile-only behaviour and the hook / component that
implements it. All of these are gated to `<` `md` (768 px) so the desktop
layout stays untouched.

## Layout

| Element | Mobile | Desktop |
|---|---|---|
| Sidebar  | `fixed` drawer, slides in from the left edge, dimmed backdrop | Static 260 px panel |
| Topbar   | `[burger] [center model picker] [workspace icon]` | `[title + badges] [status pills + workspace + logout]` |
| ModelBar | Hidden — the model picker lives in the top bar centre | Shown above the composer, can `dropUp` |
| Composer | `rounded-2xl`, `p-2`, icon-only `Файлы`/`Workspace` (36×36) | `rounded-3xl`, `p-4`, full-text labels |
| Workspace pane | Full-screen overlay (`fixed inset-0`) | 300 px side panel docked right |
| FilePreview | `max-w-2xl`, two-row header (name + meta) + wrap-flex actions | `w-1/2 min-w-[320px]`, single-row header |

## Gestures

| Gesture | Component | Effect |
|---|---|---|
| Edge-swipe right from left edge | `useEdgeSwipe` (`App.jsx`) | Opens Sidebar when collapsed |
| Pull-to-refresh on chat scroll | `usePullToRefresh` (`MessageList.jsx`) | Calls `onRefresh = location.reload`. Visual: `↓ Потяни…` → `↑ Отпусти…` → `⟳` |
| Swipe-left on a message | `useSwipeActions` (`MessageList.jsx`) | Reveals action buttons (copy, regenerate, edit) |

Each hook does its own slope check (`|dx| > |dy| * ratio`) to avoid
hijacking vertical scrolling.

## Haptic feedback

`src/lib/haptics.js`. Calls `navigator.vibrate(pattern)` only on browsers
that expose the API. Toggle in Sidebar bottom strip (📳 / 📴), pref
stored at `localStorage['browserai.haptics']`.

| Method | Pattern | Used when |
|---|---|---|
| `haptics.tap()`       | `15ms`            | tool finished, sidebar opens via edge swipe |
| `haptics.success()`   | `50ms`            | final assistant message, plain chat done |
| `haptics.warning()`   | `[30,50,30]`      | (reserved) |
| `haptics.error()`     | `[60,80,60]`      | exception / error event |

## Compact tool cards

`AgentToolBlock.jsx` shows a single-row pill: `[>_] used Bash · echo "…" · ✓ · 527ms · ▾`.

- Icon: terminal-style monogram, not emoji, so it fits at 11 px.
- Status mark: `•` (running, amber, pulsing) → `✓` (emerald) or `✗` (rose).
- Duration: shown only after both `startedAt` + `finishedAt` exist;
  formatter rounds `<10 s` to one decimal, otherwise integer.
- Body: scrollable `max-h-72`, monospace 11 px, optional syntax
  highlighting for code-ish results.

## Streaming reasoning

When the agent loop emits `event: thought`, the UI inserts the model's
prose just above the matching tool card (by `step`). Renders as
markdown, so the model can write headers/code blocks too. The visual
order is exactly the agent's planning order: thought → tool_start →
tool_result → thought → tool_start → … → final assistant message.

## Syntax highlighting

`src/lib/syntaxHighlight.js` is a ~150-line dependency-free tokenizer
for js/ts/jsx/json/py/sh/html/css/md/yaml/toml. Tokens get
`<span class="tok-com|str|num|key|fn|ttype">`. Colour palette in
`src/index.css` under `.tok-*`.

Used in:
- `AgentToolBlock` for `read_file`, `write_file`, `edit_file` (language
  detected from `args.path`), and `bash` (forced to `sh`).
- Available to any other component via `import { highlight } from '../lib/syntaxHighlight.js'`.

## User preferences strip

`SidebarUserPrefs.jsx`, anchored at the bottom of the Sidebar.

| Control | Persisted at | Applied to |
|---|---|---|
| Theme toggle ☀️/🌙 | `browserai.theme` ('light'\|'dark') | `<html class="theme-light">` flips a CSS `filter: invert(0.92) hue-rotate(180deg)`. Images / `.preserve-color` get a counter-invert. |
| Font size A− / A+ | `browserai.fontSize` (px, 13–20) | `<html style="--browserai-base-fz: …px">` driving `html { font-size: var() }`. |
| Haptics 📳 / 📴 | `browserai.haptics` ('on'\|'off') | `haptics.isEnabled()` short-circuits all vibration calls. |

## Code-block copy buttons

`src/lib/markdown.jsx` wraps every fenced block with
`<pre class="code-block-wrap" data-code="<URL-encoded source>">` and
adds a `<button data-copy-btn>Копировать</button>`. A single delegated
`onClick` on the markdown root copies the source to the clipboard and
flashes `Скопировано` for 1.5 s.

`@media (max-width: 767px)` styles in `index.css` keep the button at
60 % opacity always (no hover on touch).

## ErrorBoundary

`src/components/ErrorBoundary.jsx` wraps `<App />` in `src/main.jsx`.

- Catches React render errors via `getDerivedStateFromError` +
  `componentDidCatch`.
- Global `window.onerror` and `unhandledrejection` listeners pipe into
  the same UI.
- Renders a red panel with message + stack + `Перезагрузить` /
  `Продолжить` buttons.
- POSTs the crash report to `/api/debug/client-error` with `keepalive: true`
  so unloading the page does not lose the report.
- Reports land in `${CLIENT_ERROR_LOG}` (default
  `/data/client-errors.log`, mounted on the host via the data
  bind-mount).
