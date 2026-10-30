"""Migration 433: directory presence, and the directory item shape that carries it."""

from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from hushh_mcp.services import connection_presence as presence
from hushh_mcp.services.connections_service import ConnectionsError, ConnectionsService
from tests.services.test_connections_service import _RecordingDB


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, None),
        ("", None),
        ("   ", None),
        ("  Pediatric   nurse \n", "Pediatric nurse"),
        ("x" * 80, "x" * 80),
    ],
)
def test_role_label_is_trimmed_collapsed_and_cleared_when_empty(raw, expected):
    assert presence.normalize_role_label(raw) == expected


@pytest.mark.parametrize(
    "raw,code",
    [("x" * 81, "CONNECTION_ROLE_LABEL_TOO_LONG"), ("nurse\x00", "CONNECTION_ROLE_LABEL_INVALID")],
)
def test_role_label_refuses_overlong_and_control_characters(raw, code):
    with pytest.raises(ConnectionsError) as caught:
        presence.normalize_role_label(raw)
    assert caught.value.code == code
    assert caught.value.status_code == 422


def test_directory_presence_reads_never_chosen_as_the_vault_rule():
    row = {
        "directory_listed": None,
        "role_label": None,
        "vault_enrolled": True,
        "updated_at": datetime(2026, 10, 27, tzinfo=timezone.utc),
    }
    payload = presence.get_directory_presence(lambda sql, params: row, user_id="owner")
    assert payload["listed"] is None
    assert payload["effectiveListed"] is True
    assert payload["vaultEnrolled"] is True
    assert payload["roleLabel"] is None
    assert payload["updatedAt"] == "2026-10-27T00:00:00+00:00"


def test_directory_presence_missing_row_reads_as_unlisted_without_inventing_a_profile():
    assert presence.get_directory_presence(lambda sql, params: None, user_id="owner") == {
        "listed": None,
        "effectiveListed": False,
        "roleLabel": None,
        "vaultEnrolled": False,
        "roleLabelMaxLength": 80,
        "updatedAt": None,
    }


def test_directory_presence_update_writes_only_sent_fields_and_binds_values():
    statements = []

    def write(sql, params):
        statements.append((sql, params))
        return {"directory_listed": params["listed"], "role_label": None, "vault_enrolled": False}

    payload = presence.update_directory_presence(
        write, user_id="owner", fields={"listed"}, listed=True
    )
    sql, params = statements[0]
    assert "directory_listed = :listed" in sql
    assert "role_label" not in sql.split("RETURNING")[0]
    assert params == {"user_id": "owner", "listed": True}
    assert payload["listed"] is True
    assert payload["effectiveListed"] is True


def test_directory_presence_update_normalizes_the_role_label_before_writing():
    captured = {}

    def write(sql, params):
        captured.update(params)
        return {
            "directory_listed": False,
            "role_label": params["role_label"],
            "vault_enrolled": True,
        }

    payload = presence.update_directory_presence(
        write, user_id="owner", fields={"role_label"}, role_label="  Retired   teacher "
    )
    assert captured["role_label"] == "Retired teacher"
    assert payload["roleLabel"] == "Retired teacher"
    # An explicit opt-out wins over an enrolled vault.
    assert payload["effectiveListed"] is False


@pytest.mark.parametrize("fields", [set(), {"unknown"}])
def test_directory_presence_update_refuses_an_empty_change(fields):
    def write(sql, params):
        pytest.fail("no write expected")

    with pytest.raises(ConnectionsError) as caught:
        presence.update_directory_presence(write, user_id="owner", fields=fields)
    assert caught.value.code == "CONNECTION_PRESENCE_EMPTY"


def test_directory_presence_update_without_a_spine_row_asks_for_a_retry():
    with pytest.raises(ConnectionsError) as caught:
        presence.update_directory_presence(
            lambda sql, params: None, user_id="owner", fields={"listed"}, listed=True
        )
    assert caught.value.code == "CONNECTION_PRESENCE_PROFILE_MISSING"
    assert caught.value.status_code == 409


def test_search_directory_items_carry_the_role_label_from_the_directory_row():
    def directory_search(owner_user_id: str, **options: object) -> dict[str, object]:
        return {
            "items": [
                {"userId": "user-c", "displayName": "Cara", "roleLabel": "Plumber"},
                {"userId": "user-d", "displayName": "Dev"},
            ],
            "page": 1,
            "hasMore": False,
        }

    svc = ConnectionsService(directory_search=directory_search)
    db = _RecordingDB([[], [], []])  # no pending / connections
    with patch("hushh_mcp.services.connections_service.get_db", lambda: db):
        out = svc.search_directory("user-a", query="", page=1, limit=20)
    assert [(item["userId"], item.get("roleLabel")) for item in out["items"]] == [
        ("user-c", "Plumber"),
        ("user-d", None),
    ]
