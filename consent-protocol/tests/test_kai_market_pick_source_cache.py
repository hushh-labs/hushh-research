from __future__ import annotations

import pytest

from api.routes.kai import market_insights


def test_pick_source_roster_signature_tracks_source_identity_and_artifact_freshness():
    signature = market_insights._pick_source_roster_signature(
        [
            {
                "id": "ria:profile_1",
                "state": "ready",
                "share_status": "active",
                "artifact_id": "artifact_1",
                "source_data_version": 7,
                "artifact_updated_at": "2026-04-02T12:34:56Z",
            },
            {
                "id": "ria:profile_2",
                "state": "pending",
                "share_status": "active",
                "upload_id": None,
                "source_data_version": None,
                "artifact_updated_at": None,
            },
        ]
    )

    assert signature == (
        "ria:profile_1:ready:active:artifact_1:7:2026-04-02T12:34:56Z|"
        "ria:profile_2:pending:active:::"
    )


def test_pick_row_value_supports_dict_and_object_rows():
    class _Row:
        ticker = "AAPL"

    assert market_insights._pick_row_value({"ticker": "MSFT"}, "ticker") == "MSFT"
    assert market_insights._pick_row_value(_Row(), "ticker") == "AAPL"
    assert market_insights._pick_row_value(_Row(), "missing") is None


@pytest.mark.asyncio
async def test_resolve_pick_source_rows_uses_preloaded_ria_sources(monkeypatch):
    class _FakeRenaissanceService:
        async def get_all_investable(self):
            return [{"ticker": "AAPL"}]

    async def _unexpected_list_sources(self, user_id: str):  # noqa: ANN001
        raise AssertionError(f"RIA source lookup should not run for {user_id}")

    monkeypatch.setattr(
        market_insights,
        "get_renaissance_service",
        lambda: _FakeRenaissanceService(),
    )
    monkeypatch.setattr(
        market_insights.RIAIAMService,
        "list_investor_pick_sources",
        _unexpected_list_sources,
    )

    rows, sources, resolved = await market_insights._resolve_pick_source_rows(
        "investor_1",
        "default",
        ria_sources=[
            {
                "id": "ria:profile_1",
                "label": "Advisor Alpha",
                "kind": "ria",
                "state": "ready",
                "is_default": False,
                "share_status": "active",
                "share_origin": "relationship_implicit",
                "share_granted_at": "2026-03-25T00:00:00Z",
                "upload_id": "upload_1",
            }
        ],
    )

    assert resolved == "default"
    assert rows == [{"ticker": "AAPL"}]
    assert [source["id"] for source in sources] == ["default", "ria:profile_1"]
