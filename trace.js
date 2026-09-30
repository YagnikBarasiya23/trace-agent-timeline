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
