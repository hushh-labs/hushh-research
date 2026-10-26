"""WorkOS enterprise SSO contracts: signatures, state, exchange refusals, deprovisioning.

No database is involved: WorkOS is the authority for organizations and domains and
Firebase is the authority for accounts, so the real service runs against fakes of
those two edges.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hushh_mcp.runtime_settings import workos_sso_enabled
from hushh_mcp.services.enterprise_sso import EnterpriseSsoError, EnterpriseSsoService
from hushh_mcp.services.enterprise_sso.firebase_identity import (
    CLAIM_DEPROVISIONED_AT,
    CLAIM_ORG,
    CLAIM_ORIGIN,
    CLAIM_USER,
)
from hushh_mcp.services.enterprise_sso.membership import membership_hash
from hushh_mcp.services.enterprise_sso.service import sso_uid
from hushh_mcp.services.enterprise_sso.workos_adapter import (
    DirectoryMembership,
    SsoProfile,
    WorkOSConfig,
    WorkOSSdkAdapter,
    sign_state,
    verify_state,
    verify_webhook_signature,
)
from tests.helpers.workos_identity import (
    API_KEY,
    CONFIG,
    SECRET,
    WRONG_SECRET,
    FakeConsent,
    FakeFirebase,
    FakeWorkOS,
    _acme,
    _deleted,
    _event,
    _real_adapter,
    _request,
    _routes_client,
    _sdk_org,
    _sign,
    _sign_in,
    _webhook,
    directory_models,
    offboarding_provider,
)
from tests.helpers.workos_identity import (
    active_firebase_account as active_firebase_account,
)
from tests.helpers.workos_identity import (
    world as world,
)

# ── Pure contracts ──


def test_webhook_signature_accepts_a_good_signature_and_rejects_every_forgery():
    body = b'{"id":"event_1"}'
    verify_webhook_signature(body, _sign(body), SECRET)  # negative control: valid passes
    for header in (
        _sign(body, secret=WRONG_SECRET),
        _sign(b"tampered"),
        _sign(body, issued_ms=int((time.time() - 3600) * 1000)),  # replay outside the window
        "t=abc,v1=00",
        "",
        None,
    ):
        with pytest.raises(EnterpriseSsoError) as refused:
            verify_webhook_signature(body, header, SECRET)
        assert refused.value.code == "webhook_invalid_signature"


def test_webhook_signature_agrees_with_the_vendor_sdk():
    from workos import WorkOSClient

    body = b'{"id":"event_1","event":"dsync.user.deleted","data":{}}'
    sdk = WorkOSClient(api_key=API_KEY, client_id="client_1").webhooks
    sdk.verify_header(event_body=body, event_signature=_sign(body), secret=SECRET)
    with pytest.raises(Exception):  # noqa: B017 - the vendor's own error type
        sdk.verify_header(
            event_body=body, event_signature=_sign(body, secret=WRONG_SECRET), secret=SECRET
        )


def test_state_binds_the_org_and_refuses_tampering_and_expiry():
    state = sign_state(API_KEY, "org_01")
    assert verify_state(API_KEY, state) == "org_01"  # negative control
    payload, _, signature = state.partition(".")
    for bad in (f"{payload}.{signature[:-2]}AA", f"x{payload}.{signature}", "", "nodot"):
        with pytest.raises(EnterpriseSsoError):
            verify_state(API_KEY, bad)
    with pytest.raises(EnterpriseSsoError):
        verify_state("a_different_key", state)
    with pytest.raises(EnterpriseSsoError):
        verify_state(API_KEY, sign_state(API_KEY, "org_01", now=time.time() - 3600))


def test_routes_answer_404_while_the_flag_is_off(monkeypatch):
    from api.routes import workos as routes

    monkeypatch.delenv("WORKOS_SSO_ENABLED", raising=False)
    monkeypatch.delenv("WORKOS_WEBHOOK_SECRET", raising=False)
    app = FastAPI()
    app.include_router(routes.router)
    app.include_router(routes.webhook_router)
    client = TestClient(app)
    assert client.post("/api/auth/sso/start", json={"email": "a@b.example"}).status_code == 404
    assert (
        client.post("/api/auth/sso/exchange", json={"code": "c", "state": "s"}).status_code == 404
    )
    assert client.post("/api/webhooks/workos", content=b"{}").status_code == 404


def test_the_account_uid_is_stable_per_person_and_never_shared_across_orgs_or_people():
    assert sso_uid("org_01", "prof_1") == sso_uid("org_01", "prof_1")
    assert (
        len({sso_uid("org_01", "prof_1"), sso_uid("org_02", "prof_1"), sso_uid("org_01", "prof_2")})
        == 3
    )
    assert sso_uid("org_01", "prof_1").startswith("sso_")


# ── The real adapter on real WorkOS SDK objects ──
# These exist because the fakes below are hand-written: they prove the service's rules, not that
# the adapter reads WorkOS's real objects correctly. A live staging run showed WorkOS leaves its
# built-in Test Identity Provider out of the connection listing, which this protects.


def test_only_dns_verified_domains_count_and_they_are_lowercased():
    org = _sdk_org(
        [
            ("Acme.Example", "verified"),
            ("old.example", "legacy_verified"),
            ("pending.example", "pending"),
            ("unverified.example", "unverified"),
            ("failed.example", "failed"),
        ]
    )
    found = _real_adapter([org], ["active"]).get_organization("org_01")
    assert found.verified_domains == frozenset({"acme.example", "old.example"})


@pytest.mark.parametrize(
    ("connection_states", "disabled"),
    [
        ([], False),  # the built-in Test IdP is not listed: WorkOS, not the listing, decides
        (["active"], False),
        (["inactive"], True),  # a customer switched their connection off
        (["draft", "inactive"], True),
        (["inactive", "active"], False),
    ],
)
def test_sso_is_disabled_only_when_connections_are_listed_and_none_is_active(
    connection_states, disabled
):
    org = _sdk_org([("acme.example", "verified")])
    assert (
        _real_adapter([org], connection_states).get_organization("org_01").sso_disabled is disabled
    )


def test_domain_discovery_never_guesses_between_organizations():
    org = _sdk_org([("acme.example", "verified")])
    assert (
        _real_adapter([org], ["active"]).find_organization_by_domain("acme.example").id == "org_01"
    )
    # a domain WorkOS has not verified, a switched-off organization, and two claimants all give nothing
    assert (
        _real_adapter(
            [_sdk_org([("pending.example", "pending")])], ["active"]
        ).find_organization_by_domain("pending.example")
        is None
    )
    assert _real_adapter([org], ["inactive"]).find_organization_by_domain("acme.example") is None
    assert _real_adapter([org, org], ["active"]).find_organization_by_domain("acme.example") is None


@pytest.mark.parametrize(
    ("error_kwargs", "error_class", "expected_code", "expected_status"),
    [
        # A key and Client ID from different WorkOS applications: our deployment, not the person.
        ({"error": "invalid_client"}, "BadRequestError", "sso_unavailable", 503),
        ({}, "AuthenticationError", "sso_unavailable", 503),
        # A used, expired or unknown code is the person's attempt.
        ({"error": "invalid_grant"}, "BadRequestError", "sso_code_invalid", 400),
        ({}, "NotFoundError", "sso_code_invalid", 400),
    ],
)
def test_a_rejected_code_exchange_tells_a_misconfiguration_from_a_bad_attempt(
    error_kwargs, error_class, expected_code, expected_status
):
    import workos

    adapter = WorkOSSdkAdapter(
        WorkOSConfig(api_key="sk_test_x", client_id="client_x", redirect_uri="https://a.example/b")
    )

    def reject(**_):
        raise getattr(workos, error_class)("rejected", request_id="req_1", **error_kwargs)

    adapter._client = SimpleNamespace(sso=SimpleNamespace(get_profile_and_token=reject))
    with pytest.raises(EnterpriseSsoError) as refused:
        adapter.exchange_code("a-code")
    assert (refused.value.code, refused.value.status_code) == (expected_code, expected_status)


def test_the_adapter_keeps_identity_and_name_without_groups_or_raw_attributes():
    # Built from the real SDK model so a renamed field fails here instead of silently losing names.
    from workos.sso.models.profile import Profile

    sdk_profile = Profile(
        object="profile",
        id="prof_1",
        organization_id="org_01",
        connection_id="conn_1",
        connection_type=None,
        idp_id="idp_1",
        email="ada@acme.example",
        first_name=" Ada ",
        last_name="Lovelace",
        name=None,
        raw_attributes={"department": "analytical engines"},
        groups=["admins"],
    )
    adapter = WorkOSSdkAdapter(
        WorkOSConfig(api_key="sk_test_x", client_id="client_x", redirect_uri="https://a.example/b")
    )
    adapter._client = SimpleNamespace(
        sso=SimpleNamespace(get_profile_and_token=lambda **_: SimpleNamespace(profile=sdk_profile))
    )

    assert adapter.exchange_code("a-code") == SsoProfile(
        id="prof_1",
        organization_id="org_01",
        email="ada@acme.example",
        first_name="Ada",
        last_name="Lovelace",
        connection_id="conn_1",
        idp_id="idp_1",
    )


@pytest.mark.parametrize(
    "case",
    [
        "exact",
        "empty",
        "ambiguous",
        "wrong_org",
        "inactive",
        "paginated",
        "user_page",
        "missing_idp",
    ],
)
def test_directory_attribution_uses_complete_exact_provider_identity(case):
    from workos._pagination import SyncPage
    from workos.common.models.list_metadata import ListMetadata

    directory, user, profile = directory_models(case)
    calls = []

    def connection(identifier):
        calls.append(("connection", identifier))
        return SimpleNamespace(
            organization_id="wrong" if case == "wrong_org" else "org_01", state="active"
        )

    def users(**kwargs):
        calls.append(("users", kwargs))
        assert kwargs == {"directory": "directory_1", "idp_id": "idp_1", "limit": 2}
        return SyncPage(
            [user, user] if case == "ambiguous" else [user],
            ListMetadata(before=None, after="more" if case == "user_page" else None),
        )

    adapter = WorkOSSdkAdapter(CONFIG)
    adapter._client = SimpleNamespace(
        sso=SimpleNamespace(get_connection=connection),
        directory_sync=SimpleNamespace(
            list_directories=lambda **_: SyncPage(
                [] if case == "empty" else [directory],
                ListMetadata(before=None, after="more" if case == "paginated" else None),
            ),
            list_users=users,
        ),
    )
    if case in {"exact", "empty"}:
        assert adapter.directory_membership(profile) == (
            None if case == "empty" else DirectoryMembership("directory_1", "directory_user_1")
        )
        if case == "empty":
            assert calls == []  # TestIdP needs no hidden-connection lookup.
    else:
        with pytest.raises(EnterpriseSsoError) as refused:
            adapter.directory_membership(profile)
        assert refused.value.code == "sso_directory_binding_required"


# ── Fakes ──


async def test_generation_activation_preserves_original_workos_signin_and_offboarding(
    world, monkeypatch
):
    monkeypatch.setenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", "true")
    await _sign_in(world)
    uid = sso_uid("org_01", "prof_1")
    assert world.firebase.minted[0][0] == uid
    assert world.firebase.minted[0][1]["hussh_workos_membership"]
    await _webhook(world, _deleted())
    assert world.firebase.quarantined == [uid]
    assert world.consent.revoked == [uid]
    with pytest.raises(EnterpriseSsoError) as refused:
        await _sign_in(world)
    assert refused.value.code == "sso_deprovisioned"


# ── Start ──


async def test_start_asks_workos_which_org_owns_the_domain(world):
    started = await world.service.start(email="Someone@ACME.example", organization_id=None)
    assert started["organization"] == {"name": "Acme"}
    assert verify_state(API_KEY, started["state"]) == "org_01"
    assert world.workos.urls == [("org_01", "someone@acme.example")]


@pytest.mark.parametrize("setup", ["unknown_domain", "consumer_domain", "sso_switched_off"])
async def test_start_refuses_unowned_domains_free_mail_and_inactive_orgs(world, setup):
    email = "x@elsewhere.example"
    if setup == "consumer_domain":
        # Even if WorkOS were to claim it, a free-mail domain is never an org's to own.
        world.workos.orgs["org_01"] = _acme(verified_domains=frozenset({"gmail.com"}))
        email = "x@gmail.com"
    elif setup == "sso_switched_off":
        world.workos.orgs["org_01"] = _acme(sso_disabled=True)
        email = "x@acme.example"
    with pytest.raises(EnterpriseSsoError) as refused:
        await world.service.start(email=email, organization_id=None)
    assert refused.value.code == "sso_not_available"
    assert world.workos.urls == []


async def test_start_can_target_an_org_id_but_not_one_whose_sso_is_switched_off(world):
    started = await world.service.start(email=None, organization_id="org_01")
    assert verify_state(API_KEY, started["state"]) == "org_01"
    world.workos.orgs["org_01"] = _acme(sso_disabled=True)
    with pytest.raises(EnterpriseSsoError):
        await world.service.start(email=None, organization_id="org_01")


# ── Exchange ──


async def test_first_sign_in_creates_a_stable_account_with_a_minimal_token(world):
    result = await _sign_in(world)
    uid = result["user_id"]
    assert uid == sso_uid("org_01", "prof_1")
    assert result["is_new_account"]
    user = world.firebase.users[uid]
    assert user["email"] == "ada@acme.example" and user["verified"]
    assert user["claims"] == {CLAIM_ORG: "org_01", CLAIM_USER: "prof_1", CLAIM_ORIGIN: "created"}
    # Identity only: two token claims, never the review-lane marker, never a role.
    assert world.firebase.minted == [
        (
            uid,
            {
                "auth_provider": "workos",
                "workos_org_id": "org_01",
                "hussh_workos_profile": membership_hash("org_01", "prof_1"),
                "hussh_workos_membership": membership_hash(
                    "org_01", "directory_1", "directory_user_1"
                ),
            },
        )
    ]
    again = await _sign_in(world)
    assert again["user_id"] == uid and not again["is_new_account"]
    assert len(world.firebase.users) == 1


async def test_simultaneous_first_sign_ins_make_one_account(world):
    first, second = await asyncio.gather(_sign_in(world), _sign_in(world))
    assert first["user_id"] == second["user_id"]
    assert len(world.firebase.users) == 1


NEW_ACCOUNT = object()


@pytest.mark.parametrize(
    ("existing_name", "first", "last", "full", "expected"),
    [
        (NEW_ACCOUNT, "Ada", "Lovelace", None, "Ada Lovelace"),
        (NEW_ACCOUNT, "Ada", None, None, "Ada"),
        (NEW_ACCOUNT, None, None, "Ada King", "Ada King"),  # an IdP that sends only a full name
        (None, "Ada", "Lovelace", None, "Ada Lovelace"),  # a linked account with no name yet
        ("Countess A.", "Ada", "Lovelace", None, "Countess A."),  # the name already there wins
        (NEW_ACCOUNT, "ada@acme.example", None, None, None),  # an address is not a name
        (NEW_ACCOUNT, None, None, None, None),  # the IdP sent no name at all
    ],
)
async def test_the_idps_name_fills_an_empty_profile_and_never_replaces_one(
    world, existing_name, first, last, full, expected
):
    world.workos.profile = replace(
        world.workos.profile, first_name=first, last_name=last, name=full
    )
    if existing_name is not NEW_ACCOUNT:
        world.firebase.add("uid-existing", "ada@acme.example", display_name=existing_name)

    result = await _sign_in(world)

    assert world.firebase.users[result["user_id"]]["display_name"] == expected
    assert world.firebase.minted  # a name never stands between a person and signing in


async def test_a_returning_sso_account_gets_its_name_on_the_next_sign_in(world):
    first = await _sign_in(world)  # the IdP sent no name this time
    world.workos.profile = replace(world.workos.profile, first_name="Ada", last_name="Lovelace")

    again = await _sign_in(world)

    assert again["user_id"] == first["user_id"]
    assert world.firebase.users[first["user_id"]]["display_name"] == "Ada Lovelace"


async def test_a_name_that_cannot_be_saved_does_not_stop_sign_in(world):
    async def provider_down(uid, display_name):
        raise RuntimeError("identity provider down")

    world.firebase.add("uid-existing", "ada@acme.example")
    world.firebase.set_display_name = provider_down
    world.workos.profile = replace(world.workos.profile, first_name="Ada", last_name="Lovelace")

    result = await _sign_in(world)

    assert result["user_id"] == "uid-existing" and world.firebase.minted
    assert world.firebase.users["uid-existing"]["display_name"] is None


async def test_a_changed_work_email_still_reaches_the_same_account(world):
    uid = (await _sign_in(world))["user_id"]
    world.workos.profile = SsoProfile("prof_1", "org_01", "ada.lovelace@acme.example")
    again = await _sign_in(world)
    assert again["user_id"] == uid and len(world.firebase.users) == 1


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        ("org_mismatch", "sso_org_mismatch"),
        ("org_unknown_to_workos", "sso_org_not_enabled"),
        ("sso_switched_off", "sso_org_not_enabled"),
        ("unverified_domain", "sso_domain_not_verified"),
        ("consumer_domain", "sso_domain_not_verified"),
        ("bad_code", "sso_code_invalid"),
        ("bad_state", "sso_state_invalid"),
    ],
)
async def test_exchange_refuses_and_creates_nothing(world, setup, code):
    state = None
    if setup == "org_mismatch":
        world.workos.profile = SsoProfile("prof_1", "org_other", "ada@acme.example")
    elif setup == "org_unknown_to_workos":
        world.workos.orgs.clear()
    elif setup == "sso_switched_off":
        world.workos.orgs["org_01"] = _acme(sso_disabled=True)
    elif setup == "unverified_domain":
        # The IdP may assert an address, but only on a domain this org verified with WorkOS.
        world.workos.profile = SsoProfile("prof_1", "org_01", "ceo@someone-elses-company.example")
    elif setup == "consumer_domain":
        world.workos.orgs["org_01"] = _acme(verified_domains=frozenset({"gmail.com"}))
        world.workos.profile = SsoProfile("prof_1", "org_01", "victim@gmail.com")
    elif setup == "bad_state":
        state = "forged.state"
    with pytest.raises(EnterpriseSsoError) as refused:
        await world.service.exchange(
            code="bad" if setup == "bad_code" else "good-code",
            state=state or sign_state(API_KEY, "org_01"),
        )
    assert refused.value.code == code
    assert world.firebase.users == {} and world.firebase.minted == []


async def test_an_existing_verified_account_is_linked_not_duplicated(world):
    world.firebase.add("uid-existing", "ada@acme.example", verified=True)
    result = await _sign_in(world)
    assert result["user_id"] == "uid-existing" and not result["is_new_account"]
    assert len(world.firebase.users) == 1
    assert world.firebase.users["uid-existing"]["claims"][CLAIM_ORIGIN] == "linked"


async def test_an_unverified_existing_account_is_never_taken_over(world):
    world.firebase.add("uid-squatter", "ada@acme.example", verified=False)
    with pytest.raises(EnterpriseSsoError) as refused:
        await _sign_in(world)
    assert refused.value.code == "sso_email_conflict"
    assert world.firebase.minted == []
    assert world.firebase.users["uid-squatter"]["claims"] == {}


async def test_an_address_is_never_handed_to_a_different_person(world):
    # A leaver's account must not pass to a new hire who reuses the same address.
    world.firebase.add(
        "uid-leaver", "ada@acme.example", **{CLAIM_ORG: "org_01", CLAIM_USER: "prof_leaver"}
    )
    with pytest.raises(EnterpriseSsoError) as refused:
        await _sign_in(world)
    assert refused.value.code == "sso_account_conflict"
    assert world.firebase.minted == []


async def test_a_deleted_account_is_not_recreated(world):
    world.deleted.add(sso_uid("org_01", "prof_1"))
    with pytest.raises(EnterpriseSsoError) as refused:
        await _sign_in(world)
    assert refused.value.code == "sso_account_deleted"
    assert world.firebase.users == {}


# ── Webhook deprovisioning ──


async def test_webhook_rejects_a_bad_signature_and_changes_nothing(world):
    uid = (await _sign_in(world))["user_id"]
    body = _deleted()
    with pytest.raises(EnterpriseSsoError) as refused:
        await world.service.handle_webhook(body=body, signature=_sign(body, secret=WRONG_SECRET))
    assert refused.value.code == "webhook_invalid_signature"
    assert world.firebase.quarantined == [] and world.consent.revoked == []
    assert CLAIM_DEPROVISIONED_AT not in world.firebase.users[uid]["claims"]
    # Negative control: the same event with a good signature does act.
    assert (await _webhook(world, body))["deprovisioned"] == 1


async def test_deprovisioning_an_sso_account_ends_it_and_its_grants_and_blocks_sign_in(world):
    uid = (await _sign_in(world))["user_id"]
    await _webhook(world, _deleted(email="ADA@acme.example"))
    assert world.firebase.quarantined == [uid]
    assert world.consent.revoked == [uid]
    assert world.firebase.users[uid]["claims"][CLAIM_DEPROVISIONED_AT]
    with pytest.raises(EnterpriseSsoError) as refused:
        await _sign_in(world)
    assert refused.value.code == "sso_deprovisioned"


async def test_deprovisioning_a_linked_personal_account_ends_the_work_session_only(world):
    world.firebase.add("uid-personal", "ada@acme.example", verified=True)
    await _sign_in(world)  # links the existing account
    body = _deleted()
    assert (await _webhook(world, body))["deprovisioned"] == 1
    # Their own account, vault and grants are not the employer's to disable.
    assert world.firebase.quarantined == [] and world.consent.revoked == []
    assert world.firebase.sessions_revoked == ["uid-personal"]
    assert not world.firebase.users["uid-personal"]["disabled"]
    # ...but they can no longer sign in through the organization.
    with pytest.raises(EnterpriseSsoError) as refused:
        await _sign_in(world)
    assert refused.value.code == "sso_deprovisioned"


async def test_an_inactive_directory_update_deprovisions_but_an_active_one_does_not(world):
    uid = (await _sign_in(world))["user_id"]
    data = {
        "id": "directory_user_1",
        "directory_id": "directory_1",
        "organization_id": "org_01",
        "email": "ada@acme.example",
    }
    active = _event("dsync.user.updated", {**data, "state": "active"}, "event_a")
    await _webhook(world, active)
    assert world.firebase.quarantined == []
    inactive = _event("dsync.user.updated", {**data, "state": "inactive"}, "event_b")
    await _webhook(world, inactive)
    assert world.firebase.quarantined == [uid]


async def test_deprovision_requires_captured_membership_not_the_event_email(world):
    uid = (await _sign_in(world))["user_id"]
    world.firebase.add("uid-bystander", "bystander@acme.example", verified=True)
    for body in (
        _deleted(org="org_other"),
        _deleted(directory="other"),
        _deleted(person="stranger"),
    ):
        with pytest.raises(EnterpriseSsoError) as refused:
            await _webhook(world, body)
        assert refused.value.code == "sso_directory_binding_required"
    assert not world.firebase.quarantined and not world.firebase.sessions_revoked
    # An email change or malicious email field cannot select another identity.
    assert (await _webhook(world, _deleted(email="bystander@acme.example")))["deprovisioned"] == 1
    assert world.firebase.quarantined == [uid]
    assert world.firebase.users["uid-bystander"]["claims"] == {}


async def test_retired_membership_cannot_offboard_the_same_uid_replacement(world):
    uid = (await _sign_in(world))["user_id"]
    world.memberships.retired.add(uid)
    # The external UID still exists with a replacement's state. A late event
    # must not read/mutate that identity or revoke the new owner's grants.
    world.firebase.users[uid]["claims"] = {"replacement": True}
    assert (await _webhook(world, _deleted()))["deprovisioned"] == 0
    assert world.firebase.users[uid]["claims"] == {"replacement": True}
    assert not world.firebase.quarantined and not world.consent.revoked


async def test_a_redelivered_event_repeats_harmlessly(world):
    uid = (await _sign_in(world))["user_id"]
    body = _deleted()
    await _webhook(world, body)
    claims_after_first = dict(world.firebase.users[uid]["claims"])
    again = await _webhook(world, body)
    assert again == {"received": True, "deprovisioned": 1}
    assert world.firebase.users[uid]["claims"] == claims_after_first  # first timestamp kept


async def test_an_incomplete_quarantine_fails_the_delivery_and_a_retry_finishes_it(world):
    uid = (await _sign_in(world))["user_id"]
    body = _deleted()
    world.firebase.quarantine_ok = False
    with pytest.raises(EnterpriseSsoError) as failed:
        await _webhook(world, body)
    assert failed.value.status_code == 503
    assert world.consent.revoked == []
    # Sign-in is already refused even though Firebase could not be reached.
    assert world.firebase.users[uid]["claims"][CLAIM_DEPROVISIONED_AT]
    world.firebase.quarantine_ok = True
    assert (await _webhook(world, body))["deprovisioned"] == 1
    assert world.consent.revoked == [uid]


async def test_unrelated_events_are_acknowledged_and_ignored(world):
    body = _event("dsync.group.created", {"id": "group_1"})
    assert await _webhook(world, body) == {"received": True, "deprovisioned": 0}


def test_deploy_binds_exactly_the_variables_the_runtime_reads(monkeypatch):
    """A rename on either side would leave a deployed lane with SSO silently off."""
    script = Path(__file__).resolve().parents[2] / "deploy" / "sso" / "bind_workos.sh"
    text = script.read_text(encoding="utf-8")
    secrets = re.findall(r"(?m)^append_optional_secret (WORKOS_[A-Z_]+) (WORKOS_[A-Z_]+)\s*$", text)
    flags = re.findall(r"(?m)^append_optional_env (WORKOS_[A-Z_]+) ", text)
    assert secrets and flags, "the deploy script must bind the WorkOS variables"
    deploy = script.parents[2] / "scripts" / "deploy" / "backend-deploy.sh"
    assert "source deploy/sso/bind_workos.sh" in deploy.read_text(encoding="utf-8")
    # The secret is created under exactly the name the runtime reads.
    assert all(secret == variable for secret, variable in secrets)
    bound = [variable for _, variable in secrets] + flags
    for name in [n for n in os.environ if n.startswith("WORKOS_")]:
        monkeypatch.delenv(name)
    for name in bound:
        value = {"_URI": "https://app.example/login", "_ORIGINS": "https://app.example"}
        monkeypatch.setenv(name, next((v for k, v in value.items() if name.endswith(k)), "true"))

    config = WorkOSConfig.from_env()

    assert workos_sso_enabled()
    assert config.sign_in_ready and config.webhook_secret and config.redirect_origins


def test_cloudbuild_packs_sso_settings_in_binder_order():
    cloudbuild = Path(__file__).resolve().parents[2] / "deploy" / "backend.cloudbuild.yaml"
    assert (
        "_WORKOS_CONFIG=${_WORKOS_SSO_ENABLED}|${_WORKOS_REDIRECT_URI}|${_WORKOS_REDIRECT_ORIGINS}"
        in cloudbuild.read_text(encoding="utf-8")
    )


async def test_sign_in_is_unavailable_without_the_webhook_secret():
    """Offboarding arrives by webhook, so SSO that cannot receive it must not sign anyone in."""
    service = EnterpriseSsoService(
        workos=FakeWorkOS(),
        config=replace(CONFIG, webhook_secret=""),
        firebase=FakeFirebase(),
        consent=FakeConsent(),
        is_tombstoned=lambda uid: False,
    )

    with pytest.raises(EnterpriseSsoError) as refused:
        await service.start(email="person@example.com", organization_id=None)

    assert refused.value.code == "sso_unavailable"
    assert refused.value.status_code == 503


@pytest.mark.parametrize(
    ("connection_states", "disabled"),
    [([], True), (["active"], False), (["inactive"], True)],
)
def test_production_reads_an_empty_connection_list_as_no_sso(connection_states, disabled):
    # Production has no hidden test provider, so an organization with no connection must not
    # be sent to WorkOS (the person would land on a failed sign-in).
    org = _sdk_org([("acme.example", "verified")])
    adapter = _real_adapter([org], connection_states, api_key="sk_live_x")
    assert adapter.get_organization("org_01").sso_disabled is disabled


_DEFAULT_REDIRECT = "https://uat.one.hushh.ai/login"
_ORIGINS = ("https://uat.one.hushh.ai", "https://uat.one.hussh.ai", "https://uat.one.hussh.si")


@pytest.mark.parametrize(
    ("origin", "expected"),
    [
        ("https://uat.one.hussh.ai", "https://uat.one.hussh.ai/login"),
        ("https://UAT.one.hussh.si/", "https://uat.one.hussh.si/login"),
        ("https://evil.example", _DEFAULT_REDIRECT),  # not a host we serve
        ("http://uat.one.hussh.ai", _DEFAULT_REDIRECT),  # plain http is never honoured
        (None, _DEFAULT_REDIRECT),
    ],
)
def test_sso_returns_only_to_an_origin_we_serve(origin, expected):
    config = replace(CONFIG, redirect_uri=_DEFAULT_REDIRECT, redirect_origins=_ORIGINS)
    assert config.redirect_uri_for(origin) == expected


def test_a_misconfigured_insecure_origin_is_still_never_honoured_except_localhost():
    config = replace(
        CONFIG,
        redirect_uri=_DEFAULT_REDIRECT,
        redirect_origins=("http://insecure.example", "http://localhost:3000"),
    )
    assert config.redirect_uri_for("http://insecure.example") == _DEFAULT_REDIRECT
    assert config.redirect_uri_for("http://localhost:3000") == "http://localhost:3000/login"


async def test_start_sends_workos_the_redirect_for_the_origin_the_person_started_on():
    workos = FakeWorkOS()
    service = EnterpriseSsoService(
        workos=workos,
        config=replace(CONFIG, redirect_origins=("https://alt.example",)),
        firebase=FakeFirebase(),
        consent=FakeConsent(),
        is_tombstoned=lambda uid: False,
    )

    await service.start(
        email="someone@acme.example", organization_id=None, origin="https://alt.example"
    )
    await service.start(
        email="someone@acme.example", organization_id=None, origin="https://evil.example"
    )

    assert workos.redirects == ["https://alt.example/cb", "https://app.example/cb"]


def test_the_webhook_keeps_working_after_sign_in_is_switched_off(monkeypatch):
    # Turning sign-in off is the rollback. It must not make WorkOS's offboarding events fail.
    client = _routes_client(monkeypatch, enabled=False, secret=SECRET)

    bad = client.post(
        "/api/webhooks/workos", content=b"{}", headers={"WorkOS-Signature": "t=1, v1=00"}
    )

    assert bad.status_code == 400  # reachable and verifying, not the 404 of a dark deployment
    assert client.post("/api/auth/sso/start", json={"email": "a@acme.example"}).status_code == 404


def test_start_takes_the_email_in_the_body_never_the_url(monkeypatch):
    client = _routes_client(monkeypatch, enabled=True, secret=SECRET)

    assert client.get("/api/auth/sso/start", params={"email": "a@acme.example"}).status_code == 405
    assert client.post("/api/auth/sso/start", json={}).status_code == 422


def test_the_limited_routes_work_with_the_limiter_switched_on(monkeypatch):
    # The limiter is off under pytest, so a broken key function never ran. slowapi hands the request
    # only to a key function whose parameter is named `request` and calls any other with no
    # argument; that made both routes answer 500 on UAT while every other test passed.
    from slowapi.errors import RateLimitExceeded

    from api.middlewares.rate_limit import limiter, rate_limit_exceeded_handler

    client = _routes_client(monkeypatch, enabled=True, secret=SECRET)
    client.app.state.limiter = limiter
    client.app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
    monkeypatch.setattr(limiter, "enabled", True)
    limiter.reset()
    try:
        # 61 requests: whichever way a minute boundary splits them, one window holds more than 30.
        starts = [client.post("/api/auth/sso/start", json={}).status_code for _ in range(61)]
        exchange = client.post("/api/auth/sso/exchange", json={"code": "x", "state": "y"})
    finally:
        limiter.reset()

    assert set(starts) == {422, 429}  # reached the handler (422) until the ceiling held (429)
    assert exchange.status_code not in (429, 500)


@pytest.mark.parametrize(
    ("forwarded", "expected"),
    [
        ("203.0.113.9, 10.0.0.1", "sso:203.0.113.9"),
        # A visitor who sends their own X-Forwarded-For cannot take over the slot we read.
        ("1.1.1.1, 203.0.113.9, 10.0.0.1", "sso:203.0.113.9"),
        ("203.0.113.9", "sso:10.0.0.1"),  # no proxy hop to trust: fall back to the peer
        (None, "sso:10.0.0.1"),
    ],
)
def test_the_rate_limit_tells_visitors_apart_behind_the_proxy(forwarded, expected):
    from api.routes import workos as routes

    assert routes._client_key(_request(forwarded)) == expected


@pytest.mark.parametrize(
    ("event", "state", "expected"),
    [
        ("dsync.user.deleted", None, True),
        ("dsync.user.updated", "inactive", True),
        ("dsync.user.updated", "suspended", True),
        ("dsync.user.updated", "active", False),
        ("dsync.group.created", "inactive", False),
    ],
)
def test_which_directory_events_deprovision(event, state, expected):
    data = {"state": state} if state else {}
    assert EnterpriseSsoService._is_deprovision(event, data) is expected


@pytest.mark.skipif(sys.platform == "win32" or not shutil.which("bash"), reason="needs POSIX bash")
@pytest.mark.parametrize(
    ("flag", "bound", "redirect_uri", "ok"),
    [
        (
            "true",
            "WORKOS_API_KEY WORKOS_CLIENT_ID WORKOS_WEBHOOK_SECRET",
            "https://app.example/login",
            True,
        ),
        (
            "true",
            "WORKOS_API_KEY WORKOS_CLIENT_ID",
            "https://app.example/login",
            False,
        ),  # missing secret
        (
            "true",
            "WORKOS_API_KEY WORKOS_CLIENT_ID WORKOS_WEBHOOK_SECRET",
            "",
            False,
        ),  # missing redirect
        ("", "", "", True),  # SSO off: the secrets stay optional
    ],
)
def test_deploy_refuses_to_enable_sso_with_missing_required_configuration(
    flag, bound, redirect_uri, ok
):
    script = Path(__file__).resolve().parents[2] / "deploy" / "sso" / "bind_workos.sh"
    stubs = (
        "secrets=BASE=x:latest; PROJECT_ID=p\n"
        'append_optional_secret() { case " $BOUND " in *" $1 "*) secrets="${secrets},$2=$1:latest";; esac; }\n'
        "append_optional_env() { :; }\n"
    )
    # Cloud Build packs these three substitutions into one step env entry.
    env = {
        **os.environ,
        "BOUND": bound,
        "_WORKOS_CONFIG": f"{flag}|{redirect_uri}|https://app.example",
    }
    run = subprocess.run(  # noqa: S603 - fixed shell and repository script; fixed inputs
        ["bash", "-c", f"{stubs}source {script}"], env=env, capture_output=True, text=True
    )
    assert (run.returncode == 0) is ok


async def test_sso_only_login_preserves_prior_offboarding_when_directory_is_removed(world):
    world.workos.directory_membership = lambda _: None
    await _sign_in(world)
    assert "hussh_workos_profile" in world.firebase.minted[-1][1]
    assert "hussh_workos_membership" not in world.firebase.minted[-1][1]
    # A later verified exchange captures Directory Sync; removing that directory
    # cannot downgrade a previously offboarded profile to SSO-only authority.
    world.workos.directory_membership = lambda _: DirectoryMembership(
        "directory_1", "directory_user_1"
    )
    await _sign_in(world)
    world.memberships.offboard("org_01", "directory_1", "directory_user_1")
    world.workos.directory_membership = lambda _: None
    before = len(world.firebase.minted)
    with pytest.raises(EnterpriseSsoError) as refused:
        await _sign_in(world)
    assert refused.value.code == "sso_deprovisioned"
    assert len(world.firebase.minted) == before


@pytest.mark.parametrize(
    "origin,changed,lost",
    [
        ("created", False, False),
        ("linked", False, False),
        ("linked", True, False),
        ("created", False, True),
    ],
)
async def test_offboarding_rechecks_binding_and_settles_one_provider_write(
    monkeypatch, origin, changed, lost
):
    identity, permit, settlements, writes = offboarding_provider(monkeypatch, origin, changed, lost)
    if changed or lost:
        with pytest.raises(EnterpriseSsoError) as error:
            await identity.offboard(
                "captured-owner", origin, "org_01", membership_hash("org_01", "prof_1")
            )
        assert error.value.status_code == (409 if changed else 503)
    else:
        assert await identity.offboard(
            "captured-owner", origin, "org_01", membership_hash("org_01", "prof_1")
        )
    assert settlements == [
        (permit, "rejected" if changed else "uncertain" if lost else "succeeded")
    ]
    assert len(writes) == (0 if changed else 1)
    if writes:
        uid, fields = writes[0]
        assert uid == "captured-uid"
        assert fields.get("disableUser", False) is (origin == "created")
        assert set(fields) == (
            {"customAttributes", "validSince", "disableUser"}
            if origin == "created"
            else {"customAttributes", "validSince"}
        )
        decoded = json.loads(fields["customAttributes"])
        assert decoded["unrelated"] == "preserved" and decoded[CLAIM_DEPROVISIONED_AT] > 0


@pytest.mark.parametrize(
    "state",
    ["active", "offboarded", "retired", "foreign_lane", "database_outage", "legacy_offboarded"],
)
@pytest.mark.parametrize("profile_only", [False, True])
def test_held_workos_custom_token_cannot_reopen_an_offboarded_membership(
    monkeypatch, state, profile_only, active_firebase_account
):
    import firebase_admin.auth as firebase_auth
    from fastapi import HTTPException

    from api.utils import firebase_auth as firebase_auth_module
    from api.utils.firebase_auth import verify_firebase_bearer
    from hushh_mcp.services.enterprise_sso.membership import SqlMembershipStore

    monkeypatch.delenv("ACCOUNT_GENERATION_ADMISSION_ENABLED", raising=False)
    lane = firebase_auth_module.current_auth_lane()
    claims = {
        "uid": "captured-owner",
        "firebase": {"sign_in_provider": "custom"},
        "auth_provider": "workos",
        "hussh_account_owner": "captured-owner",
        "hussh_account_lane": "foreign-lane" if state == "foreign_lane" else lane,
        "hussh_workos_membership": "sha256:" + "a" * 64,
    }
    if profile_only:
        claims["hussh_workos_profile"] = claims.pop("hussh_workos_membership")
    if state == "legacy_offboarded":
        claims.pop("hussh_workos_membership", None)
        claims.pop("hussh_workos_profile", None)
        claims["workosDeprovisionedAt"] = 1
    calls = []

    def admit(_self, key, owner):
        calls.append((key, owner))
        if state == "database_outage":
            raise ConnectionError("synthetic outage")
        return state == "active"

    monkeypatch.setattr(SqlMembershipStore, "admit", admit)
    monkeypatch.setattr(SqlMembershipStore, "admit_profile", admit)
    monkeypatch.setattr(firebase_auth_module, "ensure_firebase_auth_admin", lambda: (True, "test"))
    monkeypatch.setattr(firebase_auth_module, "get_firebase_auth_app", lambda: object())
    # The ID token is freshly redeemed AFTER provider revocation, so Firebase
    # signature/auth_time alone cannot distinguish this held custom token.
    monkeypatch.setattr(firebase_auth, "verify_id_token", lambda *_args, **_kwargs: claims)
    if state == "active":
        assert verify_firebase_bearer("Bearer held-workos-proof") == "captured-owner"
    else:
        with pytest.raises(HTTPException) as error:
            verify_firebase_bearer("Bearer held-workos-proof")
        assert error.value.status_code == (
            503 if state == "database_outage" else 401 if state == "foreign_lane" else 403
        )
    assert len(calls) == (0 if state in {"foreign_lane", "legacy_offboarded"} else 1)
