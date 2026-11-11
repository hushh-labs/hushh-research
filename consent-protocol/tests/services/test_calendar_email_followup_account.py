"""Selected-account Mail grant isolation, using synthetic identities only."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from hushh_mcp.services import calendar_email_followup_account as account


class _Google:
    def __init__(self) -> None:
        self.subjects = {"default": "subject-a", "account-b": "subject-b", "account-c": "subject-c"}
        self.mail_grants = {"account-b": ("owner", "gmail", "account-b", "subject-b", "epoch-b")}
        self.token_accounts: list[str] = []

    async def read_calendar_grant_identity(self, *, user_id: str, account_id: str):
        subject = self.subjects.get(account_id)
        return (
            SimpleNamespace(
                provider_subject=subject,
                binding=(user_id, "calendar", account_id, subject),
            )
            if subject
            else None
        )

    async def read_grant_binding(self, *, user_id: str, service: str, account_id: str):
        assert user_id == "owner" and service == "gmail"
        return self.mail_grants.get(account_id)

    async def access_token(self, *, user_id: str, service: str, access_level: str, account_id: str):
        assert user_id == "owner" and service == "gmail" and access_level == "read"
        self.token_accounts.append(account_id)
        return f"synthetic-token-{account_id}"


class _Gmail:
    def __init__(self) -> None:
        self.row = {
            "status": "connected",
            "revoked": False,
            "google_sub": "subject-a",
            "scope_csv": "https://www.googleapis.com/auth/gmail.readonly",
            "followup_read_generation": "epoch-a",
        }
        self.tokens = 0

    def _fetch_connection_row(self, *, user_id: str):
        assert user_id == "owner"
        return self.row

    async def get_read_access_token(self, *, user_id: str):
        assert user_id == "owner"
        self.tokens += 1
        return "synthetic-default-token"


@pytest.fixture
def grants(monkeypatch):
    google, gmail = _Google(), _Gmail()
    monkeypatch.setattr(account, "get_google_connection_service", lambda: google)
    monkeypatch.setattr(account, "get_gmail_receipts_service", lambda: gmail)
    return google, gmail


@pytest.mark.asyncio
async def test_default_requires_exact_calendar_subject(grants):
    google, gmail = grants
    selected = await account.open_selected_mail_grant(user_id="owner", account_id="default")
    assert selected.provider_subject == "subject-a"
    assert gmail.tokens == 1
    google.subjects["default"] = "subject-b"
    with pytest.raises(account.SelectedMailAccessError, match="mail_grant_changed"):
        await selected.require_current()
    with pytest.raises(account.SelectedMailAccessError, match="selected_mail_permission_required"):
        await account.open_selected_mail_grant(user_id="owner", account_id="default")
    assert gmail.tokens == 1


@pytest.mark.asyncio
async def test_additional_mail_grants_never_fall_back_to_default(grants):
    google, gmail = grants
    selected = await account.open_selected_mail_grant(user_id="owner", account_id="account-b")
    assert selected.provider_subject == "subject-b"
    assert selected.token == "synthetic-token-account-b"
    assert google.token_accounts == ["account-b"]
    assert gmail.tokens == 0
    with pytest.raises(account.SelectedMailAccessError, match="selected_mail_permission_required"):
        await account.open_selected_mail_grant(user_id="owner", account_id="account-c")
    assert google.token_accounts == ["account-b"]
    assert gmail.tokens == 0
    google.mail_grants["account-b"] = ("owner", "gmail", "account-b", "subject-b", "epoch-new")
    with pytest.raises(account.SelectedMailAccessError, match="mail_grant_changed"):
        await selected.require_current()
