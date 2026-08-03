"""BYOK-safe PKM scope availability checks for consent admission.

The resolver consumes manifest-derived metadata only. It never reads or
decrypts PKM payloads, and legacy rows without materialization metadata remain
``unknown`` rather than being treated as empty.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, cast

from hushh_mcp.consent.scope_generator import get_scope_generator

ScopeAvailabilityState = Literal[
    "materialized",
    "empty",
    "unknown",
    "unavailable",
    "not_applicable",
]


class _ScopeGenerator(Protocol):
    async def get_available_scope_entries(self, user_id: str) -> list[dict]: ...


@dataclass(frozen=True)
class ScopeAvailability:
    scope: str
    state: ScopeAvailabilityState
    materialized_leaf_count: int = 0
    source_manifest_revision: int | None = None

    @property
    def requestable(self) -> bool:
        return self.state in {"materialized", "unknown", "not_applicable"}


class PkmScopeAvailabilityResolver:
    """Resolve whether a dynamic information scope can enter consent."""

    def __init__(self, *, scope_generator: _ScopeGenerator | None = None) -> None:
        self._scope_generator = scope_generator

    async def resolve(self, *, user_id: str, scope: str) -> ScopeAvailability:
        return (await self.resolve_many(user_id=user_id, scopes=[scope]))[0]

    async def resolve_many(
        self,
        *,
        user_id: str,
        scopes: list[str],
    ) -> list[ScopeAvailability]:
        normalized_scopes = [str(scope or "").strip() for scope in scopes]
        dynamic_scopes = {scope for scope in normalized_scopes if scope.startswith("attr.")}
        entries: list[dict] = []
        if dynamic_scopes:
            generator = self._scope_generator or cast(
                _ScopeGenerator,
                get_scope_generator(),
            )
            entries = await generator.get_available_scope_entries(user_id)
        entries_by_scope = {
            str(entry.get("scope") or "").strip(): entry
            for entry in entries
            if isinstance(entry, dict) and str(entry.get("scope") or "").strip() in dynamic_scopes
        }
        return [
            self._resolve_from_entries(
                normalized_scope=scope,
                entry=entries_by_scope.get(scope),
            )
            for scope in normalized_scopes
        ]

    @staticmethod
    def _resolve_from_entries(
        *,
        normalized_scope: str,
        entry: dict | None,
    ) -> ScopeAvailability:
        if not normalized_scope.startswith("attr."):
            return ScopeAvailability(
                scope=normalized_scope,
                state="not_applicable",
            )
        if entry is None:
            return ScopeAvailability(scope=normalized_scope, state="unavailable")
        state = str(entry.get("materialization_state") or "unknown").strip().lower()
        if state not in {"materialized", "empty", "unknown"}:
            state = "unknown"
        try:
            leaf_count = max(0, int(entry.get("materialized_leaf_count") or 0))
        except (TypeError, ValueError):
            leaf_count = 0
        try:
            revision_raw = entry.get("source_manifest_revision")
            revision = int(revision_raw) if revision_raw is not None else None
        except (TypeError, ValueError):
            revision = None
        return ScopeAvailability(
            scope=normalized_scope,
            state=cast(ScopeAvailabilityState, state),
            materialized_leaf_count=leaf_count,
            source_manifest_revision=revision,
        )

    async def filter_requestable(
        self,
        *,
        user_id: str,
        scopes: list[str],
    ) -> tuple[list[str], list[str]]:
        requestable: list[str] = []
        empty_or_unavailable: list[str] = []
        for scope, availability in zip(
            scopes,
            await self.resolve_many(user_id=user_id, scopes=scopes),
            strict=True,
        ):
            if availability.requestable:
                requestable.append(scope)
            else:
                empty_or_unavailable.append(scope)
        return requestable, empty_or_unavailable


_resolver: PkmScopeAvailabilityResolver | None = None


def get_pkm_scope_availability_resolver() -> PkmScopeAvailabilityResolver:
    global _resolver
    if _resolver is None:
        _resolver = PkmScopeAvailabilityResolver()
    return _resolver
