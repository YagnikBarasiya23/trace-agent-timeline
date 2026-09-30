/*!
 * Trace — an agent run timeline. MIT © 2026 Yagnik Barasiya
 * https://github.com/YagnikBarasiya23/trace-agent-timeline
 */

const TRANSITIONS = {
  running: { done: 'done', fail: 'failed', cancel: 'cancelled' },
  failed: { retry: 'running' },
};

/** The only legal step state changes. Anything else is a bug in the caller. */
export function transition(state, event) {
  const next = TRANSITIONS[state]?.[event];
  if (!next) throw new Error(`Trace: cannot ${event} a ${state} step`);
  return next;
}

/** 1.3s under ten seconds, 12s under a minute, then 1m 05s. */
export function formatDuration(ms) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 9.95) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}

/** Indented JSON for tool arguments and results, with long strings cut short. */
export function summarizeJson(value, maxLen = 80) {
  if (value === undefined) return '';
  const cut = v => (typeof v === 'string' && v.length > maxLen ? `${v.slice(0, maxLen - 1)}…` : v);
  if (typeof value === 'string') return cut(value);
  try {
    return JSON.stringify(value, (_, v) => cut(v), 2);
  } catch {
    return String(value);
  }
}

/**
 * Tools that start before the previous one finishes run in parallel:
 * wrap a lone running tool into a group, or join a running group.
 */
export function groupDecision(last) {
  if (!last || last.parent) return 'new';
  if (last.kind === 'parallel' && last.state === 'running') return 'join';
  if (last.kind === 'tool' && last.state === 'running') return 'wrap';
  return 'new';
}

const parseArgs = text => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const message = error => String(error?.message ?? error ?? 'Run failed');

function openaiMapper() {
  const started = new Set();
  return event => {
    switch (event.type) {
      case 'response.reasoning_summary_text.delta': {
        const ops = [];
        if (!started.has(event.item_id)) {
          started.add(event.item_id);
          ops.push({ op: 'reasoning.start', id: event.item_id });
        }
        ops.push({ op: 'reasoning.append', id: event.item_id, text: event.delta });
        return ops;
      }
      case 'response.output_item.done':
        return event.item?.type === 'reasoning' && started.has(event.item.id) ? [{ op: 'reasoning.done', id: event.item.id }] : [];
      case 'response.output_item.added':
        return event.item?.type === 'function_call' ? [{ op: 'tool.start', id: event.item.id, name: event.item.name }] : [];
      case 'response.function_call_arguments.done':
        return [{ op: 'tool.args', id: event.item_id, args: parseArgs(event.arguments) }];
      case 'response.completed':
        return [{ op: 'finish' }];
      case 'response.failed':
        return [{ op: 'error', message: message(event.response?.error) }];
      case 'error':
        return [{ op: 'error', message: message(event) }];
      default:
        return [];
    }
  };
}

function anthropicMapper() {
  const blocks = new Map();
  let turn = 0;
  let stopReason = null;
  return event => {
    switch (event.type) {
      case 'message_start':
        turn++;
        stopReason = null;
        return [];
      case 'content_block_start': {
        const block = event.content_block;
        if (block.type === 'thinking') {
          const id = `thinking-${turn}-${event.index}`;
          blocks.set(event.index, { kind: 'thinking', id });
          return [{ op: 'reasoning.start', id }];
        }
        if (block.type === 'tool_use') {
          blocks.set(event.index, { kind: 'tool', id: block.id, json: '' });
          return [{ op: 'tool.start', id: block.id, name: block.name }];
        }
        return [];
      }
      case 'content_block_delta': {
        const block = blocks.get(event.index);
        if (block?.kind === 'thinking' && event.delta.type === 'thinking_delta') {
          return [{ op: 'reasoning.append', id: block.id, text: event.delta.thinking }];
        }
        if (block?.kind === 'tool' && event.delta.type === 'input_json_delta') block.json += event.delta.partial_json;
        return [];
      }
      case 'content_block_stop': {
        const block = blocks.get(event.index);
        blocks.delete(event.index);
        if (block?.kind === 'thinking') return [{ op: 'reasoning.done', id: block.id }];
        if (block?.kind === 'tool') return [{ op: 'tool.args', id: block.id, args: block.json ? parseArgs(block.json) : {} }];
        return [];
      }
      case 'message_delta':
        stopReason = event.delta?.stop_reason ?? stopReason;
        return [];
      case 'message_stop':
        // A tool_use stop means the agent loop continues with another message.
        return stopReason === 'tool_use' ? [] : [{ op: 'finish' }];
      case 'error':
        return [{ op: 'error', message: message(event.error) }];
      default:
        return [];
    }
  };
}

function aiSdkMapper() {
  const started = new Set();
  const start = id => {
    if (started.has(id)) return [];
    started.add(id);
    return [{ op: 'reasoning.start', id }];
  };
  return part => {
    switch (part.type) {
      case 'reasoning-start':
        return start(part.id);
      case 'reasoning-delta':
        return [...start(part.id), { op: 'reasoning.append', id: part.id, text: part.text ?? part.delta ?? '' }];
      case 'reasoning-end':
        return [{ op: 'reasoning.done', id: part.id }];
      case 'tool-call':
        return [
          { op: 'tool.start', id: part.toolCallId, name: part.toolName },
          { op: 'tool.args', id: part.toolCallId, args: part.input ?? part.args ?? {} },
        ];
      case 'tool-result':
        return [{ op: 'tool.done', id: part.toolCallId, result: part.output ?? part.result }];
      case 'tool-error':
        return [{ op: 'tool.fail', id: part.toolCallId, message: message(part.error) }];
      case 'finish':
        return [{ op: 'finish' }];
      case 'error':
        return [{ op: 'error', message: message(part.error) }];
      default:
        return [];
    }
  };
}

const MAPPERS = { openai: openaiMapper, anthropic: anthropicMapper, 'ai-sdk': aiSdkMapper };

/** Turns one provider's stream events into Trace operations. Stateful: make one per run. */
export function createMapper(format) {
  const make = MAPPERS[format];
  if (!make) throw new Error(`Trace: unknown format "${format}"`);
  return make();
}
