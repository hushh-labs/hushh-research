"""Tests for server-side `intent`-signal derivation.

Uses fakes for both collaborators — a stub read model (list_publishable_slices)
and a recording signal service — so the derivation's mapping and idempotency
contract are covered without a database or a real PKM.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.opportunity_signal_derivation_service import (
    OpportunitySignalDerivationService,
    _dedupe_key,
)


class _FakeInfoService:
    def __init__(self, slices: list[dict[str, Any]]):
        self._slices = slices
        self.called_with: str | None = None

    async def list_publishable_slices(self, *, user_id: str, **_kw) -> list[dict[str, Any]]:
        self.called_with = user_id
        return self._slices


class _FakeSignalService:
    """Records create_signal calls and echoes back a shaped-ish row."""

    def __init__(self):
        self.calls: list[dict[str, Any]] = []

    async def create_signal(self, **kwargs) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"id": f"sig-{len(self.calls)}", "status": "active", **kwargs}


def _derivation(slices):
    info = _FakeInfoService(slices)
    signals = _FakeSignalService()
    svc = OpportunitySignalDerivationService(info_service=info, signal_service=signals)
    return svc, info, signals


async def test_derive_maps_each_slice_to_intent_signal():
    slices = [
        {
            "domain": "travel",
            "domainTitle": "Travel",
            "label": "Upcoming trip",
            "scopeHandle": "h-travel",
            "topLevelScopePath": "travel.trip",
            "suggestedPriceCents": 250,
            "currency": "USD",
        },
        {
            "domain": "insurance",
            "domainTitle": "Insurance",
            "label": "Auto renewal",
            "scopeHandle": None,
            "topLevelScopePath": "insurance.auto",
            "suggestedPriceCents": 400,
            "currency": "USD",
        },
    ]
    svc, info, signals = _derivation(slices)

    out = await svc.derive_for_user(user_id="owner")

    assert info.called_with == "owner"
    assert len(out) == 2
    assert len(signals.calls) == 2

    first = signals.calls[0]
    assert first["kind"] == "intent"
    assert first["source"] == "derived"
    assert first["domain"] == "travel"
    assert first["scope_handle"] == "h-travel"
    assert first["suggested_price_cents"] == 250
    assert "Upcoming trip" in first["title"]
    assert first["dedupe_key"] == "derived:intent:travel:h-travel"
    assert first["metadata"]["topLevelScopePath"] == "travel.trip"
    assert first["metadata"]["label"] == "Upcoming trip"


async def test_dedupe_key_falls_back_to_label_when_no_handle():
    # A slice with no scope_handle must still get a stable, distinct key.
    assert _dedupe_key("insurance", None, "Auto renewal") == "derived:intent:insurance:Auto renewal"
    slices = [
        {
            "domain": "insurance",
            "domainTitle": "Insurance",
            "label": "Auto renewal",
            "scopeHandle": None,
            "topLevelScopePath": "insurance.auto",
            "suggestedPriceCents": 400,
            "currency": "USD",
        }
    ]
    svc, _info, signals = _derivation(slices)

    await svc.derive_for_user(user_id="owner")

    assert signals.calls[0]["dedupe_key"] == "derived:intent:insurance:Auto renewal"


async def test_derive_with_no_publishable_slices_creates_nothing():
    svc, _info, signals = _derivation([])
    out = await svc.derive_for_user(user_id="owner")
    assert out == []
    assert signals.calls == []
