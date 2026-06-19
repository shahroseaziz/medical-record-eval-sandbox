import '@testing-library/jest-dom'
import { afterEach } from 'vitest'

// Isolate web storage between tests. The notebook cube now persists to / hydrates
// from localStorage (C6/S35), so without this a cube written in one test would
// bleed into the next via the shared jsdom storage. No-op under the node env.
afterEach(() => {
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    // non-jsdom (node) test environment — no web storage to clear.
  }
})
