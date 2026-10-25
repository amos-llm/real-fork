/** React Query key for one agent's fork points, shared by every pill render. */
export function forkPointsQueryKey(agentId: string | null) {
  return ["real-fork", "points", agentId] as const;
}
