import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from hushh_mcp.services.consent_center_service import ConsentCenterService


def test_person_consent_uses_current_avatar_and_clears_removed_photo():
    priya_ref = "11111111-1111-4111-8111-111111111111"
    meena_ref = "22222222-2222-4222-8222-222222222222"
    inactive_ref = "33333333-3333-4333-8333-333333333333"
    svc = ConsentCenterService.__new__(ConsentCenterService)
    svc._read_only = False
    svc._identity = MagicMock()
    svc._identity.ensure_many = AsyncMock(
        return_value={
            "uid-priya": {
                "display_name": "Priya",
                "photo_url": "https://example.test/priya.png",
            },
            "uid-meena": {"display_name": "Meena", "photo_url": None},
        }
    )
    fake_db = MagicMock()
    fake_db.execute_raw.return_value.data = [
        {"public_person_ref": priya_ref, "user_id": "uid-priya"},
        {"public_person_ref": meena_ref, "user_id": "uid-meena"},
    ]

    with patch("hushh_mcp.services.consent_center_service.get_db", return_value=fake_db):
        entries = asyncio.run(
            svc._hydrate_entry_identities(
                [
                    {
                        "counterpart_type": "person",
                        "counterpart_id": priya_ref,
                        "counterpart_label": "Priya",
                    },
                    {
                        "counterpart_type": "person",
                        "counterpart_id": meena_ref,
                        "counterpart_label": "Meena",
                        "counterpart_image_url": "https://example.test/old.png",
                    },
                    {
                        "counterpart_type": "person",
                        "counterpart_id": inactive_ref,
                        "counterpart_image_url": "https://example.test/inactive.png",
                    },
                    {
                        "counterpart_type": "developer",
                        "counterpart_id": "app-1",
                        "counterpart_image_url": "https://example.test/logo.png",
                    },
                ]
            )
        )

    assert "public_profile_status = 'active'" in fake_db.execute_raw.call_args.args[0]
    assert fake_db.execute_raw.call_args.args[1] == {
        "person_refs": [priya_ref, meena_ref, inactive_ref]
    }
    svc._identity.ensure_many.assert_awaited_once_with(["uid-priya", "uid-meena"])
    assert entries[0]["counterpart_image_url"] == "https://example.test/priya.png"
    assert entries[0]["counterpart_id"] == priya_ref
    assert entries[1]["counterpart_image_url"] is None
    assert entries[2]["counterpart_image_url"] is None
    assert entries[3]["counterpart_image_url"] == "https://example.test/logo.png"


def test_person_consent_invalid_public_ref_does_not_retain_request_time_avatar():
    svc = ConsentCenterService.__new__(ConsentCenterService)
    svc._read_only = False
    svc._identity = MagicMock()
    svc._identity.ensure_many = AsyncMock(return_value={})

    with patch("hushh_mcp.services.consent_center_service.get_db") as fake_db:
        entries = asyncio.run(
            svc._hydrate_entry_identities(
                [
                    {
                        "counterpart_type": "person",
                        "counterpart_id": "not-a-public-ref",
                        "counterpart_image_url": "https://example.test/stale.png",
                    }
                ]
            )
        )

    fake_db.assert_not_called()
    svc._identity.ensure_many.assert_awaited_once_with([])
    assert entries[0]["counterpart_image_url"] is None


def test_person_consent_lookup_failure_does_not_retain_request_time_avatar():
    svc = ConsentCenterService.__new__(ConsentCenterService)
    svc._read_only = False
    svc._identity = MagicMock()
    svc._identity.ensure_many = AsyncMock(return_value={})
    person_ref = "44444444-4444-4444-8444-444444444444"
    fake_db = MagicMock()
    fake_db.execute_raw.side_effect = RuntimeError("database unavailable")

    with patch("hushh_mcp.services.consent_center_service.get_db", return_value=fake_db):
        entries = asyncio.run(
            svc._hydrate_entry_identities(
                [
                    {
                        "counterpart_type": "person",
                        "counterpart_id": person_ref,
                        "counterpart_image_url": "https://example.test/stale.png",
                    }
                ]
            )
        )

    svc._identity.ensure_many.assert_awaited_once_with([])
    assert entries[0]["counterpart_image_url"] is None


def test_consents_pending_count_includes_incoming_connection_requests():
    svc = ConsentCenterService.__new__(ConsentCenterService)

    fake_conn = MagicMock()
    fake_conn.list_requests.return_value = [{"id": "req-1"}, {"id": "req-2"}]

    with patch(
        "hushh_mcp.services.consent_center_service.ConnectionsService",
        return_value=fake_conn,
    ):
        count = asyncio.run(svc._incoming_connection_request_count("user-a"))
    assert count == 2
    fake_conn.list_requests.assert_called_once_with("user-a", direction="incoming")


def test_incoming_entries_surface_public_scope_proposals_for_selection():
    """Connection review exposes proposal presentation only, never raw scopes."""
    svc = ConsentCenterService.__new__(ConsentCenterService)

    fake_conn = MagicMock()
    fake_conn.list_requests.return_value = [
        {
            "id": "req-scoped",
            "counterpartUserId": "ria-1",
            "counterpartDisplayName": "Ada RIA",
            "message": "sharing a pick",
            "scopes": [
                {
                    "scopeHandle": "scp_1",
                    "direction": "requested",
                    "label": "RIA Picks",
                    "description": "Use this RIA's published investment picks.",
                    "status": "pending",
                }
            ],
        },
        {
            "id": "req-plain",
            "counterpartUserId": "friend-1",
            # no scopes key at all → plain connect
        },
    ]

    with patch(
        "hushh_mcp.services.consent_center_service.ConnectionsService",
        return_value=fake_conn,
    ):
        entries = asyncio.run(svc._incoming_connection_request_entries("user-a"))

    by_id = {e["id"]: e for e in entries}
    assert by_id["req-scoped"]["metadata"]["scope_proposals"] == [
        {
            "scopeHandle": "scp_1",
            "direction": "requested",
            "label": "RIA Picks",
            "description": "Use this RIA's published investment picks.",
            "status": "pending",
        }
    ]
    assert by_id["req-scoped"]["kind"] == "connection_request"
    assert by_id["req-plain"]["metadata"]["scope_proposals"] == []
    fake_conn.list_requests.assert_called_once_with("user-a", direction="incoming")
