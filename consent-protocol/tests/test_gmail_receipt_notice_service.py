"""Receipt notice service and routes: owner and mailbox boundary, honest failure, source opening.

MODEL STAND-IN: the runner below reads the same packet a real model would and
returns scripted findings. These tests prove the service's contract around any
model: what it is given, what it may show, and how it fails.
"""

from __future__ import annotations

import hashlib
import json
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.kai import gmail
from hushh_mcp.services import gmail_receipt_notice_service as notice_module
from hushh_mcp.services.gmail_live_receipts_service import (
    GmailLiveReceiptsService,
    ReceiptReadSession,
    _ReadAuthority,
)
from hushh_mcp.services.gmail_receipt_notice_service import GmailReceiptNoticeService
from hushh_mcp.services.gmail_receipts_service import GmailApiError
from tests.test_gmail_receipt_notice import (
    CHECKS,
    NETFLIX,
    NOW,
    netflix_history,
)
from tests.test_gmail_receipt_notice import (
    gmail as gmail_message,
)

OWNER_TOKEN = "owner-vault-token"
NOTICE = gmail_message(
    "n4",
    "2026-11-10",
    NETFLIX,
    "We haven't seen you",
    "Hi, you haven't watched anything on this account in 60 days.",
)


class FakeSession:
    def __init__(
        self, account: str, mailbox: list[dict[str, Any]], *, changed_after_model: bool = False
    ) -> None:
        self.account = account
        self.mailbox = {m["id"]: m for m in mailbox}
        self.changed_after_model = changed_after_model
        self.queries: list[str] = []

    def message_id_for(self, key: str) -> str | None:
        prefix = f"key:{self.account}:"
        message_id = key[len(prefix) :] if key.startswith(prefix) else None
        return message_id if message_id in self.mailbox else None

    def locator(self, message_id: str) -> str:
        return f"loc:{self.account}:{message_id}"

    def stable_id(self, message_id: str) -> str:
        return hashlib.sha256(f"{self.account}:{message_id}".encode()).hexdigest()[:24]

    async def list_ids(self, query: str, limit: int) -> list[str]:
        self.queries.append(query)
        root = query.split("from:", 1)[1].split(" ", 1)[0]
        return [
            m["id"] for m in self.mailbox.values() if root in m["payload"]["headers"][0]["value"]
        ][:limit]

    async def fetch(self, ids: list[str]) -> list[dict[str, Any]]:
        return [self.mailbox[i] for i in ids if i in self.mailbox]

    async def require_current(self) -> None:
        if self.changed_after_model:
            raise GmailApiError("changed", status_code=409, code="GMAIL_CONNECTION_CHANGED")


class FakeLive:
    def __init__(self, session: FakeSession) -> None:
        self.session = session

    @asynccontextmanager
    async def read_session(
        self, *, user_id: str, require_access: Any, expected_account: str | None = None
    ):
        await require_access()
        if expected_account is not None and expected_account != self.session.account:
            raise GmailApiError("changed", status_code=409, code="GMAIL_RECEIPT_ACCOUNT_CHANGED")
        yield self.session


def keys(session: FakeSession, *ids: str) -> list[str]:
    return [f"key:{session.account}:{i}" for i in ids]


def sees(payload: dict[str, Any], subject_has: str) -> str:
    return next(
        m["id"] for p in payload["providers"] for m in p["messages"] if subject_has in m["subject"]
    )


class Runner:
    """Reads the packet like a model would and proposes the inactivity finding."""

    def __init__(self) -> None:
        self.calls = 0
        self.prompt = ""

    async def __call__(self, prompt: str, user_id: str, consent_token: str) -> dict[str, Any]:
        self.calls += 1
        self.prompt = prompt
        payload = json.loads(prompt.split("\n", 1)[1])
        provider = payload["providers"][0]
        paid = max((m for m in provider["messages"] if m["paid"]), key=lambda m: m["on"])
        notices = [m for m in provider["messages"] if "haven't seen you" in m["subject"]]
        if not notices:
            return {"findings": [], "resolved": [], "none_reason": "Nothing stands out."}
        return {
            "findings": [
                {
                    "kind": "inactive_plan",
                    "headline": "Still using this ₹499 plan?",
                    "reason": "Netflix says this account hasn't watched anything in 60 days.",
                    "strength": "clear",
                    "evidence": [
                        {"message_id": paid["id"], "role": "paid", "quote": "Total ₹499.00 paid"},
                        {
                            "message_id": notices[0]["id"],
                            "role": "provider_notice",
                            "quote": "you haven't watched anything on this account in 60 days",
                        },
                    ],
                    "plans": [],
                    "promised_by": None,
                    "announced": None,
                    "checks": CHECKS,
                }
            ],
            "resolved": [],
            "none_reason": "",
        }


def service_for(session: FakeSession, runner: Any) -> GmailReceiptNoticeService:
    return GmailReceiptNoticeService(live=FakeLive(session), runner=runner, clock=lambda: NOW)  # type: ignore[arg-type]


async def access() -> None:
    return None


async def run(
    service: GmailReceiptNoticeService, session: FakeSession, ids: list[str], **extra: Any
) -> dict[str, Any]:
    return await service.analyze(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=access,
        receipt_keys=keys(session, *ids),
        expected_account=session.account,
        **extra,
    )


async def test_the_model_reads_related_provider_mail_and_a_validated_finding_comes_back_with_sources():
    session = FakeSession("a@x.test", [*netflix_history(), NOTICE])
    runner = Runner()
    result = await run(service_for(session, runner), session, ["n1", "n2", "n3"])

    assert result["account_key"] == "a@x.test" and result["coverage"]["providers"] == 1
    # The notice was never in the receipt keys: it came from the provider search.
    assert any(q.startswith("from:netflix.com ") for q in session.queries)
    [found] = result["findings"]
    assert found["kind"] == "inactive_plan" and found["strength"] == "clear"
    assert found["attribution"]["by"] == "Netflix" and found["attribution"]["on"] == "2026-11-10"
    assert found["action"] == {"id": "review_plan", "label": "Review plan"}
    assert {e["role"] for e in found["evidence"]} == {"paid", "provider_notice"}
    assert all(e["open_key"].startswith("loc:a@x.test:") for e in found["evidence"])
    assert found["id"].startswith("nf_") and found["facts"]["amount_minor"] == 49900
    # What the model saw is code-shaped evidence: no provider message ids, mail marked untrusted.
    assert "untrusted" in runner.prompt and "n3" not in json.dumps(
        json.loads(runner.prompt.split("\n", 1)[1])
    )


async def test_the_same_evidence_gives_the_same_finding_id_so_a_kept_choice_sticks():
    first_session = FakeSession("a@x.test", [*netflix_history(), NOTICE])
    first = await run(service_for(first_session, Runner()), first_session, ["n1", "n2", "n3"])
    again = await run(service_for(first_session, Runner()), first_session, ["n1", "n2", "n3"])
    assert first["findings"][0]["id"] == again["findings"][0]["id"]
    later_notice = gmail_message(
        "n9",
        "2026-11-20",
        NETFLIX,
        "We haven't seen you",
        "Hi, you haven't watched anything on this account in 60 days.",
    )
    newer = FakeSession("a@x.test", [*netflix_history(), NOTICE, later_notice])
    changed = await run(service_for(newer, Runner()), newer, ["n1", "n2", "n3"])
    assert changed["findings"][0]["id"] != first["findings"][0]["id"]


async def test_the_providers_own_cancellation_emails_are_returned_for_the_device_to_confirm():
    cancelled = gmail_message(
        "n5", "2026-11-12", NETFLIX, "Your subscription has ended", "You cancelled your plan."
    )
    session = FakeSession("a@x.test", [*netflix_history(), NOTICE, cancelled])
    result = await run(service_for(session, Runner()), session, ["n1", "n2", "n3"])
    assert [(c["domain"], c["on"]) for c in result["cancellations"]] == [
        ("netflix.com", "2026-11-12")
    ]
    assert result["cancellations"][0]["open_key"].startswith("loc:a@x.test:")


async def test_contradictory_evidence_removes_the_finding():
    cancelled = gmail_message(
        "n5", "2026-11-12", NETFLIX, "Your subscription has ended", "You cancelled your plan."
    )
    session = FakeSession("a@x.test", [*netflix_history(), NOTICE, cancelled])
    result = await run(service_for(session, Runner()), session, ["n1", "n2", "n3"])
    assert result["findings"] == []


async def test_a_quiet_provider_with_receipts_only_returns_nothing_without_inventing_inactivity():
    session = FakeSession("a@x.test", netflix_history())
    runner = Runner()
    result = await run(service_for(session, runner), session, ["n1", "n2", "n3"])
    assert result["findings"] == [] and runner.calls == 1


async def test_with_no_paid_receipts_the_model_is_not_called():
    session = FakeSession("a@x.test", [NOTICE])
    runner = Runner()
    result = await run(service_for(session, runner), session, ["n4"])
    assert result["findings"] == [] and runner.calls == 0 and result["none_reason"]


async def test_each_mailbox_is_read_and_returned_on_its_own():
    other = [
        gmail_message(
            "m1",
            "2026-11-02",
            NETFLIX,
            "Your payment receipt",
            "Thank you for your payment. Total ₹649.00 paid.",
        )
    ]
    mine = FakeSession("a@x.test", [*netflix_history(), NOTICE])
    theirs = FakeSession("b@x.test", other)
    ok = await run(service_for(mine, Runner()), mine, ["n1", "n2", "n3"])
    assert all(
        e["open_key"].startswith("loc:a@x.test:") for f in ok["findings"] for e in f["evidence"]
    )
    # A key minted for the other mailbox opens nothing here, and is only counted.
    result = await service_for(mine, Runner()).analyze(
        user_id="owner",
        consent_token=OWNER_TOKEN,
        require_access=access,
        receipt_keys=[*keys(mine, "n1", "n2", "n3"), *keys(theirs, "m1")],
        expected_account="a@x.test",
    )
    assert result["coverage"]["unreadable_keys"] == 1
    with pytest.raises(GmailApiError) as caught:
        await service_for(mine, Runner()).analyze(
            user_id="owner",
            consent_token=OWNER_TOKEN,
            require_access=access,
            receipt_keys=keys(mine, "n1"),
            expected_account="b@x.test",
        )
    assert caught.value.code == "GMAIL_RECEIPT_ACCOUNT_CHANGED"


async def test_a_connection_that_changed_while_the_model_ran_shows_nothing():
    session = FakeSession("a@x.test", [*netflix_history(), NOTICE], changed_after_model=True)
    with pytest.raises(GmailApiError) as caught:
        await run(service_for(session, Runner()), session, ["n1", "n2", "n3"])
    assert caught.value.code == "GMAIL_CONNECTION_CHANGED"


async def test_model_failures_are_typed_and_never_return_findings(monkeypatch):
    session = FakeSession("a@x.test", [*netflix_history(), NOTICE])
    for failure, code, status in (
        (TimeoutError(), "GMAIL_RECEIPT_NOTICE_TIMEOUT", 504),
        (RuntimeError("provider down"), "GMAIL_RECEIPT_NOTICE_UNAVAILABLE", 503),
        (
            ValueError("single-turn agent returned invalid JSON"),
            "GMAIL_RECEIPT_NOTICE_INVALID",
            502,
        ),
    ):
        monkeypatch.setattr(notice_module, "run_email_gene", AsyncMock(side_effect=failure))
        service = GmailReceiptNoticeService(live=FakeLive(session), clock=lambda: NOW)  # type: ignore[arg-type]
        with pytest.raises(GmailApiError) as caught:
            await run(service, session, ["n1", "n2", "n3"])
        assert (caught.value.code, caught.value.status_code) == (code, status)


async def test_one_check_per_owner_runs_at_a_time_and_the_lane_frees_afterwards():
    import asyncio

    session = FakeSession("a@x.test", [*netflix_history(), NOTICE])
    release = asyncio.Event()

    class Slow(Runner):
        async def __call__(self, prompt: str, user_id: str, consent_token: str) -> dict[str, Any]:
            await release.wait()
            return await super().__call__(prompt, user_id, consent_token)

    service = service_for(session, Slow())
    first = asyncio.create_task(run(service, session, ["n1", "n2", "n3"]))
    await asyncio.sleep(0.05)
    with pytest.raises(GmailApiError) as caught:
        await run(service, session, ["n1", "n2", "n3"])
    assert (
        caught.value.code == "GMAIL_RECEIPT_NOTICE_IN_PROGRESS" and caught.value.status_code == 409
    )
    release.set()
    assert (await first)["findings"]
    assert (await run(service, session, ["n1", "n2", "n3"]))["findings"]  # the lane is free again


async def test_the_kill_switch_stops_every_model_call(monkeypatch):
    monkeypatch.setenv("KAI_RECEIPT_NOTICE_ENABLED", "false")
    session = FakeSession("a@x.test", [*netflix_history(), NOTICE])
    runner = Runner()
    with pytest.raises(GmailApiError) as caught:
        await run(service_for(session, runner), session, ["n1", "n2", "n3"])
    assert caught.value.code == "GMAIL_RECEIPT_NOTICE_UNAVAILABLE" and runner.calls == 0


async def test_an_email_can_be_opened_only_with_a_key_for_this_owner_and_mailbox():
    session = FakeSession("a@x.test", [*netflix_history(), NOTICE])
    service = service_for(session, Runner())
    opened = await service.source(
        user_id="owner", key="key:a@x.test:n4", require_access=access, expected_account="a@x.test"
    )
    assert opened["subject"] == "We haven't seen you"
    assert "haven't watched anything on this account in 60 days" in opened["excerpt"]
    assert opened["from_domain"] == "mailer.netflix.com" and opened["received_at"].startswith(
        "2026-11-10"
    )
    with pytest.raises(GmailApiError) as caught:
        await service.source(
            user_id="owner",
            key="key:b@x.test:n4",
            require_access=access,
            expected_account="a@x.test",
        )
    assert caught.value.code == "GMAIL_RECEIPT_NOT_FOUND"
    with pytest.raises(GmailApiError) as wrong:
        await service.source(
            user_id="owner",
            key="key:a@x.test:n4",
            require_access=access,
            expected_account="b@x.test",
        )
    assert wrong.value.code == "GMAIL_RECEIPT_ACCOUNT_CHANGED"


def test_sealed_routing_keys_open_only_for_the_mailbox_that_minted_them():
    live = GmailLiveReceiptsService(source_secret=b"s" * 32, gmail=MagicMock())

    def session(account: str) -> ReceiptReadSession:
        authority = _ReadAuthority(
            "owner", account, "2026-01-01", ("owner", "gmail", account, "2026-01-01", "g"), "token"
        )
        return ReceiptReadSession(live, authority, MagicMock(), [1024])

    mine, theirs = session("a@x.test"), session("b@x.test")
    key = mine.locator("provider-msg-1")
    assert mine.message_id_for(key) == "provider-msg-1"
    assert theirs.message_id_for(key) is None
    assert (
        mine.message_id_for("grs1_" + "A" * 60) is None and mine.message_id_for("not-a-key") is None
    )
    assert (
        mine.stable_id("provider-msg-1")
        == mine.stable_id("provider-msg-1")
        != theirs.stable_id("provider-msg-1")
    )
    assert "provider-msg-1" not in key and "provider-msg-1" not in mine.stable_id("provider-msg-1")


# -- routes ------------------------------------------------------------------------


def _app(*, firebase_uid: str = "owner", vault_owner: str | None = "owner") -> FastAPI:
    app = FastAPI()
    app.include_router(gmail.router)
    app.dependency_overrides[require_firebase_auth] = lambda: firebase_uid
    if vault_owner is not None:
        app.dependency_overrides[require_vault_owner_token] = lambda: {
            "user_id": vault_owner,
            "token": "vault-token",
        }
    return app


@pytest.fixture(autouse=True)
def shared_owner_placement(monkeypatch, active_account_lifecycle):
    from hushh_mcp.services import owner_placement_guard

    monkeypatch.setattr(
        owner_placement_guard, "get_owner_hosting_mode", AsyncMock(return_value="shared")
    )


BODY = {"user_id": "owner", "account_key": "a@x.test", "receipt_keys": ["grs1_" + "a" * 40]}


def test_the_notice_route_needs_the_vault_owner_and_stays_bounded(monkeypatch):
    service = MagicMock()
    service.analyze = AsyncMock(return_value={"findings": []})
    monkeypatch.setattr(gmail, "get_gmail_receipt_notice_service", lambda: service)
    assert (
        TestClient(_app(firebase_uid="other")).post("/gmail/receipts/notice", json=BODY).status_code
        == 403
    )
    assert (
        TestClient(_app(vault_owner="other")).post("/gmail/receipts/notice", json=BODY).status_code
        == 403
    )
    assert (
        TestClient(_app(vault_owner=None), raise_server_exceptions=False)
        .post("/gmail/receipts/notice", json=BODY)
        .status_code
        == 401
    )
    client = TestClient(_app())
    assert (
        client.post("/gmail/receipts/notice", json={**BODY, "receipt_keys": ["k"] * 41}).status_code
        == 422
    )
    assert (
        client.post("/gmail/receipts/notice", json={**BODY, "receipt_keys": []}).status_code == 422
    )
    assert client.post("/gmail/receipts/notice", json={**BODY, "extra": 1}).status_code == 422
    assert (
        client.post(
            "/gmail/receipts/notice", json={**BODY, "receipt_keys": ["k" * 341]}
        ).status_code
        == 422
    )
    service.analyze.assert_not_awaited()


def test_the_notice_route_passes_only_the_owner_account_and_keys_and_is_no_store(monkeypatch):
    service = MagicMock()
    service.analyze = AsyncMock(return_value={"findings": [], "resolved": []})
    monkeypatch.setattr(gmail, "get_gmail_receipt_notice_service", lambda: service)
    revalidate = AsyncMock()
    monkeypatch.setattr(gmail, "_revalidate_live_receipt_access", revalidate)
    response = TestClient(_app()).post(
        "/gmail/receipts/notice",
        json={
            **BODY,
            "prior": [
                {
                    "id": "nf_1",
                    "kind": "inactive_plan",
                    "provider": "Netflix",
                    "headline": "Still using this?",
                }
            ],
        },
    )
    assert response.status_code == 200 and response.headers["cache-control"] == "private, no-store"
    kwargs = service.analyze.await_args.kwargs
    assert kwargs["user_id"] == "owner" and kwargs["expected_account"] == "a@x.test"
    assert kwargs["receipt_keys"] == BODY["receipt_keys"] and kwargs["prior"][0]["id"] == "nf_1"
    assert kwargs["consent_token"] == "vault-token"


@pytest.mark.parametrize(
    ("code", "status", "retryable"),
    [
        ("GMAIL_RECEIPT_NOTICE_TIMEOUT", 504, True),
        ("GMAIL_RECEIPT_NOTICE_UNAVAILABLE", 503, True),
        ("GMAIL_RECEIPT_NOTICE_INVALID", 502, False),
        ("GMAIL_RECEIPT_ACCOUNT_CHANGED", 409, False),
    ],
)
def test_notice_failures_reach_the_device_as_typed_safe_errors(
    monkeypatch, code, status, retryable
):
    service = MagicMock()
    service.analyze = AsyncMock(
        side_effect=GmailApiError("secret detail", status_code=status, code=code)
    )
    monkeypatch.setattr(gmail, "get_gmail_receipt_notice_service", lambda: service)
    response = TestClient(_app()).post("/gmail/receipts/notice", json=BODY)
    detail = response.json()["detail"]
    assert (
        response.status_code == status
        and detail["code"] == code
        and detail["retryable"] is retryable
    )
    assert "secret detail" not in response.text


def test_the_source_route_opens_one_email_for_the_owner_only(monkeypatch):
    service = MagicMock()
    service.source = AsyncMock(return_value={"subject": "s", "excerpt": "e"})
    monkeypatch.setattr(gmail, "get_gmail_receipt_notice_service", lambda: service)
    body = {"user_id": "owner", "account_key": "a@x.test", "open_key": "grs1_" + "b" * 40}
    assert (
        TestClient(_app(vault_owner="other"))
        .post("/gmail/receipts/notice/source", json=body)
        .status_code
        == 403
    )
    ok = TestClient(_app()).post("/gmail/receipts/notice/source", json=body)
    assert ok.status_code == 200 and ok.headers["cache-control"] == "private, no-store"
    assert service.source.await_args.kwargs["key"] == body["open_key"]
