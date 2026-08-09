import { z } from 'zod';

export const workspaceRoleSchema = z.enum([
  'implement',
  'review',
  'verify',
  'investigate',
]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const workspaceStatusSchema = z.enum([
  'creating',
  'ready',
  'active',
  'completed',
  'cleanup_available',
]);
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;

export const relayWorkspaceSchema = z.object({
  id: z.string().min(1),
  parentTaskId: z.string().min(1),
  repositoryRoot: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  baseCommit: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  role: workspaceRoleSchema,
  createdAt: z.string().datetime(),
  status: workspaceStatusSchema,
  terminalIds: z.array(z.string().min(1)),
});
export type RelayWorkspace = z.infer<typeof relayWorkspaceSchema>;

export const LATEST_WORKSPACE_REGISTRY_SCHEMA = 1;

export const workspaceRegistrySchema = z.object({
  schemaVersion: z.literal(LATEST_WORKSPACE_REGISTRY_SCHEMA),
  workspaces: z.array(relayWorkspaceSchema),
});
export type WorkspaceRegistry = z.infer<typeof workspaceRegistrySchema>;
