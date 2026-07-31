//! Minimal FFI bindings to gtk-layer-shell for Wayland-native window positioning.
//!
//! On Wayland, regular clients cannot set absolute window positions — the
//! compositor decides placement. The `zwlr_layer_shell_v1` protocol (supported
//! by niri and other wlroots-based compositors) is the exception: layer-shell
//! surfaces can be positioned at exact screen coordinates via anchors + margins.
//!
//! This module exposes just the handful of C functions we need. We link against
//! the system `gtk-layer-shell` shared library (not the unmaintained Rust crate).
//!
//! Positioning strategy: anchor a surface to the TOP and LEFT edges (only),
//! then set `margin_top = y` and `margin_left = x`. The surface appears at
//! screen position (x, y). This is the Wayland-native equivalent of X11's
//! `move(x, y)` and works reliably on niri.

#![cfg(target_os = "linux")]

use gtk::glib;
use gtk::prelude::*;
use tauri::AppHandle;
use tauri::Manager;

// ─── C enum re-declarations (match gtk-layer-shell.h) ──────────────────────

/// GtkLayerShellLayer — we only need OVERLAY (always-on-top).
#[repr(u32)]
#[derive(Clone, Copy)]
pub enum LayerShellLayer {
    Background = 0,
    Bottom = 1,
    Top = 2,
    Overlay = 3,
}

/// GtkLayerShellEdge — margins are set per-edge.
#[repr(u32)]
#[derive(Clone, Copy)]
pub enum LayerShellEdge {
    Left = 0,
    Right = 1,
    Top = 2,
    Bottom = 3,
}

/// GtkLayerShellKeyboardMode — ON_DEMAND lets the user click into the widget
/// without grabbing exclusive keyboard focus.
#[repr(u32)]
#[derive(Clone, Copy)]
pub enum LayerShellKeyboardMode {
    None = 0,
    Exclusive = 1,
    OnDemand = 2,
}

// ─── FFI declarations ──────────────────────────────────────────────────────
//
// We declare the C functions ourselves rather than depending on the
// unmaintained gtk-layer-shell-sys crate. The signatures match the public
// header exactly. `GtkWindow*` is an opaque GObject pointer — we accept it
// as `*mut std::os::raw::c_void` and cast from the gtk-rs pointer.

type GtkWindowPtr = *mut std::os::raw::c_void;

extern "C" {
    fn gtk_layer_is_supported() -> glib::ffi::gboolean;
    fn gtk_layer_is_layer_window(window: GtkWindowPtr) -> glib::ffi::gboolean;
    fn gtk_layer_init_for_window(window: GtkWindowPtr);
    fn gtk_layer_set_layer(window: GtkWindowPtr, layer: LayerShellLayer);
    fn gtk_layer_set_anchor(window: GtkWindowPtr, edge: LayerShellEdge, anchor_to_edge: glib::ffi::gboolean);
    fn gtk_layer_set_margin(window: GtkWindowPtr, edge: LayerShellEdge, margin_size: i32);
    fn gtk_layer_set_keyboard_mode(window: GtkWindowPtr, mode: LayerShellKeyboardMode);
    fn gtk_layer_set_namespace(window: GtkWindowPtr, namespace: *const std::os::raw::c_char);
    fn gtk_layer_try_force_commit(window: GtkWindowPtr);
}

const TRUE: glib::ffi::gboolean = 1;
const FALSE: glib::ffi::gboolean = 0;

/// Check whether the compositor supports the layer-shell protocol.
pub fn is_supported() -> bool {
    unsafe { gtk_layer_is_supported() == TRUE }
}

/// Check whether a window has already been initialized as a layer-shell surface.
pub fn is_layer_window(app: &AppHandle, label: &str) -> bool {
    match gtk_window_ptr(app, label) {
        Ok(ptr) => unsafe { gtk_layer_is_layer_window(ptr) == TRUE },
        Err(_) => false,
    }
}

/// Get the raw `GtkWindow*` pointer from a Tauri webview window on Linux.
///
/// Tauri exposes `gtk_window()` → `gtk::ApplicationWindow`, which is a
/// subclass of `gtk::Window`. We upcast and extract the FFI pointer.
fn gtk_window_ptr(app: &AppHandle, label: &str) -> Result<GtkWindowPtr, String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("Window '{label}' not found"))?;
    let gtk_win: gtk::Window = window
        .gtk_window()
        .map_err(|e| e.to_string())?
        .upcast();
    // gtk::Window::as_ptr() returns *mut gtk::ffi::GtkWindow — a GObject
    // pointer that is layout-compatible with our opaque GtkWindowPtr.
    Ok(gtk_win.as_ptr() as GtkWindowPtr)
}

/// Turn an existing Tauri window into a layer-shell surface and position it
/// at absolute screen coordinates `(x, y)`.
///
/// This must be called **before** the window is shown (ideally right after
/// creation while it's still hidden). The window is anchored to the top-left
/// corner of the output, with margins providing the absolute offset.
///
/// `x`, `y` are in logical pixels.
pub fn init_layer_window(app: &AppHandle, label: &str, x: i32, y: i32) -> Result<(), String> {
    let ptr = gtk_window_ptr(app, label)?;

    unsafe {
        gtk_layer_init_for_window(ptr);
        // Overlay layer → always on top of regular windows.
        gtk_layer_set_layer(ptr, LayerShellLayer::Overlay);
        // Anchor to top-left only — don't stretch to fill the screen.
        gtk_layer_set_anchor(ptr, LayerShellEdge::Left, TRUE);
        gtk_layer_set_anchor(ptr, LayerShellEdge::Top, TRUE);
        gtk_layer_set_anchor(ptr, LayerShellEdge::Right, FALSE);
        gtk_layer_set_anchor(ptr, LayerShellEdge::Bottom, FALSE);
        // Margins provide the absolute screen position.
        gtk_layer_set_margin(ptr, LayerShellEdge::Left, x);
        gtk_layer_set_margin(ptr, LayerShellEdge::Top, y);
        // Let the user click into the widget without exclusive keyboard grab.
        gtk_layer_set_keyboard_mode(ptr, LayerShellKeyboardMode::OnDemand);
        // Namespace identifies the surface to the compositor.
        let ns = b"loadform\0";
        gtk_layer_set_namespace(ptr, ns.as_ptr() as *const _);
        // Force the initial state to commit immediately.
        gtk_layer_try_force_commit(ptr);
    }

    Ok(())
}

/// Reposition an already-initialized layer-shell window to new screen
/// coordinates `(x, y)` in logical pixels. Called when the sun is dragged
/// and planets need to follow.
pub fn move_layer_window(app: &AppHandle, label: &str, x: i32, y: i32) -> Result<(), String> {
    let ptr = gtk_window_ptr(app, label)?;

    unsafe {
        gtk_layer_set_margin(ptr, LayerShellEdge::Left, x);
        gtk_layer_set_margin(ptr, LayerShellEdge::Top, y);
        gtk_layer_try_force_commit(ptr);
    }

    Ok(())
}