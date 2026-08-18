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


class _Parsed:
    def __init__(self, user_id: str, scope: str):
        self.user_id = user_id
        self.scope = scope


class _Request:
    """Minimal stand-in; verify_pod_identity is monkeypatched, so the request
    object is never actually inspected."""


def _payload() -> broker.PodSpecialistReadRequest:
    return broker.PodSpecialistReadRequest(scopeToken="scope-jwt")


@pytest.fixture
def flags_on(monkeypatch):
    monkeypatch.setattr(broker, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(broker, "pod_data_door_enabled", lambda: True)


def _identity(monkeypatch, hushh_id):
    async def _verify(_request, _authorization):
        return hushh_id

    monkeypatch.setattr(broker, "verify_pod_identity", _verify)


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


def _registry(mapping):
    class _Repo:
        async def get(self, user_id):
            hushh = mapping.get(user_id)
            return {"hushh_id": hushh} if hushh else None

    return _Repo()


def _reader(seen):
    def _run(name, *, owner_id):
        seen["name"] = name
        seen["owner_id"] = owner_id
        return {"recipients": [{"userId": "friend"}]}

    return _run


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
async def test_a_read_happens_when_all_three_bindings_hold(flags_on, monkeypatch):
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
    _identity(monkeypatch, None)  # verify_pod_identity returns None for non-pods
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
