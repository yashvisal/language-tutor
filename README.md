# tutor

Live voice conversation practice with an AI language tutor. `frontend/` is the
Next.js app (and the Convex backend under `frontend/convex/`); `backend/` is
the Python LiveKit agent worker. Product direction lives in
`plans/product-vision.md`.

## Checks

Frontend, from `frontend/`:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Backend, from `backend/`:

```bash
uv sync
uv run ruff check src tests
uv run ruff format --check src tests
uv run pytest -q
```

CI (`.github/workflows/ci.yml`) runs exactly these on every pull request and on
pushes to `main`, as two jobs. `pnpm build` is not in CI — it needs real Clerk
and Convex environment variables to prerender, so the build is verified by the
deploy instead. Run it locally before shipping anything that touches rendering.
