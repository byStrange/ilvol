/**
 * The extraction prompt.
 *
 * Lives in its own module so the eval harness (evals/run.ts) sends byte-identical
 * text to what production sends. A prompt copied into a test file drifts within
 * a week and then the eval is measuring something that no longer ships.
 */

// Mirrors LoadFormData in src-tauri/src/lib.rs. Keep in sync.
export const FIELDS = [
  'pickup_location',
  'pickup_datetime',
  'pickup_type',
  'pickup_window',
  'delivery_location',
  'delivery_datetime',
  'delivery_type',
  'delivery_window',
  'stops',
  'commodity',
  'equipment_type',
  'trailer_instructions',
  'rate',
  'weight',
  'additional_notes',
] as const;

export type LoadField = (typeof FIELDS)[number];

export function buildPrompt(transcript: string): string {
  return `You are a logistics data extraction assistant. Given a broker conversation transcript, extract the following fields:
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
{
  "data": {
${FIELDS.map((f) => `    "${f}": "..."`).join(',\n')}
  },
  "confidence": {
${FIELDS.map((f) => `    "${f}": 0.9`).join(',\n')}
  }
}

Transcript:
${transcript}`;
}

console.log(buildPrompt(`**Dispatcher**: Calling about 53ft dry van pick Chicago IL drop Atlanta GA. Load 45678. Still available?

**Broker**: Available. Rate two thousand two hundred dollars. Full truckload.

**Dispatcher**: Too low. Market average high. Need two thousand four hundred dollars. Deadhead twenty miles.

**Broker**: Max authority two thousand three hundred dollars. Shipper strict on budget.

**Dispatcher**: Two thousand three hundred fifty dollars. Meet middle. Driver ready immediate dispatch.

**Broker**: Deal. Send MC number, insurance certificate, driver phone. Rate confirmation coming now.`))

/** The model may wrap its JSON in markdown fences despite instructions. */
export function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
}
