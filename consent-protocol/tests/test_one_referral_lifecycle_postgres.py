"""Real PostgreSQL referral transactions, concurrency and authority boundaries.

Use CI's ONE_COMMAND_TEST_DATABASE_URL or set REFERRAL_TEST_DATABASE_URL to a
disposable PostgreSQL database. Each test owns a random isolated schema.
"""

import importlib
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

from db.migration_authority import _replay_sql, build_manifest_entries
from hushh_mcp.services import one_referral_activity_service as activity
from hushh_mcp.services import one_referral_challenge_service as challenge
from hushh_mcp.services import one_referral_circle_service as wars
from hushh_mcp.services import one_referral_leaderboard_service as leaderboard
from hushh_mcp.services import one_referral_maintenance_service as maintenance
from hushh_mcp.services import one_referral_network_service as network
from hushh_mcp.services import one_referral_program_settings_service as settings
from hushh_mcp.services import one_referral_rewards_service as rewards
from hushh_mcp.services import one_referral_scoring_service as scoring
from hushh_mcp.services import one_referral_service as referrals

pytestmark = pytest.mark.db
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def db(monkeypatch):
    url = os.getenv("REFERRAL_TEST_DATABASE_URL") or os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("A disposable referral or canonical CI PostgreSQL URL is required")
    schema = "referral_test_" + uuid4().hex
    admin = create_engine(url)
    with admin.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(url, connect_args={"options": f"-c search_path={schema},public"})
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.exec_driver_sql("""
              CREATE TABLE actor_profiles(user_id TEXT PRIMARY KEY,created_at TIMESTAMPTZ DEFAULT clock_timestamp());
              CREATE TABLE actor_identity_cache(user_id TEXT PRIMARY KEY,display_name TEXT,phone_verified BOOLEAN);
              CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY,setup_completed BOOLEAN,setup_completed_at BIGINT);
              CREATE TABLE one_location_circles(id UUID PRIMARY KEY,name TEXT,status TEXT DEFAULT 'active',owner_user_id TEXT,system_kind TEXT);
              CREATE TABLE one_location_circle_memberships(circle_id UUID,user_id TEXT,status TEXT DEFAULT 'active',PRIMARY KEY(circle_id,user_id));
              CREATE TABLE one_location_circle_members(circle_id UUID,user_id TEXT,status TEXT);
              CREATE TABLE pkm_data(user_id TEXT PRIMARY KEY,encrypted_data_ciphertext TEXT);
              CREATE TABLE pkm_events(id BIGSERIAL PRIMARY KEY,user_id TEXT NOT NULL,domain TEXT NOT NULL,
                operation_type TEXT NOT NULL,metadata JSONB NOT NULL DEFAULT '{}');
              CREATE TABLE connections(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_a_id TEXT,user_b_id TEXT,status TEXT DEFAULT 'active');
            """)
            for number in (55, 165, 184, 270, 271, 272, 273, 274, 289, 338, 347, 348, 349, 358):
                path = next((ROOT / "db/migrations").glob(f"{number:03d}_*.sql"))
                conn.connection.cursor().execute(path.read_text(encoding="utf-8"))

        @contextmanager
        def connection():
            with engine.begin() as conn:
                yield conn

        for module in (
            wars,
            activity,
            challenge,
            leaderboard,
            network,
            settings,
            rewards,
            scoring,
            referrals,
            maintenance,
            importlib.import_module("db.db_client"),
            importlib.import_module("hushh_mcp.services.one_referral_display_handle_service"),
        ):
            monkeypatch.setattr(module, "get_db_connection", connection)
        yield engine
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def _actor(db, uid, name=None):
    with db.begin() as conn:
        conn.execute(text("INSERT INTO actor_profiles(user_id) VALUES(:uid)"), {"uid": uid})
        conn.execute(
            text("INSERT INTO actor_identity_cache VALUES(:uid,:name,TRUE)"),
            {"uid": uid, "name": name or uid},
        )
        conn.execute(
            text("INSERT INTO vault_keys VALUES(:uid,TRUE,:at)"),
            {"uid": uid, "at": int(datetime.now(timezone.utc).timestamp() * 1000)},
        )


def _invite(db, parent, child, name=None):
    slug = referrals.get_or_create_referral_code(parent, referrals.get_active_policy())["slug"]
    attribution = referrals.resolve_slug_for_attribution(slug, user_agent="Mozilla/5.0")
    _actor(db, child, name)
    assert referrals.bind_attribution(attribution["attribution_id"], child)["status"] == "bound"
    return attribution["attribution_id"]


def _reply(db, uid, *, status="complete", model="verified-runtime"):
    conversation_id, message_id = uuid4(), uuid4()
    with db.begin() as conn:
        conn.execute(
            text("INSERT INTO agent_chat_conversations(id,user_id) VALUES(:id,:uid)"),
            {"id": conversation_id, "uid": uid},
        )
        for role, mid in (("user", uuid4()), ("assistant", message_id)):
            conn.execute(
                text("""
              INSERT INTO agent_chat_messages(id,conversation_id,user_id,role,status,
              content_ciphertext,content_iv,content_tag,model,completed_at)
              VALUES(:id,:cid,:uid,:role,:status,'encrypted','iv','tag',:model,clock_timestamp())
            """),
                {
                    "id": mid,
                    "cid": conversation_id,
                    "uid": uid,
                    "role": role,
                    "status": status,
                    "model": model,
                },
            )
    return str(message_id)


def _settle():
    return [scoring.process_one_job(job) for job in scoring.claim_due_scoring_jobs()]


@pytest.mark.asyncio
@pytest.mark.parametrize("sidecar", [None, "suggest_follow_ups", "react_to_message"])
async def test_current_adk_chat_reply_qualifies_atomically_without_plaintext(
    db, monkeypatch, sidecar
):
    import time
    from types import SimpleNamespace

    from google.adk.events import Event, EventActions
    from google.genai import types

    from hushh_mcp.one_adk.encrypted_session_service import EncryptedAdkSessionService
    from hushh_mcp.one_adk.queued_input import STOPPED_ANSWER, registry, run_scope, settle
    from tests.helpers.chat_keys import static_chat_cipher

    _actor(db, "alice")
    _invite(db, "alice", "bob")
    service = EncryptedAdkSessionService(static_chat_cipher(), referral_usage_app_name="hussh_one")

    async def execute(sql, params):
        with db.begin() as connection:
            return SimpleNamespace(
                data=[dict(row) for row in connection.execute(text(sql), params).mappings()]
            )

    monkeypatch.setattr(service, "_execute", execute)
    session = await service.create_session(
        app_name="hussh_one", user_id="bob", session_id="real-chat-path"
    )
    await service.append_event(
        session,
        Event(
            author="user",
            invocation_id="turn",
            timestamp=time.time(),
            content=types.Content(role="user", parts=[types.Part(text="synthetic private prompt")]),
        ),
    )
    failed = Event(
        author="one",
        invocation_id="turn",
        timestamp=time.time(),
        error_code="MODEL_FAILED",
        content=types.Content(role="model", parts=[types.Part(text="synthetic failed reply")]),
    )
    await service.append_event(session, failed)
    await service.append_event(
        session,
        Event(
            author="user",
            invocation_id="cancelled-turn",
            timestamp=time.time(),
            content=types.Content(
                role="user", parts=[types.Part(text="synthetic cancelled prompt")]
            ),
        ),
    )
    async with run_scope("bob", session.id, "cancelled-run", accepting=True) as run:
        try:
            registry.request_stop("bob", session.id)
            await service.append_event(
                session,
                Event(
                    author="one",
                    invocation_id="cancelled-turn",
                    timestamp=time.time(),
                    content=types.Content(role="model", parts=[types.Part(text=STOPPED_ANSWER)]),
                ),
            )
        finally:
            settle(run)
    await service.append_event(
        session,
        Event(
            author="one",
            invocation_id="turn",
            timestamp=time.time(),
            long_running_tool_ids={"review"},
            content=types.Content(
                role="model",
                parts=[
                    types.Part(text="synthetic review awaiting approval"),
                    types.Part(
                        function_call=types.FunctionCall(id="review", name="review", args={})
                    ),
                ],
            ),
        ),
    )
    for part in [
        types.Part(text="synthetic private reasoning", thought=True),
        types.Part(text=" \n\t"),
    ]:
        await service.append_event(
            session,
            Event(
                author="one",
                invocation_id="turn",
                timestamp=time.time(),
                content=types.Content(role="model", parts=[part]),
            ),
        )
    if sidecar:
        # A shown presentation tool alone cannot promote failed/thought-only
        # output to a successful reply, nor borrow an answer from another turn.
        await service.append_event(
            session,
            Event(
                author="one",
                invocation_id="other-turn",
                timestamp=time.time(),
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(text="synthetic answer from another turn"),
                        types.Part(function_call=types.FunctionCall(name=sidecar, args={})),
                    ],
                ),
            ),
        )

        def sidecar_result(*, error_code=None, name=sidecar):
            return Event(
                author="one",
                invocation_id="turn",
                timestamp=time.time(),
                error_code=error_code,
                actions=EventActions(skip_summarization=True),
                content=types.Content(
                    role="user",
                    parts=[
                        types.Part(
                            function_response=types.FunctionResponse(
                                name=name, response={"status": "shown"}
                            )
                        )
                    ],
                ),
            )

        await service.append_event(session, sidecar_result())
    with db.connect() as conn:
        assert (
            conn.execute(
                text("SELECT COUNT(*) FROM one_referral_events WHERE event_type='product_usage'")
            ).scalar()
            == 0
        )
    answer_parts = [types.Part(text="synthetic private reply")]
    if sidecar:
        answer_parts.append(types.Part(function_call=types.FunctionCall(name=sidecar, args={})))
    reply = Event(
        author="one",
        invocation_id="turn",
        timestamp=time.time(),
        content=types.Content(role="model", parts=answer_parts),
    )
    await service.append_event(session, reply)
    if sidecar:
        assert not reply.is_final_response()
        await service.append_event(session, sidecar_result(error_code="TOOL_FAILED"))
        await service.append_event(session, sidecar_result(name="ordinary_tool"))
        with db.connect() as conn:
            assert (
                conn.execute(
                    text(
                        "SELECT COUNT(*) FROM one_referral_events WHERE event_type='product_usage'"
                    )
                ).scalar()
                == 0
            )
        reply = sidecar_result()
        assert reply.is_final_response()
        await service.append_event(session, reply)
    await service.append_event(session, reply)  # persisted source replay stays once-only
    await service.append_event(
        session,
        Event(
            author="specialist",
            invocation_id="turn",
            timestamp=time.time(),
            content=types.Content(
                role="model", parts=[types.Part(text="another private reply in the same turn")]
            ),
        ),
    )
    assert referrals.get_referral_summary("alice")["qualified_count"] == 1
    assert len(_settle()) == 1
    assert activity.get_balances("alice") == {"points": 115, "coins": 115}
    assert activity.get_balances("bob") == {"points": 10, "coins": 10}
    with db.connect() as conn:
        rows = (
            conn.execute(
                text("SELECT metadata FROM one_referral_events WHERE event_type='product_usage'")
            )
            .scalars()
            .all()
        )
    assert len(rows) == 1
    assert rows[0]["source"] == "adk_chat"
    assert "synthetic private" not in str(rows)


def test_referral_journey_and_replay_awards(db):
    _actor(db, "alice")
    aid = _invite(db, "alice", "bob", "Bob Patel")
    summary = referrals.get_referral_summary("alice")
    assert summary["total_count"] == 1 and summary["in_progress_count"] == 1
    assert summary["referrals"][0]["display_name"] == "Bob Patel"
    assert referrals.bind_attribution(aid, "bob")["status"] == "already_used"
    activity.record_app_open("bob")
    referrals.sync_referral_qualification_from_onboarding("bob")
    assert referrals.get_referral_summary("alice")["qualified_count"] == 0
    # Neither arbitrary IDs nor a failed reply count as verified product use.
    activity.reconcile_product_activity("bob", str(uuid4()))
    activity.reconcile_product_activity("bob", _reply(db, "bob", status="error"))
    assert referrals.get_referral_summary("alice")["qualified_count"] == 0
    mid = _reply(db, "bob")
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: activity.reconcile_product_activity("bob", mid), range(4)))
    assert _settle()[0]["status"] == "completed"
    assert not _settle()
    assert referrals.get_referral_summary("alice")["qualified_count"] == 1
    history = activity.get_transaction_history("alice")
    assert sorted(row["points"] for row in history["entries"]) == [5, 10, 100]
    assert sum(row["coins"] for row in history["entries"]) == 115
    assert scoring.get_cumulative_score("alice") == 115
    assert scoring.get_cumulative_score("bob") == 10
    scoring.publish_leaderboard_snapshot()
    assert (
        leaderboard.get_individual_leaderboard(viewer_user_id="alice")["entries"][0]["points"]
        == 115
    )
    # Historical coin migration must not turn activity points into coins on replay.
    with db.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        try:
            conn.connection.cursor().execute(
                _replay_sql(
                    build_manifest_entries(
                        ROOT / "db/migrations", ("347_one_referral_dashboard_lifecycle.sql",)
                    )[0]
                )
            )
        except Exception:
            conn.connection.cursor().execute("ROLLBACK")
            raise
    assert sum(row["coins"] for row in activity.get_transaction_history("alice")["entries"]) == 115


def test_concurrent_bind_preserves_single_parent_and_tree(db):
    _actor(db, "alice")
    _invite(db, "alice", "bob")
    slug = referrals.get_or_create_referral_code("bob", referrals.get_active_policy())["slug"]
    aid = referrals.resolve_slug_for_attribution(slug, user_agent="Mozilla/5.0")["attribution_id"]
    _actor(db, "carol")
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: referrals.bind_attribution(aid, "carol"), range(4)))
    assert sum(r["status"] == "bound" for r in results) == 1
    assert (
        network.get_network_circle("alice")["circle_id"]
        == network.get_network_circle("carol")["circle_id"]
    )
    circle = network.get_network_circle("alice")
    assert circle["member_count"] == 3 and circle["score"] == 0
    activity.reconcile_product_activity("carol", _reply(db, "carol"))
    assert network.get_network_circle("alice")["score"] == 1
    assert network.get_network_circle("alice")["qualified_member_count"] == 1


def test_daily_streak_concurrency_timezone_reset_and_bonus(db, monkeypatch):
    _actor(db, "alice")

    class Clock(datetime):
        value = datetime(2026, 10, 14, 18, 29, tzinfo=timezone.utc)

        @classmethod
        def now(cls, tz=None):
            return cls.value

    monkeypatch.setattr(activity, "datetime", Clock)
    with ThreadPoolExecutor(max_workers=4) as pool:
        result = list(pool.map(lambda _: activity.record_app_open("alice"), range(4)))
    assert sum(r["recorded"] for r in result) == 1
    assert result[0]["activity_date"] == "2026-10-14"
    Clock.value = datetime(2026, 10, 14, 18, 30, tzinfo=timezone.utc)
    assert activity.record_app_open("alice")["current_run_days"] == 2
    Clock.value += timedelta(days=1)
    assert activity.record_app_open("alice")["current_run_days"] == 3
    assert activity.get_transaction_history("alice")["entries"][0]["coins"] == 15
    activity.record_app_open("alice")
    assert len(activity.get_transaction_history("alice")["entries"]) == 1
    Clock.value += timedelta(days=2)
    assert activity.get_daily_streak("alice", "Asia/Kolkata")["current_run_days"] == 0
    assert activity.record_app_open("alice")["current_run_days"] == 1
    assert activity.get_daily_streak("alice", "Asia/Kolkata")["longest_run_days"] == 3


def test_rewards_claims_and_next_milestone_are_persisted(db):
    _actor(db, "alice")
    for index in range(10):
        uid = f"friend{index}"
        _invite(db, "alice", uid)
        activity.reconcile_product_activity(uid, _reply(db, uid))
    _settle()
    progress = leaderboard.get_milestone_progress(
        "alice", settings_milestones=settings.get_active_program_settings().milestones
    )
    assert progress["earned"][0]["milestone_key"] == "voucher_10"
    assert progress["next_milestone"]["threshold"] == 100
    assert progress["earned"][0]["fulfillment_status"] == "pending_review"
    _actor(db, "intruder")
    with pytest.raises(rewards.RewardClaimError):
        rewards.claim_milestone("intruder", "voucher_10")

    def claim(_):
        try:
            return rewards.claim_milestone("alice", "voucher_10")["status"]
        except rewards.RewardClaimError:
            return "rejected"

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(claim, range(4))).count("claimed") == 1
    with pytest.raises(rewards.RewardClaimError):
        rewards.claim_milestone("alice", "earbuds_100")


def test_challenge_is_persisted_and_expired_entries_are_refused(db):
    first = challenge.get_challenge_status()
    second = challenge.get_challenge_status()
    assert first["round_id"] == second["round_id"] and first["cutoff_at"] == second["cutoff_at"]
    with db.begin() as conn:
        challenge.require_open_round(conn, first["round_id"])
        conn.execute(
            text("UPDATE one_referral_reward_rounds SET cutoff_at=NOW()-INTERVAL '1 second'")
        )
    with db.begin() as conn, pytest.raises(ValueError):
        challenge.require_open_round(conn, first["round_id"])
    challenge.get_challenge_status()
    with db.connect() as conn:
        assert (
            conn.execute(
                text("SELECT status FROM one_referral_reward_rounds WHERE id=CAST(:id AS UUID)"),
                {"id": first["round_id"]},
            ).scalar()
            == "ended"
        )


def test_product_rewards_follow_trusted_writes(db):
    _actor(db, "alice")
    _actor(db, "bob")
    with db.begin() as conn:
        # Current atomic Memory saves emit confirmed content_write events;
        # projections, upgrades and unconfirmed writes must not earn points.
        for operation, provenance in (
            (
                "decision_projection",
                '{"mutation_plan_id":"plan","confirmation_receipt_id":"receipt"}',
            ),
            ("content_write", '{"upgrade_claim":{"claim_id":"upgrade"}}'),
            ("content_write", '{"mutation_plan_id":"plan","confirmation_receipt_id":" "}'),
            ("content_write", "{}"),
        ):
            conn.execute(
                text("""
              INSERT INTO pkm_events(user_id,domain,operation_type,metadata)
              VALUES('alice','financial',:operation,jsonb_build_object('provenance',CAST(:provenance AS JSONB)))
            """),
                {"operation": operation, "provenance": provenance},
            )
        assert (
            conn.execute(
                text(
                    "SELECT COALESCE(SUM(points),0) FROM one_referral_score_events WHERE user_id='alice'"
                )
            ).scalar_one()
            == 0
        )
        for domain in ("financial", "personal"):
            conn.execute(
                text("""
              INSERT INTO pkm_events(user_id,domain,operation_type,metadata)
              VALUES('alice',:domain,'content_write',
                '{"provenance":{"mutation_plan_id":"plan","confirmation_receipt_id":"receipt"}}')
            """),
                {"domain": domain},
            )
    assert scoring.get_cumulative_score("alice") == 15
    with db.begin() as conn:
        # Legacy compatibility shares the same once-per-owner/day key.
        conn.execute(text("INSERT INTO pkm_data VALUES('alice','ciphertext')"))
        conn.execute(text("UPDATE pkm_data SET encrypted_data_ciphertext='new_ciphertext'"))
        conn.execute(text("INSERT INTO connections(user_a_id,user_b_id) VALUES('alice','bob')"))
        conn.execute(text("UPDATE connections SET status='revoked'"))
        conn.execute(text("UPDATE connections SET status='active'"))
    assert scoring.get_cumulative_score("alice") == 20
    assert scoring.get_cumulative_score("bob") == 5
    assert all(
        row["coins"] == row["points"]
        for row in activity.get_transaction_history("alice")["entries"]
    )


def test_reviewed_policy_history_replays_after_lifecycle_activation(db):
    """A repeated release preserves v4, historical policies and earned awards."""
    _actor(db, "alice")
    with db.begin() as conn:
        activity.record_score(
            conn,
            user_id="alice",
            event_type="agent_usage",
            points=10,
            coins=0,
            version=4,
            key="earned-before-replay",
        )
    entries = build_manifest_entries(
        ROOT / "db/migrations",
        (
            "289_one_referral_program_settings_v2.sql",
            "338_one_referral_usd_catalogue.sql",
            "347_one_referral_dashboard_lifecycle.sql",
            "348_one_referral_confirmed_memory_reward.sql",
            "349_one_referral_dashboard_truth.sql",
        ),
    )
    with db.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        before = conn.exec_driver_sql(
            "SELECT * FROM one_referral_program_settings ORDER BY version"
        ).all()
        for _ in range(2):
            for entry in entries:
                conn.connection.cursor().execute(_replay_sql(entry))
        assert (
            conn.exec_driver_sql(
                "SELECT * FROM one_referral_program_settings ORDER BY version"
            ).all()
            == before
        )
    assert scoring.get_cumulative_score("alice") == 10


@pytest.mark.parametrize(
    "migration", ("289_one_referral_program_settings_v2.sql", "338_one_referral_usd_catalogue.sql")
)
@pytest.mark.parametrize(
    "drift",
    (
        "UPDATE one_referral_program_settings SET points='{}' WHERE version=4",
        "UPDATE one_referral_program_settings SET activated_at=activated_at+INTERVAL '1 second' WHERE version=5",
        "UPDATE one_referral_program_settings SET version=6 WHERE version=5",
    ),
)
def test_policy_replay_rejects_unreviewed_successor(db, migration, drift):
    entry = build_manifest_entries(ROOT / "db/migrations", (migration,))[0]
    with db.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.exec_driver_sql(drift)
        with pytest.raises(Exception, match="reviewed|lineage|does not match"):
            conn.connection.cursor().execute(_replay_sql(entry))
        conn.exec_driver_sql("ROLLBACK")


def test_job_backoff_stale_lease_and_terminal_retry(db):
    _actor(db, "alice")
    _invite(db, "alice", "bob")
    activity.reconcile_product_activity("bob", _reply(db, "bob"))
    job = scoring.claim_due_scoring_jobs()[0]
    with db.begin() as conn:
        conn.execute(
            text(
                "UPDATE one_referral_scoring_jobs SET lease_id=gen_random_uuid(),lease_expires_at=NOW()+INTERVAL '1 minute'"
            )
        )
    assert scoring.process_one_job(job)["reason"] == "stale_lease"
    scoring._record_job_failure(job["job_id"], 0, lease_id=job["lease_id"])
    with db.begin() as conn:
        conn.execute(
            text(
                "UPDATE one_referral_scoring_jobs SET status='queued',next_at=NOW()+INTERVAL '1 day'"
            )
        )
    assert scoring.claim_due_scoring_jobs() == []
    with db.begin() as conn:
        conn.execute(text("UPDATE one_referral_scoring_jobs SET next_at=NOW(),retry_count=4"))
    job = scoring.claim_due_scoring_jobs()[0]
    scoring._record_job_failure(job["job_id"], 4, lease_id=job["lease_id"])
    with db.connect() as conn:
        row = conn.execute(text("SELECT status,retry_count FROM one_referral_scoring_jobs")).one()
        assert row.status == "failed" and row.retry_count == 5


def test_network_cycle_and_cross_owner_product_events_are_rejected(db):
    _actor(db, "alice")
    _invite(db, "alice", "bob")
    _invite(db, "bob", "carol")
    mid = _reply(db, "carol")
    activity.reconcile_product_activity("bob", mid)
    assert referrals.get_referral_summary("alice")["qualified_count"] == 0
    slug = referrals.get_or_create_referral_code("carol", referrals.get_active_policy())["slug"]
    aid = referrals.resolve_slug_for_attribution(slug, user_agent="Mozilla/5.0")["attribution_id"]
    with pytest.raises(Exception, match="referral cycle"), db.begin() as conn:
        conn.execute(
            text("""
          INSERT INTO one_referral_relationships(attribution_id,referrer_user_id,referred_user_id,policy_version,status)
          VALUES(CAST(:aid AS UUID),'carol','alice',2,'signed_up')
        """),
            {"aid": aid},
        )
    assert network.get_network_circle("alice")["member_count"] == 3


def test_leaderboard_pagination_uses_lifetime_earned_coins(db):
    _actor(db, "point_only")
    now = datetime.now(timezone.utc)
    with db.begin() as conn:
        activity.record_score(
            conn,
            user_id="point_only",
            event_type="agent_usage",
            points=1000000,
            coins=0,
            version=3,
            key="point-only",
        )
        for index in range(502):
            uid = f"scored{index:04d}"
            conn.execute(text("INSERT INTO actor_profiles(user_id) VALUES(:uid)"), {"uid": uid})
            activity.record_score(
                conn,
                user_id=uid,
                event_type="app_streak_bonus",
                points=15,
                coins=15,
                version=3,
                key=uid,
                occurred_at=now,
            )
    assert scoring.publish_leaderboard_snapshot().entry_count == 503
    page = leaderboard.get_individual_leaderboard(limit=2, viewer_user_id="scored0501")
    assert [entry["rank"] for entry in page["entries"]] == [1, 2]
    assert page["viewer"]["rank"] == 503
    continuation = leaderboard.get_individual_leaderboard(
        limit=2, after_rank=2, snapshot_id=page["snapshot_id"]
    )
    assert [entry["rank"] for entry in continuation["entries"]] == [3, 4]


def test_concurrent_round_creation_and_late_flash_boundary(db):
    cutoff = datetime.now(timezone.utc) + timedelta(days=7)
    with ThreadPoolExecutor(max_workers=4) as pool:
        rounds = list(
            pool.map(
                lambda _: settings.get_or_create_reward_round(cutoff, "Asia/Kolkata"), range(4)
            )
        )
    assert len({item["id"] for item in rounds}) == 1
    from hushh_mcp.operons.referral_scoring.points import points_for_qualification

    start = datetime.now(timezone.utc)
    end = start + timedelta(seconds=1)
    windows = [{"start": start.isoformat(), "end": end.isoformat()}]
    assert (
        points_for_qualification(
            end, {"qualified_referral_points": 100, "flash_window_total_points": 200}, windows
        ).points
        == 100
    )


def test_delayed_parent_bind_merges_an_existing_subtree(db):
    _actor(db, "alice")
    slug = referrals.get_or_create_referral_code("alice", referrals.get_active_policy())["slug"]
    aid = referrals.resolve_slug_for_attribution(slug, user_agent="Mozilla/5.0")["attribution_id"]
    _actor(db, "bob")
    _invite(db, "bob", "carol")
    assert referrals.bind_attribution(aid, "bob")["status"] == "bound"
    assert (
        network.get_network_circle("alice")["circle_id"]
        == network.get_network_circle("carol")["circle_id"]
    )
    assert network.get_network_circle("alice")["member_count"] == 3


def test_account_deletion_rebuilds_surviving_parent_chains(db):
    _actor(db, "alice")
    _invite(db, "alice", "bob")
    _invite(db, "bob", "carol")
    _invite(db, "carol", "dave")
    with db.begin() as conn:
        conn.execute(text("DELETE FROM actor_profiles WHERE user_id='bob'"))
    assert (
        network.get_network_circle("carol")["circle_id"]
        == network.get_network_circle("dave")["circle_id"]
    )
    assert (
        network.get_network_circle("carol")["circle_id"]
        != network.get_network_circle("alice")["circle_id"]
    )


def test_unready_users_cannot_starve_usage_reconciliation(db):
    _actor(db, "alice")
    for index in range(21):
        uid = f"person{index:02d}"
        _invite(db, "alice", uid)
        if index < 20:
            with db.begin() as conn:
                conn.execute(
                    text("UPDATE vault_keys SET setup_completed=FALSE WHERE user_id=:uid"),
                    {"uid": uid},
                )
        _reply(db, uid, model=None)  # Trusted specialist completion can omit a model field.
    assert maintenance.reconcile_pending_activity() == 20
    assert maintenance.reconcile_pending_activity() == 1
    assert referrals.get_referral_summary("alice")["qualified_count"] == 1


def test_conflicting_migration_replay_is_rejected_without_rewriting_history(db):
    with db.begin() as conn:
        conn.execute(
            text(
                "UPDATE one_referral_program_settings SET points=points || jsonb_build_object('referral_in_progress_points',999) WHERE version=4"
            )
        )
    with (
        pytest.raises(Exception, match="conflicting or inactive program settings"),
        db.connect().execution_options(isolation_level="AUTOCOMMIT") as conn,
    ):
        try:
            conn.connection.cursor().execute(
                (ROOT / "db/migrations/347_one_referral_dashboard_lifecycle.sql").read_text(
                    encoding="utf-8"
                )
            )
        except Exception:
            conn.connection.cursor().execute("ROLLBACK")
            raise


def test_authenticated_api_uses_real_owner_storage_and_forbids_circle_changes(db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from tests.test_one_referral_dashboard_routes import routes

    _actor(db, "alice")
    _invite(db, "alice", "bob")
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)
    assert client.get("/api/one/referrals/points").status_code == 401
    app.dependency_overrides[routes.require_firebase_auth] = lambda: "alice"
    assert client.get("/api/one/referrals/points?user_id=bob").json() == {"points": 5, "coins": 5}
    assert client.post("/api/one/referrals/points", json={"points": 99999}).status_code == 405
    assert (
        client.post(
            "/api/one/referrals/rewards/claim",
            json={"milestone_key": "voucher_10", "user_id": "bob"},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/one/referrals/rewards/claim", json={"milestone_key": "voucher_10"}
        ).status_code
        == 409
    )
    assert (
        client.post("/api/one/referrals/circle", json={"circle_id": str(uuid4())}).status_code
        == 409
    )
    assert activity.get_balances("alice") == {"points": 5, "coins": 5}
    assert client.post("/api/one/referrals/app-open").json()["recorded"] is False
    assert activity.get_daily_streak("alice", "Asia/Kolkata")["current_run_days"] == 0
    assert (
        client.post("/api/one/referrals/app-open", json={"surface": "referral_dashboard"}).json()[
            "current_run_days"
        ]
        == 1
    )
    assert (
        client.post(
            "/api/one/referrals/app-open", json={"surface": "referral_dashboard", "coins": 999}
        ).status_code
        == 422
    )


def test_qualification_window_expires_without_fake_usage(db):
    _actor(db, "alice")
    _invite(db, "alice", "bob")
    with db.begin() as conn:
        conn.execute(
            text("UPDATE one_referral_relationships SET created_at=NOW()-INTERVAL '8 days'")
        )
    maintenance.reconcile_pending_activity()
    summary = referrals.get_referral_summary("alice")
    assert summary["in_progress_count"] == 0 and summary["referrals"][0]["status"] == "Expired"


def test_rollback_preserves_awards_and_claim_history(db):
    _actor(db, "alice")
    _invite(db, "alice", "bob")
    earned = activity.get_balances("alice")
    with db.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.connection.cursor().execute(
            (
                ROOT / "db/migrations/rollback/349_one_referral_dashboard_truth.rollback.sql"
            ).read_text(encoding="utf-8")
        )
        entry = build_manifest_entries(
            ROOT / "db/migrations", ("349_one_referral_dashboard_truth.sql",)
        )[0]
        conn.connection.cursor().execute(_replay_sql(entry))
    assert activity.get_balances("alice") == earned
    assert settings.get_active_program_settings().version == 5


def test_legacy_score_is_coins_and_live_rank_without_scheduler(db):
    _actor(db, "legacy_owner")
    with db.begin() as conn:
        activity.record_score(
            conn,
            user_id="legacy_owner",
            event_type="agent_usage",
            points=50,
            coins=0,
            version=4,
            key="historical-score",
        )
    assert activity.get_balances("legacy_owner") == {"points": 50, "coins": 50}
    board = leaderboard.get_individual_leaderboard(viewer_user_id="legacy_owner")
    assert [(r["rank"], r["points"], r["is_viewer"]) for r in board["entries"]] == [(1, 50, True)]
    assert activity.get_transaction_history("legacy_owner")["entries"][0]["coins"] == 50


def test_joined_progress_excludes_open_links_and_survives_qualification(db):
    _actor(db, "alice")
    code = referrals.get_or_create_referral_code("alice", referrals.get_active_policy())
    referrals.resolve_slug_for_attribution(code["slug"], user_agent="Mozilla/5.0")
    assert referrals.get_referral_summary("alice")["joined_count"] == 0
    _invite(db, "alice", "bob")
    _invite(db, "alice", "carol")
    summary = referrals.get_referral_summary("alice")
    assert summary["joined_count"] == summary["total_count"] == 2
    assert summary["qualified_count"] == 0
    assert [r["status"] for r in summary["referrals"]] == ["In progress", "In progress"]
    progress = leaderboard.get_milestone_progress(
        "alice", settings_milestones=settings.get_active_program_settings().milestones
    )
    assert progress["next_milestone"]["progress"] == 2
    assert progress["next_milestone"]["threshold"] == 10
    assert progress["earned"] == []
    activity.reconcile_product_activity("bob", _reply(db, "bob"))
    _settle()
    before = activity.get_balances("alice")
    activity.reconcile_product_activity("bob")
    _settle()
    assert activity.get_balances("alice") == before
    assert referrals.get_referral_summary("alice")["joined_count"] == 2
    assert referrals.get_referral_summary("alice")["qualified_count"] == 1


def test_zero_coin_registered_participant_is_ranked_and_invitation_is_not(db):
    _actor(db, "alice")
    with db.begin() as conn:
        conn.execute(
            text(
                "UPDATE one_referral_program_settings SET points=points || jsonb_build_object('referral_in_progress_points',0) WHERE version=5"
            )
        )
    # Publish an empty board before a zero-award signup; membership must invalidate it.
    assert leaderboard.get_individual_leaderboard()["entries"] == []
    _invite(db, "alice", "bob")
    board = leaderboard.get_individual_leaderboard(viewer_user_id="alice")
    assert [(r["rank"], r["points"], r["is_viewer"]) for r in board["entries"]] == [(1, 0, True)]


def test_dashboard_attendance_does_not_fabricate_app_history_and_crosses_monday(db, monkeypatch):
    _actor(db, "alice")

    class Clock(datetime):
        value = datetime(2026, 10, 11, 18, 29, 59, tzinfo=timezone.utc)

        @classmethod
        def now(cls, tz=None):
            return cls.value

    monkeypatch.setattr(activity, "datetime", Clock)
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO one_referral_streak_state(user_id,current_streak,longest_streak,last_activity_date) VALUES('alice',9,9,'2026-10-11')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO one_referral_activity_days(user_id,activity_date,timezone) VALUES('alice','2026-10-11','Asia/Kolkata')"
            )
        )
    assert activity.get_daily_streak("alice", "UTC")["current_run_days"] == 0
    assert activity.record_app_open("alice")["current_run_days"] == 1
    before = activity.get_balances("alice")
    Clock.value += timedelta(seconds=1)
    assert activity.record_app_open("alice")["current_run_days"] == 2
    assert activity.get_balances("alice") == before
    with db.connect() as conn:
        assert (
            conn.execute(
                text("SELECT current_streak FROM one_referral_streak_state WHERE user_id='alice'")
            ).scalar()
            == 9
        )


def test_forward_catalogue_preserves_old_entitlement_and_preview_has_no_team_authority(db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from tests.test_one_referral_dashboard_routes import routes

    _actor(db, "alice")
    _invite(db, "alice", "bob")
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO one_referral_milestone_entitlements(user_id,milestone_key,threshold,reward,settings_version) VALUES('alice','airpods_500',500,'Apple Watch',4)"
            )
        )
    cfg = settings.get_active_program_settings()
    assert cfg.version == 5 and not cfg.feature_active
    assert next(r for r in cfg.milestones if r["threshold"] == 500)["reward"] == "Apple AirPods"
    assert (
        leaderboard.get_milestone_progress("alice", settings_milestones=cfg.milestones)["earned"][
            0
        ]["reward"]
        == "Apple Watch"
    )
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes.require_firebase_auth] = lambda: "alice"
    client = TestClient(app)
    before = network.get_network_circle("alice")
    assert client.get("/api/one/referrals/circle").json() == {
        "circle_id": None,
        "status": "preview",
        "competition_active": False,
    }
    assert client.get("/api/one/referrals/circles/leaderboard").json()["teams"] == []
    assert (
        client.post(
            "/api/one/referrals/circle", json={"circle_id": before["circle_id"]}
        ).status_code
        == 409
    )
    assert network.get_network_circle("alice") == before


def test_deleted_participants_and_zero_score_cohort_refresh_rank_immediately(db):
    for uid, score in (("leader", 100), ("viewer", 50)):
        _actor(db, uid)
        with db.begin() as conn:
            activity.record_score(
                conn,
                user_id=uid,
                event_type="agent_usage",
                points=score,
                coins=0,
                version=5,
                key=uid,
            )
    before = leaderboard.get_individual_leaderboard(viewer_user_id="viewer")
    assert next(r for r in before["entries"] if r["is_viewer"])["rank"] == 2
    # Deleting the non-max event owner must still close the rank gap immediately.
    with db.begin() as conn:
        conn.execute(text("DELETE FROM actor_profiles WHERE user_id='leader'"))
    after = leaderboard.get_individual_leaderboard(viewer_user_id="viewer")
    assert next(r for r in after["entries"] if r["is_viewer"])["rank"] == 1
    assert after["snapshot_id"] != before["snapshot_id"]


def _circle(db, owner="alice", name="Private friends"):
    cid = str(uuid4())
    with db.begin() as conn:
        conn.execute(
            text("INSERT INTO one_location_circles(id,name,owner_user_id) VALUES(:cid,:name,:uid)"),
            {"cid": cid, "name": name, "uid": owner},
        )
        conn.execute(
            text(
                "INSERT INTO one_location_circle_memberships(circle_id,user_id) VALUES(:cid,:uid)"
            ),
            {"cid": cid, "uid": owner},
        )
    return cid


def test_circle_wars_qualification_snapshot_preserves_individual_coins_and_private_names(db):
    _actor(db, "alice")
    _actor(db, "outsider")
    cid = _circle(db)
    state = wars.opt_in("alice", cid)
    assert state["period"]["timezone"] == "Asia/Kolkata"
    assert state["participation"]["team"]["participating_members"] == 1
    _invite(db, "alice", "bob")
    activity.reconcile_product_activity("bob", _reply(db, "bob"))
    # Leaving before the delayed worker runs must not erase event-time eligibility.
    with db.begin() as conn:
        conn.execute(
            text("UPDATE one_location_circle_memberships SET status='left' WHERE user_id='alice'")
        )
    assert _settle()[0]["status"] == "completed"
    assert not _settle()
    board = wars.get_leaderboard("outsider")
    team = board["teams"][0]
    assert team["qualified_referrals"] == 1 and team["circle_id"] is None
    assert team["anonymous"] and "Private friends" not in str(board)
    assert activity.get_balances("alice") == {"points": 115, "coins": 115}
    assert wars.get_state("alice")["participation"]["team"]["anonymous"]
    with db.begin() as conn:
        conn.execute(
            text(
                "UPDATE one_referral_relationships SET status='revoked',revoked_at=clock_timestamp() WHERE referred_user_id='bob'"
            )
        )
    assert wars.get_leaderboard("outsider")["teams"][0]["qualified_referrals"] == 0


@pytest.mark.parametrize("before_join", [True, False])
def test_circle_wars_never_awards_pre_opt_in_or_nonmember_referrals(db, before_join):
    _actor(db, "alice")
    cid = _circle(db)
    if before_join:
        _invite(db, "alice", "bob")
    wars.opt_in("alice", cid)
    if not before_join:
        _invite(db, "alice", "bob")
        with db.begin() as conn:
            conn.execute(
                text(
                    "UPDATE one_location_circle_memberships SET status='left' WHERE user_id='alice'"
                )
            )
    activity.reconcile_product_activity("bob", _reply(db, "bob"))
    assert _settle()[0]["status"] == "completed"
    assert wars.get_leaderboard("alice")["teams"][0]["qualified_referrals"] == 0
    assert activity.get_balances("alice")["coins"] == 115


def test_circle_wars_concurrent_selection_is_one_per_week_and_no_automatic_members(db):
    _actor(db, "alice")
    _actor(db, "other")
    cid = _circle(db)
    other = _circle(db, name="Another private Circle")
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO one_location_circle_memberships(circle_id,user_id) VALUES(:cid,'other')"
            ),
            {"cid": cid},
        )

    def join(chosen):
        try:
            return wars.opt_in("alice", chosen)["participation"]["team"]["circle_id"]
        except wars.CircleWarsError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(join, [cid, other]))
    assert results.count("CIRCLE_ALREADY_SELECTED_THIS_WEEK") == 1
    selected = wars.get_state("alice")["participation"]
    assert selected["team"]["participating_members"] == 1
    assert wars.get_state("other")["participation"] is None
    assert wars.opt_in("alice", selected["team"]["circle_id"])["participation"] == selected
    with pytest.raises(wars.CircleWarsError):
        wars.opt_in("other", other)


def test_circle_wars_weekly_history_does_not_reset_coins_or_copy_opt_ins(db, monkeypatch):
    _actor(db, "alice")
    cid = _circle(db)
    old = wars.opt_in("alice", cid)
    _invite(db, "alice", "bob")
    activity.reconcile_product_activity("bob", _reply(db, "bob"))
    assert _settle()[0]["status"] == "completed"
    # A separately persisted round proves ownership comes from round ID, never
    # a recomputed date or today's roster. Earlier fixture round is historical.
    with db.begin() as conn:
        rid = conn.execute(
            text("""INSERT INTO one_referral_reward_rounds(settings_version,started_at,cutoff_at,timezone)
          SELECT settings_version,clock_timestamp()-INTERVAL '1 hour',cutoff_at+INTERVAL '7 days',timezone
          FROM one_referral_reward_rounds WHERE id=CAST(:rid AS UUID) RETURNING id"""),
            {"rid": old["period"]["round_id"]},
        ).scalar_one()
    monkeypatch.setattr(
        wars, "get_challenge_status", lambda: {"calendar_active": True, "round_id": str(rid)}
    )
    assert wars.get_state("alice")["participation"] is None
    assert wars.get_leaderboard("alice")["teams"] == []
    assert (
        wars.get_state("alice", old["period"]["round_id"])["participation"]["team"][
            "qualified_referrals"
        ]
        == 1
    )
    assert activity.get_balances("alice")["coins"] == 115


def test_circle_wars_api_requires_owner_and_explicit_consent_and_bounds_pages(db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from tests.test_one_referral_dashboard_routes import routes

    _actor(db, "alice")
    cid = _circle(db)
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app)
    assert client.get("/api/one/referrals/circle-wars").status_code in (401, 403)
    app.dependency_overrides[routes.require_vault_owner_token] = lambda: {"user_id": "alice"}
    path = "/api/one/referrals/circle-wars/participation"
    for payload in (
        {"circle_id": cid},
        {"circle_id": cid, "consent": "true"},
        {"circle_id": cid, "consent": False},
        {"circle_id": cid, "consent": True, "user_id": "other"},
    ):
        assert client.post(path, json=payload).status_code == 422
    result = client.post(path, json={"circle_id": cid, "consent": True})
    assert result.status_code == 200 and result.headers["cache-control"] == "private, no-store"
    assert client.get("/api/one/referrals/circle-wars/leaderboard?offset=-1").status_code == 422
    page = client.get("/api/one/referrals/circle-wars/leaderboard?offset=25").json()
    assert page["teams"] == [] and page["total_teams"] == 1 and not page["has_more"]


def test_circle_wars_immutable_history_and_migration_replay(db):
    _actor(db, "alice")
    cid = _circle(db)
    wars.opt_in("alice", cid)
    from sqlalchemy.exc import IntegrityError

    with pytest.raises(IntegrityError), db.begin() as conn:
        conn.execute(
            text(
                "UPDATE one_referral_circle_selections SET selected_at=selected_at-INTERVAL '1 day'"
            )
        )
    with db.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.connection.cursor().execute(
            (ROOT / "db/migrations/358_circle_wars_weekly_opt_in.sql").read_text()
        )
    assert wars.get_state("alice")["participation"]["team"]["participating_members"] == 1
