export type {
  EvalMode,
  EvalCase,
  RetrievedChunkInput,
  ScorerName,
  ExpectedField,
  FieldScorerMap,
  BaseScoreResult,
  ContainsResult,
  FaithfulnessClaim,
  FaithfulnessResult,
  ReferenceVerdict,
  ReferenceJudgeResult,
  ExtractionCompletenessResult,
  SectionHitResult,
  StructuredFieldDiff,
  StructuredDiffResult,
} from './types'

export { loadThresholds } from './thresholds'
export type { Thresholds } from './thresholds'

export { scoreContains } from './scorers/contains'
export { scoreFaithfulness } from './scorers/faithfulness'
export {
  scoreReferenceJudge,
  buildReferencePrompt,
  buildRedactedReferencePrompt,
} from './scorers/reference-judge'
export { scoreExtractionCompleteness } from './scorers/extraction-completeness'
export { scoreSectionHit } from './scorers/section-hit'
export { scoreStructuredDiff, extractEntries } from './scorers/structured-diff'
export {
  canonicalizeDose,
  dosesMatch,
  normalizeName,
  collapseDuplicates,
} from './scorers/structured-diff-normalization'
export type {
  CanonicalDose,
  NormalizedEntry,
  RawEntry,
  CollapseResult,
} from './scorers/structured-diff-normalization'
export { computeMeanScore, computeStdDev, medianRunIndex, computeAggregate } from './aggregate'
export type { FaithfulnessRunResult, CaseAggregateInput, AggregateResult } from './aggregate'
