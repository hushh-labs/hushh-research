"""Fail-closed content privacy for both modern and legacy ADK telemetry."""

from google.adk.telemetry.context import ContentCapturingMode, TelemetryConfig


def private_telemetry() -> TelemetryConfig:
    config = TelemetryConfig(capture_message_content=ContentCapturingMode.NO_CONTENT)
    # An administrator can override per-request SDK settings through the
    # environment. Refuse private processing if that would capture content.
    if (
        config.resolved_content_capturing_mode != ContentCapturingMode.NO_CONTENT
        or config.should_add_content_to_legacy_spans
        or config.should_add_content_to_logs
        or config.should_add_content_to_experimental_spans
    ):
        raise ValueError("Private agent content telemetry must be disabled.")
    return config
