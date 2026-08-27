// yappy for desktop.
//
// The web client is BUNDLED into the binary (frontendDist points at the
// webapp's dist), so the app opens instantly with no network and owns its
// origin. The Rust side carries what a browser tab cannot: a frameless
// window with the app's own titlebar, a system tray with close-to-tray so
// yappy stays connected in the background, and an unread badge painted onto
// the taskbar icon, driven by the web client over IPC.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

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

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_badge])
        .setup(|app| {
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
