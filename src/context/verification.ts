import { createHash, randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { RelayState } from '../state/schema.js';
import { updateState } from '../state/store.js';
import { activeLeases } from '../state/leases.js';
import { redactSecrets } from '../safety/redaction.js';
import { inspectCoveredSnapshot, type SnapshotLimits } from './snapshot.js';
import type { SnapshotIdentity } from './snapshot-schema.js';
import {
  MAX_VERIFICATION_RECEIPTS,
  verificationEnvironmentSchema,
  verificationReceiptSchema,
  type VerificationEnvironment,
  type VerificationReceipt,
} from './verification-schema.js';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export type VerificationFreshness =
  'historical' | 'pending' | 'stale' | 'current-observation' | 'reuse-eligible';
export interface VerificationSummary {
  receiptId: string | null;
  command: string;
  outcome: 'passed' | 'failed' | 'unknown';
  exitCode: number | null;
  freshness: VerificationFreshness;
  reasons: string[];
  scope: string | null;
  observedAt: string;
}
/** Only an in-memory host-qualified fixture can supply this. No current CLI accepts or creates it. */
export interface TrustedVerificationScope {
  receiptId: string;
  snapshotId: string;
  environmentId: string;
  commandDigest: string;
  deterministic: true;
  dependencyInputsCovered: true;
  ignoredInputsCovered: true;
  environmentInputsCovered: true;
  toolchainInputsCovered: true;
  externalState: 'none';
  clock: 'controlled';
  randomness: 'controlled';
  interval: 'sealed';
}

export function verificationCommand(command: string) {
  const cleaned = redactSecrets(stripVTControlCharacters(command));
  let text = cleaned.redactedText.slice(0, 4096);
  if (/^[\uD800-\uDBFF]$/.test(text.slice(-1))) text = text.slice(0, -1);
  return {
    text: text || '(empty command)',
    digest: digest(cleaned.redactedText),
    redacted: cleaned.redactions.length > 0,
    truncated: cleaned.redactedText.length > text.length,
  };
}

function allowedEnvironmentValue(name: string, value: string): boolean {
  if (/\p{Cc}/u.test(value)) return false;
  if (value === '') return true;
  if (name === 'NODE_ENV')
    return ['development', 'production', 'test'].includes(value);
  if (name === 'CI') return /^(?:true|false|yes|no|0|1)$/i.test(value);
  if (name === 'TZ') {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }
  return /^(?:C|POSIX|[a-z]{2,3}(?:_[A-Z]{2})?)(?:\.(?:UTF-?8|US-ASCII|ISO8859-?\d{1,2}))?(?:@(?:latin|cyrillic|euro))?$/i.test(
    value,
  );
}

export function captureVerificationEnvironment(
  snapshot: SnapshotIdentity,
  options: {
    env?: NodeJS.ProcessEnv;
    host?: {
      nodeVersion: string;
      platform: string;
      arch: string;
      executablePathDigest: string;
    };
  } = {},
): VerificationEnvironment {
  const env = options.env ?? process.env;
  const host = options.host ?? {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    executablePathDigest: digest(process.execPath),
  };
  const values = (['NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'CI'] as const).map(
    (name) => {
      const raw = env[name];
      const cleaned =
        raw === undefined || raw.length > 160 ? null : redactSecrets(raw);
      const withheld =
        raw !== undefined &&
        (!cleaned ||
          cleaned.redactions.length > 0 ||
          !allowedEnvironmentValue(name, raw));
      return {
        name,
        present: raw !== undefined,
        value: withheld ? null : (cleaned?.redactedText ?? null),
        withheld,
      };
    },
  );
  const body = {
    schemaVersion: 1 as const,
    algorithm: 'rirei-host-test-environment-v1' as const,
    host,
    values,
    dependencyDigest: snapshot.dependencyDigest,
    dependencyCoverage: 'manifest-only' as const,
    coverage: 'partial' as const,
    unmeasured: [
      'installed-dependency-content',
      'ignored-or-generated-inputs',
      'external-service-state',
      'test-tool-versions',
      'environment-outside-allowlist',
      'clock-and-randomness',
      'between-boundary-mutations',
      ...(values.some((value) => value.withheld)
        ? ['withheld-allowlisted-values']
        : []),
    ],
  };
  const canonical = verificationEnvironmentSchema
    .omit({ id: true })
    .parse(body);
  return verificationEnvironmentSchema.parse({
    ...canonical,
    id: digest(JSON.stringify(canonical)),
  });
}

export function sealVerificationReceipt(
  value: Omit<VerificationReceipt, 'hash'>,
): VerificationReceipt {
  const body = verificationReceiptSchema.omit({ hash: true }).parse(value);
  return verificationReceiptSchema.parse({
    ...body,
    hash: digest(JSON.stringify(body)),
  });
}

function receiptIntegrityMatches(receipt: VerificationReceipt): boolean {
  const { hash, ...body } = receipt;
  return digest(JSON.stringify(body)) === hash;
}

export function classifyVerification(
  value: unknown,
  currentSnapshot?: SnapshotIdentity,
  currentEnvironment?: VerificationEnvironment,
  options: {
    expectedCommand?: string | null;
    trustedScope?: TrustedVerificationScope;
  } = {},
): { freshness: VerificationFreshness; reasons: string[] } {
  const parsed = verificationReceiptSchema.safeParse(value);
  if (!parsed.success)
    return {
      freshness: 'historical',
      reasons: ['qualified-receipt-unavailable'],
    };
  const receipt = parsed.data;
  if (!receiptIntegrityMatches(receipt))
    return { freshness: 'historical', reasons: ['receipt-integrity-mismatch'] };
  if (receipt.status === 'pending')
    return { freshness: 'pending', reasons: ['completion-not-observed'] };
  if (
    receipt.status !== 'completed' ||
    !receipt.endSnapshot ||
    !receipt.endEnvironment ||
    !receipt.endedAt ||
    receipt.exitCode === undefined ||
    receipt.exitCode === null
  )
    return {
      freshness: 'historical',
      reasons: ['complete-result-unavailable'],
    };
  if (
    options.expectedCommand !== undefined &&
    receipt.scope.kind === 'configured-tests' &&
    (!options.expectedCommand ||
      verificationCommand(options.expectedCommand).digest !==
        receipt.command.digest)
  )
    return { freshness: 'stale', reasons: ['configured-command-changed'] };
  if (
    receipt.startSnapshot.id !== receipt.endSnapshot.id ||
    receipt.startEnvironment.id !== receipt.endEnvironment.id
  )
    return {
      freshness: 'stale',
      reasons: ['inputs-changed-during-verification'],
    };
  if (
    currentSnapshot &&
    (receipt.endSnapshot.workspaceId !== currentSnapshot.workspaceId ||
      receipt.endSnapshot.id !== currentSnapshot.id)
  )
    return { freshness: 'stale', reasons: ['current-input-identity-differs'] };
  if (currentEnvironment && receipt.endEnvironment.id !== currentEnvironment.id)
    return { freshness: 'stale', reasons: ['observed-environment-differs'] };
  if (
    !currentSnapshot ||
    !currentEnvironment ||
    [receipt.startSnapshot, receipt.endSnapshot, currentSnapshot].some(
      (snapshot) => snapshot.coverage.status !== 'complete',
    )
  )
    return {
      freshness: 'historical',
      reasons: ['covered-input-identity-incomplete'],
    };
  const trusted = options.trustedScope;
  if (
    receipt.exitCode === 0 &&
    !receipt.command.redacted &&
    !receipt.command.truncated &&
    trusted &&
    trusted.receiptId === receipt.id &&
    trusted.snapshotId === currentSnapshot.id &&
    trusted.environmentId === currentEnvironment.id &&
    trusted.commandDigest === receipt.command.digest &&
    [
      receipt.startEnvironment,
      receipt.endEnvironment,
      currentEnvironment,
    ].every((environment) =>
      environment.values.every((value) => !value.withheld),
    ) &&
    trusted.deterministic === true &&
    trusted.dependencyInputsCovered === true &&
    trusted.ignoredInputsCovered === true &&
    trusted.environmentInputsCovered === true &&
    trusted.toolchainInputsCovered === true &&
    trusted.externalState === 'none' &&
    trusted.clock === 'controlled' &&
    trusted.randomness === 'controlled' &&
    trusted.interval === 'sealed'
  )
    return {
      freshness: 'reuse-eligible',
      reasons: ['explicit-host-qualified-deterministic-scope'],
    };
  return {
    freshness: 'current-observation',
    reasons: [
      'matching-covered-boundaries',
      'environment-partially-observed',
      'intervening-mutations-not-proven-absent',
    ],
  };
}

export async function beginVerification(
  root: string,
  taskId: string,
  command: string,
  options: { snapshotLimits?: Partial<SnapshotLimits> } = {},
): Promise<VerificationReceipt> {
  const snapshot = await inspectCoveredSnapshot(root, options.snapshotLimits);
  const receipt = sealVerificationReceipt({
    schemaVersion: 1,
    id: randomUUID(),
    taskId,
    source: 'relay-command',
    status: 'pending',
    command: verificationCommand(command),
    workingDirectory: snapshot.workspace,
    scope: { kind: 'configured-tests', label: null },
    startedAt: new Date().toISOString(),
    startSnapshot: snapshot.identity,
    startEnvironment: captureVerificationEnvironment(snapshot.identity),
    output: 'not-captured',
  });
  await updateState(root, (current) => {
    if (
      current.sessionId !== taskId ||
      !['active', 'blocked'].includes(current.task.status) ||
      activeLeases(current).length
    )
      throw new Error('Verification task or ownership changed before launch.');
    const existing = [...(current.verificationReceipts ?? [])];
    while (existing.length >= MAX_VERIFICATION_RECEIPTS) {
      const index = existing.findIndex((item) => item.status !== 'pending');
      if (index < 0)
        throw new Error('Unresolved verification receipt limit reached.');
      existing.splice(index, 1);
    }
    return { ...current, verificationReceipts: [...existing, receipt] };
  });
  return receipt;
}

export async function completeVerification(
  root: string,
  started: VerificationReceipt,
  exitCode: number | null,
  durationMs: number,
  options: {
    interrupted?: boolean;
    snapshotLimits?: Partial<SnapshotLimits>;
  } = {},
): Promise<VerificationReceipt> {
  const { hash: priorHash, ...body } = started;
  if (
    started.status !== 'pending' ||
    !priorHash ||
    sealVerificationReceipt(body).hash !== priorHash
  )
    throw new Error('Verification start receipt is missing or changed.');
  const endedAt = new Date().toISOString();
  const snapshot = await inspectCoveredSnapshot(root, options.snapshotLimits);
  const receipt = sealVerificationReceipt({
    ...body,
    status:
      options.interrupted || exitCode === null ? 'interrupted' : 'completed',
    endedAt,
    exitCode,
    durationMs,
    endSnapshot: snapshot.identity,
    endEnvironment: captureVerificationEnvironment(snapshot.identity),
  });
  await updateState(root, (current) => {
    if (current.sessionId !== started.taskId)
      throw new Error('Verification task changed before result recording.');
    const pending = current.verificationReceipts?.find(
      (item) => item.id === started.id,
    );
    if (!pending || pending.status !== 'pending' || pending.hash !== priorHash)
      throw new Error('Verification receipt changed before result recording.');
    return {
      ...current,
      task: { ...current.task, updatedAt: endedAt },
      verificationReceipts: current.verificationReceipts!.map((item) =>
        item.id === receipt.id ? receipt : item,
      ),
      tests: [
        ...current.tests,
        {
          command: started.command.text,
          status:
            receipt.status === 'completed' && exitCode === 0
              ? 'passed'
              : 'failed',
          exitCode,
          durationMs,
          createdAt: receipt.endedAt!,
          verificationReceiptId: receipt.id,
          ...(receipt.status === 'interrupted'
            ? {
                summary:
                  'Verification interrupted; complete test result unknown.',
              }
            : {}),
        },
      ],
    };
  });
  return receipt;
}

export async function inspectVerificationState(
  state: RelayState,
  workspace: string,
  expectedCommand: string | null,
  snapshotLimits?: Partial<SnapshotLimits>,
  capturedSnapshot?: SnapshotIdentity,
): Promise<{
  snapshot?: SnapshotIdentity;
  environment?: VerificationEnvironment;
  summaries: VerificationSummary[];
}> {
  const receipts = (state.verificationReceipts ?? []).filter(
    (receipt) => receipt.taskId === state.sessionId,
  );
  const active = receipts.filter((receipt) => receipt.status !== 'pending');
  const covered =
    capturedSnapshot ??
    (active.length
      ? (await inspectCoveredSnapshot(workspace, snapshotLimits)).identity
      : undefined);
  const environment = covered
    ? captureVerificationEnvironment(covered)
    : undefined;
  const summaries: VerificationSummary[] = receipts.map((receipt) => ({
    receiptId: receipt.id,
    command: receipt.command.text,
    outcome:
      receiptIntegrityMatches(receipt) &&
      receipt.status === 'completed' &&
      receipt.exitCode !== null &&
      receipt.exitCode !== undefined
        ? receipt.exitCode === 0
          ? 'passed'
          : 'failed'
        : 'unknown',
    exitCode: receiptIntegrityMatches(receipt)
      ? (receipt.exitCode ?? null)
      : null,
    ...classifyVerification(receipt, covered, environment, {
      expectedCommand,
    }),
    scope: receipt.scope.label,
    observedAt: receipt.endedAt ?? receipt.startedAt,
  }));
  const ids = new Set(receipts.map((receipt) => receipt.id));
  for (const test of state.tests.slice(-64))
    if (!test.verificationReceiptId || !ids.has(test.verificationReceiptId))
      summaries.push({
        receiptId: null,
        command: verificationCommand(test.command).text,
        outcome:
          test.exitCode === null || test.status === 'skipped'
            ? 'unknown'
            : test.status,
        exitCode: test.exitCode,
        freshness: 'historical',
        reasons: ['qualified-receipt-unavailable'],
        scope: null,
        observedAt: test.createdAt,
      });
  return {
    ...(covered ? { snapshot: covered, environment } : {}),
    summaries: summaries
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
      .slice(-64),
  };
}
