/**
 * Judge key-resolution logic extracted so it can be imported and regression-tested
 * without pulling in the full Next.js route environment.
 */

/**
 * Determine which Anthropic API key the judge will use and whether that key
 * is the caller's BYO key.
 *
 * The stored `judgeKeyIsByo` flag is derived from the ACTUAL key used, not
 * from the requested `judgeUsesByo` flag — important when envKey is absent and
 * the judge falls back to the BYO key even though `judgeUsesByo` was false.
 */
export function resolveJudgeKey(
  byoKey: string | undefined,
  envKey: string | undefined,
  judgeUsesByo: boolean,
): { judgeKey: string | null; judgeKeyIsByo: boolean } {
  const effectiveJudgeUsesByo = Boolean(judgeUsesByo && byoKey)
  const judgeKey = effectiveJudgeUsesByo ? byoKey! : (envKey ?? byoKey ?? null)
  if (!judgeKey) return { judgeKey: null, judgeKeyIsByo: false }
  const judgeKeyIsByo = Boolean(byoKey && judgeKey === byoKey)
  return { judgeKey, judgeKeyIsByo }
}
