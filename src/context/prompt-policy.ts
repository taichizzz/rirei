import { createHash } from 'node:crypto';
import { handoffContentChecks, type RenderedHandoff } from '../handoff.js';
import type { EvidencePresentation } from './schema.js';

export const HANDOFF_PROFILES = [
  'control',
  'focused-output',
  'stable-layout',
  'stable-focused',
] as const;
export type HandoffProfile = (typeof HANDOFF_PROFILES)[number];
export const RECEIVER_OUTPUT_POLICY = [
  'Follow the submitted task requirements, including any requested output.',
  'Make focused edits; use patches when practical and full-file replacement when simpler.',
  'Run relevant checks and retain useful failure diagnostics.',
  'Finish with changed behavior, verification, and unresolved uncertainty; keep the recap concise unless the task asks for more.',
].join('\n');
const POLICY_HEADER = 'RECEIVER OUTPUT POLICY v1 (experimental)';
const LAYOUT_HEADER = 'RIREI HANDOFF — stable-layout-v1 (experimental)';
const SAFETY = 'Inspect the working tree and preserve existing changes.';
const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');

export interface PromptPolicyMetadata {
  schemaVersion: 1;
  requested: HandoffProfile;
  effective: HandoffProfile;
  applied: boolean;
  fallbackReason:
    'insufficient-legacy-headroom' | 'unsupported-control-layout' | null;
  baseTextSha256: string;
  textSha256: string;
  addedCharacters: number;
  chargedTo: 'legacy-capsule';
  legacyUsedCharacters: number;
  legacyMaxCharacters: number;
  outputPolicyVersion: 1 | null;
  layoutVersion: 1 | null;
  staticPrefix: {
    characters: number;
    utf8Bytes: number;
    sha256: string;
  } | null;
  cacheBenefit: 'unmeasured';
}

export function parseHandoffProfile(
  value: unknown = 'control',
): HandoffProfile {
  if (
    typeof value !== 'string' ||
    !HANDOFF_PROFILES.some((profile) => profile === value)
  )
    throw new Error(
      `Unknown handoff profile. Use ${HANDOFF_PROFILES.join(', ')}.`,
    );
  return value as HandoffProfile;
}
export const stableLayoutProfile = (profile: HandoffProfile) =>
  profile === 'stable-layout' || profile === 'stable-focused';

/** Changes presentation only; selected requirements, citations and uncertainty never yield to policy. */
export function applyHandoffPolicy(
  base: RenderedHandoff,
  options: {
    profile?: HandoffProfile;
    workspace: string;
    legacyText: string;
    legacyMaxCharacters: number;
    presentation?: EvidencePresentation;
  },
): RenderedHandoff {
  const profile = parseHandoffProfile(options.profile);
  if (profile === 'control') return base;
  const focused = profile === 'focused-output' || profile === 'stable-focused';
  const stable = stableLayoutProfile(profile);
  let candidate: string | undefined;
  let prefix = '';
  if (!stable) {
    prefix = `${POLICY_HEADER}\n${RECEIVER_OUTPUT_POLICY}\n\n`;
    candidate = prefix + base.text;
  } else {
    const blocks = options.legacyText.split('\n\n');
    const git = blocks.find((block) => block.startsWith('Git: '));
    const safe = blocks.indexOf(SAFETY);
    // Tiny/truncated legacy capsules do not have enough structure to safely relocate sections.
    if (
      git &&
      safe >= 0 &&
      blocks[0]?.startsWith('Task: ') &&
      (!base.continuity || options.presentation)
    ) {
      const staticBlocks = [
        LAYOUT_HEADER,
        SAFETY,
        ...(focused ? [`${POLICY_HEADER}\n${RECEIVER_OUTPUT_POLICY}`] : []),
        ...(options.presentation
          ? [options.presentation.preamble.join('\n')]
          : []),
      ];
      prefix = staticBlocks.join('\n\n') + '\n\n';
      const workspace = `Current workspace: ${JSON.stringify(options.workspace)}`;
      const originalWorkspace = options.presentation?.workspace;
      const sourceBody = options.presentation
        ? [
            ...options.presentation.submissions,
            ...options.presentation.evidence,
          ].join('\n')
        : '';
      const runtime = [
        git,
        ...(options.presentation?.runtime ?? []),
        ...(originalWorkspace && originalWorkspace !== workspace
          ? [originalWorkspace]
          : []),
      ];
      candidate =
        prefix +
        [
          workspace,
          ...blocks.filter((block) => block !== git && block !== SAFETY),
          ...(sourceBody ? [sourceBody] : []),
          `Runtime observations:\n${runtime.join('\n')}`,
        ].join('\n\n') +
        (base.text.endsWith('\n') ? '\n' : '');
    }
  }
  const added =
    candidate === undefined
      ? 0
      : Math.max(0, candidate.length - base.text.length);
  const fits =
    candidate !== undefined &&
    options.legacyText.length + added <= options.legacyMaxCharacters &&
    candidate.length <= base.budget.maxCharacters &&
    Math.ceil(candidate.length / 4) <= base.budget.maxTokens;
  const text = fits ? candidate! : base.text;
  const metadata: PromptPolicyMetadata = {
    schemaVersion: 1,
    requested: profile,
    effective: fits ? profile : 'control',
    applied: fits,
    fallbackReason: fits
      ? null
      : candidate === undefined
        ? 'unsupported-control-layout'
        : 'insufficient-legacy-headroom',
    baseTextSha256: digest(base.text),
    textSha256: digest(text),
    addedCharacters: fits ? text.length - base.text.length : 0,
    chargedTo: 'legacy-capsule',
    legacyUsedCharacters: options.legacyText.length + (fits ? added : 0),
    legacyMaxCharacters: options.legacyMaxCharacters,
    outputPolicyVersion: fits && focused ? 1 : null,
    layoutVersion: fits && stable ? 1 : null,
    staticPrefix: fits
      ? {
          characters: prefix.length,
          utf8Bytes: Buffer.byteLength(prefix),
          sha256: digest(prefix),
        }
      : null,
    cacheBenefit: 'unmeasured',
  };
  return {
    ...base,
    policy: metadata,
    text,
    budget: {
      ...base.budget,
      usedCharacters: text.length,
      estimatedTokens: Math.ceil(text.length / 4),
    },
    contentChecks: handoffContentChecks(
      text,
      base.capsule.task.originalRequest,
    ),
  };
}

/** Exact UTF-8 byte prefix only; provider-side token/cache behavior cannot be inferred from it. */
export function sharedPromptPrefix(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  let bytes = 0;
  while (bytes < Math.min(a.length, b.length) && a[bytes] === b[bytes]) bytes++;
  return {
    utf8Bytes: bytes,
    sha256: createHash('sha256').update(a.subarray(0, bytes)).digest('hex'),
    providerCacheReuse: null,
  };
}
