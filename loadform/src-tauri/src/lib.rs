use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

mod audio_capture;
mod config;
mod layer_shell;

use audio_capture::{list_audio_devices, start_capture, CaptureHandle, CaptureOptions, AudioDevice};
use config::ConfigState;

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

// ─── LLM Extraction ─────────────────────────────────────────────────────────

#[tauri::command]
async fn extract_load_data(
    config: State<'_, ConfigState>,
    app: AppHandle,
    req: ExtractionRequest,
) -> Result<LoadFormDataWithConfidence, String> {
    // Cloud extraction goes through the `extract` Edge Function (called from
    // src/main.js), which holds the Ollama key. This command is the
    // local-Ollama development path only, so the desktop process never needs a
    // provider credential.
    let (model, is_local) = {
        let cfg = config.config.lock().unwrap();
        (cfg.ollama_model.clone(), cfg.is_local_ollama())
    };

    if !is_local {
        return Err(
            "extract_load_data is the local-Ollama dev path only. Cloud extraction goes through \
             the `extract` Edge Function. Set OLLAMA_BASE_URL=http://localhost:11434 to use this."
                .to_string(),
        );
    }

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

    // Local Ollama — native ollama-rs. The remote branch is gone: cloud
    // extraction is the `extract` Edge Function's job now.
    let raw_content = {
        let ollama = Ollama::default();
        let request = GenerationRequest::new(model, prompt);
        let response: GenerationResponse = ollama
            .generate(request)
            .await
            .map_err(|e| format!("Local Ollama generation failed: {}", e))?;
        response.response
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
    app: AppHandle,
    device_id: String,
    mix_system_audio: bool,
    deepgram_token: String,
) -> Result<(), String> {
    if deepgram_token.trim().is_empty() {
        return Err("Missing Deepgram token — is the session still valid?".to_string());
    }

    let mut guard = state.handle.lock().unwrap();
    if guard.is_some() {
        return Err("Capture already running".to_string());
    }

    let options = CaptureOptions {
        device_id: device_id.clone(),
        mix_system_audio,
    };

    let handle = start_capture(app.clone(), deepgram_token, options)?;
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

#[tauri::command]
fn toggle_widget(app: AppHandle) -> Result<(), String> {
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
        // Initialize layer-shell BEFORE showing — gtk_layer_init_for_window
        // asserts the window is not yet mapped. Doing this after show()
        // triggers "custom_shell_surface_init: assertion '!gtk_widget_get_mapped'"
        // criticals. Position at a sensible default; JS will refine after load.
        if !layer_shell::is_layer_window(&app, "widget") {
            // Place near top-right of the screen by default.
            if let Ok(pos) = window.outer_position() {
                let _ = layer_shell::init_layer_window(&app, "widget", pos.x, pos.y);
            } else {
                let _ = layer_shell::init_layer_window(&app, "widget", 100, 100);
            }
        }
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
    }
    Ok(())
}

// ─── Layer-shell orbit commands (Wayland-native window positioning) ────────
//
// On Wayland, regular windows can't be positioned by the app. We use the
// wlr-layer-shell protocol (via gtk-layer-shell) to place the sun widget and
// each planet chip at exact screen coordinates. The sun is draggable via JS;
// on each drag tick JS reads the sun's new position and tells Rust to
// re-anchor every planet relative to it.

#[tauri::command]
fn init_layer_widget(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    layer_shell::init_layer_window(&app, "widget", x, y)
}

/// Reposition the sun widget without re-initializing layer-shell. Used by
 /// JS during drag to update margins only.
#[tauri::command]
fn move_layer_widget(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    layer_shell::move_layer_window(&app, "widget", x, y)
}

#[tauri::command]
fn get_widget_position(app: AppHandle) -> Result<(i32, i32), String> {
    let win = app
        .get_webview_window("widget")
        .ok_or("Widget window not found")?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    Ok((pos.x, pos.y))
}

/// Payload for creating a planet window. `key` is the field key (unique label),
/// `label`/`icon`/`value`/`confidence` are display data, `x`/`y` is the screen
/// position in logical px.
#[derive(Deserialize)]
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

#[tauri::command]
fn create_planet_window(app: AppHandle, planet: CreatePlanetPayload) -> Result<(), String> {
    let label = format!("planet-{}", planet.key);

    // If this planet window already exists, just move it.
    if app.get_webview_window(&label).is_some() {
        return layer_shell::move_layer_window(&app, &label, planet.x, planet.y);
    }

    let win = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("planet.html".into()),
    )
    .title("LoadForm")
    .inner_size(150.0, 70.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .shadow(false)
    .visible(false) // shown after layer-shell init
    .build()
    .map_err(|e| e.to_string())?;

    // Initialize layer-shell before showing so the compositor places it at
    // the exact position from the first frame.
    layer_shell::init_layer_window(&app, &label, planet.x, planet.y)?;

    // Send the planet its display data so it can render the chip.
    let _ = app.emit_to(
        &label,
        "planet:data",
        serde_json::json!({
            "key": planet.key,
            "label": planet.label,
            "icon": planet.icon,
            "value": planet.value,
            "confidence": planet.confidence,
            "is_demo": planet.is_demo,
        }),
    );

    win.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn move_planet_window(app: AppHandle, key: String, x: i32, y: i32) -> Result<(), String> {
    let label = format!("planet-{key}");
    layer_shell::move_layer_window(&app, &label, x, y)
}

/// Update a planet's displayed value (called on re-extraction with new data).
#[tauri::command]
fn update_planet_window(
    app: AppHandle,
    key: String,
    value: String,
    confidence: f64,
) -> Result<(), String> {
    let label = format!("planet-{key}");
    let _ = app.emit_to(
        &label,
        "planet:data",
        serde_json::json!({
            "key": key,
            "value": value,
            "confidence": confidence,
        }),
    );
    Ok(())
}

#[tauri::command]
fn close_planet_window(app: AppHandle, key: String) -> Result<(), String> {
    let label = format!("planet-{key}");
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Close every planet window at once (e.g. when capture stops or demo clears).
#[tauri::command]
fn close_all_planets(app: AppHandle) -> Result<(), String> {
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

/// Re-broadcast extracted fields to every window.
///
/// When extraction ran inside Rust it emitted `load:fields` itself. Cloud
/// extraction now happens in the `extract` Edge Function and is called from the
/// main window's JS, which has no way to reach the widget window — so the
/// caller hands the parsed result back through here to fan it out. Keeps the
/// orbital planet chips updating live during a call.
#[tauri::command]
fn broadcast_load_fields(app: AppHandle, fields: LoadFormDataWithConfidence) -> Result<(), String> {
    app.emit("load:fields", &fields).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ConfigState::default())
        .manage(CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            extract_load_data,
            copy_to_clipboard,
            list_devices,
            start_capture_cmd,
            stop_capture,
            is_capture_running,
            toggle_widget,
            init_layer_widget,
            move_layer_widget,
            get_widget_position,
            create_planet_window,
            move_planet_window,
            update_planet_window,
            close_planet_window,
            close_all_planets,
            continue_in_app,
            minimize_main,
            toggle_maximize_main,
            close_main,
            broadcast_load_fields,
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
