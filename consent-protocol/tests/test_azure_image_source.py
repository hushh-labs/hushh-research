"""The importImage source credential: a short-lived token minted by impersonating the
dedicated image reader, never the hub's own runtime token, never logged, and a typed
refusal before setup when a private source has no reader configured."""

from __future__ import annotations

import json
import logging

import pytest

from hushh_mcp.services import azure_agent_setup as setup
from hushh_mcp.services import azure_image_source as source
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.user_azure_backend import jit_person_authority
from tests.azure_arm_fake import FakeArm
from tests.test_user_azure_backend import (  # noqa: F401 - shared fixtures and builders
    _NEW,
    _SOURCE,
    _backend,
    _hub_caller,
    _upgrade_spec,
    arm,
)

_READER = "one-pod-image-reader@hushh-pda-dev.iam.gserviceaccount.com"
_HUB_EMAIL = "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
_HUB_TOKEN = "hub-runtime-token-must-never-leave"  # noqa: S105 - fake, authenticates nothing
_READER_TOKEN = "reader-token-900s"  # noqa: S105 - fake, authenticates nothing
_PERSON_TOKEN = "person-token-for-tests"  # noqa: S105 - fake, authenticates nothing
_REGISTRY = "us-central1-docker.pkg.dev"
_REPOSITORY = "hushh-pda-dev/one-pod/consent-protocol-pod"
_DIGEST = "sha256:" + "b" * 64
_CHALLENGE = f'Bearer realm="https://{_REGISTRY}/v2/token",service="{_REGISTRY}"'


class _Response:
    def __init__(self, status: int, body: dict | None = None, headers: dict | None = None):
        self.status_code = status
        self._body = body or {}
        self.headers = headers or {}

    def json(self) -> dict:
        return self._body


class _Google:
    """IAM Credentials and an Artifact Registry repository, recording every request."""

    def __init__(self, *, iam_status=200, minted=_READER_TOKEN, readable=True, public=False):
        self.iam_status, self.minted = iam_status, minted
        self.readable, self.public = readable, public
        self.posts: list[tuple[str, dict, dict]] = []
        self.heads: list[tuple[str, dict]] = []
        self.gets: list[tuple[str, dict]] = []

    def post(self, url, headers=None, json=None, timeout=None):
        self.posts.append((url, headers or {}, json or {}))
        if self.iam_status != 200:
            return _Response(self.iam_status, {"error": {"status": "PERMISSION_DENIED"}})
        return _Response(200, {"accessToken": self.minted, "expireTime": "2026-10-02T00:15:00Z"})

    def head(self, url, headers=None, timeout=None):
        self.heads.append((url, headers or {}))
        auth = (headers or {}).get("Authorization", "")
        if not auth:
            return _Response(401, headers={"WWW-Authenticate": _CHALLENGE})
        if auth == "Bearer anonymous-pull" and self.public:
            return _Response(200)
        if auth == f"Bearer {_READER_TOKEN}" and self.readable:
            return _Response(200)
        return _Response(403)

    def get(self, url, params=None, timeout=None):
        self.gets.append((url, params or {}))
        return _Response(200, {"token": "anonymous-pull"})


def _hub() -> tuple[str, str]:
    return _HUB_TOKEN, _HUB_EMAIL


@pytest.fixture
def reader(monkeypatch):
    monkeypatch.setenv(source.READER_SA_ENV, _READER)
    return _READER


@pytest.fixture
def no_reader(monkeypatch):
    monkeypatch.delenv(source.READER_SA_ENV, raising=False)


def test_the_credential_is_minted_by_impersonating_the_reader_only_when_asked(reader):
    google = _Google()
    credentials = source.import_credentials(_REGISTRY, session=google, hub_identity=_hub)
    assert credentials is not None and google.posts == []
    assert credentials() == {"username": "oauth2accesstoken", "password": _READER_TOKEN}
    url, headers, body = google.posts[0]
    assert url == (
        f"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{_READER}"
        ":generateAccessToken"
    )
    assert body == {"scope": ["https://www.googleapis.com/auth/cloud-platform"], "lifetime": "900s"}
    # The hub's own token goes to IAM Credentials to impersonate, and nowhere else.
    assert headers == {"Authorization": f"Bearer {_HUB_TOKEN}"}


def test_without_a_reader_there_is_no_credential(no_reader):
    assert source.import_credentials(_REGISTRY, session=_Google(), hub_identity=_hub) is None


def test_a_google_token_never_reaches_a_foreign_registry(reader):
    google = _Google()
    assert source.import_credentials("registry.example.com", session=google) is None
    with pytest.raises(AzureSetupRefused) as exc:
        source.require_import_access(
            "registry.example.com", "agent", _DIGEST, session=google, hub_identity=_hub
        )
    assert exc.value.code == "IMAGE_SOURCE_UNSUPPORTED"
    assert google.posts == []
    sent = json.dumps(google.heads)
    assert _READER_TOKEN not in sent and _HUB_TOKEN not in sent


def test_a_private_source_without_a_reader_is_refused_naming_the_configuration(no_reader):
    google = _Google(public=False)
    with pytest.raises(AzureSetupRefused) as exc:
        source.require_import_access(_REGISTRY, _REPOSITORY, _DIGEST, session=google)
    assert exc.value.code == "IMAGE_SOURCE_NOT_CONFIGURED"
    assert "HUSSH_POD_IMAGE_READER_SA" in str(exc.value)
    assert google.posts == []


def test_a_public_source_needs_no_reader(no_reader):
    google = _Google(public=True)
    assert source.require_import_access(_REGISTRY, _REPOSITORY, _DIGEST, session=google) == "public"
    realm, params = google.gets[0]
    assert realm == f"https://{_REGISTRY}/v2/token"
    assert params == {"service": _REGISTRY, "scope": f"repository:{_REPOSITORY}:pull"}
    assert google.heads[-1][0] == f"https://{_REGISTRY}/v2/{_REPOSITORY}/manifests/{_DIGEST}"


def test_an_unreachable_source_is_not_assumed_public(no_reader):
    class _Down(_Google):
        def head(self, url, headers=None, timeout=None):
            raise ConnectionError("no route")

    with pytest.raises(AzureSetupRefused) as exc:
        source.require_import_access(_REGISTRY, _REPOSITORY, _DIGEST, session=_Down())
    assert exc.value.code == "IMAGE_SOURCE_NOT_CONFIGURED"


def test_the_preflight_proves_the_reader_can_read_this_digest(reader):
    google = _Google(readable=True)
    access = source.require_import_access(
        _REGISTRY, _REPOSITORY, _DIGEST, session=google, hub_identity=_hub
    )
    assert access == "reader"
    url, headers = google.heads[-1]
    assert url.endswith(f"/manifests/{_DIGEST}")
    assert headers["Authorization"] == f"Bearer {_READER_TOKEN}"


def test_a_reader_without_the_repository_grant_is_refused_before_setup(reader):
    with pytest.raises(AzureSetupRefused) as exc:
        source.require_import_access(
            _REGISTRY, _REPOSITORY, _DIGEST, session=_Google(readable=False), hub_identity=_hub
        )
    assert exc.value.code == "IMAGE_READER_CANNOT_READ"


def test_a_refused_impersonation_never_falls_back_to_the_hub_token(reader):
    credentials = source.import_credentials(
        _REGISTRY, session=_Google(iam_status=403), hub_identity=_hub
    )
    assert credentials is not None
    with pytest.raises(AzureSetupRefused) as exc:
        credentials()
    assert exc.value.code == "IMAGE_READER_UNAVAILABLE"


def test_an_unreachable_iam_or_missing_hub_identity_is_a_typed_refusal(reader):
    class _Unreachable(_Google):
        def post(self, url, headers=None, json=None, timeout=None):
            raise ConnectionError("iamcredentials unreachable")

    def no_identity() -> tuple[str, str]:
        raise RuntimeError("metadata and ADC both empty")

    for session, identity in ((_Unreachable(), _hub), (_Google(), no_identity)):
        with pytest.raises(AzureSetupRefused) as exc:
            source.require_import_access(
                _REGISTRY, _REPOSITORY, _DIGEST, session=session, hub_identity=identity
            )
        assert exc.value.code == "IMAGE_READER_UNAVAILABLE"


def test_a_minted_token_equal_to_the_hub_token_is_refused(reader):
    credentials = source.import_credentials(
        _REGISTRY, session=_Google(minted=_HUB_TOKEN), hub_identity=_hub
    )
    with pytest.raises(AzureSetupRefused) as exc:
        credentials()  # type: ignore[misc]
    assert exc.value.code == "IMAGE_READER_UNAVAILABLE"


def test_the_hub_identity_cannot_be_its_own_reader(monkeypatch):
    monkeypatch.setenv(source.READER_SA_ENV, _HUB_EMAIL)
    google = _Google()
    with pytest.raises(AzureSetupRefused) as exc:
        source.mint_reader_token(_HUB_EMAIL, session=google, hub_identity=_hub)
    assert exc.value.code == "IMAGE_READER_IS_HUB"
    assert google.posts == []


def test_a_malformed_reader_is_refused(monkeypatch):
    monkeypatch.setenv(source.READER_SA_ENV, "not-a-service-account")
    with pytest.raises(AzureSetupRefused) as exc:
        source.import_credentials(_REGISTRY)
    assert exc.value.code == "IMAGE_READER_MISCONFIGURED"


def test_no_token_is_ever_logged_or_put_in_an_error(reader, caplog):
    caplog.set_level(logging.DEBUG)
    errors: list[str] = []
    source.require_import_access(
        _REGISTRY, _REPOSITORY, _DIGEST, session=_Google(), hub_identity=_hub
    )
    for google in (_Google(iam_status=403), _Google(readable=False), _Google(minted=_HUB_TOKEN)):
        try:
            source.require_import_access(
                _REGISTRY, _REPOSITORY, _DIGEST, session=google, hub_identity=_hub
            )
        except AzureSetupRefused as exc:
            errors.append(str(exc))
    assert len(errors) == 3
    for secret in (_READER_TOKEN, _HUB_TOKEN):
        assert secret not in caplog.text
        assert not any(secret in message for message in errors)


def _patch_mint(monkeypatch, minted: list[str]) -> None:
    def fake_mint(reader, *, session=None, hub_identity=None):
        assert reader == _READER
        minted.append(reader)
        return _READER_TOKEN

    monkeypatch.setattr(source, "mint_reader_token", fake_mint)


def test_setup_imports_with_the_reader_credential_by_default(reader, monkeypatch):
    minted: list[str] = []
    _patch_mint(monkeypatch, minted)
    fake = FakeArm()

    class _Healthy:
        def get(self, url, timeout=None):
            return _Response(200)

    setup.run_agent_setup(
        access_token=_PERSON_TOKEN, tenant_id="11111111-1111-1111-1111-111111111111",
        subscription_id="22222222-2222-2222-2222-222222222222", location="eastus2",
        spec=PodSpec(hushh_id="ha1_abcdefghijklmnopqrstuvwxyz234567",
                     phone_e164_hash="h", pod_pubkey="", billing_space_id="b"),
        source_image=f"{_REGISTRY}/{_REPOSITORY}@{_DIGEST}", advance=lambda _s: None, arm=fake,
        hussh_principal_id="88888888-8888-8888-8888-888888888888", http=_Healthy(),
        sleep=lambda _s: None,
    )  # fmt: skip
    imports = [body for _, path, body in fake.calls if path.endswith("/importImage")]
    assert imports[0]["source"]["credentials"] == {
        "username": "oauth2accesstoken",
        "password": _READER_TOKEN,
    }
    assert minted == [_READER]
    assert sum(_READER_TOKEN in json.dumps(body) for _, _, body in fake.calls if body) == 1


async def test_an_approved_update_imports_with_the_reader_credential(arm, reader, monkeypatch):  # noqa: F811 - shared fixture
    minted: list[str] = []
    _patch_mint(monkeypatch, minted)
    backend = _backend(arm)
    with jit_person_authority("person-jit-token"):
        await backend.upgrade(_upgrade_spec(arm, backend, []))
    imports = [body for method, path, body in arm.calls if path.endswith("/importImage")]
    assert imports[0]["source"]["credentials"]["password"] == _READER_TOKEN
    assert imports[0]["source"]["sourceImage"].endswith(f"@{_NEW}")
    assert imports[0]["source"]["registryUri"] == _SOURCE.split("/", 1)[0]
    assert minted == [_READER]


async def test_a_refused_reader_credential_replaces_nothing(arm, reader, monkeypatch):  # noqa: F811 - shared fixture
    def refused(reader, *, session=None, hub_identity=None):
        raise AzureSetupRefused("no reader token", code="IMAGE_READER_UNAVAILABLE")

    monkeypatch.setattr(source, "mint_reader_token", refused)
    backend = _backend(arm)
    with jit_person_authority("person-jit-token"):
        with pytest.raises(AzureSetupRefused):
            await backend.upgrade(_upgrade_spec(arm, backend, []))
    assert arm.writes() == []
