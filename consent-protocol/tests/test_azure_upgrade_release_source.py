"""An approved Azure update imports from the same place setup does.

The owner approves the hub's own reference (``gcr.io/<project>/consent-protocol-pod@``
digest), but the image reader is granted only the pod-only release repository
(``HUSSH_AZURE_POD_IMAGE_REPOSITORY``). Setup already mapped its import there; the
update preflight and the update import did not, so on dev every approved update
refused before sign-in. These tests pin the mapping at both sites and that approval
identity stays on the approved reference itself: only where the bytes are read from
moves, and a digest names exact bytes.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from api.routes.one import byoc_azure
from hushh_mcp.services import azure_agent_upgrade, azure_image_source, pod_upgrade_handoff
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.user_azure_backend import jit_person_authority
from tests import test_byoc_azure_routes as routes
from tests.test_byoc_azure_routes import (  # noqa: F401 - shared fixtures and builders
    _COMPLETE,
    _REAL_REQUIRE_IMAGE_ACCESS,
    _UPGRADE,
    _client,
    _provisioned,
    _redeems_as,
    _state,
    spawned,
)
from tests.test_user_azure_backend import (  # noqa: F401 - shared fixtures and builders
    _NEW,
    _SUB,
    _backend,
    _hub_caller,
    _upgrade_spec,
    arm,
)

_RELEASE = "us-central1-docker.pkg.dev/hushh-pda-dev/one-pod-release/consent-protocol-pod"
_APPROVED = f"gcr.io/hushh-pda-dev/consent-protocol-pod@{_NEW}"
_READER_TOKEN = "reader-token-900s"  # noqa: S105 - fake, authenticates nothing


@pytest.fixture
def release_repository(monkeypatch):
    monkeypatch.setenv(azure_image_source.RELEASE_REPOSITORY_ENV, _RELEASE)
    return _RELEASE


@pytest.fixture
def no_reader(monkeypatch):
    monkeypatch.delenv(azure_image_source.READER_SA_ENV, raising=False)


def _import_body(arm) -> dict:  # noqa: F811 - the shared FakeArm fixture
    posts = [body for method, path, body in arm.calls if path.endswith("/importImage")]
    assert len(posts) == 1, "exactly one import per update"
    return posts[0]


# --- the import itself -----------------------------------------------------------


async def test_the_update_imports_the_approved_digest_from_the_release_repository(
    arm,  # noqa: F811 - shared fixture
    release_repository,
    no_reader,
):
    backend, acks = _backend(arm), []
    with jit_person_authority("person-jit-token"):
        handle = await backend.upgrade(
            _upgrade_spec(arm, backend, acks, upgrade_target_image=_APPROVED)
        )
    source = _import_body(arm)["source"]
    assert source["registryUri"] == "us-central1-docker.pkg.dev"
    assert source["sourceImage"] == f"hushh-pda-dev/one-pod-release/consent-protocol-pod@{_NEW}"
    # Approval identity is untouched: the record still names what the owner approved,
    # and the agent now reports exactly the approved digest.
    assert handle.backend_metadata["source_image"] == _APPROVED
    assert acks[0]["image"].endswith(f"@{_NEW}")


async def test_without_a_release_repository_the_approved_reference_is_imported(
    arm,  # noqa: F811 - shared fixture
    monkeypatch,
    no_reader,
):
    monkeypatch.delenv(azure_image_source.RELEASE_REPOSITORY_ENV, raising=False)
    backend = _backend(arm)
    with jit_person_authority("person-jit-token"):
        await backend.upgrade(_upgrade_spec(arm, backend, [], upgrade_target_image=_APPROVED))
    source = _import_body(arm)["source"]
    assert source["registryUri"] == "gcr.io"
    assert source["sourceImage"] == f"hushh-pda-dev/consent-protocol-pod@{_NEW}"


async def test_the_reader_credential_goes_to_the_release_repository_host(
    arm,  # noqa: F811 - shared fixture
    release_repository,
    monkeypatch,
):
    minted_for: list[str] = []

    def mint(reader, *, session=None, hub_identity=None):
        minted_for.append(reader)
        return _READER_TOKEN

    monkeypatch.setenv(
        azure_image_source.READER_SA_ENV,
        "hussh-pod-image-reader@hushh-pda-dev.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(azure_image_source, "mint_reader_token", mint)
    backend = _backend(arm)
    with jit_person_authority("person-jit-token"):
        await backend.upgrade(_upgrade_spec(arm, backend, [], upgrade_target_image=_APPROVED))
    source = _import_body(arm)["source"]
    assert source["registryUri"] == "us-central1-docker.pkg.dev"
    assert source["credentials"] == {"username": "oauth2accesstoken", "password": _READER_TOKEN}
    assert len(minted_for) == 1


async def test_a_misconfigured_release_repository_refuses_before_the_agent_is_drained(
    arm,  # noqa: F811 - shared fixture
    monkeypatch,
    no_reader,
):
    prepared: list[str] = []

    class _Handoff:
        def __init__(self, **_):
            pass

        def prepare_and_wait(self, *, operation_id, **_):
            prepared.append(operation_id)
            return {}

        def release(self, **_):
            return {}

    monkeypatch.setattr(pod_upgrade_handoff, "PodUpgradeHandoffClient", _Handoff)
    monkeypatch.setenv(azure_image_source.RELEASE_REPOSITORY_ENV, "registry.example.com/x/pod")
    backend = _backend(arm)
    spec = _upgrade_spec(
        arm, backend, [], upgrade_target_image=_APPROVED, upgrade_operation_id="op-1"
    )
    with jit_person_authority("person-jit-token"):
        with pytest.raises(AzureSetupRefused) as refused:
            await backend.upgrade(spec)
    assert refused.value.code == "IMAGE_REPOSITORY_MISCONFIGURED"
    assert prepared == [] and arm.writes() == []


def test_the_import_source_keeps_the_approved_digest(release_repository):
    registry, repository, digest = azure_agent_upgrade.import_source(_APPROVED)
    assert (registry, repository, digest) == (
        "us-central1-docker.pkg.dev",
        "hushh-pda-dev/one-pod-release/consent-protocol-pod",
        _NEW,
    )


def test_a_mapping_that_reads_another_digest_is_refused(monkeypatch):
    other = f"{_RELEASE}@sha256:" + "e" * 64
    monkeypatch.setattr(azure_agent_upgrade, "release_source", lambda _approved: other)
    with pytest.raises(RuntimeError, match="approved digest"):
        azure_agent_upgrade.import_source(_APPROVED)


# --- the preflight before the Microsoft sign-in --------------------------------------


def _record_preflight(monkeypatch) -> list[tuple]:
    seen: list[tuple] = []
    monkeypatch.setattr(byoc_azure, "_require_image_access", _REAL_REQUIRE_IMAGE_ACCESS)
    monkeypatch.setattr(
        azure_image_source, "require_import_access", lambda *args, **_: seen.append(args)
    )
    return seen


def test_upgrade_begin_preflights_the_release_repository_digest(
    spawned,  # noqa: F811 - shared fixture
    release_repository,
    monkeypatch,
):
    seen = _record_preflight(monkeypatch)
    routes._Registry.row = _provisioned(approved=_APPROVED)
    assert _client().post(_UPGRADE).status_code == 200
    assert seen == [
        ("us-central1-docker.pkg.dev", "hushh-pda-dev/one-pod-release/consent-protocol-pod", _NEW)
    ]


def test_upgrade_begin_refuses_a_misconfigured_release_repository_before_sign_in(
    spawned,  # noqa: F811 - shared fixture
    monkeypatch,
):
    seen = _record_preflight(monkeypatch)
    monkeypatch.setenv(azure_image_source.RELEASE_REPOSITORY_ENV, f"{_RELEASE}:latest")
    routes._Registry.row = _provisioned(approved=_APPROVED)
    response = _client().post(_UPGRADE)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "IMAGE_REPOSITORY_MISCONFIGURED"
    assert seen == []


def test_the_update_job_still_carries_the_approved_reference(
    spawned,  # noqa: F811 - shared fixture
    release_repository,
    monkeypatch,
):
    """Approval matching compares the stored ``targetImage`` exactly; it must not move."""
    routes._Registry.row = _provisioned(approved=_APPROVED)
    _redeems_as(monkeypatch)
    response = _client().post(
        _COMPLETE,
        json={
            "code": "c",
            "state": _state(kind="upgrade", subscription=_SUB, authority=routes._TENANT),
        },
    )
    assert response.json()["status"] == "upgrade_started"
    kind, kwargs = spawned[0]
    assert kind == "upgrade" and kwargs["target_image"] == _APPROVED


# --- a digest the release repository does not hold -----------------------------------


class _ReleaseRegistry:
    """The release repository answering the reader's manifest read with one status."""

    def __init__(self, status: int) -> None:
        self.status = status

    def head(self, url, headers=None, timeout=None):
        return SimpleNamespace(status_code=self.status)


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (404, "IMAGE_NOT_PUBLISHED"),
        (403, "IMAGE_READER_CANNOT_READ"),
        (500, "IMAGE_READER_CANNOT_READ"),
    ],
)
def test_an_unpublished_digest_is_not_mistaken_for_a_missing_grant(monkeypatch, status, code):
    monkeypatch.setenv(
        azure_image_source.READER_SA_ENV,
        "hussh-pod-image-reader@hushh-pda-dev.iam.gserviceaccount.com",
    )
    monkeypatch.setattr(azure_image_source, "mint_reader_token", lambda *_a, **_k: _READER_TOKEN)
    with pytest.raises(AzureSetupRefused) as refused:
        azure_image_source.require_import_access(
            "us-central1-docker.pkg.dev",
            "hushh-pda-dev/one-pod-release/consent-protocol-pod",
            _NEW,
            session=_ReleaseRegistry(status),
        )
    assert refused.value.code == code
    if status == 404:
        # The remedy for a missing digest is publishing it, never a wider reader grant.
        assert "grant" not in str(refused.value).lower()
