import { redactDeep } from './redact.js';
import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevState } from './types.js';

export type JevFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type JevFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** A fetch reduced to what one Jev call needs, so any transport fits (the hook's `$.http.fetch`, the global `fetch`). */
export type JevFetch = (url: string, init?: JevFetchInit) => Promise<JevFetchResponse>;

export type JevAskerExtras = {
  /** Values replaced wherever they appear, besides the API key (e.g. the session's own secrets). */
  known?: readonly string[];
  baseUrl?: string;
};

/**
 * A `JevAsker` over any fetch. Secrets are redacted from what is sent
 * (`onRedact` gets the count); the API key travels in the header only. The
 * batches of one compaction share a state object (one per window in a long
 * session), so each state is redacted once, not once per batch.
 */
export function jevAsker(
  fetchFn: JevFetch,
  apiKey: string,
  model: string,
  onRedact: (count: number) => void = () => {},
  extras: JevAskerExtras = {},
): JevAsker {
  const known = [apiKey, ...(extras.known ?? [])];
  const redacted = new WeakMap<object, JevState>();
  const redactState = (state: JevState): JevState => {
    const cached = typeof state === 'object' ? redacted.get(state) : undefined;
    if (cached !== undefined) return cached;
    const safe = redactDeep(state, known);
    if (typeof state === 'object') redacted.set(state, safe.value);
    onRedact(safe.count);
    return safe.value;
  };
  return {
    async ask(state, questions) {
      const safeState = redactState(state);
      const safeQuestions = redactDeep(questions, known);
      if (safeQuestions.count > 0) onRedact(safeQuestions.count);
      const request = buildJevRequest({ apiKey, model, baseUrl: extras.baseUrl }, safeState, safeQuestions.value);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}
