import { Redis } from '@upstash/redis'

// Spend caps in micro-USD (1/1,000,000 of a dollar)
export const DAILY_CAP_MICRO_USD = 5_000_000 // $5.00 per day
export const HOURLY_CAP_MICRO_USD = 1_000_000 // $1.00 per hour

// Worst-case cost estimate per free-tier /api/run (micro-USD):
//   Generation:  12k input + 1k output @ Haiku $0.80/$4.00 per 1M → ~14 000 µ$
//   Judge calls: 2 calls ×  ~3.5k input + 1k output              → ~14 000 µ$
//   Voyage:      ~500 query tokens @ $0.02/1M                    → ~10 µ$
const GENERATION_ESTIMATE_MICRO = Math.ceil((12_000 * 0.8 + 1_000 * 4.0)) // 13600
const JUDGE_ESTIMATE_MICRO = Math.ceil((7_000 * 0.8 + 2_000 * 4.0)) // 13600
// Exported so /api/retrieve can meter Voyage calls independently of the full run cost.
export const VOYAGE_ESTIMATE_MICRO = 10

export const ESTIMATED_RUN_COST_MICRO_USD =
  GENERATION_ESTIMATE_MICRO + JUDGE_ESTIMATE_MICRO + VOYAGE_ESTIMATE_MICRO

export class SpendCapError extends Error {
  constructor(public readonly window: 'daily' | 'hourly') {
    super(`Spend cap exceeded (${window})`)
    this.name = 'SpendCapError'
  }
}

function dailyKey(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `ks:daily:${y}-${m}-${day}`
}

function hourlyKey(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  return `ks:hourly:${y}-${m}-${day}:${h}`
}

function makeRedis(): Redis {
  // Throws if UPSTASH_REDIS_REST_URL / TOKEN are missing — caller maps to fail-closed.
  return Redis.fromEnv()
}

export type Refund = () => Promise<void>

// Books amountMicroUsd against daily and hourly spend caps using an atomic
// INCRBY-then-check pattern. Returns a refund callback that DECRBY the same
// amount — call it on request abort or Anthropic API failure.
//
// Fails CLOSED: any Upstash connectivity error rejects free-tier live runs
// rather than allowing an unbounded spend.
export async function bookSpend(
  amountMicroUsd: number = ESTIMATED_RUN_COST_MICRO_USD,
): Promise<Refund> {
  let redis: Redis
  try {
    redis = makeRedis()
  } catch (err) {
    throw new Error(
      `Upstash unavailable — failing closed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const dk = dailyKey()
  const hk = hourlyKey()

  let dailyVal: number
  let hourlyVal: number

  try {
    ;[dailyVal, hourlyVal] = await Promise.all([
      redis.incrby(dk, amountMicroUsd),
      redis.incrby(hk, amountMicroUsd),
    ])
  } catch (err) {
    throw new Error(
      `Upstash unavailable — failing closed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Async TTL maintenance: keys expire 25h / 2h after their last write.
  // We fire-and-forget because a missed TTL only wastes a small Redis key.
  redis.expire(dk, 90_000).catch(() => {})
  redis.expire(hk, 7_200).catch(() => {})

  const refund: Refund = async () => {
    try {
      await Promise.all([redis.decrby(dk, amountMicroUsd), redis.decrby(hk, amountMicroUsd)])
    } catch (err) {
      // Best-effort — a failed refund is a conservative overcount, not a security issue.
      console.log(JSON.stringify({
        event: 'refund_spend_failed',
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  // Check caps AFTER incrementing. The INCRBY return value is the post-increment
  // total, making this check race-free: only requests that actually push the counter
  // over the cap get rejected and refunded.
  if (dailyVal > DAILY_CAP_MICRO_USD) {
    await refund()
    throw new SpendCapError('daily')
  }
  if (hourlyVal > HOURLY_CAP_MICRO_USD) {
    await refund()
    throw new SpendCapError('hourly')
  }

  return refund
}
