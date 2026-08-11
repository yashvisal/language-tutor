# Repo layout

- `frontend/` — the Next.js app (all TypeScript/React code, shadcn components, the conversation surface). Run commands from `frontend/`: `pnpm dev`, `pnpm typecheck`, `pnpm lint`.
- `backend/` — the Python LiveKit Agents worker (realtime tutor, parallel STT, translation side-task, semantic analyzer). Run from `backend/` via `lk agent dev` (or `uv run`).
- `plans/` — source of truth for product intent. Read `plans/product-vision.md` before starting work; current phase plans live in `plans/phases/`.

Both `frontend/.env.local` and `backend/.env.local` carry the LiveKit/OpenAI/xAI keys (gitignored).

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `frontend/node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
