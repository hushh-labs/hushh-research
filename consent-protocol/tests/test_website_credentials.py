"""Synthetic records only: per-record cryptography, exact scope and live fences."""

import json
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException

from api.routes.pkm_routes_shared import (
    DomainManifestPayload,
    StructureDecisionPayload,
    _enforce_secrets_write_policy,
)
from hushh_mcp.consent.pkm_scope_policy import (
    is_external_requestable_pkm_scope,
    is_owner_item_grant_scope,
    is_private_pkm_export_scope,
)
from hushh_mcp.services import pod_sealed_envelope as sealed
from hushh_mcp.services.credentials_domain_validation import (
    validate_credentials_summary_envelope,
    validate_credentials_write_sidecars,
)
from hushh_mcp.services.pod_browser.contracts import BrowserBinding
from hushh_mcp.services.pod_browser.information import InformationField
from hushh_mcp.services.pod_browser.information_export import BrowserExportSelection
from hushh_mcp.services.pod_session_authority import canonical_json
from hushh_mcp.services.website_credentials import (
    CredentialAad,
    CredentialProjectionStore,
    CredentialRecord,
    CredentialRefused,
    WebsiteCredentialProjection,
    _key_purpose,
    browser_credential_source,
    open_credential_record,
)

ID = "cred_" + "a" * 32
CANARY = "SYNTHETIC_WEBSITE_PASSWORD_123"


def record(*, identifier=ID, generation=1, policy="autonomous", recipient=None):
    key = recipient or X25519PrivateKey.generate()
    aad = CredentialAad(
        purpose="website_credential_payload",
        ownerId="owner",
        credentialId=identifier,
        revision=generation,
        generation=generation,
        policyGeneration=generation,
        custodyGeneration=generation,
        autonomyPolicy=policy,
        boundOrigins=["https://example.com"],
    )
    dek = bytes([generation]) * 32
    iv = bytes(range(12))
    payload = {
        "iv": sealed.b64url_encode(iv),
        "ct": sealed.b64url_encode(
            AESGCM(dek).encrypt(
                iv,
                canonical_json({"username": "synthetic-owner", "password": CANARY}).encode(),
                canonical_json(aad.model_dump()).encode(),
            )
        ),
    }
    owner_wrap = {
        "iv": sealed.b64url_encode(iv),
        "ct": sealed.b64url_encode(
            AESGCM(b"\x03" * 32).encrypt(
                iv,
                dek,
                canonical_json(
                    {**aad.model_dump(), "purpose": "website_credential_owner_wrap"}
                ).encode(),
            )
        ),
    }
    pod = (
        None
        if policy == "vault_only"
        else sealed.seal(
            {"dataKey": sealed.b64url_encode(dek)},
            purpose=_key_purpose(),
            pod_public_key_raw=sealed.raw_public(key.public_key()),
            aad={**aad.model_dump(), "hushhId": "pod", "podKeyId": "key"},
        )
    )
    return CredentialRecord(
        schemaVersion=1, aad=aad, payload=payload, ownerWrap=owner_wrap, podWrap=pod
    ), key


def projection(value):
    return WebsiteCredentialProjection(
        record=value,
        selection=BrowserExportSelection(
            owner_id="owner",
            pod_id="pod",
            pod_key_id="key",
            field=InformationField(
                domain="credentials",
                path=f"secrets.{value.aad.credentialId}",
                export_revision=1,
                source_content_revision=1,
                source_manifest_revision=2,
                grant_ref="grant",
            ),
        ),
    )


class Log:
    def __init__(self):
        self.records = []

    async def replay(self):
        return list(self.records)

    async def append(self, kind, payload, expected_seq):
        assert expected_seq == len(self.records)
        self.records.append({"seq": expected_seq + 1, "kind": kind, "payload": payload})


@pytest.mark.parametrize("branch", ["summary", "secrets"])
def test_exact_owner_item_authority_stays_nonrequestable(branch):
    scope = f"attr.credentials.{branch}.{ID}"
    assert is_owner_item_grant_scope(scope)
    assert not is_external_requestable_pkm_scope(scope)
    assert not is_private_pkm_export_scope(scope)
    for bad in [
        f"attr.credentials.{branch}.*",
        f"{scope}.password",
        "attr.credentials.*",
        scope.replace(ID, "cred_bad"),
    ]:
        assert not is_owner_item_grant_scope(bad)
        assert not is_external_requestable_pkm_scope(bad)
        assert is_private_pkm_export_scope(bad)


@pytest.mark.parametrize(
    "leak",
    [
        {"label": "Secret"},
        {"boundOrigins": ["https://example.com"]},
        {"usernameHint": "owner"},
        {"password": CANARY},
        {"unknown": 1},
        {"schema_version": True},
    ],
)
def test_plaintext_sidecar_rejects_metadata_and_secrets(leak):
    summary = {
        "domain_intent": "credentials",
        "schema_version": 1,
        "consumer_visible": False,
        "storage_mode": "encrypted_domain",
        "item_count": 1,
    }
    validate_credentials_summary_envelope(summary)
    with pytest.raises(ValueError):
        validate_credentials_summary_envelope({**summary, **leak})


@pytest.mark.parametrize("sidecar", ["manifest", "structure_decision"])
@pytest.mark.parametrize(
    "private_projection", [{"readable_summary": CANARY}, {"readable_highlights": [CANARY]}]
)
def test_credentials_api_sidecars_refuse_private_manifest_and_decision_projections(
    sidecar, private_projection
):
    summary = {
        "domain_intent": "credentials",
        "schema_version": 1,
        "consumer_visible": False,
        "storage_mode": "encrypted_domain",
        "item_count": 1,
    }
    request = SimpleNamespace(
        summary=summary,
        manifest=DomainManifestPayload(summary_projection=summary),
        structure_decision=StructureDecisionPayload(summary_projection=summary),
    )
    _enforce_secrets_write_policy(request, "credentials")
    getattr(request, sidecar).summary_projection = {**summary, **private_projection}

    with pytest.raises(HTTPException) as refused:
        _enforce_secrets_write_policy(request, "credentials")
    assert refused.value.status_code == 422
    assert refused.value.detail["code"] == "CREDENTIALS_SUMMARY_ENVELOPE_INVALID"
    assert CANARY not in str(refused.value.detail)


@pytest.mark.parametrize("nested_sidecar", ["scope_registry", "structure_decision"])
def test_credentials_nested_projections_use_the_same_bookkeeping_contract(nested_sidecar):
    summary = {
        "domain_intent": "credentials",
        "schema_version": 1,
        "consumer_visible": False,
        "storage_mode": "encrypted_domain",
        "item_count": 1,
    }
    scope_projection = {
        "top_level_scope_path": "secrets",
        "consumer_visible": False,
        "internal_only": False,
        "storage_mode": "encrypted_domain",
    }
    manifest = {
        "summary_projection": summary,
        "structure_decision": {"summary_projection": summary},
        "scope_registry": [{"summary_projection": scope_projection}],
    }
    validate_credentials_write_sidecars(summary, manifest=manifest)
    if nested_sidecar == "scope_registry":
        projection = manifest["scope_registry"][0]["summary_projection"]
    else:
        projection = manifest["structure_decision"]["summary_projection"] = dict(summary)
    projection["readable_summary"] = CANARY
    with pytest.raises(ValueError, match="credentials_summary_invalid"):
        validate_credentials_write_sidecars(summary, manifest=manifest)


@pytest.mark.parametrize(
    ("location", "field", "private_value"),
    [
        ("path", "consent_label", CANARY),
        ("path", "display_segment", CANARY),
        ("path", "json_path", CANARY),
        ("path", "source_agent", CANARY),
        ("path", "scope_handle", CANARY),
        ("path", "path_type", "leaf"),
        ("path", "exposure_eligibility", True),
        ("manifest", "source_agent", CANARY),
        ("manifest", "top_level_scope_paths", [CANARY]),
        ("manifest", "externalizable_paths", ["summary"]),
        ("decision", "json_paths", [CANARY]),
        ("decision", "sensitivity_labels", {"summary": CANARY}),
        ("decision", "sensitivity_labels", {CANARY: "restricted"}),
    ],
)
def test_credentials_api_metadata_is_fixed_not_private_text(location, field, private_value):
    summary = {
        "domain_intent": "credentials",
        "schema_version": 1,
        "consumer_visible": False,
        "storage_mode": "encrypted_domain",
        "item_count": 1,
    }
    manifest = DomainManifestPayload(
        summary_projection=summary,
        top_level_scope_paths=["summary", "secrets"],
        paths=[
            {
                "json_path": branch,
                "path_type": "object",
                "exposure_eligibility": False,
                "consent_label": f"Website login {branch}",
                "sensitivity_label": "restricted",
                "segment_id": branch,
                "scope_handle": "s_012345abcdef",
                "source_agent": "credentials_vault",
            }
            for branch in ("summary", "secrets")
        ],
    )
    decision = StructureDecisionPayload(
        action="extend_domain",
        target_domain="credentials",
        json_paths=["summary", "secrets"],
        top_level_scope_paths=["summary", "secrets"],
        summary_projection=summary,
        sensitivity_labels={"summary": "restricted", "secrets": "restricted"},
        source_agent="credentials_vault",
    )
    request = SimpleNamespace(summary=summary, manifest=manifest, structure_decision=decision)
    _enforce_secrets_write_policy(request, "credentials")
    target = {"path": manifest.paths[0], "manifest": manifest, "decision": decision}[location]
    setattr(target, field, private_value)
    with pytest.raises(HTTPException) as refused:
        _enforce_secrets_write_policy(request, "credentials")
    assert refused.value.status_code == 422
    assert refused.value.detail["code"] == "CREDENTIALS_SUMMARY_ENVELOPE_INVALID"
    assert CANARY not in str(refused.value.detail)
    # The generic PKM write contract is unaffected by this reserved-domain guard.
    _enforce_secrets_write_policy(request, "travel")


def test_per_record_dek_and_recipient_and_aad_are_cryptographic_boundaries():
    value, key = record()
    assert (
        open_credential_record(value, key, owner_id="owner", pod_id="pod", pod_key_id="key")[
            "password"
        ]
        == CANARY
    )
    assert CANARY not in value.model_dump_json()
    for wrong in [X25519PrivateKey.generate()]:
        with pytest.raises(CredentialRefused):
            open_credential_record(value, wrong, owner_id="owner", pod_id="pod", pod_key_id="key")
    sibling, _ = record(identifier="cred_" + "b" * 32, generation=2, recipient=key)
    # A sibling's key never decrypts this payload, even on the same admitted pod.
    with pytest.raises(CredentialRefused):
        open_credential_record(
            value.model_copy(update={"podWrap": sibling.podWrap}),
            key,
            owner_id="owner",
            pod_id="pod",
            pod_key_id="key",
        )
    vault, _ = record(policy="vault_only")
    assert vault.podWrap is None
    with pytest.raises(CredentialRefused):
        open_credential_record(vault, key, owner_id="owner", pod_id="pod", pod_key_id="key")
    with pytest.raises(ValueError):
        CredentialRecord.model_validate(
            {**vault.model_dump(), "podWrap": value.podWrap.model_dump()}
        )


@pytest.mark.asyncio
async def test_live_authority_revocation_and_tombstones_survive_replay():
    log = Log()
    allowed = True
    checks = 0

    async def check(value):
        nonlocal checks
        checks += 1
        if not allowed:
            raise CredentialRefused("CREDENTIAL_SESSION_ONLY")

    store = CredentialProjectionStore(
        log, owner_id="owner", pod_id="pod", pod_key_id="key", check=check
    )
    value, key = record()
    await store.publish(projection(value))
    source = browser_credential_source(store=store, private_key=key)
    binding = BrowserBinding(
        owner_id="owner",
        pod_id="pod",
        incarnation="incarnation",
        task_id="task",
        environment="development",
        expires_at=4102444800,
    )
    (descriptor,) = await source.catalog(binding, "https://example.com")
    async with source.open(binding, descriptor) as lease:
        assert bytes(lease.password).decode() == CANARY
        allowed = False
        with pytest.raises(CredentialRefused):
            await lease.recheck()
    assert not any(lease.password)
    assert not await source.catalog(binding, "https://example.com")
    allowed = True
    await store.revoke(ID, 1)
    with pytest.raises(CredentialRefused):
        await store.get_current(ID)
    with pytest.raises(CredentialRefused):
        await store.publish(projection(value))
    # Replayed old records cannot revive an equal-generation revoked projection.
    log.records.append({**log.records[0], "seq": len(log.records) + 1})
    with pytest.raises(CredentialRefused):
        await store.get_current(ID)
    latest, _ = record(generation=2, recipient=key)
    await store.publish(projection(latest))
    with pytest.raises(CredentialRefused):
        async with source.open(binding, descriptor):
            pass
    assert checks >= 5
    assert CANARY not in json.dumps(log.records)


@pytest.mark.asyncio
async def test_refresh_preserves_grant_and_cannot_cross_a_revocation():
    async def check(value):
        return None

    log = Log()
    store = CredentialProjectionStore(
        log, owner_id="owner", pod_id="pod", pod_key_id="key", check=check
    )
    value, _ = record()
    first = projection(value)
    await store.publish(first)
    refreshed_field = first.selection.field.model_copy(
        update={"export_revision": 2, "source_content_revision": 2, "source_manifest_revision": 3}
    )
    refreshed = first.model_copy(
        update={"selection": first.selection.model_copy(update={"field": refreshed_field})}
    )
    await store.publish(refreshed)
    assert await store.get_current(ID) == refreshed
    with pytest.raises(CredentialRefused):
        await store.publish(first)
    other_grant = refreshed.model_copy(
        update={
            "selection": refreshed.selection.model_copy(
                update={
                    "field": refreshed_field.model_copy(
                        update={"grant_ref": "different", "export_revision": 3}
                    )
                }
            )
        }
    )
    with pytest.raises(CredentialRefused):
        await store.publish(other_grant)
    await store.revoke(ID, 1)
    with pytest.raises(CredentialRefused):
        await store.publish(refreshed)


@pytest.mark.asyncio
async def test_vault_only_transient_rechecks_current_record_and_fence():
    value, key = record(policy="vault_only")

    async def check(value):
        return None

    store = CredentialProjectionStore(
        Log(), owner_id="owner", pod_id="pod", pod_key_id="key", check=check
    )

    async def load(selection):
        return value

    store.load_current = load
    source = browser_credential_source(store=store, private_key=key)
    binding = BrowserBinding(
        owner_id="owner",
        pod_id="pod",
        incarnation="incarnation",
        task_id="task",
        environment="development",
        expires_at=4102444800,
    )
    selected = BrowserExportSelection(
        owner_id="owner",
        pod_id="pod",
        pod_key_id="key",
        field=InformationField(
            domain="credentials",
            path=f"secrets.{ID}",
            export_revision=1,
            source_content_revision=1,
            source_manifest_revision=2,
            grant_ref="grant",
        ),
    )
    aad = {
        "ownerId": "owner",
        "hushhId": "pod",
        "podKeyId": "key",
        "credentialId": ID,
        "recordRevision": 1,
        "policyGeneration": 1,
        "custodyGeneration": 1,
        "origin": "https://example.com",
    }
    await source.validate_transient(binding, aad, selected)
    for changes in [
        {"recordRevision": 2},
        {"origin": "https://other.example.com"},
        {"podKeyId": "other"},
        {"ownerId": "other"},
    ]:
        with pytest.raises(CredentialRefused):
            await source.validate_transient(binding, {**aad, **changes}, selected)
    await store.revoke(ID, 1)
    with pytest.raises(CredentialRefused):
        await source.validate_transient(binding, aad, selected)


def test_owner_route_rejects_before_body_parse_and_never_echoes_invalid_input(monkeypatch):
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient

    from api.routes.one import pod_website_credentials as route

    app = FastAPI()
    app.include_router(route.router)

    async def denied(_):
        raise HTTPException(401, detail={"code": "OWNER_REQUIRED"})

    monkeypatch.setattr(route, "_admit", denied)
    client = TestClient(app)
    response = client.post("/api/one/pod/credentials", content=CANARY)
    assert response.status_code == 401
    assert CANARY not in response.text

    async def held():
        return None

    async def admitted(_):
        return object(), held

    monkeypatch.setattr(route, "_admit", admitted)
    response = client.post("/api/one/pod/credentials", json={"password": CANARY})
    assert response.status_code == 422
    assert CANARY not in response.text


@pytest.mark.asyncio
async def test_production_authority_refreshes_only_current_record_and_honors_session_only(
    monkeypatch,
):
    from types import SimpleNamespace

    from hushh_mcp.services import pod_hub_client, pod_self_registration
    from hushh_mcp.services.pod_browser import information
    from hushh_mcp.services.pod_config import POD_CONFIG_RECORD_KIND
    from hushh_mcp.services.website_credentials import production_credential_store

    value, _ = record()
    first = projection(value)
    latest = first.selection
    reads = []

    class Response:
        status_code = 200
        content = b"{}"

        def json(self):
            return latest.model_dump(mode="json")

        def close(self):
            pass

    class Client:
        def post(self, path, **kwargs):
            assert path == "/api/one/pod/browser-approval/export/current"
            reads.append(path)
            return Response()

    monkeypatch.setattr(pod_hub_client, "PodHubClient", lambda **kwargs: Client())
    monkeypatch.setattr(pod_self_registration, "pod_keypair", lambda: SimpleNamespace(key_id="key"))
    monkeypatch.setattr(pod_self_registration, "pod_key_is_durable", lambda: True)

    async def current_record(self, binding, field):
        assert field == latest.field
        return {"secrets": {ID: value.model_dump()}}

    monkeypatch.setattr(information.ScopedProjectionReader, "read", current_record)

    async def held():
        return None

    log = Log()
    store = production_credential_store(
        log=log,
        owner_id="owner",
        pod_id="pod",
        pod_key_id="key",
        environment="development",
        incarnation="incarnation",
        check=held,
    )
    await store.publish(first)
    latest = first.selection.model_copy(
        update={
            "field": first.selection.field.model_copy(
                update={
                    "export_revision": 2,
                    "source_content_revision": 2,
                    "source_manifest_revision": 3,
                }
            )
        }
    )
    assert (await store.get_current(ID)).selection == latest
    before = len(reads)
    await log.append(
        POD_CONFIG_RECORD_KIND,
        {"hushh_id": "pod", "config": {"session_only_lockdown": True}},
        expected_seq=len(log.records),
    )
    with pytest.raises(CredentialRefused, match="CREDENTIAL_SESSION_ONLY"):
        await store.get_current(ID)
    assert len(reads) == before


@pytest.mark.asyncio
async def test_stale_export_is_refresh_metadata_only_until_current_source_is_published(monkeypatch):
    import base64
    import time
    from types import SimpleNamespace

    from db import connection
    from hushh_mcp.consent import paid_admission
    from hushh_mcp.consent import token as token_module
    from hushh_mcp.consent.export_envelope import (
        ConsentExportAadV2,
        canonical_aad_bytes,
        digest_bytes,
    )
    from hushh_mcp.services import consent_commerce_ports, owner_item_grants
    from hushh_mcp.services.consent_db import ConsentDBService
    from hushh_mcp.services.consent_export_refresh_eligibility import (
        continuous_refresh_tokens_for_domain_write,
    )

    scope = f"attr.credentials.secrets.{ID}"
    expiry = int(time.time() * 1000) + 3600000
    binding = {"source_content_revision": 1, "source_manifest_revision": 2, "duration_hours": 1}
    metadata = {
        "developer_app_id": "agent_one",
        "recipient_agent_id": "agent_one",
        "connector_key_id": "key",
        "recipient_key_fingerprint": "sha256:" + "a" * 64,
        "scope_handle": "s_credential_item",
        "owner_item_grant": binding,
    }
    aad = ConsentExportAadV2(
        app_id="agent_one",
        grant_id="grant",
        export_id="a" * 32,
        revision=1,
        machine_scope=scope,
        scope_handle="s_credential_item",
        recipient_key_fingerprint=metadata["recipient_key_fingerprint"],
        expires_at_ms=expiry,
    )
    ciphertext = b"SYNTHETIC_ENCRYPTED_CREDENTIAL"
    row = {
        "consent_token": "synthetic_token",
        "user_id": "owner",
        "scope": scope,
        "app_id": "agent_one",
        "grant_id": "grant",
        "is_strict_zero_knowledge": True,
        "envelope_version": 2,
        "connector_key_id": "key",
        "recipient_key_fingerprint": metadata["recipient_key_fingerprint"],
        "export_id": "a" * 32,
        "envelope_aad": aad.model_dump(),
        "envelope_aad_sha256": digest_bytes(canonical_aad_bytes(aad)),
        "encrypted_data": base64.b64encode(ciphertext).decode(),
        "ciphertext_sha256": digest_bytes(ciphertext),
        "ciphertext_bytes": len(ciphertext),
        "export_revision": 1,
        "source_content_revision": 1,
        "source_manifest_revision": 2,
        "refresh_policy": "continuous_until_expiry",
        "scope_handle": "s_credential_item",
    }
    stale = True
    recipient_checks = []
    source_checks = []

    def bound(meta, owner, selected):
        if meta.get("owner_item_grant") != binding or owner != "owner" or selected != scope:
            raise ValueError()
        return binding

    async def require(conn, owner, selected, meta, *, verify_source=True):
        assert verify_source is False
        bound(meta, owner, selected)
        recipient_checks.append(True)

    async def source(conn, owner, selected, revisions):
        source_checks.append(revisions)
        if stale:
            raise ValueError("source_stale")

    monkeypatch.setattr(owner_item_grants, "owner_item_binding", bound)
    monkeypatch.setattr(owner_item_grants, "require_owner_item_binding", require)
    monkeypatch.setattr(paid_admission, "verify_source_revisions", source)

    class Context:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        def transaction(self):
            return self

        def acquire(self):
            return self

    async def pool():
        return Context()

    monkeypatch.setattr(connection, "get_pool", pool)

    async def validate(*args, **kwargs):
        return (
            True,
            None,
            SimpleNamespace(
                user_id="owner", agent_id="agent_one", scope_str=scope, expires_at=expiry
            ),
        )

    monkeypatch.setattr(token_module, "validate_token_with_db", validate)

    async def grant(*args):
        return {"user_id": "owner", "metadata": metadata}

    monkeypatch.setattr(consent_commerce_ports, "token_grant", grant)

    class Query:
        def table(self, *args):
            return self

        def select(self, *args):
            return self

        def eq(self, *args):
            return self

        def gt(self, *args):
            return self

        def limit(self, *args):
            return self

        def execute(self):
            return SimpleNamespace(data=[row])

    service = object.__new__(ConsentDBService)
    service._get_db = lambda: Query()
    service._normalize_export_row = lambda value: dict(value)
    service._parse_metadata = lambda value: value
    assert await service.get_consent_export("synthetic_token") is None
    bounded = await service.get_consent_export_metadata("synthetic_token")
    assert bounded and bounded["export_revision"] == 1
    assert "encrypted_data" not in bounded and "consent_token" not in bounded

    async def candidates(*args):
        return [{"scope": scope, "token_id": "synthetic_token"}]

    service.get_continuous_refresh_candidates_for_domain = candidates
    monkeypatch.setattr("hushh_mcp.services.consent_db.ConsentDBService", lambda: service)
    manifest = SimpleNamespace(
        top_level_scope_paths=["summary", "secrets"], externalizable_paths=[]
    )
    assert await continuous_refresh_tokens_for_domain_write(
        user_id="owner", domain="credentials", manifest=manifest
    ) == ["synthetic_token"]
    # Once the same-grant refresh is current, ordinary ciphertext reads resume.
    stale = False
    assert await service.get_consent_export("synthetic_token") is not None
    assert recipient_checks and source_checks
    metadata.pop("owner_item_grant")
    assert await service.get_consent_export_metadata("synthetic_token") is None


def test_production_typescript_vector_opens_only_at_its_bound_pod():
    import base64
    from pathlib import Path

    vector = json.loads(
        (Path(__file__).parent / "fixtures" / "website_credential_vector_v1.json").read_text()
    )
    value = CredentialRecord.model_validate(vector["record"])
    # This published vector carries a trivial synthetic key, never pod authority.
    private_raw = base64.b64decode(vector["podPrivateKeyRaw"])
    assert private_raw == bytes([7]) * 32
    assert "PUBLIC SYNTHETIC TEST VECTOR, NEVER DEPLOYABLE" in vector["description"]
    key = X25519PrivateKey.from_private_bytes(private_raw)
    assert (
        open_credential_record(value, key, owner_id="owner", pod_id="pod", pod_key_id="key")
        == vector["expectedPayload"]
    )
    with pytest.raises(CredentialRefused):
        open_credential_record(value, key, owner_id="owner", pod_id="other-pod", pod_key_id="key")
