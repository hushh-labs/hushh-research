"""Final export boundary: provider exception messages are never durable telemetry.

ADK's NO_CONTENT policy excludes request/response attributes but OpenTelemetry
still records exceptions automatically. Retain error types, timing, trace
correlation and status, never their potentially prompt-bearing descriptions.
"""

from collections.abc import Sequence

from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import Status

_PRIVATE_ERROR_FIELDS = frozenset(
    {
        "exception.message",
        "exception.stacktrace",
        "error.message",
        "error.stacktrace",
        "error.description",
        "error.details",
    }
)


def _safe_attributes(attributes):
    return {
        key: value for key, value in (attributes or {}).items() if key not in _PRIVATE_ERROR_FIELDS
    }


class PrivateTraceExporter(SpanExporter):
    def __init__(self, delegate: SpanExporter):
        self.delegate = delegate

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        projected = [
            ReadableSpan(
                name=span.name,
                context=span.context,
                parent=span.parent,
                resource=span.resource,
                attributes=_safe_attributes(span.attributes),
                events=[
                    Event(event.name, _safe_attributes(event.attributes), event.timestamp)
                    for event in span.events
                ],
                links=span.links,
                kind=span.kind,
                status=Status(span.status.status_code),
                start_time=span.start_time,
                end_time=span.end_time,
                instrumentation_scope=span.instrumentation_scope,
            )
            for span in spans
        ]
        return self.delegate.export(projected)

    def shutdown(self) -> None:
        self.delegate.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self.delegate.force_flush(timeout_millis)
