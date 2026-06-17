const BYO_SESSION_KEY = 'byo_api_key'
const JUDGE_BYO_SESSION_KEY = 'judge_uses_byo'

// The interactive BYO key panel (the React component this file used to export)
// lived on the retired workbench/workspace surfaces and was deleted with them in
// N19. What survives is the pair of pure session-storage readers the run/score
// hooks still call to attach a user's key to outbound requests.

/**
 * Returns the BYO headers to include on every API fetch.
 * Call this client-side; returns {} when called server-side or when no key is stored.
 */
export function getByoHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  const key = sessionStorage.getItem(BYO_SESSION_KEY)
  if (!key) return {}
  return { 'X-Byo-Api-Key': key }
}

/**
 * Returns whether the user opted in to running the judge with their own key.
 * When true, judge scores are non-comparable to the seeded baseline.
 */
export function getJudgeUsesByo(): boolean {
  if (typeof window === 'undefined') return false
  return sessionStorage.getItem(JUDGE_BYO_SESSION_KEY) === 'true'
}
