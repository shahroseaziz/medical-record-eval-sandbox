// N18 Cutover (SHA-173). The notebook front page — authored at /notebook/start in
// N6 and staged there alongside the old persona front door — is now the site root
// `/`. The product surface is `/notebook` (reached from this page). The classic
// workbench (`/workbench`) stays REACHABLE by direct URL but is UNLINKED from `/`
// and from any nav; deletion of the superseded surfaces is deferred to N19.
//
// This is a pure route swap. ROLLBACK: restore the previous persona-router page.tsx
// (the SHA-73 R17 "front door" that linked to /lesson and /workbench) — `git revert`
// of this commit swaps the root back with no other change required.
//
// The front-page component still lives co-located with its N6 test at
// /notebook/start; root re-exports it so there is a single source of truth (and the
// N6 component test keeps passing). force-static is re-declared here because route
// segment config is read from the page module, not inherited through a re-export.
export { default } from './notebook/start/page'

export const dynamic = 'force-static'
