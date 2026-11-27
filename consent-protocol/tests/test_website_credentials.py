"""Canonical Secrets and ephemeral human-approved Browser lease boundaries."""

import time
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException

from hushh_mcp.consent.pkm_scope_policy import (
    is_external_requestable_pkm_scope,
    is_private_pkm_export_scope,
)
from hushh_mcp.services import pod_sealed_envelope as sealed
from hushh_mcp.services.pod_browser.contracts import BrowserRefused
from hushh_mcp.services.pod_browser.credential_contracts import CredentialUseRequest
from hushh_mcp.services.pod_browser.credential_transient import (
    PURPOSE,
    CredentialLeaseKeys,
    HumanCredentialSource,
    open_worker_lease,
)
from tests.helpers.pod_browser import binding

ID = "sec_" + "a" * 16


def lease_fixture():
    bound = binding(expires_at=int(time.time()) + 600)
    request = CredentialUseRequest(
        operation_id="human_operation",
        handle=ID,
        origin="https://example.com",
        control_epoch=1,
        targets={
            "username": {"x": 10, "y": 10},
            "password": {"x": 10, "y": 40},
            "submit": {"x": 10, "y": 70},
        },
    )
    keys = CredentialLeaseKeys(bound)
    public = keys.prepare(request)
    aad = {
        "purpose": PURPOSE.name,
        "ownerId": bound.owner_id,
        "credentialId": ID,
        "recordRevision": 1,
        "sourceContentRevision": 2,
        "sourceManifestRevision": 3,
        "podId": bound.pod_id,
        "leaseKeyId": public["id"],
        "taskId": bound.task_id,
        "incarnation": bound.incarnation,
        "controlEpoch": 1,
        "origin": request.origin,
        "operationId": request.operation_id,
        "expiresAt": min(int(time.time()) + 60, public["expires_at"]),
        "nonce": str(uuid4()),
    }
    return bound, request, keys, public, aad


@pytest.mark.parametrize("fault", [None, "origin", "task", "epoch", "expired", "key", "replay"])
async def test_worker_lease_is_ephemeral_bound_single_use_and_cleared(fault):

    bound, request, keys, public, aad = lease_fixture()
    if fault == "origin":
        aad["origin"] = "https://other.example.com"
    if fault == "task":
        aad["taskId"] = "browser_" + "b" * 32
    if fault == "epoch":
        aad["controlEpoch"] += 1
    if fault == "expired":
        aad["expiresAt"] = int(time.time()) - 1
    if fault == "key":
        aad["leaseKeyId"] = "lease_" + "b" * 32
    envelope = sealed.seal(
        {"username": "synthetic-user", "password": "synthetic-private-password"},
        purpose=PURPOSE,
        pod_public_key_raw=sealed.b64url_decode(public["public_key"], length=32),
        aad=aad,
    )

    async def check():
        pass

    async def use():
        async with open_worker_lease(keys, bound, request, envelope, check=check) as lease:
            assert lease.password == bytearray(b"synthetic-private-password")
            return lease

    if fault not in (None, "replay"):
        with pytest.raises(BrowserRefused):
            await use()
    else:
        lease = await use()
        assert not any(lease.password) and not any(lease.username)
        with pytest.raises(BrowserRefused):
            await use()
    assert keys._pending is None or fault in {"origin", "task", "epoch", "expired"}


async def test_host_source_never_unwraps_and_requires_current_source_before_nonce(monkeypatch):
    bound, request, _, public, aad = lease_fixture()

    envelope = sealed.seal(
        {"username": "synthetic-user", "password": "synthetic-private-password"},
        purpose=PURPOSE,
        pod_public_key_raw=sealed.b64url_decode(public["public_key"], length=32),
        aad=aad,
    )
    current, claims = True, []

    async def check(binding, value):
        if not current:
            raise BrowserRefused("BROWSER_CREDENTIAL_SOURCE_CHANGED")

    async def claim():
        claims.append(aad["nonce"])

    monkeypatch.setattr(
        sealed, "open_envelope", lambda *a, **k: pytest.fail("host must never decrypt")
    )
    source = HumanCredentialSource(check)
    async with source.open_transient(bound, request, envelope, claim=claim) as lease:
        assert not lease.username and not lease.password and lease.envelope is envelope
    assert len(claims) == 1
    current = False
    with pytest.raises(BrowserRefused):
        async with source.open_transient(bound, request, envelope, claim=claim):
            pass
    assert len(claims) == 1


def test_only_exact_canonical_secret_item_can_use_owner_started_export():
    from hushh_mcp.consent.pkm_scope_policy import (
        is_private_pkm_manifest_path,
        is_public_pkm_projection_allowed,
    )
    from hushh_mcp.services.owner_item_grants import OwnerItemRequest

    scope = "attr.secrets.items." + ID
    assert not is_external_requestable_pkm_scope(scope)
    assert not is_private_pkm_export_scope(scope)
    for refused in (
        "attr.secrets.*",
        "attr.secrets.items.*",
        "attr.secrets.items." + ID + ".value",
        "attr.credentials.secrets.cred_" + "a" * 32,
    ):
        assert is_private_pkm_export_scope(refused)
    request = dict(
        operation_id="a" * 32,
        secret_id=ID,
        recipient_app_id="app",
        source_content_revision=1,
        source_manifest_revision=1,
    )
    assert OwnerItemRequest(**request).branch == "items"
    with pytest.raises(ValueError):
        OwnerItemRequest(**{**request, "recipient_kind": "owner_pod", "pod_id": "pod"})
    assert not is_external_requestable_pkm_scope("attr.credentials.*")
    assert not is_public_pkm_projection_allowed("credentials")
    assert is_private_pkm_manifest_path(domain="credentials", path="summary")


@pytest.mark.parametrize("sidecar", ["summary_projection", "structure_decision", "path"])
def test_canonical_secrets_sidecars_reject_private_values_and_legacy_writes(sidecar):
    from api.routes.pkm_routes_shared import _enforce_secrets_write_policy
    from hushh_mcp.services.secrets_domain_validation import validate_secrets_write_sidecars

    summary = {
        "domain_intent": "secrets",
        "item_count": 1,
        "consumer_visible": False,
        "storage_mode": "encrypted_domain",
    }
    validate_secrets_write_sidecars(summary)
    manifest = {"summary_projection": {}}
    if sidecar == "summary_projection":
        manifest["summary_projection"] = {"readable_summary": "SYNTHETIC_PRIVATE_CANARY"}
    elif sidecar == "structure_decision":
        manifest["structure_decision"] = {
            "summary_projection": {"highlights": ["SYNTHETIC_PRIVATE_CANARY"]}
        }
    else:
        manifest["paths"] = [
            {
                "json_path": "items",
                "path_type": "object",
                "exposure_eligibility": False,
                "consent_label": "SYNTHETIC_PRIVATE_CANARY",
            }
        ]
    with pytest.raises(ValueError):
        validate_secrets_write_sidecars(summary, manifest=manifest)
    with pytest.raises(HTTPException) as error:
        _enforce_secrets_write_policy(SimpleNamespace(summary=summary), "credentials")
    assert error.value.detail == {"code": "LEGACY_CREDENTIALS_READ_ONLY"}


async def test_retired_credentials_direct_writer_refuses_without_touching_store():
    from hushh_mcp.services.personal_knowledge_model_service import PersonalKnowledgeModelService

    service = object.__new__(PersonalKnowledgeModelService)
    result = await service.store_domain_data("owner", "credentials", {}, {}, return_result=True)
    assert result["success"] is False and result["code"] == "LEGACY_CREDENTIALS_READ_ONLY"


async def test_worker_recipient_survives_human_delay_but_expired_lease_and_epoch_never_unwrap(
    monkeypatch,
):
    from hushh_mcp.services.pod_browser import credential_transient as module

    now = [int(time.time())]
    monkeypatch.setattr(module.time, "time", lambda: now[0])
    bound, request, keys, public, aad = lease_fixture()
    try:
        now[0] += 120  # owner unlocking/choosing is not an extra model turn
        assert keys.prepare(request) == public
        aad["expiresAt"] = now[0] + 30
        envelope = sealed.seal(
            {"username": "synthetic-user", "password": "synthetic-password"},
            purpose=PURPOSE,
            pod_public_key_raw=sealed.b64url_decode(public["public_key"], length=32),
            aad=aad,
        )

        async def check():
            pass

        async with open_worker_lease(keys, bound, request, envelope, check=check) as lease:
            assert lease.password == b"synthetic-password"
        assert not any(lease.password)
        public = keys.prepare(request)
        aad.update(leaseKeyId=public["id"], expiresAt=now[0] - 1, nonce=str(uuid4()))
        envelope = sealed.seal(
            {"username": "synthetic-user", "password": "synthetic-password"},
            purpose=PURPOSE,
            pod_public_key_raw=sealed.b64url_decode(public["public_key"], length=32),
            aad=aad,
        )
        monkeypatch.setattr(
            sealed,
            "open_envelope",
            lambda *a, **k: pytest.fail("expired or retired lease must not decrypt"),
        )
        with pytest.raises(BrowserRefused):
            async with open_worker_lease(keys, bound, request, envelope, check=check):
                pass
        aad["expiresAt"] = now[0] + 30
        envelope["aad"] = aad
        keys.retire_epoch(request.control_epoch + 1)
        with pytest.raises(BrowserRefused):
            async with open_worker_lease(keys, bound, request, envelope, check=check):
                pass
    finally:
        keys.clear()
