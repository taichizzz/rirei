const ROLES = new Set(['implement', 'review', 'verify', 'investigate']);
const STATUSES = new Set([
  'creating',
  'ready',
  'active',
  'completed',
  'cleanup_available',
]);

export function sanitizeWorkspaceList(data, taskStatus, terminalClaims = []) {
  const entries = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray(data.workspaces)
      ? data.workspaces
      : [];
  const claims = new Set(terminalClaims);
  for (const run of Array.isArray(taskStatus?.runs) ? taskStatus.runs : []) {
    if (typeof run?.workspaceId === 'string') claims.add(run.workspaceId);
    else claims.add('default');
  }
  const workspaces = entries
    .map((workspace) => {
      if (
        !workspace ||
        typeof workspace !== 'object' ||
        typeof workspace.id !== 'string' ||
        workspace.id.length > 200 ||
        typeof workspace.branch !== 'string' ||
        workspace.branch.length > 300 ||
        !ROLES.has(workspace.role) ||
        !STATUSES.has(workspace.status) ||
        workspace.parentTaskId !== taskStatus?.sessionId
      )
        return null;
      const claimed = claims.has(workspace.id);
      return {
        id: workspace.id,
        branchLabel: workspace.branch,
        role: workspace.role,
        status: workspace.status,
        parentTaskId: workspace.parentTaskId,
        claimed,
        selectable: workspace.status === 'ready' && !claimed,
      };
    })
    .filter(Boolean);
  return {
    workspaces,
    mainClaimed: claims.has('default'),
    mainBranchLabel:
      typeof taskStatus?.git?.currentBranch === 'string'
        ? taskStatus.git.currentBranch
        : 'HEAD',
  };
}
