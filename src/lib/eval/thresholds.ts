import { readFileSync } from 'fs'
import { join } from 'path'

export interface Thresholds {
  faithfulness: number
  contains: number
  referenceJudge: number
  judgeKappaMin: number
  extractionCompleteness: number
  structuredDiff: number
}

function parseSimpleYaml(content: string): Record<string, number> {
  const result: Record<string, number> = {}
  for (const raw of content.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^([\w_]+):\s*([\d.]+)/)
    if (m) result[m[1]] = parseFloat(m[2])
  }
  return result
}

export function loadThresholds(yamlPath?: string): Thresholds {
  const path = yamlPath ?? join(process.cwd(), 'evals', 'thresholds.yaml')
  const raw = parseSimpleYaml(readFileSync(path, 'utf-8'))
  return {
    faithfulness: raw['faithfulness'] ?? 0.85,
    contains: raw['contains'] ?? 1.0,
    referenceJudge: raw['reference_judge'] ?? 0.8,
    judgeKappaMin: raw['judge_kappa_min'] ?? 0.0,
    extractionCompleteness: raw['extraction_completeness'] ?? 0.0,
    structuredDiff: raw['structured_diff'] ?? 0.0,
  }
}
