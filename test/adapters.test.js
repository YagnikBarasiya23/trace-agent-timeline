import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMapper } from '../trace.js';

const load = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const run = format => {
  const map = createMapper(format);
  return load(format).flatMap(event => map(event));
};

test('OpenAI Responses stream maps to reasoning, tools and finish', () => {
  assert.deepEqual(run('openai'), [
    { op: 'reasoning.start', id: 'rs_1' },
    { op: 'reasoning.append', id: 'rs_1', text: 'The owner wants ' },
    { op: 'reasoning.append', id: 'rs_1', text: 'a weekend offer.' },
    { op: 'reasoning.done', id: 'rs_1' },
    { op: 'tool.start', id: 'fc_1', name: 'analytics_summary' },
    { op: 'tool.args', id: 'fc_1', args: { days: 30 } },
    { op: 'tool.start', id: 'fc_2', name: 'best_time' },
    { op: 'tool.args', id: 'fc_2', args: 'not json' },
    { op: 'finish' },
  ]);
});

test('Anthropic stream keeps thinking blocks apart across messages and finishes only at end_turn', () => {
  assert.deepEqual(run('anthropic'), [
    { op: 'reasoning.start', id: 'thinking-1-0' },
    { op: 'reasoning.append', id: 'thinking-1-0', text: 'Check last month first.' },
    { op: 'reasoning.done', id: 'thinking-1-0' },
    { op: 'tool.start', id: 'toolu_1', name: 'analytics_summary' },
    { op: 'tool.args', id: 'toolu_1', args: { days: 30 } },
    { op: 'reasoning.start', id: 'thinking-2-0' },
    { op: 'reasoning.append', id: 'thinking-2-0', text: 'Reach is up.' },
    { op: 'reasoning.done', id: 'thinking-2-0' },
    { op: 'finish' },
  ]);
});

test('AI SDK fullStream maps tool calls, results and errors', () => {
  assert.deepEqual(run('ai-sdk'), [
    { op: 'reasoning.start', id: 'r1' },
    { op: 'reasoning.append', id: 'r1', text: 'Pull the numbers.' },
    { op: 'reasoning.done', id: 'r1' },
    { op: 'tool.start', id: 't1', name: 'analytics_summary' },
    { op: 'tool.args', id: 't1', args: { days: 30 } },
    { op: 'tool.start', id: 't2', name: 'best_time' },
    { op: 'tool.args', id: 't2', args: {} },
    { op: 'tool.done', id: 't1', result: { reach: 7200 } },
    { op: 'tool.fail', id: 't2', message: 'Timed out' },
    { op: 'finish' },
  ]);
});

test('AI SDK reasoning without a start event still opens a step once', () => {
  const map = createMapper('ai-sdk');
  assert.deepEqual(map({ type: 'reasoning-delta', id: 'x', text: 'a' }), [
    { op: 'reasoning.start', id: 'x' },
    { op: 'reasoning.append', id: 'x', text: 'a' },
  ]);
  assert.deepEqual(map({ type: 'reasoning-delta', id: 'x', text: 'b' }), [{ op: 'reasoning.append', id: 'x', text: 'b' }]);
});

test('errors map to an error op and unknown formats throw', () => {
  assert.deepEqual(createMapper('openai')({ type: 'error', message: 'Rate limited' }), [{ op: 'error', message: 'Rate limited' }]);
  assert.deepEqual(createMapper('anthropic')({ type: 'error', error: { message: 'Overloaded' } }), [{ op: 'error', message: 'Overloaded' }]);
  assert.deepEqual(createMapper('ai-sdk')({ type: 'error', error: 'boom' }), [{ op: 'error', message: 'boom' }]);
  assert.throws(() => createMapper('gemini'), /unknown format/);
});
