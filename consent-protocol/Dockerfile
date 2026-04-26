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

# Copy requirements and install Python dependencies using uv with bytecode compilation
COPY requirements.txt .
RUN uv pip install --no-cache-dir --system --compile-bytecode -r requirements.txt

# Stage 2: Production runtime
FROM python:3.13-slim

WORKDIR /app

# Install runtime dependencies needed by operational jobs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy Python dependencies from builder
COPY --from=builder /usr/local /usr/local
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Make sure scripts in .local are usable
ENV PATH=/usr/local/bin:$PATH

# Copy application code
COPY . .
RUN python -m compileall -q .

# Expose port (Cloud Run will override this)
EXPOSE 8080

# Run FastAPI with uvicornWorker via gunicorn
# Cloud Run sets PORT env var, default to 8080
CMD ["sh", "-c", "exec gunicorn server:app -w 2 -k uvicorn.workers.UvicornWorker -b 0.0.0.0:${PORT:-8080}"]
