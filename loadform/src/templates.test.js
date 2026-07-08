/**
 * LoadForm - Template System Tests
 *
 * Run in browser console or with a test runner:
 *   node --experimental-vm-modules src/templates.test.js
 */

import { DEFAULT_TEMPLATE, renderTemplate, getConfidenceBorderColor, getConfidenceBadgeColor, needsReview } from './templates.js';

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

function assertFalse(actual, message) {
  if (actual) {
    console.error(`FAIL: ${message}`);
    throw new Error(`Test failed: ${message}`);
  }
  console.log(`PASS: ${message}`);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

console.log('\n=== Template Tests ===\n');

// Test 1: Basic template rendering
const data = {
  pickup_location: 'Amarillo, TX',
  pickup_datetime: 'Tue 6/24, 8:00 AM',
  delivery_location: 'Tulsa, OK',
  delivery_datetime: 'Thu 6/26, 6:00 AM',
  commodity: 'Frozen chicken',
  equipment_type: 'Reefer',
  rate: '$2.80/mile',
  weight: '43,000 lbs',
  additional_notes: 'Lumpers required',
};

const result = renderTemplate(DEFAULT_TEMPLATE, data);
assertTrue(result.includes('Amarillo, TX'), 'renders pickup_location');
assertTrue(result.includes('Tue 6/24, 8:00 AM'), 'renders pickup_datetime');
assertTrue(result.includes('$2.80/mile'), 'renders rate');
assertTrue(result.includes('Lumpers required'), 'renders notes');

// Test 2: Alias resolution
assertTrue(result.includes('Reefer'), 'resolves {equipment} alias to equipment_type');
assertTrue(result.includes('Lumpers required'), 'resolves {notes} alias to additional_notes');

// Test 3: Missing fields show placeholder markers
const partialData = {
  pickup_location: 'Dallas, TX',
  delivery_location: 'Houston, TX',
};
const partialResult = renderTemplate(DEFAULT_TEMPLATE, partialData);
assertTrue(partialResult.includes('Dallas, TX'), 'renders available fields');

// Test 4: Confidence border colors
assertEqual(getConfidenceBorderColor(0.95), 'border-green-500', 'high confidence is green');
assertEqual(getConfidenceBorderColor(0.8), 'border-green-500', 'threshold high confidence is green');
assertEqual(getConfidenceBorderColor(0.65), 'border-yellow-500', 'medium confidence is yellow');
assertEqual(getConfidenceBorderColor(0.5), 'border-yellow-500', 'threshold medium confidence is yellow');
assertEqual(getConfidenceBorderColor(0.3), 'border-red-500', 'low confidence is red');

// Test 5: Confidence badge colors
assertTrue(getConfidenceBadgeColor(0.9).includes('green'), 'high confidence badge is green');
assertTrue(getConfidenceBadgeColor(0.6).includes('yellow'), 'medium confidence badge is yellow');
assertTrue(getConfidenceBadgeColor(0.2).includes('red'), 'low confidence badge is red');

// Test 6: Needs review
assertTrue(needsReview(0.5), '50% confidence needs review');
assertTrue(needsReview(0.69), '69% confidence needs review');
assertFalse(needsReview(0.7), '70% confidence does not need review');
assertFalse(needsReview(0.85), '85% confidence does not need review');

// Test 7: Custom threshold
assertTrue(needsReview(0.8, 0.85), '80% below 85% threshold needs review');
assertFalse(needsReview(0.9, 0.85), '90% above 85% threshold OK');

// Test 8: Custom template
const customTemplate = 'FROM: {pickup_location} TO: {delivery_location} PAY: {rate}';
const customResult = renderTemplate(customTemplate, data);
assertEqual(customResult, 'FROM: Amarillo, TX TO: Tulsa, OK PAY: $2.80/mile', 'custom template renders correctly');

console.log('\n=== All Template Tests Passed ===\n');
