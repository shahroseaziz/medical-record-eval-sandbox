# Medical Record Eval Sandbox

An open-source web app where users load synthetic C-CDA patient records, write prompts, build golden sets, and run evals live against Claude.

## Stack

- Next.js 15 (App Router) + TypeScript
- Vercel AI SDK v4
- pgvector on PostgreSQL 16 (via Docker)
- Vitest (unit) + Playwright (e2e)
- Upstash Redis for rate limiting

## Local dev

> Setup instructions will be filled in once parsing, RAG, and eval modules are implemented.

For now, start the database:

```bash
docker compose up -d
```

Copy `.env.example` to `.env.local` and fill in your API keys, then:

```bash
pnpm install
pnpm dev
```

## Evals

Thresholds live in `evals/thresholds.yaml`. Golden sets, scorers, and results go in the corresponding subdirectories under `evals/`.
