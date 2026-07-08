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
        initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat,
    };

    // initialize_mta returns HRESULT, check with .is_err()
    let mta_result = initialize_mta();
    if mta_result.is_err() {
        return Err(format!("WASAPI MTA init failed: {:?}", mta_result));
    }

    // Use DeviceEnumerator::new().get_default_device(&Direction::Render)
    let enumerator = DeviceEnumerator::new()
        .map_err(|e| format!("Failed to create device enumerator: {:?}", e))?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| format!("Failed to get default render device: {:?}", e))?;

    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| format!("Failed to get audio client: {:?}", e))?;

    // WaveFormat::new takes usize for sample rate, returns Self (not Result)
    let wavefmt = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None);

    let (def_time, min_time) = audio_client
        .get_device_period()
        .map_err(|e| format!("Failed to get device period: {:?}", e))?;

    // Shared event-driven mode for loopback capture
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_time,
    };

    audio_client
        .initialize_client(&wavefmt, &Direction::Capture, &mode)
        .map_err(|e| format!("AudioClient init failed: {:?}", e))?;

    // Get event handle for event-driven mode
    let h_event = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("Failed to get event handle: {:?}", e))?;

    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("Failed to get capture client: {:?}", e))?;

    let blockalign = wavefmt.get_blockalign() as usize;

    audio_client
        .start_stream()
        .map_err(|e| format!("Failed to start stream: {:?}", e))?;

    // Capture loop
    loop {
        // Check stop flag
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        // Wait for event with timeout
        if h_event.wait_for_event(100).is_err() {
            // Timeout or error, check stop flag and continue
            continue;
        }

        // Read available frames
        let next_packet_size = capture_client
            .get_next_packet_size()
            .map_err(|e| format!("Failed to get next packet size: {:?}", e))?;

        let frames_to_read = match next_packet_size {
            Some(size) => size as usize,
            None => continue, // Exclusive mode - skip for now
        };

        if frames_to_read == 0 {
            continue;
        }

        // Allocate buffer for raw bytes
        let mut buffer = vec![0u8; frames_to_read * blockalign];
        let (frames_read, _buffer_info) = capture_client
            .read_from_device(&mut buffer)
            .map_err(|e| format!("Failed to read from device: {:?}", e))?;

        if frames_read == 0 {
            continue;
        }

        // Convert f32 samples to i16 bytes
        // WAVEFORMATEXTENSIBLE with Float subtype gives us f32 data
        let bytes_read = frames_read as usize * blockalign;
        let f32_samples: &[f32] = bytemuck::cast_slice(&buffer[..bytes_read]);
        let i16_bytes = f32_samples_to_i16_bytes(f32_samples);

        // Send to channel
        if audio_tx.try_send(i16_bytes).is_err() {
            // Channel full or closed, continue
        }
    }

    let _ = audio_client.stop_stream();
    Ok(())
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
