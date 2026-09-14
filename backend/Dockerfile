# syntax=docker/dockerfile:1
#
# The worker's deploy artifact (launch checklist B4). Built by LiveKit Cloud's
# build service on `lk agent create` / `lk agent deploy` — see
# https://docs.livekit.io/deploy/agents/builds/ for the requirements this
# follows: a glibc base, an unprivileged user, a fixed start command, and no
# LIVEKIT_* variables (Cloud injects those at runtime).
#
# 3.13 is the top of `pyproject.toml`'s `requires-python` (>=3.10,<3.14) and
# matches `.python-version`, so the image runs the interpreter this repo is
# developed and tested against.
ARG PYTHON_VERSION=3.13
FROM ghcr.io/astral-sh/uv:python${PYTHON_VERSION}-bookworm-slim AS base

# Unbuffered: a worker that dies must have emitted its logs first.
ENV PYTHONUNBUFFERED=1
# Compile to bytecode at install time so the first job doesn't pay for it.
# `livekit.agents.inference` alone is ~2.5s of imports on a cold process.
ENV UV_COMPILE_BYTECODE=1

# --- Build stage: native extensions need a compiler; the final image doesn't.
FROM base AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      gcc \
      g++ \
      python3-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifest and lockfile first: the dependency layer is then cached across
# every build that only changed `src/`.
COPY pyproject.toml uv.lock ./

# --frozen: install exactly what `uv.lock` pins and fail if the lock is stale.
# --no-dev: ruff and pytest have no business in a production image.
RUN uv sync --frozen --no-dev

# The worker itself. `src` is a flat module directory, not a package — the
# process runs from inside it, exactly as `lk agent dev` does locally.
COPY src/ ./src/

# --- Production stage.
FROM base

ARG UID=10001
RUN adduser \
      --disabled-password \
      --gecos "" \
      --home "/app" \
      --shell "/sbin/nologin" \
      --uid "${UID}" \
      appuser

WORKDIR /app

# One layer, correct ownership, and none of the build stage's toolchain.
COPY --from=build --chown=appuser:appuser /app /app

# Everything runs on the venv's interpreter; no `uv run` resolution at boot.
ENV PATH="/app/.venv/bin:$PATH"

USER appuser

# `start` is the production form of the same `agents.cli` entrypoint
# `lk agent dev` runs (see backend/README.md, "Run"). No wrapper script and no
# backgrounding: LiveKit Cloud's health check watches this process.
CMD ["python", "src/agent.py", "start"]
