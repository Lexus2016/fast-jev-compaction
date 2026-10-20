import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  batchCalls,
  buildJevRequest,
  collectToolCalls,
  compact,
  compactMessages,
  decideCall,
  dropStubbedCalls,
  estimateTokens,
  fitState,
  HistoryTooLargeError,
  JevClient,
  noulAnswer,
  parseJevResponse,
  reductionRatio,
  resolveOptions,
  sliceSurrogateSafe,
  truncate,
  type HistoryToolCall,
  type JevAnswer,
  type JevAsker,
  type JevQuestions,
  type Message,
  type ToolCall,
} from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

const fileA = 'export const a = 1;\n'.repeat(50);
const fileB = 'export const b = 2;\n'.repeat(50);

function transcript(): Message[] {
  return [
    message('user', 'Never edit anything under src/generated. Fix the failing test.'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    message('assistant', 'a.ts looks fine; checking b.ts'),
    call('tool-2', 'Read', { file_path: 'src/b.ts' }, fileB),
    result('tool-2', fileB),
    call('tool-3', 'Bash', { command: 'npm test' }, 'FAIL b.test.ts'),
    result('tool-3', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'The failure is in b.test.ts; fixing now.'),
    message('user', 'go ahead'),
  ];
}

type Seen = { state: unknown; questions: string[] };

function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
        ),
      };
    },
  };
}

const fit = {
  maxStateTokens: 25_000,
  preserveRecentMessages: 0,
  goal: 'fix the test',
};

describe('options', () => {
  it('fills in defaults and ignores non-finite values', () => {
    expect(resolveOptions()).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 25_000,
      maxRequestTokens: 30_000,
      truncateHeadChars: 300,
    });
    expect(resolveOptions({
      keepThreshold: Number.NaN,
      preserveRecentMessages: 2.7,
      truncateHeadChars: -1.2,
    })).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
    });
  });

  it('keeps keepThreshold a probability', () => {
    expect(resolveOptions({ keepThreshold: 5 }).keepThreshold).toBe(1);
    expect(resolveOptions({ keepThreshold: -1 }).keepThreshold).toBe(0);
  });
});

describe('token estimate', () => {
  it('charges words, digits and symbols separately and never undercounts JSON badly', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('12345678')).toBe(4);
    const json = JSON.stringify({ file_path: '/Users/x/src/a.ts', old_string: 'a = 1;', n: 42 });
    expect(estimateTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
  });

  it('charges dense runs (hex, UUIDs, base64) at least ~3 chars per token (#81)', () => {
    const blob = 'c3RhcnQgdGhlIGNvbXBhY3Rpb24gZnJvbSB0aGUgaG9vayBhbmQga2VlcCBpdCBydW5uaW5n';
    expect(estimateTokens(blob)).toBeGreaterThanOrEqual(Math.ceil(blob.length / 3));
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(estimateTokens(uuid)).toBeGreaterThanOrEqual(Math.ceil(uuid.replace(/-/g, '').length / 3));
    const sha = 'd41d8cd98f00b204e9800998ecf8427e';
    expect(estimateTokens(sha)).toBeGreaterThanOrEqual(Math.ceil(sha.length / 3));
    // prose and ordinary identifiers keep the word rate
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('estimateTokens')).toBe(3);
    expect(estimateTokens('12345678')).toBe(4);
    expect(estimateTokens('utf8 base64')).toBeLessThan(6);
    // repeated filler compresses well and stays on the word rate
    expect(estimateTokens('x'.repeat(200))).toBe(34);
  });
});

describe('tool call collection', () => {
  it('pairs each tool call with its result and pins recent ones', () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned])).toEqual([
      ['t1', 'Read', 1, 2, false],
      ['t2', 'Read', 4, 5, false],
      ['t3', 'Bash', 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
    expect(calls[0]?.resultChars).toBe(fileA.length);
  });

  it('ignores calls without a result', () => {
    expect(collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, '')], 0)).toHaveLength(0);
  });
});

describe('state fitting', () => {
  it('sends the whole history with tool results replaced by a note', () => {
    const messages = transcript();
    const { state, stage } = fitState(messages, collectToolCalls(messages, 0), fit);
    expect(stage).toBe('full');
    const json = JSON.stringify(state);
    expect(json).not.toContain('export const a = 1;');
    expect(json).toContain('Never edit anything under src/generated');
    expect(json).toContain('go ahead');
    expect(state.history.map((entry) => entry.i)).toEqual([0, 1, 3, 4, 6, 8, 9]);
    expect(state.history[1]?.tool_calls?.[0]).toMatchObject({
      id: 't1',
      tool: 'Read',
      result: `ok, ${fileA.length} chars (omitted)`,
    });
    expect((state.history[4]?.tool_calls?.[0] as HistoryToolCall).result).toMatch(/^error, /);
  });

  it('defaults the goal to the latest user prompts', () => {
    const { state } = fitState(transcript(), [], { ...fit, goal: '' });
    expect(state.goal).toContain('Fix the failing test');
    expect(state.goal).toContain('go ahead');
  });

  it('truncates tool inputs before touching message text', () => {
    const messages = [
      message('user', 'start'),
      call('w', 'Write', { file_path: 'x.ts', content: 'x'.repeat(5000) }, 'ok'),
      result('w', 'ok'),
      message('assistant', 'written'),
    ];
    const { state, stage, tokens } = fitState(messages, collectToolCalls(messages, 0), {
      ...fit,
      maxStateTokens: 300,
    });
    expect(stage).toBe('inputs<=200');
    expect(tokens).toBeLessThanOrEqual(300);
    expect(state.history[0]?.text).toBe('start');
    expect((state.history[1]?.tool_calls?.[0] as HistoryToolCall).input.length).toBeLessThanOrEqual(200);
  });

  it('shrinks old tool calls to one line each when nothing else is left to cut', () => {
    const messages = [message('user', 'start')];
    for (let i = 0; i < 40; i += 1) {
      messages.push(call(`c${i}`, 'Read', { file_path: `/repo/src/module-${i}.ts` }, 'x'), result(`c${i}`, 'x'));
    }
    messages.push(message('assistant', 'done'));
    const calls = collectToolCalls(messages, 1);
    const full = fitState(messages, calls, { ...fit, preserveRecentMessages: 1 });
    const compacted = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.8),
    });
    expect(compacted.stage).toBe('old calls compacted');
    expect(compacted.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.8));
    expect(compacted.tokens).toBeGreaterThanOrEqual(estimateTokens(JSON.stringify(compacted.state)));
    expect(compacted.state.history[1]?.tool_calls?.[0]).toBe(
      't1 Read file_path=/repo/src/module-0.ts → ok 1ch',
    );
    expect(compacted.state.history.at(-1)?.text).toBe('done');

    const merged = fitState(messages, calls, {
      ...fit,
      preserveRecentMessages: 1,
      maxStateTokens: Math.floor(full.tokens * 0.45),
    });
    expect(merged.stage).toBe('old calls merged');
    expect(merged.tokens).toBeLessThanOrEqual(Math.floor(full.tokens * 0.45));
    expect(merged.state.history).toHaveLength(3);
    expect(merged.state.history[1]?.tool_calls).toHaveLength(40);
    expect(merged.state.history[1]?.tool_calls?.[39]).toMatch(/^t40 Read /);
    expect(merged.state.history[0]?.text).toBe('start');
    expect(merged.state.history[2]?.text).toBe('done');
  });

  it('abridges long texts oldest-first and collapses old messages last', () => {
    const long = (n: number) => `${n} ` + 'lorem ipsum '.repeat(300);
    const messages = [
      message('user', long(0)),
      message('assistant', long(1)),
      message('user', long(2)),
      message('assistant', long(3)),
      message('user', 'latest'),
    ];
    const abridged = fitState(messages, [], { ...fit, maxStateTokens: 1800, preserveRecentMessages: 1 });
    expect(abridged.stage).toBe('texts abridged');
    expect(abridged.tokens).toBeLessThanOrEqual(1800);
    expect(abridged.state.history[1]?.text).toContain('chars omitted');
    expect(abridged.state.history[0]?.text).toBe(long(0));
    expect(abridged.state.history[4]?.text).toBe('latest');

    const collapsed = fitState(messages, [], { ...fit, maxStateTokens: 420, preserveRecentMessages: 1 });
    expect(collapsed.stage).toBe('old messages collapsed');
    expect(collapsed.tokens).toBeLessThanOrEqual(420);
    expect(collapsed.state.history[1]?.text).toMatch(/^\[… \d+ chars omitted …\]$/);
    expect(collapsed.state.history[0]?.text).toContain('lorem');
    expect(collapsed.state.history[4]?.text).toBe('latest');
  });

  it('throws when the history cannot be fitted', () => {
    const messages = [message('user', 'a'.repeat(2000)), message('assistant', 'b')];
    expect(() => fitState(messages, [], { ...fit, maxStateTokens: 50 })).toThrow(/too large/);
  });
});

describe('question batching', () => {
  const calls: ToolCall[] = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i + 1}`,
    tool_use_id: `tool-${i + 1}`,
    tool: 'Read',
    input: {},
    callIndex: i * 2 + 1,
    resultIndex: i * 2 + 2,
    resultChars: 100,
    isError: false,
    pinned: false,
  }));
  const options = { maxRequestTokens: 30_000 };

  it('puts everything in one request when it fits', () => {
    expect(batchCalls(calls, 1000, options)).toHaveLength(1);
  });

  it('splits questions across requests when the state leaves little room', () => {
    const batches = batchCalls(calls, 29_600, options);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((c) => c.id)).toEqual(calls.map((c) => c.id));
  });

  it('throws when a single question does not fit', () => {
    expect(() => batchCalls(calls, 29_990, options)).toThrow(/no room/);
  });

  it('never asks more questions in one request than Jev accepts', () => {
    const many: ToolCall[] = Array.from({ length: 200 }, (_, i) => ({
      ...calls[0]!,
      id: `t${i + 1}`,
      tool_use_id: `tool-${i + 1}`,
    }));
    const batches = batchCalls(many, 1000, options);
    expect(batches.flat()).toHaveLength(200);
    for (const batch of batches) expect(batch.length * 2).toBeLessThanOrEqual(128);
  });
});

describe('decisions', () => {
  const options = { keepThreshold: 0.5 };
  const unpinned = { id: 't1', tool: 'Read', pinned: false };

  it('keeps, drops the result, or stubs the call based on the keep probabilities', () => {
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.7 }, options).action).toBe('keep');
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, options).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, options)).toMatchObject({
      action: 'stub_call',
      reason: 'call_stubbed',
    });
    expect(
      decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, { ...options, dropCalls: true }).action,
    ).toBe('drop_call');
    expect(decideCall({ ...unpinned, pinned: true }, { keepCall: 0, keepResult: 0 }, options)).toMatchObject({
      action: 'keep',
      reason: 'pinned',
    });
  });

  it('removes dropped calls and truncates dropped results', () => {
    const messages = transcript();
    messages[4]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[5]!.toolResults![0]!.text = 'x'.repeat(2000);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, { ...options, dropCalls: true }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ];
    const kept = applyDecisions(messages, decisions, calls, 300);

    expect(kept.map((m) => m.text || m.toolUses[0]?.tool_use_id || m.toolResults?.[0]?.tool_use_id)).toEqual([
      'Never edit anything under src/generated. Fix the failing test.',
      'a.ts looks fine; checking b.ts',
      'tool-2',
      'tool-2',
      'tool-3',
      'tool-3',
      'The failure is in b.test.ts; fixing now.',
      'go ahead',
    ]);
    expect(kept[0]).toBe(messages[0]);
    // The call message stays the engine's own: only the result message is rebuilt (#137).
    expect(kept[2]).toBe(messages[4]);
    expect(kept[3]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(kept[3]).not.toBe(messages[5]);
    expect(kept[4]).toBe(messages[6]);
    expect(kept[5]?.toolResults?.[0]?.text).toContain('expected 2 to be 3');

    const shortMessages = transcript();
    shortMessages[4]!.toolUses[0]!.text = 'y'.repeat(100);
    shortMessages[5]!.toolResults![0]!.text = 'y'.repeat(100);
    const shortKept = applyDecisions(shortMessages, decisions, calls, 300);
    expect(shortKept[2]).toBe(shortMessages[4]);
    expect(shortKept[3]).toBe(shortMessages[5]);
  });

  it('honours truncateHeadChars, including a zero head', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })];
    const original = messages[2]!.toolResults![0]!.text;
    const total = original.length;

    const kept = applyDecisions(messages, decisions, calls, 50);
    expect(kept[2]?.toolResults?.[0]?.text).toBe(
      `${original.slice(0, 50)}\n[fast-jev-compaction truncated ${total - 50} chars of this tool result; it was read in full when the call ran; re-run it only if you need the output again and the call only reads; do not repeat a call that wrote, sent or deleted something just to see its output]`,
    );
    expect(kept[1]).toBe(messages[1]);

    const noHead = applyDecisions(messages, decisions, calls, 0);
    expect(noHead[2]?.toolResults?.[0]?.text).toBe(
      `[fast-jev-compaction truncated ${total} chars of this tool result; it was read in full when the call ran; re-run it only if you need the output again and the call only reads; do not repeat a call that wrote, sent or deleted something just to see its output]`,
    );
  });

  it('never makes a result longer, and keeps it verbatim unless 100 chars are freed', () => {
    const rewritten = (text: string, keepCall: number): string | undefined => {
      const messages = transcript();
      messages[2]!.toolResults![0]!.text = text;
      const calls = collectToolCalls(messages, 0);
      const decisions = [decideCall(calls[0]!, { keepCall, keepResult: 0.1 }, { keepThreshold: 0.5 })];
      return applyDecisions(messages, decisions, calls, 300)[2]?.toolResults?.[0]?.text;
    };
    for (let length = 300; length <= 1200; length += 7) {
      const text = 'r'.repeat(length);
      for (const keepCall of [0.9, 0.1]) {
        const out = rewritten(text, keepCall)!;
        expect(out === text || text.length - out.length >= 100).toBe(true);
      }
    }
    expect(rewritten('r'.repeat(500), 0.9)).toBe('r'.repeat(500));
  });

  it('never cuts the head of a dropped result inside a surrogate pair', () => {
    const emoji = '\u{1F600}';
    const note = (omitted: number): string =>
      `[fast-jev-compaction truncated ${omitted} chars of this tool result; it was read in full when the call ran; re-run it only if you need the output again and the call only reads; do not repeat a call that wrote, sent or deleted something just to see its output]`;
    const truncated = (text: string): string | undefined => {
      const messages = transcript();
      messages[1]!.toolUses[0]!.text = text;
      messages[2]!.toolResults![0]!.text = text;
      const calls = collectToolCalls(messages, 0);
      const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })];
      const kept = applyDecisions(messages, decisions, calls, 300);
      expect(kept[1]).toBe(messages[1]);
      return kept[2]?.toolResults?.[0]?.text;
    };

    const straddling = `${'x'.repeat(299)}${emoji.repeat(200)}`;
    expect(truncated(straddling)).toBe(`${'x'.repeat(299)}\n${note(straddling.length - 299)}`);

    const aligned = `${'x'.repeat(298)}${emoji.repeat(200)}`;
    expect(truncated(aligned)).toBe(`${'x'.repeat(298)}${emoji}\n${note(aligned.length - 300)}`);
  });
});

describe('stubbed calls and parallel responses', () => {
  const options = { keepThreshold: 0.5 };
  const stub = { keepCall: 0.1, keepResult: 0.1 };
  const note = (chars: number): string =>
    `[fast-jev-compaction removed the ${chars}-char output of this call; it was read in full when the call ran; re-run it only if you need the output again and the call only reads; do not repeat a call that wrote, sent or deleted something just to see its output]`;

  it('keeps a stubbed call whole, however long its input, and replaces its output with a note', () => {
    const script = `cat <<'EOF' > build.sh\n${'echo step\n'.repeat(80)}EOF`;
    const messages = [
      message('user', 'Build it.'),
      call('tool-1', 'Bash', { command: script, description: 'write the build script' }, 'ok'),
      result('tool-1', 'written\n'.repeat(100)),
      message('assistant', 'Done.'),
    ];
    const calls = collectToolCalls(messages, 0);
    const kept = applyDecisions(messages, [decideCall(calls[0]!, stub, options)], calls, 300);
    expect(kept).toHaveLength(4);
    expect(kept[1]).toBe(messages[1]);
    expect(kept[2]!.toolResults![0]!.text).toBe(note(800));
    expect(kept[3]).toBe(messages[3]);
  });

  it('keeps an output no longer than a truncated head verbatim, and replaces a longer one', () => {
    const at = (chars: number) => {
      const out = 'r'.repeat(chars);
      const messages = [message('user', 'go'), call('tool-1', 'Bash', { command: 'run' }, out), result('tool-1', out)];
      const calls = collectToolCalls(messages, 0);
      return applyDecisions(messages, [decideCall(calls[0]!, stub, options)], calls, 300)[2]!.toolResults![0]!.text;
    };
    expect(at(420)).toBe('r'.repeat(420));
    expect(at(421)).toBe(note(421));
    expect(at(150)).toBe('r'.repeat(150));
  });

  it('leaves a short output a stub would replace as it is', () => {
    const messages = [
      message('user', 'Count it.'),
      call('tool-1', 'Bash', { command: 'wc -c f' }, '  42'),
      result('tool-1', '  42'),
    ];
    const calls = collectToolCalls(messages, 0);
    const kept = applyDecisions(messages, [decideCall(calls[0]!, stub, options)], calls, 300);
    kept.forEach((m, i) => expect(m).toBe(messages[i]));
  });

  it('keeps a stubbed call whole when its input is already short, rewriting only the result', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const kept = applyDecisions(messages, [decideCall(calls[0]!, stub, options)], calls, 300);
    expect(kept[1]).toBe(messages[1]);
    expect(kept[2]!.toolResults![0]!.text).toBe(note(fileA.length));
  });

  it('keeps the head of an error a stub replaces', () => {
    const messages = transcript();
    messages[7]!.toolResults![0]!.text = `Error: ENOENT src/missing.ts\n${'  at frame\n'.repeat(80)}`;
    const calls = collectToolCalls(messages, 0);
    const kept = applyDecisions(messages, [decideCall(calls[2]!, stub, options)], calls, 40);
    expect(kept[7]!.toolResults![0]!.text).toMatch(
      /^Error: ENOENT src\/missing\.ts\n.*\n\[fast-jev-compaction truncated \d+ chars of this tool result \(error\)/s,
    );
  });

  it('never rebuilds a call message of a parallel response, stub or dropped result', () => {
    const long = 'z'.repeat(2000);
    const messages = [
      message('user', 'Read all three.'),
      call('p-1', 'Bash', { command: long }, long),
      call('p-2', 'Read', { file_path: 'b.ts' }, long),
      call('p-3', 'Read', { file_path: 'c.ts' }, long),
      result('p-1', long),
      result('p-2', long),
      result('p-3', long),
      message('assistant', 'Read them.'),
    ];
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, stub, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ];
    const kept = applyDecisions(messages, decisions, calls, 300);
    expect(kept).toHaveLength(messages.length);
    for (const index of [1, 2, 3]) expect(kept[index]).toBe(messages[index]);
    expect(kept[4]!.toolResults![0]!.text).toBe(note(2000));
    expect(kept[5]!.toolResults![0]!.text).toMatch(/\[fast-jev-compaction truncated 1700 chars/);
    expect(kept[6]).toBe(messages[6]);
  });
});

describe('compact', () => {
  it('resends the full state with every batch and merges the answers', async () => {
    const seen: Seen[] = [];
    const messages = transcript();
    const stateTokens = fitState(messages, collectToolCalls(messages, 1), {
      ...fit,
      goal: '',
      preserveRecentMessages: 1,
    }).tokens;
    const output = await compact(
      messages,
      fakeJev((name) => (name.startsWith('call_') ? 0.9 : 0.1), seen),
      { preserveRecentMessages: 1, maxRequestTokens: stateTokens + 150 },
    );

    expect(output.stats.requests).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.flatMap((r) => r.questions).sort()).toEqual([
      'call_t1',
      'call_t2',
      'call_t3',
      'result_t1',
      'result_t2',
      'result_t3',
    ]);
    expect(new Set(seen.map((r) => JSON.stringify(r.state))).size).toBe(1);
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_result', 'drop_result', 'drop_result']);
    expect(output.messages).toHaveLength(messages.length);
    expect(output.stats).toMatchObject({ resultsDropped: 3, kept: 0, callsDropped: 0, pinned: 0 });
    expect(reductionRatio(output)).toBeGreaterThan(0);
  });

  it('keeps everything without calling Jev when no tool call is a candidate', async () => {
    const seen: Seen[] = [];
    const messages = [message('user', 'hello'), message('assistant', 'hi')];
    const output = await compact(messages, fakeJev(() => 0, seen));
    expect(seen).toHaveLength(0);
    expect(output.stats).toMatchObject({ requests: 0, stateStage: '', calls: 0 });
    expect(output.messages).toEqual(messages);
  });

  it('reports a tiny reduction when Jev wants everything kept', async () => {
    const output = await compact(transcript(), fakeJev(() => 0.95), { preserveRecentMessages: 1 });
    expect(output.decisions.every((d) => d.action === 'keep')).toBe(true);
    expect(reductionRatio(output)).toBe(0);
  });

  it('rejects malformed answers', async () => {
    const broken: JevAsker = {
      ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }),
    };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 1 })).rejects.toThrow(
      /Invalid Jev answer/,
    );
  });
});

describe('HTTP client', () => {
  it('builds a System One request', () => {
    const request = buildJevRequest({ apiKey: 'k' }, { a: 1 }, {
      q: { type: 'noul', instructions: 'x' },
    });
    expect(request.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(request.body)).toEqual({
      model: 'jev-latest',
      state: { a: 1 },
      questions: { q: { type: 'noul', instructions: 'x' } },
    });
  });

  it('rejects failed and malformed responses', () => {
    expect(() => parseJevResponse(500, false, 'boom')).toThrow(/500/);
    expect(() => parseJevResponse(200, true, 'not json')).toThrow(/malformed/);
    expect(() => parseJevResponse(200, true, '{}')).toThrow(/missing answers/);
    expect(parseJevResponse(200, true, '{"answers":{}}')).toEqual({ answers: {} });
  });

  it('fails an answer outside [0, 1] and clamps rounding noise', () => {
    const noul = (value: unknown): number =>
      noulAnswer(parseJevResponse(200, true, JSON.stringify({ answers: { q: { noul: value } } })).answers, 'q');
    expect(() => noul(-1)).toThrow(/out of range/);
    expect(() => noul(2)).toThrow(/out of range/);
    expect(() => noul('0.4')).toThrow(/Invalid Jev answer/);
    expect(noul(1 + 1e-9)).toBe(1);
    expect(noul(-1e-9)).toBe(0);
    expect(noul(0.37)).toBe(0.37);
  });

  it('asks over fetch and refuses to run without a key', async () => {
    const bodies: string[] = [];
    const client = new JevClient({
      apiKey: 'k',
      model: 'jev-test',
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ answers: { q: { noul: 0.4 } } }), { status: 200 });
      }) as typeof fetch,
    });
    const response = await client.ask('state', { q: { type: 'noul', instructions: 'x' } });
    expect(response.answers.q).toEqual({ noul: 0.4 });
    expect(JSON.parse(bodies[0]!).model).toBe('jev-test');

    const keyless = new JevClient({ apiKey: '' });
    await expect(keyless.ask('s', {})).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactMessages(transcript(), { apiKey: '', preserveRecentMessages: 1 }),
    ).rejects.toThrow(/TYPESAFE_API_KEY/);
  });
});

describe('surrogate-safe cuts (#128)', () => {
  // A lone surrogate: a high surrogate not followed by a low one, or a low
  // surrogate not preceded by a high one (the check from the issue report).
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('truncate steps the head cut back instead of orphaning a high surrogate', () => {
    // '🔥' is U+1F525 = D83D DE25; a UTF-16 cut at index 2 would split it.
    const out = truncate('a🔥b', 3);
    expect(out).toBe('a…');
    expect(lone.test(out)).toBe(false);
  });

  it('truncate leaves text alone when no cut is needed', () => {
    expect(truncate('a🔥b', 4)).toBe('a🔥b');
  });

  it('sliceSurrogateSafe drops the pair on head cuts instead of orphaning it', () => {
    const text = `${'x'.repeat(399)}🔥`;
    const head = sliceSurrogateSafe(text, 0, 400);
    expect(head).toBe('x'.repeat(399));
    expect(lone.test(head)).toBe(false);
  });

  it('sliceSurrogateSafe keeps the pair whole on tail cuts', () => {
    // A 150-char tail of this string would start on the low surrogate of 🔥.
    const text = `${'x'.repeat(149)}🔥${'x'.repeat(149)}`;
    const tail = sliceSurrogateSafe(text, text.length - 150, text.length);
    expect(tail).toBe(`🔥${'x'.repeat(149)}`);
    expect(lone.test(tail)).toBe(false);
  });

  it('abridged states serialise with no lone surrogates', () => {
    // The head cut at 400 would split the first 🔥; the 150-char tail would
    // start on the low surrogate of the second one.
    const text = `${'x'.repeat(399)}🔥${'y'.repeat(449)}🔥${'y'.repeat(149)}`;
    const fitted = fitState([message('user', text)], [], {
      maxStateTokens: 300,
      preserveRecentMessages: 1,
      goal: 'g',
    });
    expect(fitted.stage).toBe('texts abridged');
    const entry = fitted.state.history[0]?.text ?? '';
    expect(entry).toContain('chars omitted');
    expect(lone.test(JSON.stringify(fitted.state))).toBe(false);
  });

  it('buildJevRequest replaces lone-surrogate escapes instead of sending them', () => {
    const request = buildJevRequest({ apiKey: 'k' }, { evil: '\uD83D' } as never, {
      q: { type: 'noul', instructions: 'x' },
    });
    // The lone surrogate must not reach the wire as \ud83d (the API 400s on it).
    expect(request.body).not.toMatch(/\\ud83d/i);
    expect(JSON.parse(request.body).state).toEqual({ evil: '�' });
    // A tool that printed the six characters `\ud800` keeps them: only real surrogates are replaced.
    const literal = buildJevRequest({ apiKey: 'k' }, { text: 'escape \\ud800 and \\udc00' }, {
      q: { type: 'noul', instructions: 'x' },
    });
    expect(JSON.parse(literal.body).state).toEqual({ text: 'escape \\ud800 and \\udc00' });
    const lowFirst = buildJevRequest({ apiKey: 'k' }, { t: 'a\uDC00b😀c\uD800' }, {
      q: { type: 'noul', instructions: 'x' },
    });
    expect(JSON.parse(lowFirst.body).state).toEqual({ t: 'a�b😀c�' });
    // A well-formed pair still round-trips untouched.
    const paired = buildJevRequest({ apiKey: 'k' }, { ok: '🔥' } as never, {
      q: { type: 'noul', instructions: 'x' },
    });
    expect(JSON.parse(paired.body).state).toEqual({ ok: '🔥' });
  });
});

describe('windowed states when the history does not fit', () => {
  // Ported with the windowing from deadczarvc (Mikhail Nemerov), upstream PR #119.
  function long(n: number): Message[] {
    const out: Message[] = [message('user', 'Fix the failing build; never touch src/generated.')];
    for (let i = 0; i < n; i++) {
      out.push(message('assistant', `Step ${i}: ${'checking the next module and its callers '.repeat(6)}`));
      out.push(call(`w${i}`, 'Bash', { command: `npm test -- module${i}` }, ''));
      out.push(result(`w${i}`, `module${i}: 3 passed, 1 failed (exit code 1)\n${'x'.repeat(400)}`));
    }
    out.push(message('user', 'go on'));
    return out;
  }
  const options = { maxStateTokens: 3_000, maxRequestTokens: 6_000, preserveRecentMessages: 2 };

  it('splits into windows that each fit, and every candidate is asked', async () => {
    const messages = long(400);
    const calls = collectToolCalls(messages, 2);
    expect(() => fitState(messages, calls, resolveOptions(options))).toThrow(HistoryTooLargeError);
    const seen: Seen[] = [];
    const out = await compact(messages, fakeJev(() => 0.1, seen), options);
    expect(out.stats.stateStage).toMatch(/^windows:\d+$/);
    expect(out.stats.stateTokens).toBeLessThanOrEqual(options.maxStateTokens);
    const asked = new Set(seen.flatMap((s) => s.questions).filter((q) => q.startsWith('call_')));
    expect(asked.size).toBe(calls.filter((c) => !c.pinned).length);
    expect(out.stats.requests).toBe(seen.length);
  });

  it('keeps an unasked call even with a threshold above one', async () => {
    const out = await compact(long(1), fakeJev(() => 0), { maxStateTokens: 1, keepThreshold: 1.1, preserveRecentMessages: 0 });
    expect(out.stats.stateStage).toMatch(/unasked:1/);
    expect(out.decisions.map((d) => [d.action, d.reason])).toEqual([['keep', 'kept']]);
    expect(out.stats.callsStubbed).toBe(0);
  });

  it('keeps a call that no window can fit, instead of throwing', async () => {
    const messages = long(5);
    const seen: Seen[] = [];
    const out = await compact(messages, fakeJev(() => 0.1, seen), {
      ...options,
      maxStateTokens: 200,
      goal: 'g'.repeat(5_000),
    });
    expect(seen.length).toBe(0);
    expect(out.stats.stateStage).toMatch(/unasked:\d+/);
    expect(out.decisions.every((d) => d.action === 'keep')).toBe(true);
    out.messages.forEach((m, i) => expect(m).toBe(messages[i]));
  });

  it('keeps at most four Jev requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    let requests = 0;
    const asker: JevAsker = {
      async ask(_state, questions) {
        requests += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        const keep: JevAnswer = { type: 'noul', noul: 0.9 };
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, keep])) };
      },
    };
    const out = await compact(long(400), asker, options);
    expect(requests).toBeGreaterThan(4);
    expect(out.stats.requests).toBe(requests);
    expect(peak).toBe(4);
  });

  it('starts no further request once the round is cancelled', async () => {
    let started = 0;
    const release: Array<() => void> = [];
    const asker: JevAsker = {
      async ask(_state, questions) {
        started += 1;
        await new Promise<void>((resolve) => release.push(resolve));
        const keep: JevAnswer = { type: 'noul', noul: 0.9 };
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, keep])) };
      },
    };
    const cancel = new AbortController();
    const pending = compact(long(400), asker, options, cancel.signal);
    const outcome = pending.then(() => 'resolved', (error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBe(4);
    cancel.abort();
    for (const go of release.splice(0)) go();
    expect(await outcome).toMatch(/cancelled/);
    expect(started).toBe(4);
  });

  it('starts no further request once one has failed', async () => {
    let started = 0;
    const asker: JevAsker = {
      async ask() {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 2));
        throw new Error('Jev request failed (503): busy');
      },
    };
    await expect(compact(long(400), asker, options)).rejects.toThrow(/503/);
    expect(started).toBe(4);
  });
});

describe('repeated compaction', () => {
  it('settles results an earlier round reduced and asks only about the rest', async () => {
    const messages = transcript();
    messages.splice(-2, 0, call('tool-4', 'Read', { file_path: 'src/c.ts' }, fileB), result('tool-4', fileB));
    const first = await compact(messages, fakeJev((name) => (name.endsWith('_t2') ? 0.9 : 0.1)), {
      preserveRecentMessages: 1,
    });
    expect(first.decisions.map((d) => d.action)).toEqual(['stub_call', 'keep', 'stub_call', 'stub_call']);

    const calls = collectToolCalls(first.messages, 1);
    expect(calls.map((c) => c.settled)).toEqual([true, false, false, true]);

    const seen: Seen[] = [];
    const second = await compact(first.messages, fakeJev(() => 0.1, seen), { preserveRecentMessages: 1 });
    expect(seen.flatMap((s) => s.questions).sort()).toEqual(['call_t2', 'call_t3', 'result_t2', 'result_t3']);
    expect(second.stats.settled).toBe(2);
    expect(second.decisions.filter((d) => d.reason === 'settled').map((d) => d.id)).toEqual(['t1', 't4']);
  });

  it('recognises every note this library writes, and nothing else', () => {
    const note = (text: string, isError = false): boolean => {
      const messages = [message('user', 'go'), call('x', 'Bash', {}, text), result('x', text, isError), message('user', 'next')];
      const calls = collectToolCalls(messages, 0);
      const stubbed = applyDecisions(messages, [decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, { keepThreshold: 0.5 })], calls, 300);
      const truncated = applyDecisions(messages, [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })], calls, 300);
      return [stubbed, truncated].every((out) => collectToolCalls(out, 0)[0]!.settled);
    };
    expect(note('y'.repeat(2000))).toBe(true);
    expect(note(`Error: boom\n${'z'.repeat(2000)}`, true)).toBe(true);
    const plain = [message('user', 'go'), call('x', 'Bash', {}, 'ok'), result('x', 'ok; re-run the tool if needed]'), message('user', 'n')];
    // Notes an upstream or an earlier fork version wrote are settled too.
    for (const old of [
      `${'h'.repeat(300)}\n[fast-jev-compaction truncated 1700 chars of this tool result; re-run the tool if needed]`,
      '[fast-jev-compaction removed the 2000-char output of this call; re-run the tool if needed]',
      // 0.4.x
      '[fast-jev-compaction removed the 2000-char output of this call; it was read in full when the call ran; re-run the tool if needed]',
    ]) {
      const legacy = [message('user', 'go'), call('x', 'Bash', {}, old), result('x', old), message('user', 'n')];
      expect(collectToolCalls(legacy, 0)[0]!.settled).toBe(true);
    }
    expect(collectToolCalls(plain, 0)[0]!.settled).toBe(false);
  });
});

describe('dropping the stubs when they do not free enough', () => {
  it('applies the same answers with stubbed calls removed, and recounts', async () => {
    const content = 'line of a written file\n'.repeat(200);
    const messages = [
      message('user', 'Write the files.'),
      call('w-1', 'Write', { file_path: 'a.txt', content }, 'File created'),
      result('w-1', 'File created successfully at: a.txt'),
      call('w-2', 'Read', { file_path: 'b.txt' }, fileA),
      result('w-2', fileA),
      message('assistant', 'Both done.'),
      message('user', 'thanks'),
    ];
    const stubbed = await compact(messages, fakeJev((name) => (name.endsWith('_t2') ? 0.9 : 0.1)), {
      preserveRecentMessages: 2,
    });
    expect(stubbed.stats.callsStubbed).toBe(1);
    expect(reductionRatio(stubbed)).toBeLessThan(0.05);

    const dropped = dropStubbedCalls(messages, stubbed, { preserveRecentMessages: 2 });
    expect(dropped.stats.callsStubbed).toBe(0);
    expect(dropped.stats.callsDropped).toBe(1);
    expect(dropped.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(dropped.messages.some((m) => m.toolUses.some((t) => t.tool_use_id === 'w-1'))).toBe(false);
    expect(dropped.messages.some((m) => m.toolResults?.some((r) => r.tool_use_id === 'w-1'))).toBe(false);
    expect(reductionRatio(dropped)).toBeGreaterThan(0.5);
    expect(dropStubbedCalls(messages, dropped, { preserveRecentMessages: 2 })).toBe(dropped);
  });
});
