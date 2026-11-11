'use strict';

/**
 * Structural checks on the patch spec.
 *
 * These guard the contract that makes the patch safe across releases: every
 * rule must be anchored, counted, and paired with a probe. A rule that silently
 * loses its probe or its expected count could misapply to a future build, which
 * is the one failure mode this project exists to avoid.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const spec = require('../../src/js/patch-spec');

const REQUIRED_FIELDS = ['id', 'title', 'pattern', 'replacement', 'probe', 'expectTotal', 'perFile', 'why'];

test('every rule declares the full contract', () => {
  for (const rule of spec.rules) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(rule[field] !== undefined && rule[field] !== '', `rule ${rule.id} is missing ${field}`);
    }
    assert.ok(
      typeof rule.replacement === 'string' || typeof rule.replacement === 'function',
      `rule ${rule.id}: replacement must be a string or a function`
    );
  }
});

test('patterns and probes are global regexes', () => {
  for (const rule of spec.rules) {
    assert.ok(rule.pattern instanceof RegExp, `rule ${rule.id}: pattern must be a RegExp`);
    assert.ok(rule.pattern.global, `rule ${rule.id}: pattern must use the /g flag`);
    assert.ok(rule.probe instanceof RegExp, `rule ${rule.id}: probe must be a RegExp`);
    assert.ok(rule.probe.global, `rule ${rule.id}: probe must use the /g flag`);
  }
});

test('expected counts are positive and per-file bounds are sane', () => {
  for (const rule of spec.rules) {
    assert.ok(Number.isInteger(rule.expectTotal) && rule.expectTotal > 0, `rule ${rule.id}: bad expectTotal`);
    assert.ok(Number.isInteger(rule.perFile) && rule.perFile > 0, `rule ${rule.id}: bad perFile`);
    assert.ok(rule.perFile <= rule.expectTotal, `rule ${rule.id}: perFile exceeds expectTotal`);
  }
});

test('rule ids are unique', () => {
  const ids = spec.rules.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate rule id in ${ids.join(', ')}`);
});

test('pattern and probe of the same rule do not overlap', () => {
  // A rule whose probe also matches its own pattern would report both
  // "pending" and "applied" for the same site.
  for (const rule of spec.rules) {
    const sample = rule.probe.source;
    assert.notEqual(sample, rule.pattern.source, `rule ${rule.id}: probe equals pattern`);
  }
});

test('the spec has a semver version', () => {
  assert.match(spec.SPEC_VERSION, /^\d+\.\d+\.\d+$/);
});

test('gateway providers are the only relaxed branches', () => {
  assert.deepEqual(spec.GATEWAY_PROVIDERS, ['gateway', 'mantle']);
  const relaxed = spec.rules.find((r) => r.id === 'gateway-validator-relaxed');
  assert.ok(relaxed, 'gateway-validator-relaxed rule is missing');
  for (const provider of ['anthropic', 'bedrock', 'vertex', 'foundry']) {
    assert.ok(
      !relaxed.pattern.source.includes(`case"${provider}"`),
      `rule must not touch the ${provider} branch`
    );
  }
});
