"""A cloud proven before the registry row exists must not be lost between the two.

THE ORDER THAT CREATES THIS

The cloud step comes before phone verification, and phone verification is what mints
the registry row. So between them a person can hold a PROVEN cloud with nowhere to put
it, and `save_byoc_project` parks it on their setup record instead.
`register_pending` attaches it once the row exists.

That attach is best-effort by design and documents itself as retryable -- "the parked
record stays, so a retry can still land it". Two things meant the retry never happened
and the parked cloud was silently ignored in the meantime.

`user_cloud_from_row` returns None only for a MISSING row. A row that EXISTS without
cloud columns came back as a `UserCloud` full of Nones, which is `not None`, so
`resolve_user_cloud` returned it and never consulted the parked record. Downstream:
`is_user_owned` False, `blocks_provisioning` False, and provisioning builds the pod on
hushh's compute and hushh's bill for somebody who had already proved their own project.
That is the same silent fallback `8fecfa991` closed, reached through a different door.

And `register_pending` returns early whenever a row already exists -- before the attach
-- so every later phone-verify stopped short of the retry it promised.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from hushh_mcp.services import user_cloud_service
from hushh_mcp.services.user_cloud_service import resolve_user_cloud

_USER = "uid-parked"
_PARKED = {
    "project_id": "alices-own-cloud",
    "region": "us-central1",
    "bootstrap_sa": "one-bootstrap@alices-own-cloud.iam.gserviceaccount.com",
    "authorized": True,
}


class _Registry:
    def __init__(self, row: Optional[dict]) -> None:
        self.row = row

    async def get(self, user_id: str) -> Optional[dict]:
        return self.row


def _park(monkeypatch, value: Optional[dict] = None, *, raises: bool = False) -> None:
    """Stand in for the setup-record read, which builds its own repo internally."""

    async def _parked(_user_id: str):
        if raises:
            raise RuntimeError("setup-record store unreachable")
        if value is None:
            return None
        return user_cloud_service.UserCloud(
            deployment_target="user_gcp",
            model_credential_mode="user_adc",
            project=value["project_id"],
            region=value["region"],
            bootstrap_sa=value["bootstrap_sa"],
            authorized=bool(value["authorized"]),
        )

    monkeypatch.setattr(user_cloud_service, "_parked_user_cloud", _parked)


async def test_a_row_without_a_cloud_still_finds_the_parked_one(monkeypatch):
    """The gap. A row existing is not the same as a row answering the question."""
    _park(monkeypatch, _PARKED)
    cloud = await resolve_user_cloud(_USER, repo=_Registry({"user_id": _USER, "status": "pending"}))

    assert cloud is not None
    assert cloud.project == "alices-own-cloud", "the person's proven cloud was ignored"
    assert cloud.is_user_owned is True
    assert cloud.is_ready_to_provision is True


async def test_the_pod_is_not_built_on_hushhs_cloud_while_theirs_sits_parked(monkeypatch):
    """The consequence, in the terms the orchestrator actually asks in.

    With the parked cloud unseen, `is_user_owned` was False and `blocks_provisioning`
    was False -- so nothing refused, and the pod was built on the deployment default.
    """
    _park(monkeypatch, dict(_PARKED, authorized=False))
    cloud = await resolve_user_cloud(_USER, repo=_Registry({"user_id": _USER, "status": "pending"}))

    assert cloud is not None
    assert cloud.blocks_provisioning is True, (
        "a person with an unauthorized cloud of their own was about to get hushh's"
    )


async def test_a_row_that_names_a_cloud_is_never_overridden(monkeypatch):
    """A recorded choice wins. The parked record is a waiting room, not an authority."""
    _park(monkeypatch, _PARKED)
    row = {
        "user_id": _USER,
        "deployment_target": "user_gcp",
        "model_credential_mode": "user_adc",
        "user_cloud_project": "the-attached-one",
        "user_cloud_region": "us-central1",
        "user_cloud_bootstrap_sa": "one-bootstrap@the-attached-one.iam.gserviceaccount.com",
        "user_cloud_authorized_at": "2026-09-04T00:00:00Z",
    }
    cloud = await resolve_user_cloud(_USER, repo=_Registry(row))

    assert cloud is not None
    assert cloud.project == "the-attached-one"


async def test_choosing_hushh_hosting_is_also_a_recorded_choice(monkeypatch):
    """`gcp` is an answer, not an absence.

    Gating on "the row names a target" rather than "the row names a USER cloud" is what
    keeps a stale parked record from dragging somebody back to BYOC after they chose
    hosting.
    """
    _park(monkeypatch, _PARKED)
    cloud = await resolve_user_cloud(
        _USER, repo=_Registry({"user_id": _USER, "deployment_target": "gcp"})
    )

    assert cloud is not None
    assert cloud.is_hosted is True
    assert cloud.project != "alices-own-cloud"


async def test_a_failed_parked_lookup_is_not_an_unknown_cloud(monkeypatch):
    """The regression the first version of this fix introduced.

    `_parked_user_cloud` builds its own repository and always reaches the real store,
    so letting its failure fall through to the outer handler turned every cloudless row
    into "we could not read this person's cloud" -- which REFUSES provisioning. That
    would have blocked every person who simply has not chosen a cloud yet.

    The registry answered here. Only the waiting room was unreachable, and that adds no
    doubt to a question already settled.
    """
    _park(monkeypatch, raises=True)
    cloud = await resolve_user_cloud(_USER, repo=_Registry({"user_id": _USER, "status": "pending"}))

    assert cloud is not None
    assert cloud.lookup_failed is False, "a failed waiting-room read became an unknown cloud"
    assert cloud.blocks_provisioning is False


async def test_a_failed_registry_read_is_still_unknown(monkeypatch):
    """The other side of that line, which must not move.

    When the REGISTRY cannot be read there is genuinely no answer, and provisioning
    must refuse rather than default to hushh's cloud (8fecfa991).
    """

    class _Exploding:
        async def get(self, user_id: str):
            raise RuntimeError("registry unreachable")

    _park(monkeypatch, _PARKED)
    cloud = await resolve_user_cloud(_USER, repo=_Exploding())

    assert cloud is not None
    assert cloud.lookup_failed is True
    assert cloud.blocks_provisioning is True


# -- the row eventually gets the cloud written onto it --------------------------


class _AttachRegistry(_Registry):
    """A registry whose row exists, plus a record of attach attempts."""

    def __init__(self, row: Optional[dict]) -> None:
        super().__init__(row)
        self.attached = 0

    async def set_user_cloud(self, **kwargs: Any) -> bool:
        self.attached += 1
        return True


@pytest.mark.asyncio
async def test_a_re_fired_phone_verify_retries_the_attach(monkeypatch):
    """Where the promised retry used to die.

    `register_pending` returns early whenever a row exists, and that return sat BEFORE
    the attach. So a cloud whose first attach failed stayed parked forever with nothing
    in the system trying again.
    """
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    from hushh_mcp.services import byoc_setup_job_service, personal_agent_provisioning_service

    calls: list[str] = []

    async def _attach(user_id: str, *, registry: Any) -> bool:
        calls.append(user_id)
        return True

    monkeypatch.setattr(byoc_setup_job_service, "attach_parked_cloud", _attach)

    registry = _AttachRegistry({"user_id": _USER, "hushh_id": "ha1_x", "status": "pending"})
    service = personal_agent_provisioning_service.PersonalAgentProvisioningService(
        registry=registry
    )
    result = await service.register_pending(user_id=_USER, phone_e164="+14155550123")

    assert calls == [_USER], "the early return skipped the retry it promised"
    assert result["status"] == "pending", "a re-fire must not change the row's state"


@pytest.mark.asyncio
async def test_a_row_that_already_has_its_cloud_does_no_extra_work(monkeypatch):
    """The common re-fire must stay cheap; there is nothing left to attach."""
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    from hushh_mcp.services import byoc_setup_job_service, personal_agent_provisioning_service

    calls: list[str] = []

    async def _attach(user_id: str, *, registry: Any) -> bool:
        calls.append(user_id)
        return True

    monkeypatch.setattr(byoc_setup_job_service, "attach_parked_cloud", _attach)

    registry = _AttachRegistry(
        {
            "user_id": _USER,
            "hushh_id": "ha1_x",
            "status": "provisioned",
            "user_cloud_project": "already-attached",
        }
    )
    service = personal_agent_provisioning_service.PersonalAgentProvisioningService(
        registry=registry
    )
    await service.register_pending(user_id=_USER, phone_e164="+14155550123")

    assert calls == []
