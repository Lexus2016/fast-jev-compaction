import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Backstop for #128, as a `JSON.stringify` replacer: a lone surrogate left in
 * any string of the request becomes U+FFFD before it is serialised, since
 * `JSON.stringify` would escape it as `\udXXX` and the API rejects that with
 * "Request contains invalid Unicode text". The cuts in `state.ts` already
 * avoid splitting pairs; this covers lone surrogates from anywhere else (raw
 * tool output). Working on the strings, not the JSON text, leaves a literal
 * `\ud800` that a tool printed as it is.
 */
function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '�');
}

/**
 * The HTTP request for one Jev call, for any fetch-like transport. `transform`
 * rewrites every string of the body as it is serialised (the asker redacts
 * secrets with it); the inputs themselves are left as they are.
 */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
  transform: (text: string) => string = (text) => text,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(
      {
        model: params.model ?? DEFAULT_MODEL,
        state,
        questions,
      },
      (_key, value: unknown) => (typeof value === 'string' ? wellFormed(transform(value)) : value),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbabilities(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((p) => typeof p === 'number');
}

function isJevAnswer(value: unknown): value is JevAnswer {
  if (!isRecord(value)) return false;
  if ('noul' in value) return typeof value['noul'] === 'number';
  if ('choice' in value) {
    return typeof value['choice'] === 'string' && typeof value['confidence'] === 'number' && isProbabilities(value['probabilities']);
  }
  if ('score' in value) {
    return typeof value['score'] === 'number' && typeof value['confidence'] === 'number' && isProbabilities(value['probabilities']);
  }
  return false;
}

/**
 * Validates a Jev response body; throws on anything but an `answers` object.
 * An answer of no known shape is left out, so asking for it fails like a
 * missing one.
 */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed['answers'])) {
    throw new Error('Jev response is missing answers');
  }
  const answers: Record<string, JevAnswer> = {};
  for (const [name, answer] of Object.entries(parsed['answers'])) {
    if (isJevAnswer(answer)) answers[name] = answer;
  }
  const response: JevResponse = { answers };
  if (typeof parsed['model'] === 'string') response.model = parsed['model'];
  return response;
}

/** How far outside [0, 1] a probability may land from rounding before it counts as wrong. */
const RANGE_TOLERANCE = 1e-6;

/**
 * The `noul` probability of one answer; throws when it is missing or outside
 * [0, 1], so a malformed scoring fails the round (and takes the fallback)
 * instead of stubbing or keeping a call on a meaningless number.
 */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (!answer || !('noul' in answer) || !Number.isFinite(answer.noul)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  if (answer.noul < -RANGE_TOLERANCE || answer.noul > 1 + RANGE_TOLERANCE) {
    throw new Error(`Jev answer for ${name} is out of range: ${answer.noul}`);
  }
  return Math.min(1, Math.max(0, answer.noul));
}
