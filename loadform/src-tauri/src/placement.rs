//! Absolute window placement, abstracted over the windowing system.
//!
//! Windows and macOS let a client position its own top-level windows, so the
//! ordinary Tauri window API is all that's needed there.
//!
//! Wayland does not: the compositor owns placement, and a regular client is
//! never allowed to say where it sits. The one escape hatch is the
//! `zwlr_layer_shell_v1` protocol, which is why Linux delegates to
//! [`crate::layer_shell`] instead.
//!
//! Everything here takes logical pixels.

use tauri::AppHandle;

#[cfg(not(target_os = "linux"))]
use tauri::Manager;

/// Place `label` at absolute screen position `(x, y)` with logical size
/// `(w, h)`, before it is shown.
///
/// Must be called while the window is still hidden, and only once per window:
/// on Linux this promotes the window to a layer-shell surface, and
/// `gtk_layer_init_for_window` asserts the window has not been mapped yet.
pub fn init_window(
    app: &AppHandle,
    label: &str,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        crate::layer_shell::init_layer_window(app, label, x, y, w, h)
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Both the widget and the planets already declare `always_on_top`, so
        // size and position are all that's left to apply here.
        let win = window(app, label)?;
        win.set_size(tauri::LogicalSize::new(w as f64, h as f64))
            .map_err(|e| e.to_string())?;
        move_window(app, label, x, y)
    }
}

/// Reposition an already-placed window. Called on every drag tick, for the sun
/// and for each planet following it.
pub fn move_window(app: &AppHandle, label: &str, x: i32, y: i32) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        crate::layer_shell::move_layer_window(app, label, x, y)
    }

    #[cfg(not(target_os = "linux"))]
    {
        window(app, label)?
            .set_position(tauri::LogicalPosition::new(x as f64, y as f64))
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(target_os = "linux"))]
fn window(app: &AppHandle, label: &str) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(label)
        .ok_or_else(|| format!("Window '{label}' not found"))
}
