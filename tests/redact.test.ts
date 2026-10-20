import { describe, expect, it } from 'vitest';

import { jevAsker } from '../hooks/fast-jev.js';
import { REDACTED, redactDeep, redactSecrets } from '../src/redact.js';
import type { JevQuestions } from '../src/types.js';

// Fake credentials, assembled at run time so no credential-shaped literal sits in the repo.
const j = (...parts: string[]) => parts.join('');
const SECRETS = {
  anthropic: j('sk-', 'ant-oat01-', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'),
  openrouter: j('sk-', 'or-v1-', '0123456789abcdef'.repeat(3)),
  ghlPit: j('pit', '-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d'),
  github: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  jwt: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
  prefixed: j('TSAFE', '_', '9F3A77B0C1D2E3F405162738495A6B7C8D9E0F1A2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4'),
  opaque: j('Zx9Qw8Er7Ty6Ui5', 'Op4As3Df2Gh1Jk0LzXcVbNm'),
};

describe('redactSecrets', () => {
  it.each(Object.entries(SECRETS))('removes a %s credential in prose, commands and JSON', (_name, secret) => {
    for (const text of [
      secret,
      `use ${secret} here`,
      `curl -H "Authorization: Bearer ${secret}" https://x`,
      `API_KEY=${secret}`,
      JSON.stringify({ command: `echo ${secret}` }),
    ]) {
      const out = redactSecrets(text);
      expect(out.text).not.toContain(secret);
      expect(out.count).toBeGreaterThan(0);
    }
  });

  it('keeps the name of an assignment and drops only the value', () => {
    expect(redactSecrets('DB_PASSWORD=hunter2hunter2').text).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(redactSecrets('--token abcdefgh12345678').text).toBe(`--token ${REDACTED}`);
  });

  it('replaces known values exactly, whatever their shape', () => {
    expect(redactSecrets('key is plainwordsecret!', ['plainwordsecret!']).text).toBe(`key is ${REDACTED}`);
  });

  it.each([
    'see project_fast_jev_compaction_review_2026-09-23.md now',
    'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1',
    'session 7ed8c43a-fcaf-4df7-8c30-9d1c74a0afcd',
    'commit e3f262a0000000000000000000000000000000ab',
    'const key = fs.readFileSync(path)',
    'token=$TYPESAFE_API_KEY',
    'C:\\Users\\Sam Bell\\projects\\jev-integration\\compaction-pilot\\fast-jev-compaction',
    'The quick brown fox jumps over the lazy dog, twice a week.',
  ])('leaves non-secrets alone: %s', (text) => {
    const out = redactSecrets(text);
    expect(out.text).toBe(text);
    expect(out.count).toBe(0);
  });

  it('redacts every string inside nested values without mutating the input', () => {
    const input = { a: [{ cmd: `x ${SECRETS.ghlPit}` }], n: 3 };
    const { value, count } = redactDeep(input);
    expect(JSON.stringify(value)).not.toContain(SECRETS.ghlPit);
    expect(count).toBe(1);
    expect(input.a[0]!.cmd).toContain(SECRETS.ghlPit);
  });
});

describe('redactSecrets review fixes', () => {
  it('stays fast on ~100KB of snake_case text (no quadratic backtracking)', () => {
    for (const unit of ['a1b2c3d4e5_', 'SOME_ENV_NAME_', 'key_', 'x-']) {
      const text = unit.repeat(Math.ceil(100_000 / unit.length));
      const started = Date.now();
      redactSecrets(text);
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  it('drops the password from URL credentials and keeps the user', () => {
    const url = j('https://svcuser:', 'Tr0ub4dor&3xtraLong', 'RandomPasswordValue1', '@db.example.com:5432/mydb');
    const out = redactSecrets(`curl ${url}`);
    expect(out.text).toBe(`curl https://svcuser:${REDACTED}@db.example.com:5432/mydb`);
  });

  it('removes base64 secrets that contain a slash or plus', () => {
    const aws = j('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYFAKEKEY9');
    const out = redactSecrets(`the deploy script printed: ${aws} -- copy it`);
    expect(out.text).not.toContain(aws);
  });

  it.each([
    'GET api/v1/users/12345/orders/67890/items/abcdef',
    'open docs/guides/getting-started/install/windows/step2',
    'https://github.com/tamaratran/fast-jev-compaction/issues/89',
    'see /fleet/shared/scripts/checks/tier_env_ctx_window.cjs',
    'GET /api/v2/Users/GetUserProfile/AccountSettings2024',
  ])('base64 rule leaves paths and routes alone: %s', (text) => {
    expect(redactSecrets(text).text).toBe(text);
  });
});

describe('jevAsker', () => {
  it('sends no secret in the request body, keeps the API key in the header only', async () => {
    const ownKey = j('my-own-', 'api-key-123456');
    let sent: { body?: string; headers?: Record<string, string> } = {};
    const asker = jevAsker(
      async (_url, init) => {
        sent = init ?? {};
        return { status: 200, ok: true, text: JSON.stringify({ answers: {} }) };
      },
      ownKey,
      'jev-latest',
    );
    await asker.ask(
      { goal: `deploy with ${SECRETS.openrouter} and ${ownKey}` } as never,
      { call_t1: { type: 'noul', instructions: `input was ${SECRETS.anthropic}` } } as never,
    );
    for (const secret of [SECRETS.openrouter, SECRETS.anthropic, ownKey]) {
      expect(sent.body).not.toContain(secret);
    }
    expect(sent.headers?.authorization).toBe(`Bearer ${ownKey}`);
    expect(() => JSON.parse(sent.body ?? '')).not.toThrow();
  });

  it('redacts a shared state once across batches and counts it once', async () => {
    const bodies: string[] = [];
    const counts: number[] = [];
    const asker = jevAsker(
      async (_url, init) => {
        bodies.push(init?.body ?? '');
        return { status: 200, ok: true, text: JSON.stringify({ answers: {} }) };
      },
      'k'.repeat(16),
      'jev-latest',
      (count) => counts.push(count),
    );
    const state = { goal: `use ${SECRETS.github}` };
    const question: JevQuestions = { call_t1: { type: 'noul', instructions: 'keep?' } };
    await asker.ask(state, question);
    await asker.ask(state, question);
    expect(counts).toEqual([1]);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).not.toContain(SECRETS.github);
    await asker.ask({ goal: `and ${SECRETS.jwt}` }, question);
    expect(counts).toEqual([1, 1]);
  });
});

describe('redaction bypasses found in review', () => {
  const secret = j('hunter2', 'hunter2');
  it.each([
    ['an assignment inside a serialised tool input', JSON.stringify({ command: `export DB_PASSWORD="${secret}" && psql` })],
    ['a flag value inside a serialised tool input', JSON.stringify({ command: `mysql --password "${secret}" db` })],
    ['a short password', `password=${j('hun', 'ter2')}`],
    ['a dotted password', `password=${j('short', '.secret')}`],
    ['a lowercase bearer token', `authorization: bearer ${j('abcdefghij', 'klmnopqrstuvwxyz0123')}`],
    ['a Stripe secret key', `STRIPE=${j('sk_', 'live_', 'aB3dE6gH9jK2mN5pQ8sT1vW4')}`],
  ])('redacts %s, exactly once', (_name, text) => {
    const out = redactSecrets(text);
    expect(out.count).toBe(1);
    expect(out.text).toContain(REDACTED);
    expect(out.text).not.toContain(`${REDACTED}]`);
    expect(out.text).not.toMatch(/hunter2|ter2|\.secret|klmnop|aB3dE6/);
  });

  it('leaves environment references and placeholders alone', () => {
    for (const text of ['password=$DB_PASSWORD', 'password=%PASS%', 'password=none']) {
      expect(redactSecrets(text).count).toBe(0);
    }
  });
});

describe('password literals found in the second review', () => {
  const S = (command: string) => JSON.stringify({ command });
  it.each([
    ['a one-to-three-char password', 'password=abc', /abc/],
    ['a short dotted password', 'password=a.b', /a\.b/],
    ['a space-separated password flag', S(`mysql --password ${j('hun', 'ter2')} db`), /hunter2/],
    ['a single-quoted password with a space', S(`DB_PASSWORD='abc ${j('tail', 'secret')}' psql`), /abc|tailsecret/],
    ['a double-quoted password with a space', S(`DB_PASSWORD="hello ${j('wor', 'ld')}" psql`), /hello|world/],
    ['a password starting with a newline', S(`DB_PASSWORD="\n${j('hun', 'ter2')}\n" psql`), /hunter2/],
    ['a token inside a password', `password=${j('hunter2-', 'sk-test-', 'abcdefghijklmnop')}`, /hunter2|abcdefghijklmnop/],
    ['a single-quoted literal starting with $', S(`export DB_PASSWORD='$${j('literal', 'Secret')}'`), /literalSecret/],
    ['a JSON password field with a space', `{"password": "${j('s3cr3t', ' value')}"}`, /s3cr3t/],
  ])('redacts %s, exactly once', (_name, text, leak) => {
    const out = redactSecrets(text);
    expect(out.count).toBe(1);
    expect(out.text).not.toMatch(leak);
    expect(out.text).not.toContain(`${REDACTED}]`);
  });

  it('keeps a double-quoted environment reference, which the shell expands', () => {
    expect(redactSecrets(JSON.stringify({ command: 'export DB_PASSWORD="$DB_PASS"' })).count).toBe(0);
  });
});

// Shapes from llm-security-proxy's catalogue (src/security/patterns.rs), assembled at run time.
const SERVICE_TOKENS = {
  awsTemporary: j('AS', 'IA', 'ABCDEFGHIJKLMNOP'),
  sendgrid: j('SG', '.', 'AbCdEfGh1234IjKlMnOp56', '.', 'QrStUvWx7890YzAbCdEf1234GhIjKlMnOp5678QrS'),
  vault: j('hv', 's.', 'CAESIAbCdEfGh1234IjKlMnOp5678'),
  doppler: j('dp', '.pt.', 'AbCd1234EfGh5678IjKl90'),
  telegram: j('123456789', ':A', 'AbCd1234EfGh5678IjKl90MnOp1234QrSt5'),
  npm: j('np', 'm_', 'AbCd1234EfGh5678IjKl90MnOp1234QrSt'),
  pypi: j('pypi-', 'AgEIcHlwaS5vcmc', 'AbCd1234'.repeat(7)),
  mailgun: j('ke', 'y-', '0123456789abcdef0123456789ABCDEF'),
  newRelic: j('NR', 'AK-', 'ABCDEFGHIJ0123456789KLMNOPQ'),
  digitalOcean: j('do', 'p_v1_', 'a1b2c3d4'.repeat(8)),
  gitlab: j('gl', 'pat-', 'AbCd1234EfGh5678IjKl'),
  stripeWebhook: j('wh', 'sec_', 'AbCd1234EfGh5678IjKl90'),
  huggingFace: j('h', 'f_', 'AbCdEfGhIjKlMnOpQrSt12'),
  grafana: j('gl', 'sa_', 'AbCd1234'.repeat(4), '_a1b2c3d4'),
  shopify: j('shp', 'at_', 'a1b2c3d4'.repeat(4)),
  linear: j('lin', '_api_', 'AbCd1234'.repeat(3)),
  postman: j('PM', 'AK-', '0123456789abcdef01234567-', 'AbCd1234'.repeat(4)),
  flyDeploy: j('Fly', 'V1 fm2_', 'AbCd1234'.repeat(4)),
  flyAccess: j('fo', '1_', 'AbCd1234'.repeat(3)),
  groq: j('gs', 'k_', 'AbCd1234'.repeat(4)),
  replicate: j('r', '8_', 'AbCd1234'.repeat(4)),
  databricks: j('da', 'pi', '0123456789abcdef'.repeat(2)),
};

describe('redaction gaps found in the 0.4.1 audit', () => {
  it.each(Object.entries(SERVICE_TOKENS))('removes a %s token in prose and in a serialised tool input', (_name, token) => {
    for (const text of [`use ${token} here`, JSON.stringify({ command: `deploy ${token}` })]) {
      const out = redactSecrets(text);
      expect(out.text).not.toContain(token);
      expect(out.count).toBeGreaterThan(0);
    }
  });

  const hex40 = '9c2e'.repeat(10);
  it.each([
    ['a PASS-named variable', `SMTP_PASS=${j('abc', '12345')}`, /abc12345/],
    ['a PASS-named JSON field', `{"DB_PASS": "${j('hunter', '22')}"}`, /hunter22/],
    ['a quoted pass key in a login body', JSON.stringify({ command: `curl -d '{"user":"admin","pass":"${j('hun', 'ter22')}"}' https://x` }), /hunter22/],
    ['a passphrase', `passphrase: ${j('correct', 'horse')}`, /correcthorse/],
    ['a Ukrainian password key', `пароль: ${j('qwe', 'rty123')}`, /qwerty123/],
    ['a token with a comma inside', `token=${j('abc,', 'def12345')}`, /def12345/],
    ['a hex credential after --key', `deploy --key ${hex40}`, /9c2e9c2e/],
    ['a password flag', `unzip --pass ${j('s3cr', 'et99')} a.zip`, /s3cret99/],
    ['a cookie header in a curl command', JSON.stringify({ command: `curl -H "Cookie: session=${j('4f9a', '2b7c1d8e')}" https://x` }), /4f9a2b7c/],
    ['a cookie JSON field', `{"Cookie": "sid=${j('4f9a', '2b7c1d8e')}; theme=dark"}`, /4f9a2b7c|theme/],
    ['a short URL password', `postgres://app:${j('pw', '1')}@db:5432/x`, /pw1/],
    ['an email address', `contact ${j('john.doe', '@acme.com')} today`, /john\.doe/],
    ['an international phone number', `call ${j('+1 415 ', '555 0101')} now`, /555 0101/],
    ['a card number that passes Luhn', `card ${j('4111 1111 ', '1111 1111')}`, /1111 1111$/],
    ['an IBAN that passes mod-97', `pay to ${j('GB82WEST', '12345698765432')}`, /GB82WEST/],
  ])('redacts %s', (_name, text, leak) => {
    const out = redactSecrets(text);
    expect(out.count).toBeGreaterThan(0);
    expect(out.text).not.toMatch(leak);
  });

  it.each([
    'bypass=true',
    'compass=north123',
    'If tests pass: ship it',
    'const create = (cookie: string, payload: object) => post(payload)',
    'fetch(url, { headers: { cookie }, method })',
    'ssh --key ~/.ssh/id_ed25519 host',
    'openssl --key /etc/ssl/private/server.pem',
    'git push git@github.com:Lexus2016/fast-jev-compaction.git main',
    'const cfg = { token: process.env.TOKEN, retries: 3 }',
    'card 4111 1111 1111 1112',
    'IBAN GB82WEST12345698765433',
    'x+12345678 is a sum',
    'version 1.2.3+build.45',
  ])('leaves non-secrets alone: %s', (text) => {
    const out = redactSecrets(text);
    expect(out.text).toBe(text);
    expect(out.count).toBe(0);
  });

  it('keeps trailing commas outside the redaction', () => {
    expect(redactSecrets(`token=${j('abc,', 'def12345')},`).text).toBe(`token=${REDACTED},`);
  });

  it('removes the rest of a private key whose END line was cut off', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7aB3dE6gH9jK2mN5pQ8sT1vW4';
    const cut = JSON.stringify({ content: `-----BEGIN ${'PRIVATE'} KEY-----\n${body}\n${body}` }).slice(0, -2);
    const out = redactSecrets(cut);
    expect(out.text).not.toContain(body.slice(0, 20));
  });

  it('scans BEGIN markers without an END in linear time', () => {
    const time = (size: number): number => {
      const text = `-----BEGIN ${'PRIVATE'} KEY-----\n`.repeat(Math.floor(size / 28));
      const started = performance.now();
      redactSecrets(text);
      return performance.now() - started;
    };
    time(50_000); // warm up
    const small = Math.max(time(200_000), 1);
    const large = time(800_000);
    expect(large / small).toBeLessThan(10); // quadratic would be ~16x
  });
});
