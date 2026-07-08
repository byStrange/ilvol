/**
 * LoadForm - Deepgram Real-Time Transcription Module
 *
 * Handles microphone capture via Web Audio API and streams audio
 * to Deepgram's websocket API for real-time speech-to-text.
 */

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';
const SAMPLE_RATE = 16000;
const CHANNELS = 1;

/**
 * Converts an AudioBuffer to 16-bit linear PCM Int16Array.
 */
function audioBufferToInt16(audioBuffer) {
  const length = audioBuffer.length;
  const buffer = new Int16Array(length);
  const channelData = audioBuffer.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    buffer[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  return buffer;
}

/**
 * Starts real-time transcription from microphone via Deepgram.
 *
 * @param {string} apiKey - Deepgram API key
 * @param {(chunk: TranscriptChunk) => void} onChunk - Callback for each transcript chunk
 * @returns {Promise<{stop: () => Promise<string>, isCapturing: () => boolean}>} Controller
 */
export async function startTranscription(apiKey, onChunk) {
  let mediaRecorder = null;
  let audioContext = null;
  let websocket = null;
  let stream = null;
  let capturing = false;
  let accumulatedTranscript = '';
  let pendingWords = [];

  // Get microphone permission
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: SAMPLE_RATE,
      channelCount: CHANNELS,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

  // Create Deepgram websocket connection
  const wsUrl = new URL(DEEPGRAM_URL);
  wsUrl.searchParams.set('encoding', 'linear16');
  wsUrl.searchParams.set('sample_rate', String(SAMPLE_RATE));
  wsUrl.searchParams.set('channels', String(CHANNELS));
  wsUrl.searchParams.set('punctuate', 'true');
  wsUrl.searchParams.set('interim_results', 'true');
  wsUrl.searchParams.set('model', 'nova-2');
  wsUrl.searchParams.set('language', 'en');

  websocket = new WebSocket(wsUrl.toString());
  websocket.binaryType = 'arraybuffer';

  await new Promise((resolve, reject) => {
    websocket.onopen = resolve;
    websocket.onerror = reject;
    websocket.onclose = () => {
      if (capturing) reject(new Error('WebSocket closed unexpectedly'));
    };
  });

  // Set auth header via URL (Deepgram accepts key in query param or header)
  // Actually, Deepgram uses Authorization header with token
  // We'll re-open with the key in the URL query as a workaround, or send after connect
  // Per Deepgram docs: wss://api.deepgram.com/v1/listen?token=YOUR_API_KEY

  // Reconnect with token in URL
  websocket.close();
  const wsUrlWithToken = new URL(DEEPGRAM_URL);
  wsUrlWithToken.searchParams.set('token', apiKey);
  wsUrlWithToken.searchParams.set('encoding', 'linear16');
  wsUrlWithToken.searchParams.set('sample_rate', String(SAMPLE_RATE));
  wsUrlWithToken.searchParams.set('channels', String(CHANNELS));
  wsUrlWithToken.searchParams.set('punctuate', 'true');
  wsUrlWithToken.searchParams.set('interim_results', 'true');
  wsUrlWithToken.searchParams.set('model', 'nova-2');
  wsUrlWithToken.searchParams.set('language', 'en');

  websocket = new WebSocket(wsUrlWithToken.toString());
  websocket.binaryType = 'arraybuffer';

  await new Promise((resolve, reject) => {
    websocket.onopen = resolve;
    websocket.onerror = reject;
  });

  // Set up WebSocket message handler
  websocket.onmessage = (event) => {
    const response = JSON.parse(event.data);
    const transcript = response.channel?.alternatives?.[0]?.transcript;
    const isFinal = response.is_final === true;
    const confidence = response.channel?.alternatives?.[0]?.confidence ?? 0.0;

    if (!transcript || transcript.trim().length === 0) return;

    const chunk = {
      text: transcript,
      is_final: isFinal,
      confidence: Math.round(confidence * 100) / 100,
      timestamp: Date.now(),
    };

    if (isFinal) {
      accumulatedTranscript += ' ' + transcript;
      // Clean up leading space
      accumulatedTranscript = accumulatedTranscript.trim();
    }

    if (onChunk) {
      onChunk(chunk);
    }
  };

  // Set up audio processing pipeline
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, CHANNELS, CHANNELS);

  processor.onaudioprocess = (event) => {
    if (!capturing) return;

    const audioBuffer = event.inputBuffer;
    const int16Data = audioBufferToInt16(audioBuffer);
    const buffer = int16Data.buffer;

    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(buffer);
    }
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  capturing = true;

  // Return controller
  return {
    isCapturing: () => capturing,
    stop: async () => {
      capturing = false;

      // Gracefully close Deepgram connection
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify({ type: 'CloseStream' }));
        // Give a moment for final results to arrive
        await new Promise(r => setTimeout(r, 1000));
        websocket.close();
      }

      // Stop media tracks
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }

      // Disconnect audio graph
      if (processor) {
        processor.disconnect();
      }
      if (source) {
        source.disconnect();
      }
      if (audioContext && audioContext.state !== 'closed') {
        await audioContext.close();
      }

      return accumulatedTranscript;
    },
  };
}
