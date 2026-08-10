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
use config::{ConfigState, LlmProvider};

/// Live data for every open planet window, keyed by field key.
///
/// Planet windows *pull* their initial data from here on load rather than
/// relying on an event fired at creation time — a freshly built window has not
/// registered its listeners yet, so a push would be dropped on the floor.
#[derive(Default)]
pub struct PlanetStore {
    planets: Mutex<HashMap<String, serde_json::Value>>,
}

/// The load as it stands after every extraction so far in this session.
///
/// Extraction is not a single shot: the same growing transcript is re-sent every
/// few seconds, and the model answers each call from scratch. A field it filled
/// at 0:20 can come back empty at 0:25 simply because the model chose to write
/// less this time — nothing about the conversation retracted it. Replacing the
/// whole form with each answer therefore makes fields (and their planets) blink
/// in and out, and leaves the load looking like whatever the last call happened
/// to bother filling in.
///
/// So answers accumulate here instead: see [`merge_extraction`] for what a new
/// answer is allowed to change. Cleared when a capture session starts and when
/// the form is reset, since both mean "this is a different load now".
#[derive(Default)]
pub struct ExtractionStore {
    inner: Mutex<LoadFormDataWithConfidence>,
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

// ─── Gemini API Types ───────────────────────────────────────────────────────
//
// Modelled as concrete structs rather than poked at through `serde_json::Value`
// so a shape change in the API fails loudly at parse time with a message that
// names the missing field, instead of turning into a `None` three layers deep.

#[derive(Debug, Serialize)]
struct GeminiGenerateRequest {
    contents: Vec<GeminiContent>,
    #[serde(rename = "generationConfig")]
    generation_config: GeminiGenerationConfig,
}

#[derive(Debug, Serialize, Deserialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Debug, Serialize, Deserialize)]
struct GeminiPart {
    text: String,
}

#[derive(Debug, Serialize)]
struct GeminiGenerationConfig {
    #[serde(rename = "responseMimeType")]
    response_mime_type: String,
    temperature: f32,
}

/// `content` and `finishReason` are optional because a candidate that trips a
/// safety filter comes back with a reason and no parts at all.
#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    #[serde(default)]
    content: Option<GeminiContent>,
    #[serde(rename = "finishReason", default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GeminiGenerateResponse {
    #[serde(default)]
    candidates: Vec<GeminiCandidate>,
    /// Present instead of `candidates` when the whole prompt is blocked.
    #[serde(rename = "promptFeedback", default)]
    prompt_feedback: Option<GeminiPromptFeedback>,
}

#[derive(Debug, Deserialize)]
struct GeminiPromptFeedback {
    #[serde(rename = "blockReason", default)]
    block_reason: Option<String>,
}

impl GeminiGenerateResponse {
    /// Pulls the model text out of the first candidate, or explains why there
    /// isn't one. A blocked response is a 200 OK with an empty candidate list,
    /// so this is the only place the failure is visible.
    fn into_text(self) -> Result<String, String> {
        let Some(candidate) = self.candidates.into_iter().next() else {
            let reason = self
                .prompt_feedback
                .and_then(|f| f.block_reason)
                .unwrap_or_else(|| "no reason given".to_string());
            return Err(format!(
                "Gemini returned no candidates (likely a safety block): {}",
                reason
            ));
        };

        let finish_reason = candidate.finish_reason.clone();
        candidate
            .content
            .map(|c| {
                c.parts
                    .into_iter()
                    .map(|p| p.text)
                    .collect::<Vec<_>>()
                    .join("")
            })
            .filter(|text| !text.is_empty())
            .ok_or_else(|| {
                format!(
                    "Gemini candidate contained no text (finishReason: {})",
                    finish_reason.unwrap_or_else(|| "unknown".to_string())
                )
            })
    }
}

// ─── Extraction merging ─────────────────────────────────────────────────────

/// Confidence below which a *new* field is not worth showing at all.
///
/// Only gates fields the load doesn't have yet. A model asked for fifteen keys
/// on a transcript that so far mentions two of them will guess at the rest, and
/// it usually scores those guesses honestly — this is where they get dropped.
const MIN_NEW_FIELD_CONFIDENCE: f64 = 0.3;

/// How much *worse* a fresh answer's confidence may be than the one already
/// held before it stops counting as a correction. Later calls see more of the
/// conversation, so they win ties and near-ties; only a clear drop is refused.
const CONFIDENCE_HYSTERESIS: f64 = 0.15;

/// Phrases a model writes when it has nothing to say but has been asked for a
/// value anyway. Matched after lowercasing and trimming punctuation.
///
/// The prompt asks for an empty string in that case, and mostly gets one. This
/// is the net under that: in the form a stray "N/A" lands in a labelled input
/// and reads as filled-in; in orbit it's a chip floating in space announcing
/// that nothing is known, which is worse than no chip at all.
const EMPTY_ANSWERS: &[&str] = &[
    "none", "n/a", "na", "null", "nil", "nan", "unknown", "unspecified", "undisclosed", "tbd",
    "tba", "empty", "blank", "no", "n/s", "no info",
];

/// Openings that mean the rest of the sentence is an excuse, not a value —
/// "not mentioned in the transcript", "none specified by the broker".
///
/// Matched as prefixes rather than whole strings because models pad them, and
/// each one ends at a word boundary so a real value is never swallowed: a
/// commodity of "no-spill drums" or a pickup in "Nome, AK" survives.
const EMPTY_ANSWER_PREFIXES: &[&str] = &[
    "not mentioned",
    "not specified",
    "not provided",
    "not stated",
    "not given",
    "not discussed",
    "not applicable",
    "not available",
    "not indicated",
    "none mentioned",
    "none specified",
    "none provided",
    "none given",
    "no information",
    "no info ",
    "no mention",
    "no details",
    "no value",
    "unknown ",
    "unspecified ",
];

/// A field's value with the model's throat-clearing removed: the trimmed text,
/// or `""` when it says nothing.
fn clean_field_value(raw: &str) -> String {
    // A trailing aside doesn't rescue an empty answer — "none (direct route)"
    // is still nothing — so judge the part before it.
    let head = raw.split('(').next().unwrap_or(raw);
    let stripped = head
        .trim()
        .trim_matches(|c: char| c.is_whitespace() || ".,;:-–—\"'".contains(c))
        .to_lowercase();

    if stripped.is_empty()
        || EMPTY_ANSWERS.contains(&stripped.as_str())
        || EMPTY_ANSWER_PREFIXES
            .iter()
            .any(|prefix| stripped.starts_with(prefix))
    {
        return String::new();
    }

    raw.trim().to_string()
}

/// Whether two fields may honestly hold the same text.
///
/// Everywhere else, one value arriving in several fields at once is the model
/// spreading the one fact it has across the keys it was asked to fill —
/// the pickup city turning up again as the delivery, the stop and the window.
/// These three pairs are the exceptions: a round trip really can be drop and
/// hook at both ends, under the same appointment window, on the same day.
fn may_share_value(a: &str, b: &str) -> bool {
    const PAIRS: &[(&str, &str)] = &[
        ("pickup_type", "delivery_type"),
        ("pickup_window", "delivery_window"),
        ("pickup_datetime", "delivery_datetime"),
    ];
    PAIRS
        .iter()
        .any(|(x, y)| (a == *x && b == *y) || (a == *y && b == *x))
}

/// Of the fields a single answer fills with identical text, the ones to ignore.
///
/// The keeper is whichever field the load already established with that value,
/// or failing that the one the model is most sure of — so the copy is dropped
/// rather than the fact. Note this only ever suppresses a *repeat*: the value
/// still lands, in exactly one field.
fn echoed_fields(
    candidates: &[(String, String, Option<f64>)],
    held: &serde_json::Map<String, serde_json::Value>,
) -> std::collections::HashSet<String> {
    let mut echoes = std::collections::HashSet::new();
    let already_held = |key: &str, value: &str| {
        held.get(key).and_then(|v| v.as_str()).unwrap_or_default() == value
    };

    for (i, (key_a, value_a, confidence_a)) in candidates.iter().enumerate() {
        for (key_b, value_b, confidence_b) in candidates.iter().skip(i + 1) {
            if !value_a.eq_ignore_ascii_case(value_b) || may_share_value(key_a, key_b) {
                continue;
            }
            let (held_a, held_b) = (
                already_held(key_a, value_a),
                already_held(key_b, value_b),
            );
            let loser = if held_a != held_b {
                if held_a {
                    key_b
                } else {
                    key_a
                }
            } else if confidence_a.unwrap_or(0.0) >= confidence_b.unwrap_or(0.0) {
                key_b
            } else {
                key_a
            };
            echoes.insert(loser.clone());
        }
    }
    echoes
}

/// Fold a fresh extraction into the load accumulated so far.
///
/// The rules, per field:
///
///   - An empty answer changes nothing. The model going quiet about a field is
///     not the broker retracting it.
///   - A field the load doesn't have yet is taken only if the model is
///     reasonably sure of it — that's the guess filter.
///   - A field that is already filled is overwritten by a *different* answer,
///     because the later call read more of the conversation, unless that answer
///     is markedly less confident than the one it would replace.
///   - A value the answer puts in more than one field is kept in one of them —
///     see [`echoed_fields`].
fn merge_extraction(
    held: &LoadFormDataWithConfidence,
    fresh: &LoadFormDataWithConfidence,
) -> LoadFormDataWithConfidence {
    let mut merged_data = match serde_json::to_value(&held.data) {
        Ok(serde_json::Value::Object(map)) => map,
        _ => return fresh.clone(),
    };
    let fresh_data = match serde_json::to_value(&fresh.data) {
        Ok(serde_json::Value::Object(map)) => map,
        _ => return held.clone(),
    };
    let mut merged_confidence = held.confidence.clone();

    // A confidence the model didn't report is not evidence against the value —
    // some models skip the map entirely — so only a score that is actually
    // present can disqualify anything.
    let candidates: Vec<(String, String, Option<f64>)> = fresh_data
        .iter()
        .filter_map(|(key, raw)| {
            let value = clean_field_value(raw.as_str().unwrap_or_default());
            (!value.is_empty())
                .then(|| (key.clone(), value, fresh.confidence.get(key).copied()))
        })
        .collect();
    let echoes = echoed_fields(&candidates, &merged_data);

    for (key, candidate, candidate_confidence) in &candidates {
        if echoes.contains(key) {
            continue;
        }
        let candidate_confidence = *candidate_confidence;
        let current = merged_data
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        if current.is_empty() {
            if candidate_confidence.is_some_and(|c| c < MIN_NEW_FIELD_CONFIDENCE) {
                continue;
            }
        } else {
            if current == candidate {
                continue;
            }
            let current_confidence = merged_confidence.get(key).copied().unwrap_or(0.0);
            if candidate_confidence
                .is_some_and(|c| c + CONFIDENCE_HYSTERESIS < current_confidence)
            {
                continue;
            }
        }

        merged_data.insert(key.clone(), serde_json::Value::String(candidate.clone()));
        if let Some(confidence) = candidate_confidence {
            merged_confidence.insert(key.clone(), confidence);
        }
    }

    let data = serde_json::from_value(serde_json::Value::Object(merged_data))
        .unwrap_or_else(|_| held.data.clone());

    LoadFormDataWithConfidence {
        data,
        confidence: merged_confidence,
    }
}

// ─── LLM Extraction ─────────────────────────────────────────────────────────

/// The extraction prompt, identical for every provider.
///
/// Split out of `extract_load_data` so that adding a backend can never fork the
/// wording — the field list and the confidence contract are what the whole app's
/// parsing depends on, and two copies would drift.
///
/// The rules below the field list are load-bearing. This prompt runs against a
/// *partial* transcript every few seconds, so early on it asks for fifteen
/// fields from a conversation that has established two, and a model handed a
/// template of fifteen filled-in "..." strings will fill fifteen strings: it
/// spreads the pickup city across `pickup_window` and `stops`, writes "N/A" into
/// the rest, and scores it all in the eighties because the example did. On the
/// form that reads as noise; in the widget's orbit each one is its own chip, so
/// the whole ring populates from a single mentioned city. Hence: empty string
/// for anything unstated, no value copied between fields, and confidence that
/// means what it says.
fn extraction_prompt(transcript: &str) -> String {
    format!(
        r#"You are a logistics data extraction assistant. Given a broker conversation transcript, extract the following fields:
- pickup_location: where the load picks up (city, state)
- pickup_datetime: when the load picks up (day, date, time)
- pickup_type: how the pickup works — "live load" (driver waits while loaded), "drop and hook" (drop empty, grab preloaded), "empty in" (arrive with empty trailer), "preloaded" (trailer already loaded, hook and go)
- pickup_window: time window or appointment type — e.g. "FCFS 10am-4pm", "Appointment 2:00 PM", "ASAP", "24/7"
- delivery_location: where the load delivers (city, state)
- delivery_datetime: when the load delivers (day, date, time)
- delivery_type: how the delivery works — "live unload" (driver waits while unloaded), "drop and hook" (drop loaded, grab empty), "empty out" (leave with empty trailer)
- delivery_window: time window or appointment type for delivery — e.g. "FCFS 8am-5pm", "Appointment 9:00 AM"
- stops: any intermediate stops between pickup and delivery. Format as "City, ST → City, ST" for multiple.
- commodity: what is being shipped (be specific: "frozen chicken", "steel coils", "retail goods")
- equipment_type: truck type (reefer, dry van, flatbed, step deck, conestoga, etc.)
- trailer_instructions: full operation chain for drivers without trailers — e.g. "Pick empty nearby → live load → live unload", "Hook preloaded at shipper → drop and hook at receiver", "Empty in → live load → drop and hook"
- rate: pay rate mentioned ($/mile or total amount)
- weight: load weight in lbs
- additional_notes: any other relevant info (lumpers, appointments, hazmat, T-check, pallet jack, etc.)

This transcript is a live call and is usually incomplete — most of these fields
will not have been discussed yet. Extracting nothing is a correct answer.

Rules:
1. Only fill a field the transcript actually states. If it has not been said,
   return an empty string "" for it — never "N/A", "none", "unknown", "not
   mentioned", or any other placeholder text.
2. Never put the same value in two fields. A pickup city is not a delivery city,
   a time window, or a stop. If only the pickup city has been said, only
   pickup_location is filled.
3. Do not infer, assume, or fill in what a typical load would look like. Quote
   what was said, condensed.
4. Confidence is per field, 0.0 to 1.0, and reflects how clearly the transcript
   states that field. Use 0.0 for every field you left empty. Do not inflate a
   score because the field is important.

Return ONLY valid JSON in this exact format with no markdown code blocks. The
example below is a call where only the pickup, the commodity and the rate have
come up so far — note that every field still under discussion is empty:
{{
  "data": {{
    "pickup_location": "Amarillo, TX",
    "pickup_datetime": "Tue 6/24, 8:00 AM",
    "pickup_type": "",
    "pickup_window": "",
    "delivery_location": "",
    "delivery_datetime": "",
    "delivery_type": "",
    "delivery_window": "",
    "stops": "",
    "commodity": "Frozen chicken",
    "equipment_type": "",
    "trailer_instructions": "",
    "rate": "$2.80/mile",
    "weight": "",
    "additional_notes": ""
  }},
  "confidence": {{
    "pickup_location": 0.95,
    "pickup_datetime": 0.87,
    "pickup_type": 0.0,
    "pickup_window": 0.0,
    "delivery_location": 0.0,
    "delivery_datetime": 0.0,
    "delivery_type": 0.0,
    "delivery_window": 0.0,
    "stops": 0.0,
    "commodity": 0.82,
    "equipment_type": 0.0,
    "trailer_instructions": 0.0,
    "rate": 0.89,
    "weight": 0.0,
    "additional_notes": 0.0
  }}
}}

Transcript:
{}"#,
        transcript
    )
}

/// Ollama completion, local or remote. Returns the model's raw text.
///
/// Local goes through `ollama-rs` because it handles the daemon's defaults for
/// us; remote hits `/api/generate` directly since ollama.com needs a bearer
/// token the crate doesn't plumb through the same way.
async fn generate_ollama(
    base_url: String,
    model: String,
    api_key: String,
    is_local: bool,
    prompt: String,
) -> Result<String, String> {
    if is_local {
        let ollama = Ollama::default();
        let request = GenerationRequest::new(model, prompt);
        let response: GenerationResponse = ollama
            .generate(request)
            .await
            .map_err(|e| format!("Local Ollama generation failed: {}", e))?;
        return Ok(response.response);
    }

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

    Ok(api_response.response)
}

/// Gemini completion via `generateContent`. Returns the model's raw text.
///
/// `responseMimeType: application/json` is what keeps this compatible with the
/// shared parsing below: without it Gemini reliably wraps its answer in a
/// markdown JSON fence, and while the fence stripper handles that, JSON mode also
/// constrains decoding so the model can't trail off into prose after the object.
/// The low temperature is for the same reason — this is an extraction task, and
/// creative rephrasing of a pickup city is a bug.
async fn generate_gemini(model: String, api_key: String, prompt: String) -> Result<String, String> {
    // Caught here rather than let Google answer with a generic 400, which reads
    // as "invalid key" and sends users hunting for a typo that isn't there.
    if api_key.is_empty() {
        return Err(
            "Gemini API key not set. Add a 'gemini' row to your Supabase api_keys table, or switch the LLM provider back to Ollama in Settings."
                .to_string(),
        );
    }

    let api_req = GeminiGenerateRequest {
        contents: vec![GeminiContent {
            parts: vec![GeminiPart { text: prompt }],
        }],
        generation_config: GeminiGenerationConfig {
            response_mime_type: "application/json".to_string(),
            temperature: 0.2,
        },
    };

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    );

    // The key goes in a header rather than the `?key=` query parameter Google's
    // older samples use, so it can't leak into proxy or request logs.
    let response = reqwest::Client::new()
        .post(&url)
        .header("x-goog-api-key", &api_key)
        .json(&api_req)
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    let status = response.status();
    let body_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if !status.is_success() {
        // Google's error body carries the actionable part (expired key, model
        // not found, quota), so surface it verbatim instead of just the code.
        return Err(format!("Gemini API error {}: {}", status, body_text));
    }

    let api_response: GeminiGenerateResponse = serde_json::from_str(&body_text)
        .map_err(|e| format!("Failed to parse Gemini response: {}. Body: {}", e, body_text))?;

    api_response.into_text()
}

#[tauri::command]
async fn extract_load_data(
    config: State<'_, ConfigState>,
    extraction: State<'_, ExtractionStore>,
    app: AppHandle,
    req: ExtractionRequest,
) -> Result<LoadFormDataWithConfidence, String> {
    let prompt = extraction_prompt(&req.transcript);

    // Snapshot everything the call needs while the lock is held: the config
    // mutex is a std `Mutex`, so it must not be alive across the await below.
    enum Backend {
        Ollama {
            base_url: String,
            model: String,
            api_key: String,
            is_local: bool,
        },
        Gemini {
            model: String,
            api_key: String,
        },
    }

    let backend = {
        let cfg = config.config.lock().unwrap();
        match cfg.provider {
            LlmProvider::Ollama => Backend::Ollama {
                base_url: cfg.ollama_base_url.clone(),
                model: cfg.ollama_model.clone(),
                api_key: cfg.ollama_api_key.clone(),
                is_local: cfg.is_local_ollama(),
            },
            LlmProvider::Gemini => Backend::Gemini {
                model: cfg.gemini_model.clone(),
                api_key: cfg.gemini_api_key.clone(),
            },
        }
    };

    let raw_content = match backend {
        Backend::Ollama {
            base_url,
            model,
            api_key,
            is_local,
        } => generate_ollama(base_url, model, api_key, is_local, prompt).await?,
        Backend::Gemini { model, api_key } => generate_gemini(model, api_key, prompt).await?,
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

    // Fold this answer into the load so far, rather than letting it replace it.
    // Both consumers — the form and the widget's orbit — read the accumulated
    // load, so neither can see a field blink out because one call went quiet
    // about it. See `ExtractionStore`.
    let merged = {
        let mut held = extraction.inner.lock().unwrap();
        *held = merge_extraction(&held, &parsed);
        held.clone()
    };

    // Broadcast the extracted fields to every window (main + widget) so the
    // floating widget's orbital "planet" chips can update in real time as the
    // dispatcher talks — even though extraction was invoked by the main window.
    let _ = app.emit("load:fields", &merged);

    Ok(merged)
}

/// The load accumulated so far. Lets a window that missed the `load:fields`
/// broadcasts — the widget, whose planets are closed while the sun is hidden —
/// rebuild from the current state instead of waiting for the next extraction.
#[tauri::command]
fn get_load_fields(extraction: State<'_, ExtractionStore>) -> LoadFormDataWithConfidence {
    extraction.inner.lock().unwrap().clone()
}

/// Start a fresh load: the next extraction accumulates from nothing.
///
/// Called when the form is reset and when a saved load is opened, so a new
/// conversation can't inherit the previous one's fields. A capture session
/// resets the store itself, in `start_capture_cmd`.
#[tauri::command]
fn reset_extraction(extraction: State<'_, ExtractionStore>) {
    *extraction.inner.lock().unwrap() = LoadFormDataWithConfidence::default();
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
    extraction: State<'_, ExtractionStore>,
    app: AppHandle,
    device_id: String,
    mix_system_audio: bool,
) -> Result<(), String> {
    config.config.lock().unwrap().is_valid()?;

    let mut guard = state.handle.lock().unwrap();
    if guard.is_some() {
        return Err("Capture already running".to_string());
    }

    // A new session is a new load: start accumulating from nothing, or the
    // first extraction would merge into the last call's fields.
    *extraction.inner.lock().unwrap() = LoadFormDataWithConfidence::default();

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
        // Close all planet windows when the sun hides, and tell the widget its
        // orbit is gone — it keeps the slot map, so a close it didn't make
        // would leave it addressing windows that no longer exist and quietly
        // pushing updates into nothing. It rebuilds from `get_load_fields` when
        // the sun comes back.
        close_planet_windows(&app);
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
/// `rename_all = "camelCase"` is kept deliberately even though every field here
/// is currently a single word: Tauri camel-cases *command parameter* names for
/// you, but nested struct fields go straight through serde, so the first
/// multi-word field added below would silently fail to match and the whole
/// command would error out with "missing field".
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePlanetPayload {
    key: String,
    label: String,
    icon: String,
    value: String,
    confidence: f64,
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
/// doesn't wipe out the planet's label or icon.
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

/// Close every planet window at once (e.g. when capture starts or a load is reset).
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
        close_planet_windows(&app);
    }
    Ok(())
}

/// Close every planet window and tell the widget they're gone.
///
/// The widget owns the slot map, so anything that closes planets from Rust has
/// to say so — otherwise the map keeps describing windows that don't exist, the
/// fields it lists never come back (an update is pushed to a dead label instead
/// of a window being built), and their slots stay reserved forever.
fn close_planet_windows(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("planet-") {
            let _ = win.close();
        }
    }
    let _ = app.emit_to("widget", "orbit:cleared", ());
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
    /// Optional so that a client built before Gemini existed — or a Supabase
    /// project with no `gemini` row — still satisfies the payload.
    #[serde(default)]
    gemini_key: Option<String>,
}

#[tauri::command]
fn set_api_keys(
    state: State<'_, ConfigState>,
    payload: SetApiKeysPayload,
) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.set_keys(payload.deepgram_key, payload.ollama_key);
    if let Some(gemini) = payload.gemini_key {
        cfg.set_gemini_key(gemini);
    }
    Ok(())
}

/// Switch the extraction backend. Called from the settings modal; the frontend
/// mirrors the choice into `localStorage` and replays it on the next launch,
/// since the config itself is rebuilt empty every start.
#[tauri::command]
fn set_llm_provider(state: State<'_, ConfigState>, provider: String) -> Result<(), String> {
    let parsed = LlmProvider::parse(&provider)?;
    state.config.lock().unwrap().provider = parsed;
    Ok(())
}

#[tauri::command]
fn get_llm_provider(state: State<'_, ConfigState>) -> String {
    state.config.lock().unwrap().provider.as_str().to_string()
}

#[tauri::command]
fn logout(state: State<'_, ConfigState>) -> Result<(), String> {
    let mut cfg = state.config.lock().unwrap();
    cfg.deepgram_api_key.clear();
    cfg.ollama_api_key.clear();
    cfg.gemini_api_key.clear();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ConfigState::default())
        .manage(CaptureState::default())
        .manage(PlanetStore::default())
        .manage(ExtractionStore::default())
        .manage(WidgetPos::default())
        .invoke_handler(tauri::generate_handler![
            extract_load_data,
            get_load_fields,
            reset_extraction,
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
            set_llm_provider,
            get_llm_provider,
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

    /// Guards the field names in the Gemini response structs against the real
    /// envelope — the nesting is four levels deep and every level is optional
    /// in at least one failure mode, so a rename would otherwise only show up
    /// as a runtime parse error against a live API we can't hit in CI.
    #[test]
    fn test_gemini_response_text_extraction() {
        let raw = r#"{
            "candidates": [
                {
                    "content": {
                        "parts": [
                            { "text": "{\"data\":{\"pickup_location\":\"Amarillo, TX\"}}" }
                        ],
                        "role": "model"
                    },
                    "finishReason": "STOP",
                    "avgLogprobs": -0.12
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 812,
                "candidatesTokenCount": 214,
                "totalTokenCount": 1026
            },
            "modelVersion": "gemini-2.5-flash",
            "responseId": "abc123"
        }"#;

        let response: GeminiGenerateResponse = serde_json::from_str(raw).unwrap();
        let text = response.into_text().unwrap();
        assert_eq!(text, r#"{"data":{"pickup_location":"Amarillo, TX"}}"#);

        // And the extracted text is what the shared parser consumes.
        let parsed: LoadFormDataWithConfidence = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed.data.pickup_location, "Amarillo, TX");
    }

    #[test]
    fn test_gemini_empty_candidates_is_error() {
        // A safety block is an HTTP 200 with no candidates, so this must not be
        // mistaken for an empty extraction.
        let raw = r#"{
            "promptFeedback": { "blockReason": "SAFETY" },
            "modelVersion": "gemini-2.5-flash"
        }"#;

        let response: GeminiGenerateResponse = serde_json::from_str(raw).unwrap();
        let err = response.into_text().unwrap_err();
        assert!(err.contains("no candidates"), "unexpected error: {}", err);
        assert!(err.contains("SAFETY"), "block reason lost: {}", err);
    }

    #[test]
    fn test_llm_provider_parsing() {
        assert_eq!(LlmProvider::parse("ollama").unwrap(), LlmProvider::Ollama);
        assert_eq!(LlmProvider::parse(" Gemini ").unwrap(), LlmProvider::Gemini);
        assert_eq!(LlmProvider::Gemini.as_str(), "gemini");
        assert!(LlmProvider::parse("gpt-4").is_err());
    }

    // ─── Extraction merging ─────────────────────────────────────────────────

    #[test]
    fn test_placeholder_values_read_as_empty() {
        for placeholder in [
            "",
            "   ",
            "N/A",
            "n/a.",
            "none",
            "None (direct)",
            "Unknown",
            "TBD",
            "not mentioned",
            "Not mentioned in the transcript",
            "no information provided",
            "None specified by the broker",
            "-",
            "--",
        ] {
            assert_eq!(
                clean_field_value(placeholder),
                "",
                "expected {placeholder:?} to read as empty"
            );
        }
    }

    #[test]
    fn test_real_values_survive_the_placeholder_filter() {
        // The prefixes end at word boundaries precisely so these don't get
        // swallowed: each one starts like a placeholder and isn't one.
        for value in [
            "Nome, AK",
            "None Such Foods, Dallas TX",
            "No-spill drums",
            "Not-So-Fast Logistics",
            "Northlake, IL",
            "Naperville, IL",
            "Live load",
            "$2.80/mile ($2,100 total)",
        ] {
            assert_eq!(clean_field_value(value), value, "{value:?} was filtered out");
        }
    }

    /// Build an extraction from (key, value, confidence) triples.
    fn extraction(fields: &[(&str, &str, f64)]) -> LoadFormDataWithConfidence {
        let mut data = serde_json::Map::new();
        let mut confidence = HashMap::new();
        for (key, value, conf) in fields {
            data.insert(key.to_string(), serde_json::json!(value));
            confidence.insert(key.to_string(), *conf);
        }
        LoadFormDataWithConfidence {
            data: serde_json::from_value(serde_json::Value::Object(data)).unwrap(),
            confidence,
        }
    }

    #[test]
    fn test_merge_keeps_fields_a_later_call_went_quiet_about() {
        // The bug this whole accumulator exists for: the second call says
        // nothing about the pickup, and the pickup planet used to vanish.
        let held = extraction(&[("pickup_location", "Amarillo, TX", 0.95)]);
        let fresh = extraction(&[
            ("pickup_location", "", 0.0),
            ("additional_notes", "Lumpers required", 0.8),
        ]);

        let merged = merge_extraction(&held, &fresh);
        assert_eq!(merged.data.pickup_location, "Amarillo, TX");
        assert_eq!(merged.data.additional_notes, "Lumpers required");
        assert_eq!(merged.confidence.get("pickup_location"), Some(&0.95));
    }

    #[test]
    fn test_merge_ignores_placeholders_and_low_confidence_guesses() {
        let held = LoadFormDataWithConfidence::default();
        let fresh = extraction(&[
            ("pickup_location", "Amarillo, TX", 0.95),
            ("delivery_location", "N/A", 0.9),
            // The padding signature: a guess the model itself scores low.
            ("pickup_window", "FCFS 8am-5pm", 0.15),
        ]);

        let merged = merge_extraction(&held, &fresh);
        assert_eq!(merged.data.pickup_location, "Amarillo, TX");
        assert_eq!(merged.data.delivery_location, "");
        assert_eq!(merged.data.pickup_window, "");
    }

    #[test]
    fn test_merge_takes_corrections_but_not_downgrades() {
        let held = extraction(&[
            ("pickup_location", "Amarillo, TX", 0.9),
            ("rate", "$2,100 total", 0.9),
        ]);
        let fresh = extraction(&[
            // Later in the call the broker got specific — a confident
            // correction replaces what's held.
            ("pickup_location", "Amarillo, TX (Dock 4)", 0.92),
            // ...while a hedged rewrite of a field we're already sure of does
            // not.
            ("rate", "$2,000 total", 0.4),
        ]);

        let merged = merge_extraction(&held, &fresh);
        assert_eq!(merged.data.pickup_location, "Amarillo, TX (Dock 4)");
        assert_eq!(merged.data.rate, "$2,100 total");
    }

    #[test]
    fn test_merge_drops_a_value_copied_across_fields() {
        // The reported bug: one mentioned city, and the model fills the rest of
        // the pickup group and the delivery with it — five chips in orbit for a
        // fact the broker said once.
        let held = LoadFormDataWithConfidence::default();
        let fresh = extraction(&[
            ("pickup_location", "Amarillo, TX", 0.95),
            ("delivery_location", "Amarillo, TX", 0.6),
            ("stops", "Amarillo, TX", 0.5),
            ("additional_notes", "Amarillo, TX", 0.4),
        ]);

        let merged = merge_extraction(&held, &fresh);
        assert_eq!(merged.data.pickup_location, "Amarillo, TX");
        assert_eq!(merged.data.delivery_location, "");
        assert_eq!(merged.data.stops, "");
        assert_eq!(merged.data.additional_notes, "");
    }

    #[test]
    fn test_merge_keeps_the_field_that_already_held_the_value() {
        // Confidence alone would hand the city to the delivery here. The load
        // already knows it as the pickup, so the pickup keeps it.
        let held = extraction(&[("pickup_location", "Amarillo, TX", 0.7)]);
        let fresh = extraction(&[
            ("pickup_location", "Amarillo, TX", 0.7),
            ("delivery_location", "Amarillo, TX", 0.9),
        ]);

        let merged = merge_extraction(&held, &fresh);
        assert_eq!(merged.data.pickup_location, "Amarillo, TX");
        assert_eq!(merged.data.delivery_location, "");
    }

    #[test]
    fn test_merge_allows_pairs_that_honestly_match() {
        // A round trip that is drop and hook at both ends under one window is a
        // real load, not a copied value.
        let held = LoadFormDataWithConfidence::default();
        let fresh = extraction(&[
            ("pickup_type", "Drop and hook", 0.9),
            ("delivery_type", "Drop and hook", 0.9),
            ("pickup_window", "FCFS 8am-5pm", 0.85),
            ("delivery_window", "FCFS 8am-5pm", 0.85),
        ]);

        let merged = merge_extraction(&held, &fresh);
        assert_eq!(merged.data.pickup_type, "Drop and hook");
        assert_eq!(merged.data.delivery_type, "Drop and hook");
        assert_eq!(merged.data.pickup_window, "FCFS 8am-5pm");
        assert_eq!(merged.data.delivery_window, "FCFS 8am-5pm");
    }

    #[test]
    fn test_merge_accepts_values_when_the_model_reports_no_confidence() {
        // Some models skip the confidence map entirely. A missing score is not
        // evidence against the value, so it must not act as a zero.
        let held = LoadFormDataWithConfidence::default();
        let fresh = LoadFormDataWithConfidence {
            data: LoadFormData {
                pickup_location: "Amarillo, TX".to_string(),
                ..Default::default()
            },
            confidence: HashMap::new(),
        };

        let merged = merge_extraction(&held, &fresh);
        assert_eq!(merged.data.pickup_location, "Amarillo, TX");
    }
}
