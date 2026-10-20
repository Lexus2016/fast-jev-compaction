import { describe, expect, it, vi } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  knownSecrets,
  mayUseBuiltin,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
  withCompactionDeadline,
} from '../hooks/fast-jev.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

type HookHandler = (host: any, event: any, next: (event: any) => unknown) => Promise<unknown>;

function registeredHooks(options: Record<string, unknown> = {}): Map<string, HookHandler> {
  const handlers = new Map<string, HookHandler>();
  const on = ((name: string, ...args: unknown[]) => {
    handlers.set(name, args.at(-1) as HookHandler);
    return { catch: (handler: HookHandler) => handlers.set(`catch:${name}`, handler) };
  }) as never;
  register(on, options as never);
  return handlers;
}

function turnComplete(overrides: Record<string, unknown> = {}) {
  return {
    answer: 'done',
    durationMs: 1,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('settings.env values as known secrets', () => {
  const secret = ['plain', 'word', 'secret', 'value'].join('-');
  const opaque = ['Zx9Qw8Er7Ty6Ui5', 'Op4As3Df2Gh1Jk0Lz'].join('');

  it('takes secret-named and token-shaped values, and leaves the rest as context', () => {
    expect(
      knownSecrets({
        MY_SERVICE_TOKEN: secret,
        SOME_SETTING: opaque,
        ANTHROPIC_BASE_URL: 'https://api.example.com',
        CLAUDE_CODE_SUBAGENT_MODEL: 'haiku-latest',
        DB_PASS: 'short',
      }),
    ).toEqual([secret, opaque]);
  });

  it('keeps them out of the Jev request', async () => {
    const bodies: string[] = [];
    const host = {
      env: { get: async (name: string) => (name === 'TYPESAFE_API_KEY' ? 'k'.repeat(16) : undefined) },
      settings: { read: async () => ({ env: { MY_SERVICE_TOKEN: secret, ANTHROPIC_BASE_URL: 'https://api.example.com' } }) },
      http: { fetch: jevFetch(() => 0.1, bodies) },
      ui: { log: () => {}, toast: () => {} },
      clock: { sleep: (_ms: number, { signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))) },
    };
    const messages = transcript();
    messages[3] = call('tool-2', 'Bash', { command: `curl -u bot:${secret} https://api.example.com/run` }, 'FAIL');
    await registeredHooks({ preserveRecentMessages: 1 }).get('session.compact')!(host, { trigger: 'manual', messages }, async () => ({ messages: [] }));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain(secret);
      expect(body).toContain('https://api.example.com');
    }
  });
});

describe('hook config bounds', () => {
  it('replaces a compactAtPercent outside (0, 100] and clamps minReductionRatio', () => {
    for (const compactAtPercent of [0, -5, 150]) expect(resolveHookConfig({ compactAtPercent }).compactAtPercent).toBe(60);
    expect(resolveHookConfig({ compactAtPercent: 100 }).compactAtPercent).toBe(100);
    expect(resolveHookConfig({ minReductionRatio: 2 }).minReductionRatio).toBe(1);
    expect(resolveHookConfig({ minReductionRatio: -1 }).minReductionRatio).toBe(0);
  });
});

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, model: 'jev-latest', compactionTimeoutMs: 60000, logDecisions: false, builtinFallback: 'auto' });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no', logDecisions: true, dropCalls: true, builtinFallback: 'sometimes' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
      compactionTimeoutMs: 60000,
      logDecisions: true,
      dropCalls: true,
      builtinFallback: 'auto',
    });
    expect(resolveHookConfig({ builtinFallback: 'never' }).builtinFallback).toBe('never');
    expect(resolveHookConfig({ builtinFallback: 'always' }).builtinFallback).toBe('always');
  });
});

describe('compaction deadline', () => {
  it('accepts a positive timeout and defaults invalid values', () => {
    expect(resolveHookConfig({ compactionTimeoutMs: 2500 }).compactionTimeoutMs).toBe(2500);
    for (const value of [0, -1, NaN, Infinity, '15000']) {
      expect(resolveHookConfig({ compactionTimeoutMs: value }).compactionTimeoutMs).toBe(60000);
    }
  });

  it('cancels the timer when work succeeds or throws', async () => {
    for (const fails of [false, true]) {
      let timerSignal: AbortSignal | undefined;
      const pending = withCompactionDeadline(async () => {
        if (fails) throw new Error('request failed');
        return 'done';
      }, 1234, (ms, { signal }) => {
        expect(ms).toBe(1234);
        timerSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
      });
      if (fails) await expect(pending).rejects.toThrow('request failed');
      else await expect(pending).resolves.toBe('done');
      expect(timerSignal?.aborted).toBe(true);
    }
  });

  it('aborts the work signal at the deadline and when the dispatch ends', async () => {
    let expire!: () => void;
    let seen: AbortSignal | undefined;
    const atDeadline = withCompactionDeadline(
      (signal) => {
        seen = signal;
        return new Promise<never>(() => {});
      },
      1234,
      () => new Promise((resolve) => { expire = resolve; }),
    );
    const assertion = expect(atDeadline).rejects.toThrow('timed out');
    await Promise.resolve(); // work starts on the next microtask
    expect(seen?.aborted).toBe(false);
    expire();
    await assertion;
    expect(seen?.aborted).toBe(true);

    const dispatch = new AbortController();
    let work: AbortSignal | undefined;
    const done = withCompactionDeadline(
      async (signal) => {
        work = signal;
        dispatch.abort();
        return 'finished';
      },
      1234,
      (_ms, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))),
      dispatch.signal,
    );
    await expect(done).resolves.toBe('finished');
    expect(work?.aborted).toBe(true);
  });

  it('stops the work when the wait itself fails, rejecting or throwing', async () => {
    for (const sleep of [
      () => Promise.reject(new Error('clock gone')),
      () => {
        throw new Error('clock gone');
      },
    ]) {
      const dispatch = new AbortController();
      let work: AbortSignal | undefined;
      const pending = withCompactionDeadline(
        (signal) => {
          work = signal;
          return new Promise<never>(() => {});
        },
        1234,
        sleep,
        dispatch.signal,
      );
      await expect(pending).rejects.toThrow('clock gone');
      expect(work?.aborted).toBe(true);
    }
  });

  it('settles at the deadline even if work is still pending and rejects later', async () => {
    let expire!: () => void;
    let rejectWork!: (error: Error) => void;
    const work = new Promise<never>((_resolve, reject) => { rejectWork = reject; });
    const pending = withCompactionDeadline(() => work, 1234, () => new Promise((resolve) => { expire = resolve; }));
    const assertion = expect(pending).rejects.toThrow('Jev compaction timed out after 1234ms');
    await Promise.resolve(); // the wait starts on the next microtask
    expire();
    await assertion;
    rejectWork(new Error('late request failure'));
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    // The call message keeps its handle: rebuilding it would split a parallel response (#137).
    expect(out[1]).toBe(messages[1]);
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['stub_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-1', undefined, 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(messages[2]?.toolResults?.[0]?.text).toBe(
      `[fast-jev-compaction removed the ${fileA.length}-char output of this call; it was read in full when the call ran; re-run it only if you need the output again and the call only reads; do not repeat a call that wrote, sent or deleted something just to see its output]`,
    );
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 calls stubbed; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(summarize({ ...output, stats: { ...output.stats, requests: 0 } })).toMatch(/; no Jev request$/);
    expect(decisionLog(output)).toBe('t1:Read:stub_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:stub_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:stub_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });
});

describe('registered compaction hooks', () => {
  it('does not send speculative precompute transcripts to Jev', async () => {
    const hooks = registeredHooks();
    const handler = hooks.get('session.compact')!;
    const next = vi.fn(async (event) => event);
    const host = {
      env: { get: vi.fn() },
      settings: { read: vi.fn() },
      http: { fetch: vi.fn() },
      ui: { log: vi.fn(), toast: vi.fn() },
    };
    const event = { trigger: 'precompute', messages: [] };

    const result = await handler(host, event, next);

    expect(result).toMatchObject({ skip: expect.any(String) });
    expect(next).not.toHaveBeenCalled();
    expect(host.http.fetch).not.toHaveBeenCalled();
  });

  it('passes subagent and fork compactions through without calling Jev', async () => {
    const hooks = registeredHooks();
    const handler = hooks.get('session.compact')!;
    const next = vi.fn(async (event) => ({ messages: event.messages }));
    const host = {
      env: { get: vi.fn() },
      settings: { read: vi.fn() },
      http: { fetch: vi.fn() },
      ui: { log: vi.fn(), toast: vi.fn() },
    };
    const events = [
      { trigger: 'manual', agentId: 'agent-1', messages: [] },
      { trigger: 'precompute', agentId: 'fork-1', messages: [] },
    ];

    for (const event of events) await handler(host, event, next);

    expect(next).toHaveBeenNthCalledWith(1, events[0]);
    expect(next).toHaveBeenNthCalledWith(2, events[1]);
    expect(host.http.fetch).not.toHaveBeenCalled();
  });

  it('only auto-compacts completed main-agent answers', async () => {
    const hooks = registeredHooks({ compactAtPercent: 1 });
    const handler = hooks.get('turn.complete')!;
    const usage = vi.fn(async () => ({ context: { percent: 100 } }));
    const compact = vi.fn(async () => ({}));
    const next = vi.fn(async (event) => event);
    const host = { session: { usage, compact }, ui: { log: vi.fn() } };

    for (const event of [
      turnComplete({ reason: 'aborted', isAborted: true }),
      turnComplete({ reason: 'refusal' }),
      turnComplete({ reason: 'error' }),
      turnComplete({ agentId: 'agent-1' }),
    ]) {
      await handler(host, event, next);
    }

    expect(usage).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(4);
  });

  it('auto-compacts a main-session answer when usage reaches the configured threshold', async () => {
    const hooks = registeredHooks({ compactAtPercent: 60 });
    const handler = hooks.get('turn.complete')!;
    const event = turnComplete();
    const usage = vi.fn(async () => ({ context: { percent: 75 } }));
    const compact = vi.fn(async () => ({}));
    const next = vi.fn(async (received) => received);
    const host = { session: { usage, compact }, ui: { log: vi.fn() } };

    const result = await handler(host, event, next);

    expect(usage).toHaveBeenCalledOnce();
    expect(compact).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(event);
    expect(result).toBe(event);
  });

  it('claims the auto-compaction guard before awaiting usage and releases it after completion', async () => {
    const hooks = registeredHooks({ compactAtPercent: 60 });
    const handler = hooks.get('turn.complete')!;
    const firstUsage = deferred<{ context: { percent: number } }>();
    const secondUsage = deferred<{ context: { percent: number } }>();
    const usage = vi.fn().mockReturnValueOnce(firstUsage.promise).mockReturnValueOnce(secondUsage.promise);
    const compact = vi.fn(async () => ({}));
    const next = vi.fn(async (event) => event);
    const host = { session: { usage, compact }, ui: { log: vi.fn() } };

    const first = handler(host, turnComplete(), next);
    const concurrent = handler(host, turnComplete({ turnId: 'turn-2' }), next);
    firstUsage.resolve({ context: { percent: 30 } });
    secondUsage.resolve({ context: { percent: 30 } });
    await Promise.all([first, concurrent]);

    expect(usage).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();

    const afterRelease = handler(host, turnComplete({ turnId: 'turn-3' }), next);
    expect(usage).toHaveBeenCalledTimes(2);
    secondUsage.resolve({ context: { percent: 30 } });
    await afterRelease;
  });
});

// Trigger-aware fallback, adapted from upstream PR #103 (XavierXIEXIN).
describe('built-in summary fallback', () => {
  const CORE = { messages: [message('user', 'built-in summary')] };
  const failing = async () => ({ status: 500, ok: false, text: 'upstream error' });

  async function compactWith(trigger: string, fetch: ReturnType<typeof jevFetch> | typeof failing, options: Record<string, unknown> = {}) {
    const notices: string[] = [];
    const host = {
      env: { get: async (name: string) => (name === 'TYPESAFE_API_KEY' ? 'k' : undefined) },
      settings: { read: async () => ({}) },
      http: { fetch },
      ui: { log: (text: string) => notices.push(text), toast: () => {} },
      clock: { sleep: (_ms: number, { signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))) },
    };
    let delegated = false;
    const out = await registeredHooks({ preserveRecentMessages: 1, ...options }).get('session.compact')!(
      host,
      { trigger, messages: transcript() },
      async () => {
        delegated = true;
        return CORE;
      },
    );
    return { out, delegated, notices };
  }

  it('is only for the engine auto compaction by default', () => {
    expect(mayUseBuiltin('auto', 'auto')).toBe(true);
    for (const trigger of ['manual', 'plugin', 'precompute', undefined]) {
      expect(mayUseBuiltin(trigger, 'auto')).toBe(false);
      expect(mayUseBuiltin(trigger, 'always')).toBe(true);
      expect(mayUseBuiltin(trigger, 'never')).toBe(false);
    }
    expect(mayUseBuiltin('auto', 'never')).toBe(false);
  });

  it('installs a Jev result that clears the minimum on any trigger', async () => {
    for (const trigger of ['manual', 'auto', 'plugin']) {
      const { out, delegated, notices } = await compactWith(trigger, jevFetch(() => 0.1));
      expect(delegated).toBe(false);
      expect(out).toMatchObject({ messages: expect.any(Array) });
      expect(notices).toEqual([expect.stringMatching(/^kept 7\/7 messages, no summary \(\d+% reduction\)$/)]);
    }
  });

  it('adds the counts and the per-call decisions only with logDecisions', async () => {
    const { notices } = await compactWith('manual', jevFetch(() => 0.1), { logDecisions: true });
    expect(notices[0]).toMatch(/^decisions: /);
    expect(notices.at(-1)).toMatch(/^kept 7\/7 messages, no summary \(\d+% reduction; 2 calls stubbed; state ~\d+ tokens/);
  });

  it('leaves a /compact or a plugin request that Jev cannot shrink as it is', async () => {
    for (const trigger of ['manual', 'plugin']) {
      const { out, delegated, notices } = await compactWith(trigger, jevFetch(() => 0.9));
      expect(delegated).toBe(false);
      expect(out).toEqual({
        skip: 'fast-jev-compaction: below 25% minimum: 0% reduction; conversation left unchanged',
      });
      expect(notices.at(-1)).toMatch(/^not compacted, no built-in summary \(below 25% minimum/);
    }
  });

  it('hands an engine auto compaction that Jev cannot shrink to the built-in summary', async () => {
    const { out, delegated, notices } = await compactWith('auto', jevFetch(() => 0.9));
    expect(delegated).toBe(true);
    expect(out).toBe(CORE);
    expect(notices.at(-1)).toMatch(/^fallback to built-in summary \(below 25% minimum/);
  });

  it('skips on a Jev failure unless the engine itself is compacting', async () => {
    for (const trigger of ['manual', 'plugin']) {
      const { out, delegated } = await compactWith(trigger, failing);
      expect(delegated).toBe(false);
      expect(out).toEqual({ skip: expect.stringMatching(/500.*; conversation left unchanged$/) });
    }
    const { out, delegated } = await compactWith('auto', failing);
    expect(delegated).toBe(true);
    expect(out).toBe(CORE);
  });

  it('keeps the skip notice to one short line', async () => {
    const html = async () => ({ status: 403, ok: false, text: `<!DOCTYPE html>${'x'.repeat(2000)}` });
    const { out } = await compactWith('manual', html);
    expect(out).toEqual({ skip: expect.any(String) });
    expect(JSON.stringify(out).length).toBeLessThan(320);
  });

  it('follows builtinFallback always and never', async () => {
    expect((await compactWith('manual', jevFetch(() => 0.9), { builtinFallback: 'always' })).out).toBe(CORE);
    expect((await compactWith('auto', jevFetch(() => 0.9), { builtinFallback: 'never' })).out).toEqual({
      skip: expect.stringMatching(/conversation left unchanged$/),
    });
  });
});

describe('turn.complete request after a skip', () => {
  function driver() {
    const handler = registeredHooks().get('turn.complete')!;
    const state: { percent: number; answer: { skip?: string }; requested: number[] } = {
      percent: 0,
      answer: { skip: 'nothing to prune' },
      requested: [],
    };
    const host = {
      session: {
        usage: async () => ({ context: { percent: state.percent } }),
        compact: async () => {
          state.requested.push(state.percent);
          return state.answer;
        },
      },
      ui: { log: () => {} },
    };
    const turn = async (percent: number) => {
      state.percent = percent;
      await handler(host, turnComplete(), async () => ({}));
    };
    return { state, turn };
  }

  it('asks again only once the context has grown by ten points', async () => {
    const { state, turn } = driver();
    for (const percent of [50, 61, 65, 70, 71]) await turn(percent);
    state.answer = {};
    for (const percent of [81, 62]) await turn(percent);
    expect(state.requested).toEqual([61, 71, 81, 62]);
  });

  it('forgets the wait once the context drops below compactAtPercent', async () => {
    const { state, turn } = driver();
    for (const percent of [61, 65, 30, 61]) await turn(percent);
    expect(state.requested).toEqual([61, 61]);
  });
});

describe('session.compact catch handler', () => {
  function caught(trigger: string, kind: 'throw' | 'timeout', options: Record<string, unknown> = {}) {
    const handler = registeredHooks(options).get('catch:session.compact')!;
    const logs: string[] = [];
    const next = Object.assign(vi.fn(async () => ({ messages: [] })), {
      error: { kind, message: 'boom', budget: 30_000 },
      called: false,
    });
    return { result: handler({ ui: { log: (t: string) => logs.push(t) } }, { trigger, messages: [] }, next), next, logs };
  }

  it('applies the fallback policy when the hook throws or overruns', async () => {
    const manual = caught('manual', 'timeout');
    expect(await manual.result).toEqual({ skip: 'fast-jev-compaction: hook timeout: boom; conversation left unchanged' });
    expect(manual.next).not.toHaveBeenCalled();
    expect(manual.logs).toEqual(['not compacted, no built-in summary (hook timeout: boom)']);

    const auto = caught('auto', 'throw');
    expect(await auto.result).toEqual({ messages: [] });
    expect(auto.next).toHaveBeenCalledOnce();

    expect(await caught('manual', 'throw', { builtinFallback: 'always' }).result).toEqual({ messages: [] });
  });
});

describe('auto compaction when stubs do not free enough', () => {
  const content = 'line of a written file\n'.repeat(200);
  const heavy = (): SessionMessage[] => [
    message('user', 'Write it.', { handle: 'h-0' }),
    call('w-1', 'Write', { file_path: 'a.txt', content }, 'ok'),
    result('w-1', 'File created successfully at: a.txt'),
    message('assistant', 'Written.', { handle: 'h-3' }),
    message('user', 'next', { handle: 'h-4' }),
  ];
  async function run(trigger: string) {
    const notices: string[] = [];
    const host = {
      env: { get: async (name: string) => (name === 'TYPESAFE_API_KEY' ? 'k' : undefined) },
      settings: { read: async () => ({}) },
      http: { fetch: jevFetch(() => 0.1) },
      ui: { log: (text: string) => notices.push(text), toast: () => {} },
      clock: { sleep: (_ms: number, { signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')))) },
    };
    let delegated = false;
    const out = await registeredHooks({ preserveRecentMessages: 2 }).get('session.compact')!(
      host,
      { trigger, messages: heavy() },
      async () => {
        delegated = true;
        return { messages: [] };
      },
    );
    return { out, delegated, notices };
  }

  it('removes the calls Jev rated unneeded before falling back to the summary', async () => {
    const { out, delegated, notices } = await run('auto');
    expect(delegated).toBe(false);
    expect(out).toMatchObject({ messages: expect.any(Array) });
    expect(notices.at(-1)).toMatch(/^kept 3\/5 messages, no summary; stubs alone freed \d+%, so 1 unneeded calls were removed/);
  });

  it('keeps a /compact verbatim instead: stubs only, skipped below the minimum', async () => {
    const { out, delegated } = await run('manual');
    expect(delegated).toBe(false);
    expect(out).toEqual({ skip: expect.stringMatching(/^fast-jev-compaction: below 25% minimum/) });
  });
});

describe('what reaches Jev', () => {
  it('carries no password a Bash call put in its command', async () => {
    const password = ['hunter2', 'hunter2'].join('');
    const messages = [
      message('user', 'Connect to the database.', { handle: 'h-0' }),
      call('db-1', 'Bash', { command: `export DB_PASSWORD="${password}" && psql -c 'select 1'` }, ' ?column? \n 1'),
      result('db-1', ' ?column? \n 1'),
      message('assistant', 'Connected.', { handle: 'h-3' }),
      message('user', 'next', { handle: 'h-4' }),
    ];
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k'.repeat(16) };
    await compactSession(messages, config, jevFetch(() => 0.9, bodies));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain(password);
  });
});
