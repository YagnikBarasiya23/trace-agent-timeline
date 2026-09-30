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

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let uid = 0;

class Step {
  constructor(trace, { kind, name = '', id, parent = null }) {
    this.trace = trace;
    this.kind = kind;
    this.name = name;
    this.id = id ?? `step-${++uid}`;
    this.parent = parent;
    this.children = [];
    this.state = 'running';
    this.startedAt = performance.now();
    this.endedAt = null;
    this.text = '';
    this.argsValue = undefined;
    this.resultValue = undefined;
    this.error = null;
    this.fraction = null;
    this.open = kind === 'reasoning';
    this.el = parent ? this.#lane() : this.#row();
    this.render();
  }

  #row() {
    const li = document.createElement('li');
    li.className = 'trace-step';
    li.dataset.kind = this.kind;
    li.innerHTML = `<span class="trace-dot" aria-hidden="true"></span>
<div class="trace-main">
  <button type="button" class="trace-head" aria-expanded="false">
    <span class="trace-title"></span><span class="trace-time"></span>
  </button>
  <div class="trace-body"></div>
</div>`;
    li.querySelector('.trace-head')._step = this;
    return li;
  }

  #lane() {
    const div = document.createElement('div');
    div.className = 'trace-lane';
    div.innerHTML = '<span class="trace-title"></span><span class="trace-time"></span><span class="trace-bar"><b></b></span>';
    return div;
  }

  get elapsed() {
    return (this.endedAt ?? performance.now()) - this.startedAt;
  }

  append(text) {
    this.text += text;
    this.render();
    this.trace._changed();
  }

  args(value) {
    this.argsValue = value;
    this.render();
  }

  progress(fraction) {
    this.fraction = Math.min(1, Math.max(0, fraction));
    this.render();
  }

  done({ result } = {}) {
    this.#move('done');
    if (result !== undefined) this.resultValue = result;
    if (this.kind === 'reasoning') this.open = false;
    if (this.kind === 'tool' || this.kind === 'reasoning') {
      this.trace._announce(`${this.#label()} finished in ${formatDuration(this.elapsed)}`);
    }
    this.#settle();
  }

  fail(messageText) {
    this.#move('fail');
    this.error = String(messageText ?? 'Failed');
    this.trace._announce(`${this.#label()} failed: ${this.error}`);
    this.#settle();
  }

  cancel() {
    this.#move('cancel');
    this.#settle();
  }

  retry() {
    this.state = transition(this.state, 'retry');
    this.error = null;
    this.resultValue = undefined;
    this.fraction = null;
    this.startedAt = performance.now();
    this.endedAt = null;
    this.#settle();
  }

  /** Parallel steps only: add a lane. */
  tool(name, { id, args } = {}) {
    if (this.kind !== 'parallel') throw new Error('Trace: only a parallel step has lanes');
    const lane = new Step(this.trace, { kind: 'tool', name, id, parent: this });
    this.children.push(lane);
    this.el.querySelector('.trace-lanes').append(lane.el);
    this.trace._register(lane);
    if (args !== undefined) lane.args(args);
    this.#childChanged();
    return lane;
  }

  #move(event) {
    this.state = transition(this.state, event);
    this.endedAt = performance.now();
  }

  #settle() {
    this.render();
    this.parent?.#childChanged();
    this.trace._changed();
  }

  #childChanged() {
    const states = this.children.map(c => c.state);
    const running = states.includes('running');
    if (running && this.state !== 'running') {
      this.state = 'running';
      this.endedAt = null;
      this.error = null;
    } else if (!running && this.state === 'running' && states.length) {
      const failed = states.filter(s => s === 'failed').length;
      this.endedAt = performance.now();
      this.state = failed ? 'failed' : 'done';
      this.error = failed ? `${failed} of ${states.length} failed` : null;
    }
    this.render();
    this.trace._changed();
  }

  #label() {
    if (this.kind === 'reasoning') return 'Reasoning';
    return this.name || 'Step';
  }

  render() {
    const el = this.el;
    el.dataset.state = this.state;
    el.querySelector('.trace-time').textContent = this.kind === 'message' || this.kind === 'final' ? '' : formatDuration(this.elapsed);
    const title = el.querySelector('.trace-title');

    if (this.parent) {
      title.textContent = this.name;
      el.title = this.error ?? summarizeJson(this.argsValue, 60);
      const bar = el.querySelector('.trace-bar');
      bar.classList.toggle('is-indeterminate', this.state === 'running' && this.fraction == null);
      bar.firstElementChild.style.width = this.state === 'running' ? `${(this.fraction ?? 0) * 100}%` : '100%';
      let retry = el.querySelector('.trace-retry');
      if (this.state === 'failed' && !retry) {
        retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'trace-retry';
        retry.textContent = 'Retry';
        retry._step = this;
        el.append(retry);
      } else if (this.state !== 'failed') retry?.remove();
      return;
    }

    if (this.kind === 'reasoning') {
      title.textContent = this.state === 'running' ? 'Thinking' : `Reasoned for ${formatDuration(this.elapsed)}`;
      title.classList.toggle('trace-shimmer', this.state === 'running' && !reduced());
    } else if (this.kind === 'parallel') {
      title.textContent = this.error ? `${this.name} · ${this.error}` : this.name;
    } else {
      title.textContent = this.name;
      title.classList.toggle('trace-mono', this.kind === 'tool');
    }

    const body = el.querySelector('.trace-body');
    const head = el.querySelector('.trace-head');
    const sections = [];
    if (this.kind === 'reasoning' && this.text) sections.push(['text', this.text]);
    if (this.argsValue !== undefined) sections.push(['Input', summarizeJson(this.argsValue)]);
    if (this.resultValue !== undefined) sections.push(['Output', summarizeJson(this.resultValue)]);
    body.replaceChildren(
      ...sections.map(([label, content]) => {
        if (label === 'text') {
          const p = document.createElement('p');
          p.className = 'trace-text';
          p.textContent = content;
          return p;
        }
        const block = document.createElement('div');
        block.className = 'trace-io';
        const h = document.createElement('span');
        h.textContent = label;
        const pre = document.createElement('pre');
        pre.textContent = content;
        block.append(h, pre);
        return block;
      }),
    );
    const showError = this.error && this.kind !== 'parallel' && this.kind !== 'final';
    if (showError) {
      const err = document.createElement('p');
      err.className = 'trace-error';
      err.textContent = this.error;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'trace-retry';
      retry.textContent = 'Retry';
      retry._step = this;
      err.append(' ', retry);
      body.append(err);
    }

    const expandable = sections.length > 0;
    head.disabled = !expandable && !showError;
    const open = (this.open && expandable) || Boolean(showError);
    head.setAttribute('aria-expanded', String(open));
    body.hidden = !open;

    if (this.kind === 'parallel' && !el.querySelector('.trace-lanes')) {
      const lanes = document.createElement('div');
      lanes.className = 'trace-lanes';
      el.querySelector('.trace-main').append(lanes);
    }
  }
}

export default class Trace {
  #steps = new Map();
  #listeners = {};
  #timer = 0;
  #stick = true;
  #frame = 0;

  constructor(el) {
    this.el = el;
    this.last = null;
    el.classList.add('trace');
    this.list = document.createElement('ol');
    this.list.className = 'trace-list';
    this.list.setAttribute('aria-label', 'Agent steps');
    this.live = document.createElement('div');
    this.live.className = 'trace-live';
    this.live.setAttribute('aria-live', 'polite');
    this.jump = document.createElement('button');
    this.jump.type = 'button';
    this.jump.className = 'trace-jump';
    this.jump.textContent = 'Jump to latest';
    this.jump.hidden = true;
    el.append(this.list, this.jump, this.live);

    this.onScroll = () => {
      this.#stick = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (this.#stick) this.jump.hidden = true;
    };
    this.onClick = event => {
      const retry = event.target.closest('.trace-retry');
      if (retry) {
        this.#emit('retry', retry._step);
        return;
      }
      if (event.target.closest('.trace-jump')) {
        el.scrollTo({ top: el.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' });
        return;
      }
      const head = event.target.closest('.trace-head');
      if (head?._step) {
        const step = head._step;
        step.open = head.getAttribute('aria-expanded') !== 'true';
        step.render();
        this.#emit('toggle', step, step.open);
      }
    };
    el.addEventListener('scroll', this.onScroll, { passive: true });
    el.addEventListener('click', this.onClick);
  }

  reasoning({ id } = {}) {
    return this.#add(new Step(this, { kind: 'reasoning', id }));
  }

  tool(name, { id, args } = {}) {
    const step = this.#add(new Step(this, { kind: 'tool', name, id }));
    if (args !== undefined) step.args(args);
    return step;
  }

  parallel(name = 'Running in parallel') {
    return this.#add(new Step(this, { kind: 'parallel', name }));
  }

  message(text) {
    const step = this.#add(new Step(this, { kind: 'message', name: text }));
    step.done();
    return step;
  }

  finish(text = 'Done') {
    const step = this.#add(new Step(this, { kind: 'final', name: text }));
    step.done();
    this._announce(text);
    return step;
  }

  error(messageText) {
    const step = this.#add(new Step(this, { kind: 'final', name: messageText }));
    step.fail(messageText);
    return step;
  }

  get(id) {
    return this.#steps.get(id);
  }

  on(event, fn) {
    (this.#listeners[event] ??= new Set()).add(fn);
    return () => this.#listeners[event].delete(fn);
  }

  /** Renders a provider stream. `runTool(name, args)` executes tools for OpenAI and Anthropic streams. */
  async fromEvents(events, { format, runTool } = {}) {
    const map = createMapper(format);
    const pending = [];
    let ending = null;
    for await (const event of events) {
      for (const op of map(event)) {
        if (op.op === 'finish' || op.op === 'error') ending = op;
        else this.#apply(op, runTool, pending);
      }
    }
    await Promise.all(pending);
    if (ending?.op === 'error') this.error(ending.message);
    else if (ending) this.finish();
  }

  clear() {
    this.#steps.clear();
    this.list.replaceChildren();
    this.last = null;
    this.jump.hidden = true;
    this.#stick = true;
  }

  destroy() {
    clearInterval(this.#timer);
    this.#timer = 0;
    cancelAnimationFrame(this.#frame);
    this.el.removeEventListener('scroll', this.onScroll);
    this.el.removeEventListener('click', this.onClick);
    this.list.remove();
    this.jump.remove();
    this.live.remove();
    this.el.classList.remove('trace');
    this.#steps.clear();
  }

  #apply(op, runTool, pending) {
    switch (op.op) {
      case 'reasoning.start':
        this.reasoning({ id: op.id });
        break;
      case 'reasoning.append':
        this.get(op.id)?.append(op.text);
        break;
      case 'reasoning.done':
        this.get(op.id)?.done();
        break;
      case 'tool.start': {
        const decision = groupDecision(this.last);
        if (decision === 'join') this.last.tool(op.name, { id: op.id });
        else if (decision === 'wrap') this.#wrap(this.last).tool(op.name, { id: op.id });
        else this.tool(op.name, { id: op.id });
        break;
      }
      case 'tool.args': {
        const step = this.get(op.id);
        if (!step) break;
        step.args(op.args);
        if (runTool) pending.push(this.#run(step, runTool));
        break;
      }
      case 'tool.done':
        this.get(op.id)?.done({ result: op.result });
        break;
      case 'tool.fail':
        this.get(op.id)?.fail(op.message);
        break;
    }
  }

  async #run(step, runTool) {
    try {
      step.done({ result: await runTool(step.name, step.argsValue) });
    } catch (error) {
      step.fail(error?.message ?? String(error));
    }
  }

  /** Replaces a lone running tool with a parallel group that contains it. */
  #wrap(toolStep) {
    const group = new Step(this, { kind: 'parallel', name: 'Running in parallel' });
    this.list.replaceChild(group.el, toolStep.el);
    this.#steps.delete(toolStep.id);
    this._register(group);
    this.last = group;
    group.startedAt = toolStep.startedAt;
    const lane = group.tool(toolStep.name, { id: toolStep.id, args: toolStep.argsValue });
    lane.startedAt = toolStep.startedAt;
    lane.render();
    return group;
  }

  #add(step) {
    this._register(step);
    this.list.append(step.el);
    this.last = step;
    if (!reduced()) {
      step.el.classList.add('is-entering');
      requestAnimationFrame(() => requestAnimationFrame(() => step.el.classList.remove('is-entering')));
    }
    this._changed();
    return step;
  }

  _register(step) {
    this.#steps.set(step.id, step);
    this.#tick();
  }

  _announce(text) {
    this.live.textContent = text;
  }

  _changed() {
    this.#tick();
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      if (this.#stick) this.el.scrollTop = this.el.scrollHeight;
      else this.jump.hidden = false;
    });
  }

  /** One shared clock for every running step's timer; it stops when nothing is running. */
  #tick() {
    if (this.#timer || ![...this.#steps.values()].some(step => step.state === 'running')) return;
    this.#timer = setInterval(() => {
      let running = false;
      for (const step of this.#steps.values()) {
        if (step.state !== 'running') continue;
        running = true;
        step.el.querySelector('.trace-time').textContent = formatDuration(step.elapsed);
      }
      if (!running) {
        clearInterval(this.#timer);
        this.#timer = 0;
      }
    }, 100);
  }

  #emit(event, ...args) {
    this.#listeners[event]?.forEach(fn => fn(...args));
  }
}
