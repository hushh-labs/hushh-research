import pytest

from hushh_mcp.services.trusted_connections_service import (
    IdentityUnresolvedError,
    TrustedConnectionsError,
    TrustedConnectionsService,
)


def _service(*, rows_one=None, rows_many=None, directory=None):
    """Build a service without a real DB; stub the execute + directory seams."""
    svc = TrustedConnectionsService.__new__(TrustedConnectionsService)
    calls = {"one": [], "many": []}

    def fake_one(sql, params=None):
        calls["one"].append((sql, params or {}))
        return (rows_one or {}).get(_tag(sql))

    def fake_many(sql, params=None):
        calls["many"].append((sql, params or {}))
        return (rows_many or {}).get(_tag(sql), [])

    svc._execute_one = fake_one  # type: ignore[attr-defined]
    svc._execute_many = fake_many  # type: ignore[attr-defined]
    svc._directory_lookup = lambda owner: directory or []  # type: ignore[attr-defined]
    svc._calls = calls  # type: ignore[attr-defined]
    return svc


def _tag(sql: str) -> str:
    s = sql.strip().upper()
    if s.startswith("INSERT"):
        return "insert"
    if s.startswith("UPDATE"):
        return "update"
    if "COUNT(*)" in s:
        return "count"
    if s.startswith("SELECT 1"):
        return "exists"
    return "select"


def test_add_by_user_id_passthrough_upserts():
    svc = _service(rows_one={"insert": {"id": "c1"}})
    out = svc.add_connection("owner1", trusted_user_id="devA", label="Dad")
    assert out["id"] == "c1"
    assert out["trustedUserId"] == "devA"
    assert out["resolvedVia"] == "user_id"
    assert svc._calls["one"][-1][1]["owner_user_id"] == "owner1"


def test_add_by_query_unique_match_resolves_from_directory():
    svc = _service(
        rows_one={"insert": {"id": "c2"}},
        directory=[{"userId": "u-alice", "displayName": "Alice Rivera"}],
    )
    out = svc.add_connection("owner1", query="alice")
    assert out["trustedUserId"] == "u-alice"
    assert out["resolvedVia"] == "directory"


def test_add_by_query_multiple_matches_raises_with_candidates():
    svc = _service(
        directory=[
            {"userId": "u1", "displayName": "Alice Rivera"},
            {"userId": "u2", "displayName": "Alice Tan"},
        ]
    )
    with pytest.raises(IdentityUnresolvedError) as exc:
        svc.add_connection("owner1", query="alice")
    assert len(exc.value.candidates) == 2


def test_add_by_query_no_match_raises():
    svc = _service(directory=[{"userId": "u1", "displayName": "Bob"}])
    with pytest.raises(IdentityUnresolvedError):
        svc.add_connection("owner1", query="alice")


def test_add_rejects_self():
    svc = _service()
    with pytest.raises(TrustedConnectionsError):
        svc.add_connection("owner1", trusted_user_id="owner1")


def test_add_requires_identifier():
    svc = _service()
    with pytest.raises(TrustedConnectionsError):
        svc.add_connection("owner1")


def test_remove_revokes():
    svc = _service(rows_one={"update": {"id": "c1"}})
    out = svc.remove_connection("owner1", "devA")
    assert out == {"removed": 1, "trustedUserId": "devA"}


def test_remove_missing_is_idempotent_noop():
    svc = _service(rows_one={})  # update returns None
    out = svc.remove_connection("owner1", "devA")
    assert out == {"removed": 0, "trustedUserId": "devA"}


def test_list_connections_returns_active():
    svc = _service(
        rows_many={
            "select": [
                {
                    "trusted_user_id": "devA",
                    "display_name": "Alice",
                    "label": None,
                    "created_at": "2026-07-05T00:00:00Z",
                }
            ]
        }
    )
    out = svc.list_connections("owner1")
    assert out == [
        {
            "trustedUserId": "devA",
            "displayName": "Alice",
            "label": None,
            "createdAt": "2026-07-05T00:00:00Z",
        }
    ]


def test_is_trusted_true_false():
    yes = _service(rows_one={"exists": {"ok": 1}})
    assert yes.is_trusted("owner1", "devA") is True
    no = _service(rows_one={})
    assert no.is_trusted("owner1", "devA") is False


def test_seed_inserts_one_edge_per_dev_when_empty():
    svc = _service(rows_one={"count": {"n": 0}, "insert": {"id": "c1"}})
    out = svc.seed_new_user("owner1", ["devA", "devB", "devC"])
    assert out["seeded"] == 3 and out["existingCount"] == 0


def test_seed_skips_when_already_connected():
    svc = _service(rows_one={"count": {"n": 2}})
    out = svc.seed_new_user("owner1", ["devA"])
    assert out == {"seeded": 0, "existingCount": 2, "skippedSelf": 0}


def test_seed_skips_self_and_blanks():
    svc = _service(rows_one={"count": {"n": 0}, "insert": {"id": "c1"}})
    out = svc.seed_new_user("owner1", ["owner1", "", "devB"])
    assert out["seeded"] == 1 and out["skippedSelf"] == 2


def test_seed_rejects_missing_owner():
    svc = _service()
    with pytest.raises(TrustedConnectionsError):
        svc.seed_new_user("  ", ["devA"])
