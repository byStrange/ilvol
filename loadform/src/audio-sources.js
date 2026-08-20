/**
 * LoadForm — what the app can capture, and what it should say when it can't.
 *
 * The backend reports a flat device list (`list_devices` in audio_capture.rs):
 * zero or more `mic:N` entries plus exactly one system entry — `system:default`
 * where loopback actually works, `system:unavailable` everywhere else. Three
 * useful capture modes fall out of that list, and which of them are reachable
 * depends on what the machine has.
 *
 * The rule that matters most here: **a missing microphone must not take system
 * audio down with it.** A dispatcher listening to a call on speaker, with no
 * mic plugged in at all, still has one whole side of the conversation to
 * transcribe. The picker used to collapse to a single disabled "No microphones
 * found" line in that case, which read as "this app is broken" and hid the one
 * mode that would have worked.
 *
 * So every mode is always returned, available or not, each carrying the reason
 * it can't be used. The UI renders the unreachable ones as visibly disabled
 * cards with that reason on them, rather than omitting them — someone with no
 * mic learns they have no mic, instead of wondering where the option went.
 *
 * The capture-mode string encoding (unchanged, and what start_capture_cmd
 * takes once split by parseCaptureMode):
 *
 *   "mic:0"          mic only
 *   "mic:0+system"   mic mixed with system audio  ← the default when possible
 *   "system:default" system audio only
 */

export const MIX_SUFFIX = '+system';

/** The backend's id for loopback capture on platforms that support it. */
export const SYSTEM_DEVICE_ID = 'system:default';

/** Split a capture-mode string into what start_capture_cmd actually takes. */
export function parseCaptureMode(value) {
  const str = typeof value === 'string' ? value : '';
  const mixSystemAudio = str.endsWith(MIX_SUFFIX);
  return {
    deviceId: mixSystemAudio ? str.slice(0, -MIX_SUFFIX.length) : str,
    mixSystemAudio,
  };
}

/** The inverse, for syncing the picker to a capture started elsewhere. */
export function captureModeValue(deviceId, mixSystemAudio) {
  return mixSystemAudio ? `${deviceId}${MIX_SUFFIX}` : deviceId;
}

/** Which of the three modes a capture-mode string represents. */
export function modeIdForValue(value) {
  const { deviceId, mixSystemAudio } = parseCaptureMode(value);
  if (mixSystemAudio) return 'both';
  if (deviceId.startsWith('system:')) return 'system';
  if (deviceId.startsWith('mic:')) return 'mic';
  return null;
}

/** What the token grant should be billed as. */
export function captureSourceLabel(value) {
  const id = modeIdForValue(value);
  return id === 'both' ? 'mixed' : id === 'system' ? 'system' : 'mic';
}

export function listMicrophones(devices) {
  return (Array.isArray(devices) ? devices : []).filter(
    (d) => d && d.device_type === 'microphone',
  );
}

export function hasSystemAudio(devices) {
  return (Array.isArray(devices) ? devices : []).some((d) => d && d.id === SYSTEM_DEVICE_ID);
}

const NO_MIC_REASON = 'No microphone detected on this PC.';
const NO_SYSTEM_REASON =
  'System audio capture needs Windows. On Linux or macOS, route it through a virtual audio cable and pick that as a microphone.';

/**
 * The three capture modes, in the order they should be offered.
 *
 * `micId` picks which microphone the mic-bearing modes use; it falls back to
 * the first one reported. Modes that can't run come back with `available:
 * false` and a `reason` written for the person reading it, not for a log.
 */
export function buildCaptureModes(devices, micId = null) {
  const mics = listMicrophones(devices);
  const system = hasSystemAudio(devices);
  const mic = mics.find((d) => d.id === micId) || mics[0] || null;
  const micName = mic ? mic.name : null;

  const both = {
    id: 'both',
    title: 'Both sides of the call',
    subtitle: micName
      ? `${micName} + everything playing on this PC`
      : 'Your microphone + everything playing on this PC',
    detail:
      'Records you and the broker together — your mic plus anything coming through RingCentral, Zoom, Teams or the browser.',
    recommended: Boolean(mic && system),
    value: mic ? captureModeValue(mic.id, true) : null,
    available: Boolean(mic && system),
    reason: !mic ? NO_MIC_REASON : !system ? NO_SYSTEM_REASON : null,
  };

  const micOnly = {
    id: 'mic',
    title: 'Just my side',
    subtitle: micName ? micName : 'Your microphone',
    detail:
      "Records only your microphone. The broker's side of the call will not be in the transcript.",
    // Promoted to the lead choice where loopback can't run at all (Linux,
    // macOS): being the best available mode is what "recommended" means here.
    recommended: Boolean(mic && !system),
    value: mic ? captureModeValue(mic.id, false) : null,
    available: Boolean(mic),
    reason: mic ? null : NO_MIC_REASON,
  };

  const systemOnly = {
    id: 'system',
    title: 'Just what I hear',
    subtitle: 'Everything playing on this PC — calls, speakers, video',
    detail:
      'Records only what comes out of your speakers. Your own voice will not be in the transcript.',
    // Without a mic this is the only thing that can run, so it stops being the
    // niche choice and becomes the one the picker leads with.
    recommended: !mics.length && system,
    value: system ? SYSTEM_DEVICE_ID : null,
    available: system,
    reason: system ? null : NO_SYSTEM_REASON,
  };

  return [both, micOnly, systemOnly];
}

/**
 * The mode to open on: the richest one this machine can actually run.
 *
 * Mixed first because a broker call has two sides and capturing one of them
 * transcribes half a conversation — then mic, then system audio alone, which
 * is what a mic-less machine lands on. `null` only when nothing can capture.
 */
export function defaultCaptureValue(devices, micId = null) {
  const modes = buildCaptureModes(devices, micId);
  const pick = modes.find((m) => m.available);
  return pick ? pick.value : null;
}

/**
 * One line naming what the machine is missing, or null when nothing is.
 *
 * Shown above the picker so the gap is stated once, plainly, instead of being
 * inferred from which cards happen to be greyed out.
 */
export function captureWarning(devices) {
  const mics = listMicrophones(devices);
  const system = hasSystemAudio(devices);

  if (!mics.length && !system) {
    return 'No microphone and no system audio on this PC — there is nothing to record. Plug in a mic or headset, then press Refresh.';
  }
  if (!mics.length) {
    return 'No microphone detected. System audio still works, so anything playing on this PC will be transcribed — but your own voice will not be.';
  }
  if (!system) {
    return "System audio capture is Windows-only, so only your microphone can be recorded here. The broker's side will not be in the transcript.";
  }
  return null;
}
