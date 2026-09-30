import test from 'node:test';
import assert from 'node:assert/strict';
import { transition, formatDuration, summarizeJson, groupDecision } from '../trace.js';

test('running steps can finish, fail or be cancelled', () => {
  assert.equal(transition('running', 'done'), 'done');
  assert.equal(transition('running', 'fail'), 'failed');
  assert.equal(transition('running', 'cancel'), 'cancelled');
});

test('only failed steps can be retried and finished steps stay finished', () => {
  assert.equal(transition('failed', 'retry'), 'running');
  assert.throws(() => transition('done', 'fail'), /cannot fail a done step/);
  assert.throws(() => transition('running', 'retry'), /cannot retry a running step/);
  assert.throws(() => transition('cancelled', 'done'));
});

test('durations read naturally at every scale', () => {
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(1340), '1.3s');
  assert.equal(formatDuration(9949), '9.9s');
  assert.equal(formatDuration(12400), '12s');
  assert.equal(formatDuration(59600), '1m 00s');
  assert.equal(formatDuration(65000), '1m 05s');
  assert.equal(formatDuration(119600), '2m 00s');
  assert.equal(formatDuration(-5), '0.0s');
});

test('summarizeJson pretty-prints and truncates long strings', () => {
  assert.equal(summarizeJson(undefined), '');
  assert.equal(summarizeJson({ days: 30 }), '{\n  "days": 30\n}');
  assert.equal(summarizeJson('x'.repeat(10), 5), 'xxxx…');
  assert.equal(summarizeJson({ note: 'abcdefghij' }, 5), '{\n  "note": "abcd…"\n}');
  const loop = {};
  loop.self = loop;
  assert.equal(summarizeJson(loop), '[object Object]');
});

test('a tool that starts while another is running groups them', () => {
  assert.equal(groupDecision(null), 'new');
  assert.equal(groupDecision({ kind: 'tool', state: 'running', parent: null }), 'wrap');
  assert.equal(groupDecision({ kind: 'tool', state: 'done', parent: null }), 'new');
  assert.equal(groupDecision({ kind: 'parallel', state: 'running', parent: null }), 'join');
  assert.equal(groupDecision({ kind: 'parallel', state: 'done', parent: null }), 'new');
  assert.equal(groupDecision({ kind: 'reasoning', state: 'running', parent: null }), 'new');
});
