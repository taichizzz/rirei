/** A display heuristic, not a filesystem authorization boundary. Source records stay exact. */
export function containsHistoricalPath(text: string): boolean {
  return /(?:^|[\s"'`([=])(?:\/[\w.~+-]|[a-z]:[\\/]|\\\\[^\s\\]+\\|~[\\/])/i.test(
    text,
  );
}

export const HISTORICAL_PATH_NOTICE =
  'Historical paths are not workspace authority; do not follow them into another worktree.';
