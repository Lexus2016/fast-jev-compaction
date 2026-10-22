# Changelog

## 0.5.1 — 2026-10-22

- `/compact` and the plugin's own `turn.complete` request now also erase the
  calls Jev rated unneeded (no new request) when the stubs alone free less
  than `minReductionRatio`; before, only Claude Code's own automatic
  compaction did. In a long UGC session the stubs freed 9–16% on every manual
  and plugin round, which were all skipped ("below 25% minimum"), while the
  automatic round that could erase calls went from 14% to 64% (784k → 208k
  tokens, no summary). Still no built-in summary for these triggers: if the
  removal also frees too little they answer `{ skip }` as before.
- A skip or fallback below the minimum now says what erasing the unneeded
  calls would have freed (`… 16% reduction; 21% with the unneeded calls
  removed`), so a refusal shows the best figure that was reachable.

## 0.5.0 — 2026-10-20

Fixes from the audit of 0.4.1; details and evidence in
[FORK.md](FORK.md#audit-of-041).

Security

- Redaction catches `PASS`-named and quoted `"pass"` keys, `passphrase`,
  `пароль`, values with a comma inside, `--key`/`--pass` flags, `Cookie`
  headers, short URL passwords, e-mail addresses, `+` phone numbers, valid
  card numbers and IBANs, and 22 more service token shapes (SendGrid, Vault,
  Doppler, GitLab, Hugging Face, npm, PyPI, …). A private key cut before its
  END line is redacted to the end, in linear time.
- Secret-named or token-shaped `settings.env` values are redacted wherever
  they appear in a Jev request.
- The library (`compactMessages`, `JevClient`) redacts like the hook and
  aborts a request after `timeoutMs` (60 s).
- Notes tell the model to re-run only reads, never to repeat a call that
  wrote, sent or deleted something just to see its output.
- A Jev probability outside [0, 1] fails the round instead of deciding a
  call; `keepThreshold`, `minReductionRatio` and `compactAtPercent` are
  bounded.
- README no longer points to the `fast-jev-compaction` npm package, which is
  not built from this repository.

Other

- A truncation or stub is applied only when it frees at least 100 chars; some
  outputs used to grow.
- vitest 5 (`npm audit`: 0), CI on every push, no type assertions in `src/`
  or `hooks/`.

## 0.4.1 — 2026-10-20

- A compaction logs one line with the reduction only. The per-reason counts,
  state size, request count and redaction count moved behind `logDecisions`,
  next to the per-call `decisions:` lines.

## 0.4.0 — 2026-10-20

First release of the maintained fork, on upstream `e3f262a` (0.3.0). Every
change is listed with its source in [FORK.md](FORK.md).

Context

- A call Jev rates as unneeded stays whole and its output becomes a one-line
  note; it is no longer erased (upstream #65, #123). `dropCalls: true` restores
  erasing.
- Cutting one output of a parallel response no longer makes Claude Code report
  the other outputs as missing: only tool-result messages are rewritten
  (upstream #137).
- Only Claude Code's own automatic compaction falls back to the built-in
  summary; `/compact` and the plugin's own request are skipped instead
  (`builtinFallback`, upstream #103). After a skip the plugin waits for the
  context to grow by 10 points before it asks again.
- A history too large for one Jev state is asked in windows instead of falling
  back (upstream #119). Outputs an earlier compaction reduced are not asked
  about again.
- When Claude Code's own automatic compaction cannot reach the minimum with
  stubs, the calls Jev rated unneeded are removed (no new request) before the
  built-in summary is used.
- A stub keeps an output no longer than `truncateHeadChars` + 120 verbatim,
  and every note says the output was read in full when the call ran.

Requests

- Secret-shaped values are redacted from everything sent to Jev (upstream #98),
  including passwords inside serialised tool inputs, short or dotted
  passwords, any-case bearer tokens and Stripe secret keys.
- At most 128 questions per request and four requests in flight.
- One deadline per Jev round (upstream #117), 60 s by default; at the deadline,
  or when Claude Code ends the hook's dispatch, no further request is started.
- Lone surrogates never reach the request; cuts never split a surrogate pair
  (upstream #110, #128).
- Hashes, UUIDs and base64 are no longer undercounted in the token estimate
  (upstream #81).

Hook

- Subagent, fork and speculative compactions are left alone; only main-agent
  answers trigger the automatic request (upstream #112).
- Headless sessions stop asking after the first refusal (upstream #125).
- The per-call decision log is opt-in (`logDecisions`, upstream #148).
- A hook that fails or overruns its budget gets the same fallback policy.
- The marketplace is `lexus2016`; the plugin id stays `fast-jev-compaction`.
