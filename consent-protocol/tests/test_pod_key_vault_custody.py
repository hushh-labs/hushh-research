"""The pod's log key under the person's Key Vault: minted once, never forked.

A second DEK would seal a second history and present it as the same agent, so
every path here is about when the pod may mint (only on proven absence), when it
must adopt (a lost create race), and when it must refuse (anything else).
"""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services import byoc_key_custody, pod_workload_identity
from hushh_mcp.services.byoc_key_custody import ByocKeyCustodyError, resolve_pod_log_key
from hushh_mcp.services.pod_azure_blob_store import AzureBlobObjectStore, PodBlobStorageForbidden
from hushh_mcp.services.pod_key_vault_custody import (
    PodKeyVaultCustodyError,
    parse_key_vault_key,
    resolve_key_vault_log_key,
)
from hushh_mcp.services.pod_object_version import ABSENT
from tests.pod_azure_fakes import (
    CONTAINER_URL,
    VAULT_KEY_ID,
    FakeBlobService,
    FakeKeyVault,
    FakeManagedIdentity,
    RoutingSession,
    _error,
    azure_workload_env,
)

WRAPPED = f"{CONTAINER_URL}/keys/log-key.wrapped"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_KEY_VAULT_KEY", VAULT_KEY_ID)
    monkeypatch.setenv("POD_STORAGE_AZURE_BLOB_URL", CONTAINER_URL)
    monkeypatch.delenv("HUSSH_POD_KMS_KEY", raising=False)
    monkeypatch.delenv("HUSSH_POD_WRAPPED_LOG_KEY_OBJECT", raising=False)
    monkeypatch.setattr(pod_workload_identity, "_cache", {})


def _tokens(resource: str) -> str:
    assert resource in ("https://vault.azure.net", "https://storage.azure.com")
    return "synthetic-bearer"


def _store(blob: FakeBlobService) -> AzureBlobObjectStore:
    return AzureBlobObjectStore(
        CONTAINER_URL, session=blob, token_provider=_tokens, forget_token=lambda _r: None
    )


def _resolve(blob: FakeBlobService, vault: FakeKeyVault) -> bytes:
    return resolve_key_vault_log_key(store=_store(blob), session=vault, token_provider=_tokens)


def test_first_boot_mints_wraps_locally_proves_and_stores_once():
    blob, vault = FakeBlobService(), FakeKeyVault()
    dek = _resolve(blob, vault)
    assert len(dek) == 32
    envelope = json.loads(blob.blobs[WRAPPED][0])
    assert envelope["alg"] == "RSA-OAEP-256" and envelope["kid"] == VAULT_KEY_ID
    assert dek not in blob.blobs[WRAPPED][0]
    # Public key read, one proving unwrap; the wrap itself never left the pod.
    assert vault.calls == ["get", "unwrap"]
    puts = [headers for method, _url, headers in blob.requests if method == "put"]
    assert len(puts) == 1 and puts[0]["If-None-Match"] == "*"
    # A later boot unwraps the same key and mints nothing.
    assert _resolve(blob, vault) == dek
    assert vault.calls == ["get", "unwrap", "unwrap"]


def test_a_lost_first_boot_race_adopts_the_winners_key():
    vault, other = FakeKeyVault(), FakeBlobService()
    winner = _resolve(other, vault)  # the boot that wins the race
    stored = other.blobs[WRAPPED][0]

    class Racing(FakeBlobService):
        def put(self, url, **kwargs):
            self.blobs.setdefault(url, (stored, '"0x1"'))  # the other boot landed first
            return super().put(url, **kwargs)

    racing = Racing()
    assert _resolve(racing, vault) == winner
    assert racing.blobs[WRAPPED][0] == stored


@pytest.mark.parametrize("status,code", [(403, "AuthorizationPermissionMismatch"), (500, "")])
def test_a_refused_or_failed_read_never_mints(status, code):
    blob, vault = FakeBlobService(), FakeKeyVault()
    blob.scripted += [("get", _error(status, code)), ("get", _error(status, code))]
    with pytest.raises((PodBlobStorageForbidden, RuntimeError)):
        _resolve(blob, vault)
    assert vault.calls == [] and not blob.blobs
    assert all(method == "get" for method, _url, _headers in blob.requests)


def test_a_refused_unwrap_refuses_rather_than_replacing_the_key():
    blob, vault = FakeBlobService(), FakeKeyVault()
    _resolve(blob, vault)
    stored = blob.blobs[WRAPPED]
    vault.refuse["unwrap"] = 403
    with pytest.raises(ByocKeyCustodyError, match="403"):
        _resolve(blob, vault)
    assert blob.blobs[WRAPPED] == stored


def test_a_key_the_pod_cannot_unwrap_is_never_stored():
    blob, vault = FakeBlobService(), FakeKeyVault()
    vault.refuse["unwrap"] = 403
    with pytest.raises(PodKeyVaultCustodyError):
        _resolve(blob, vault)
    assert not blob.blobs


def test_a_key_wrapped_to_another_key_version_is_refused():
    blob, vault = FakeBlobService(), FakeKeyVault()
    _resolve(blob, vault)
    data, etag = blob.blobs[WRAPPED]
    envelope = json.loads(data)
    envelope["kid"] = VAULT_KEY_ID[:-32] + "b" * 32
    blob.blobs[WRAPPED] = (json.dumps(envelope).encode(), etag)
    with pytest.raises(PodKeyVaultCustodyError, match="different key version"):
        _resolve(blob, vault)


def test_the_key_id_must_be_a_versioned_vault_key():
    assert parse_key_vault_key(VAULT_KEY_ID).resource == "https://vault.azure.net"
    gov = "https://pod-vault.vault.usgovcloudapi.net/keys/log-key/" + "c" * 32
    assert parse_key_vault_key(gov).resource == "https://vault.usgovcloudapi.net"
    for bad in (
        "https://pod-vault.vault.azure.net/keys/log-key",
        "https://pod-vault.vault.azure.net/secrets/log-key/" + "a" * 32,
        "https://evil.example.com/keys/log-key/" + "a" * 32,
        "http://pod-vault.vault.azure.net/keys/log-key/" + "a" * 32,
    ):
        with pytest.raises(PodKeyVaultCustodyError):
            parse_key_vault_key(bad)


def test_the_tier_agnostic_resolver_routes_through_identity_blob_and_vault(monkeypatch):
    azure_workload_env(monkeypatch)
    identity, blob, vault = FakeManagedIdentity(), FakeBlobService(), FakeKeyVault()
    session = RoutingSession(blob=blob, vault=vault, identity=identity)
    assert byoc_key_custody.byoc_custody_configured()
    dek = resolve_pod_log_key(session=session)
    assert resolve_pod_log_key(session=session) == dek
    resources = sorted({call["params"]["resource"] for call in identity.calls})
    assert resources == ["https://storage.azure.com", "https://vault.azure.net"]
    assert len(identity.calls) == 2  # each token cached for its lifetime
    memory = byoc_key_custody.resolve_pod_memory_key(session=session)
    assert memory == byoc_key_custody.derive_memory_key(dek)


def test_a_pod_has_exactly_one_custodian(monkeypatch):
    monkeypatch.setenv("HUSSH_POD_KMS_KEY", "projects/p/locations/l/keyRings/r/cryptoKeys/k")
    with pytest.raises(ByocKeyCustodyError, match="exactly one custodian"):
        resolve_pod_log_key(session=RoutingSession())


def test_key_vault_custody_needs_the_rendered_blob_url(monkeypatch):
    monkeypatch.delenv("POD_STORAGE_AZURE_BLOB_URL")
    with pytest.raises(PodKeyVaultCustodyError, match="POD_STORAGE_AZURE_BLOB_URL"):
        resolve_key_vault_log_key(session=FakeKeyVault(), token_provider=_tokens)


def test_the_absent_version_is_the_only_one_that_creates():
    assert ABSENT == ""
