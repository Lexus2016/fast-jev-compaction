/**
 * Secret redaction for what leaves the machine. The Jev request carries the
 * history's texts and tool inputs; anything shaped like a credential in them is
 * replaced before the request is built. The transcript itself is never changed.
 *
 * Pattern-based by necessity: `$.env.get` takes literal names only, so the hook
 * cannot enumerate the environment. Values the hook does hold (its own API key)
 * are passed as `known` and replaced exactly.
 */

export const REDACTED = '[REDACTED]';

/**
 * What a rule's value capture sees of an earlier replacement: the value
 * classes stop before `]`, so a guard against redacting twice looks for this.
 */
const REDACTED_HEAD = REDACTED.slice(0, -1);

/**
 * Credentials with a recognisable shape, replaced whole. The service prefixes
 * after Slack follow llm-security-proxy's catalogue (src/security/patterns.rs);
 * the dotted ones (SendGrid, Vault, Doppler) matter most, since OPAQUE stops
 * at a dot.
 */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant|or|kimi|proj|live|test)?-?[A-Za-z0-9_-]{16,}/g, // Anthropic, OpenRouter, Kimi, OpenAI, Stripe
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9_-]{20,}/g, // Stripe webhook signing secret
  /\bpit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // GoHighLevel private integration
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bgl(?:pat|dt|rt|cbt|oas|soat)-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id, long-term and temporary
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /\bGOCSPX-[0-9A-Za-z_-]{20,}/g, // Google OAuth client secret
  /\bSG\.[A-Za-z0-9_-]{20,24}\.[A-Za-z0-9_-]{39,50}/g, // SendGrid
  /\bhv[sbr]\.[A-Za-z0-9_-]{24,}/g, // HashiCorp Vault
  /\bdp\.(?:pt|st|sa|scim|audit)\.[A-Za-z0-9]{20,}/g, // Doppler
  /\b\d{5,16}:A[A-Za-z0-9_-]{34,}/g, // Telegram bot
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
  /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g, // PyPI
  /\bkey-[0-9a-zA-Z]{32}\b/g, // Mailgun
  /\bNR(?:AK-[A-Za-z0-9]{27}|AA-[a-f0-9]{27}|I[IQ]-[A-Za-z0-9_-]{32}|RA-[a-f0-9]{42})\b/g, // New Relic
  /\bdo[por]_v1_[a-f0-9]{64}\b/g, // DigitalOcean
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\bglsa_[A-Za-z0-9_]{32,}/g, // Grafana
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32,}/g, // Shopify
  /\blin_api_[A-Za-z0-9]{20,}/g, // Linear
  /\bPMAK-[A-Za-z0-9-]{20,}/g, // Postman
  /\bFlyV1\s+fm[12]_[A-Za-z0-9_-]{20,}/g, // Fly.io deploy token
  /\bfo1_[A-Za-z0-9_-]{20,}/g, // Fly.io access token
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\br8_[A-Za-z0-9]{20,}/g, // Replicate
  /\bdapi[a-f0-9]{32,}/g, // Databricks
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/g, // Discord bot token
  // To the END line, or to the end of the text when a cut removed it: a lazy
  // scan per BEGIN with no END was quadratic, and the key's lines leaked.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** `prefix_<long random>` keys (Typesafe-style); the tail must look random, not like a snake_case name. */
const PREFIXED = /\b([A-Za-z]{2,10})_([A-Za-z0-9_.-]{40,})/g;

/** `NAME=value`, `"apiKey": "value"`, `--token value`: keep the name, drop the value. */
const ASSIGNMENT =
  // repetition is bounded ({0,4}, {1,30}): an unbounded (?:[A-Za-z0-9]+[_-])* backtracks quadratically on snake_case runs.
  // A comma does not end the value: `token=abc,def12345` is one secret.
  /((?:[A-Za-z0-9]{1,30}[_-]){0,4}(?:api[_-]?key|apikey|key|token|secret|password|passwd|pwd|auth|credentials?|client[_-]?secret|access[_-]?key)(?:[_-][A-Za-z0-9]{1,30}){0,4}(?:\\?["'])?[ \t]{0,4}[:=][ \t]{0,4}(?:\\?["'])?)([^\s"'`;)\]}\\<>]{8,})/gi;

/**
 * A password-named key: `DB_PASSWORD`, `passwd`, `SMTP_PASS`, `"pass"`,
 * `пароль`, `"password"` (its closing quote too). A bare `pass` is a key only
 * after a name segment (`SMTP_PASS`, `db-pass`) or quoted (`"pass":`): in
 * prose ("tests pass: 5/5") it is the verb, and in `bypass=` part of a word.
 */
const PASSWORD_KEY = String.raw`(?:[A-Za-z0-9]{1,30}[_-]){0,4}(?:password|passwd|passphrase|pwd|(?<=[_-])pass|(?<=["'])pass(?=\\?["'])|пароль)(?:[_-][A-Za-z0-9]{1,30}){0,4}(?:\\?["'])?[ \t]{0,4}[:=][ \t]{0,4}`;

/**
 * A quoted password, however short, spaced or dotted: the whole literal up to
 * the same quote, which may come escaped (`\"`) as it does inside a serialised
 * tool input. The generic rule below needs 8+ chars, stops at a space and
 * spares member access (`a.b`). Runs before the token patterns, so a token
 * inside a password cannot leave the rest of the password behind.
 */
const PASSWORD_QUOTED = new RegExp(String.raw`(${PASSWORD_KEY})(\\?["'])(.{1,200}?)\2`, 'gi');

/** An unquoted password, from one character; a comma does not end it. */
const PASSWORD = new RegExp(String.raw`(${PASSWORD_KEY})([^\s"'\x60;)\]}\\<>]{1,})`, 'gi');

/** `scheme://user:password@host`: keep the user, drop the password. */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/@:]{1,64}:)([^\s@/]{3,})(@)/gi;

/**
 * A `Cookie` / `Set-Cookie` header, as a header line or a JSON field: the whole
 * value goes. The value must open with `name=`, so `cookie: string` in a
 * signature or `{ cookie }` in an object is left alone.
 */
const COOKIE = /(\b(?:Set-)?Cookie(?:\\?["'])?[ \t]{0,4}:[ \t]{0,4}(?:\\?["'])?)([^\s=;"'\\]{1,128}=[^"'\\\r\n]*)/gi;

/** Lengths bounded as RFC 5321 bounds them: an unbounded local part rescans every long `a-b-c` run from each start (30 s on 100 KB). */
const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g;

/** An international number written with its `+`; local numbers are too easily confused with other figures. */
const PHONE = /(?<![\w)+])\+\d{1,3}[-. ]?\(?\d{2,4}\)?[-. ]?\d{3,4}[-. ]?\d{2,4}\b/g;

/** Visa, Mastercard, Amex, Discover, with optional spaces or dashes; kept unless the Luhn check passes. */
const CARD =
  /\b(?:4\d{3}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}|5[1-5]\d{2}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}|3[47]\d{2}[- ]?\d{6}[- ]?\d{5}|6(?:011|5\d{2})[- ]?\d{4}[- ]?\d{4}[- ]?\d{4})\b/g;

/** IBAN of the European and Ukrainian prefixes; kept unless the mod-97 check passes. */
const IBAN =
  /\b(?:UA|DE|GB|FR|IT|ES|PL|NL|BE|AT|CH|CZ|SE|NO|DK|FI|PT|IE|LU|SK|HU|RO|BG|HR|LT|LV|EE|SI|MT|CY|GR|IS|LI|MC|SM|AD|TR|IL)\d{2}[A-Z0-9]{10,30}\b/g;

function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function ibanValid(value: string): boolean {
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const part = code >= 65 ? String(code - 55) : char; // A=10 … Z=35
    for (const digit of part) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Base64 secrets with `/` or `+` (AWS secret access keys and the like), which OPAQUE splits at the slash. */
const BASE64 = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g;

/** `--token value` style flags on command lines; a path after the flag (`--key ~/id.pem`) is kept. */
const FLAG = /(--(?:api-?key|key|token|password|passphrase|pass|secret|auth|client-secret)[=\s]+(?:\\?["'])?)([^\s"'`\\]{4,})/gi;

/** `Bearer <token>` / `Basic <token>` in headers and curl lines. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{16,})/gi;

/** Long opaque strings: at least 32 chars, letters and digits mixed. */
const OPAQUE = /(?<![A-Za-z0-9_\-/.\\])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_\-/.\\])/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a string looks like a random token rather than an id, digest or name. */
export function looksOpaque(s: string): boolean {
  if (UUID.test(s)) return false; // ids, not secrets
  if (/^[0-9a-f]{40}$/i.test(s) || /^[0-9a-f]{64}$/i.test(s)) return false; // git / sha256 digests
  const digits = (s.match(/[0-9]/g) ?? []).length;
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  if (digits < 4 || letters < 8) return false;
  if (digits / s.length < 0.2) {
    // mostly letters: only an identifier-shaped string is exempt
    if (/^[a-z]+(?:[_-][a-z0-9]+)+$/.test(s)) return false; // snake/kebab names
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s)) return false; // CONSTANT_NAMES
  }
  return true;
}

/** Values after `key =` that are code or references, not credentials. */
function looksLikeCode(value: string): boolean {
  return (
    /^(?:true|false|null|undefined|none)$/i.test(value) ||
    /^[$%]/.test(value) || // $VAR, ${VAR}, %VAR%
    /^[/~.]/.test(value) || // paths
    value.includes('(') || // calls: fs.readFileSync(
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[|&?]*[{[]?$/.test(value) // member access: j.mcpOAuth
  );
}

/**
 * A value's own commas count (`token=abc,def12345`), trailing ones do not: in
 * `{ token: process.env.TOKEN, … }` the comma ends the expression.
 */
function splitTrailingCommas(value: string): { secret: string; trailing: string } {
  const secret = value.replace(/,+$/, '');
  return { secret, trailing: value.slice(secret.length) };
}

export type Redaction = { text: string; count: number };

/** Replaces every credential-shaped substring of `text`. */
export function redactSecrets(text: string, known: readonly string[] = []): Redaction {
  let count = 0;
  let out = text;
  for (const secret of known) {
    if (secret.length < 8) continue;
    const parts = out.split(secret);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join(REDACTED);
    }
  }
  out = out.replace(PASSWORD_QUOTED, (m, name: string, quote: string, value: string) => {
    // In double quotes a shell expands `$VAR`; in single quotes it is the literal password.
    if (!quote.endsWith("'") && /^[$%]/.test(value)) return m;
    if (/^(?:true|false|null|undefined|none)$/i.test(value)) return m;
    count++;
    return `${name}${quote}${REDACTED}${quote}`;
  });
  out = out.replace(PASSWORD, (m, name: string, value: string) => {
    const { secret, trailing } = splitTrailingCommas(value);
    if (!secret || secret.includes(REDACTED_HEAD) || /^(?:[$%]|(?:true|false|null|undefined|none)$)/i.test(secret)) return m;
    count++;
    return `${name}${REDACTED}${trailing}`;
  });
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, () => {
      count++;
      return REDACTED;
    });
  }
  out = out.replace(PREFIXED, (m, _prefix: string, tail: string) => {
    if (/\.[a-z]{1,5}$/.test(tail) || !looksOpaque(tail.replace(/\./g, ''))) return m;
    count++;
    return REDACTED;
  });
  out = out.replace(URL_CREDENTIALS, (m, head: string, value: string, at: string) => {
    if (value.includes(REDACTED_HEAD)) return m;
    count++;
    return `${head}${REDACTED}${at}`;
  });
  out = out.replace(COOKIE, (m, head: string, value: string) => {
    if (value.trim() === REDACTED) return m;
    count++;
    return `${head}${REDACTED}`;
  });
  out = out.replace(EMAIL, (m) => {
    if (/^git@/i.test(m)) return m; // an SSH remote, not a person
    count++;
    return REDACTED;
  });
  out = out.replace(CARD, (m) => {
    if (!luhnValid(m)) return m;
    count++;
    return REDACTED;
  });
  out = out.replace(IBAN, (m) => {
    if (!ibanValid(m)) return m;
    count++;
    return REDACTED;
  });
  out = out.replace(PHONE, () => {
    count++;
    return REDACTED;
  });
  out = out.replace(BASE64, (m) => {
    if (!/[/+]/.test(m)) return m; // no slash or plus: OPAQUE decides
    const upper = (m.match(/[A-Z]/g) ?? []).length;
    const lower = (m.match(/[a-z]/g) ?? []).length;
    const digits = (m.match(/[0-9]/g) ?? []).length;
    if (upper < 3 || lower < 3 || digits < 2) return m; // paths and URL routes are rarely mixed case
    const segments = m.split('/').filter(Boolean);
    if (segments.length > 1 && segments.every((s) => /^(?:[A-Za-z]+[0-9]*|v?[0-9]+)$/.test(s))) return m; // /api/v2/GetUserProfile/Settings2024
    count++;
    return REDACTED;
  });
  out = out.replace(AUTH_SCHEME, (_m, scheme: string, value: string) => {
    if (value === REDACTED) return _m;
    count++;
    return `${scheme} ${REDACTED}`;
  });
  out = out.replace(ASSIGNMENT, (m, name: string, value: string) => {
    const { secret, trailing } = splitTrailingCommas(value);
    if (secret.length < 8 || secret.includes(REDACTED_HEAD) || looksLikeCode(secret)) return m;
    count++;
    return `${name}${REDACTED}${trailing}`;
  });
  out = out.replace(FLAG, (m, flag: string, value: string) => {
    if (value.includes(REDACTED_HEAD) || /^[/~]/.test(value)) return m;
    count++;
    return `${flag}${REDACTED}`;
  });
  out = out.replace(OPAQUE, (m) => {
    if (!looksOpaque(m)) return m;
    count++;
    return REDACTED;
  });
  return { text: out, count };
}

