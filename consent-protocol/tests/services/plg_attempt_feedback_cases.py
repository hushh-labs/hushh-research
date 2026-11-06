"""Real SQL: unrelated feedback gaps cannot postpone a confirmed hard bounce."""

from contextlib import asynccontextmanager
from types import SimpleNamespace

from hushh_mcp.services import attempt_email_feedback as feedback
from hushh_mcp.services.account_deletion_lifecycle_service import account_deletion_user_hash


async def assert_bounce_survives_unrelated_feedback_gap(pool, monkeypatch, owner, report):
    async with pool.acquire() as conn:

        @asynccontextmanager
        async def acquire(**_kwargs):
            yield conn

        async def get_pool():
            return SimpleNamespace(acquire=acquire)

        with monkeypatch.context() as patch:
            patch.setattr(feedback, "get_pool", get_pool)
            for gap in ("sending", "uncertain", "unbound", "blocked_submission", "blocked_bounce"):
                transaction = conn.transaction()
                await transaction.start()
                try:
                    peer = "feedback-peer-" + gap
                    peer_hash = "e" * 64
                    await conn.execute("INSERT INTO actor_profiles VALUES($1)", peer)
                    await conn.execute("INSERT INTO vault_keys VALUES($1)", peer)
                    await conn.execute(
                        "INSERT INTO one_product_activity_epochs(user_id) VALUES($1)", peer
                    )
                    await conn.execute(
                        """INSERT INTO one_attempt_email_preferences
                        (user_id,enabled,revision,generation,activity_generation,email_hash,
                         disclosure_version,consent_at)
                        SELECT $1,TRUE,p.revision,p.generation,e.generation,$3,
                          p.disclosure_version,p.consent_at
                        FROM one_attempt_email_preferences p,one_product_activity_epochs e
                        WHERE p.user_id=$2 AND e.user_id=$1""",
                        peer,
                        owner,
                        peer_hash,
                    )
                    status = gap if gap in ("sending", "uncertain") else "accepted"
                    provider = None if status != "accepted" else "provider_peer"
                    message = "<peer@example.invalid>" if gap == "blocked_bounce" else None
                    peer_id = await conn.fetchval(
                        """INSERT INTO one_attempt_email_outbox
                        (user_id,activity_generation,attempt_key,permission_generation,
                         permission_revision,recipient_hash,agent_id,action_id,phase,observed_at,
                         status,claim_id,claimed_at,provider_id,accepted_at,rfc_message_id)
                        SELECT $1,e.generation,d.attempt_key,d.permission_generation,
                          d.permission_revision,$3,d.agent_id,d.action_id,d.phase,d.observed_at,
                          $4,gen_random_uuid(),NOW(),$5,
                          CASE WHEN $5::text IS NOT NULL THEN NOW() END,$6
                        FROM one_attempt_email_outbox d,one_product_activity_epochs e
                        WHERE d.user_id=$2 AND d.rfc_message_id=$7 AND e.user_id=$1
                        RETURNING id""",
                        peer,
                        owner,
                        peer_hash,
                        status,
                        provider,
                        message,
                        report["messageId"],
                    )
                    assert peer_id is not None
                    if gap.startswith("blocked_"):
                        await conn.execute(
                            """INSERT INTO account_deletion_tombstones
                            (user_id_hash,cleanup_intent_kind) VALUES($1,'phone_orphan')""",
                            account_deletion_user_hash(peer),
                        )
                    submissions = (
                        [
                            {
                                "providerId": provider,
                                "recipientHash": peer_hash,
                                "messageId": "<peer@example.invalid>",
                            }
                        ]
                        if gap == "blocked_submission"
                        else []
                    )
                    bounces = (
                        [{"messageId": message, "recipientHash": peer_hash}]
                        if gap == "blocked_bounce"
                        else []
                    ) + [report]
                    before = await conn.fetchrow(
                        "SELECT enabled,revision FROM one_attempt_email_preferences WHERE user_id=$1",
                        owner,
                    )
                    assert before["enabled"]
                    for _ in range(2):
                        # The page stays replayable; the known recipient is blocked now.
                        assert not await feedback.apply(submissions=submissions, bounces=bounces)
                        current = await conn.fetchrow(
                            """SELECT enabled,delivery_blocked,revision
                            FROM one_attempt_email_preferences WHERE user_id=$1""",
                            owner,
                        )
                        assert not current["enabled"], gap
                        assert current["delivery_blocked"], gap
                        assert current["revision"] == before["revision"] + 1, gap
                        assert await conn.fetchval(
                            """SELECT bounced_at IS NOT NULL FROM one_attempt_email_outbox
                            WHERE user_id=$1 AND rfc_message_id=$2""",
                            owner,
                            report["messageId"],
                        ), gap
                    retained = await conn.fetchrow(
                        "SELECT status,provider_id,rfc_message_id,bounced_at FROM one_attempt_email_outbox WHERE id=$1",
                        peer_id,
                    )
                    assert retained["status"] == status
                    assert retained["provider_id"] == provider
                    assert retained["rfc_message_id"] == message
                    assert retained["bounced_at"] is None
                finally:
                    # Only this disposable test transaction is rolled back.
                    await transaction.rollback()
