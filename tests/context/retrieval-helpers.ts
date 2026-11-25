import { realpath } from 'node:fs/promises';
import { afterEach } from 'vitest';
import {
  initializeProject,
  startTask,
} from '../../src/application/project-setup.js';
import {
  appendCapturedObservation,
  issueCaptureGrant,
  setContextConsent,
} from '../../src/context/store.js';
import type { ContextObservation } from '../../src/context/schema.js';
import { createRepository, removeRepository } from '../helpers.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRepository));
});
export async function retrievalProject() {
  const root = await realpath(await createRepository());
  roots.push(root);
  await initializeProject(root);
  const state = await startTask(root, 'Retrieve exact relevant context');
  await setContextConsent(root, state.sessionId, true);
  const issued = (await issueCaptureGrant(root, {
    taskId: state.sessionId,
    runId: 'retrieval-fixture',
    workspace: root,
    provider: 'claude',
    providerSessionId: 'fixture-session',
    launchGitFingerprint: 'historical',
  }))!;
  let sequence = 0;
  const record = (text: string, extra: Partial<ContextObservation> = {}) =>
    appendCapturedObservation(
      root,
      state.sessionId,
      'retrieval-fixture',
      issued.token,
      {
        provider: 'claude',
        providerSessionId: 'fixture-session',
        hook: 'fixture',
        kind: 'prompt_submission',
        sourceId: `fixture-${++sequence}`,
        text,
        redacted: false,
        truncated: false,
        ...extra,
      },
    );
  return { root, state, record };
}
