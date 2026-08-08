use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

mod audio_capture;
mod config;
/// Wayland-only. Non-Linux targets position windows through `placement` alone.
#[cfg(target_os = "linux")]
mod layer_shell;
mod placement;

use audio_capture::{list_audio_devices, start_capture, CaptureHandle, CaptureOptions, AudioDevice};
use config::ConfigState;

/// Live data for every open planet window, keyed by field key.
///
/// Planet windows *pull* their initial data from here on load rather than
/// relying on an event fired at creation time — a freshly built window has not
/// registered its listeners yet, so a push would be dropped on the floor.
#[derive(Default)]
pub struct PlanetStore {
    planets: Mutex<HashMap<String, serde_json::Value>>,
}

/// Authoritative screen position of the sun widget, in logical pixels.
///
/// On Wayland `outer_position()` is unsupported for layer-shell surfaces, so we
/// can't ask the compositor where the widget is — we are the only ones who
/// know, because we set the anchor margins ourselves.
pub struct WidgetPos {
    inner: Mutex<WidgetPlacement>,
}

struct WidgetPlacement {
    x: i32,
    y: i32,
    /// Whether the widget has been placed already. Tracked here rather than
    /// asked of the window system, both because the answer is
    /// platform-specific and because on Linux the layer-shell init must happen
    /// exactly once, while the window is still unmapped.
    placed: bool,
}

impl Default for WidgetPos {
    fn default() -> Self {
        Self {
            inner: Mutex::new(WidgetPlacement { x: 100, y: 100, placed: false }),
        }
    }
}

use ollama_rs::{
    generation::completion::{request::GenerationRequest, GenerationResponse},
    Ollama,
};

// ─── Shared State ───────────────────────────────────────────────────────────

pub struct CaptureState {
    handle: Mutex<Option<CaptureHandle>>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            handle: Mutex::new(None),
        }
    }
}

// ─── Data Types ─────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct LoadFormData {
    #[serde(default)]
    pub pickup_location: String,
    #[serde(default)]
    pub pickup_datetime: String,
    #[serde(default)]
    pub pickup_type: String,
    #[serde(default)]
    pub pickup_window: String,
    #[serde(default)]
    pub delivery_location: String,
    #[serde(default)]
    pub delivery_datetime: String,
    #[serde(default)]
    pub delivery_type: String,
    #[serde(default)]
    pub delivery_window: String,
    #[serde(default)]
    pub stops: String,
    #[serde(default)]
    pub commodity: String,
    #[serde(default)]
    pub equipment_type: String,
    #[serde(default)]
    pub trailer_instructions: String,
    #[serde(default)]
    pub rate: String,
    #[serde(default)]
    pub weight: String,
    #[serde(default)]
    pub additional_notes: String,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct LoadFormDataWithConfidence {
    #[serde(default)]
    pub data: LoadFormData,
    #[serde(default)]
    pub confidence: HashMap<String, f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExtractionRequest {
    pub transcript: String,
}

// ─── Ollama Native API Types ────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct OllamaGenerateRequest {
    model: String,
    prompt: String,
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct OllamaGenerateResponse {
    response: String,
}

// ─── LLM Extraction ─────────────────────────────────────────────────────────

#[tauri::command]
async fn extract_load_data(
    config: State<'_, ConfigState>,
    app: AppHandle,
    req: ExtractionRequest,
) -> Result<LoadFormDataWithConfidence, String> {
    let (base_url, model, api_key, is_local) = {
        let cfg = config.config.lock().unwrap();
        (
            cfg.ollama_base_url.clone(),
            cfg.ollama_model.clone(),
            cfg.ollama_api_key.clone(),
            cfg.is_local_ollama(),
        )
    };

    let prompt = format!(
        r#"You are a logistics data extraction assistant. Given a broker conversation transcript, extract the following fields:
- pickup_location: where the load picks up (city, state)
- pickup_datetime: when the load picks up (day, date, time)
- pickup_type: how the pickup works — "live load" (driver waits while loaded), "drop and hook" (drop empty, grab preloaded), "empty in" (arrive with empty trailer), "preloaded" (trailer already loaded, hook and go)
- pickup_window: time window or appointment type — e.g. "FCFS 10am-4pm", "Appointment 2:00 PM", "ASAP", "24/7"
- delivery_location: where the load delivers (city, state)
- delivery_datetime: when the load delivers (day, date, time)
- delivery_type: how the delivery works — "live unload" (driver waits while unloaded), "drop and hook" (drop loaded, grab empty), "empty out" (leave with empty trailer)
- delivery_window: time window or appointment type for delivery — e.g. "FCFS 8am-5pm", "Appointment 9:00 AM"
- stops: any intermediate stops between pickup and delivery, or "none" if direct. Format as "City, ST → City, ST" for multiple.
- commodity: what is being shipped (be specific: "frozen chicken", "steel coils", "retail goods")
- equipment_type: truck type (reefer, dry van, flatbed, step deck, conestoga, etc.)
- trailer_instructions: full operation chain for drivers without trailers — e.g. "Pick empty nearby → live load → live unload", "Hook preloaded at shipper → drop and hook at receiver", "Empty in → live load → drop and hook"
- rate: pay rate mentioned ($/mile or total amount)
- weight: load weight in lbs
- additional_notes: any other relevant info (lumpers, appointments, hazmat, T-check, pallet jack, etc.)

For each field, provide a confidence score from 0.0 to 1.0.
Return ONLY valid JSON in this exact format with no markdown code blocks:
{{
  "data": {{
    "pickup_location": "...",
    "pickup_datetime": "...",
    "pickup_type": "...",
    "pickup_window": "...",
    "delivery_location": "...",
    "delivery_datetime": "...",
    "delivery_type": "...",
    "delivery_window": "...",
    "stops": "...",
    "commodity": "...",
    "equipment_type": "...",
    "trailer_instructions": "...",
    "rate": "...",
    "weight": "...",
    "additional_notes": "..."
  }},
  "confidence": {{
    "pickup_location": 0.95,
    "pickup_datetime": 0.87,
    "pickup_type": 0.82,
    "pickup_window": 0.90,
    "delivery_location": 0.98,
    "delivery_datetime": 0.91,
    "delivery_type": 0.85,
    "delivery_window": 0.88,
    "stops": 0.95,
    "commodity": 0.82,
    "equipment_type": 0.99,
    "trailer_instructions": 0.75,
    "rate": 0.89,
    "weight": 0.95,
    "additional_notes": 0.75
  }}
}}

Transcript:
{}"#,
        req.transcript
    );

    let raw_content = if is_local {
        // Local Ollama — native ollama-rs
        let ollama = Ollama::default();
        let request = GenerationRequest::new(model, prompt);
        let response: GenerationResponse = ollama
            .generate(request)
            .await
            .map_err(|e| format!("Local Ollama generation failed: {}", e))?;
        response.response
    } else {
        // Remote Ollama — native /api/generate with auth
        let api_req = OllamaGenerateRequest {
            model,
            prompt,
            stream: false,
        };

        let client = reqwest::Client::new();
        let url = format!("{}/api/generate", base_url.trim_end_matches('/'));

        let mut builder = client.post(&url).json(&api_req);
        if !api_key.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", api_key));
        }

        let response = builder.send().await.map_err(|e| format!("HTTP error: {}", e))?;
        let status = response.status();
        let body_text = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response body: {}", e))?;

        if !status.is_success() {
            return Err(format!("Ollama API error {}: {}", status, body_text));
        }

        let api_response: OllamaGenerateResponse = serde_json::from_str(&body_text)
            .map_err(|e| format!("Failed to parse Ollama response: {}. Body: {}", e, body_text))?;

        api_response.response
    };

    // The LLM response may contain markdown code blocks — strip them
    let cleaned = raw_content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: LoadFormDataWithConfidence = serde_json::from_str(cleaned).map_err(|e| {
        format!(
            "Failed to parse LLM output as LoadFormDataWithConfidence: {}. Raw: {}",
            e, raw_content
        )
    })?;

    // Broadcast the extracted fields to every window (main + widget) so the
    // floating widget's orbital "planet" chips can update in real time as the
    // dispatcher talks — even though extraction was invoked by the main window.
    let _ = app.emit("load:fields", &parsed);

    Ok(parsed)
}

// ─── Clipboard ──────────────────────────────────────────────────────────────

#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        use arboard::Clipboard;
        let mut clipboard =
            Clipboard::new().map_err(|e| format!("Failed to access clipboard: {}", e))?;
        clipboard
            .set_text(text)
            .map_err(|e| format!("Failed to set clipboard text: {}", e))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Clipboard not supported on this platform".to_string())
    }
}

// ─── Tauri Entry ────────────────────────────────────────────────────────────

#[tauri::command]
fn list_devices() -> Vec<AudioDevice> {
    list_audio_devices()
}

#[tauri::command]
fn start_capture_cmd(
    state: State<'_, CaptureState>,
    config: State<'_, ConfigState>,
    app: AppHandle,
    device_id: String,
    mix_system_audio: bool,
) -> Result<(), String> {
    config.config.lock().unwrap().is_valid()?;

    let mut guard = state.handle.lock().unwrap();
    if guard.is_some() {
        return Err("Capture already running".to_string());
    }

    let options = CaptureOptions {
        device_id: device_id.clone(),
        mix_system_audio,
    };

    let handle = start_capture(
        app.clone(),
        config.config.lock().unwrap().deepgram_api_key.clone(),
        options,
    )?;
    *guard = Some(handle);
    let _ = app.emit(
        "capture:state",
        serde_json::json!({
            "running": true,
            "deviceId": device_id,
            "mixSystemAudio": mix_system_audio,
        }),
    );
    Ok(())
}

#[tauri::command]
fn stop_capture(state: State<'_, CaptureState>, app: AppHandle) -> Result<(), String> {
    let mut guard = state.handle.lock().unwrap();
    if let Some(handle) = guard.take() {
        handle.stop();
        let _ = app.emit("capture:state", serde_json::json!({ "running": false }));
        Ok(())
    } else {
        Err("No capture running".to_string())
    }
}

#[tauri::command]
fn is_capture_running(state: State<'_, CaptureState>) -> bool {
    state.handle.lock().unwrap().is_some()
}

/// Logical size of the monitor the widget lives on.
///
/// `current_monitor()` reports `None` for a window that hasn't been mapped yet —
/// which is exactly the state we're in when choosing where to place the widget —
/// so fall through to the primary monitor and then to any monitor at all before
/// giving up on a hardcoded guess.
fn monitor_logical_size(window: &tauri::WebviewWindow) -> (i32, i32) {
    let candidates = [
        window.current_monitor().ok().flatten(),
        window.primary_monitor().ok().flatten(),
        window
            .available_monitors()
            .ok()
            .and_then(|mons| mons.into_iter().next()),
    ];

    for mon in candidates.into_iter().flatten() {
        let scale = mon.scale_factor();
        let size = mon.size();
        if scale > 0.0 && size.width > 0 && size.height > 0 {
            return (
                (size.width as f64 / scale).round() as i32,
                (size.height as f64 / scale).round() as i32,
            );
        }
    }
    (1920, 1080)
}

#[tauri::command]
fn toggle_widget(app: AppHandle, widget_pos: State<'_, WidgetPos>) -> Result<(), String> {
    let Some(window) = app.get_webview_window("widget") else {
        return Err("Widget window not found".to_string());
    };
    if window.is_visible().map_err(|e| e.to_string())? {
        window.hide().map_err(|e| e.to_string())?;
        // Close all planet windows when the sun hides.
        for (label, win) in app.webview_windows() {
            if label.starts_with("planet-") {
                let _ = win.close();
            }
        }
    } else {
        // Place the widget BEFORE showing it. On Linux this is where
        // gtk_layer_init_for_window runs, and it asserts the window is not yet
        // mapped — doing it after show() triggers
        // "custom_shell_surface_init: assertion '!gtk_widget_get_mapped'".
        {
            let mut pos = widget_pos.inner.lock().unwrap();
            if !pos.placed {
                // Centre the sun on its monitor so there is room for planets to
                // orbit on every side. `outer_position()` is not supported for
                // Wayland surfaces, so we choose the position rather than read it.
                let (mon_w, mon_h) = monitor_logical_size(&window);
                let x = ((mon_w - WIDGET_W) / 2).max(0);
                let y = ((mon_h - WIDGET_H) / 2).max(0);
                placement::init_window(&app, "widget", x, y, WIDGET_W, WIDGET_H)?;
                *pos = WidgetPlacement { x, y, placed: true };
            }
        }
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();

        // Tell the widget where it ended up. Its JS ran at app startup — long
        // before this first show — so whatever geometry it read back then is
        // stale, and planets would be laid out around the wrong origin.
        let (x, y) = {
            let pos = widget_pos.inner.lock().unwrap();
            (pos.x, pos.y)
        };
        let (screen_w, screen_h) = monitor_logical_size(&window);
        let _ = app.emit_to(
            "widget",
            "widget:geometry",
            WidgetGeometry {
                x,
                y,
                screen_w,
                screen_h,
                uses_layer_shell: USES_LAYER_SHELL,
            },
        );
    }
    Ok(())
}

// ─── Layer-shell orbit commands (Wayland-native window positioning) ────────
//
// The sun widget and each planet chip are placed at exact screen coordinates
// through `placement`, which on Wayland means the wlr-layer-shell protocol and
// elsewhere just the ordinary window API. The sun is draggable via JS; on each
// drag tick JS reports the sun's new position and Rust re-anchors every planet
// relative to it.

/// Logical size of the sun widget — must match the `widget` window in
/// tauri.conf.json and the SUN_W/SUN_H constants in widget.js.
const WIDGET_W: i32 = 300;
const WIDGET_H: i32 = 190;
const PLANET_W: f64 = 112.0;
const PLANET_H: f64 = 60.0;

#[tauri::command]
fn init_layer_widget(
    app: AppHandle,
    widget_pos: State<'_, WidgetPos>,
    x: i32,
    y: i32,
) -> Result<(), String> {
    placement::init_window(&app, "widget", x, y, WIDGET_W, WIDGET_H)?;
    *widget_pos.inner.lock().unwrap() = WidgetPlacement { x, y, placed: true };
    Ok(())
}

/// One planet's new position within a [`move_orbit`] batch.
#[derive(Deserialize)]
struct PlanetMove {
    key: String,
    x: i32,
    y: i32,
}

/// Move the sun and every planet in one call, in one event-loop turn.
///
/// The drag loop used to issue `move_layer_widget` plus one `move_planet_window`
/// per planet every frame — sixteen IPC round trips at 60fps with a full orbit,
/// each a separate window-move on the main thread. Batching keeps the message
/// loop clear (every move is a real `SetWindowPos` on Windows) and moves the
/// whole constellation together, so the planets don't trail the sun.
///
/// A planet that has closed since JS built the batch is skipped rather than
/// failing the call: the sun's own move matters more than a stale entry.
#[tauri::command]
fn move_orbit(
    app: AppHandle,
    widget_pos: State<'_, WidgetPos>,
    x: i32,
    y: i32,
    planets: Vec<PlanetMove>,
) -> Result<(), String> {
    placement::move_window(&app, "widget", x, y)?;
    {
        let mut pos = widget_pos.inner.lock().unwrap();
        pos.x = x;
        pos.y = y;
    }
    for planet in planets {
        let label = format!("planet-{}", planet.key);
        let _ = placement::move_window(&app, &label, planet.x, planet.y);
    }
    Ok(())
}

/// The sun's position plus the usable screen size, so JS can lay planets out
/// without running them off the edge of the monitor.
///
/// `uses_layer_shell` tells the drag tracker which coordinate space it can
/// trust. It has to come from here rather than a JS user-agent sniff, because
/// the answer *is* which `placement` backend was compiled in — see the drag
/// section of widget.js.
#[derive(Serialize, Clone)]
struct WidgetGeometry {
    x: i32,
    y: i32,
    screen_w: i32,
    screen_h: i32,
    uses_layer_shell: bool,
}

/// True when window placement goes through wlr-layer-shell (Linux) rather than
/// the ordinary top-level window API.
const USES_LAYER_SHELL: bool = cfg!(target_os = "linux");

#[tauri::command]
fn get_widget_position(
    app: AppHandle,
    widget_pos: State<'_, WidgetPos>,
) -> Result<WidgetGeometry, String> {
    let win = app
        .get_webview_window("widget")
        .ok_or("Widget window not found")?;
    let (x, y) = {
        let pos = widget_pos.inner.lock().unwrap();
        (pos.x, pos.y)
    };
    let (screen_w, screen_h) = monitor_logical_size(&win);
    Ok(WidgetGeometry {
        x,
        y,
        screen_w,
        screen_h,
        uses_layer_shell: USES_LAYER_SHELL,
    })
}

/// Payload for creating a planet window. `key` is the field key (unique label),
/// `label`/`icon`/`value`/`confidence` are display data, `x`/`y` is the screen
/// position in logical px.
///
/// `rename_all = "camelCase"` is required: Tauri camel-cases *command
/// parameter* names for you, but nested struct fields go straight through
/// serde, so `isDemo` from JS would otherwise fail to match `is_demo` and the
/// whole command would error out with "missing field".
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePlanetPayload {
    key: String,
    label: String,
    icon: String,
    value: String,
    confidence: f64,
    is_demo: bool,
    x: i32,
    y: i32,
}

/// Spawn (or refresh) the window for one planet.
///
/// **This command must stay `async`.** Tauri runs a synchronous command on the
/// main thread, inside the IPC callback of the webview that invoked it — and on
/// Windows, building a webview from inside another webview's callback deadlocks
/// the WebView2 message loop (wry#583). The whole app hangs hard: no repaint, no
/// input, kill-from-Task-Manager territory. Marking the command `async` moves it
/// onto the async runtime, so `build()` runs off the main thread and the event
/// loop stays free to service window creation. GTK/WebKitGTK on Linux has no
/// such re-entrancy problem, which is why this only ever bit on Windows.
#[tauri::command]
async fn create_planet_window(
    app: AppHandle,
    store: State<'_, PlanetStore>,
    planet: CreatePlanetPayload,
) -> Result<(), String> {
    let label = format!("planet-{}", planet.key);

    let data = serde_json::json!({
        "key": planet.key,
        "label": planet.label,
        "icon": planet.icon,
        "value": planet.value,
        "confidence": planet.confidence,
        "is_demo": planet.is_demo,
    });

    // Publish the data *before* the window exists so that however fast the
    // webview loads, `get_planet_data` already has an answer for it.
    store
        .planets
        .lock()
        .unwrap()
        .insert(planet.key.clone(), data.clone());

    // If this planet window already exists, just move it and push the update.
    if app.get_webview_window(&label).is_some() {
        let _ = app.emit_to(&label, "planet:data", &data);
        return placement::move_window(&app, &label, planet.x, planet.y);
    }

    // The key travels in the query string: the window needs to know which
    // planet it is before it can ask for its data. Field keys are plain
    // snake_case identifiers, so no escaping is needed.
    let win = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(format!("planet.html?key={}", planet.key).into()),
    )
    .title("LoadForm")
    .inner_size(PLANET_W, PLANET_H)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false) // never steal focus from the sun mid-drag
    .visible(false) // shown once it has been placed
    .build()
    .map_err(|e| e.to_string())?;

    // Position it before showing so it appears at the right spot on the first
    // frame — on Wayland that means promoting it to a layer-shell surface,
    // which additionally *requires* the window to still be unmapped.
    //
    // Tear the window back down if placement fails: it is still hidden, and a
    // hidden-but-registered window would make every later create for this key
    // take the "already exists" branch above and silently move an invisible
    // window instead of ever showing a planet again.
    if let Err(err) = placement::init_window(
        &app,
        &label,
        planet.x,
        planet.y,
        PLANET_W as i32,
        PLANET_H as i32,
    ) {
        let _ = win.destroy();
        return Err(err);
    }

    win.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// Hand a freshly loaded planet window its display data. Pull-based by design —
/// see `PlanetStore`.
#[tauri::command]
fn get_planet_data(store: State<'_, PlanetStore>, key: String) -> Option<serde_json::Value> {
    store.planets.lock().unwrap().get(&key).cloned()
}

#[tauri::command]
fn move_planet_window(app: AppHandle, key: String, x: i32, y: i32) -> Result<(), String> {
    let label = format!("planet-{key}");
    placement::move_window(&app, &label, x, y)
}

/// Update a planet's displayed value (called on re-extraction with new data).
///
/// Merges into the stored record rather than replacing it, so a value update
/// doesn't wipe out the planet's label, icon or demo flag.
#[tauri::command]
fn update_planet_window(
    app: AppHandle,
    store: State<'_, PlanetStore>,
    key: String,
    value: String,
    confidence: f64,
) -> Result<(), String> {
    let label = format!("planet-{key}");

    let merged = {
        let mut planets = store.planets.lock().unwrap();
        let entry = planets
            .entry(key.clone())
            .or_insert_with(|| serde_json::json!({ "key": key }));
        if let Some(obj) = entry.as_object_mut() {
            obj.insert("value".into(), serde_json::json!(value));
            obj.insert("confidence".into(), serde_json::json!(confidence));
        }
        entry.clone()
    };

    let _ = app.emit_to(&label, "planet:data", &merged);
    Ok(())
}

#[tauri::command]
fn close_planet_window(app: AppHandle, store: State<'_, PlanetStore>, key: String) -> Result<(), String> {
    let label = format!("planet-{key}");
    store.planets.lock().unwrap().remove(&key);
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Close every planet window at once (e.g. when capture stops or demo clears).
#[tauri::command]
fn close_all_planets(app: AppHandle, store: State<'_, PlanetStore>) -> Result<(), String> {
    store.planets.lock().unwrap().clear();
    for (label, win) in app.webview_windows() {
        if label.starts_with("planet-") {
            let _ = win.close();
        }
    }
    Ok(())
}

#[tauri::command]
fn continue_in_app(app: AppHandle) -> Result<(), String> {
    // Focus the main window (show it in case it was minimized), then hide the
    // floating widget. Driven from Rust so it doesn't depend on JS-side
    // window-control permissions.
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    if let Some(widget) = app.get_webview_window("widget") {
        widget.hide().map_err(|e| e.to_string())?;
        for (label, win) in app.webview_windows() {
            if label.starts_with("planet-") {
                let _ = win.close();
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn minimize_main(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("Main window not found")?
        .minimize()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_maximize_main(app: AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("Main window not found")?;
    if win.is_maximized().map_err(|e| e.to_string())? {
        win.unmaximize().map_err(|e| e.to_string())
    } else {
        win.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn close_main(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("Main window not found")?
        .close()
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
struct SetApiKeysPayload {
    deepgram_key: String,
    ollama_key: String,
}

#[tauri::command]
fn set_api_keys(
    state: State<'_, ConfigState>,
    payload: SetApiKeysPayload,
) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_keys(payload.deepgram_key, payload.ollama_key);
    Ok(())
}

#[tauri::command]
fn logout(state: State<'_, ConfigState>) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.deepgram_api_key.clear();
    cfg.ollama_api_key.clear();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ConfigState::default())
        .manage(CaptureState::default())
        .manage(PlanetStore::default())
        .manage(WidgetPos::default())
        .invoke_handler(tauri::generate_handler![
            extract_load_data,
            copy_to_clipboard,
            list_devices,
            start_capture_cmd,
            stop_capture,
            is_capture_running,
            toggle_widget,
            init_layer_widget,
            move_orbit,
            get_widget_position,
            create_planet_window,
            get_planet_data,
            move_planet_window,
            update_planet_window,
            close_planet_window,
            close_all_planets,
            continue_in_app,
            minimize_main,
            toggle_maximize_main,
            close_main,
            set_api_keys,
            logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_form_data_serialization() {
        let data = LoadFormData {
            pickup_location: "Amarillo, TX".to_string(),
            pickup_datetime: "Tue 6/24, 8:00 AM".to_string(),
            delivery_location: "Tulsa, OK".to_string(),
            delivery_datetime: "Thu 6/26, 6:00 AM".to_string(),
            commodity: "Frozen chicken".to_string(),
            equipment_type: "Reefer".to_string(),
            rate: "$2.80/mile ($2,100 total)".to_string(),
            weight: "43,000 lbs".to_string(),
            additional_notes: "Lumpers required".to_string(),
            ..Default::default()
        };

        let json = serde_json::to_string(&data).unwrap();
        let back: LoadFormData = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pickup_location, "Amarillo, TX");
        assert_eq!(back.equipment_type, "Reefer");
    }

    #[test]
    fn test_confidence_parsing() {
        let raw = r#"{
            "data": {
                "pickup_location": "Amarillo, TX",
                "pickup_datetime": "Tue 6/24, 8:00 AM",
                "delivery_location": "Tulsa, OK",
                "delivery_datetime": "Thu 6/26, 6:00 AM",
                "commodity": "Frozen chicken",
                "equipment_type": "Reefer",
                "rate": "$2.80/mile",
                "weight": "43,000 lbs",
                "additional_notes": ""
            },
            "confidence": {
                "pickup_location": 0.98,
                "pickup_datetime": 0.87,
                "delivery_location": 0.96,
                "delivery_datetime": 0.91,
                "commodity": 0.82,
                "equipment_type": 0.99,
                "rate": 0.89,
                "weight": 0.95,
                "additional_notes": 0.0
            }
        }"#;

        let parsed: LoadFormDataWithConfidence = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.data.pickup_location, "Amarillo, TX");
        assert_eq!(
            parsed.confidence.get("pickup_location"),
            Some(&0.98)
        );
        assert_eq!(
            parsed.confidence.get("additional_notes"),
            Some(&0.0)
        );
    }

    #[test]
    fn test_markdown_code_block_stripping() {
        let raw = r#"```json
        {
            "data": {"pickup_location": "Test"},
            "confidence": {"pickup_location": 0.95}
        }
        ```"#;

        let cleaned = raw
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();

        let parsed: LoadFormDataWithConfidence = serde_json::from_str(cleaned).unwrap();
        assert_eq!(parsed.data.pickup_location, "Test");
    }
}
