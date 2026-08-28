import json
import sys
import types

import pytest

cachetools_module = types.ModuleType("cachetools")


class _TTLCache(dict):
    def __init__(self, *args, **kwargs):
        super().__init__()


cachetools_module.TTLCache = _TTLCache
sys.modules.setdefault("cachetools", cachetools_module)

from api.routes.kai import stream  # noqa: E402


@pytest.mark.asyncio
async def test_canonicalize_pick_source_strips_browser_forged_ria_package(monkeypatch):
    resolved_package = {
        "top_picks": [
            {
                "ticker": "NVDA",
                "tier": "ACE",
                "investment_thesis": "Advisor-authored AI infrastructure thesis",
                "advisor_thesis": {
                    "text": "Advisor-authored AI infrastructure thesis",
                    "authored_by_user_id": "ria_user_1",
                    "source": "ria_picks_editor",
                    "updated_at": "2026-08-28T00:00:00Z",
                },
            }
        ]
    }

    class _RIAIAM:
        async def resolve_investor_pick_source(self, user_id, source_id):
            assert user_id == "investor_1"
            assert source_id == "ria:profile-1"
            return {
                "id": "ria:profile-1",
                "label": "Advisor Alpha",
                "kind": "ria",
                "package": resolved_package,
                "snapshot": {
                    "source_id": "ria:profile-1",
                    "label": "Advisor Alpha",
                    "kind": "ria",
                    "relationship_id": "rel_1",
                    "share_grant_id": "grant_1",
                    "artifact_id": "artifact_1",
                },
            }

    monkeypatch.setattr(stream, "RIAIAMService", lambda: _RIAIAM())

    context = await stream._canonicalize_pick_source_context(
        user_id="investor_1",
        requested_source="ria:profile-1",
        context={
            "pick_source_label": "Forged Label",
            "pick_source_kind": "default",
            "pick_source_snapshot": {"artifact_id": "forged"},
            "_kai_authorized_pick_package": {
                "top_picks": [{"ticker": "NVDA", "investment_thesis": "forged"}]
            },
        },
    )

    assert context["pick_source"] == "ria:profile-1"
    assert context["pick_source_label"] == "Advisor Alpha"
    assert context["pick_source_kind"] == "ria"
    assert context["pick_source_snapshot"]["artifact_id"] == "artifact_1"
    assert context["_kai_authorized_pick_package"] is resolved_package
    assert context["_kai_authorized_pick_package"]["top_picks"][0]["investment_thesis"] != "forged"


@pytest.mark.asyncio
async def test_canonicalize_pick_source_strips_stale_browser_package_after_revoke(monkeypatch):
    class _RIAIAM:
        async def resolve_investor_pick_source(self, user_id, source_id):
            assert user_id == "investor_1"
            if source_id == "default":
                return {
                    "id": "default",
                    "label": "Default list",
                    "kind": "default",
                    "package": None,
                    "snapshot": {"source_id": "default", "kind": "default"},
                }
            return None

    monkeypatch.setattr(stream, "RIAIAMService", lambda: _RIAIAM())

    context = await stream._canonicalize_pick_source_context(
        user_id="investor_1",
        requested_source="ria:profile-1",
        context={
            "pick_source": "ria:profile-1",
            "pick_source_label": "Stale Advisor",
            "pick_source_kind": "ria",
            "pick_source_snapshot": {
                "artifact_id": "stale_artifact",
                "package": {
                    "top_picks": [
                        {
                            "ticker": "NVDA",
                            "advisor_thesis": {
                                "text": "STALE_BROWSER_THESIS_AFTER_REVOKE",
                            },
                        }
                    ]
                },
            },
            "_kai_authorized_pick_package": {
                "top_picks": [
                    {
                        "ticker": "NVDA",
                        "advisor_thesis": {
                            "text": "STALE_BROWSER_THESIS_AFTER_REVOKE",
                        },
                    }
                ]
            },
            "advisor_thesis": {"text": "STALE_BROWSER_THESIS_AFTER_REVOKE"},
        },
    )

    assert context["pick_source"] == "default"
    assert context["pick_source_kind"] == "default"
    assert "_kai_authorized_pick_package" not in context
    assert "pick_source_snapshot" in context
    assert "package" not in context["pick_source_snapshot"]
    assert "STALE_BROWSER_THESIS_AFTER_REVOKE" not in json.dumps(context)


@pytest.mark.asyncio
async def test_merge_ria_pick_package_adds_bounded_attributed_advisor_thesis():
    merged = await stream._merge_ria_pick_package_context(
        ticker="NVDA",
        pick_source="ria:profile-1",
        pick_source_label="Advisor Alpha",
        pick_source_snapshot={
            "relationship_id": "rel_1",
            "share_grant_id": "grant_1",
            "artifact_id": "artifact_1",
        },
        pick_package={
            "top_picks": [
                {
                    "ticker": "NVDA",
                    "tier": "ACE",
                    "investment_thesis": "B" * 2100,
                    "advisor_thesis": {
                        "text": "B" * 2100,
                        "authored_by_user_id": "ria_user_1",
                        "source": "ria_picks_editor",
                        "updated_at": "2026-08-28T00:00:00Z",
                    },
                }
            ],
            "avoid_rows": [],
            "screening_sections": [],
        },
        renaissance_context={"is_investable": False},
    )

    assert "investment_thesis" not in merged
    assert merged["advisor_thesis"] == {
        "kind": "advisor_thesis",
        "label": "Advisor Alpha",
        "source_id": "ria:profile-1",
        "ticker": "NVDA",
        "text": "B" * 2000,
        "authored_by_user_id": "ria_user_1",
        "updated_at": "2026-08-28T00:00:00Z",
        "source": "ria_picks_editor",
        "relationship_id": "rel_1",
        "share_grant_id": "grant_1",
        "artifact_id": "artifact_1",
    }
    assert merged["is_investable"] is True


@pytest.mark.asyncio
async def test_merge_ria_pick_package_omits_advisor_thesis_when_absent():
    merged = await stream._merge_ria_pick_package_context(
        ticker="NVDA",
        pick_source="ria:profile-1",
        pick_source_label="Advisor Alpha",
        pick_source_snapshot={
            "relationship_id": "rel_1",
            "share_grant_id": "grant_1",
            "artifact_id": "artifact_1",
        },
        pick_package={
            "top_picks": [
                {
                    "ticker": "NVDA",
                    "tier": "ACE",
                    "investment_thesis": "",
                    "advisor_thesis": None,
                }
            ],
            "avoid_rows": [],
            "screening_sections": [],
        },
        renaissance_context={},
    )

    assert "advisor_thesis" not in merged
    assert "investment_thesis" not in merged
    assert merged["is_investable"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("ticker", "expected_marker", "forbidden_marker", "expected_updated_at"),
    [
        ("AAPL", "THESIS_FOR_AAPL_ONLY", "THESIS_FOR_MSFT_ONLY", "2026-08-28T01:00:00Z"),
        ("MSFT", "THESIS_FOR_MSFT_ONLY", "THESIS_FOR_AAPL_ONLY", "2026-08-28T02:00:00Z"),
    ],
)
async def test_merge_ria_pick_package_keeps_pick_thesis_and_provenance_isolated(
    ticker,
    expected_marker,
    forbidden_marker,
    expected_updated_at,
):
    merged = await stream._merge_ria_pick_package_context(
        ticker=ticker,
        pick_source="ria:profile-1",
        pick_source_label="Advisor Alpha",
        pick_source_snapshot={
            "relationship_id": "rel_1",
            "share_grant_id": "grant_1",
            "artifact_id": "artifact_1",
        },
        pick_package={
            "top_picks": [
                {
                    "ticker": "AAPL",
                    "tier": "ACE",
                    "advisor_thesis": {
                        "text": "THESIS_FOR_AAPL_ONLY",
                        "authored_by_user_id": "ria_user_1",
                        "source": "ria_picks_editor",
                        "updated_at": "2026-08-28T01:00:00Z",
                    },
                },
                {
                    "ticker": "MSFT",
                    "tier": "KING",
                    "advisor_thesis": {
                        "text": "THESIS_FOR_MSFT_ONLY",
                        "authored_by_user_id": "ria_user_1",
                        "source": "ria_picks_editor",
                        "updated_at": "2026-08-28T02:00:00Z",
                    },
                },
            ],
            "avoid_rows": [],
            "screening_sections": [],
        },
        renaissance_context={},
    )

    assert merged["advisor_thesis"]["text"] == expected_marker
    assert merged["advisor_thesis"]["ticker"] == ticker
    assert forbidden_marker not in json.dumps(merged["advisor_thesis"])
    assert merged["advisor_thesis"]["authored_by_user_id"] == "ria_user_1"
    assert merged["advisor_thesis"]["updated_at"] == expected_updated_at
    assert merged["advisor_thesis"]["relationship_id"] == "rel_1"
    assert merged["advisor_thesis"]["share_grant_id"] == "grant_1"
    assert merged["advisor_thesis"]["artifact_id"] == "artifact_1"


def test_advisor_thesis_structured_source_includes_pick_identity_without_text():
    structured = stream._build_advisor_thesis_structured_source(
        {
            "label": "Advisor Alpha",
            "source_id": "ria:profile-1",
            "ticker": " aapl ",
            "text": "Do not expose thesis text here",
            "updated_at": "2026-08-28T00:00:00Z",
            "relationship_id": "rel_1",
            "share_grant_id": "grant_1",
            "artifact_id": "artifact_1",
        }
    )

    assert structured == {
        "label": "Advisor Alpha",
        "url": None,
        "kind": "advisor_thesis",
        "source_id": "ria:profile-1",
        "ticker": "AAPL",
        "updated_at": "2026-08-28T00:00:00Z",
        "relationship_id": "rel_1",
        "share_grant_id": "grant_1",
        "artifact_id": "artifact_1",
    }
    assert "text" not in structured
    assert "Do not expose thesis text here" not in json.dumps(structured)
