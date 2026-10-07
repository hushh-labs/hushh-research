"""Google revokes whole grants, so the agent never revokes one a working login still uses.

Gmail, Calendar, Drive and Contacts sign in through native clients in one project, so
one account shares one Google grant: revoking any of its refresh tokens kills them
all. The fake Google here behaves as documented (a revoke kills the whole
(project, account) grant, and a refresh on a dead grant answers ``invalid_grant``), so
each test proves the sibling login still works afterwards, not only that no revoke
call was made.
"""

from __future__ import annotations

# ruff: noqa: S105, S106 -- token strings here are synthetic fixtures, not credentials.
import time
import uuid
from dataclasses import replace
from typing import Any, Awaitable, Callable, Optional

import pytest

from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services import pod_google_oauth, pod_memory_service
from hushh_mcp.services.pod_commit_log import PodLogConflict
from hushh_mcp.services.pod_connector_connect import (
    _revoke_unless_shared,
    revoke_all,
    revoke_fenced,
)
from hushh_mcp.services.pod_connector_credential_seal import (
    OpenedConnectorCredential,
    seal_connector_credential,
)
from hushh_mcp.services.pod_connector_tokens import ConnectorTokenError, google_token_source
from hushh_mcp.services.pod_sealed_envelope import b64url_decode
from tests.test_pod_connector_doors import (  # noqa: F401 - `pod` is a fixture
    CLIENT,
    OWNER,
    OWNER_SESSION,
    TRANSITION,
    VECTOR,
    G,
    _client,
    _id_token,
    pod,
)

ACCOUNT = "1098765432"
OTHER_ACCOUNT = "2222222222"
SCOPES = {
    "gmail": ["openid", "email", G + "gmail.readonly"],
    "calendar": ["openid", "email", G + "calendar.events.readonly", G + "calendar.freebusy"],
}


class _GrantGoogle:
    """Google as documented: a revoke kills every token of that (client, account)."""

    def __init__(self) -> None:
        self.account = ACCOUNT
        self.answer: dict[str, Any] = {}
        self.issued: dict[str, tuple[str, str]] = {}
        self.dead: set[tuple[str, str]] = set()
        self.invalid_tokens: set[str] = set()
        self.revoked: list[str] = []
        self.on_revoke: Optional[Callable[[], Awaitable[None]]] = None
        self.after_revoke: Optional[Callable[[], Awaitable[None]]] = None

    async def __call__(self, url: str, form: Any) -> tuple[int, dict]:
        form = dict(form)
        if url == pod_google_oauth.REVOKE_URL:
            self.revoked.append(form["token"])
            if self.on_revoke is not None:
                await self.on_revoke()
            grant = self.issued.get(form["token"])
            if grant is not None:
                self.dead.add(grant)
                self.invalid_tokens.update(
                    token for token, issued in self.issued.items() if issued == grant
                )
            if self.after_revoke is not None:
                await self.after_revoke()
            return 200, {}
        if form["grant_type"] == "refresh_token":
            if (
                form["refresh_token"] in self.invalid_tokens
                or self.issued.get(form["refresh_token"]) in self.dead
            ):
                return 400, {"error": "invalid_grant"}
            return 200, {"access_token": "ya29.a", "expires_in": 3600, "scope": form["scope"]}
        refresh = f"1//refresh-{self.account}-{len(self.issued) + 1}"
        self.issued[refresh] = (pod_google_oauth.oauth_project_id(form["client_id"]), self.account)
        self.dead.discard(self.issued[refresh])
        body = {
            "access_token": "ya29.a",
            "refresh_token": refresh,
            "expires_in": 3600,
            "id_token": _id_token(sub=self.account, aud=form["client_id"]),
            **self.answer,
        }
        return 200, {k: v for k, v in body.items() if v is not None}


@pytest.fixture
def google(pod, monkeypatch):  # noqa: F811 - the imported fixture
    fake = _GrantGoogle()
    monkeypatch.setattr(pod_google_oauth, "http_post", fake)
    google_token_source()._cache.clear()
    yield fake
    google_token_source()._cache.clear()


def _sealed(connector: str, scopes: Optional[list[str]] = None) -> dict:
    sealed = seal_connector_credential(
        {**VECTOR["plaintext"], "scopes": scopes or SCOPES[connector]},
        pod_public_key_raw=b64url_decode(VECTOR["podPublicKey"]),
        aad={
            **VECTOR["aad"],
            "connectorId": connector,
            "credentialId": str(uuid.uuid4()),
            "issuedAtMs": int(time.time() * 1000),
        },
    )
    return {"envelope": sealed, "transition": TRANSITION}


def _connect(connector: str) -> Any:
    return _client().put(
        f"/api/one/pod/connectors/{connector}", json=_sealed(connector), headers=OWNER_SESSION
    )


def _connected(google: _GrantGoogle, connector: str, **answer: Any) -> None:
    google.answer = {"scope": " ".join(SCOPES[connector]), **answer}
    response = _connect(connector)
    assert response.status_code == 200, response.text


def _delete(connector: str) -> dict:
    return _client().delete(f"/api/one/pod/connectors/{connector}", headers=OWNER_SESSION).json()


async def _still_works(connector: str) -> None:
    google_token_source().forget(connector)
    assert await google_token_source().access_token(connector) == "ya29.a"


async def test_disconnecting_one_connector_keeps_the_shared_grant_for_the_others(google):
    _connected(google, "gmail")
    _connected(google, "calendar")

    gmail = _delete("gmail")

    assert gmail == {"connectorId": "gmail", "status": "absent", "providerRevoked": None}
    assert google.revoked == [], "Google would have revoked Calendar's grant too"
    assert store.active_connector_credential("calendar").status == "connected"
    await _still_works("calendar")

    calendar = _delete("calendar")
    assert calendar["providerRevoked"] is True and len(google.revoked) == 1, "the last one revokes"
    assert google.dead == {(CLIENT.split("-", 1)[0], ACCOUNT)}


@pytest.mark.parametrize(
    "answer",
    [
        {"scope": "openid email"},
        {"refresh_token": None},
        {"id_token": _id_token(aud="999-other.apps.googleusercontent.com")},
    ],
    ids=["scope_not_granted", "refresh_token_missing", "account_unverified"],
)
async def test_a_failed_connect_never_revokes_the_grant_behind_a_working_login(google, answer):
    _connected(google, "gmail")
    google.answer = {"scope": " ".join(SCOPES["calendar"]), **answer}

    refused = _connect("calendar")

    assert refused.status_code == 422
    assert google.revoked == [] and google.dead == set()
    await _still_works("gmail")


async def test_a_lost_record_race_never_revokes_a_shared_grant(google, monkeypatch):
    _connected(google, "gmail")

    async def lost_race(*_args: Any, **_kwargs: Any) -> None:
        raise PodLogConflict("lost")

    monkeypatch.setattr(store, "record_connector_credential", lost_race)
    google.answer = {"scope": " ".join(SCOPES["calendar"])}
    assert _connect("calendar").status_code == 409
    assert google.revoked == []
    await _still_works("gmail")


async def test_a_failed_connect_with_no_other_login_still_revokes(google):
    google.answer = {"scope": "openid email"}
    assert _connect("calendar").json() == {"code": "SCOPE_NOT_GRANTED"}
    assert len(google.revoked) == 1, "nothing else uses the grant, so nothing is left live"


async def test_replacing_a_login_retires_the_old_grant_only_when_nothing_uses_it(google):
    _connected(google, "gmail")
    _connected(google, "gmail")
    assert google.revoked == [], "same account: the new token lives on the same grant"
    replaced = store.active_connector_credential("gmail").refresh_token

    google.account = OTHER_ACCOUNT
    _connected(google, "gmail")
    assert google.revoked == [replaced], "the replaced account's grant is not left live"
    assert google.dead == {(CLIENT.split("-", 1)[0], ACCOUNT)}
    await _still_works("gmail")


async def test_a_login_recorded_while_its_grant_was_revoked_is_marked_needs_reauth(google):
    log = pod_memory_service._resolve_log()
    _connected(google, "gmail")

    async def calendar_lands_mid_revoke() -> None:
        google.issued["1//calendar-raced"] = (CLIENT.split("-", 1)[0], ACCOUNT)
        await store.record_connector_credential(
            log,
            hushh_id=OWNER,
            opened=OpenedConnectorCredential(
                kind="authorization_code",
                connector_id="calendar",
                provider="google",
                credential_id=str(uuid.uuid4()),
                issued_at_ms=int(time.time() * 1000),
                client_profile="hussh_ios",
                client_id=CLIENT,
            ),
            account_subject=ACCOUNT,
            granted_scopes=tuple(SCOPES["calendar"]),
            refresh_token="1//calendar-raced",
        )

    google.on_revoke = calendar_lands_mid_revoke
    assert _delete("gmail")["providerRevoked"] is True
    assert store.active_connector_credential("calendar").status == "needs_reauth"
    with pytest.raises(ConnectorTokenError) as refused:
        await google_token_source().access_token("calendar")
    assert refused.value.code == "NEEDS_REAUTH"


async def test_a_fresh_grant_after_revocation_survives_sibling_validation(google):
    log = pod_memory_service._resolve_log()
    _connected(google, "gmail")
    fresh_id = str(uuid.uuid4())

    async def fresh_calendar_authorization():
        _, body = await google(
            pod_google_oauth.TOKEN_URL, {"grant_type": "authorization_code", "client_id": CLIENT}
        )
        await store.record_connector_credential(
            log,
            hushh_id=OWNER,
            opened=OpenedConnectorCredential(
                kind="authorization_code",
                connector_id="calendar",
                provider="google",
                credential_id=fresh_id,
                issued_at_ms=int(time.time() * 1000),
                client_profile="hussh_ios",
                client_id=CLIENT,
            ),
            account_subject=ACCOUNT,
            granted_scopes=tuple(SCOPES["calendar"]),
            refresh_token=body["refresh_token"],
        )

    google.after_revoke = fresh_calendar_authorization
    assert _delete("gmail")["providerRevoked"] is True
    current = store.active_connector_credential("calendar")
    assert current.credential_id == fresh_id and current.status == store.STATUS_CONNECTED
    assert len(google.revoked) == 1
    await _still_works("calendar")


async def test_erasure_revokes_each_grant_once_and_says_when_it_could_not_look(google, monkeypatch):
    _connected(google, "gmail")
    _connected(google, "calendar")

    assert await revoke_all() == {"revoked": 1, "unrevoked": 0, "unavailable": 0}
    assert len(google.revoked) == 1, "one grant, one revocation"

    monkeypatch.setattr(store, "_LOAD_FAILED", True)
    assert await revoke_all() == {"revoked": 0, "unrevoked": 0, "unavailable": 1}


async def test_different_native_clients_in_one_project_share_the_revocation_boundary(
    google, monkeypatch
):
    android = f"{CLIENT.split('-', 1)[0]}-aaaaaaaaaaaaaaaa.apps.googleusercontent.com"
    monkeypatch.setenv("GOOGLE_ANDROID_CONNECTOR_CLIENT_ID", android)
    _connected(google, "gmail")
    _connected(google, "calendar")
    calendar = store.active_connector_credential("calendar")
    # A token from the other configured client belongs to the same project grant.
    store.set_active_connector_credentials(
        {
            "gmail": store.active_connector_credential("gmail"),
            "calendar": replace(calendar, client_id=android, client_profile="hussh_android"),
        }
    )
    log = pod_memory_service._resolve_log()
    await log.append(
        store.RECORD_KIND, store._payload(OWNER, store.active_connector_credential("calendar"))
    )
    assert _delete("gmail")["providerRevoked"] is None
    assert google.revoked == [], "a client-id comparison would kill the sibling grant"
    assert await revoke_all() == {"revoked": 1, "unrevoked": 0, "unavailable": 0}
    assert len(google.revoked) == 1, "project+account, rather than client+account, is one grant"


async def test_an_unavailable_sibling_check_is_never_reported_as_known_sharing(google):
    class Broken:
        async def replay(self):
            raise OSError("unavailable")

    result = await _revoke_unless_shared(
        Broken(),
        hushh_id=OWNER,
        token="synthetic-token",
        client_id=CLIENT,
        subject=ACCOUNT,
    )
    assert result is False and google.revoked == []


async def test_disconnect_does_not_delete_a_login_that_arrives_during_provider_revocation(google):
    _connected(google, "gmail")
    log = pod_memory_service._resolve_log()
    newer_id = str(uuid.uuid4())

    async def reconnect_during_revoke():
        await store.record_connector_credential(
            log,
            hushh_id=OWNER,
            opened=OpenedConnectorCredential(
                kind="authorization_code",
                connector_id="gmail",
                provider="google",
                credential_id=newer_id,
                issued_at_ms=int(time.time() * 1000) + 1,
                client_profile="hussh_ios",
                client_id=CLIENT,
            ),
            account_subject=OTHER_ACCOUNT,
            granted_scopes=tuple(SCOPES["gmail"]),
            refresh_token="1//new-account-login",
        )

    google.on_revoke = reconnect_during_revoke
    assert _delete("gmail")["providerRevoked"] is True
    assert store.active_connector_credential("gmail").credential_id == newer_id
    assert store.active_connector_credential("gmail").status == store.STATUS_CONNECTED


async def test_fenced_erasure_uses_verified_latest_records_after_restart(google):
    _connected(google, "gmail")
    _connected(google, "calendar")
    log = pod_memory_service._resolve_log()
    await log.fence_for_erasure(owner_id=OWNER, attempt_id="erase-fixture")
    store.set_active_connector_credentials({})  # a fresh process has no in-memory login
    result = await revoke_fenced(log, owner_id=OWNER, attempt_id="erase-fixture", hushh_id=OWNER)
    assert result["revoked"] == 1 and result["unavailable"] == 0
    assert len(result["receipts"]) == 1 and result["receipts"][0]["outcome"] == "confirmed"
    assert ACCOUNT not in str(result) and "1//" not in str(result)
    assert len(google.revoked) == 1
    refused = await revoke_fenced(log, owner_id=OWNER, attempt_id="other", hushh_id=OWNER)
    assert refused == {"revoked": 0, "unrevoked": 0, "unavailable": 1, "receipts": []}
    assert len(google.revoked) == 1, "wrong erasure authority must not reach Google"


async def test_empty_fenced_erasure_is_a_noop_without_provider_calls(google):
    log = pod_memory_service._resolve_log()
    await log.fence_for_erasure(owner_id=OWNER, attempt_id="erase-empty")
    result = await revoke_fenced(log, owner_id=OWNER, attempt_id="erase-empty", hushh_id=OWNER)
    assert result == {"revoked": 0, "unrevoked": 0, "unavailable": 0, "receipts": []}
    assert google.revoked == []
