use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::runtime::Runtime;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest, tungstenite::Message as WsMessage};
use url::Url;

// ─── Constants ──────────────────────────────────────────────────────────────

const SAMPLE_RATE: u32 = 16000;
const CHANNELS: u16 = 1;
const DEEPGRAM_URL: &str = "wss://api.deepgram.com/v1/listen";

// ─── Audio Device Info ──────────────────────────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub device_type: String, // "microphone" | "system"
}

// ─── Transcript Chunk (emitted to frontend) ─────────────────────────────────

#[derive(Clone, Serialize)]
pub struct TranscriptChunk {
    pub text: String,
    pub is_final: bool,
    pub confidence: f64,
    pub timestamp: u64,
}

// ─── Capture State ──────────────────────────────────────────────────────────

pub struct CaptureHandle {
    stop_flag: Arc<AtomicBool>,
}

impl CaptureHandle {
    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::Relaxed);
    }
}

// ─── List Available Audio Devices ───────────────────────────────────────────

pub fn list_audio_devices() -> Vec<AudioDevice> {
    let mut devices = Vec::new();
    let host = cpal::default_host();

    // Input devices (microphones)
    if let Ok(input_devs) = host.input_devices() {
        for (idx, device) in input_devs.enumerate() {
            let name = device
                .name()
                .unwrap_or_else(|_| format!("Mic {}", idx + 1));
            devices.push(AudioDevice {
                id: format!("mic:{}", idx),
                name,
                device_type: "microphone".to_string(),
            });
        }
    }

    // System audio (loopback) — only meaningful on Windows with WASAPI
    // On other platforms we add a generic "System Audio" option if possible
    #[cfg(target_os = "windows")]
    {
        devices.push(AudioDevice {
            id: "system:default".to_string(),
            name: "System Audio (All Apps)".to_string(),
            device_type: "system".to_string(),
        });
    }

    // Fallback for non-Windows: indicate system audio isn't available natively
    #[cfg(not(target_os = "windows"))]
    {
        devices.push(AudioDevice {
            id: "system:unavailable".to_string(),
            name: "System Audio (Windows only)".to_string(),
            device_type: "system".to_string(),
        });
    }

    devices
}

// ─── Start Capture (from selected device) ───────────────────────────────────

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    pub device_id: String,
    pub mix_system_audio: bool, // if true, mix mic + system
}

pub fn start_capture(
    app_handle: AppHandle,
    deepgram_api_key: String,
    options: CaptureOptions,
) -> Result<CaptureHandle, String> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();

    std::thread::spawn(move || {
        let rt = Runtime::new().expect("Failed to create tokio runtime");
        rt.block_on(async {
            if let Err(e) =
                capture_and_stream(app_handle, deepgram_api_key, options, stop_flag_clone).await
            {
                eprintln!("[audio_capture] error: {}", e);
            }
        });
    });

    Ok(CaptureHandle { stop_flag })
}

// ─── Core Capture + Deepgram Streaming ──────────────────────────────────────

async fn capture_and_stream(
    app_handle: AppHandle,
    api_key: String,
    options: CaptureOptions,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    // ─── Deepgram Websocket ─────────────────────────────────────────────────
    let mut ws_url = Url::parse(DEEPGRAM_URL)
        .map_err(|e| format!("Invalid Deepgram URL: {}", e))?;

    ws_url
        .query_pairs_mut()
        .append_pair("encoding", "linear16")
        .append_pair("sample_rate", &SAMPLE_RATE.to_string())
        .append_pair("channels", &CHANNELS.to_string())
        .append_pair("punctuate", "true")
        .append_pair("interim_results", "true")
        .append_pair("model", "nova-2")
        .append_pair("language", "en");

    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("WS request build failed: {}", e))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Token {}", api_key).parse().unwrap(),
    );

    let (ws_stream, _) = connect_async(request)
        .await
        .map_err(|e| format!("Deepgram connect failed: {}", e))?;

    let (mut ws_write, mut ws_read) = ws_stream.split();

    // Channel: audio bytes → websocket writer
    let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(256);

    // ─── Websocket Writer Task ──────────────────────────────────────────────
    let writer = tokio::spawn(async move {
        while let Some(chunk) = audio_rx.recv().await {
            if ws_write.send(WsMessage::Binary(chunk.into())).await.is_err() {
                break;
            }
        }
        let close_msg = WsMessage::Text(r#"{"type": "CloseStream"}"#.to_string());
        let _ = ws_write.send(close_msg).await;
    });

    // ─── Websocket Reader + Tauri Emitter Task ──────────────────────────────
    let app_clone = app_handle.clone();
    let reader = tokio::spawn(async move {
        let mut accumulated = String::new();

        while let Some(msg) = ws_read.next().await {
            match msg {
                Ok(WsMessage::Text(text)) => {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                        let transcript = parsed["channel"]["alternatives"][0]["transcript"]
                            .as_str()
                            .unwrap_or("");
                        let is_final = parsed["is_final"].as_bool().unwrap_or(false);
                        let confidence = parsed["channel"]["alternatives"][0]["confidence"]
                            .as_f64()
                            .unwrap_or(0.0);

                        if !transcript.is_empty() {
                            let chunk = TranscriptChunk {
                                text: transcript.to_string(),
                                is_final,
                                confidence,
                                timestamp: std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis() as u64,
                            };

                            let _ = app_clone.emit("transcript:chunk", &chunk);

                            if is_final {
                                accumulated.push(' ');
                                accumulated.push_str(transcript);
                            }
                        }
                    }
                }
                Ok(WsMessage::Close(_)) => break,
                Err(_) => break,
                _ => {}
            }
        }

        accumulated
    });

    // ─── Start Audio Capture based on device selection ────────────────────────
    if options.device_id.starts_with("mic:") {
        let idx_str = options.device_id.trim_start_matches("mic:");
        let idx: usize = idx_str.parse().unwrap_or(0);
        capture_mic(audio_tx.clone(), stop_flag.clone(), idx).await?;
    } else if options.device_id == "system:default" {
        #[cfg(target_os = "windows")]
        {
            capture_system_audio_windows(audio_tx.clone(), stop_flag.clone()).await?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            return Err("System audio capture is only available on Windows".to_string());
        }
    } else if options.device_id == "system:unavailable" {
        return Err("System audio capture is only available on Windows".to_string());
    } else {
        return Err(format!("Unknown device: {}", options.device_id));
    }

    // ─── Cleanup ────────────────────────────────────────────────────────────
    drop(audio_tx); // Signals writer to close

    let _ = writer.await;
    let accumulated = reader.await.unwrap_or_default();

    // Emit final transcript
    let _ = app_handle.emit(
        "transcript:complete",
        serde_json::json!({ "text": accumulated.trim() }),
    );

    Ok(())
}

// ─── Microphone Capture (cpal, cross-platform) ─────────────────────────────

async fn capture_mic(
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop_flag: Arc<AtomicBool>,
    device_index: usize,
) -> Result<(), String> {
    let host = cpal::default_host();
    let devices: Vec<_> = host
        .input_devices()
        .map_err(|e| format!("Failed to list input devices: {}", e))?
        .collect();

    let device = devices
        .get(device_index)
        .ok_or(format!("Mic device index {} not found", device_index))?;

    let config = cpal::StreamConfig {
        channels: CHANNELS,
        sample_rate: cpal::SampleRate(SAMPLE_RATE),
        buffer_size: cpal::BufferSize::Default,
    };

    let audio_tx_clone = audio_tx.clone();
    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let bytes = f32_samples_to_i16_bytes(data);
                let _ = audio_tx_clone.try_send(bytes);
            },
            move |err| eprintln!("[audio_capture] CPAL mic error: {}", err),
            None,
        )
        .map_err(|e| format!("Failed to build mic stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start mic stream: {}", e))?;

    // Wait for stop
    while !stop_flag.load(Ordering::Relaxed) {
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    drop(stream);
    Ok(())
}

// ─── System Audio Capture (Windows WASAPI loopback) ─────────────────────────

#[cfg(target_os = "windows")]
async fn capture_system_audio_windows(
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    use wasapi::{
        initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat,
    };

    initialize_mta().map_err(|e| format!("WASAPI MTA init failed: {:?}", e))?;

    let device = wasapi::get_default_device(&Direction::Render,
    )
    .map_err(|e| format!("Failed to get default render device: {:?}", e))?;

    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| format!("Failed to get audio client: {:?}", e))?;

    let wavefmt = WaveFormat::new(16, 16, &SampleType::Int, SAMPLE_RATE, 1, None)
        .map_err(|e| format!("WaveFormat failed: {:?}", e))?;

    // Shared event-driven mode with loopback
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };

    audio_client
        .initialize_client(&wavefmt,
        &Direction::Capture, // WASAPI loopback is technically a capture on render device
        &mode,
        )
        .map_err(|e| format!("AudioClient init failed: {:?}", e))?;

    // NOTE: The wasapi crate 0.14 does NOT have a direct loopback flag.
    // For true loopback we need the newer wasapi API or raw COM calls.
    // As a workaround, we use cpal's loopback via a different approach below.

    // For now, emit a clear error telling the user this needs Windows-specific work
    drop(audio_client);
    Err("System audio loopback requires advanced WASAPI setup. Please use Microphone mode for now, or contact support.".to_string())
}

// ─── f32 → i16 (little-endian bytes) ────────────────────────────────────────

fn f32_samples_to_i16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &sample in samples {
        let s = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

// ─── Placeholder for non-Windows system audio ───────────────────────────────

#[cfg(not(target_os = "windows"))]
async fn capture_system_audio_windows(
    _audio_tx: mpsc::Sender<Vec<u8>>,
    _stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    Err("System audio capture is only available on Windows".to_string())
}
