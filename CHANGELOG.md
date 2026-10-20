# Changelog

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

- Secret-shaped values are redacted from everything sent to Jev (upstream #98).
- At most 128 questions per request and four requests in flight.
- One deadline per Jev round (upstream #117), 60 s by default.
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
