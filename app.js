import Trace from './trace.js';

const trace = new Trace(document.querySelector('#trace'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let running = false;
let offRetry = () => {};

async function stream(step, text) {
  for (const word of text.split(' ')) {
    step.append(`${word} `);
    await wait(45);
  }
}

async function schedule() {
  const step = trace.tool('posts.schedule', { args: { at: 'Sat 11:00', platform: 'instagram' } });
  await wait(700);
  step.done({ result: 'scheduled' });
  trace.finish('Post scheduled with photo');
}

async function agent({ failImage = false } = {}) {
  const think = trace.reasoning();
  await stream(think, 'The owner wants a weekend offer that reaches students. Check what worked last month, then draft a post with a photo and pick the best time.');
  think.done();

  const summary = trace.tool('analytics.summary', { args: { days: 30 } });
  await wait(900);
  summary.done({ result: { reach: 7200, engagementRate: 0.098, topPlatform: 'instagram' } });

  const group = trace.parallel();
  const caption = group.tool('draft_caption', { args: { tone: 'friendly', offer: '20% off for students' } });
  const image = group.tool('generate_image', { args: { prompt: 'Brunch table by a window, morning light' } });
  const best = group.tool('best_time', { args: { platform: 'instagram' } });
  for (let i = 1; i <= 10; i++) {
    await wait(120);
    image.progress(i / 10);
    if (i === 4) best.done({ result: 'Sat 11:00–13:00' });
    if (i === 7) caption.done({ result: 'Students, treat yourself: 20% off brunch all weekend.' });
  }

  if (failImage) {
    image.fail('Image model timed out after 30s');
    offRetry();
    offRetry = trace.on('retry', async step => {
      offRetry();
      step.retry();
      for (let i = 1; i <= 10; i++) {
        await wait(100);
        step.progress(i / 10);
      }
      step.done({ result: 'brunch-table.jpg' });
      await schedule();
    });
    return;
  }
  image.done({ result: 'brunch-table.jpg' });
  await schedule();
}

async function* anthropicStream() {
  const thinking = 'Reach dipped last week. Compare the two weeks and look at what was posted before suggesting anything.';
  const events = [
    { type: 'message_start', message: { id: 'msg_1' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    ...thinking.split(' ').map(word => ({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `${word} ` } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'analytics_compare', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"weeks": [38, 39]}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'list_posts', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"week": 39}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  for (const event of events) {
    await wait(event.type === 'content_block_delta' ? 40 : 250);
    yield event;
  }
}

const runTool = async name => {
  await wait(name === 'list_posts' ? 1400 : 900);
  return name === 'list_posts' ? { posts: 2, note: 'One post fewer than usual' } : { week38: 9100, week39: 6400 };
};

document.querySelectorAll('[data-run]').forEach(button => {
  button.addEventListener('click', async () => {
    const run = button.dataset.run;
    if (run === 'clear') {
      if (!running) trace.clear();
      return;
    }
    if (running) return;
    running = true;
    offRetry();
    trace.clear();
    try {
      if (run === 'agent') await agent();
      if (run === 'failure') await agent({ failImage: true });
      if (run === 'anthropic') await trace.fromEvents(anthropicStream(), { format: 'anthropic', runTool });
    } finally {
      running = false;
    }
  });
});

running = true;
agent().finally(() => (running = false));
