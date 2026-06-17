export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EXAMPLE_ARTIFACT_PATH } from '@/app/notebook/example-artifact'

// Serves the committed worked-example artifact to the N13b client loader. This is a
// STATIC FILE READ — never a model call — so replaying the worked example spends
// nothing of either metered model (the zero-metered-call replay contract). The
// artifact is a maintainer-committed, live-engine-verified fixture
// (example/README.md); until it lands this route returns 404 and the loader paints
// the "not available yet" state rather than erroring.
export async function GET() {
  try {
    const raw = await readFile(join(process.cwd(), EXAMPLE_ARTIFACT_PATH), 'utf-8')
    return new NextResponse(raw, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // The fixture only changes via a reviewed bump commit; let the browser cache it.
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch {
    return NextResponse.json(
      { error: 'The worked example has not been committed yet.' },
      { status: 404 },
    )
  }
}
