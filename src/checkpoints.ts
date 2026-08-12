import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { relayPath } from './safety/path-policy.js';
import { readState } from './state/store.js';

const CHECKPOINT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{3,}$/;
const METADATA_MAX_BYTES = 64 * 1024;
const TEXT_ARTIFACT_MAX_BYTES = 1024 * 1024;
const PATCH_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export const CHECKPOINT_PATCH_DISPLAY_BYTES = 512 * 1024;

const metadataSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  label: z.string().min(1).optional(),
  commit: z.string().min(1),
  branch: z.string(),
  patchTruncated: z.boolean(),
  fingerprint: z.string().length(64).optional(),
});

export interface CheckpointSummary {
  id: string;
  createdAt: string;
  label?: string;
}

export interface CheckpointDiff {
  metadata: z.infer<typeof metadataSchema>;
  status: string;
  diffStat: string;
  patch: string;
  captureTruncated: boolean;
  displayTruncated: boolean;
  warnings: string[];
}

export function validateCheckpointId(id: string): void {
  if (!CHECKPOINT_ID.test(id)) throw new Error('Invalid Relay checkpoint ID.');
}

async function requireDirectory(directory: string): Promise<void> {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('Relay checkpoint directory is missing.');
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory())
    throw new Error('Relay checkpoint paths must be real directories.');
}

async function readArtifact(
  filePath: string,
  artifact: string,
  maxBytes: number,
): Promise<Buffer> {
  let details;
  try {
    details = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`Checkpoint artifact ${artifact} is missing.`);
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile())
    throw new Error(`Checkpoint artifact ${artifact} must be a regular file.`);

  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new Error(`Checkpoint artifact ${artifact} must not be a symlink.`);
    throw error;
  }
  try {
    const opened = await file.stat();
    if (!opened.isFile())
      throw new Error(
        `Checkpoint artifact ${artifact} must be a regular file.`,
      );
    if (opened.size > maxBytes)
      throw new Error(
        `Checkpoint artifact ${artifact} exceeds its read limit.`,
      );
    const contents = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await file.read(
        contents,
        offset,
        contents.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return contents.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function utf8Prefix(contents: Buffer, maxBytes = contents.length): string {
  const decoder = new StringDecoder('utf8');
  const prefix = contents.subarray(0, Math.min(contents.length, maxBytes));
  return decoder.write(prefix);
}

function omitBinaryPatchSections(patch: string): {
  patch: string;
  omitted: boolean;
} {
  let omitted = false;
  const sections = patch.split(/(?=^diff --git )/m);
  const sanitized = sections.map((section) => {
    if (!/^GIT binary patch$/m.test(section)) return section;
    omitted = true;
    const header = section
      .split('\n')
      .find((line) => line.startsWith('diff --git '));
    return `${header ?? 'diff --git (binary file)'}\n[Relay binary patch omitted]\n`;
  });
  return { patch: sanitized.join(''), omitted };
}

async function checkpointState(projectRoot: string) {
  await requireDirectory(relayPath(projectRoot));
  await requireDirectory(relayPath(projectRoot, 'checkpoints'));
  const stateFile = await lstat(relayPath(projectRoot, 'state.json'));
  if (stateFile.isSymbolicLink() || !stateFile.isFile())
    throw new Error('Relay state must be a regular file.');
  return readState(projectRoot);
}

export async function listCheckpoints(
  projectRoot: string,
): Promise<CheckpointSummary[]> {
  const state = await checkpointState(projectRoot);
  return Promise.all(
    state.checkpoints.map(async (checkpoint) => {
      validateCheckpointId(checkpoint.id);
      await requireDirectory(
        relayPath(projectRoot, 'checkpoints', checkpoint.id),
      );
      return {
        id: checkpoint.id,
        createdAt: checkpoint.createdAt,
        ...(checkpoint.label ? { label: checkpoint.label } : {}),
      };
    }),
  );
}

export async function readCheckpointDiff(
  projectRoot: string,
  id: string,
): Promise<CheckpointDiff> {
  validateCheckpointId(id);
  const state = await checkpointState(projectRoot);
  const records = state.checkpoints.filter(
    (checkpoint) => checkpoint.id === id,
  );
  if (records.length !== 1)
    throw new Error(`Unknown or pruned Relay checkpoint: ${id}`);

  const directory = relayPath(projectRoot, 'checkpoints', id);
  await requireDirectory(directory);
  const [metadataBytes, statusBytes, diffStatBytes, patchBytes] =
    await Promise.all([
      readArtifact(
        relayPath(projectRoot, 'checkpoints', id, 'metadata.json'),
        'metadata.json',
        METADATA_MAX_BYTES,
      ),
      readArtifact(
        relayPath(projectRoot, 'checkpoints', id, 'status.txt'),
        'status.txt',
        TEXT_ARTIFACT_MAX_BYTES,
      ),
      readArtifact(
        relayPath(projectRoot, 'checkpoints', id, 'diff-stat.txt'),
        'diff-stat.txt',
        TEXT_ARTIFACT_MAX_BYTES,
      ),
      readArtifact(
        relayPath(projectRoot, 'checkpoints', id, 'changes.patch'),
        'changes.patch',
        PATCH_ARTIFACT_MAX_BYTES,
      ),
    ]);

  let parsedMetadata: unknown;
  try {
    parsedMetadata = JSON.parse(utf8Prefix(metadataBytes));
  } catch {
    throw new Error('Checkpoint metadata.json is not valid JSON.');
  }
  const metadata = metadataSchema.parse(parsedMetadata);
  if (metadata.id !== id)
    throw new Error('Checkpoint metadata ID does not match the selected ID.');

  const status = utf8Prefix(statusBytes);
  const diffStat = utf8Prefix(diffStatBytes);
  const displayTruncated = patchBytes.length > CHECKPOINT_PATCH_DISPLAY_BYTES;
  const displayPatch = utf8Prefix(patchBytes, CHECKPOINT_PATCH_DISPLAY_BYTES);
  const sanitizedPatch = omitBinaryPatchSections(displayPatch);
  const warnings = [
    `Saved patch is the worktree/index diff against Git base ${metadata.commit} at capture time; it is not a comparison between checkpoints.`,
  ];
  if (/(^|\n)\?\? /.test(status))
    warnings.push(
      'Untracked file names appear in status, but their contents were not captured by this checkpoint format.',
    );
  if (metadata.patchTruncated)
    warnings.push('The patch was truncated when this checkpoint was captured.');
  if (displayTruncated)
    warnings.push('The returned patch was truncated for display.');
  if (sanitizedPatch.omitted)
    warnings.push(
      'The saved patch contains binary data; its patch body was omitted.',
    );

  return {
    metadata,
    status,
    diffStat,
    patch: sanitizedPatch.patch,
    captureTruncated: metadata.patchTruncated,
    displayTruncated,
    warnings,
  };
}
