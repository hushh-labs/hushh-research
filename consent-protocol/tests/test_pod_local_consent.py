"""An owner-cloud agent judges Ed25519 consent tokens itself, against a signed list.

Every case runs the real signer, the real verifier and the real revocation list; only
the hub client is replaced, and in the local cases it raises if it is asked at all.
"""

from __future__ import annotations

import base64
import sys
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.consent import token_signing  # noqa: E402
from hushh_mcp.services import pod_consent_revocation as revocation  # noqa: E402
from hushh_mcp.services.pod_consent_client import (  # noqa: E402
    require_owner_scope,
    verify_consent,
)

OWNER = "owner-uid"
POD = "ha1_owner_pod"
SCOPE = "attr.preferences.travel.*"
BINDING = revocation.RevocationBinding(POD, "uat", "pod-0123456789abcdef", 1)


def _seed() -> str:
    raw = Ed25519PrivateKey.generate().private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    return base64.b64encode(raw).decode()


@pytest.fixture
def keys(monkeypatch):
    """One process plays the hub (private keys) and the pod (derived public keys)."""
    monkeypatch.setenv("HUSSH_ID", POD)
    monkeypatch.setenv("CONSENT_ED25519_PRIVATE_KEY", _seed())
    monkeypatch.setenv("OWNER_FEED_ED25519_PRIVATE_KEY", _seed())
    monkeypatch.delenv("CONSENT_ED25519_PUBLIC_KEYS", raising=False)
    monkeypatch.delenv("OWNER_FEED_ED25519_PUBLIC_KEYS", raising=False)
    token_signing.reset_caches()
    revocation.clear_installed_revocation_list()
    from hushh_mcp.services import pod_session_authority

    async def held():
        return None

    authority = SimpleNamespace(
        hushh_id=POD, environment="uat", pod_key_id=BINDING.pod_key_id, epoch=1, require_held=held
    )
    monkeypatch.setattr(pod_session_authority, "active_session_authority", lambda: authority)
    yield authority
    token_signing.reset_caches()
    revocation.clear_installed_revocation_list()


def _now() -> int:
    return int(time.time() * 1000)


def _token(
    *,
    user=OWNER,
    agent="personal_agent",
    scope=SCOPE,
    ttl_ms=600_000,
    hmac=False,
    issued=None,
    commercial=False,
):
    issued = _now() if issued is None else issued
    raw = f"{user}|{agent}|{scope}|{issued}|{issued + ttl_ms}"
    if commercial:
        raw += "|commercial"
    if hmac:
        signature = token_signing.hmac_signature(raw, "hub-symmetric-key")
    else:
        signature = token_signing.sign_payload(raw, hmac_key="", require_asymmetric=True)
    return f"HCT:{base64.urlsafe_b64encode(raw.encode()).decode()}.{signature}"


def _install(*, revoked=(), live=(), issued_at_ms=None, owner=OWNER, hushh_id=POD):
    doc = revocation.sign_revocation_list(
        owner_id=owner,
        hushh_id=hushh_id,
        binding=replace(BINDING, hushh_id=hushh_id),
        revoked=revoked,
        live=[revocation.token_fingerprint(token) for token in live],
        issued_at_ms=_now() if issued_at_ms is None else issued_at_ms,
    )
    return revocation.install_revocation_list(doc)


class _HubNeverAsked:
    def post(self, *_a, **_k):
        raise AssertionError("the hub was asked about a token the agent can judge")


class _HubSaysValid:
    def __init__(self):
        self.asked = 0

    def post(self, *_a, **_k):
        self.asked += 1
        return type(
            "R",
            (),
            {
                "status_code": 200,
                "json": lambda _s: {"valid": True, "userId": OWNER, "hushhId": POD},
            },
        )()


async def test_an_ed25519_token_is_verified_inside_the_agent_and_never_sent_to_the_hub(keys):
    token = _token()
    assert _install(live=[token])
    verdict = await verify_consent(token, expected_scope=SCOPE, client=_HubNeverAsked())
    assert verdict.valid and verdict.available
    assert (verdict.user_id, verdict.hushh_id, verdict.scope) == (OWNER, POD, SCOPE)


async def test_require_owner_scope_admits_a_locally_verified_token(keys):
    token = _token()
    _install(live=[token])

    async def local(tok, *, expected_scope):
        return await verify_consent(tok, expected_scope=expected_scope, client=_HubNeverAsked())

    verdict = await require_owner_scope(token, expected_scope=SCOPE, user_id=OWNER, verifier=local)
    assert verdict.hushh_id == POD


async def test_a_revoked_token_is_refused_as_a_clean_denial(keys):
    token = _token()
    _install(revoked=[revocation.token_fingerprint(token)])
    verdict = await verify_consent(token, expected_scope=SCOPE, client=_HubNeverAsked())
    assert verdict.should_refuse and verdict.reason == "consent has been revoked"


async def test_a_stale_list_is_unavailable_never_valid(keys):
    _install(issued_at_ms=_now() - revocation.MAX_AGE_MS - 1_000)
    verdict = await verify_consent(_token(), expected_scope=SCOPE, client=_HubNeverAsked())
    assert not verdict.valid and not verdict.available


async def test_scope_owner_expiry_and_signature_are_all_checked_locally(keys):
    good, someone_else = _token(), _token(user="someone-else")
    _install(live=[good, someone_else])
    hub = _HubNeverAsked()
    wrong_scope = await verify_consent(good, expected_scope="cap.email.inbox.view", client=hub)
    assert wrong_scope.should_refuse
    other_owner = await verify_consent(someone_else, expected_scope=SCOPE, client=hub)
    assert other_owner.should_refuse and other_owner.reason == "token names another owner"
    expired = await verify_consent(_token(ttl_ms=-1), expected_scope=SCOPE, client=hub)
    assert expired.should_refuse
    forged = good[: good.rindex(".") + 1] + base64.urlsafe_b64encode(b"x" * 64).decode().rstrip("=")
    assert (await verify_consent(forged, expected_scope=SCOPE, client=hub)).should_refuse


async def test_a_token_with_no_live_grant_is_refused_like_the_hub_refuses_it(keys):
    """Minted well before the list, yet absent from it: the hub refuses it, so do we."""
    _install(live=[_token(ttl_ms=600_001)])  # another grant of the same pair is live
    before = _token(issued=_now() - 5 * 60 * 1000)
    verdict = await verify_consent(before, expected_scope=SCOPE, client=_HubNeverAsked())
    assert verdict.should_refuse and verdict.reason == "consent is not active"


async def test_a_token_minted_after_the_list_goes_to_the_hub_never_a_local_denial(keys):
    """A standing grant re-minted for this turn, or one the owner just approved."""
    assert _install(issued_at_ms=_now() - 30_000)
    hub = _HubSaysValid()
    after = await verify_consent(_token(), expected_scope=SCOPE, client=hub)
    assert after.valid and after.available and hub.asked == 1
    # Minted a moment before the list was read, committed just after: also not heard of.
    assert _install(issued_at_ms=_now() + 1_000)
    racing = await verify_consent(_token(issued=_now() - 60_000), expected_scope=SCOPE, client=hub)
    assert racing.valid and hub.asked == 2


def _public_b64(seed_b64: str) -> str:
    private = Ed25519PrivateKey.from_private_bytes(base64.b64decode(seed_b64))
    raw = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return base64.b64encode(raw).decode()


async def test_a_key_the_agent_does_not_hold_goes_to_the_hub_never_a_local_denial(
    keys, monkeypatch
):
    """An Azure placement without the consent public keys, or a rotated hub key."""
    token = _token()
    _install(live=[token])
    monkeypatch.delenv("CONSENT_ED25519_PRIVATE_KEY")
    monkeypatch.setenv(
        "CONSENT_ED25519_PUBLIC_KEYS", f'{{"hushh-consent-9": "{_public_b64(_seed())}"}}'
    )
    token_signing.reset_caches()
    hub = _HubSaysValid()
    verdict = await verify_consent(token, expected_scope=SCOPE, client=hub)
    assert verdict.valid and verdict.available and hub.asked == 1
    # A stale list does not change that: a missing key is the hub's to judge.
    revocation.clear_installed_revocation_list()
    assert _install(live=[token], issued_at_ms=_now() - revocation.MAX_AGE_MS - 1_000)
    stale = await verify_consent(token, expected_scope=SCOPE, client=hub)
    assert stale.valid and hub.asked == 2


async def test_hmac_tokens_internal_principals_and_no_list_keep_the_hub_path(keys):
    hub = _HubSaysValid()
    # No list installed yet: transitional, the hub still answers.
    assert (await verify_consent(_token(), expected_scope=SCOPE, client=hub)).valid
    _install()
    assert (await verify_consent(_token(hmac=True), expected_scope=SCOPE, client=hub)).valid
    assert (await verify_consent(_token(agent="self"), expected_scope=SCOPE, client=hub)).valid
    assert hub.asked == 3


def test_a_list_for_another_pod_or_signed_by_another_key_is_refused(keys, monkeypatch):
    with pytest.raises(revocation.RevocationListRefused) as wrong:
        _install(hushh_id="ha1_someone_else")
    assert wrong.value.code == "WRONG_POD"
    doc = revocation.sign_revocation_list(
        owner_id=OWNER, hushh_id=POD, binding=BINDING, revoked=[], issued_at_ms=_now()
    )
    monkeypatch.setenv("OWNER_FEED_ED25519_PRIVATE_KEY", _seed())
    token_signing.reset_caches()
    with pytest.raises(revocation.RevocationListRefused) as forged:
        revocation.install_revocation_list(doc)
    assert forged.value.code == "BAD_SIGNATURE"
    tampered = {"list": {**doc["list"], "revoked": []}, "signature": "deadbeef" * 8}
    with pytest.raises(revocation.RevocationListRefused):
        revocation.install_revocation_list(tampered)


def test_an_older_list_never_replaces_a_newer_one(keys):
    token = _token()
    now = _now()
    assert _install(revoked=[revocation.token_fingerprint(token)], issued_at_ms=now)
    assert not _install(revoked=[], issued_at_ms=now - 1_000), "a replay must not un-revoke"
    held = revocation.installed_revocation_list()
    assert held is not None and revocation.token_fingerprint(token) in held.revoked


def test_the_hub_builder_lists_superseded_and_revoked_grants_only(keys):
    latest = [
        {
            "agent_id": "personal_agent",
            "scope": SCOPE,
            "action": "CONSENT_GRANTED",
            "token_id": "t2",
        },
        {"agent_id": "app", "scope": "cap.email.inbox.view", "action": "REVOKED", "token_id": None},
    ]
    grants = [
        {"agent_id": "personal_agent", "scope": SCOPE, "token_id": "t1"},
        {"agent_id": "personal_agent", "scope": SCOPE, "token_id": "t2"},
        {"agent_id": "app", "scope": "cap.email.inbox.view", "token_id": "t3"},
    ]
    revoked, live = revocation.split_fingerprints(latest, grants)
    assert revoked == {revocation.token_fingerprint("t1"), revocation.token_fingerprint("t3")}
    assert live == {revocation.token_fingerprint("t2")}
    assert revocation.revoked_fingerprints(latest, grants) == revoked
    # A denial breaks lineage only for personal_agent, exactly as is_token_active reads it.
    assert "action = 'CONSENT_DENIED' AND agent_id = 'personal_agent'" in revocation._LATEST_SQL


async def test_the_built_list_round_trips_into_the_agent(keys):
    def reader(owner, now_ms):
        assert owner == OWNER
        return (
            [{"agent_id": "a", "scope": SCOPE, "action": "REVOKED", "token_id": None}],
            [{"agent_id": "a", "scope": SCOPE, "token_id": "gone"}],
        )

    doc = await revocation.build_consent_revocation_list(OWNER, POD, binding=BINDING, reader=reader)
    assert revocation.install_revocation_list(doc)
    held = revocation.installed_revocation_list()
    assert held is not None and held.revoked == {revocation.token_fingerprint("gone")}
    assert held.live == frozenset()


async def test_an_oversize_ledger_raises_rather_than_truncating(keys):
    def reader(_owner, _now_ms):
        return [], [{"agent_id": "a", "scope": SCOPE, "token_id": f"t{i}"} for i in range(5001)]

    with pytest.raises(RuntimeError):
        await revocation.build_consent_revocation_list(OWNER, POD, binding=BINDING, reader=reader)


def test_the_owner_feed_namespace_has_its_own_keys():
    names = (
        token_signing.OWNER_FEED.private_key_env,
        token_signing.OWNER_FEED.public_keys_env,
        token_signing.OWNER_FEED.alg_env,
        token_signing.OWNER_FEED.kid_env,
    )
    for other in (token_signing.CONSENT_TOKENS, token_signing.CONSENT_AUDIT):
        assert not set(names) & {
            other.private_key_env,
            other.public_keys_env,
            other.alg_env,
            other.kid_env,
        }


class _HubDenies:
    def __init__(self):
        self.asked = 0

    def post(self, *_a, **_k):
        self.asked += 1
        return SimpleNamespace(status_code=200, json=lambda: {"valid": False})


@pytest.mark.parametrize(
    "options",
    [{"scope": "cap.one.invoke"}, {"scope": "attr.wallet.summary.*"}, {"commercial": True}],
)
async def test_reserved_and_paid_grants_keep_canonical_policy_even_when_snapshot_says_live(
    keys, options
):
    token = _token(**options)
    _install(live=[token])
    hub = _HubDenies()
    verdict = await verify_consent(token, expected_scope=options.get("scope", SCOPE), client=hub)
    assert verdict.should_refuse and hub.asked == 1


@pytest.mark.parametrize(
    "changed", [{"epoch": 2}, {"pod_key_id": "pod-other"}, {"environment": "prod"}]
)
async def test_snapshot_cannot_authorize_another_incarnation_or_deployment(keys, changed):
    token = _token()
    _install(live=[token])  # positive control: exact current binding authorizes locally
    assert (await verify_consent(token, expected_scope=SCOPE, client=_HubNeverAsked())).valid
    for key, value in changed.items():
        setattr(keys, key, value)
    hub = _HubDenies()
    assert (await verify_consent(token, expected_scope=SCOPE, client=hub)).should_refuse
    assert hub.asked == 1 and revocation.installed_revocation_list() is None
    with pytest.raises(revocation.RevocationListRefused, match="WRONG_INCARNATION"):
        _install(live=[token])


async def test_a_fenced_or_unreadable_owner_lease_cannot_use_a_fresh_snapshot(keys):
    token = _token()
    _install(live=[token])
    assert (await verify_consent(token, expected_scope=SCOPE, client=_HubNeverAsked())).valid

    async def fenced():
        raise RuntimeError("fenced")

    keys.require_held = fenced
    verdict = await verify_consent(token, expected_scope=SCOPE, client=_HubNeverAsked())
    assert not verdict.valid and not verdict.available


async def test_a_canonical_response_cannot_revive_a_worker_fenced_during_the_request(keys):
    async def fenced():
        raise RuntimeError("fenced")

    class Hub(_HubSaysValid):
        def post(self, *args, **kwargs):
            keys.require_held = fenced
            return super().post(*args, **kwargs)

    hub = Hub()
    verdict = await verify_consent(_token(commercial=True), expected_scope=SCOPE, client=hub)
    assert hub.asked == 1 and not verdict.valid and not verdict.available


async def test_a_conflicting_equal_time_snapshot_cannot_replace_authority(keys):
    token, now = _token(), _now()
    assert _install(live=[token], issued_at_ms=now)
    assert not _install(live=[token], issued_at_ms=now)
    with pytest.raises(revocation.RevocationListRefused, match="CONFLICTING_REPLAY"):
        _install(revoked=[revocation.token_fingerprint(token)], issued_at_ms=now)
    assert revocation.installed_revocation_list() is None
    hub = _HubDenies()
    assert (await verify_consent(token, expected_scope=SCOPE, client=hub)).should_refuse
    assert hub.asked == 1
    assert not _install(live=[token], issued_at_ms=now - 1)
    assert not _install(live=[token], issued_at_ms=now)
    assert revocation.installed_revocation_list() is None
    assert _install(live=[token], issued_at_ms=now + 1)
    assert revocation.installed_revocation_list() is not None
