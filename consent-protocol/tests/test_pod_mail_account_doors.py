"""Multi-mailbox HTTP regression using the existing admitted pod harness."""

# ruff: noqa: S106 -- synthetic credentials only.
import uuid

from hushh_mcp.services import pod_connector_credentials
from hushh_mcp.services.pod_connector_credential_seal import seal_connector_credential
from hushh_mcp.services.pod_sealed_envelope import b64url_decode
from tests.test_pod_connector_doors import (
    HUB,
    OWNER,
    OWNER_SESSION,
    PATH,
    TRANSITION,
    VECTOR,
    _client,
    _id_token,
    _now_ms,
    pod,  # noqa: F401 -- shared pytest fixture
)


def _mail_envelope(issued: int, intent: dict) -> dict:
    sealed = seal_connector_credential(
        {**VECTOR["plaintext"], "mailAccount": intent},
        pod_public_key_raw=b64url_decode(VECTOR["podPublicKey"]),
        aad={**VECTOR["aad"], "issuedAtMs": issued, "credentialId": str(uuid.uuid4())},
    )
    return {"envelope": sealed, "transition": TRANSITION}


async def test_two_google_mailboxes_keep_separate_custody_and_targeted_disconnect(request):
    log, google = request.getfixturevalue("pod")
    client = _client()
    issued = _now_ms() - 1000
    accounts_path = PATH + "/accounts"
    first = _mail_envelope(issued, {"mode": "add"})
    assert client.put(PATH, json=first, headers=OWNER_SESSION).status_code == 200
    original = pod_connector_credentials.active_connector_credential("gmail")
    google.token_answer[1]["id_token"] = _id_token(
        sub="222222222", email="personal@example.com", email_verified=True
    )
    google.token_answer[1]["refresh_token"] = "synthetic-personal-refresh"
    second = _mail_envelope(issued + 1, {"mode": "add"})
    assert client.put(PATH, json=second, headers=OWNER_SESSION).status_code == 200
    accounts = client.get(accounts_path, headers=OWNER_SESSION).json()["accounts"]
    assert len(accounts) == 2
    personal = next(item for item in accounts if not item["isDefault"])
    assert personal["email"] == "personal@example.com"
    assert pod_connector_credentials.active_connector_credential("gmail") == original
    # Replaying a recorded native request retries transition cleanup, never code redemption.
    token_calls = len(google.calls)
    assert client.put(PATH, json=second, headers=OWNER_SESSION).status_code == 200
    assert len(google.calls) == token_calls
    duplicate = client.put(
        PATH, json=_mail_envelope(issued + 2, {"mode": "add"}), headers=OWNER_SESSION
    )
    assert (
        duplicate.status_code == 422
        and duplicate.json()["code"] == "MAIL_ACCOUNT_ALREADY_CONNECTED"
    )
    wrong = client.put(
        PATH,
        json=_mail_envelope(
            issued + 3,
            {
                "mode": "reconnect",
                "accountId": accounts[0]["accountId"],
                "credentialId": original.credential_id,
            },
        ),
        headers=OWNER_SESSION,
    )
    assert wrong.status_code == 422 and wrong.json()["code"] == "MAIL_ACCOUNT_MISMATCH"
    assert not google.revoked(), "duplicate or mismatched sign-in must not revoke an existing grant"
    # Reconnect only the selected mailbox, then reject a stale disconnect of its former credential.
    replacement = _mail_envelope(
        issued + 4,
        {
            "mode": "reconnect",
            "accountId": personal["accountId"],
            "credentialId": personal["credentialId"],
        },
    )
    assert client.put(PATH, json=replacement, headers=OWNER_SESSION).status_code == 200
    target = accounts_path + "/" + personal["accountId"]
    assert (
        client.delete(
            target, params={"credential_id": personal["credentialId"]}, headers=OWNER_SESSION
        ).status_code
        == 409
    )
    new_credential = replacement["envelope"]["aad"]["credentialId"]
    assert (
        client.delete(
            target, params={"credential_id": new_credential}, headers=OWNER_SESSION
        ).json()["status"]
        == "absent"
    )
    assert pod_connector_credentials.active_connector_credential("gmail") == original
    assert client.put(PATH, json=second, headers=OWNER_SESSION).json()["code"] == "STALE_CREDENTIAL"
    restored, _ = await pod_connector_credentials.read_connector_credentials(log, hushh_id=OWNER)
    assert list(restored) == ["gmail"]
    assert client.get(accounts_path, headers=HUB).status_code == 403


async def test_three_mailboxes_resolve_separate_refresh_grants_after_disconnect(request):
    from hushh_mcp.services.pod_connector_tokens import PodGoogleTokenSource
    from hushh_mcp.services.pod_gmail_local import PodGmailConnection

    log, google = request.getfixturevalue("pod")
    client = _client()
    issued = _now_ms() - 1000
    addresses = ["a@team.example", "b@team.example", "c@other.example"]
    for index, address in enumerate(addresses):
        google.token_answer[1]["id_token"] = _id_token(
            sub=str(10000 + index), email=address, email_verified=True
        )
        google.token_answer[1]["refresh_token"] = "fixture-" + address
        response = client.put(
            PATH, json=_mail_envelope(issued + index, {"mode": "add"}), headers=OWNER_SESSION
        )
        assert response.status_code == 200

    async def refresh(_url, form):
        return 200, {
            "access_token": "access-" + form["refresh_token"],
            "expires_in": 3600,
            "scope": "https://www.googleapis.com/auth/gmail.readonly",
        }

    tokens = PodGoogleTokenSource(log_resolver=lambda: log, post=refresh, clock=lambda: 1000)
    inventory = PATH + "/accounts"
    accounts = {
        row["email"]: row for row in client.get(inventory, headers=OWNER_SESSION).json()["accounts"]
    }
    assert set(accounts) == set(addresses)

    async def verify(address):
        row = accounts[address]
        held = pod_connector_credentials.active_mail_account(row["accountId"])
        assert held.credential_id == row["credentialId"]
        gmail = PodGmailConnection(OWNER, account_id=held.account_id, token_source=tokens)
        assert await gmail._token(OWNER, "read") == "access-fixture-" + address

    for address in addresses:
        await verify(address)
    removed = accounts[addresses[1]]
    assert (
        client.delete(
            inventory + "/" + removed["accountId"],
            params={"credential_id": removed["credentialId"]},
            headers=OWNER_SESSION,
        ).json()["status"]
        == "absent"
    )
    assert pod_connector_credentials.active_mail_account(removed["accountId"]) is None
    await verify(addresses[0])
    await verify(addresses[2])
