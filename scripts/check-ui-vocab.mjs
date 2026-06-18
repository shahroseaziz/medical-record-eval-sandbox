#!/usr/bin/env node
// ── Banned-UI-vocabulary gate (SHA-174 N19) — PERMANENT CI check ──────────────
//
// The correctness-first redesign replaced eval JARGON with plain language in the
// shipped product. This gate keeps that regression from sneaking back: no
// user-facing string in the React UI surface may contain the banned vocabulary
//
//     faithfulness · grounding · rubric · knob · calibration · atom
//
// SCOPE — rendered UI only: src/app/**/*.tsx and src/components/**/*.tsx,
// EXCLUDING __tests__ and *.test.* (tests assert behavior, they don't ship). The
// engine + the notebook LOGIC layer legitimately use these words as identifiers
// (`scoreFaithfulness`, `groundingContext`, `FaithfulnessResult`) and in code
// comments — so the gate (a) scans only `.tsx` (where shipped JSX/string text
// lives, not the `.ts` logic/types), (b) strips comments before matching, and
// (c) matches WHOLE WORDS so camelCase compounds never trip it. API routes live
// under src/app/api and carry no `.tsx`, so they are out of scope by construction.
//
// Exit 0 = clean. Exit 1 = a banned word shipped in UI text.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/app', 'src/components']
const BANNED = ['faithfulness', 'grounding', 'rubric', 'knob', 'calibration', 'atom']
const RE = new RegExp(`\\b(${BANNED.join('|')})\\b`, 'i')

function* walkTsx(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__') continue
      yield* walkTsx(p)
    } else if (p.endsWith('.tsx') && !p.includes('.test.')) {
      yield p
    }
  }
}

// Strip block comments (incl. JSDoc) and line comments so only code + JSX/string
// text remains. The `(?<!:)` guard leaves `https://` URLs intact rather than
// eating the rest of that line.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/[^\n]*/g, ' ')
}

const offenders = []
for (const root of ROOTS) {
  for (const file of walkTsx(root)) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      if (RE.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
    })
  }
}

if (offenders.length) {
  console.error('✗ Banned UI vocabulary found in the shipped React surface:')
  console.error(`    banned words: ${BANNED.join(', ')}\n`)
  for (const o of offenders) console.error('    ' + o)
  console.error(
    '\nUse plain language in user-facing UI text. Engine/identifier use belongs in non-.tsx logic.',
  )
  process.exit(1)
}
console.log('✓ UI vocabulary gate: clean (no banned words in the shipped React surface).')
