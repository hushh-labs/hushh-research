"""Bounded same-model regional failover for managed Vertex Gemini calls.

The facade preserves the subset of the ``google-genai`` client contract used by
Hussh while selecting another configured Vertex location only for transient
provider failures. It never changes the model, credentials, request, or config.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

_RETRYABLE_STATUS_CODES = {429, 500, 503}
_RETRYABLE_STATUS_NAMES = {"INTERNAL", "RESOURCE_EXHAUSTED", "UNAVAILABLE"}


def _status_code(error: Exception) -> int | None:
    for name in ("status_code", "code"):
        value = getattr(error, name, None)
        if callable(value):
            try:
                value = value()
            except TypeError:
                continue
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def is_retryable_vertex_error(error: Exception) -> bool:
    """Return whether an idempotent call may be retried in another location."""

    if _status_code(error) in _RETRYABLE_STATUS_CODES:
        return True
    status = str(getattr(error, "status", "") or "").strip().upper()
    return status in _RETRYABLE_STATUS_NAMES


class _AsyncModels:
    def __init__(self, client: "VertexRegionalClient") -> None:
        self._client = client

    async def generate_content(self, **kwargs: Any) -> Any:
        return await self._client._call_async("generate_content", kwargs)

    async def generate_content_stream(self, **kwargs: Any) -> Any:
        # Failover is allowed only while opening the stream. Once the caller has
        # received chunks, replaying in another region could duplicate output.
        return await self._client._call_async("generate_content_stream", kwargs)


class _AsyncNamespace:
    def __init__(self, client: "VertexRegionalClient") -> None:
        self.models = _AsyncModels(client)


class _SyncModels:
    def __init__(self, client: "VertexRegionalClient") -> None:
        self._client = client

    def generate_content(self, **kwargs: Any) -> Any:
        return self._client._call_sync("generate_content", kwargs)

    def generate_content_stream(self, **kwargs: Any) -> Any:
        return self._client._call_sync("generate_content_stream", kwargs)


class VertexRegionalClient:
    """Genai-shaped client with process-local Vertex location health state.

    The location-health seam is intentionally private and process-local today.
    If cross-instance coordination becomes necessary, the cooldown store can be
    replaced by a Postgres-backed implementation and later Redis/Memorystore
    without changing callers or the generation contract.
    """

    def __init__(
        self,
        *,
        project: str,
        locations: tuple[str, ...],
        client_factory: Callable[..., Any],
        cooldown_seconds: float,
    ) -> None:
        if not locations:
            raise ValueError("At least one Vertex location is required")
        self._project = project
        self._locations = locations
        self._client_factory = client_factory
        self._cooldown_seconds = max(0.0, cooldown_seconds)
        self._lock = threading.Lock()
        self._cooldowns: dict[str, float] = {}
        self._clients: dict[str, Any] = {locations[0]: self._new_client(locations[0])}
        self.aio = _AsyncNamespace(self)
        self.models = _SyncModels(self)

    def _new_client(self, location: str) -> Any:
        return self._client_factory(vertexai=True, project=self._project, location=location)

    def _client_for(self, location: str) -> Any:
        with self._lock:
            client = self._clients.get(location)
            if client is None:
                client = self._new_client(location)
                self._clients[location] = client
            return client

    def _available_locations(self) -> tuple[str, ...]:
        now = time.monotonic()
        with self._lock:
            available = tuple(
                location
                for location in self._locations
                if self._cooldowns.get(location, 0.0) <= now
            )
            if available:
                return available
            # If every endpoint is cooling down, make one bounded probe against
            # the endpoint closest to expiry instead of failing without a call.
            return (min(self._locations, key=lambda item: self._cooldowns.get(item, 0.0)),)

    def _mark_transient_failure(self, location: str, error: Exception) -> None:
        with self._lock:
            self._cooldowns[location] = time.monotonic() + self._cooldown_seconds
        logger.warning(
            "vertex_region_cooldown location=%s status_code=%s error_type=%s",
            location,
            _status_code(error),
            error.__class__.__name__,
        )

    def _call_sync(self, method_name: str, kwargs: dict[str, Any]) -> Any:
        last_error: Exception | None = None
        for location in self._available_locations():
            try:
                method = getattr(self._client_for(location).models, method_name)
                return method(**kwargs)
            except Exception as error:  # noqa: BLE001 - provider boundary
                if not is_retryable_vertex_error(error):
                    raise
                last_error = error
                self._mark_transient_failure(location, error)
        if last_error is not None:
            raise last_error
        raise RuntimeError("Vertex regional failover exited without an attempt")

    async def _call_async(self, method_name: str, kwargs: dict[str, Any]) -> Any:
        last_error: Exception | None = None
        for location in self._available_locations():
            try:
                method = getattr(self._client_for(location).aio.models, method_name)
                return await method(**kwargs)
            except Exception as error:  # noqa: BLE001 - provider boundary
                if not is_retryable_vertex_error(error):
                    raise
                last_error = error
                self._mark_transient_failure(location, error)
        if last_error is not None:
            raise last_error
        raise RuntimeError("Vertex regional failover exited without an attempt")

    def __getattr__(self, name: str) -> Any:
        # Preserve less-common SDK namespaces on the configured primary client.
        return getattr(self._client_for(self._locations[0]), name)
