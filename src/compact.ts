import { noulAnswer } from './request.js';
import {
  collectToolCalls,
  estimateTokens,
  fitState,
  goalFromMessages,
  HistoryTooLargeError,
  isPinned,
  RERUN_GUIDANCE,
} from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  FittedState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolResult,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  dropCalls: false,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/** Jev answers between 1 and 128 questions per request; each call asks two. */
const MAX_CALLS_PER_REQUEST = 64;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    dropCalls:
      typeof options.dropCalls === 'boolean' ? options.dropCalls : DEFAULT_OPTIONS.dropCalls,
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches that Jev accepts: at most
 * `MAX_CALLS_PER_REQUEST` calls, whose questions together with the (always
 * complete) state fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (
      current.length > 0 &&
      (currentTokens + tokens > budget || current.length === MAX_CALLS_PER_REQUEST)
    ) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'> &
    Partial<Pick<ResolvedCompactOptions, 'dropCalls'>>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  if (options.dropCalls) return { ...base, action: 'drop_call', reason: 'call_dropped' };
  return { ...base, action: 'stub_call', reason: 'call_stubbed' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

/** Whether ending `text` at `index` would separate the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Said in every note: without it a model has taken its own earlier answers,
 * given while the output was in front of it, for guesses made without it.
 */
const READ_WHEN_RAN = 'it was read in full when the call ran';

/** A rewrite must free at least this many chars; otherwise the output stays verbatim. */
const MIN_SAVING = 100;

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  // End the head on a code point boundary: cutting a surrogate pair in half
  // would leave a lone surrogate in the rebuilt transcript.
  const cut = splitsSurrogatePair(text, headChars) ? headChars - 1 : headChars;
  const head = cut > 0 ? `${text.slice(0, cut)}\n` : '';
  const out = `${head}[fast-jev-compaction truncated ${text.length - cut} chars of this tool result${
    isError ? ' (error)' : ''
  }; ${READ_WHEN_RAN}; ${RERUN_GUIDANCE}]`;
  // Measured against the note actually written: a head plus a note longer than
  // the output it replaces would grow the history and hide the output's end.
  return text.length - out.length >= MIN_SAVING ? out : text;
}

/**
 * The result of a stubbed call: a one-line note in place of the output, so
 * the call stays answered and the history says what became of its output. An
 * error keeps its head, since the exact error text is what is worth keeping,
 * and an output no longer than `headChars` + 120 stays as it is: a short
 * output is usually the fact itself (a count, an id, a status). Nor is an
 * output replaced by a note that frees less than `MIN_SAVING` chars.
 */
function stubResultText(text: string, isError: boolean, headChars: number): string {
  if (isError) return truncatedResultText(text, isError, headChars);
  if (text.length <= headChars + 120) return text;
  const stub = `[fast-jev-compaction removed the ${text.length}-char output of this call; ${READ_WHEN_RAN}; ${RERUN_GUIDANCE}]`;
  return text.length - stub.length >= MIN_SAVING ? stub : text;
}

/**
 * Rebuilds the conversation from the decisions. A dropped result keeps a
 * bounded head and note; a stubbed call keeps its call whole and its output
 * becomes a note; with `dropCalls` a call is removed together with its result
 * instead. Messages that lose all their content are removed; untouched
 * messages are returned as the same objects they came in as.
 *
 * Only tool_result messages are rewritten; a message holding a call is kept
 * as it was or, with `dropCalls`, loses that call. Claude Code builds a
 * message handed back without its handle as a new API message, so a rebuilt
 * call message splits a parallel response and the host reports the other
 * calls' results as missing (upstream #137). And a call is never shortened:
 * live, a model read a cut command as the command it had run, even with a
 * note saying otherwise.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  if (actions.size === 0) return [...messages];

  const rewriteUses = (tools: ToolUse[]): ToolUse[] =>
    tools.some((tool) => actions.get(tool.tool_use_id) === 'drop_call')
      ? tools.filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      : tools;

  const rewriteResults = (results: ToolResult[]): ToolResult[] => {
    let changed = false;
    const out: ToolResult[] = [];
    for (const result of results) {
      const action = actions.get(result.tool_use_id);
      if (action === 'drop_call') {
        changed = true;
        continue;
      }
      const isError = result.isError ?? false;
      const text =
        action === 'drop_result'
          ? truncatedResultText(result.text, isError, headChars)
          : action === 'stub_call'
            ? stubResultText(result.text, isError, headChars)
            : result.text;
      if (text === result.text) {
        out.push(result);
        continue;
      }
      out.push({ tool_use_id: result.tool_use_id, text, isError: result.isError });
      changed = true;
    }
    return changed ? out : results;
  };

  const kept: Message[] = [];
  for (const message of messages) {
    const toolUses = rewriteUses(message.toolUses);
    const toolResults = message.toolResults && rewriteResults(message.toolResults);
    if (toolUses === message.toolUses && toolResults === message.toolResults) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && !toolResults?.length) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults && toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

/**
 * The same compaction with every stubbed call removed together with its
 * result, as `dropCalls` would have done: no new Jev request, the same
 * answers applied the upstream way. For when a compaction must shrink the
 * conversation and the stubs alone do not free enough; erasing calls Jev
 * already rated unneeded keeps the rest verbatim, where the alternative is an
 * LLM summary. `messages` and `options` must be the ones `result` came from.
 */
export function dropStubbedCalls(
  messages: readonly Message[],
  result: CompactResult,
  options: CompactOptions = {},
): CompactResult {
  if (result.stats.callsStubbed === 0) return result;
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const decisions = result.decisions.map(
    (decision): CallDecision =>
      decision.action === 'stub_call'
        ? { ...decision, action: 'drop_call', reason: 'call_dropped' }
        : decision,
  );
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return {
    messages: kept,
    decisions,
    stats: {
      ...result.stats,
      messagesAfter: kept.length,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      callsDropped: count(decisions, 'call_dropped'),
      callsStubbed: 0,
    },
  };
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/** Jev requests in flight at once within one compaction. */
const MAX_CONCURRENT_REQUESTS = 4;

/**
 * Maps `items` through `fn` with at most `limit` calls in flight, keeping the
 * order. On the first failure, or once `signal` aborts, no further item is
 * started; the failure (or the cancellation) is thrown once the calls in
 * flight have settled.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && !signal?.aborted && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (signal?.aborted) throw new Error('compaction cancelled before every Jev request was made');
  return results;
}

type StateGroup = { state: FittedState; calls: ToolCall[] };

/**
 * One state for all candidates when the history fits `maxStateTokens`. When it
 * does not (long sessions), the candidates are split into contiguous windows,
 * halved until each window's state fits: a window's state keeps the goal, the
 * first message, the pinned newest messages and its own messages in full, and
 * leaves the rest of the history out. Relevance of an old call depends mostly
 * on the goal and the recent turns, which every window carries. A call whose
 * window cannot fit even alone is returned in `unasked`; it gets no answer and
 * therefore stays, like any call Jev was not asked about. Adapted from
 * deadczarvc (Mikhail Nemerov), upstream PR #119.
 */
export function stateGroups(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  candidates: readonly ToolCall[],
  options: ResolvedCompactOptions,
): { groups: StateGroup[]; unasked: ToolCall[]; stage: string } {
  try {
    const state = fitState(messages, calls, options);
    return { groups: [{ state, calls: [...candidates] }], unasked: [], stage: state.stage };
  } catch (error) {
    if (!(error instanceof HistoryTooLargeError)) throw error;
  }
  const windowOptions = { ...options, goal: options.goal || goalFromMessages(messages) };
  const groups: StateGroup[] = [];
  const unasked: ToolCall[] = [];
  const fit = (group: ToolCall[]): void => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const call of group) {
      lo = Math.min(lo, call.callIndex);
      hi = Math.max(hi, call.resultIndex);
    }
    const inWindow = new Set(group.map((call) => call.id));
    const view = messages.map((message, i) =>
      (i >= lo && i <= hi) || isPinned(i, messages.length, options.preserveRecentMessages)
        ? message
        : { ...message, text: '' },
    );
    try {
      const state = fitState(
        view,
        calls.filter((call) => call.pinned || inWindow.has(call.id)),
        windowOptions,
      );
      groups.push({ state, calls: group });
    } catch (error) {
      if (!(error instanceof HistoryTooLargeError)) throw error;
      if (group.length === 1) {
        unasked.push(group[0]!);
        return;
      }
      const half = Math.ceil(group.length / 2);
      fit(group.slice(0, half));
      fit(group.slice(half));
    }
  };
  const half = Math.ceil(candidates.length / 2);
  fit(candidates.slice(0, half));
  if (candidates.length > half) fit(candidates.slice(half));
  const stage = `windows:${groups.length}${unasked.length > 0 ? ` unasked:${unasked.length}` : ''}`;
  return { groups, unasked, stage };
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions; when it cannot be fitted, the
 * calls are asked in windows (see `stateGroups`). At most
 * `MAX_CONCURRENT_REQUESTS` requests run at once. Throws when Jev fails; the
 * caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
  signal?: AbortSignal,
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned && !call.settled);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let requests = 0;
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const { groups, stage } = stateGroups(messages, calls, candidates, resolved);
    fitted = { tokens: groups.reduce((max, group) => Math.max(max, group.state.tokens), 0), stage };
    const jobs = groups.flatMap((group) =>
      batchCalls(group.calls, group.state.tokens, resolved).map((batch) => ({
        state: group.state.state,
        batch,
      })),
    );
    requests = jobs.length;
    const answered = await mapLimit(
      jobs,
      MAX_CONCURRENT_REQUESTS,
      (job) => askBatch(asker, job.state, job.batch),
      signal,
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map((call): CallDecision => {
    const keep = (reason: CallDecision['reason']): CallDecision => ({
      id: call.id,
      tool: call.tool,
      keepCall: 1,
      keepResult: 1,
      action: 'keep',
      reason,
    });
    if (call.pinned) return keep('pinned');
    if (call.settled) return keep('settled');
    const answer = answers.get(call.id);
    // A call Jev was not asked about (no window could fit it) stays whatever the threshold.
    return answer ? decideCall(call, answer, resolved) : keep('kept');
  });
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      callsStubbed: count(decisions, 'call_stubbed'),
      pinned: count(decisions, 'pinned'),
      settled: count(decisions, 'settled'),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests,
      ms: Date.now() - started,
    },
  };
}
