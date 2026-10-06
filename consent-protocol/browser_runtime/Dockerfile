# Browser-only sandbox launcher. Build context: consent-protocol.
# The built digest (not this tag) must be bound into an approved pod release.
FROM python:3.13-slim
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/browser/browsers
RUN /opt/venv/bin/pip install --no-cache-dir playwright==1.63.0 pydantic==2.12.5 \
    && /opt/venv/bin/playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/browser
COPY hushh_mcp/services/public_endpoint_policy.py /opt/browser/hushh_mcp/services/
# Deliberately no COPY . ., /app, pod_server, environment files or credentials.
COPY hushh_mcp/services/pod_browser/__init__.py \
     hushh_mcp/services/pod_browser/contracts.py \
     hushh_mcp/services/pod_browser/mailbox.py \
     hushh_mcp/services/pod_browser/playwright_executor.py \
     hushh_mcp/services/pod_browser/sandbox_runner.py \
     hushh_mcp/services/pod_browser/gcp_probe.py \
     hushh_mcp/services/pod_browser/worker_identity.py \
     hushh_mcp/services/pod_browser/scratch.py \
     hushh_mcp/services/pod_browser/session_state.py \
     hushh_mcp/services/pod_browser/origin.py \
     /opt/browser/hushh_mcp/services/pod_browser/
RUN groupadd --system --gid 10002 browser \
    && useradd --system --uid 10002 --gid browser --home-dir /tmp/browser browser
USER 10002:10002
# Controlled probe by default. This is not a service that accepts browser tasks.
CMD ["/opt/venv/bin/python", "-m", "hushh_mcp.services.pod_browser.gcp_probe"]
