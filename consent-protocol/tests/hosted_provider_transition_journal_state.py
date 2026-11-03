"""Focused helpers for the retained hosted provider-account transition journal test."""

import asyncio
import json
from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest


def _assert_retained_admission_shape(ctx):
    assert not ctx.pg.execute(
        "SELECT valid_hosted_provider_account_transition_intent(%s::jsonb,%s::jsonb)",
        (
            json.dumps(
                ctx.pg.execute(
                    "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
                )[0][0]
            ),
            json.dumps(ctx.legacy_candidate),
        ),
    )[0][0]
    assert not asyncio.run(
        ctx.journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id=ctx.item_a["attemptId"], intent=ctx.legacy_candidate
        )
    )
    ctx.retained_row = ctx.pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
    )[0][0]
    assert (
        ctx.pg.execute(
            "SELECT hosted_provider_effective_billing_account(%s::jsonb)",
            (json.dumps(ctx.retained_row),),
        )[0][0]
        == "billingAccounts/014D7F-FD970D-D2459E"
    )
    assert ctx.pg.execute(
        "SELECT hosted_pod_retained_admitted('owner-a',%s::jsonb)", (json.dumps(ctx.retained_row),)
    )[0][0]
    ctx.mismatched_admission = deepcopy(ctx.retained_row)
    ctx.mismatched_admission["backend_metadata"]["provisionAttempt"]["hostedAdmission"][
        "environment"
    ] = "prod"
    assert not ctx.pg.execute(
        "SELECT hosted_pod_retained_admitted('owner-a',%s::jsonb)",
        (json.dumps(ctx.mismatched_admission),),
    )[0][0]
    assert not ctx.pg.execute(
        "SELECT valid_hosted_provider_account_transition_intent(%s::jsonb,%s::jsonb)",
        (json.dumps(ctx.mismatched_admission), json.dumps(ctx.intent)),
    )[0][0]
    ctx.invalid_retained_rows = []
    ctx.wrong_checkpoint_owner = deepcopy(ctx.retained_row)
    ctx.wrong_checkpoint_owner["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
        "hostedPreparation"
    ]["ownerId"] = "foreign-owner"
    ctx.invalid_retained_rows.append(ctx.wrong_checkpoint_owner)
    ctx.wrong_checkpoint_generation = deepcopy(ctx.retained_row)
    ctx.wrong_checkpoint_generation["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
        "hostedPreparation"
    ]["generation"] = 8
    ctx.invalid_retained_rows.append(ctx.wrong_checkpoint_generation)
    ctx.wrong_checkpoint_digest = deepcopy(ctx.retained_row)
    ctx.wrong_checkpoint_digest["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
        "hostedPreparation"
    ]["planDigest"] = "f" * 64
    ctx.invalid_retained_rows.append(ctx.wrong_checkpoint_digest)
    ctx.wrong_final_step = deepcopy(ctx.retained_row)
    ctx.wrong_final_step["backend_metadata"]["provisionAttempt"]["evidence"]["reserved"][
        "hostedPreparation"
    ]["completed"][4]["step"] = "authorize_project"
    ctx.invalid_retained_rows.append(ctx.wrong_final_step)
    assert [
        ctx.pg.execute(
            "SELECT valid_hosted_preparation_result(%s::jsonb,%s::jsonb)",
            (
                json.dumps(ctx.retained_row["backend_metadata"]["provisionAttempt"]),
                json.dumps(ctx.receipt),
            ),
        )[0][0]
        for ctx.receipt in ctx.retained_row["backend_metadata"]["provisionAttempt"]["evidence"][
            "reserved"
        ]["hostedPreparation"]["completed"]
    ] == [True] * 5
    for invalid_row in ctx.invalid_retained_rows:
        assert not ctx.pg.execute(
            "SELECT valid_hosted_provider_account_transition_intent(%s::jsonb,%s::jsonb)",
            (json.dumps(invalid_row), json.dumps(ctx.intent)),
        )[0][0]


def _assert_duplicate_foreign_and_stale_refusals(ctx):
    ctx.wrong_operation = ctx.make_intent(ctx.project_data[0])
    ctx.wrong_operation["operationId"] = "00000000-0000-4000-8000-000000000000"
    assert not asyncio.run(
        ctx.journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id=ctx.item_a["attemptId"], intent=ctx.wrong_operation
        )
    )
    ctx.history_before = ctx.pg.execute(
        "SELECT (backend_metadata->'provisionAttempt'->'hostedAdmission'->'assignment'->'preparationContract')::text,(backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedPreparation'->'completed'->1)::text FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0]
    assert not asyncio.run(
        ctx.journal.record_provider_account_transition_intent(
            owner_id="owner-a",
            attempt_id=ctx.item_a["attemptId"],
            intent={**ctx.intent, "projectNumber": "999999999999"},
        )
    )
    assert not asyncio.run(
        ctx.journal.record_provider_account_transition_intent(
            owner_id="owner-b", attempt_id=ctx.item_b["attemptId"], intent=ctx.intent
        )
    )
    assert not asyncio.run(
        ctx.journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id="f" * 32, intent=ctx.intent
        )
    )
    ctx.stale = ctx.make_intent(ctx.item_a, delta=11)
    assert not asyncio.run(
        ctx.journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id=ctx.item_a["attemptId"], intent=ctx.stale
        )
    )
    assert asyncio.run(
        ctx.journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id=ctx.item_a["attemptId"], intent=ctx.intent
        )
    )
    assert not asyncio.run(
        ctx.journal.record_provider_account_transition_intent(
            owner_id="owner-a", attempt_id=ctx.item_a["attemptId"], intent=ctx.intent
        )
    )


def _persist_unknown_transition(ctx):
    ctx.transition = ctx.pg.execute(
        "SELECT backend_metadata->'provisionAttempt'->'providerAccountTransition' FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    assert ctx.transition["phase"] == "intent" and ctx.transition["generation"] == 1
    ctx.intent_row = ctx.pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
    )[0][0]
    assert (
        ctx.pg.execute(
            "SELECT hosted_provider_effective_billing_account(%s::jsonb)",
            (json.dumps(ctx.intent_row),),
        )[0][0]
        is None
    )
    with pytest.raises(
        ctx.psycopg2.errors.InsufficientPrivilege, match="provider account transition"
    ):
        ctx.pg.execute("SELECT reserve_personal_agent_erasure('owner-a','unresolved-erasure')")
    ctx.unknown = {
        "version": 1,
        "outcome": "unknown",
        "observedAt": datetime.now(timezone.utc).isoformat(),
    }
    ctx.aged_intent = deepcopy(ctx.intent)
    ctx.aged_at = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
    ctx.aged_intent["intentAt"] = ctx.aged_at
    ctx.aged_intent["actorVerification"]["verifiedAt"] = ctx.aged_at
    ctx.aged_intent["minimumSourceRevision"] = "d" * 40
    ctx.aged_state = {
        "version": 1,
        "generation": 2,
        "phase": "unknown",
        "intent": ctx.aged_intent,
        "settlements": [ctx.unknown],
    }
    assert ctx.pg.execute(
        "SELECT valid_hosted_provider_account_transition_intent(to_jsonb(r),%s::jsonb),valid_hosted_provider_account_transition(to_jsonb(r),%s::jsonb) FROM personal_agent_registry r WHERE user_id='owner-a'",
        (json.dumps(ctx.aged_intent), json.dumps(ctx.aged_state)),
    )[0] == (True, True)
    ctx.row_for_append = ctx.pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
    )[0][0]
    ctx.previous_state = ctx.row_for_append["backend_metadata"]["provisionAttempt"][
        "providerAccountTransition"
    ]
    ctx.unknown_state = {
        **ctx.previous_state,
        "generation": 2,
        "phase": "unknown",
        "settlements": [ctx.unknown],
    }
    ctx.row_after_append = deepcopy(ctx.row_for_append)
    ctx.row_after_append["backend_metadata"]["provisionAttempt"]["providerAccountTransition"] = (
        ctx.unknown_state
    )
    assert ctx.pg.execute(
        "SELECT valid_hosted_provider_account_transition(%s::jsonb,%s::jsonb),valid_hosted_provider_account_transition_append(%s::jsonb,%s::jsonb)",
        (
            json.dumps(ctx.row_after_append),
            json.dumps(ctx.unknown_state),
            json.dumps(ctx.row_for_append),
            json.dumps(ctx.row_after_append),
        ),
    )[0] == (True, True)
    assert (
        ctx.pg.execute(
            "SELECT hosted_provider_effective_billing_account(%s::jsonb)",
            (json.dumps(ctx.row_after_append),),
        )[0][0]
        is None
    )


def _reject_malformed_transition(ctx):
    ctx.malformed_row = deepcopy(ctx.row_after_append)
    ctx.malformed_row["backend_metadata"]["provisionAttempt"]["providerAccountTransition"][
        "unrecognized"
    ] = True
    assert (
        ctx.pg.execute(
            "SELECT hosted_provider_effective_billing_account(%s::jsonb)",
            (json.dumps(ctx.malformed_row),),
        )[0][0]
        is None
    )
    assert asyncio.run(
        ctx.journal.settle_provider_account_transition(
            owner_id="owner-a",
            attempt_id=ctx.item_a["attemptId"],
            expected_generation=1,
            expected_phase="intent",
            settlement=ctx.unknown,
        )
    )
    assert not asyncio.run(
        ctx.journal.settle_provider_account_transition(
            owner_id="owner-a",
            attempt_id=ctx.item_a["attemptId"],
            expected_generation=1,
            expected_phase="intent",
            settlement=ctx.unknown,
        )
    )


def _settle_transition_and_check_effective_account(ctx):
    ctx.settled = {
        "version": 1,
        "outcome": "settled",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "projectId": ctx.item_a["project"],
        "projectNumber": ctx.item_a["projectNumber"],
        "billingAccountName": "billingAccounts/013848-8258FA-2D068F",
        "billingEnabled": True,
        "actorPrincipal": "user:kushaltrivedi97@gmail.com",
        "operationId": ctx.item_a["operationId"],
    }
    assert not asyncio.run(
        ctx.journal.settle_provider_account_transition(
            owner_id="owner-a",
            attempt_id=ctx.item_a["attemptId"],
            expected_generation=1,
            expected_phase="intent",
            settlement=ctx.settled,
        )
    )
    assert asyncio.run(
        ctx.journal.settle_provider_account_transition(
            owner_id="owner-a",
            attempt_id=ctx.item_a["attemptId"],
            expected_generation=2,
            expected_phase="unknown",
            settlement=ctx.settled,
        )
    )
    ctx.transition = ctx.pg.execute(
        "SELECT backend_metadata->'provisionAttempt'->'providerAccountTransition' FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0][0]
    assert ctx.transition["phase"] == "settled" and ctx.transition["generation"] == 3
    ctx.settled_row = ctx.pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-a'"
    )[0][0]
    assert (
        ctx.pg.execute(
            "SELECT hosted_provider_effective_billing_account(%s::jsonb)",
            (json.dumps(ctx.settled_row),),
        )[0][0]
        == "billingAccounts/013848-8258FA-2D068F"
    )
    ctx.history_after = ctx.pg.execute(
        "SELECT (backend_metadata->'provisionAttempt'->'hostedAdmission'->'assignment'->'preparationContract')::text,(backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedPreparation'->'completed'->1)::text FROM personal_agent_registry WHERE user_id='owner-a'"
    )[0]
    assert ctx.history_after == ctx.history_before


def _assert_preparation_history_frozen(ctx):
    ctx.pg.execute(
        "UPDATE personal_agent_registry SET last_heartbeat_at=clock_timestamp() WHERE user_id='owner-a'"
    )
    with pytest.raises(
        ctx.psycopg2.errors.InsufficientPrivilege, match="preparation evidence retained"
    ):
        ctx.pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{provisionAttempt,hostedAdmission,assignment,preparationContract,operatorPrincipal}',to_jsonb('user:rewritten@example.test'::text)) WHERE user_id='owner-a'"
        )
    with pytest.raises(
        ctx.psycopg2.errors.InsufficientPrivilege, match="preparation evidence retained"
    ):
        ctx.pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{provisionAttempt,evidence,reserved,hostedPreparation,completed,1,billingObservation,billingAccountName}',to_jsonb('billingAccounts/rewritten'::text)) WHERE user_id='owner-a'"
        )
    with pytest.raises(
        ctx.psycopg2.errors.InsufficientPrivilege, match="preparation evidence retained"
    ):
        ctx.pg.execute(
            "UPDATE personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{serviceUid}',to_jsonb('rewritten-service-uid'::text)) WHERE user_id='owner-a'"
        )
