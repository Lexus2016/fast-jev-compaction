# Fork notes and audit log

This is a maintained fork of
[tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction),
based on upstream `main` at `e3f262a` (2026-09-17), the last upstream commit.
By 2026-10-20 upstream had about seventy open pull requests and had merged
none since that commit; some 560 forks carried their own fixes. This fork
reads them, ports what holds up, rejects what does not, and records here
which was which and why.

## How changes get in

- Every line the hook executes is reviewed: `hooks/hooks.json` →
  `hooks/fast-jev.ts` → its imports in `src/`. `demo/` and `examples/` never
  run in the hook and are out of scope.
- A ported change is cherry-picked by the exact commit SHA recorded below, so a
  later force-push to its branch cannot swap in a different diff.
- Each diff is checked for network calls (`$.http.fetch`), process spawning
  (`$.process.run`), filesystem writes (`$.fs.*`), `eval`, dynamic imports,
  encoded strings, and changes to `hooks.json`, `package.json` or the lockfile.
- Every string a change adds to what the model reads (notes, stubs, markers)
  is read, since this hook rewrites the model's history and an instruction
  planted there is the realistic attack.
- Test files are read before they run; they execute code too.
- A change to how messages are handed back to Claude Code is verified in a
  live headless Claude Code session, not only against unit tests.

## The base, audited

At `e3f262a` the hook executes `hooks/fast-jev.ts`, `src/compact.ts`,
`src/request.ts` and `src/state.ts` (about 1000 lines; `src/types.ts` is types
only). The one network call is `$.http.fetch` to
`https://api.typesafe.ai/v1/systemone`. No filesystem, process or `eval` use.
The only text added to the model's history is the truncation note in
`src/compact.ts`. `package.json` has no install scripts and no runtime
dependencies; all 122 lockfile entries resolve from `registry.npmjs.org`.

`claude plugin validate` on this fork's hook reports what it calls:
`$.clock.sleep, $.env.get, $.http.fetch, $.session.compact, $.session.usage,
$.settings.read, $.ui.log, $.ui.toast`; env writes: nothing; env reads:
`TYPESAFE_API_KEY`.

## Ported

| Commit here | Source | Author | What | Notes |
| --- | --- | --- | --- | --- |
| `44d871e` | PR #106 `0b8b00d` | Will Gomes | `tsconfig` path for newer TypeScript, plugin metadata | clean |
| `9595f2c` | PR #110 `65f4bdf` | actom | truncated result head never splits a surrogate pair | clean |
| `69989aa` | PR #132 `9b5f8f6` | Dhruv Arora | surrogate-safe cuts in the Jev state, JSON backstop | backstop replaced in `ed0a882` |
| `7eaec63` | PR #85 `53488d8` | kuishou68 | token estimate charges hex, UUID and base64 runs ~3 chars/token | clean |
| `215e36b` | kevinb6e fork `49bb8ab` | Kevin BATAILLE | at most 64 calls (128 questions) per Jev request | Jev answers 400 above 128 |
| `74dfc61` | PR #112 `f073257` | Patrick Obrtal | subagent, fork and `precompute` compactions left alone; only main-agent answers trigger | clean |
| `59efa42` | PR #125 `be9ef74` | Metehan Kilkis | stop asking `$.session.compact` after a headless refusal | test adapted to #112's `reason` filter |
| `8d5fe71` | PR #117 `d45d4f5` | Max Mohammadi | one deadline for a Jev round | `scripts/test-host-hooks.mjs` spawns `claude plugin test` locally; it never runs in the hook |
| `1592315` | PR #148 `85abf72` | Luke Bradford | per-call decision log opt-in (`logDecisions`) | chosen over the equivalent #146 for size; conflicts resolved by hand |
| `5f3245e` | PR #98 `12efc9c`, `6324b75`, `f1e3dca` | socialadsmentor | secret redaction of the Jev request | `src/redact.ts` as of `f1e3dca` (bounded regex); `withoutHandles` and the version bump left out; state redacted once per compaction instead of once per batch |
| `8bf741a` | QuanticPotatoes fork `8334214` (PR #119) | Mikhail Nemerov (deadczarvc) | Jev asked in windows when the history does not fit | ported by hand; `HistoryTooLargeError` class instead of a message match |
| `6a44223` | PR #103 `ea14b7a` | XavierXIEXIN | built-in summary only for the engine's auto compaction; wait 10 points after a skip | ported by hand onto #112/#117/#125; tests rewritten without type assertions |

## Written here

| Commit | What | Evidence |
| --- | --- | --- |
| `5e7f7ea` | Calls are never rebuilt; an unneeded call stays whole with its output replaced by a note (`stub_call`, default), `dropCalls: true` restores erasing | live: #137 reproduced (`ensureToolResultPairing: repaired missing tool_result blocks`; kept files read as "Tool result missing") and gone after the change; #65/#123 addressed by never erasing a call |
| `ed0a882` | lone surrogates replaced in the request's strings by a `JSON.stringify` replacer | the #132 regex rewrote a tool's literal `\ud800` text; new test fails on the old code |
| `8bf741a` | settled results (already reduced) not asked again; at most four requests in flight, none started after a failure; `compactionTimeoutMs` 15 s → 60 s | 2000 synthetic calls: ~50 requests; the built-in summary it would fall back to takes ~30 s |
| `19a6980` | `.catch` on `session.compact` with the fallback policy | `claude plugin validate`: "gating hook without .catch" before, "with .catch" after |
| `7ec154b` | an auto compaction whose stubs free too little removes the calls Jev rated unneeded before falling back; a stub keeps an output up to `truncateHeadChars` + 120 verbatim | 26 heaviest local transcripts, fake Jev rating every call unneeded: stubs 21–69%, erasing 34–97%, truncating results only 18–64% |
| `e408836` | every note says the output was read in full when the call ran | real-Jev smoke: Haiku called its own earlier answers unverified with the old wording |
| `1eec67d` | redaction: escaped quotes in serialised inputs, short and dotted passwords, any-case `bearer`, Stripe `sk_` keys, no double redaction | independent review (codex) reproduced a password in a Bash command reaching Jev; five new tests and an end-to-end body check fail on the previous code |
| `4e05b45` | the deadline (or the end of the hook's dispatch) stops the request queue; a call Jev was not asked about is kept whatever the threshold | same review; three new tests fail on the previous code |
| `4866025` | quoted and very short passwords redacted whole; the work stops however the deadline's wait ends | second review of the fixes; nine new tests fail on the previous code |
| `b0e20fe` | redaction: `PASS`-named and quoted `"pass"` keys, `passphrase`, `пароль`, commas inside values, `--key`/`--pass`, `Cookie` headers, 3+ char URL passwords, e-mail, `+` phone numbers, Luhn-valid cards, mod-97-valid IBANs, 22 service token shapes from llm-security-proxy (`src/security/patterns.rs`); the PEM rule runs to the end of a cut text | 0.4.1 audit probes (`SMTP_PASS=…`, `"DB_PASS"`, cookies, `token=a,b…`, `--key <hex>`) all passed unredacted before; PEM without END took 0.48/1.9/7.6 s on 200/400/800 KB, now ~45 ms on 800 KB; offline on states from 12 local transcripts: 778 redactions instead of 700, 0.05% of the state text |
| `2ef21ae` | one redacting asker (`src/asker.ts`) for the hook and `JevClient`, so `compactMessages` redacts too; `JevClient` aborts a request after `timeoutMs` (60 s) | the library path sent the history unredacted and could wait forever (audit, council) |
| `ad76e4d` | secret-named or token-shaped `settings.env` values redacted as known secrets; unreadable settings no longer cost the compaction | `curl -u bot:<value>` passes every pattern; the host tests caught a `settings.read` rejection that would have failed the round |
| `6ea7f20` | notes say to re-run only reads and not to repeat a call that wrote, sent or deleted something; a rewrite must free at least 100 chars measured against the note actually written | 421–428-char outputs grew when truncated; live A/B below |
| `ed4bbe1` | Jev answers validated through type guards; a `noul` outside [0, 1] (beyond 1e-6) fails the round; `keepThreshold`, `minReductionRatio` and `compactAtPercent` bounded | `noul: -1` was accepted and stubbed calls (council) |
| `b4a23f9` | no type assertion left in `src/` or `hooks/`; redaction moved into the request's `JSON.stringify` replacer | same timing on 500–5000 synthetic calls |
| `6a18116` | vitest 2.1.8 → 5.0.5 | `npm audit`: 7 advisories (2 critical) → 0 |
| `1634223` | CI: typecheck, tests, `npm audit --audit-level=high`, actions pinned to SHAs | — |

## Considered and not ported

Read and rejected:

- **PR #139** (keep a rebuilt message's handle): on Claude Code 2.1.293 the
  engine reuses a handle only for a message that comes back unchanged (reported
  in upstream #137); superseded here by never rebuilding call messages.
- **PR #98 `withoutHandles`**: stripping the handle from every kept message
  makes each call of a parallel response its own API message (the #137 split
  for every parallel response), trading the `--resume` fix for in-session loss.
- **PR #83 input cutting** (stub idea taken, implementation not): cutting a
  stub's long input was tried here too. Live, the model read the cut command as
  the command it had run, and the note key as a parameter it had passed, twice,
  even with notes in the input and the result saying otherwise.
- **orangewk `911ae3f`, `5dad087`, `ad91a16`, `e1a77b5`** (rebuild every kept
  message, regroup responses): fixes `--resume` (#89) but rebuilt messages lose
  thinking blocks, images and attached rows (queued prompts among them) in the
  live session. `responseStarts` was ported and then dropped with input
  cutting, since nothing here rebuilds call messages any more.
- **PR #135**: same fix as #132, which covers more call sites.
- **PR #146**: same feature as #148.
- **PR #138** (curl fallback): adds `$.process.run(['curl', …])` with the key
  on stdin; spawning a process from the hook is outside this fork's surface.
- **deadczarvc-labs/jev-factkeep-compaction**: a 4.4k-line rewrite (fact stubs,
  saved outputs on disk, extra providers); too far from this base to audit as
  one change. Its windowing (via PR #119) is ported.

Deferred, not yet reviewed in full:

- `--resume` reloading the pre-compaction history (upstream #89).
- `baseUrl` / other endpoints: PRs #90, #94, #96, #113, #124, #142.
- OpenRouter transport and per-compaction batch caps: PR #126 (its question cap
  is covered by `215e36b`).
- Compacting injected text and long replies: PR #141. Deferring automatic
  compaction to the turn's end: PR #149. Salvaging identifiers from dropped
  results: PR #105. Provenance marks: PR #134.

## Live verification

Claude Code 2.1.304, headless, one `stream-json` process (a `--resume` would
reload the history, see #89), `claude-haiku-5-5`, plugin loaded with
`--plugin-dir` and the installed copy disabled. Decisions were forced by file
name in a test copy of the plugin, so the message mapping under test is the
committed code. Scenario: four parallel `Read`s (`keep-*` kept, `drop-*`
truncated), one long `Bash` output (stubbed), `/compact`, two short turns, a
second `/compact`, then questions answered from memory only.

| Build | Pairing repair in debug log | Kept files' last lines | Stubbed Bash |
| --- | --- | --- | --- |
| upstream fixes only | yes | "Tool result missing due to internal error" | — |
| this fork | none | `AMBER-END`, `COBALT-END` | command recalled exactly, output reported as removed by compaction |

The second `/compact` (21% < 25%) now answers `not compacted, no built-in
summary` and the next answer still quotes the verbatim history; before
`6a44223` it fell back to the LLM summary.

Then the shipped plugin, unmodified (real Jev decisions, the 25% gate, six
pinned messages), with the same scenario: Jev stubbed all five calls (90–92%
reduction), no pairing repair, and the second `/compact` was skipped with
`5 settled; no Jev request`. Every model recalled the Bash command exactly and
reported the removed outputs as removed. `claude-haiku-5-5` still called its
own earlier answers unverified, even with the read-in-full wording;
`claude-sonnet-5-5` kept them as what it had seen and marked only inferences
as inferences.

For 0.5.0 the note wording was checked the same way, with 0.4.1 (old
wording) and 0.5.0 side by side: a `Read` of a file and a `Bash` command that
appends to `deploy.log` and prints 120 lines were both stubbed, then the
model was asked for a fact from the file and for line 57 of the command's
output. Both builds re-read the file and answered from it; neither repeated
the command (`deploy.log` holds one line in both) and both reconstructed the
line from the command itself, saying the output had been removed. So the
re-run hazard did not reproduce with the old wording on Haiku; the new
wording closes the instruction that invited it and changed nothing else.
Both compactions applied (83%, 86%), with no pairing repair.

## Performance

Synthetic sessions, fake Jev, `node --expose-gc`, local work only (the Jev
requests themselves add ~0.4 s each):

| Calls | upstream `e3f262a` | this fork |
| --- | --- | --- |
| 200 | 7 ms | 12 ms |
| 400 | 18 ms, 5 requests (one over Jev's 128-question limit) | 37 ms, 7 requests |
| 600–800 | throws: history too large → summary | 800: 103 ms, 2 windows, 14 requests |
| 2000 | throws | 333 ms, 4 windows, 50 requests |
| 4000 | throws | 876 ms, 8 windows, 102 requests |

## Independent review

Before the release, `codex` and `agy` (different providers) reviewed the diff
against the task (`consult --panel codex,agy --review`). codex returned FAIL
with five findings, four of them reproduced: a password in a serialised Bash
command reached Jev; short, dotted and lowercase-bearer secrets passed; the
deadline did not stop the request queue; an unasked call could be stubbed
above a threshold of 1. All four are fixed in `1eec67d` and `4e05b45`. The
fifth, that `builtinFallback: 'always'` lets `/compact` summarise, is the
option working as documented. agy's run was cut off; its one finding (no
explicit pattern for Stripe `sk_live_` keys) is in `1eec67d`.

A second codex review of those fixes confirmed the main cases closed and
found edge cases (quoted passwords with spaces, one-to-three-char passwords,
a token inside a password, single-quoted `$` literals, a sleep that rejects
or throws); all are fixed and tested.

## Audit of 0.4.1

On 2026-10-20 0.4.1 was audited against the AI-SAFE threat list (INPUT,
EXEC, LOGIC, INFRA, DATA) and, independently, by `consult council` (agy and
grok, synthesised by codex; 8 of 8 citations verified). Verdict for 0.4.1:
not safe, for the redaction leaks and the library path above. Fixed in 0.5.0
as listed under "Written here". Council findings not taken:

- *Dropping stubbed calls splits a parallel response (#137 again)*: in
  39,826 assistant rows of 40 local transcripts no row holds more than one
  `tool_use`, or a `tool_use` with text, so a dropped call removes its whole
  row and nothing is rebuilt.
- *A tool output can forge the settled note* (rated high): it can, and such an
  output is then never compacted; without the plugin it would stay in context
  until the built-in summary all the same, so it gains an attacker nothing.
  Listed below.
- *Jev decides without seeing the outputs*: by design; sending them would
  multiply the state and what redaction has to catch.

Re-run of every probe on 0.5.0: everything above is redacted; the residual
misses are listed below. With the last 🔴/🟠 items closed, the remaining open
item is INFRA.2 (no cap on requests per compaction, 🟡).

## Known gaps

- Redaction is pattern-based, as upstream's was: a secret with no recognisable
  name, prefix or shape still reaches Jev. Known misses: a password in prose
  ("the password is …"), a hex credential in a URL path (40- and 64-char hex
  is exempt as a commit or sha256 digest), a local phone number written
  without `+`, a quoted password holding an escaped quote of its own
  (`--password="ab\"cd"` keeps `cd`). Over-redaction seen offline: a short
  value after a `fix-pass:`-style label.
- No cap on Jev requests per compaction: a 5000-call synthetic session takes
  138 requests (~2.3M tokens by chars/4), 72–78% of each the same state sent
  again. Shorter questions would fit 64 calls per request instead of ~34;
  left until its effect on Jev's answers is measured.
- A failed Jev batch fails the round and drops the answers already paid for;
  there is no retry on 429/5xx yet.
- The six pinned messages are about three calls, not the current turn: an
  automatic compaction in the middle of a long turn can stub an output the
  model is still working with (it can re-read it).
- An output is "settled" by its note text, so a tool output ending in that
  text is never compacted.
- Claude Code installs the dev dependencies into the plugin cache (36
  packages, `npm audit` 0); the hook imports none of them.
- The Jev state still tells Jev that what is not kept "is deleted
  permanently"; with stubs, only outputs are. Left as is until its effect on
  Jev's calibration is measured.
- Tests (several from upstream) still use TypeScript type assertions; `src/`
  and `hooks/` have none.
