import type { InputChange } from './snapshot.js';
import type { SnapshotIdentity } from './snapshot-schema.js';
import type { VerificationSummary } from './verification.js';

export const INSPECTION_DEFAULT_CHARACTERS = 6000;
export const INSPECTION_MAX_CHARACTERS = 12000;
export const INSPECTION_MIN_CHARACTERS = 1200;
export type InspectionFormat = 'text' | 'json';

export interface InspectionRequirement {
  kind: 'requirement';
  source: string;
  sequence?: number;
  start: 0;
  end: number;
  text: string;
  truncated: boolean;
  redacted: boolean;
}
export interface InspectionFile {
  kind: 'file-change';
  path: string;
  source: 'snapshot' | 'reported-reference' | 'requested-path';
  staged: InputChange;
  worktree: InputChange;
  omission?: string;
}
export interface InspectionExcerpt {
  kind: 'diff' | 'current-file';
  path: string;
  layer: 'staged' | 'worktree' | 'current';
  baseOid?: string;
  resultOid?: string;
  contentHash?: string;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
  redacted: boolean;
}
export interface InspectionAction {
  kind: 'action';
  type: 'next' | 'blocker';
  source: string;
  provenance: 'user' | 'agent' | 'legacy-task-record';
  agent?: string;
  text: string;
}
export type InspectionItem =
  | InspectionRequirement
  | InspectionFile
  | InspectionExcerpt
  | InspectionAction
  | ({ kind: 'verification' } & Pick<
      VerificationSummary,
      'receiptId' | 'command' | 'outcome' | 'exitCode' | 'freshness' | 'reasons'
    >)
  | {
      kind: 'required-source';
      source: string;
      sequence?: number;
      start: 0;
      end: number;
    };

export interface InspectionPacket {
  schemaVersion: 1;
  kind: 'current-state-inspection';
  packetId: string;
  workspace: string | null;
  snapshot: { id: string; status: SnapshotIdentity['coverage']['status'] };
  scope: string;
  requirements: {
    total: number;
    inline: number;
    status: 'retained-text-inline' | 'lookup-required' | 'source-incomplete';
    sourceGaps: number;
    capture: 'disabled' | 'partial';
  };
  changes: { observed: number | null; complete: boolean };
  omitted: {
    requirements: number;
    files: number;
    verification: number;
    actions: number;
    excerpts: number;
    sourceReferences: number;
  };
  gaps: string[];
  items: InspectionItem[];
  next: string[];
  budget: {
    maxCharacters: number;
    usedCharacters: number;
    estimatedTokens: number;
  };
}

export interface InspectionAnchor {
  schemaVersion: 1;
  snapshotId: string;
  coverage: SnapshotIdentity['coverage']['status'];
  changedFiles: number | null;
  lookup: string;
}
