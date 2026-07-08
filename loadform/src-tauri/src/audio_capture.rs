use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
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

// ─── Start Mic Capture ──────────────────────────────────────────────────────

pub fn start_mic_capture(
    app_handle: AppHandle,
    deepgram_api_key: String,
) -> Result<CaptureHandle, String> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();

    std::thread::spawn(move || {
        let rt = Runtime::new().expect("Failed to create tokio runtime");
        rt.block_on(async {
            if let Err(e) = capture_and_stream(app_handle, deepgram_api_key, stop_flag_clone).await
            {
                eprintln!("[audio_capture] error: {}", e);
            }
        });
    });

    Ok(CaptureHandle { stop_flag })
}

// ─── WASAPI Capture + Deepgram Streaming (async) ────────────────────────────

async fn capture_and_stream(
    app_handle: AppHandle,
    api_key: String,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    // ─── CPAL: Open default microphone ────────────────────────────────────
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No default input device (microphone) found. Please connect a microphone.")?;

    let config = cpal::StreamConfig {
        channels: CHANNELS,
        sample_rate: cpal::SampleRate(SAMPLE_RATE),
        buffer_size: cpal::BufferSize::Default,
    };

    // Channel: audio bytes → websocket writer
    let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(128);

    // ─── CPAL: Build input stream ───────────────────────────────────────────
    let audio_tx_clone = audio_tx.clone();
    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let bytes = f32_samples_to_i16_bytes(data);
                // Non-blocking — drop if channel is full (backpressure)
                let _ = audio_tx_clone.try_send(bytes);
            },
            move |err| {
                eprintln!("[audio_capture] CPAL error: {}", err);
            },
            None,
        )
        .map_err(|e| format!("Failed to build input stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start audio stream: {}", e))?;

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

    // ─── Wait for stop signal ───────────────────────────────────────────────
    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    // ─── Cleanup ────────────────────────────────────────────────────────────
    drop(stream); // Stops CPAL capture
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

// ─── f32 → i16 (little-endian bytes) ────────────────────────────────────────

fn f32_samples_to_i16_bytes(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &sample in samples {
        let s = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}
