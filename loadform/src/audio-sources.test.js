/**
 * LoadForm — capture source selection tests
 *
 *   node src/audio-sources.test.js
 *
 * The case this file exists for is the mic-less Windows PC. A fresh install on
 * a desktop with no microphone reported "no devices" and refused to record
 * anything, even though loopback capture — the whole other side of the call —
 * was sitting right there in the device list. Most of what follows is about
 * that: system audio must survive a missing mic, and the person in front of
 * the app must be told which half they are losing.
 */

import {
  buildCaptureModes,
  defaultCaptureValue,
  captureWarning,
  parseCaptureMode,
  captureModeValue,
  modeIdForValue,
  captureSourceLabel,
} from './audio-sources.js';

let failures = 0;

function check(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`FAIL: ${message}`);
    console.error(`  Expected: ${JSON.stringify(expected)}`);
    console.error(`  Actual:   ${JSON.stringify(actual)}`);
    return;
  }
  console.log(`PASS: ${message}`);
}

const MIC_1 = { id: 'mic:0', name: 'Headset Mic', device_type: 'microphone' };
const MIC_2 = { id: 'mic:1', name: 'Webcam Mic', device_type: 'microphone' };
const SYSTEM = { id: 'system:default', name: 'System Audio (All Apps)', device_type: 'system' };
const NO_SYSTEM = {
  id: 'system:unavailable',
  name: 'System Audio (Windows only)',
  device_type: 'system',
};

const modeById = (devices, id, micId = null) =>
  buildCaptureModes(devices, micId).find((m) => m.id === id);

// ─── Windows with a mic: everything reachable ───────────────────────────────

check(
  buildCaptureModes([MIC_1, SYSTEM]).map((m) => m.available),
  [true, true, true],
  'a Windows PC with a mic can run all three modes',
);
check(
  defaultCaptureValue([MIC_1, SYSTEM]),
  'mic:0+system',
  'opens on mic mixed with system audio, which hears both sides',
);
check(modeById([MIC_1, MIC_2, SYSTEM], 'mic', 'mic:1').value, 'mic:1', 'honours the chosen mic');
check(
  modeById([MIC_1, MIC_2, SYSTEM], 'both', 'mic:1').value,
  'mic:1+system',
  'mixes the chosen mic, not merely the first one',
);
check(
  modeById([MIC_1, SYSTEM], 'both').subtitle,
  'Headset Mic + everything playing on this PC',
  'names the mic it will actually record',
);
check(captureWarning([MIC_1, SYSTEM]), null, 'nothing to warn about when both sides are available');

// ─── Windows with no mic: system audio still works ──────────────────────────
//
// The regression this whole module was written for.

const MICLESS = [SYSTEM];

check(modeById(MICLESS, 'system').available, true, 'system audio survives a missing microphone');
check(
  defaultCaptureValue(MICLESS),
  'system:default',
  'a mic-less PC opens on system audio rather than on nothing',
);
check(
  modeById(MICLESS, 'system').recommended,
  true,
  'system audio leads the picker when it is the only mode that can run',
);
check(
  buildCaptureModes(MICLESS).map((m) => m.available),
  [false, false, true],
  'the two mic modes are unavailable, and are still returned so the UI can say why',
);
check(
  modeById(MICLESS, 'mic').reason,
  'No microphone detected on this PC.',
  'the mic modes carry the reason they cannot be picked',
);
check(
  captureWarning(MICLESS).startsWith('No microphone detected.'),
  true,
  'the missing mic is stated outright, not left to be inferred',
);
check(
  captureWarning(MICLESS).includes('System audio still works'),
  true,
  'and the warning says what does still work',
);

// ─── Linux/macOS: loopback is the half that is missing ──────────────────────

check(
  buildCaptureModes([MIC_1, NO_SYSTEM]).map((m) => m.available),
  [false, true, false],
  'without loopback only the mic-only mode can run',
);
check(
  defaultCaptureValue([MIC_1, NO_SYSTEM]),
  'mic:0',
  'so that is what the picker opens on',
);
check(
  modeById([MIC_1, NO_SYSTEM], 'mic').recommended,
  true,
  'mic-only leads the picker where it is the best available mode',
);
check(
  modeById([MIC_1, NO_SYSTEM], 'system').reason.includes('Windows'),
  true,
  'and system audio explains that it needs Windows',
);

// ─── Nothing at all ─────────────────────────────────────────────────────────

check(defaultCaptureValue([]), null, 'no devices means no default, rather than a bogus one');
check(defaultCaptureValue([NO_SYSTEM]), null, 'a placeholder system entry is not a capture mode');
check(
  captureWarning([NO_SYSTEM]).includes('nothing to record'),
  true,
  'a machine that can record nothing says so',
);

// ─── Mode string encoding ───────────────────────────────────────────────────

check(parseCaptureMode('mic:0+system'), { deviceId: 'mic:0', mixSystemAudio: true }, 'splits a mixed mode');
check(parseCaptureMode('mic:0'), { deviceId: 'mic:0', mixSystemAudio: false }, 'splits a mic-only mode');
check(
  parseCaptureMode('system:default'),
  { deviceId: 'system:default', mixSystemAudio: false },
  'splits a system-only mode',
);
check(parseCaptureMode(null), { deviceId: '', mixSystemAudio: false }, 'survives a missing value');
check(captureModeValue('mic:0', true), 'mic:0+system', 'rebuilds a mixed mode');
check(captureModeValue('mic:0', false), 'mic:0', 'rebuilds a mic-only mode');
check(modeIdForValue('mic:0+system'), 'both', 'reads a mixed value back as a mode');
check(modeIdForValue('system:default'), 'system', 'reads a system value back as a mode');
check(modeIdForValue('mic:1'), 'mic', 'reads a mic value back as a mode');
check(modeIdForValue(''), null, 'refuses to name a mode for an empty value');

// The string the token grant is billed under — a system-only capture is not a
// mic capture, and the widget used to report it as one.
check(captureSourceLabel('mic:0+system'), 'mixed', 'bills a mixed capture as mixed');
check(captureSourceLabel('system:default'), 'system', 'bills a system-only capture as system');
check(captureSourceLabel('mic:0'), 'mic', 'bills a mic capture as mic');

console.log(failures === 0 ? '\nAll capture source tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
