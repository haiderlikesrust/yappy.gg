// yappy for desktop.
//
// A deliberate thin shell: the window loads https://app.yappy.gg directly, so
// the desktop app ships every web feature the day it deploys — no separate
// release train, no stale bundle. The page's origin stays app.yappy.gg, which
// means the API's CORS allowlist, the gateway, and sessions all behave exactly
// as they do in a browser. The Rust side owns what a browser tab cannot: a
// real window, its own icon and taskbar identity, and native chrome.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running yappy");
}
