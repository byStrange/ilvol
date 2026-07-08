/**
 * LoadForm - Template System
 *
 * Defines the default template and a render function for formatting
 * load data into driver-friendly output.
 */

export const DEFAULT_TEMPLATE = `LOAD DETAILS
Pickup: {pickup_location} — {pickup_datetime}
Delivery: {delivery_location} — {delivery_datetime}
Rate: {rate}
Weight: {weight}
Equipment: {equipment}
Notes: {notes}`;

/**
 * Available template variables:
 * {pickup_location}, {pickup_datetime}
 * {delivery_location}, {delivery_datetime}
 * {commodity}, {equipment} (alias for equipment_type)
 * {rate}, {weight}
 * {notes} (alias for additional_notes)
 */

const FIELD_ALIASES = {
  equipment: 'equipment_type',
  notes: 'additional_notes',
};

/**
 * Render a template string by replacing {variable} placeholders with values.
 *
 * @param {string} template - Template string with {placeholders}
 * @param {Object} data - Data object with field values
 * @returns {string} Rendered output
 */
export function renderTemplate(template, data) {
  let result = template;

  // Replace all {key} placeholders
  const regex = /\{(\w+)\}/g;
  result = result.replace(regex, (match, key) => {
    // Resolve aliases: {equipment} -> equipment_type
    const dataKey = FIELD_ALIASES[key] || key;
    const value = data[dataKey];
    return value !== undefined && value !== '' ? value : `?{${key}}?`;
  });

  // Clean up any lines that end up empty or with just placeholder markers
  result = result
    .split('\n')
    .filter((line) => !line.match(/^\?\{\w+\}\?$/))
    .join('\n');

  return result.trim();
}

/**
 * Get confidence color class for a field based on its confidence score.
 *
 * @param {number} confidence - 0.0 to 1.0
 * @returns {string} Tailwind border color class
 */
export function getConfidenceBorderColor(confidence) {
  if (confidence >= 0.8) return 'border-green-500';
  if (confidence >= 0.5) return 'border-yellow-500';
  return 'border-red-500';
}

/**
 * Get confidence badge class.
 *
 * @param {number} confidence - 0.0 to 1.0
 * @returns {string} Tailwind badge class
 */
export function getConfidenceBadgeColor(confidence) {
  if (confidence >= 0.8) return 'bg-green-500/20 text-green-400';
  if (confidence >= 0.5) return 'bg-yellow-500/20 text-yellow-400';
  return 'bg-red-500/20 text-red-400';
}

/**
 * Check if a field needs review (confidence below threshold).
 *
 * @param {number} confidence - 0.0 to 1.0
 * @param {number} threshold - Default 0.7
 * @returns {boolean}
 */
export function needsReview(confidence, threshold = 0.7) {
  return confidence < threshold;
}
