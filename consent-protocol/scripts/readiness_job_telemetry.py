"""Content-free call telemetry for the readiness exam job's own process."""

from __future__ import annotations

import logging
import sys

from mcp_modules.log_redaction import install_sensitive_log_filter

# Content-free call lines only: timings, token counts and retry codes. Every
# other logger stays at WARNING, so library request lines never reach the logs.
CALL_TELEMETRY_LOGGERS = (
    "hushh_mcp.runtime_providers.azure_adk",
    "hushh_mcp.services.drive_suggestion_service",
)


def enable_call_telemetry() -> None:
    """Emit exam call telemetry on stdout through the runtime log redactor."""
    logging.basicConfig(stream=sys.stdout, level=logging.WARNING, format="%(name)s %(message)s")
    install_sensitive_log_filter()
    for name in CALL_TELEMETRY_LOGGERS:
        logging.getLogger(name).setLevel(logging.INFO)
