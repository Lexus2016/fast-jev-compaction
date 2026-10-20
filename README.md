# fast-jev-compaction

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call is scored, stale outputs are cut to a note, every call stays,
and everything kept stays verbatim. Also usable as an npm library.

> **Maintained fork** of
> [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction).
> Upstream has merged nothing since 2026-09-17 and holds about seventy open
> community pull requests. This fork reviews them line by line, ports the ones
> that hold up, fixes the context-loss bugs that live testing found, and keeps
> developing the plugin. [CHANGELOG.md](CHANGELOG.md) says what changed;
> [FORK.md](FORK.md) is the audit log: every upstream PR and fork commit that
> was read, with its verdict.

### What this fork fixes

- **No "Tool result missing" after compaction** (upstream #137). Cutting one
  output of a parallel response made Claude Code split that response and
  report the other calls' outputs as missing. Only tool-result messages are
  rewritten now; reproduced and verified live on Claude Code 2.1.304.
- **No erased calls** (#65, #123). A call Jev rates as unneeded stays whole
  and its output becomes a one-line note, so the history never narrates work
  with the evidence gone (after which a model has reported work it never did).
- **No needless LLM summary** (#103). Only Claude Code's own automatic
  compaction, which must shrink the conversation, falls back to the built-in
  summary, and only after removing the calls Jev rated unneeded did not free
  enough either; `/compact` and the plugin's own request are skipped instead.
- **Long sessions compact.** A history too large for one Jev state is asked
  in windows instead of throwing (500+ calls used to always fall back).
  Repeated compactions do not re-ask about outputs already reduced.
- **Safer and steadier requests**: secrets redacted from what is sent to Jev
  (#98), subagent and speculative compactions left alone (#112), one deadline
  per round (#117), at most 128 questions per request and four requests in
  flight, UTF-16-safe cuts (#110, #132), a token estimate that does not
  undercount hashes and base64 (#85), no retry storm in headless sessions
  (#125), the per-call decision log opt-in (#148).

Install (replacing an upstream install, remove that first):

```sh
claude plugin uninstall fast-jev-compaction@fast-jev-compaction   # upstream, if installed
claude plugin marketplace remove fast-jev-compaction             # upstream, if added
claude plugin marketplace add Lexus2016/fast-jev-compaction
claude plugin install fast-jev-compaction@lexus2016
```

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything the assistant said or
did. It only replaces tool outputs Jev says are no longer needed with a short
note, and it asks Jev while showing it the whole conversation. Every tool call,
and all user and assistant text, stays verbatim and in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit (long sessions), the calls are asked in contiguous windows,
   halved until each window's state fits: a window keeps the goal, the first
   message, the pinned newest messages and its own messages in full. A call no
   window can fit is not asked, so it stays. Tokens are estimated without a
   tokenizer (a word per six letters, half a token per digit, ~one per other
   symbol, at least one per three characters of a hash or base64 run),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do). A result an earlier compaction already reduced (it ends
   in this library's note) is *settled*: it stays in the state, but is not
   asked about again.
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit) and no request holds more than 128 questions (64 calls), the most Jev
   accepts. The state is resent with every request; at most four requests run
   at once and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → keep the call whole and replace its result with a one-line note
     (`stub_call`); an error keeps its head, and an output no longer than
     `truncateHeadChars` + 120 stays as it is. With `dropCalls: true` the call
     is removed together with its result instead.

   Every note says the output was read in full when the call ran, so a model
   does not take its own earlier answers for guesses.
7. The message list is rebuilt. Only tool-result messages are rewritten: a
   message holding a call is returned as the same object (or, with
   `dropCalls`, loses that call), because Claude Code treats a rebuilt call
   message as a new API message and would split a parallel response. A message
   that loses all its content is removed, and no result is ever left without
   its call.

Jev failures, malformed answers or a missing key throw; the caller (or the
Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `dropCalls` | `false` | Remove a call Jev rates unneeded with its result, instead of keeping it as a stub |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool results are rewritten (and, with `dropCalls`, calls removed); text
  messages and call inputs are never removed or shortened in the output (they
  are only abridged in the state Jev sees). A stub keeps its call's full input,
  so calls with large inputs (`Write`, long `Bash` scripts) cost what they
  cost: shortening them was tried, and a model read the cut input as what it
  had run. On the 26 heaviest local transcripts, stubbing every unpinned call
  frees 21–69% (erasing them, 34–97%). The Claude Code hook therefore erases
  the calls Jev rated unneeded, with no new request, when Claude Code's own
  automatic compaction cannot otherwise reach `minReductionRatio`.
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The state is repeated with every request, so a history near the state
  ceiling costs one request per ~40 calls; a 2000-call session takes about
  50 requests (four in flight).
- `--resume` after a plugin compaction is not verified in this fork. Upstream
  measured that a resumed session reloads most of the pre-compaction history
  (upstream #89); the in-session compaction is what this fork tests live.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and,
when Claude Code's own automatic compaction has to shrink the conversation,
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add Lexus2016/fast-jev-compaction
claude plugin install fast-jev-compaction@lexus2016
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary. When Jev could not remove enough (short
sessions, or when it fails) it reads `fallback to built-in summary (…)` during
Claude Code's automatic compaction, and `not compacted, no built-in summary (…)`
on `/compact` or the plugin's own request, which leave the conversation as it
is; `builtinFallback` changes which compactions fall back.

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run test:hooks:host  # native hook dispatcher tests; requires Claude Code
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
