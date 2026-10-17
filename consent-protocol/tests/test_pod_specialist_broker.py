"""The broker reads a specialist for a pod only when a three-way binding holds.

The security of the data door is not the projection alone (that is pinned in
test_pod_data_door_projection). It is that a read happens ONLY when all three of
these are true at once, and the same 403 hides which one failed:

  1. the caller proved it is a pod (pod identity);
  2. it presented a live, correctly-scoped per-turn token; and
  3. that token's owner is the very person this pod IS (owner binding).

These probe ``broker_specialist_read`` directly with injected validator /
registry / reader seams, so the binding is tested without a database. The
sharpest test is the cross-owner one: person A's valid location scope, presented
to person B's pod, must NOT read A's holdings.
"""

from __future__ import annotations

import pytest

import api.routes.one.pod_specialist as broker
from hushh_mcp.services.pod_request_signing import VerifiedPod


@pytest.fixture
def shared_compatibility(monkeypatch):
    """Explicit legacy Shared helper contract; never an owner-cloud admission."""
    from unittest.mock import AsyncMock

    from hushh_mcp.services import owner_placement_guard as guard
    from hushh_mcp.services import personal_agent_hosting as hosting

    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    monkeypatch.setattr(hosting, "get_owner_hosting_mode", AsyncMock(return_value="shared"))
    monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value="shared"))


class _Parsed:
    def __init__(self, user_id: str, scope: str):
        self.user_id = user_id
        self.scope = scope


class _Request:
    """Minimal stand-in; verify_pod_request is monkeypatched, so the request
    object is never actually inspected."""


def _payload() -> broker.PodSpecialistReadRequest:
    return broker.PodSpecialistReadRequest(scopeToken="scope-jwt")


@pytest.fixture
def flags_on(monkeypatch):
    monkeypatch.setattr(broker, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(broker, "pod_data_door_enabled", lambda: True)


def _identity(monkeypatch, hushh_id):
    async def _verify(_request, _authorization):
        return VerifiedPod(hushh_id) if hushh_id else None

    monkeypatch.setattr(broker, "verify_pod_request", _verify)


def _validator(user_id="u-owner", scope="cap.location.live.view", valid=True):
    async def _check(_token, *, expected_scope=None):
        # The broker asks for the specialist's required scope; a real validator
        # would reject a token whose scope does not match. Model that.
        if expected_scope and scope != expected_scope:
            return (False, "scope_mismatch", None)
        if not valid:
            return (False, "revoked", None)
        return (True, None, _Parsed(user_id, scope))

    return _check


def _registry(mapping, status="provisioned"):
    class _Repo:
        async def get(self, user_id):
            hushh = mapping.get(user_id)
            return (
                {
                    "hushh_id": hushh,
                    "status": status,
                    "backend_metadata": {"serviceUid": "synthetic-current-service"},
                }
                if hushh
                else None
            )

    return _Repo()


def _reader(seen):
    def _run(name, *, owner_id):
        seen["name"] = name
        seen["owner_id"] = owner_id
        return {"recipients": [{"userId": "friend"}]}

    return _run


@pytest.mark.parametrize("failure", [None, "foreign_owner", "wrong_agent", "revoked_during_read"])
async def test_command_context_requires_exact_scope_owner_and_continuing_grant(
    flags_on, monkeypatch, failure, shared_compatibility
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    _identity(monkeypatch, "hushh-owner")
    read = AsyncMock(return_value={"projection": {"status": "observed"}, "observations": []})
    monkeypatch.setattr(broker, "read_command_projection", read)
    calls = 0

    async def check(token, *, expected_scope):
        nonlocal calls
        calls += 1
        assert expected_scope == "cap.location.command.read"
        return (
            failure != "revoked_during_read" or calls == 1,
            None,
            SimpleNamespace(
                user_id="other" if failure == "foreign_owner" else "u-owner",
                agent_id="other" if failure == "wrong_agent" else "personal_agent",
            ),
        )

    payload = broker.PodSpecialistReadRequest(
        scopeToken="synthetic", commandRead={"kind": "settings"}
    )

    async def run():
        return await broker.broker_specialist_read(
            _Request(),
            "location",
            "Bearer synthetic",
            payload,
            validator=check,
            registry=_registry({"u-owner": "hushh-owner", "other": "hushh-other"}),
        )

    if failure:
        with pytest.raises(broker.HTTPException) as exc:
            await run()
        assert exc.value.status_code == 403
        assert read.await_count == (1 if failure == "revoked_during_read" else 0)
    else:
        assert (await run())["state"]["projection"]["status"] == "observed"
        read.assert_awaited_once()


async def _call(monkeypatch, *, hushh_id, validator, registry, reader):
    return await broker.broker_specialist_read(
        _Request(),
        "location",
        "Bearer id-token",
        _payload(),
        validator=validator,
        registry=registry,
        reader=reader,
    )


@pytest.mark.asyncio
async def test_a_read_happens_when_all_three_bindings_hold(
    flags_on, monkeypatch, shared_compatibility
):
    _identity(monkeypatch, "hushh-owner")
    seen: dict = {}
    result = await _call(
        monkeypatch,
        hushh_id="hushh-owner",
        validator=_validator(user_id="u-owner"),
        registry=_registry({"u-owner": "hushh-owner"}),
        reader=_reader(seen),
    )
    assert result["name"] == "location"
    assert result["state"]["recipients"][0]["userId"] == "friend"
    # The read ran for the owner resolved from the TOKEN, never a pod-supplied id.
    assert seen["owner_id"] == "u-owner"


@pytest.mark.asyncio
async def test_person_a_scope_on_person_b_pod_is_refused(flags_on, monkeypatch):
    """The binding that matters most. The token is A's and valid; the pod is B's.
    A must not be read on B's pod."""
    _identity(monkeypatch, "hushh-person-B")
    seen: dict = {}
    with pytest.raises(broker.HTTPException) as exc:
        await _call(
            monkeypatch,
            hushh_id="hushh-person-B",
            validator=_validator(user_id="u-person-A"),
            registry=_registry({"u-person-A": "hushh-person-A"}),
            reader=_reader(seen),
        )
    assert exc.value.status_code == 403
    assert seen == {}, "no read may run when the owner binding fails"


@pytest.mark.asyncio
async def test_a_non_pod_caller_is_401(flags_on, monkeypatch):
    _identity(monkeypatch, None)  # verify_pod_request returns None for non-pods
    with pytest.raises(broker.HTTPException) as exc:
        await _call(
            monkeypatch,
            hushh_id=None,
            validator=_validator(),
            registry=_registry({"u-owner": "hushh-owner"}),
            reader=_reader({}),
        )
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_a_revoked_scope_is_403_and_reads_nothing(flags_on, monkeypatch):
    _identity(monkeypatch, "hushh-owner")
    seen: dict = {}
    with pytest.raises(broker.HTTPException) as exc:
        await _call(
            monkeypatch,
            hushh_id="hushh-owner",
            validator=_validator(valid=False),
            registry=_registry({"u-owner": "hushh-owner"}),
            reader=_reader(seen),
        )
    assert exc.value.status_code == 403
    assert seen == {}


@pytest.mark.asyncio
async def test_an_unreachable_authority_is_503_not_a_read(flags_on, monkeypatch):
    _identity(monkeypatch, "hushh-owner")

    async def _boom(_token, *, expected_scope=None):
        raise RuntimeError("db down")

    seen: dict = {}
    with pytest.raises(broker.HTTPException) as exc:
        await _call(
            monkeypatch,
            hushh_id="hushh-owner",
            validator=_boom,
            registry=_registry({"u-owner": "hushh-owner"}),
            reader=_reader(seen),
        )
    assert exc.value.status_code == 503
    assert seen == {}


@pytest.mark.asyncio
async def test_flag_off_is_404_the_door_does_not_exist(monkeypatch):
    monkeypatch.setattr(broker, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(broker, "pod_data_door_enabled", lambda: False)
    _identity(monkeypatch, "hushh-owner")
    with pytest.raises(broker.HTTPException) as exc:
        await _call(
            monkeypatch,
            hushh_id="hushh-owner",
            validator=_validator(),
            registry=_registry({"u-owner": "hushh-owner"}),
            reader=_reader({}),
        )
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_an_unknown_specialist_name_is_404(flags_on, monkeypatch):
    _identity(monkeypatch, "hushh-owner")
    with pytest.raises(broker.HTTPException) as exc:
        await broker.broker_specialist_read(
            _Request(),
            "vault",  # no door registered
            "Bearer id-token",
            _payload(),
            validator=_validator(),
            registry=_registry({"u-owner": "hushh-owner"}),
            reader=_reader({}),
        )
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_an_unresolvable_owner_binding_fails_closed(flags_on, monkeypatch):
    """The registry cannot resolve the token owner's HusshID -> refuse, never
    fall through to a read on an unbound owner."""
    _identity(monkeypatch, "hushh-owner")
    seen: dict = {}
    with pytest.raises(broker.HTTPException) as exc:
        await _call(
            monkeypatch,
            hushh_id="hushh-owner",
            validator=_validator(user_id="u-owner"),
            registry=_registry({}),  # no row for u-owner
            reader=_reader(seen),
        )
    assert exc.value.status_code == 403
    assert seen == {}


@pytest.mark.parametrize(
    "status",
    [
        "migrating",
        "suspended",
        "provisioning",
        "connecting",
        "provisioning_failed",
        "needs_reinit",
        "reaped",
        "erasing",
        "unknown",
        None,
    ],
)
async def test_nonserving_owner_never_reaches_specialist_reader(flags_on, monkeypatch, status):
    _identity(monkeypatch, "hushh-owner")
    seen = {}
    with pytest.raises(broker.HTTPException) as exc:
        await _call(
            monkeypatch,
            hushh_id="hushh-owner",
            validator=_validator(),
            registry=_registry({"u-owner": "hushh-owner"}, status=status),
            reader=_reader(seen),
        )
    assert exc.value.status_code == 403
    assert seen == {}


async def test_registry_failure_is_unavailable_and_never_reaches_reader(flags_on, monkeypatch):
    _identity(monkeypatch, "hushh-owner")

    class Broken:
        async def get(self, _user_id):
            raise RuntimeError("synthetic-private-database-address")

    seen = {}
    with pytest.raises(broker.HTTPException) as exc:
        await _call(
            monkeypatch,
            hushh_id="hushh-owner",
            validator=_validator(),
            registry=Broken(),
            reader=_reader(seen),
        )
    assert exc.value.status_code == 503
    assert exc.value.detail == "consent authority is unavailable"
    assert seen == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("pod_owner", ["hushh-owner", "foreign-owner"])
async def test_calendar_options_reach_reader_only_after_owner_binding(
    flags_on, monkeypatch, pod_owner, shared_compatibility
):
    from unittest.mock import AsyncMock

    _identity(monkeypatch, pod_owner)
    reader = AsyncMock(return_value={"connected": True})
    payload = broker.PodSpecialistReadRequest.model_validate(
        {
            "scopeToken": "synthetic-scope",
            "calendarRead": {
                "operation": "availability",
                "start_at": "2026-10-01T00:00:00Z",
                "end_at": "2026-10-02T00:00:00Z",
            },
        }
    )
    args = (_Request(), "calendar", "Bearer synthetic", payload)
    kwargs = dict(
        validator=_validator(scope="cap.calendar.events.view"),
        registry=_registry({"u-owner": "hushh-owner"}),
        reader=reader,
    )
    if pod_owner != "hushh-owner":
        with pytest.raises(broker.HTTPException) as exc:
            await broker.broker_specialist_read(*args, **kwargs)
        assert exc.value.status_code == 403
        reader.assert_not_called()
    else:
        await broker.broker_specialist_read(*args, **kwargs)
        reader.assert_awaited_once_with(
            "calendar", owner_id="u-owner", calendar_read=payload.calendar_read
        )


@pytest.mark.parametrize("foreign", [False, True])
async def test_nav_read_requires_its_scope_and_serving_owner(
    flags_on, monkeypatch, foreign, shared_compatibility
):
    from unittest.mock import AsyncMock

    from fastapi import HTTPException

    _identity(monkeypatch, "other-pod" if foreign else "hushh-owner")
    reader = AsyncMock(return_value={"active": {"items": [], "total": 0}})
    kwargs = dict(
        validator=_validator(scope="agent.nav.review"),
        registry=_registry({"u-owner": "hushh-owner"}),
        reader=reader,
    )
    if foreign:
        with pytest.raises(HTTPException) as error:
            await broker.broker_specialist_read(
                _Request(), "nav", "Bearer synthetic", _payload(), **kwargs
            )
        assert error.value.status_code == 403
        reader.assert_not_called()
    else:
        result = await broker.broker_specialist_read(
            _Request(), "nav", "Bearer synthetic", _payload(), **kwargs
        )
        assert result["name"] == "nav"
        reader.assert_awaited_once_with("nav", owner_id="u-owner")


@pytest.mark.parametrize("case", ["allowed", "foreign", "revoked", "wrong_scope"])
@pytest.mark.parametrize(
    "name,options_key,operation,scope",
    [
        ("marketplace", "marketplaceRead", "published", "cap.pkm.marketplace.view"),
        ("email", "emailRead", "search", "cap.email.inbox.view"),
    ],
)
async def test_scoped_broker_requires_live_owner_view_before_reader(
    monkeypatch, flags_on, case, name, options_key, operation, scope, shared_compatibility
):
    from unittest.mock import AsyncMock

    from fastapi import HTTPException

    _identity(monkeypatch, "pod-owner")
    read = AsyncMock(return_value={"items": []})
    options = {"operation": operation}
    if name == "email":
        options["query"] = "subject:invoice"
    payload = broker.PodSpecialistReadRequest(scopeToken="scope-jwt", **{options_key: options})
    kwargs = dict(
        validator=_validator(
            scope="cap.pkm.marketplace.manage" if case == "wrong_scope" else scope,
            valid=case != "revoked",
        ),
        registry=_registry({"u-owner": "other-pod" if case == "foreign" else "pod-owner"}),
        reader=read,
    )
    if case != "allowed":
        with pytest.raises(HTTPException) as exc:
            await broker.broker_specialist_read(_Request(), name, "Bearer pod", payload, **kwargs)
        assert exc.value.status_code == 403
        read.assert_not_awaited()
    else:
        result = await broker.broker_specialist_read(
            _Request(), name, "Bearer pod", payload, **kwargs
        )
        assert result == {"name": name, "state": {"items": []}}
        assert read.await_args.kwargs["owner_id"] == "u-owner"
        assert read.await_args.kwargs[f"{name}_read"].operation == operation


@pytest.mark.parametrize("change", [None, "revocation", "replacement", "erasure"])
async def test_mail_metadata_rechecks_scope_and_incarnation_after_read(
    flags_on, monkeypatch, change, shared_compatibility
):
    from unittest.mock import AsyncMock

    _identity(monkeypatch, "hushh-owner")
    changed = False

    class Registry:
        async def get(self, user_id):
            assert user_id == "u-owner"
            return {
                "hushh_id": "hushh-owner",
                "status": "provisioned",
                "backend_metadata": {
                    "serviceUid": "replacement"
                    if changed and change == "replacement"
                    else "original",
                    **({"erasure": {}} if changed and change == "erasure" else {}),
                },
            }

    async def validate(token, *, expected_scope):
        assert expected_scope == "cap.email.inbox.view"
        return not (changed and change == "revocation"), None, _Parsed("u-owner", expected_scope)

    async def read(owner_id, options, *, context, require_access):
        nonlocal changed
        assert context.owner_id == owner_id == "u-owner"
        assert context.service_uid == "original"
        await require_access()
        changed = True
        return {"metadata": "synthetic"}

    reader = AsyncMock(side_effect=read)
    monkeypatch.setattr("hushh_mcp.services.pod_email_read.read_email_metadata", reader)
    request = broker.PodSpecialistReadRequest(
        scopeToken="synthetic", emailRead={"operation": "list_recent"}
    )
    call = broker.broker_specialist_read(
        _Request(),
        "email",
        "Bearer synthetic",
        request,
        validator=validate,
        registry=Registry(),
    )
    if change:
        with pytest.raises(broker.HTTPException) as error:
            await call
        assert error.value.status_code == 403
    else:
        assert (await call)["state"] == {"metadata": "synthetic"}
    reader.assert_awaited_once()


@pytest.mark.parametrize(
    "mode,status",
    [("byoc", 404), ("pending", 404), ("unplaced", 404), ("hussh_pods", 404), ("unknown", 503)],
)
async def test_private_or_unknown_placement_never_reopens_specialist_reader(
    flags_on, monkeypatch, mode, status
):
    from unittest.mock import AsyncMock

    from hushh_mcp.services import personal_agent_hosting as hosting

    _identity(monkeypatch, "hushh-owner")
    read = AsyncMock()
    monkeypatch.setattr(hosting, "get_owner_hosting_mode", AsyncMock(return_value=mode))
    with pytest.raises(broker.HTTPException) as error:
        await _call(
            monkeypatch,
            hushh_id="hushh-owner",
            validator=_validator(),
            registry=_registry({"u-owner": "hushh-owner"}),
            reader=read,
        )
    assert error.value.status_code == status
    read.assert_not_called()


@pytest.mark.parametrize("mode,status", [("byoc", 404), ("unknown", 503)])
async def test_placement_move_during_specialist_read_never_returns_projection(
    flags_on, monkeypatch, mode, status
):
    from unittest.mock import AsyncMock

    from hushh_mcp.services import personal_agent_hosting as hosting

    _identity(monkeypatch, "hushh-owner")
    placement = AsyncMock(return_value="shared")
    monkeypatch.setattr(hosting, "get_owner_hosting_mode", placement)

    async def read(name, *, owner_id):
        placement.return_value = mode
        return {"synthetic_owner_information": "must not leave after placement moves"}

    with pytest.raises(broker.HTTPException) as error:
        await _call(
            monkeypatch,
            hushh_id="hushh-owner",
            validator=_validator(),
            registry=_registry({"u-owner": "hushh-owner"}),
            reader=read,
        )
    assert error.value.status_code == status


@pytest.mark.parametrize(
    "change,status",
    [
        (None, None),
        ("revoked", 403),
        ("foreign_owner", 403),
        ("wrong_scope", 403),
        ("pod_replaced", 403),
        ("incarnation_replaced", 403),
        ("erasure", 403),
        ("consent_unavailable", 503),
        ("registry_unavailable", 503),
    ],
)
async def test_generic_specialist_rechecks_fixed_grant_and_serving_incarnation_after_read(
    flags_on, monkeypatch, shared_compatibility, change, status
):
    from unittest.mock import AsyncMock

    _identity(monkeypatch, "hushh-owner")
    changed = False
    checks = []

    class Registry:
        async def get(self, owner_id):
            assert owner_id == "u-owner"
            if changed and change == "registry_unavailable":
                raise RuntimeError("synthetic authority outage")
            return {
                "hushh_id": "replacement"
                if changed and change == "pod_replaced"
                else "hushh-owner",
                "status": "provisioned",
                "backend_metadata": {
                    "serviceUid": "replacement-service"
                    if changed and change == "incarnation_replaced"
                    else "original-service",
                    **({"erasure": {}} if changed and change == "erasure" else {}),
                },
            }

    async def validate(token, *, expected_scope):
        checks.append((token, expected_scope))
        assert token == "scope-jwt" and expected_scope == "cap.location.live.view"
        if changed and change == "consent_unavailable":
            raise RuntimeError("synthetic consent outage")
        actual_scope = "foreign.scope" if changed and change == "wrong_scope" else expected_scope
        valid = not (changed and change == "revoked") and actual_scope == expected_scope
        return (
            valid,
            None,
            _Parsed(
                "foreign" if changed and change == "foreign_owner" else "u-owner", actual_scope
            ),
        )

    async def read(name, *, owner_id):
        nonlocal changed
        assert name == "location" and owner_id == "u-owner"
        changed = True
        return {"recipients": [{"userId": "synthetic-friend"}]}

    reader = AsyncMock(side_effect=read)
    call = _call(
        monkeypatch, hushh_id="hushh-owner", validator=validate, registry=Registry(), reader=reader
    )
    if status is None:
        assert (await call)["state"] == {"recipients": [{"userId": "synthetic-friend"}]}
    else:
        with pytest.raises(broker.HTTPException) as error:
            await call
        assert error.value.status_code == status
    reader.assert_awaited_once()
    assert checks == [("scope-jwt", "cap.location.live.view")] * 2
