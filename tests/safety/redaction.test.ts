import { describe, expect, it } from 'vitest';
import {
  assertNoSecrets,
  redactSecrets,
  scanSecrets,
} from '../../src/safety/redaction.js';

describe('redaction safety', () => {
  it('scans and detects multiple secret kinds', () => {
    const text = [
      'Here is Anthropic key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
      'Here is OpenAI key: sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
      'Here is GitHub token: ghp_1234567890abcdefghijklmnopqrstuvwxyz12',
      'Here is Slack token: xoxb-1234567890-abcdefghij',
      'Here is AWS key: AKIAIOSFODNN7EXAMPLE',
      'Here is Auth: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'Here is assignment: api_key = "secret_password_value"',
    ].join('\n');

    const secrets = scanSecrets(text);
    expect(secrets.map((s) => s.kind)).toEqual([
      'anthropic_api_key',
      'openai_api_key',
      'github_token',
      'slack_token',
      'aws_access_key',
      'auth_header',
      'secret_assignment',
    ]);
  });

  it('detects modern tokens, encrypted keys, bearer tokens, and env assignments', () => {
    const text = [
      `github_pat_${'a'.repeat(40)}`,
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nabc\n-----END ENCRYPTED PRIVATE KEY-----',
      `Bearer ${'b'.repeat(32)}`,
      `API_KEY=${'c'.repeat(32)}`,
    ].join('\n');
    expect(scanSecrets(text).map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        'github_token',
        'private_key',
        'auth_header',
        'secret_assignment',
      ]),
    );
  });

  it('redacts detected secrets deterministically', () => {
    const text =
      'Key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456 and AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(text);
    expect(result.redactedText).toBe(
      'Key is [REDACTED_SECRET:anthropic_api_key] and [REDACTED_SECRET:aws_access_key]',
    );
    expect(result.redactions).toEqual([
      { kind: 'anthropic_api_key', count: 1 },
      { kind: 'aws_access_key', count: 1 },
    ]);
  });

  it('fails closed when assertNoSecrets finds secrets and allowRedact is false', () => {
    const text = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz12';
    expect(() => assertNoSecrets(text, false)).toThrow(
      /contains sensitive secrets/,
    );
  });

  it('replaces secrets when assertNoSecrets is called with allowRedact true', () => {
    const text = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz12';
    const result = assertNoSecrets(text, true);
    expect(result.cleanText).toBe('[REDACTED_SECRET:github_token]');
    expect(result.redactions).toHaveLength(1);
  });

  it('leaves clean text unchanged', () => {
    const text =
      'Just a normal coordination message about fixing test failures.';
    const result = assertNoSecrets(text, false);
    expect(result.cleanText).toBe(text);
    expect(result.redactions).toEqual([]);
  });
});
