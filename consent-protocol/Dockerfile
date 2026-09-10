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

# Install uv. Dependencies are resolved into a disposable build-stage virtual
# environment and copied into the runtime image; the running container never
# installs packages or resolves against a live registry.
RUN pip install uv

# Copy the lockfile before application source so dependency layers remain cached
# across code-only deploys. Project mode is intentional: it preserves the explicit
# CPU-only Torch source in pyproject.toml, which a generated requirements file cannot.
# The BuildKit cache mount keeps uv's wheel cache OUT of the image layer while still
# speeding installs; the layer itself is cached in the registry (mode=max).
COPY pyproject.toml uv.lock ./
RUN uv venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --active

# Stage 2: Production runtime
FROM python:3.13-slim

WORKDIR /app

# Install runtime dependencies needed by operational jobs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy the frozen Python environment from the builder. No package manager or
# dependency manifest is copied into the runtime stage.
COPY --from=builder /opt/venv /opt/venv
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
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
