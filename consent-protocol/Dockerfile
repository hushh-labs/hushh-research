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
CMD ["sh", "-c", "exec gunicorn server:app -w 2 -k uvicorn.workers.UvicornWorker --timeout 120 -b 0.0.0.0:${PORT:-8080}"]
