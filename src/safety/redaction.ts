export interface RedactionSummary {
  kind: string;
  count: number;
}

export interface RedactionResult {
  redactedText: string;
  redactions: RedactionSummary[];
}

interface SecretPattern {
  kind: string;
  regex: RegExp;
  replacement: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    kind: 'private_key',
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY[^-]*-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY[^-]*-----/g,
    replacement: '[REDACTED_SECRET:private_key]',
  },
  {
    kind: 'anthropic_api_key',
    regex: /sk-ant-[a-zA-Z0-9_.-]{20,}/g,
    replacement: '[REDACTED_SECRET:anthropic_api_key]',
  },
  {
    kind: 'openai_api_key',
    regex: /sk-(?!ant-)(?:proj-)?[a-zA-Z0-9_.-]{20,}/g,
    replacement: '[REDACTED_SECRET:openai_api_key]',
  },
  {
    kind: 'google_api_key',
    regex: /AIzaSy[a-zA-Z0-9_-]{33}/g,
    replacement: '[REDACTED_SECRET:google_api_key]',
  },
  {
    kind: 'github_token',
    regex:
      /(?:(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{20,})/g,
    replacement: '[REDACTED_SECRET:github_token]',
  },
  {
    kind: 'slack_token',
    regex: /xox[bpar]-[0-9a-zA-Z]{10,}/g,
    replacement: '[REDACTED_SECRET:slack_token]',
  },
  {
    kind: 'aws_access_key',
    regex: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED_SECRET:aws_access_key]',
  },
  {
    kind: 'auth_header',
    regex:
      /(?:Authorization\s*[:=]\s*(?:Bearer\s+)?|Bearer\s+)[a-zA-Z0-9_.+/=~-]{20,}/gi,
    replacement: '[REDACTED_SECRET:auth_header]',
  },
  {
    kind: 'secret_assignment',
    regex:
      /(?:api_key|apiKey|token|secret|password)\s*[:=]\s*(?:["'`][^"'`]{6,}["'`]|[a-zA-Z0-9_.+/=~-]{12,})/gi,
    replacement: '[REDACTED_SECRET:secret_assignment]',
  },
];

export function scanSecrets(text: string): RedactionSummary[] {
  if (!text || typeof text !== 'string') return [];
  const results: RedactionSummary[] = [];

  for (const pattern of SECRET_PATTERNS) {
    const matches = text.match(pattern.regex);
    if (matches && matches.length > 0) {
      results.push({
        kind: pattern.kind,
        count: matches.length,
      });
    }
  }

  return results;
}

export function redactSecrets(text: string): RedactionResult {
  if (!text || typeof text !== 'string') {
    return { redactedText: text || '', redactions: [] };
  }

  let redactedText = text;
  const redactions: RedactionSummary[] = [];

  for (const pattern of SECRET_PATTERNS) {
    const matches = text.match(pattern.regex);
    if (matches && matches.length > 0) {
      redactions.push({
        kind: pattern.kind,
        count: matches.length,
      });
      redactedText = redactedText.replace(pattern.regex, pattern.replacement);
    }
  }

  return { redactedText, redactions };
}

export function assertNoSecrets(
  text: string,
  allowRedact = false,
): { cleanText: string; redactions: RedactionSummary[] } {
  const detected = scanSecrets(text);
  if (detected.length === 0) {
    return { cleanText: text, redactions: [] };
  }

  if (!allowRedact) {
    const kinds = detected.map((d) => `${d.kind} (${d.count})`).join(', ');
    throw new Error(
      `Message contains sensitive secrets: ${kinds}. Use --redact to replace secrets before sending.`,
    );
  }

  const result = redactSecrets(text);
  return { cleanText: result.redactedText, redactions: result.redactions };
}
