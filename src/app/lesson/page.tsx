export const dynamic = 'force-static'

import { LessonJourney } from '@/components/LessonJourney'
import { LessonBeat2 } from '@/components/LessonBeat2'
import { loadThresholds } from '@/lib/eval/thresholds'
import { DEFAULT_PASS_THRESHOLD } from '@/lib/eval/user-agreement'

// Pass threshold lives in config (evals/thresholds.yaml), never hardcoded in the
// page (rule 15). Fall back to the documented default only if config is missing.
function faithfulnessThreshold(): number {
  try {
    return loadThresholds().faithfulness
  } catch {
    return DEFAULT_PASS_THRESHOLD
  }
}

/**
 * The correctness lesson — an app-like stepper journey (SHA-71 R15). A persistent
 * rail (Match → Meaning → Grounding) sits sticky at the top and exactly one beat
 * is interactive at a time; the journey shell (`LessonJourney`) owns the
 * one-beat-at-a-time orchestration and gated advancement. The three beats
 * (Beat 1 diff → Beat 2 reference judge → Beat 3 faithfulness, ending in the
 * gated graduation) are unchanged in pedagogy and copy.
 */
export default function LessonPage() {
  // Beat 2 is rendered here (server) and passed as a slot so its server-only
  // data load stays out of the client journey bundle.
  return <LessonJourney initialThreshold={faithfulnessThreshold()} beat2={<LessonBeat2 />} />
}
