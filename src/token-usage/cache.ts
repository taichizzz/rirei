import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { rireiDataHome } from '../platform/runtime-paths.js';
import { RelayLockError, withDirectoryLock } from '../state/lock.js';
import { CcusageSource, scanTimeoutMs } from './ccusage.js';
import { deriveReportFromCache } from './normalize.js';
import { assertPrivacySafe } from './privacy.js';
import {
  AGENT_REGISTRY,
  AgentIdSchema,
  TokenUsageCacheSchema,
  type AgentCacheSnapshot,
  type AgentId,
  type TokenUsageCache,
  type TokenUsageReport,
} from './schema.js';

export const TOKEN_USAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const CACHE_FILENAME = 'token-usage-cache.json';

export interface GetCachedTokenUsageOptions {
  days?: number;
  timezone?: string;
  forceRefresh?: boolean;
  agent?: AgentId;
  source?: CcusageSource;
  home?: string;
  now?: Date;
  sourceVersion?: string;
  /** How long to wait for a competing scan of the same agent (tests). */
  lockWaitMs?: number;
}

export function cacheFilePath(options: { home?: string } = {}): string {
  const dataDir = rireiDataHome({ home: options.home });
  return path.join(dataDir, CACHE_FILENAME);
}

/**
 * Reads and parses the persistent token-usage cache from disk.
 * Returns null if the file does not exist or fails validation.
 */
export async function readDiskCache(
  dataDir: string,
): Promise<TokenUsageCache | null> {
  const filePath = path.join(dataDir, CACHE_FILENAME);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const valid = TokenUsageCacheSchema.safeParse(parsed);
    return valid.success ? valid.data : null;
  } catch {
    return null;
  }
}

/**
 * Atomically writes the token-usage cache to disk using temp file + rename with mode 0600.
 * Enforces privacy assertions before persisting.
 */
export async function writeDiskCache(
  dataDir: string,
  cache: TokenUsageCache,
): Promise<void> {
  const valid = TokenUsageCacheSchema.parse(cache);
  assertPrivacySafe(valid);

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const destination = path.join(dataDir, CACHE_FILENAME);
  const tempFile = path.join(dataDir, `.${CACHE_FILENAME}.${randomUUID()}.tmp`);

  await writeFile(tempFile, `${JSON.stringify(valid, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(tempFile, destination);
}

function emptyCache(timezone: string, now: Date): TokenUsageCache {
  return {
    schemaVersion: 1,
    timezone,
    updatedAt: now.toISOString(),
    agents: {
      claude: undefined,
      codex: undefined,
      gemini: undefined,
      antigravity: undefined,
      opencode: undefined,
    },
  };
}

/**
 * Daily totals are grouped by the timezone they were collected in and cannot be
 * relabelled for another one, so a cache from a different zone is unusable.
 */
function sameZone(
  cache: TokenUsageCache | null,
  timezone: string,
): TokenUsageCache | null {
  return cache && cache.timezone === timezone ? cache : null;
}

/**
 * Main token-usage entrypoint.
 *
 * Default call reads the cache only (zero subprocesses, instant return).
 * When `forceRefresh: true` is passed, takes machine-wide per-agent file locks,
 * collects 180-day history per agent, writes cache atomically, and returns.
 */
export async function getCachedTokenUsage(
  options: GetCachedTokenUsageOptions = {},
): Promise<TokenUsageReport> {
  const days = options.days && options.days > 0 ? options.days : 30;
  const timezone =
    options.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC';
  const now = options.now ?? new Date();
  const dataDir = rireiDataHome({ home: options.home });

  // 1. Fast path: cache-only read when not forcing refresh
  if (!options.forceRefresh) {
    const effectiveCache =
      sameZone(await readDiskCache(dataDir), timezone) ??
      emptyCache(timezone, now);

    const report = deriveReportFromCache(effectiveCache, {
      days,
      timezone,
      now,
      sourceVersion: options.sourceVersion,
    });
    assertPrivacySafe(report);
    return report;
  }

  // 2. Refresh path: takes machine-wide lock and scans agents
  const source = options.source ?? new CcusageSource();
  const agentsToRefresh: AgentId[] = options.agent
    ? [AgentIdSchema.parse(options.agent)]
    : AGENT_REGISTRY.map((a) => a.id);

  for (const agentId of agentsToRefresh) {
    try {
      await refreshAgent(agentId);
    } catch (error) {
      // Another refresh of this agent outlasted its whole scan budget. Keep the
      // last good snapshot rather than failing every other agent's report.
      if (!(error instanceof RelayLockError)) throw error;
    }
  }

  async function refreshAgent(agentId: AgentId): Promise<void> {
    // A competing refresh may be mid-scan: wait out both of its ccusage calls.
    const waitMs = options.lockWaitMs ?? 2 * scanTimeoutMs(agentId) + 15_000;
    await withDirectoryLock(
      dataDir,
      `token-usage-${agentId}`,
      async () => {
        // Check if another concurrent CLI process already refreshed this agent recently (< 15 seconds)
        const currentCache = sameZone(await readDiskCache(dataDir), timezone);
        const existingSnap = currentCache?.agents[agentId];
        if (existingSnap && existingSnap.status === 'available') {
          const capturedMs = Date.parse(existingSnap.capturedAt);
          if (
            !Number.isNaN(capturedMs) &&
            now.getTime() - capturedMs < 15_000
          ) {
            return; // Already refreshed by competing process; skip scan
          }
        }

        // Collect new snapshot for this agent
        const newSnap = await source.collectAgentSnapshot(agentId, {
          timezone,
          now,
          historyDays: 180,
        });

        // Section 3.7: A failure never overwrites a successful snapshot:
        // keep the last good data, mark it stale, and record the failure code beside it.
        let finalSnap: AgentCacheSnapshot = newSnap;
        if (
          newSnap.status === 'error' &&
          existingSnap &&
          existingSnap.status === 'available'
        ) {
          finalSnap = {
            ...existingSnap,
            errorCode: newSnap.errorCode,
            errorReason: newSnap.errorReason,
          };
        }

        // Atomically update cache file under cache-file lock
        await withDirectoryLock(
          dataDir,
          'token-usage-cache',
          async () => {
            // Snapshots from another timezone are dropped, never mixed in.
            const latestCache =
              sameZone(await readDiskCache(dataDir), timezone) ??
              emptyCache(timezone, now);

            latestCache.agents[agentId] = finalSnap;
            latestCache.updatedAt = now.toISOString();
            await writeDiskCache(dataDir, latestCache);
          },
          { waitMs: 10_000 },
        );
      },
      { waitMs },
    );
  }

  const updatedCache =
    sameZone(await readDiskCache(dataDir), timezone) ??
    emptyCache(timezone, now);

  const report = deriveReportFromCache(updatedCache, {
    days,
    timezone,
    now,
    sourceVersion: options.sourceVersion,
  });
  assertPrivacySafe(report);
  return report;
}
