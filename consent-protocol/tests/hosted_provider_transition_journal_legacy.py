"""Focused helpers for the retained hosted provider-account transition journal test."""

import asyncio
import json
from copy import deepcopy
from datetime import datetime, timezone

from hushh_mcp.services.hosted_pod_journal import HostedPodJournal
from tests.test_hosted_pilot_admission_postgres import _Client


def _check_rollback_and_apply_transition(ctx):
    ctx.migration = ctx.ROOT / "db/migrations/parked/982_hosted_provider_account_transition.sql"
    ctx.rollback = (
        ctx.ROOT / "db/migrations/rollback/982_hosted_provider_account_transition.rollback.sql"
    )
    ctx.resolution_migration = (
        ctx.ROOT / "db/migrations/parked/983_hosted_provider_account_resolution.sql"
    )
    ctx.resolution_rollback = (
        ctx.ROOT / "db/migrations/rollback/983_hosted_provider_account_resolution.rollback.sql"
    )
    ctx.archive_definition_before = ctx.pg.execute(
        "SELECT pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure)"
    )[0][0]
    ctx.pg.apply_file(ctx.migration)
    ctx.pg.apply_file(ctx.rollback)
    ctx.archive_definition_after_rollback = ctx.pg.execute(
        "SELECT pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure)"
    )[0][0]
    import difflib

    ctx.difflib = difflib
    assert ctx.archive_definition_after_rollback == ctx.archive_definition_before, "".join(
        difflib.unified_diff(
            ctx.archive_definition_before.splitlines(keepends=True),
            ctx.archive_definition_after_rollback.splitlines(keepends=True),
        )
    )
    ctx.pg.apply_file(ctx.migration)
    ctx.intent_definition_after_982 = ctx.pg.execute(
        "SELECT pg_get_functiondef('public.valid_hosted_provider_account_transition_intent(jsonb,jsonb)'::regprocedure)"
    )[0][0]
    ctx.rollback_source_definitions = {
        signature: ctx.pg.execute(
            "SELECT pg_get_functiondef(%s::regprocedure)", ("public." + signature,)
        )[0][0]
        for signature in (
            "hosted_pod_cleanup_admitted(text,text,jsonb)",
            "hosted_preparation_cleanup_admitted(text,text,jsonb)",
            "valid_managed_preparation_cleanup(jsonb,text,jsonb)",
            "valid_erasure_managed_project_retirement(jsonb,text,jsonb)",
            "hosted_prefix_abort_admitted(text,text,jsonb)",
        )
    }
    ctx.pg.apply_file(ctx.resolution_migration)
    ctx.pg.apply_file(ctx.resolution_rollback)
    assert (
        ctx.pg.execute(
            "SELECT to_regprocedure('public.hosted_provider_effective_billing_account(jsonb)')"
        )[0][0]
        is None
    )
    assert (
        ctx.pg.execute(
            "SELECT pg_get_functiondef('public.valid_hosted_provider_account_transition_intent(jsonb,jsonb)'::regprocedure)"
        )[0][0]
        == ctx.intent_definition_after_982
    )
    assert {
        signature: ctx.pg.execute(
            "SELECT pg_get_functiondef(%s::regprocedure)", ("public." + signature,)
        )[0][0]
        for signature in ctx.rollback_source_definitions
    } == ctx.rollback_source_definitions


def _record_legacy_transition(ctx):
    ctx.monkeypatch.setenv("HUSHH_DEPLOY_SHA", "d" * 40)
    ctx.client = _Client(ctx.pg)
    ctx.journal = HostedPodJournal(ctx.client)
    ctx.legacy_item = ctx.project_data[1]
    ctx.legacy_verified_at = datetime.now(timezone.utc).isoformat()
    ctx.legacy_actor_verification = {
        "version": 1,
        "provider": "google",
        "issuer": "https://accounts.google.com",
        "subject": "synthetic-google-subject",
        "principal": "user:kushaltrivedi97@gmail.com",
        "email": "kushaltrivedi97@gmail.com",
        "emailVerified": True,
        "audience": "synthetic-982-transition-audience",
        "verificationMethod": "google_id_token_verified",
        "tokenSha256": "a" * 64,
        "verifiedAt": ctx.legacy_verified_at,
    }
    ctx.legacy_intent = {
        "version": 1,
        "ownerId": ctx.legacy_item["owner"],
        "attemptId": ctx.legacy_item["attemptId"],
        "placementEpoch": 0,
        "operationId": ctx.legacy_item["operationId"],
        "projectId": ctx.legacy_item["project"],
        "projectNumber": ctx.legacy_item["projectNumber"],
        "oldBillingAccount": "billingAccounts/014D7F-FD970D-D2459E",
        "targetBillingAccount": "billingAccounts/013848-8258FA-2D068F",
        "actorPrincipal": "user:kushaltrivedi97@gmail.com",
        "actorVerification": ctx.legacy_actor_verification,
        "serviceUid": ctx.legacy_item["serviceUid"],
        "runtimePrincipal": ctx.legacy_item["runtimePrincipal"],
        "imageDigest": ctx.image_digest,
        "intentAt": ctx.legacy_verified_at,
    }
    assert asyncio.run(
        ctx.journal.record_provider_account_transition_intent(
            owner_id=ctx.legacy_item["owner"],
            attempt_id=ctx.legacy_item["attemptId"],
            intent=ctx.legacy_intent,
        )
    )
    ctx.legacy_before_983 = ctx.pg.execute(
        "SELECT backend_metadata->'provisionAttempt'->'providerAccountTransition' FROM personal_agent_registry WHERE user_id='owner-b'"
    )[0][0]
    assert ctx.legacy_before_983["intent"]["actorVerification"] == ctx.legacy_actor_verification
    ctx.pg.apply_file(ctx.resolution_migration)
    ctx.legacy_row = ctx.pg.execute(
        "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id='owner-b'"
    )[0][0]
    ctx.legacy_transition = ctx.legacy_row["backend_metadata"]["provisionAttempt"][
        "providerAccountTransition"
    ]
    assert ctx.legacy_transition["intent"]["actorVerification"] == ctx.legacy_actor_verification
    assert ctx.pg.execute(
        "SELECT valid_hosted_provider_account_transition_intent(%s::jsonb,%s::jsonb),hosted_provider_effective_billing_account(%s::jsonb)",
        (
            json.dumps(ctx.legacy_row),
            json.dumps(ctx.legacy_transition["intent"]),
            json.dumps(ctx.legacy_row),
        ),
    )[0] == (True, None)


def _prepare_legacy_resume(ctx):
    from hushh_mcp.services.hosted_operator_identity import VerifiedOperator

    ctx.VerifiedOperator = VerifiedOperator
    from hushh_mcp.services.hosted_provider_account_transition import (
        ACTOR_PRINCIPAL,
        HostedProviderAccountTransition,
    )

    ctx.ACTOR_PRINCIPAL = ACTOR_PRINCIPAL
    ctx.HostedProviderAccountTransition = HostedProviderAccountTransition
    ctx.legacy_operator_token = "synthetic-current-userinfo-token"
    ctx.creation_identity = ctx.legacy_row["backend_metadata"]["provisionAttempt"]["evidence"][
        "reserved"
    ]["hostedPreparation"]["completed"][0]["resourceObservation"]["identity"]

    class LegacyResponse:
        status_code = 200

        def __init__(self, body):
            self._body = body

        def json(self):
            return deepcopy(self._body)

    ctx.LegacyResponse = LegacyResponse

    class LegacySession:
        def __init__(self):
            self.get_urls = []
            self.put_count = 0

        def get(self, url, **_kwargs):
            self.get_urls.append(url)
            if url.endswith("/projects/" + ctx.legacy_item["project"]):
                return ctx.LegacyResponse(ctx.creation_identity)
            if url.endswith("/billingAccounts/013848-8258FA-2D068F"):
                return ctx.LegacyResponse(
                    {"name": "billingAccounts/013848-8258FA-2D068F", "open": True}
                )
            if url.endswith("/projects/" + ctx.legacy_item["project"] + "/billingInfo"):
                return ctx.LegacyResponse(
                    {
                        "projectId": ctx.legacy_item["project"],
                        "billingAccountName": "billingAccounts/014D7F-FD970D-D2459E",
                        "billingEnabled": True,
                    }
                )
            raise AssertionError("unexpected legacy resume GET target")

        def put(self, *_args, **_kwargs):
            self.put_count += 1
            raise AssertionError("legacy resume must not issue a billing PUT")

    ctx.LegacySession = LegacySession
    ctx.monkeypatch.setattr(
        "hushh_mcp.services.hosted_provider_account_transition.verify_operator",
        lambda *_args, **_kwargs: VerifiedOperator(
            principal=ACTOR_PRINCIPAL,
            token=ctx.legacy_operator_token,
            subject="synthetic-google-subject",
            email="kushaltrivedi97@gmail.com",
            email_verified=True,
            verified_at=datetime.now(timezone.utc).isoformat(),
        ),
    )


def _resume_legacy_transition(ctx):

    class LegacyRegistry:
        async def get(self, owner_id):
            assert owner_id == ctx.legacy_item["owner"]
            return ctx.pg.execute(
                "SELECT to_jsonb(r) FROM personal_agent_registry r WHERE user_id=%s", (owner_id,)
            )[0][0]

    ctx.LegacyRegistry = LegacyRegistry
    ctx.legacy_session = ctx.LegacySession()
    ctx.legacy_service = ctx.HostedProviderAccountTransition(
        ctx.LegacyRegistry(), credentials=object(), session=ctx.legacy_session, journal=ctx.journal
    )
    assert asyncio.run(ctx.legacy_service.resume(owner_id=ctx.legacy_item["owner"])) == {
        "phase": "unknown",
        "generation": 2,
    }
    assert ctx.legacy_session.put_count == 0
    assert ctx.legacy_session.get_urls
    ctx.legacy_after_resume = ctx.pg.execute(
        "SELECT backend_metadata->'provisionAttempt'->'providerAccountTransition' FROM personal_agent_registry WHERE user_id='owner-b'"
    )[0][0]
    assert ctx.legacy_after_resume["phase"] == "unknown"
    assert ctx.legacy_after_resume["intent"]["actorVerification"] == ctx.legacy_actor_verification


def _create_new_intent_fixture(ctx):

    def make_intent(item, *, delta=0):
        now = datetime.now(timezone.utc)
        if delta:
            from datetime import timedelta

            now -= timedelta(minutes=delta)
        return {
            "version": 1,
            "ownerId": item["owner"],
            "attemptId": item["attemptId"],
            "placementEpoch": 0,
            "operationId": item["operationId"],
            "projectId": item["project"],
            "projectNumber": item["projectNumber"],
            "oldBillingAccount": "billingAccounts/014D7F-FD970D-D2459E",
            "targetBillingAccount": "billingAccounts/013848-8258FA-2D068F",
            "actorPrincipal": "user:kushaltrivedi97@gmail.com",
            "actorVerification": {
                "version": 1,
                "provider": "google",
                "verificationMethod": "google_userinfo_access_token_verified",
                "verificationEndpoint": "https://openidconnect.googleapis.com/v1/userinfo",
                "subject": "synthetic-google-subject",
                "principal": "user:kushaltrivedi97@gmail.com",
                "email": "kushaltrivedi97@gmail.com",
                "emailVerified": True,
                "verifiedAt": now.isoformat(),
            },
            "serviceUid": item["serviceUid"],
            "runtimePrincipal": item["runtimePrincipal"],
            "imageDigest": ctx.image_digest,
            "intentAt": now.isoformat(),
        }

    ctx.make_intent = make_intent
    ctx.intent = ctx.make_intent(ctx.project_data[0])
    ctx.item_a = ctx.project_data[0]
    ctx.item_b = ctx.project_data[1]
    ctx.legacy_candidate = deepcopy(ctx.intent)
    ctx.legacy_candidate_at = datetime.now(timezone.utc).isoformat()
    ctx.legacy_candidate["intentAt"] = ctx.legacy_candidate_at
    ctx.legacy_candidate["actorVerification"] = {
        **ctx.legacy_actor_verification,
        "verifiedAt": ctx.legacy_candidate_at,
    }
