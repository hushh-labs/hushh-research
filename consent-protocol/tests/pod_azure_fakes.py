"""In-memory fakes of the HTTP surfaces a pod uses off Google Cloud, and of GCS.

Each fake answers exactly as the MEASURED platform does (byoc-azure.md,
2026-10-02), so a store that passes against it is tested against the real
status mapping rather than a guess:

* Blob: create-only on an existing blob -> 409 BlobAlreadyExists; If-Match
  mismatch -> 412 ConditionNotMet; absent -> 404 BlobNotFound; no ETag reuse.
* Key Vault: GET key returns the RSA public JWK; ``unwrapkey`` opens RSA-OAEP-256.
* Managed identity: ``IDENTITY_ENDPOINT`` answers with ``expires_on`` epoch seconds.
* GCS: ``ifGenerationMatch`` mismatch -> 412; media reads state ``x-goog-generation``.
"""

from __future__ import annotations

import base64
import json
import time
import urllib.parse
from typing import Any

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ACCOUNT_URL = "https://podacct.blob.core.windows.net"
CONTAINER_URL = f"{ACCOUNT_URL}/agent/pods/ha1"
VAULT_KEY_ID = "https://pod-vault.vault.azure.net/keys/log-key/" + "a" * 32
CLIENT_ID = "11111111-2222-3333-4444-555555555555"
IDENTITY_ENDPOINT = "http://localhost:12356/msi/token"


class FakeResponse:
    def __init__(self, status: int, *, body: Any = None, content: bytes = b"", headers=None):
        self.status_code = status
        self._body = body
        self.content = content
        self.headers = dict(headers or {})
        self.text = content.decode("utf-8", "replace")

    def json(self) -> Any:
        if self._body is None:
            raise ValueError("no json body")
        return self._body


def _error(status: int, code: str) -> FakeResponse:
    xml = f"<?xml version='1.0'?><Error><Code>{code}</Code><Message>m</Message></Error>"
    return FakeResponse(status, content=xml.encode(), headers={"x-ms-error-code": code})


class FakeBlobService:
    """One storage account. ``scripted`` answers the next matching calls first."""

    def __init__(self) -> None:
        self.blobs: dict[str, tuple[bytes, str]] = {}
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        self.scripted: list[tuple[str, FakeResponse]] = []
        self._counter = 0x8DC0000000000

    def _etag(self) -> str:
        self._counter += 1
        return f'"0x{self._counter:X}"'

    def _scripted(self, method: str) -> FakeResponse | None:
        for index, (wanted, _response) in enumerate(self.scripted):
            if wanted == method:
                return self.scripted.pop(index)[1]
        return None

    def get(self, url: str, *, headers: dict[str, str], **_kwargs: Any) -> FakeResponse:
        self.requests.append(("get", url, dict(headers)))
        scripted = self._scripted("get")
        if scripted is not None:
            return scripted
        if url not in self.blobs:
            return _error(404, "BlobNotFound")
        data, etag = self.blobs[url]
        return FakeResponse(200, content=data, headers={"ETag": etag})

    def put(self, url: str, *, headers: dict[str, str], data: bytes, **_kwargs: Any):
        self.requests.append(("put", url, dict(headers)))
        scripted = self._scripted("put")
        if scripted is not None:
            return scripted
        current = self.blobs.get(url)
        if headers.get("If-None-Match") == "*" and current is not None:
            return _error(409, "BlobAlreadyExists")
        if "If-Match" in headers and (current is None or current[1] != headers["If-Match"]):
            return _error(412, "ConditionNotMet")
        etag = self._etag()
        self.blobs[url] = (bytes(data), etag)
        return FakeResponse(201, headers={"ETag": etag})


class FakeGcsService:
    """One bucket over the JSON API, plus the GCE metadata token endpoint."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, int]] = {}
        self.metadata_calls = 0
        self._generation = 1_700_000_000_000_000

    def get(self, url: str, *, params=None, **_kwargs: Any) -> FakeResponse:
        if "metadata.google.internal" in url:
            self.metadata_calls += 1
            return FakeResponse(200, body={"access_token": "gcp-token", "expires_in": 3600})
        name = urllib.parse.unquote(url.split("/o/", 1)[1])
        if name not in self.objects:
            return FakeResponse(404)
        data, generation = self.objects[name]
        return FakeResponse(200, content=data, headers={"x-goog-generation": str(generation)})

    def post(self, url: str, *, params: dict[str, str], data: bytes, **_kwargs: Any):
        name, expected = params["name"], int(params["ifGenerationMatch"])
        current = self.objects.get(name, (b"", 0))[1]
        if current != expected:
            return FakeResponse(412)
        self._generation += 1
        self.objects[name] = (bytes(data), self._generation)
        return FakeResponse(200, body={"generation": str(self._generation)})


class FakeKeyVault:
    """One RSA key. ``refuse`` maps a call ("get" or "unwrap") to a status."""

    _private = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def __init__(self, key_id: str = VAULT_KEY_ID) -> None:
        self.key_id = key_id
        self.calls: list[str] = []
        self.refuse: dict[str, int] = {}

    @staticmethod
    def _b64url(value: int | bytes) -> str:
        raw = value if isinstance(value, bytes) else value.to_bytes((value.bit_length() + 7) // 8)
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    def get(self, url: str, *, params: dict[str, str], **_kwargs: Any) -> FakeResponse:
        assert params == {"api-version": "7.4"} and url == self.key_id
        self.calls.append("get")
        if "get" in self.refuse:
            return FakeResponse(self.refuse["get"], body={"error": {"code": "Forbidden"}})
        numbers = self._private.public_key().public_numbers()
        jwk = {"kid": self.key_id, "kty": "RSA", "key_ops": ["wrapKey", "unwrapKey"]}
        jwk.update(n=self._b64url(numbers.n), e=self._b64url(numbers.e))
        return FakeResponse(200, body={"key": jwk, "attributes": {"enabled": True}})

    def post(self, url: str, *, params: dict[str, str], json: dict[str, str], **_kwargs: Any):
        assert params == {"api-version": "7.4"} and url == f"{self.key_id}/unwrapkey"
        assert json["alg"] == "RSA-OAEP-256"
        self.calls.append("unwrap")
        if "unwrap" in self.refuse:
            return FakeResponse(self.refuse["unwrap"], body={"error": {"code": "Forbidden"}})
        wrapped = base64.urlsafe_b64decode(json["value"] + "=" * (-len(json["value"]) % 4))
        oaep = padding.OAEP(
            mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None
        )
        dek = self._private.decrypt(wrapped, oaep)
        return FakeResponse(200, body={"kid": self.key_id, "value": self._b64url(dek)})


class FakeManagedIdentity:
    """The Container Apps identity endpoint, recording what it was asked for."""

    def __init__(self, lifetime_seconds: int = 86_399) -> None:
        self.calls: list[dict[str, Any]] = []
        self.lifetime_seconds = lifetime_seconds

    def get(self, url: str, *, params: dict[str, str], headers: dict[str, str], **kwargs: Any):
        self.calls.append({"url": url, "params": dict(params), "headers": dict(headers), **kwargs})
        token = f"mi-token-{len(self.calls)}-{params['resource']}"
        expires_on = str(int(time.time()) + self.lifetime_seconds)
        body = {"access_token": token, "expires_on": expires_on, "client_id": params["client_id"]}
        return FakeResponse(200, body=body)


class RoutingSession:
    """One ``requests``-shaped session routing by host, as a pod's single egress."""

    def __init__(self, *, blob=None, vault=None, identity=None) -> None:
        self.blob, self.vault, self.identity = blob, vault, identity

    def _route(self, url: str) -> Any:
        host = urllib.parse.urlsplit(url).hostname or ""
        if host == "localhost":
            return self.identity
        if host.endswith(".blob.core.windows.net"):
            return self.blob
        if host.endswith(".vault.azure.net"):
            return self.vault
        raise AssertionError(f"unexpected egress to {host}")

    def get(self, url: str, **kwargs: Any) -> Any:
        return self._route(url).get(url, **kwargs)

    def put(self, url: str, **kwargs: Any) -> Any:
        return self._route(url).put(url, **kwargs)

    def post(self, url: str, **kwargs: Any) -> Any:
        return self._route(url).post(url, **kwargs)


def azure_workload_env(monkeypatch) -> None:
    """The platform and rendered topology of a pod on Azure Container Apps."""
    monkeypatch.setenv("CONTAINER_APP_NAME", "one-pod-ha1")
    monkeypatch.setenv("CONTAINER_APP_REVISION", "one-pod-ha1--r7")
    monkeypatch.setenv("IDENTITY_ENDPOINT", IDENTITY_ENDPOINT)
    monkeypatch.setenv("IDENTITY_HEADER", "synthetic-identity-header")
    monkeypatch.setenv("AZURE_CLIENT_ID", CLIENT_ID)
    for name in ("K_SERVICE", "K_REVISION"):
        monkeypatch.delenv(name, raising=False)


def json_body(data: bytes) -> Any:
    return json.loads(data)
