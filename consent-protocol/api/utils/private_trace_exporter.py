"""Final export boundary: provider exception messages are never durable telemetry.

ADK's NO_CONTENT policy excludes request/response attributes but OpenTelemetry
still records exceptions automatically. Retain error types, timing, trace
correlation and status, never their potentially prompt-bearing descriptions.
"""

from collections.abc import Sequence

from opentelemetry.propagators.textmap import Getter, TextMapPropagator
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

# ASGI instrumentation records the full callback URL by default. Google sends
# OAuth codes, signed state and Picker file IDs in its fixed GET callbacks, so
# retaining either legacy or current HTTP URL attributes would make the trace
# export a credential/content sink. Route attributes remain safe and useful.
_PRIVATE_HTTP_URL_FIELDS = frozenset(
    {
        "http.url",
        "http.target",
        "url.full",
    }
)


class _IncomingTraceGetter(Getter):
    """Untrusted vendor state is not an authority or a required correlation field."""

    def __init__(self, delegate):
        self.delegate = delegate

    def get(self, carrier, key):
        return None if key.lower() == "tracestate" else self.delegate.get(carrier, key)

    def keys(self, carrier):
        return [key for key in self.delegate.keys(carrier) if key.lower() != "tracestate"]


class _PrivateTracePropagator(TextMapPropagator):
    def __init__(self, delegate):
        self.delegate = delegate

    def extract(self, carrier, context=None, getter=None):
        from opentelemetry.propagators.textmap import default_getter

        return self.delegate.extract(
            carrier, context, _IncomingTraceGetter(getter or default_getter)
        )

    def inject(self, carrier, context=None, setter=None):
        from opentelemetry.propagators.textmap import default_setter

        return self.delegate.inject(carrier, context, setter or default_setter)

    @property
    def fields(self):
        return self.delegate.fields


def protect_incoming_trace_context() -> None:
    """Mitigate GHSA-xcq7-p3pf-p88h while ADK pins the affected OTEL family.

    Retain traceparent, baggage and outbound propagation. Install before any
    instrumentation, which otherwise parses tracestate outside app middleware.
    """
    from opentelemetry.propagate import get_global_textmap, set_global_textmap

    delegate = get_global_textmap()
    if not isinstance(delegate, _PrivateTracePropagator):
        set_global_textmap(_PrivateTracePropagator(delegate))


def _safe_attributes(attributes):
    return {
        key: value
        for key, value in (attributes or {}).items()
        if key not in _PRIVATE_ERROR_FIELDS | _PRIVATE_HTTP_URL_FIELDS
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
