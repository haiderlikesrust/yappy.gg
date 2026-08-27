// yappy for desktop.
//
// The web client is bundled into the binary for an instant, offline-capable
// start — and updated Discord-style: on launch the shell compares the live
// site's index.html against what it is serving, downloads a newer bundle in
// the background into app-data, and applies it on the next start (or right
// away, when the person accepts the "restart" pill the page shows).
//
// Everything is served through one custom `yapp://` protocol whose handler
// prefers the downloaded bundle and falls back to the embedded assets. One
// protocol means one origin forever, which is what keeps localStorage — and
// with it the session — stable across updates.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// Where fresh web bundles come from. The deployed web client is the update
/// channel: whatever app.yappy.gg serves is what the desktop app becomes.
const UPDATE_ORIGIN: &str = "https://app.yappy.gg";

/// A bundle is only adopted if its index.html carries this marker — the web
/// client declaring it knows how to live inside the shell (titlebar, badge).
/// Protects against adopting a deploy older than desktop support, and gives
/// a place to fence off future breaking shell-API changes.
const DESKTOP_MARKER: &str = "name=\"yappy-desktop\"";

/// The web client reports its unread total whenever it changes; Windows gets
/// a violet overlay dot on the taskbar icon while anything is unread.
#[tauri::command]
fn set_badge(window: tauri::WebviewWindow, count: u32) {
    #[cfg(target_os = "windows")]
    {
        if count > 0 {
            let dot = tauri::image::Image::from_bytes(include_bytes!("../icons/badge.png")).ok();
            let _ = window.set_overlay_icon(dot);
        } else {
            let _ = window.set_overlay_icon(None);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window.set_badge_count(if count > 0 { Some(count as i64) } else { None });
    }
}

/// The "restart to apply the update" pill calls this.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// app-data/webapp — `current/` is the live downloaded bundle, `staging/` is
/// a download in progress. The swap is remove+rename, and index.html is
/// written into staging last, so a half-downloaded bundle is never current.
fn bundle_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("webapp"))
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html",
        "js" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
}

/// Root-relative `/assets/…` references inside HTML, JS or CSS.
fn asset_refs(text: &str) -> Vec<String> {
    const NEEDLE: &[u8] = b"/assets/";
    const STOP: &[u8] = b"\"'`)( \n\r\t\\,;";
    let bytes = text.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i + NEEDLE.len() <= bytes.len() {
        if &bytes[i..i + NEEDLE.len()] != NEEDLE {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i;
        while end < bytes.len() && !STOP.contains(&bytes[end]) {
            end += 1;
        }
        if let Ok(s) = std::str::from_utf8(&bytes[start..end]) {
            // Source maps are dev tooling; a client bundle does not need them.
            if !s.contains("..") && !s.ends_with(".map") && !out.iter().any(|x| x == s) {
                out.push(s.to_string());
            }
        }
        i = end.max(i + 1);
    }
    out
}

/// The index.html the app is currently serving — downloaded if present,
/// embedded otherwise. This is the version identity of the whole bundle:
/// Vite content-hashes every asset, so a changed build changes index.html.
fn current_index(app: &tauri::AppHandle) -> Option<Vec<u8>> {
    if let Some(root) = bundle_root(app) {
        if let Ok(bytes) = std::fs::read(root.join("current/index.html")) {
            return Some(bytes);
        }
    }
    app.asset_resolver().get("/index.html".into()).map(|a| a.bytes().to_vec())
}

async fn check_for_update(
    app: tauri::AppHandle,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let root = bundle_root(&app).ok_or("no app-data dir")?;
    let client = reqwest::Client::builder()
        .user_agent(format!("yappy-desktop/{}", app.package_info().version))
        .build()?;

    let index = client
        .get(format!("{UPDATE_ORIGIN}/index.html"))
        .header("cache-control", "no-cache")
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    if !std::str::from_utf8(&index)?.contains(DESKTOP_MARKER) {
        // The site is serving a build that predates desktop support (or a
        // rollback). Keep what we have rather than downgrade below the shell.
        return Ok(());
    }
    if current_index(&app).as_deref() == Some(&index[..]) {
        return Ok(()); // already the latest
    }

    let staging = root.join("staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;

    // Walk the reference graph: index → js/css → whatever those name.
    let mut files = asset_refs(std::str::from_utf8(&index)?);
    let mut i = 0;
    while i < files.len() {
        let rel = files[i].clone();
        i += 1;
        let bytes = client
            .get(format!("{UPDATE_ORIGIN}{rel}"))
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        if rel.ends_with(".js") || rel.ends_with(".css") {
            if let Ok(text) = std::str::from_utf8(&bytes) {
                for nested in asset_refs(text) {
                    if !files.iter().any(|x| x == &nested) {
                        files.push(nested);
                    }
                }
            }
        }
        let target = staging.join(rel.trim_start_matches('/'));
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(target, &bytes)?;
    }

    // Everything landed — index.html last, then the atomic-enough swap.
    std::fs::write(staging.join("index.html"), &index)?;
    let current = root.join("current");
    let _ = std::fs::remove_dir_all(&current);
    std::fs::rename(&staging, &current)?;

    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("update-ready", ());
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_badge, restart_app])
        // One origin, two sources: the downloaded bundle wins, the embedded
        // assets are the floor the app can never fall below.
        .register_uri_scheme_protocol("yapp", |ctx, request| {
            let app = ctx.app_handle();
            let path = request.uri().path();
            let mut rel = path.trim_start_matches('/').to_string();
            // SPA routes (/c/…, /saved) resolve to the document itself.
            if rel.is_empty() || !rel.contains('.') {
                rel = "index.html".into();
            }
            let ok = |bytes: Vec<u8>, mime: &str| {
                tauri::http::Response::builder()
                    .status(200)
                    .header("content-type", mime)
                    .body(bytes)
                    .unwrap()
            };
            if !rel.contains("..") {
                if let Some(root) = bundle_root(app) {
                    if let Ok(bytes) = std::fs::read(root.join("current").join(&rel)) {
                        return ok(bytes, mime_for(&rel));
                    }
                }
                if let Some(asset) = app.asset_resolver().get(format!("/{rel}")) {
                    return ok(asset.bytes().to_vec(), mime_for(&rel));
                }
            }
            tauri::http::Response::builder()
                .status(404)
                .body(Vec::new())
                .unwrap()
        })
        .setup(|app| {
            // A previously adopted bundle that lacks the marker (staged by an
            // older shell, or a bad swap) is worse than the embedded floor —
            // drop it before the window first paints.
            if let Some(root) = bundle_root(app.handle()) {
                let current = root.join("current");
                match std::fs::read_to_string(current.join("index.html")) {
                    Ok(html) if html.contains(DESKTOP_MARKER) => {}
                    Ok(_) => {
                        let _ = std::fs::remove_dir_all(&current);
                    }
                    Err(_) => {}
                }
            }

            let open = MenuItem::with_id(app, "open", "Open yappy", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit yappy", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::with_id("yappy")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("yappy")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = check_for_update(handle).await {
                    eprintln!("update check failed: {err}");
                }
            });
            Ok(())
        })
        // Closing hides: the tray keeps the session alive and notifications
        // flowing. Quit lives in the tray menu, where "actually exit" belongs.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running yappy");
}
