"""Real Postgres proof for the To-do Wallet request inventory boundary."""

# ruff: noqa: F811 -- imported owning pytest fixture
import uuid

import pytest
from sqlalchemy import text
from test_wallet_card_access_postgres import (  # noqa: F401
    cards_db,
    incoming_requests,
    legacy_cards_db,
    projection_db,
)

import hushh_mcp.services.wallet_card_request_service as request_module
from hushh_mcp.services.wallet_card_access_service import WalletCardAccessError


def test_pending_task_inventory_is_owner_scoped_paged_metadata_only(incoming_requests):
    db, _, requests = incoming_requests
    target = str(
        db.execute_raw(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id='alice'", {}
        ).data[0]["public_person_ref"]
    )
    first = requests.create("bob", target, str(uuid.uuid4()))
    second = requests.create("charu", target, str(uuid.uuid4()))
    page = requests.list_pending("alice", limit=1)
    assert page["hasMore"] is True
    assert set(page["items"][0]) == {"id", "createdAt", "expiresAt", "requesterName"}
    assert page["items"][0]["id"] == second["id"]
    assert page["items"][0]["requesterName"] == "Charu"
    with db.engine.begin() as conn:
        conn.execute(
            text("UPDATE actor_identity_cache SET display_name=:name WHERE user_id='charu'"),
            {"name": "A" * 200},
        )
    assert requests.list_pending("alice", limit=1)["items"][0]["requesterName"] == "A" * 160
    # A resolved anchor remains usable without making that request visible.
    requests.decide("alice", second["id"], "declined")
    following = requests.list_pending("alice", cursor=page["nextCursor"], limit=1)
    assert [row["id"] for row in following["items"]] == [first["id"]]
    assert following["items"][0]["requesterName"] == "Rupman"
    assert following["hasMore"] is False
    assert requests.list_pending("bob")["items"] == []
    with pytest.raises(WalletCardAccessError, match="NOT_FOUND"):
        requests.list_pending("bob", cursor=first["id"])


@pytest.mark.parametrize(
    "change,visible",
    [
        ("expiry", False),
        ("recipient_delete", False),
        ("everyone_delete", False),
        ("disconnect", False),
        ("block", False),
        ("sender_delete", True),
    ],
)
def test_pending_task_inventory_preserves_visibility_and_never_mutates_requests(
    incoming_requests, monkeypatch, change, visible
):
    db, _, requests = incoming_requests
    target = str(
        db.execute_raw(
            "SELECT public_person_ref FROM actor_profiles WHERE user_id='alice'", {}
        ).data[0]["public_person_ref"]
    )
    if change == "expiry":
        query = request_module.one

        def historical_creation(conn, sql, values=None):
            # Same owning-suite clock seam: insert a valid past request without
            # mutating immutable timestamps or disabling the database guard.
            return query(
                conn,
                sql.replace(
                    "SELECT clock_timestamp() AS t",
                    "SELECT clock_timestamp()-interval '8 days' AS t",
                ),
                values,
            )

        monkeypatch.setattr(request_module, "one", historical_creation)
    request = requests.create("bob", target, str(uuid.uuid4()))
    updates = {
        "recipient_delete": "UPDATE messages SET deleted_for_recipient_at=clock_timestamp() WHERE id=(SELECT message_id FROM wallet_card_requests WHERE id=CAST(:id AS uuid))",
        "everyone_delete": "UPDATE messages SET deleted_for_everyone_at=clock_timestamp() WHERE id=(SELECT message_id FROM wallet_card_requests WHERE id=CAST(:id AS uuid))",
        "sender_delete": "UPDATE messages SET deleted_for_sender_at=clock_timestamp() WHERE id=(SELECT message_id FROM wallet_card_requests WHERE id=CAST(:id AS uuid))",
        "disconnect": "UPDATE connections SET status='revoked' WHERE user_a_id='alice' AND user_b_id='bob'",
        "block": "INSERT INTO direct_message_blocks(blocker_user_id,blocked_user_id) VALUES('alice','bob')",
    }
    if change != "expiry":
        with db.engine.begin() as conn:
            conn.execute(text(updates[change]), {"id": request["id"]})
    assert bool(requests.list_pending("alice")["items"]) is visible
    assert (
        db.execute_raw(
            "SELECT status FROM wallet_card_requests WHERE id=CAST(:id AS uuid)",
            {"id": request["id"]},
        ).data[0]["status"]
        == "pending"
    )
