# consent-protocol/tests/test_one_location_sos_seed.py
import pytest

from hushh_mcp.services.one_location_agent_service import (
    OneLocationAgentError,
    OneLocationAgentService,
)


def _service_with_fake_db(count_existing, insert_sink):
    """Build a service without touching a real DB; stub _execute_one."""
    service = OneLocationAgentService.__new__(OneLocationAgentService)

    def fake_execute_one(sql, params):
        if "COUNT(*)" in sql:
            return {"n": count_existing}
        # INSERT path — record params, return a fake row.
        insert_sink.append(params)
        return {"id": f"conn-{len(insert_sink)}"}

    service._execute_one = fake_execute_one  # type: ignore[attr-defined]
    return service


def test_seed_inserts_one_connection_per_dev_when_no_existing():
    inserts: list[dict] = []
    service = _service_with_fake_db(0, inserts)
    result = service.seed_trusted_connections(
        owner_user_id="owner1", dev_user_ids=["devA", "devB", "devC"]
    )
    assert result["seeded"] == 3
    assert result["existingCount"] == 0
    assert len(inserts) == 3


def test_seed_skips_when_user_already_connected():
    inserts: list[dict] = []
    service = _service_with_fake_db(2, inserts)
    result = service.seed_trusted_connections(owner_user_id="owner1", dev_user_ids=["devA", "devB"])
    assert result["seeded"] == 0
    assert result["existingCount"] == 2
    assert inserts == []  # gated: no inserts when already connected


def test_seed_skips_self_and_blanks():
    inserts: list[dict] = []
    service = _service_with_fake_db(0, inserts)
    result = service.seed_trusted_connections(
        owner_user_id="owner1", dev_user_ids=["owner1", "", "devB"]
    )
    assert result["seeded"] == 1
    assert result["skippedSelf"] == 2
    assert len(inserts) == 1
    # ordered pair invariant: user_a_id < user_b_id
    params = inserts[0]
    assert params["user_a_id"] < params["user_b_id"]
    assert params["inviter_user_id"] == "owner1"
    assert params["invitee_user_id"] == "devB"


def test_seed_rejects_missing_owner():
    service = OneLocationAgentService.__new__(OneLocationAgentService)
    with pytest.raises(OneLocationAgentError):
        service.seed_trusted_connections(owner_user_id="  ", dev_user_ids=["devA"])
