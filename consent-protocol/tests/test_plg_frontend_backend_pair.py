"""Synthetic backend pair inspection is not hosted acceptance."""

import base64
import copy
import json
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/plg"))
import frontend_backend_pair as pair  # noqa: E402


def fixture(monkeypatch):
    image = "gcr.io/hushh-pda-dev/consent-protocol@sha256:" + "a" * 64
    accepted = pair.acceptance.IsolatedAcceptance(
        "dev", 123, 1, 222, "sha256:" + "b" * 64, "c" * 40, image
    )
    monkeypatch.setattr(pair.acceptance, "verify", lambda *_args, **_kwargs: accepted)
    monkeypatch.setattr(
        pair.candidate, "identity", lambda *_args: ("q123", "consent-protocol-plg-qual-q123")
    )
    service = {"metadata": {"uid": "1234-5678"}}
    revision = {"metadata": {"uid": "9876-5432"}}
    traffic = {
        "weights": {"consent-protocol-plg-qual-q123": 100},
        "tags": {"q123": "consent-protocol-plg-qual-q123"},
    }
    urls = ("https://s.example.run.app", "https://q123---s.example.run.app")
    versions = {pair.PREFIX + name: "1" for name in pair.RUNTIME_SECRETS}
    receipt = {
        "candidate": {
            "revision": "consent-protocol-plg-qual-q123",
            "runtimeSecretVersions": versions,
            "serviceUrl": urls[0],
            "actualTraffic": traffic,
            "provenance": {"ok": True},
        },
        "health": {
            "revision": "consent-protocol-plg-qual-q123",
            "imageReference": image,
            "audience": urls[0],
            "candidateUrl": urls[1],
        },
    }
    artifact = {"id": 222, "digest": "sha256:" + "b" * 64}
    monkeypatch.setattr(pair.acceptance, "_artifact", lambda *_args: (artifact, receipt))
    monkeypatch.setattr(
        pair.candidate,
        "read",
        lambda _cloud, _target, kind, _name: copy.deepcopy(
            service if kind == "services" else revision
        ),
    )
    monkeypatch.setattr(pair.candidate, "private_service", lambda *_args: None)
    monkeypatch.setattr(pair.candidate, "urls", lambda *_args: urls)
    monkeypatch.setattr(pair.candidate, "traffic", lambda *_args: traffic)
    monkeypatch.setattr(pair.candidate, "runtime", lambda *_args: None)
    monkeypatch.setattr(pair.candidate, "provenance", lambda *_args: {"ok": True})

    class Client:
        cache = {}

        def read(self, _path):
            return {
                "id": 123,
                "run_attempt": 1,
                "head_sha": "c" * 40,
                "status": "completed",
                "conclusion": "success",
            }

    return Client(), object(), service, revision, receipt, artifact


def test_pair_returns_only_non_authorizing_proposal(monkeypatch):
    client, cloud, *_ = fixture(monkeypatch)
    result = pair.inspect("dev", 123, github=client, cloud=cloud)
    assert result["serviceUid"] == "1234-5678" and result["revisionUid"] == "9876-5432"
    assert not result["providerVerified"] and not result["durableFenceVerified"]
    assert not result["frontendPairAccepted"] and not result["productionTrafficAuthorized"]
    assert not result["uidContinuityVerified"] and not result["healthRechecked"]
    assert not result["inheritedIAMVerified"]


@pytest.mark.parametrize(
    "case", ["artifact", "revision", "versions", "audience", "uid", "provenance"]
)
def test_changed_evidence_is_rejected(monkeypatch, case):
    client, cloud, service, revision, receipt, artifact = fixture(monkeypatch)
    if case == "artifact":
        artifact["id"] = 999
    elif case == "revision":
        receipt["candidate"]["revision"] = "unreviewed"
    elif case == "versions":
        receipt["candidate"]["runtimeSecretVersions"][pair.PREFIX + pair.RUNTIME_SECRETS[0]] = (
            "latest"
        )
    elif case == "audience":
        receipt["health"]["audience"] = "https://wrong.example.run.app"
    elif case == "uid":
        revision["metadata"]["uid"] = ""
    else:
        receipt["candidate"]["provenance"] = {"ok": False}
    with pytest.raises(ValueError):
        pair.inspect("dev", 123, github=client, cloud=cloud)


def test_second_hosted_admission_must_be_fresh_and_unchanged(monkeypatch):
    client, cloud, *_ = fixture(monkeypatch)
    first = pair.acceptance.verify("dev", 123, github=client)
    calls = []

    def verify(*_args, **kwargs):
        calls.append(1)
        assert kwargs["github"].cache == {}
        if len(calls) == 1:
            kwargs["github"].cache["stale"] = True
            return first
        return pair.acceptance.IsolatedAcceptance(
            "dev", 123, 2, 222, "sha256:" + "b" * 64, "c" * 40, first.image_reference
        )

    monkeypatch.setattr(pair.acceptance, "verify", verify)
    with pytest.raises(ValueError, match="backend_changed"):
        pair.inspect("dev", 123, github=client, cloud=cloud)
    assert len(calls) == 2


def test_optional_fresh_private_health_and_allow_policy_still_grant_no_authority(monkeypatch):
    client, cloud, _service, _revision, receipt, _artifact = fixture(monkeypatch)
    versions = receipt["candidate"]["runtimeSecretVersions"]
    calls = []
    monkeypatch.setattr(
        pair.qualification_iam,
        "verify",
        lambda *_args, **_kwargs: (
            calls.append(1) or {"observedAt": str(len(calls)), "bindings": "same"}
        ),
    )
    monkeypatch.setattr(pair.acceptance_contract, "iam", lambda *_args: versions)
    monkeypatch.setattr(pair.candidate, "token_audience", lambda *_args: None)

    class Http:
        def get(self, _url, token=None):
            return (403, b"") if token is None else (200, b'{"status":"healthy"}')

    dummy_token = "synthetic"
    result = pair.inspect(
        "dev",
        123,
        github=client,
        cloud=cloud,
        id_token=dummy_token,
        iam_cloud=object(),
        http=Http(),
    )
    assert len(calls) == 2 and result["freshHealthProbeAttempted"]
    assert result["freshAllowPolicyReadAttempted"]
    assert not result["providerVerified"] and not result["uidContinuityVerified"]
    assert not result["inheritedIAMVerified"] and not result["frontendPairAccepted"]
    assert "synthetic" not in str(result)


def test_fresh_health_refuses_public_backend(monkeypatch):
    client, cloud, _service, _revision, receipt, _artifact = fixture(monkeypatch)
    monkeypatch.setattr(pair.qualification_iam, "verify", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(
        pair.acceptance_contract,
        "iam",
        lambda *_args: receipt["candidate"]["runtimeSecretVersions"],
    )
    monkeypatch.setattr(pair.candidate, "token_audience", lambda *_args: None)

    class Http:
        def get(self, _url, token=None):
            return 200, b'{"status":"healthy"}'

    dummy_token = "synthetic"
    with pytest.raises(ValueError, match="backend_public"):
        pair.inspect(
            "dev",
            123,
            github=client,
            cloud=cloud,
            id_token=dummy_token,
            iam_cloud=object(),
            http=Http(),
        )


@pytest.mark.parametrize("case", ["version_changed", "summary_changed"])
def test_fresh_pair_refuses_changed_iam_evidence(monkeypatch, case):
    client, cloud, _service, _revision, receipt, _artifact = fixture(monkeypatch)
    calls = []
    monkeypatch.setattr(
        pair.qualification_iam,
        "verify",
        lambda *_args, **_kwargs: (
            calls.append(1) or {"summary": str(len(calls)) if case == "summary_changed" else "same"}
        ),
    )
    versions = receipt["candidate"]["runtimeSecretVersions"]
    monkeypatch.setattr(
        pair.acceptance_contract,
        "iam",
        lambda *_args: {} if case == "version_changed" else versions,
    )
    monkeypatch.setattr(pair.candidate, "token_audience", lambda *_args: None)

    class Http:
        def get(self, _url, token=None):
            return (403, b"") if token is None else (200, b'{"status":"healthy"}')

    dummy_token = "synthetic"
    with pytest.raises(ValueError, match="iam_"):
        pair.inspect(
            "dev",
            123,
            github=client,
            cloud=cloud,
            id_token=dummy_token,
            iam_cloud=object(),
            http=Http(),
        )


@pytest.mark.parametrize("case", ["wrong_audience", "expired"])
def test_fresh_pair_refuses_wrong_or_expired_identity_token(monkeypatch, case):
    client, cloud, _service, _revision, receipt, _artifact = fixture(monkeypatch)
    monkeypatch.setattr(pair.qualification_iam, "verify", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(
        pair.acceptance_contract,
        "iam",
        lambda *_args: receipt["candidate"]["runtimeSecretVersions"],
    )
    claims = {
        "aud": "https://wrong.example.run.app"
        if case == "wrong_audience"
        else receipt["health"]["audience"],
        "iss": "https://accounts.google.com",
        "exp": int(time.time()) - 1 if case == "expired" else int(time.time()) + 300,
    }
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    dummy_token = "header." + payload + ".signature"
    with pytest.raises(ValueError, match="audience_or_expiry"):
        pair.inspect(
            "dev",
            123,
            github=client,
            cloud=cloud,
            id_token=dummy_token,
            iam_cloud=object(),
            http=object(),
        )
