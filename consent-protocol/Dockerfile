# syntax=docker/dockerfile:1
# Multi-stage build for Python FastAPI backend
# Optimized for Google Cloud Run

# Stage 1: Build dependencies
FROM python:3.13-slim as builder

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Install uv map requirements to virtual environment
RUN pip install uv

# Install the locked graph with its explicit CPU-only Torch package source.
COPY pyproject.toml uv.lock ./
RUN uv venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --active

# Bake the exact-revision local E5 snapshot in the same virtual environment as
# the serving API. The document worker uses this image offline at runtime.
COPY hushh_mcp/services/embedding_client_leaf.py hushh_mcp/services/embedding_client_leaf.py
COPY scripts/ops/bake_drive_embedding_model.py scripts/ops/bake_drive_embedding_model.py
RUN python -m scripts.ops.bake_drive_embedding_model

# Stage 2: Production runtime
FROM python:3.13-slim

WORKDIR /app

# Install runtime dependencies needed by operational jobs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy Python dependencies from builder
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/hushh/models /opt/hushh/models
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HUSHH_DRIVE_EMBEDDING_MODEL_DIR=/opt/hushh/models/multilingual-e5-small

# Make sure scripts in .local are usable
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

# Copy application code
COPY . .

# The generated action catalog is static per image, so its passage vectors are
# computed here, once, instead of by every instance and worker at startup (about
# 70s per instance on Cloud Run, 2026-09-27). Runs the runtime's own code against
# the exact tree this image serves, offline, with the baked model. A missing or
# mismatched file at runtime only means the catalog is embedded live.
RUN HF_HUB_OFFLINE=1 python -m scripts.ops.bake_action_catalog_vectors

RUN python -m compileall -q .

# Run as a non-root, least-privilege user (FedRAMP CM-6 / SC-2). The app writes
# no bytecode at runtime (PYTHONDONTWRITEBYTECODE=1) and reads world-readable
# code, so a non-root UID needs no extra grants.
RUN useradd --system --uid 10001 --home-dir /app appuser
USER 10001

# Expose port (Cloud Run will override this)
EXPOSE 8080

# Run FastAPI with uvicornWorker via gunicorn
# Cloud Run sets PORT env var, default to 8080
# Cloud Run sends SIGTERM and kills the container 10 s later. Keep gunicorn's
# graceful shutdown (default 30 s) inside that window so workers stop on their
# own terms: open agent-chat streams get their terminal event first.
# Honor the governed per-environment worker count; unset keeps the UAT/prod default.
CMD ["sh", "-c", "exec gunicorn server:app -w ${WEB_CONCURRENCY:-2} -c gunicorn.conf.py -k uvicorn.workers.UvicornWorker --timeout 120 --graceful-timeout 8 -b 0.0.0.0:${PORT:-8080}"]
