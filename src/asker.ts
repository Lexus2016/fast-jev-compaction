import { redactSecrets } from './redact.js';
import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker } from './types.js';

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
 * A `JevAsker` over any fetch. Every string of the request body is redacted
 * as it is serialised (`onRedact` gets the count of each request's new
 * redactions); the API key travels in the header only. The batches of one
 * compaction share a state (one per window in a long session), so each string
 * is redacted once per asker, not once per batch.
 */
export function jevAsker(
  fetchFn: JevFetch,
  apiKey: string,
  model: string,
  onRedact: (count: number) => void = () => {},
  extras: JevAskerExtras = {},
): JevAsker {
  const known = [apiKey, ...(extras.known ?? [])];
  const redacted = new Map<string, string>();
  let found = 0;
  const redact = (text: string): string => {
    const cached = redacted.get(text);
    if (cached !== undefined) return cached;
    const safe = redactSecrets(text, known);
    redacted.set(text, safe.text);
    found += safe.count;
    return safe.text;
  };
  return {
    async ask(state, questions) {
      // Serialising is synchronous, so concurrent asks cannot mix their counts.
      found = 0;
      const request = buildJevRequest({ apiKey, model, baseUrl: extras.baseUrl }, state, questions, redact);
      if (found > 0) onRedact(found);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}
