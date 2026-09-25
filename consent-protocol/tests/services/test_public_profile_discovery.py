from __future__ import annotations

from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

import hushh_mcp.services.public_profile_discovery_service as discovery
from hushh_mcp.services.public_profile_discovery_service import (
    ProfileDiscoveryError,
    _profile_from_scan,
    _public_url,
    profile_discovery_user_enabled,
)


def test_profile_url_canonicalization_and_private_host_rejection():
    assert (
        _public_url("https://Example.com/person?tracking=secret#bio")
        == "https://example.com/person"
    )
    for value in (
        "http://example.com/person",
        "https://127.0.0.1/person",
        "https://localhost/person",
        "https://user:password@example.com/person",
    ):
        with pytest.raises(ProfileDiscoveryError):
            _public_url(value)


def test_profile_extraction_removes_contact_anchors_and_never_fabricates_observation_date():
    profile = _profile_from_scan(
        {
            "summary": "Researcher jane@example.com, +1 (415) 555-0184",
            "rich": {
                "evidence": [
                    {
                        "category": "Professional",
                        "claim": "Jane Doe works at Example Labs; contact jane@example.com or +1 (415) 555-0184",
                        "confidence": "high",
                        "sources": ["https://example.com/bio?session=private#contact"],
                    }
                ],
                "conflicts": ["A separate source shows a different title."],
            },
        },
        display_name="Jane Doe",
        collected_at="2026-09-23T12:00:00+00:00",
    )

    fact = profile["facts"][0]
    assert "jane@example.com" not in fact["claim"]
    assert "415" not in fact["claim"]
    assert fact["observed_at"] is None
    assert fact["collected_at"] == "2026-09-23T12:00:00+00:00"
    assert fact["source_urls"] == ["https://example.com/bio"]
    assert "jane@example.com" not in profile["summary"]


def test_scan_markdown_evidence_ledger_becomes_source_linked_review_facts():
    profile = _profile_from_scan(
        {
            "summary": "A source-backed public profile.",
            "report": """
## Evidence Ledger
| Claim | Source label | Source URL if public | Date/accessed context | Confidence | Contradiction/verification note |
| --- | --- | --- | --- | --- | --- |
| Founded Example Labs in 2021 | Public web evidence | https://example.com/about?ref=scan | 2021; accessed 2026-09-23 | High | Company page corroborates the role |
""",
            "citations": [{"uri": "https://example.com/about?ref=scan"}],
        },
        display_name="Jane Doe",
        collected_at="2026-09-23T12:00:00+00:00",
    )

    assert len(profile["facts"]) == 1
    fact = profile["facts"][0]
    assert fact["claim"] == "Founded Example Labs in 2021"
    assert fact["confidence"] == "high"
    assert fact["source_urls"] == ["https://example.com/about"]
    assert "2026-09-23" in fact["support"]
    assert fact["observed_at"] is None


def test_source_urls_reject_private_hosts_and_embedded_credentials():
    profile = _profile_from_scan(
        {
            "rich": {
                "evidence": [
                    {
                        "claim": "Public claim",
                        "sources": [
                            "https://user:secret@example.com/about",
                            "https://127.0.0.1/private",
                            "https://example.com/about",
                        ],
                    }
                ]
            }
        },
        display_name="Jane Doe",
        collected_at="2026-09-23T12:00:00+00:00",
    )

    assert profile["facts"][0]["source_urls"] == ["https://example.com/about"]


def test_scan_report_bullet_uses_its_own_citation_when_no_ledger_table_exists():
    profile = _profile_from_scan(
        {
            "report": "## Public Projects\n- Built an open-source compiler [1].\n- A second claim without a citation.",
            "citations": [{"uri": "https://github.com/example/compiler"}],
        },
        display_name="Jane Doe",
        collected_at="2026-09-23T12:00:00+00:00",
    )

    assert len(profile["facts"]) == 1
    assert profile["facts"][0]["claim"] == "Built an open-source compiler."
    assert profile["facts"][0]["source_urls"] == ["https://github.com/example/compiler"]


def test_hosted_cohort_fails_closed_and_wildcard_is_not_authority(monkeypatch):
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_DISCOVERY_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_DISCOVERY_ALLOWED_USER_IDS", "uid-a,uid-b")
    assert profile_discovery_user_enabled("uid-a") is True
    assert profile_discovery_user_enabled("uid-c") is False
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_DISCOVERY_ALLOWED_USER_IDS", "*")
    assert profile_discovery_user_enabled("uid-a") is False


def test_empty_hosted_cohort_fails_closed(monkeypatch):
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_DISCOVERY_ENABLED", "true")
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("ONE_PUBLIC_PROFILE_DISCOVERY_ALLOWED_USER_IDS", raising=False)
    assert profile_discovery_user_enabled("uid-a") is False


@pytest.mark.asyncio
async def test_worker_state_transition_can_clear_scan_reservation(monkeypatch):
    class AsyncContext:
        def __init__(self, value):
            self.value = value

        async def __aenter__(self):
            return self.value

        async def __aexit__(self, *_args):
            return None

    job_id = uuid4()
    lease_id = uuid4()
    row = {"job_id": job_id, "status": "scanning", "attempt_count": 1}

    class Connection:
        def transaction(self):
            return AsyncContext(None)

        async def fetchrow(self, *_args):
            return row

    connection = Connection()
    pool = type("Pool", (), {"acquire": lambda _self: AsyncContext(connection)})()
    monkeypatch.setattr(discovery, "get_pool", AsyncMock(return_value=pool))

    captured = {}

    async def capture_transition(_conn, *, row, status, **fields):
        captured.update(fields)
        captured["status"] = status
        return row

    service = discovery.PublicProfileDiscoveryService()
    monkeypatch.setattr(service, "_transition", capture_transition)

    await service._set_state(
        job_id,
        lease_id,
        "failed",
        error="scan_poll_failed",
        scan_id=None,
        scan_request_key=None,
        scan_deadline_at=None,
    )

    assert captured["status"] == "failed"
    assert captured["scan_id"] is None
    assert captured["scan_request_key"] is None
    assert captured["scan_deadline_at"] is None
    assert captured["attempt_count"] == 1
