import { jevAsker } from './asker.js';
import { DEFAULT_MODEL } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Abort a request (body included) after this long; defaults to 60 s. */
  timeoutMs?: number;
  /** Values to redact wherever they appear, besides the API key. */
  known?: readonly string[];
  /** Gets the number of secret-shaped values redacted from each request. */
  onRedact?: (count: number) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Asks Jev over HTTP with the global `fetch` (or an injected one), with the
 * same redaction as the Claude Code hook and a per-request timeout.
 */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly asker: JevAsker;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    const fetcher = options.fetch ?? fetch;
    const timeoutMs =
      options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.asker = jevAsker(
      async (url, init) => {
        const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        return { status: response.status, ok: response.ok, text: await response.text() };
      },
      this.apiKey,
      options.model ?? DEFAULT_MODEL,
      options.onRedact,
      { known: options.known, baseUrl: options.baseUrl },
    );
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    return this.asker.ask(state, questions);
  }
}
