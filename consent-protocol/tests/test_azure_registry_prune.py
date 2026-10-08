"""After a confirmed Azure update, the person's registry keeps the current and previous image.

Risk 8 of the pod economics sheet: Basic has no retention, so every update's 455 MiB
digest stayed forever. The fixtures are measured (dev agent, 2026-10-06, read-only):
ARM lists the inactive revision with its old digest, and the registry holds plain OCI
image manifests listed by ``/acr/v1/<repo>/_manifests``.
"""

from __future__ import annotations

import copy
import logging
from typing import Any, Optional

import pytest

from hushh_mcp.services import azure_registry_prune as prune
from hushh_mcp.services.azure_agent_upgrade import upgrade_agent
from hushh_mcp.services.azure_arm_client import ArmError
from hushh_mcp.services.azure_registry_prune import (
    PruneSkipped,
    RegistryDataPlane,
    prune_candidates,
    prune_superseded_images,
    referenced_digests,
)
from hushh_mcp.services.azure_setup_applier import AzureSetupRefused
from hushh_mcp.services.user_azure_backend import UserAzureBackend, jit_person_authority
from tests.test_azure_upgrade_waits_for_ready import (  # noqa: F401 - fixtures
    _REVISION,
    _Clock,
    _hub_caller,
    agent,
)

_SERVER = "crhussh2f98c07ffec9cbda.azurecr.io"
_APP_ID = (
    "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-hussh-one-x"
    "/providers/Microsoft.App/containerApps/ca-hussh-one-pod"
)
_OCI = "application/vnd.oci.image.manifest.v1+json"
_INDEX = "application/vnd.oci.image.index.v1+json"
_TOKEN = "person-arm-token-for-tests"  # noqa: S105 - no service exists to authenticate to
_TENANT = "11111111-1111-1111-1111-111111111111"


def _d(ch: str) -> str:
    return "sha256:" + ch * 64


def _image(digest: str) -> str:
    return f"{_SERVER}/consent-protocol-pod@{digest}"


OLDEST, STALE, PREVIOUS, CURRENT = _d("1"), _d("2"), _d("3"), _d("4")


def _app(image: str = _image(CURRENT), *, ready: str = "ca-hussh-one-pod--u4") -> dict[str, Any]:
    return {
        "id": _APP_ID,
        "properties": {
            "provisioningState": "Succeeded",
            "latestRevisionName": "ca-hussh-one-pod--u4",
            "latestReadyRevisionName": ready,
            "template": {"containers": [{"name": "pod", "image": image}]},
        },
    }


def _revision(name: str, digest: str, *, active: bool) -> dict[str, Any]:
    return {
        "name": name,
        "properties": {
            "active": active,
            "template": {"containers": [{"name": "pod", "image": _image(digest)}]},
        },
    }


#: As ARM answered on dev: the inactive revision is listed with its digest.
_REVISIONS = {
    "value": [
        _revision("ca-hussh-one-pod--scchito", STALE, active=False),
        _revision("ca-hussh-one-pod--u4", CURRENT, active=True),
    ],
}


def _manifest(digest: str, media: str = _OCI) -> dict[str, Any]:
    return {"digest": digest, "mediaType": media, "imageSize": 478205194}


class _Arm:
    def __init__(self, revisions: Any = None, error: Optional[Exception] = None) -> None:
        self.revisions = _REVISIONS if revisions is None else revisions
        self.error = error
        self.reads: list[str] = []

    def get(self, path: str, *, api_version: str, op: str = "") -> Any:
        self.reads.append(path)
        if self.error is not None:
            raise self.error
        return copy.deepcopy(self.revisions)


class _Registry:
    """The data plane as the prune uses it, recording every call."""

    def __init__(self, manifests: Any, *, fail_on: str = "") -> None:
        self.listed = manifests
        self.fail_on = fail_on
        self.server = self.repository = ""
        self.authorized: tuple[str, str] = ("", "")
        self.deleted: list[str] = []

    def __call__(self, server: str, repository: str) -> _Registry:
        self.server, self.repository = server, repository
        return self

    def authorize(self, arm_token: str, tenant_id: str) -> None:
        if self.fail_on == "authorize":
            raise PruneSkipped("registry /oauth2/exchange answered 401")
        self.authorized = (arm_token, tenant_id)

    def manifests(self) -> Any:
        return copy.deepcopy(self.listed)

    def delete(self, digest: str) -> bool:
        if self.fail_on == "delete":
            raise OSError("connection reset")
        self.deleted.append(digest)
        return True


def _prune(
    arm: _Arm, registry: _Registry, *, app=None, previous=_image(PREVIOUS), expected=None
) -> list[str]:
    app = _app() if app is None else app
    return prune_superseded_images(
        arm,  # type: ignore[arg-type]
        app_id=_APP_ID, app=app, previous=previous, tenant_id=_TENANT, token=lambda: _TOKEN,
        registry=registry,  # type: ignore[arg-type]
        expected=prune.running_image(app) if expected is None else expected,
    )  # fmt: skip


_ALL = [_manifest(d) for d in (OLDEST, STALE, PREVIOUS, CURRENT)]


# -- what is kept -------------------------------------------------------------------------


def test_only_a_digest_nothing_names_is_deleted():
    """OLDEST: no revision names it. STALE: an inactive revision still does, so it stays."""
    arm, registry = _Arm(), _Registry(_ALL)
    assert _prune(arm, registry) == [OLDEST]
    assert registry.deleted == [OLDEST]
    assert (registry.server, registry.repository) == (_SERVER, "consent-protocol-pod")
    assert registry.authorized == (_TOKEN, _TENANT)
    assert arm.reads == [f"{_APP_ID}/revisions"]


def test_the_current_and_previous_digests_are_kept_even_when_no_revision_names_them():
    registry = _Registry(_ALL)
    _prune(_Arm({"value": []}), registry)
    assert sorted(registry.deleted) == sorted([OLDEST, STALE])


def test_inactive_revisions_protect_their_digests():
    assert referenced_digests(_REVISIONS) == {STALE, CURRENT}


@pytest.mark.parametrize(
    "revisions",
    [
        {"value": [], "nextLink": "https://management.azure.com/next"},
        {"value": [_revision("r", CURRENT, active=True)] + [{"properties": {"template": {
            "containers": [{"image": f"{_SERVER}/consent-protocol-pod:latest"}]}}}]},
        {"error": {"code": "x"}},
        None,
    ],
    ids=["second_page", "tag_only_image", "no_value", "unreadable"],
)  # fmt: skip
def test_a_revision_list_that_cannot_prove_every_reference_stops_the_prune(revisions):
    with pytest.raises(PruneSkipped):
        referenced_digests(revisions)
    registry = _Registry(_ALL)
    assert _prune(_Arm(revisions if revisions is not None else []), registry) == []
    assert registry.deleted == []


def test_an_index_anywhere_stops_the_prune_so_no_child_manifest_is_deleted():
    with pytest.raises(PruneSkipped):
        prune_candidates([_manifest(OLDEST), _manifest(CURRENT, _INDEX)], protected={CURRENT})
    registry = _Registry([_manifest(OLDEST), _manifest(CURRENT, _INDEX)])
    assert _prune(_Arm(), registry) == [] and registry.deleted == []


def test_a_malformed_digest_never_reaches_a_delete_url():
    with pytest.raises(PruneSkipped):
        prune_candidates([{"digest": "../../v2", "mediaType": _OCI}], protected=set())


# -- when it runs -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("app", "previous"),
    [
        (_app(ready="ca-hussh-one-pod--r1"), _image(PREVIOUS)),  # new revision not ready
        (_app(image=f"{_SERVER}/consent-protocol-pod:latest"), _image(PREVIOUS)),  # by tag
        (_app(image=f"evil.example.com/consent-protocol-pod@{CURRENT}"), _image(PREVIOUS)),
        (_app(image=f"crhussh2f98c07ffec9cbda.azurecr.io/other@{CURRENT}"), _image(PREVIOUS)),
        (_app(), ""),  # previous image unknown
    ],
    ids=["not_ready", "tag", "foreign_host", "foreign_repository", "no_previous"],
)
def test_nothing_is_read_or_deleted_unless_the_new_revision_is_the_ready_pinned_one(app, previous):
    arm, registry = _Arm(), _Registry(_ALL)
    assert _prune(arm, registry, app=app, previous=previous) == []
    assert arm.reads == [] and registry.deleted == [] and registry.authorized == ("", "")


@pytest.mark.parametrize("fail_on", ["authorize", "delete"])
def test_a_registry_failure_logs_and_never_raises(fail_on, caplog):
    registry = _Registry(_ALL, fail_on=fail_on)
    with caplog.at_level(logging.INFO, logger=prune.logger.name):
        assert _prune(_Arm(), registry) == []
    assert "azure_registry_prune.skipped" in caplog.text
    assert _TOKEN not in caplog.text


def test_an_arm_refusal_or_a_missing_sign_in_never_raises():
    refused = ArmError("forbidden", status=403, code="AuthorizationFailed", message="", op="x")
    assert _prune(_Arm(error=refused), _Registry(_ALL)) == []
    no_sign_in = prune_superseded_images(
        _Arm(), app_id=_APP_ID, app=_app(), previous=_image(PREVIOUS),  # type: ignore[arg-type]
        registry=_Registry(_ALL), expected=_image(CURRENT),  # type: ignore[arg-type]
    )  # fmt: skip
    assert no_sign_in == []  # no jit_person_authority in this context


# -- the data plane ------------------------------------------------------------------------


class _Response:
    def __init__(self, status: int, body: Optional[dict] = None) -> None:
        self.status_code, self._body = status, body or {}

    def json(self) -> dict:
        return self._body


class _Session:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        if url.endswith("/oauth2/exchange"):
            return _Response(200, {"refresh_token": "registry-refresh"})
        return _Response(200, {"access_token": "registry-scoped"})

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        return _Response(200, {"manifests": [_manifest(OLDEST)]})

    def delete(self, url, **kwargs):
        self.calls.append(("DELETE", url, kwargs))
        return _Response(202)


def test_the_data_plane_exchanges_scopes_lists_and_deletes_without_following_redirects():
    session = _Session()
    plane = RegistryDataPlane(_SERVER, "consent-protocol-pod", http=session)
    plane.authorize(_TOKEN, _TENANT)
    assert plane.manifests() == [_manifest(OLDEST)]
    assert plane.delete(OLDEST) is True
    (_, exchange_url, exchange), (_, token_url, scoped), (_, list_url, listed), (
        _, delete_url, deleted,
    ) = session.calls  # fmt: skip
    assert exchange_url == f"https://{_SERVER}/oauth2/exchange"
    assert exchange["data"] == {
        "grant_type": "access_token", "service": _SERVER, "access_token": _TOKEN,
        "tenant": _TENANT,
    }  # fmt: skip
    assert token_url == f"https://{_SERVER}/oauth2/token"
    assert scoped["data"]["scope"] == "repository:consent-protocol-pod:metadata_read,delete"
    assert list_url == f"https://{_SERVER}/acr/v1/consent-protocol-pod/_manifests"
    assert delete_url == f"https://{_SERVER}/v2/consent-protocol-pod/manifests/{OLDEST}"
    assert listed["headers"]["Authorization"] == "Bearer registry-scoped"
    assert all(kwargs["allow_redirects"] is False for _, _, kwargs in session.calls)


# -- wired into the update ------------------------------------------------------------------


def test_a_confirmed_update_prunes_with_the_replaced_image(agent, monkeypatch):  # noqa: F811
    arm, backend, spec, _acks = agent
    calls: list[tuple[dict, str]] = []
    monkeypatch.setattr(
        UserAzureBackend,
        "prune_superseded_images",
        lambda self, _arm, app, *, previous, expected: (
            calls.append((app, previous, expected)) or []
        ),
    )
    previous = arm.resources[backend.app_id]["properties"]["template"]["containers"][0]["image"]
    clock = _Clock(on_sleep=lambda n: arm.become_ready() if n == 1 else None)
    handle = upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep)
    assert handle.status == "live"
    assert len(calls) == 1 and calls[0][1] == previous
    assert calls[0][2] == prune.running_image(calls[0][0])  # the image this update installed
    app = calls[0][0]["properties"]
    assert app["latestReadyRevisionName"] == _REVISION  # only after the verdict said live


@pytest.mark.parametrize("outcome", ["failed", "unconfirmed"])
def test_an_update_without_a_live_verdict_never_prunes(agent, monkeypatch, outcome):  # noqa: F811
    arm, backend, spec, _acks = agent
    calls: list[Any] = []
    monkeypatch.setattr(
        UserAzureBackend, "prune_superseded_images", lambda *a, **k: calls.append(a) or []
    )
    on_sleep = (
        (lambda _n: arm.set_revision("Provisioned", "Failed")) if outcome == "failed" else None
    )
    clock = _Clock(on_sleep=on_sleep)
    with pytest.raises(AzureSetupRefused):
        upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep)
    assert calls == []


def test_a_prune_that_cannot_run_leaves_the_update_live(agent):  # noqa: F811
    """The real hook under the person's sign-in: the fake ARM has no revision list."""
    arm, backend, spec, _acks = agent
    clock = _Clock(on_sleep=lambda n: arm.become_ready() if n == 1 else None)
    with jit_person_authority(_TOKEN):
        handle = upgrade_agent(backend, spec, arm, clock=clock, sleep=clock.sleep)
    assert handle.status == "live" and handle.backend_metadata["upgraded"] is True
    assert ("GET", f"{backend.app_id}/revisions", None) in arm.calls  # it tried, and let go


def test_the_backend_hook_passes_its_own_agent_and_tenant(monkeypatch):
    seen: dict[str, Any] = {}

    def fake(arm, **kwargs):
        seen.update(kwargs)
        return []

    monkeypatch.setattr(prune, "prune_superseded_images", fake)
    backend = UserAzureBackend(
        tenant_id=_TENANT, subscription_id="22222222-2222-2222-2222-222222222222",
        resource_group="rg-hussh-one-x", location="eastus2",
    )  # fmt: skip
    pruned = backend.prune_superseded_images(
        _Arm(),
        _app(),
        previous=_image(PREVIOUS),
        expected=_image(CURRENT),  # type: ignore[arg-type]
    )
    assert pruned == []
    assert seen["app_id"] == backend.app_id and seen["tenant_id"] == _TENANT
    assert seen["previous"] == _image(PREVIOUS) and seen["expected"] == _image(CURRENT)


def test_nothing_is_deleted_unless_the_app_runs_the_image_this_update_installed():
    """The registry host is trusted only when the live app runs exactly the installed image."""
    registry = _Registry(_ALL)
    assert _prune(_Arm(), registry, expected=_image(PREVIOUS)) == []
    assert registry.deleted == []


def test_one_update_deletes_at_most_the_cap(monkeypatch):
    monkeypatch.setattr(prune, "_MAX_DELETES", 1)
    many = [_manifest(_d(c)) for c in "56789"] + _ALL
    registry = _Registry(many)
    assert len(_prune(_Arm(), registry)) == 1
