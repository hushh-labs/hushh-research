"""The agent mints its own Google access tokens: narrowed, cached, single flight, honest.

Each behaviour carries its negative control: a scope never granted is refused before
Google is asked, a cached token is reused until 90 seconds before it expires, ten
concurrent asks cost one refresh, ``invalid_grant`` turns into ``needs_reauth`` in the
log, a rotated refresh token becomes the next generation, and no token, secret or
code ever reaches a log line.
"""

# ruff: noqa: S106, S107 -- token strings here are synthetic fixtures, not credentials.
from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any

import pytest

from hushh_mcp.services import google_connector_transition as transition
from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services import pod_google_oauth as google
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_connector_credential_seal import OpenedConnectorCredential
from hushh_mcp.services.pod_connector_tokens import (
    NEEDS_REAUTH,
    NOT_CONNECTED,
    SCOPE_NOT_GRANTED,
    ConnectorTokenError,
    PodGoogleTokenSource,
)

OWNER = "ha1_token_owner"
CLIENT = "123456789012-abcdefghijklmnop.apps.googleusercontent.com"
REFRESH = "1//refresh-secret-never-logged"
G = "https://www.googleapis.com/auth/"
READ_GMAIL = G + "gmail.readonly"


class _Google:
    """Google's token endpoint, answering from a script and remembering every form."""

    def __init__(self, *answers: tuple[int, dict]) -> None:
        self.answers = list(answers)
        self.forms: list[dict] = []

    async def __call__(self, url: str, form: Any) -> tuple[int, dict]:
        assert url == google.TOKEN_URL
        self.forms.append(dict(form))
        await asyncio.sleep(0)
        return self.answers.pop(0) if self.answers else _ok()


def _ok(token: str = "ya29.access-secret", scope: str = READ_GMAIL, **extra: Any) -> tuple:
    return 200, {"access_token": token, "expires_in": 3600, "scope": scope, **extra}


@pytest.fixture
async def log(monkeypatch, tmp_path):
    monkeypatch.setenv("HUSSH_ID", OWNER)
    monkeypatch.setenv("GOOGLE_IOS_CONNECTOR_CLIENT_ID", CLIENT)
    commit_log = PodCommitLog(LocalObjectStore(str(tmp_path / "s")), b"\x07" * 32, owner_id=OWNER)
    store.set_active_connector_credentials({})
    yield commit_log
    store.set_active_connector_credentials({})


async def _connect(
    log,
    scopes: tuple[str, ...] = (READ_GMAIL,),
    connector: str = "gmail",
    *,
    issued: int = 1,
    credential_id: str = "3b9f6a0e-7c2d-4e1f-9a8b-5c4d3e2f1a0b",
):
    opened = OpenedConnectorCredential(
        kind="authorization_code",
        connector_id=connector,
        provider="google",
        credential_id=credential_id,
        issued_at_ms=issued,
        client_profile="hussh_ios",
        client_id=CLIENT,
        scopes=scopes,
    )
    return await store.record_connector_credential(
        log,
        hushh_id=OWNER,
        opened=opened,
        account_subject="1234567890",
        granted_scopes=scopes,
        refresh_token=REFRESH,
        now_ms=1,
    )


def _source(log, post, clock=lambda: 1000.0) -> PodGoogleTokenSource:
    return PodGoogleTokenSource(log_resolver=lambda: log, post=post, clock=clock)


@pytest.mark.parametrize("outcome", ["revoked", "fresh", "unavailable"])
async def test_transition_validates_provider_grants_without_cached_or_time_authority(
    log, monkeypatch, outcome
):
    held = await _connect(log)
    answer = {
        "revoked": (400, {"error": "invalid_grant"}),
        "fresh": _ok(),
        "unavailable": (503, {}),
    }[outcome]
    fake = _Google(answer)
    source = _source(log, fake)
    source._cache[("gmail", (READ_GMAIL,))] = (
        held.credential_id,
        held.generation,
        "cached-old-bearer",
        10_000,
    )
    monkeypatch.setattr(
        "hushh_mcp.services.pod_connector_tokens.google_token_source", lambda: source
    )
    admission = {
        "reauthAccounts": [hashlib.sha256(held.account_subject.encode()).hexdigest()],
        "revokedAtMs": 999_999_999_999,
    }
    if outcome == "unavailable":
        with pytest.raises(transition.TransitionRefused):
            await transition.invalidate_pod_grants(log, hushh_id=OWNER, admission=admission)
    else:
        await transition.invalidate_pod_grants(log, hushh_id=OWNER, admission=admission)
    assert len(fake.forms) == 1, "even a cached bearer must be checked at Google"
    current = store.active_connector_credential("gmail")
    assert current.status == (
        store.STATUS_NEEDS_REAUTH if outcome == "revoked" else store.STATUS_CONNECTED
    )
    if outcome == "fresh":
        await transition.invalidate_pod_grants(log, hushh_id=OWNER, admission=admission)
        assert store.active_connector_credential("gmail") == held, (
            "a fresh sibling survives every retry"
        )
    else:
        assert source._cache == {}


async def test_transition_refusal_cannot_retire_a_concurrent_fresh_credential(log):
    old = await _connect(log)

    async def post(_url, _form):
        await _connect(log, issued=2, credential_id="3b9f6a0e-7c2d-4e1f-9a8b-5c4d3e2f1a0c")
        return 400, {"error": "invalid_grant"}

    await _source(log, post).validate_current(old)
    assert store.active_connector_credential("gmail").status == store.STATUS_CONNECTED
    assert store.active_connector_credential("gmail").credential_id != old.credential_id


async def test_transition_blocks_if_a_revoked_generation_cannot_be_fenced(log, monkeypatch):
    held = await _connect(log)

    async def unavailable(*args, **kwargs):
        return None

    monkeypatch.setattr(store, "advance_credential", unavailable)
    with pytest.raises(ConnectorTokenError) as refusal:
        await _source(log, _Google((400, {"error": "invalid_grant"}))).validate_current(held)
    assert refusal.value.code == "CREDENTIALS_UNAVAILABLE"


async def test_a_refresh_is_narrowed_to_the_level_and_needs_no_client_secret(log, caplog):
    caplog.set_level(logging.DEBUG)
    await _connect(log, scopes=(READ_GMAIL, G + "gmail.modify"))
    fake = _Google()

    token = await _source(log, fake).access_token("gmail", "read")

    assert token == "ya29.access-secret"
    (form,) = fake.forms
    assert form == {
        "grant_type": "refresh_token",
        "client_id": CLIENT,
        "refresh_token": REFRESH,
        "scope": READ_GMAIL,
    }, "narrowed to the read scope; a native client sends no secret"
    for secret in (REFRESH, "ya29.access-secret"):
        assert secret not in caplog.text


async def test_a_level_never_granted_is_refused_before_google_is_asked(log):
    await _connect(log)
    fake = _Google()
    with pytest.raises(ConnectorTokenError) as refused:
        await _source(log, fake).access_token("gmail", "manage")
    assert refused.value.code == SCOPE_NOT_GRANTED and fake.forms == []
    with pytest.raises(ConnectorTokenError) as absent:
        await _source(log, fake).access_token("calendar", "read")
    assert absent.value.code == NOT_CONNECTED


async def test_owner_permission_metadata_is_derived_from_the_actual_live_grant(log):
    read = await _connect(log)
    assert store.connector_permissions(read) == {
        "accessLevel": "read",
        "capabilities": {"read": True, "manage": False},
    }
    manage = await _connect(
        log,
        scopes=(G + "gmail.modify",),
        issued=2,
        credential_id="3b9f6a0e-7c2d-4e1f-9a8b-5c4d3e2f1a0c",
    )
    assert store.connector_permissions(manage) == {
        "accessLevel": "manage",
        "capabilities": {"read": True, "manage": True},
    }
    dead = await store.advance_credential(
        log,
        hushh_id=OWNER,
        connector_id="gmail",
        expected_generation=manage.generation,
        expected_credential_id=manage.credential_id,
        needs_reauth=True,
    )
    assert (
        store.connector_permissions(dead)
        == store.connector_permissions(None)
        == {"accessLevel": None, "capabilities": {"read": False, "manage": False}}
    )


async def test_an_answer_missing_the_narrowed_scope_is_refused(log):
    await _connect(log)
    fake = _Google(_ok(scope="openid"))
    with pytest.raises(ConnectorTokenError) as refused:
        await _source(log, fake).access_token("gmail")
    assert refused.value.code == SCOPE_NOT_GRANTED


async def test_the_cache_holds_until_ninety_seconds_before_expiry(log):
    await _connect(log)
    now = [1000.0]
    fake = _Google(_ok("first"), _ok("second"))
    source = _source(log, fake, clock=lambda: now[0])

    assert await source.access_token("gmail") == "first"
    now[0] = 1000.0 + 3600 - 91
    assert await source.access_token("gmail") == "first", "still outside the skew"
    now[0] = 1000.0 + 3600 - 89
    assert await source.access_token("gmail") == "second", "inside the skew: refreshed"
    assert len(fake.forms) == 2


async def test_concurrent_asks_share_one_refresh(log):
    await _connect(log)
    fake = _Google()
    source = _source(log, fake)

    tokens = await asyncio.gather(*(source.access_token("gmail") for _ in range(10)))

    assert set(tokens) == {"ya29.access-secret"}
    assert len(fake.forms) == 1, "single flight per connector"


async def test_invalid_grant_marks_needs_reauth_in_the_log(log, caplog):
    caplog.set_level(logging.DEBUG)
    await _connect(log)
    fake = _Google((400, {"error": "invalid_grant", "error_description": REFRESH}))
    source = _source(log, fake)

    with pytest.raises(ConnectorTokenError) as refused:
        await source.access_token("gmail")

    assert refused.value.code == NEEDS_REAUTH
    held = store.active_connector_credential("gmail")
    assert held.status == "needs_reauth" and held.refresh_token == "" and held.generation == 2
    reread, _ = await store.read_connector_credentials(log, hushh_id=OWNER)
    assert reread["gmail"].status == "needs_reauth", "durable, not just in memory"
    with pytest.raises(ConnectorTokenError) as again:
        await source.access_token("gmail")
    assert again.value.code == NEEDS_REAUTH and len(fake.forms) == 1, "Google is not asked again"
    assert store.connector_states() == {
        "gmail": "needs_reauth",
        "calendar": "absent",
        "drive": "absent",
        "contacts": "absent",
    }
    assert REFRESH not in caplog.text


async def test_a_rotated_refresh_token_is_recorded_as_the_next_generation(log):
    await _connect(log)
    fake = _Google(_ok(refresh_token="1//rotated"))
    await _source(log, fake).access_token("gmail")
    held, _ = await store.read_connector_credentials(log, hushh_id=OWNER)
    assert held["gmail"].refresh_token == "1//rotated" and held["gmail"].generation == 2
    # A writer holding the old generation does not overwrite the rotation.
    stale = await store.advance_credential(
        log, hushh_id=OWNER, connector_id="gmail", expected_generation=1, needs_reauth=True
    )
    assert stale.generation == 2 and stale.status == "connected"


@pytest.mark.parametrize("rotation", [False, True])
@pytest.mark.parametrize("replacement", [False, True])
async def test_an_inflight_refresh_cannot_survive_disconnect_or_change_a_replacement(
    log, rotation, replacement
):
    await _connect(log)
    new_id = "3b9f6a0e-7c2d-4e1f-9a8b-5c4d3e2f1a0c"

    async def post(_url, _form):
        await store.clear_connector_credential(log, hushh_id=OWNER, connector_id="gmail")
        if replacement:
            await _connect(log, issued=2, credential_id=new_id)
        extra = {"refresh_token": "1//stale-rotation"} if rotation else {}
        return _ok("stale-access", **extra)

    source = _source(log, post)
    with pytest.raises(ConnectorTokenError):
        await source.access_token("gmail")
    assert source._cache == {}, "a refresh admitted under the old login cannot escape"
    held, _ = await store.read_connector_credentials(log, hushh_id=OWNER)
    if replacement:
        assert held["gmail"].credential_id == new_id and held["gmail"].refresh_token == REFRESH
        assert held["gmail"].generation == 1, (
            "same generation, different credential: CAS must refuse"
        )
    else:
        assert "gmail" not in held


async def test_invalid_grant_of_an_old_login_does_not_mark_a_replacement_dead(log):
    await _connect(log)

    async def post(_url, _form):
        await store.clear_connector_credential(log, hushh_id=OWNER, connector_id="gmail")
        await _connect(log, issued=2, credential_id="3b9f6a0e-7c2d-4e1f-9a8b-5c4d3e2f1a0c")
        return 400, {"error": "invalid_grant"}

    with pytest.raises(ConnectorTokenError):
        await _source(log, post).access_token("gmail")
    assert store.active_connector_credential("gmail").status == store.STATUS_CONNECTED


async def test_an_unreadable_store_is_never_read_as_not_connected(log):
    class _Broken:
        async def replay(self):
            raise OSError("down")

    await store.load_connector_credentials(_Broken())
    with pytest.raises(ConnectorTokenError) as refused:
        await _source(log, _Google()).access_token("gmail")
    assert refused.value.code == "CREDENTIALS_UNAVAILABLE"
    assert store.connector_states() is None


async def test_the_store_rechecks_the_floor_under_its_own_compare_and_set(log):
    """Two writes that both opened against the same floor cannot both land."""
    from hushh_mcp.services.pod_connector_credential_seal import ConnectorCredentialRefused

    await _connect(log)
    with pytest.raises(ConnectorCredentialRefused) as refused:
        await _connect(log)  # same issuedAtMs: a replay that raced past the seal's check
    assert refused.value.code == "STALE_CREDENTIAL"
    cleared = await store.clear_connector_credential(log, hushh_id=OWNER, connector_id="gmail")
    assert cleared is not None and cleared.refresh_token == REFRESH
    with pytest.raises(ConnectorCredentialRefused):
        await _connect(log)  # the floor survives a disconnect: still a rollback


@pytest.mark.parametrize("failure", ["PodLogConflict", "PodLogFenced", "ConnectorStoreMissing"])
async def test_a_write_that_cannot_land_is_a_typed_refusal_never_a_raw_store_error(
    log, monkeypatch, failure
):
    """A rotation the log refused is CREDENTIALS_UNAVAILABLE; a dead grant stays NEEDS_REAUTH."""
    from hushh_mcp.services import pod_commit_log

    error = getattr(pod_commit_log, failure, None) or getattr(store, failure)
    await _connect(log)

    async def refused_write(*_args: Any, **_kwargs: Any) -> None:
        raise error("refused")

    monkeypatch.setattr(store, "advance_credential", refused_write)
    with pytest.raises(ConnectorTokenError) as rotated:
        await _source(log, _Google(_ok(refresh_token="1//rotated"))).access_token("gmail")
    assert rotated.value.code == "CREDENTIALS_UNAVAILABLE"
    with pytest.raises(ConnectorTokenError) as dead:
        await _source(log, _Google((400, {"error": "invalid_grant"}))).access_token("gmail")
    assert dead.value.code == NEEDS_REAUTH, (
        "the login is dead at Google whether or not it is written"
    )
