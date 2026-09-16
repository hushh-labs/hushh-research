from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hushh_mcp.services.person_profile_service import PersonProfileService


class _Connections:
    def get_information_scope_catalog(self, *_args, **_kwargs):
        return {
            "items": [
                {
                    "scope": "attr.identity.legal_name",
                    "label": "Legal name",
                    "description": "Name used on official records",
                    "domain": "identity",
                    "sensitivity": "sensitive",
                    "wildcard": False,
                }
            ]
        }


class _Consent:
    async def get_active_tokens(self, *_args, **_kwargs):
        return []


@pytest.mark.asyncio
async def test_viewer_profile_exposes_opaque_scope_metadata_without_raw_scope() -> None:
    rows = iter(
        [
            [
                {
                    "user_id": "subject",
                    "public_person_ref": "11111111-1111-4111-8111-111111111111",
                    "display_name": "A Person",
                    "photo_url": None,
                    "is_verified_ria": False,
                }
            ],
            [{"public_person_ref": "22222222-2222-4222-8222-222222222222"}],
            [],
            [],
            [],
        ]
    )
    db = SimpleNamespace(execute_raw=lambda *_args, **_kwargs: SimpleNamespace(data=next(rows)))
    service = PersonProfileService(connections=_Connections(), consent_db=_Consent())
    with patch("hushh_mcp.services.person_profile_service.get_db", lambda: db):
        payload = await service.get_viewer_profile(
            viewer_user_id="viewer",
            public_person_ref="11111111-1111-4111-8111-111111111111",
        )
    assert payload["requestableScopes"][0]["scopeRef"].startswith("psr_")
    assert "scope" not in payload["requestableScopes"][0]
    assert payload["relationship"]["status"] == "none"


class _ConsentWithHistory(_Consent):
    """Ledger stub: each request id resolves to a fixed latest action."""

    def __init__(self, latest_by_request: dict[str, str | None]) -> None:
        self._latest_by_request = latest_by_request

    async def get_request_status(self, _subject_user_id: str, request_id: str):
        action = self._latest_by_request.get(request_id)
        if action is None:
            return None
        return {"action": action, "expires_at": None}


def _request_row(request_id: str, *, cancelled_at: str | None = None) -> dict:
    return {
        "bundle_id": "bundle-1",
        "purpose": "Verify identity",
        "duration_seconds": 3600,
        "created_at": "2026-09-14T00:00:00+00:00",
        "cancelled_at": cancelled_at,
        "request_id": request_id,
        "scope_ref": "psr_abc",
        "label": "Legal name",
        "sensitivity": "sensitive",
    }


@pytest.mark.asyncio
async def test_viewer_request_history_reports_a_withdrawn_request_as_cancelled() -> None:
    """A CANCELLED ledger row is its own state, never "pending" or "denied".

    Also covers the bundle-only fallback: a row stamped cancelled_at whose
    ledger never recorded the withdrawal reads the same way.
    """
    rows = iter(
        [
            [
                {
                    "user_id": "subject",
                    "public_person_ref": "11111111-1111-4111-8111-111111111111",
                    "display_name": "A Person",
                    "photo_url": None,
                    "is_verified_ria": False,
                }
            ],
            [{"public_person_ref": "22222222-2222-4222-8222-222222222222"}],
            [
                _request_row("req-cancelled"),
                _request_row("req-stamped-only", cancelled_at="2026-09-14T01:00:00+00:00"),
                _request_row("req-denied"),
                _request_row("req-pending"),
            ],
            [],
            [],
        ]
    )
    db = SimpleNamespace(execute_raw=lambda *_args, **_kwargs: SimpleNamespace(data=next(rows)))
    consent = _ConsentWithHistory(
        {
            "req-cancelled": "CANCELLED",
            "req-stamped-only": "REQUESTED",
            "req-denied": "CONSENT_DENIED",
            "req-pending": "REQUESTED",
        }
    )
    service = PersonProfileService(connections=_Connections(), consent_db=consent)
    with patch("hushh_mcp.services.person_profile_service.get_db", lambda: db):
        payload = await service.get_viewer_profile(
            viewer_user_id="viewer",
            public_person_ref="11111111-1111-4111-8111-111111111111",
        )

    by_request = {item["requestId"]: item["status"] for item in payload["requestHistory"]}
    assert by_request == {
        "req-cancelled": "cancelled",
        "req-stamped-only": "cancelled",
        "req-denied": "denied",
        "req-pending": "pending",
    }
