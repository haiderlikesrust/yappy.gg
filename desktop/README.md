# yappy for desktop

A native Rust ([Tauri 2](https://v2.tauri.app)) app around the yappy web
client — not a browser tab in a frame.

- **The web client is bundled into the binary** (`frontendDist` →
  `apps/webapp/dist`), so the app opens instantly and owns its origin.
- **Frameless window with yappy's own titlebar** — the web client renders the
  chrome (drag region, min/max/close) when it detects the shell
  (`apps/webapp/src/lib/desktop.ts`, `ui/desktop/TitleBar.tsx`).
- **System tray + close-to-tray** — closing the window hides it; yappy stays
  connected and Quit lives in the tray menu.
- **Unread taskbar badge** — the store reports its unread total over IPC
  (`set_badge`) and the shell paints a violet overlay dot on the icon.

## Server prerequisite

The bundled client's origin is `http://tauri.localhost` (Windows WebView2),
so the API's `CORS_ORIGINS` must include it — see `.env.production.example`.
Without it every API call from the desktop app is refused.

## Build

Requires Rust (stable) and Node/pnpm. This package is standalone — NOT part
of the repo's pnpm workspace — so always install with:

```bash
pnpm install --ignore-workspace
```

Then:

```bash
pnpm tauri build     # builds apps/webapp first, then the shell + NSIS installer
pnpm tauri dev       # attaches to the vite dev server on :5173
```

Outputs: `src-tauri/target/release/yappy-desktop.exe` and the installer in
`src-tauri/target/release/bundle/nsis/`.

## Icons

`node gen-icon.js` draws the yappy mark (violet squircle, tongue out) with
node built-ins; `pnpm tauri icon icon-src.png` fans it out into
`src-tauri/icons/`. `node gen-badge.js` draws the unread overlay dot.
