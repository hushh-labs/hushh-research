# hushh_mcp/operons/kai/providers/audit.py
"""
Hash-only audit telemetry for Kai inference dispatch.

The consent-protocol SECURITY.md guarantees BYOK -- the server stores
ciphertext only. Logging full prompts or model outputs to consent_audit
would silently violate this because prompts can carry decrypted PKM
data that the user pulled into context.

This module emits SHA-256 fingerprints + structural metadata only,
written to consent_audit.metadata as JSONB. The shape is:

    {
      "kind": "kai_inference",
      "provider": "gemini" | "openai" | ... ,
      "scope_used": "agent.kai.inference.cloud.gemini",
      "model": "gemini-3-flash-preview",
      "prompt_hash": "<sha256 hex>",
      "prompt_chars": 1234,
      "output_hash": "<sha256 hex>" | null,
      "output_chars": 567 | null,
      "latency_ms": 842,
      "outcome": "ok" | "error" | "scope_violation",
      "error_class": "ProviderTimeout" | null,
    }

Audit writes are best-effort: if the DB connection is unavailable, the
hook logs at WARNING and returns; we never let an audit failure crash
an inference call. This matches the existing pattern in
`hushh_mcp/services/account_service.py` where consent_audit writes are
wrapped in try/except.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import asdict, dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)


def sha256_hex(text: str) -> str:
    """Return the hex SHA-256 digest of `text` (utf-8 encoded)."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class InferenceAuditRecord:
    """Structured payload written to consent_audit.metadata."""

    kind: str
    provider: str
    scope_used: str
    model: str
    prompt_hash: str
    prompt_chars: int
    output_hash: Optional[str]
    output_chars: Optional[int]
    latency_ms: int
    outcome: str
    error_class: Optional[str]

    def to_metadata(self) -> dict[str, Any]:
        return asdict(self)


class AuditWriter:
    """
    Best-effort writer for kai_inference audit rows.

    The default implementation logs only (no DB). Wire a concrete
    asyncpg connection in via `set_async_writer()` from server.py
    bootstrap; tests construct an InMemoryAuditWriter via the fixture.
    """

    def __init__(self) -> None:
        self._records: list[tuple[str, InferenceAuditRecord]] = []

    async def write(
        self,
        *,
        token_id: str,
        user_id: str,
        agent_id: str,
        record: InferenceAuditRecord,
    ) -> None:
        # Default: in-memory only, audit goes to logs.
        self._records.append((token_id, record))
        logger.info(
            "[kai-inference-audit] provider=%s scope=%s outcome=%s latency_ms=%d",
            record.provider,
            record.scope_used,
            record.outcome,
            record.latency_ms,
        )

    @property
    def records(self) -> list[tuple[str, InferenceAuditRecord]]:
        """Read-only view used by tests."""
        return list(self._records)


class TimedDispatch:
    """
    Context manager that captures latency and emits an audit record.

    Usage::

        with TimedDispatch(provider, scope, model, prompt) as t:
            response = await provider.complete(req)
            t.set_output(response.text, outcome="ok")
        await audit.write(token_id=..., user_id=..., agent_id=..., record=t.record)
    """

    def __init__(self, *, provider: str, scope: str, model: str, prompt: str) -> None:
        self._provider = provider
        self._scope = scope
        self._model = model
        self._prompt = prompt
        self._t0: float = 0.0
        self._latency_ms: int = 0
        self._output_hash: Optional[str] = None
        self._output_chars: Optional[int] = None
        self._outcome: str = "error"
        self._error_class: Optional[str] = None

    def __enter__(self) -> "TimedDispatch":
        self._t0 = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._latency_ms = int((time.perf_counter() - self._t0) * 1000)
        if exc is not None and self._outcome == "error":
            self._error_class = exc.__class__.__name__

    def set_output(self, text: str, *, outcome: str = "ok") -> None:
        self._output_hash = sha256_hex(text) if text else None
        self._output_chars = len(text) if text else 0
        self._outcome = outcome

    def set_outcome(self, outcome: str, *, error_class: Optional[str] = None) -> None:
        self._outcome = outcome
        if error_class:
            self._error_class = error_class

    @property
    def record(self) -> InferenceAuditRecord:
        return InferenceAuditRecord(
            kind="kai_inference",
            provider=self._provider,
            scope_used=self._scope,
            model=self._model,
            prompt_hash=sha256_hex(self._prompt) if self._prompt else "",
            prompt_chars=len(self._prompt),
            output_hash=self._output_hash,
            output_chars=self._output_chars,
            latency_ms=self._latency_ms,
            outcome=self._outcome,
            error_class=self._error_class,
        )


# Module-level singleton; tests replace this via `set_audit_writer()`.
_audit_writer: AuditWriter = AuditWriter()


def set_audit_writer(writer: AuditWriter) -> None:
    """Inject a concrete writer (used in production wiring + tests)."""
    global _audit_writer
    _audit_writer = writer


def get_audit_writer() -> AuditWriter:
    return _audit_writer
