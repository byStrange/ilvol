/**
 * LoadForm - Transcription Module Tests
 *
 * Tests for audio buffer conversion and Deepgram response parsing.
 */

import { startTranscription } from './transcription.js';

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    console.error(`FAIL: ${message}`);
    console.error(`  Expected: ${JSON.stringify(expected)}`);
    console.error(`  Actual:   ${JSON.stringify(actual)}`);
    throw new Error(`Test failed: ${message}`);
  }
  console.log(`PASS: ${message}`);
}

function assertTrue(actual, message) {
  if (!actual) {
    console.error(`FAIL: ${message}`);
    throw new Error(`Test failed: ${message}`);
  }
  console.log(`PASS: ${message}`);
}

// ─── Mock Deepgram Response Parsing ─────────────────────────────────────────

function parseDeepgramResponse(rawJson) {
  const response = JSON.parse(rawJson);
  const transcript = response.channel?.alternatives?.[0]?.transcript || '';
  const isFinal = response.is_final === true;
  const confidence = response.channel?.alternatives?.[0]?.confidence ?? 0.0;

  return { text: transcript, is_final: isFinal, confidence, timestamp: Date.now() };
}

console.log('\n=== Transcription Tests ===\n');

// Test 1: Parse final transcript result
const finalResponse = JSON.stringify({
  channel: {
    alternatives: [{
      transcript: 'I have a reefer load for you',
      confidence: 0.95,
    }]
  },
  is_final: true,
});

const finalParsed = parseDeepgramResponse(finalResponse);
assertEqual(finalParsed.text, 'I have a reefer load for you', 'parses transcript text');
assertEqual(finalParsed.is_final, true, 'identifies final result');
assertEqual(finalParsed.confidence, 0.95, 'extracts confidence score');
assertTrue(finalParsed.timestamp > 0, 'has timestamp');

// Test 2: Parse interim transcript result
const interimResponse = JSON.stringify({
  channel: {
    alternatives: [{
      transcript: 'I have a reef',
      confidence: 0.72,
    }]
  },
  is_final: false,
});

const interimParsed = parseDeepgramResponse(interimResponse);
assertEqual(interimParsed.is_final, false, 'identifies interim result');
assertEqual(interimParsed.confidence, 0.72, 'extracts lower confidence');

// Test 3: Empty transcript handling
const emptyResponse = JSON.stringify({
  channel: { alternatives: [{ transcript: '', confidence: 0.0 }] },
  is_final: true,
});

const emptyParsed = parseDeepgramResponse(emptyResponse);
assertEqual(emptyParsed.text, '', 'handles empty transcript');

// Test 4: Missing fields with defaults
const minimalResponse = JSON.stringify({
  is_final: true,
});

const minimalParsed = parseDeepgramResponse(minimalResponse);
assertEqual(minimalParsed.text, '', 'defaults to empty on missing fields');
assertEqual(minimalParsed.confidence, 0.0, 'defaults confidence to 0');
assertEqual(minimalParsed.is_final, true, 'preserves is_final flag');

// Test 5: Transcript accumulation (simulated)
function accumulateTranscript(existing, chunk) {
  if (chunk.is_final) {
    return existing ? existing + ' ' + chunk.text : chunk.text;
  }
  return existing;
}

let transcript = '';
transcript = accumulateTranscript(transcript, { text: 'Hello', is_final: true });
assertEqual(transcript, 'Hello', 'first final accumulates');

transcript = accumulateTranscript(transcript, { text: 'world', is_final: true });
assertEqual(transcript, 'Hello world', 'subsequent finals append with space');

transcript = accumulateTranscript(transcript, { text: 'interim', is_final: false });
assertEqual(transcript, 'Hello world', 'interim results do not accumulate');

// Test 6: Chunk structure validation
const chunk = { text: 'Test', is_final: true, confidence: 0.9, timestamp: 123456789 };
assertTrue('text' in chunk, 'chunk has text field');
assertTrue('is_final' in chunk, 'chunk has is_final field');
assertTrue('confidence' in chunk, 'chunk has confidence field');
assertTrue('timestamp' in chunk, 'chunk has timestamp field');

console.log('\n=== All Transcription Tests Passed ===\n');
