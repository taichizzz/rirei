import { realpath } from 'node:fs/promises';
import { renderEvidenceBriefing } from './briefing.js';
import {
  CONTEXT_EVENT_LIMIT,
  CONTEXT_PROMPT_LIMIT,
  type ContextEvent,
  type ContinuityContext,
} from './schema.js';
import {
  contextSnapshotFingerprint,
  readCaptureDiagnostic,
  readContextJournal,
  readContextPolicy,
  workspaceKey,
} from './store.js';

export function inspectContextEvents(events: ContextEvent[]) {
  const pending = events.filter(
    (event) =>
      event.kind === 'tool_start' &&
      !events.some(
        (result) =>
          result.kind === 'tool_result' &&
          result.runId === event.runId &&
          result.toolId === event.toolId,
      ),
  );
  const runs = [...new Set(events.map((event) => event.runId))];
  return {
    pendingTools: pending.map((event) => event.id),
    missingStarts: runs.filter(
      (run) =>
        !events.some(
          (event) => event.runId === run && event.kind === 'session_start',
        ),
    ),
    missingEnds: runs.filter(
      (run) =>
        !events.some(
          (event) => event.runId === run && event.kind === 'session_end',
        ),
    ),
  };
}

export async function loadContinuitySources(
  root: string,
  taskId: string,
  workspace: string,
  gitFingerprint?: string,
) {
  const policy = await readContextPolicy(root, taskId);
  if (!policy?.enabled) return undefined;
  const journal = await readContextJournal(root, taskId);
  const diagnostic = await readCaptureDiagnostic(root, taskId);
  const currentWorkspace = await realpath(workspace);
  const key = workspaceKey(currentWorkspace);
  const events = journal.events.filter((event) => event.workspace === key);
  const coverage = inspectContextEvents(events);
  const warnings = [
    'Only received hooks are represented; complete conversation coverage is not guaranteed.',
  ];
  if (!events.length)
    warnings.push('No context events have been captured for this workspace.');
  if (journal.incompleteTail)
    warnings.push(
      'An incomplete journal tail was ignored; capture needs attention.',
    );
  if (diagnostic)
    warnings.push(
      'A capture attempt failed; retained history has a known gap.',
    );
  if (journal.events.length >= CONTEXT_EVENT_LIMIT)
    warnings.push('The event limit was reached; later events may be missing.');
  if (coverage.pendingTools.length)
    warnings.push(
      `${coverage.pendingTools.length} tool request(s) have no observed completion. Their results are unknown.`,
    );
  if (coverage.missingStarts.length)
    warnings.push('Some runs have no captured session start.');
  if (coverage.missingEnds.length)
    warnings.push(
      'Some runs have no captured session end; interruption is possible.',
    );
  if (events.some((event) => event.truncated))
    warnings.push(
      'Some source text exceeded the capture limit and was truncated.',
    );
  if (events.some((event) => event.redacted))
    warnings.push(
      'Recognized secrets were redacted from retained source text.',
    );
  if (events.some((event) => event.kind === 'coverage_gap'))
    warnings.push('An unsupported hook was observed.');
  if (
    gitFingerprint &&
    events.some((event) => event.launchGitFingerprint !== gitFingerprint)
  )
    warnings.push(
      'The workspace differs from a capture launch anchor. Historical results do not verify the current code.',
    );

  return {
    digest: contextSnapshotFingerprint(policy, journal, diagnostic),
    events,
    coverage,
    warnings,
    workspace: currentWorkspace,
  };
}

export type ContinuitySources = NonNullable<
  Awaited<ReturnType<typeof loadContinuitySources>>
>;

export function renderContinuityContext(
  sources: ContinuitySources,
  currentState: string[] = [],
  options: { includePresentation?: boolean } = {},
): ContinuityContext {
  const { events, coverage, warnings } = sources;
  const briefing = renderEvidenceBriefing(events, {
    warnings,
    pendingTools: coverage.pendingTools,
    maxCharacters: CONTEXT_PROMPT_LIMIT,
    workspace: sources.workspace,
    currentState,
    includePresentation: options.includePresentation,
  });
  return {
    digest: sources.digest,
    eventCount: events.length,
    useful: events.some((event) =>
      ['prompt_submission', 'tool_result', 'assistant_claim'].includes(
        event.kind,
      ),
    ),
    omittedEvents: briefing.omittedEvents,
    warnings,
    text: briefing.text,
    selectedEvidence: briefing.selectedEvidence,
    partialEvents: briefing.partialEvents,
    submissionCoverage: briefing.submissionCoverage,
    ...(briefing.presentation ? { presentation: briefing.presentation } : {}),
    ...(currentState.length
      ? { omittedStateItems: briefing.omittedStateItems }
      : {}),
  };
}

export async function loadContinuityContext(
  root: string,
  taskId: string,
  workspace: string,
  gitFingerprint: string,
): Promise<ContinuityContext | undefined> {
  const sources = await loadContinuitySources(
    root,
    taskId,
    workspace,
    gitFingerprint,
  );
  return sources ? renderContinuityContext(sources) : undefined;
}
