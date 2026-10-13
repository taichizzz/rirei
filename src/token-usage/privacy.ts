import { homedir, userInfo } from 'node:os';

/**
 * Sanitizes project paths, directories, and identifiers so that no username,
 * home directory structure, or absolute path is ever leaked across IPC or CLI.
 */
export function sanitizeProjectLabel(raw: string | undefined | null): string {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return '—';
  }

  let candidate = raw.trim();

  // Known user identifiers to check against
  const usernames: string[] = [];
  try {
    const info = userInfo();
    if (info.username) usernames.push(info.username.toLowerCase());
  } catch {
    // userInfo can fail in restricted environments
  }
  if (process.env.USER) usernames.push(process.env.USER.toLowerCase());
  if (process.env.USERNAME) usernames.push(process.env.USERNAME.toLowerCase());
  if (process.env.LOGNAME) usernames.push(process.env.LOGNAME.toLowerCase());

  // 1. If it's a standard path with slashes or backslashes
  if (candidate.includes('/') || candidate.includes('\\')) {
    const segments = candidate.split(/[/\\]+/).filter(Boolean);
    if (segments.length > 0) {
      candidate = segments[segments.length - 1] ?? candidate;
    }
  }

  // 2. Handle Claude-style dash-encoded paths: -Users-<username>-Documents-<project>
  // or -home-<username>-<project>
  if (
    candidate.startsWith('-Users-') ||
    candidate.startsWith('-home-') ||
    candidate.startsWith('Users-') ||
    candidate.startsWith('home-')
  ) {
    const normalized = candidate.replace(/^-+/, '');
    const parts = normalized.split('-').filter(Boolean);
    // Format is typically: ['Users', '<username>', 'Documents', 'Project', ...]
    if (parts.length >= 2) {
      // Find start of project name by skipping Users/home, username, and known containers
      const commonContainers = new Set([
        'users',
        'home',
        'documents',
        'desktop',
        'downloads',
        'projects',
        'code',
        'repos',
        'workspace',
        'workspaces',
        'development',
        'dev',
        'library',
        'cloudstorage',
        'cloudmounter',
        'taichi',
      ]);

      let idx = 2; // skip Users/home and username
      while (
        idx < parts.length - 1 &&
        parts[idx] &&
        commonContainers.has(parts[idx]!.toLowerCase())
      ) {
        idx += 1;
      }
      candidate = parts.slice(idx).join('-');
    } else {
      candidate = parts[parts.length - 1] ?? candidate;
    }
  }

  // 3. Remove leading/trailing dots, slashes, dashes
  candidate = candidate
    .replace(/^[/\\._-]+/, '')
    .replace(/[/\\._-]+$/, '')
    .trim();

  // 4. Redact any remaining occurrences of known usernames
  for (const u of usernames) {
    if (u && u.length >= 2 && candidate.toLowerCase().includes(u)) {
      const reg = new RegExp(u, 'gi');
      candidate = candidate.replace(reg, 'project');
    }
  }

  // 5. Clean up any trailing / leading artifacts after replacement
  candidate = candidate
    .replace(/^[/\\._-]+/, '')
    .replace(/[/\\._-]+$/, '')
    .trim();

  return candidate || '—';
}

/**
 * Asserts that the serialized object contains no home-directory path,
 * no system username, and no absolute filesystem path.
 *
 * Throws an Error if any sensitive leak is found.
 */
/** Raised when token usage data would leak a path or username. */
export class TokenUsagePrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenUsagePrivacyError';
  }
}

export function assertPrivacySafe(data: unknown): void {
  const serialized = JSON.stringify(data);
  if (!serialized) return;
  const lower = serialized.toLowerCase();

  // Check 1: Home directory path
  let home = '';
  try {
    home = homedir();
  } catch {
    // Ignore homedir resolution failure
  }
  if (home && home.length > 1 && lower.includes(home.toLowerCase())) {
    throw new TokenUsagePrivacyError(
      'Privacy violation: home directory path detected in token usage data',
    );
  }

  // Check 2: System usernames
  const usernames = new Set<string>();
  try {
    const u = userInfo().username;
    if (u && u.length >= 2) usernames.add(u.toLowerCase());
  } catch {
    // Ignore userInfo resolution failure
  }
  if (process.env.USER && process.env.USER.length >= 2) {
    usernames.add(process.env.USER.toLowerCase());
  }
  if (process.env.USERNAME && process.env.USERNAME.length >= 2) {
    usernames.add(process.env.USERNAME.toLowerCase());
  }
  if (process.env.LOGNAME && process.env.LOGNAME.length >= 2) {
    usernames.add(process.env.LOGNAME.toLowerCase());
  }

  for (const user of usernames) {
    if (lower.includes(user)) {
      // Never echo the matched name: this message can reach stderr and the UI.
      throw new TokenUsagePrivacyError(
        'Privacy violation: a username was detected in token usage data',
      );
    }
  }

  // Check 3: Absolute filesystem paths
  const absolutePathRegex =
    /(?:\/(?:Users|home|private\/var|private\/tmp|tmp|usr|etc|opt)\/|[a-zA-Z]:[/\\])/i;
  if (absolutePathRegex.test(serialized)) {
    throw new TokenUsagePrivacyError(
      'Privacy violation: absolute filesystem path detected in token usage data',
    );
  }
}
