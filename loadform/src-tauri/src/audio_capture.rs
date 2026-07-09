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
            if let Err(e) = capture_and_stream(
                app_handle.clone(),
                deepgram_api_key,
                options,
                stop_flag_clone,
            )
            .await
            {
                // Previously this only went to eprintln, which is invisible in a
                // packaged/release build with no attached console. Surface it to
                // the frontend so failures are actually visible to the user.
                let _ = app_handle.emit("capture:error", e.clone());
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

        if options.mix_system_audio {
            // `mix_system_audio` used to be accepted from the frontend and
            // stored on CaptureOptions, but nothing ever read it here — the
            // branch only ever looked at device_id, so it silently ran mic
            // OR system, never both, no matter what the checkbox said.
            #[cfg(target_os = "windows")]
            {
                mix_mic_and_system(audio_tx.clone(), stop_flag.clone(), idx).await?;
            }
            #[cfg(not(target_os = "windows"))]
            {
                eprintln!(
                    "[audio_capture] system audio mixing requested but only \
                     available on Windows; falling back to mic-only"
                );
                capture_mic(audio_tx.clone(), stop_flag.clone(), idx).await?;
            }
        } else {
            capture_mic(audio_tx.clone(), stop_flag.clone(), idx).await?;
        }
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
//
// NOTE: We used to force a StreamConfig of 16kHz/mono regardless of what the
// device actually supports. On Windows, WASAPI shared-mode mic devices almost
// never natively expose 16kHz mono (they're typically 44.1/48kHz stereo), so
// build_input_stream() would fail outright with an unsupported-config error.
// That failure was only eprintln'd, so in a packaged app it looked like
// "recording just doesn't do anything." We now query the device's own default
// input config, capture at whatever it natively supports, and downmix +
// resample in the callback to the 16kHz mono Deepgram expects.

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

    // Ask the device what it can actually do instead of assuming 16kHz mono.
    // This is the fix for the Windows "mic listed but never records" bug.
    let supported_config = device.default_input_config().map_err(|e| {
        format!(
            "Failed to get default input config for this mic (often means Windows \
             microphone permission is denied for this app — check Settings > \
             Privacy & security > Microphone): {}",
            e
        )
    })?;

    let native_channels = supported_config.channels();
    let native_sample_rate = supported_config.sample_rate().0;
    let sample_format = supported_config.sample_format();
    let config: cpal::StreamConfig = supported_config.into();

    // Shared resampler state, carried between audio callbacks so we don't
    // introduce clicks/discontinuities at buffer boundaries.
    let resampler = Arc::new(std::sync::Mutex::new(Resampler::new(
        native_sample_rate,
        SAMPLE_RATE,
    )));

    // Runtime stream errors (as opposed to build-time errors below) come out
    // of cpal's error callback, which is sync and has no async context. We
    // forward them over an unbounded channel so the caller can emit them to
    // the frontend instead of silently eprintln-ing into the void.
    let (err_tx, mut err_rx) = mpsc::unbounded_channel::<String>();

    let audio_tx_clone = audio_tx.clone();
    let resampler_clone = resampler.clone();
    let err_tx_clone = err_tx.clone();
    let err_fn = move |err: cpal::StreamError| {
        let _ = err_tx_clone.send(format!("CPAL mic stream error: {}", err));
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let mono = downmix(data, native_channels);
                let resampled = resampler_clone.lock().unwrap().process(&mono);
                let bytes = f32_samples_to_i16_bytes(&resampled);
                let _ = audio_tx_clone.try_send(bytes);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                let floats: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                let mono = downmix(&floats, native_channels);
                let resampled = resampler_clone.lock().unwrap().process(&mono);
                let bytes = f32_samples_to_i16_bytes(&resampled);
                let _ = audio_tx_clone.try_send(bytes);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                let floats: Vec<f32> = data
                    .iter()
                    .map(|&s| (s as f32 - 32768.0) / 32768.0)
                    .collect();
                let mono = downmix(&floats, native_channels);
                let resampled = resampler_clone.lock().unwrap().process(&mono);
                let bytes = f32_samples_to_i16_bytes(&resampled);
                let _ = audio_tx_clone.try_send(bytes);
            },
            err_fn,
            None,
        ),
        other => {
            return Err(format!(
                "Unsupported mic sample format: {:?}. Please open an issue with your \
                 device name so we can add support.",
                other
            ))
        }
    }
    .map_err(|e| {
        format!(
            "Failed to build mic stream at {}Hz/{}ch (device's own reported config): {}",
            native_sample_rate, native_channels, e
        )
    })?;

    stream
        .play()
        .map_err(|e| format!("Failed to start mic stream: {}", e))?;

    // Wait for stop, forwarding any runtime stream errors we hear about.
    while !stop_flag.load(Ordering::Relaxed) {
        if let Ok(msg) = err_rx.try_recv() {
            eprintln!("[audio_capture] {}", msg);
            // A stream error callback firing generally means the device
            // dropped out from under us (unplugged, reclaimed exclusively by
            // another app, etc). Treat it as fatal rather than spinning.
            drop(stream);
            return Err(msg);
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    drop(stream);
    Ok(())
}

// ─── Mixed Capture: mic + system audio, summed into one stream ─────────────
//
// Both capture_mic and capture_system_audio_windows already independently
// produce 16kHz mono PCM16 chunks on their own channel. The bug here was
// that nothing ever ran them at the same time, let alone combined their
// output — mix_system_audio was read nowhere. This runs both concurrently
// and additively mixes matching sample ranges (silence-padding whichever
// side is momentarily behind) into a single stream for the Deepgram socket.

#[cfg(target_os = "windows")]
async fn mix_mic_and_system(
    audio_tx: mpsc::Sender<Vec<u8>>,
    stop_flag: Arc<AtomicBool>,
    mic_index: usize,
) -> Result<(), String> {
    let (mic_tx, mut mic_rx) = mpsc::channel::<Vec<u8>>(256);
    let (sys_tx, mut sys_rx) = mpsc::channel::<Vec<u8>>(256);

    let mic_stop = stop_flag.clone();
    let mic_task = tokio::spawn(async move { capture_mic(mic_tx, mic_stop, mic_index).await });

    let sys_stop = stop_flag.clone();
    let sys_task =
        tokio::spawn(async move { capture_system_audio_windows(sys_tx, sys_stop).await });

    // Per-source sample queues, so chunks that arrive at slightly different
    // times/sizes from the two independent capture loops can still be
    // aligned before mixing.
    let mut mic_pending: Vec<i16> = Vec::new();
    let mut sys_pending: Vec<i16> = Vec::new();
    let mut mic_closed = false;
    let mut sys_closed = false;

    loop {
        if mic_closed && sys_closed {
            break;
        }

        tokio::select! {
            msg = mic_rx.recv(), if !mic_closed => {
                match msg {
                    Some(bytes) => mic_pending.extend(bytes_to_i16(&bytes)),
                    None => mic_closed = true,
                }
            }
            msg = sys_rx.recv(), if !sys_closed => {
                match msg {
                    Some(bytes) => sys_pending.extend(bytes_to_i16(&bytes)),
                    None => sys_closed = true,
                }
            }
        }

        // A sender can be dropped (channel "closed") in the same instant a
        // message it already sent is still sitting in the buffer. Without
        // this drain, select! picking up the close notification before the
        // buffered message would wrongly treat that last chunk as silence
        // instead of mixing it — most likely right at the very end of a
        // recording, when both sides tend to stop around the same time.
        while let Ok(bytes) = mic_rx.try_recv() {
            mic_pending.extend(bytes_to_i16(&bytes));
        }
        while let Ok(bytes) = sys_rx.try_recv() {
            sys_pending.extend(bytes_to_i16(&bytes));
        }

        // While both sources are still live, only mix as far as both queues
        // overlap, so we don't zero-pad a side that's simply a few ms behind.
        // Once a side has closed for good, flush whatever's left on the
        // other, treating the closed side as silence from here on.
        let ready = if mic_closed || sys_closed {
            mic_pending.len().max(sys_pending.len())
        } else {
            mic_pending.len().min(sys_pending.len())
        };

        if ready > 0 {
            let mut mixed = Vec::with_capacity(ready);
            for i in 0..ready {
                let m = mic_pending.get(i).copied().unwrap_or(0) as i32;
                let s = sys_pending.get(i).copied().unwrap_or(0) as i32;
                mixed.push((m + s).clamp(i16::MIN as i32, i16::MAX as i32) as i16);
            }

            let drain_mic = ready.min(mic_pending.len());
            mic_pending.drain(0..drain_mic);
            let drain_sys = ready.min(sys_pending.len());
            sys_pending.drain(0..drain_sys);

            let bytes: Vec<u8> = mixed.iter().flat_map(|s| s.to_le_bytes()).collect();
            let _ = audio_tx.try_send(bytes);
        }
    }

    let mic_result = mic_task
        .await
        .map_err(|e| format!("Mic capture task panicked: {}", e))?;
    let sys_result = sys_task
        .await
        .map_err(|e| format!("System audio capture task panicked: {}", e))?;

    // Surface whichever side actually failed rather than masking one with
    // the other, e.g. if the mic got unplugged mid-mix.
    mic_result?;
    sys_result?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn bytes_to_i16(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

// ─── Downmix N channels → mono ──────────────────────────────────────────────

fn downmix(data: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return data.to_vec();
    }
    let channels = channels as usize;
    data.chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

// ─── Simple stateful linear resampler ───────────────────────────────────────
//
// Not audiophile-grade, but perfectly adequate for feeding 16kHz PCM into a
// speech-to-text API, and dependency-free. Keeps a small tail of unconsumed
// input samples plus a fractional read position across calls so consecutive
// buffers stitch together without clicks.

struct Resampler {
    ratio: f64,       // target_rate / native_rate
    src_pos: f64,      // fractional read position into `pending`
    pending: Vec<f32>, // leftover input samples from the previous call
}

impl Resampler {
    fn new(native_rate: u32, target_rate: u32) -> Self {
        Self {
            ratio: target_rate as f64 / native_rate as f64,
            src_pos: 0.0,
            pending: Vec::new(),
        }
    }

    fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if (self.ratio - 1.0).abs() < f64::EPSILON {
            return input.to_vec();
        }

        self.pending.extend_from_slice(input);

        let mut out = Vec::new();
        loop {
            let idx = self.src_pos.floor() as usize;
            if idx + 1 >= self.pending.len() {
                break;
            }
            let frac = (self.src_pos - idx as f64) as f32;
            let s0 = self.pending[idx];
            let s1 = self.pending[idx + 1];
            out.push(s0 + (s1 - s0) * frac);
            self.src_pos += 1.0 / self.ratio;
        }

        // Drop fully-consumed samples, keep the tail + carry over position.
        let consumed = self.src_pos.floor() as usize;
        if consumed > 0 && consumed <= self.pending.len() {
            self.pending.drain(0..consumed);
            self.src_pos -= consumed as f64;
        }

        out
    }
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
