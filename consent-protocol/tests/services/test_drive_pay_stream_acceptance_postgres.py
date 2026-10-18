"""Acceptance: a Drive request is paid once, then every match streams; it settles once.

Written from the owners' contract (2026-10-18), not from any implementation:

* Non-trusted request: when A taps Allow, B is asked to pay A's Allow price
  while A's agent searches Drive. Trusted circle: no consent at all, and the
  price is A's profile price.
* Nothing is shared before the order is paid. After payment every matching
  file is shared, in batches of at most 25, as the search finds it.
* A never selects files. An automatic grant still needs title evidence, the
  picked period and Drive's canShare for A.
* Nothing matched after B paid: a full automatic refund. Partial delivery: a
  refund for the approved files that were not delivered, and only those.
  Settlement happens exactly once, also when the search ends incomplete, A
  stops mid-delivery or the request expires while pending. Files B already had
  count as delivered.
* Production keeps the owner-review flow (autoshare_enabled() is false only
  there).

Real stages: request creation and Allow (DriveSharingService), the Drive
worker's search slices (DriveOwnerSearchWorker over GoogleDriveRestTransport
and GoogleDriveAdapter), DriveTrustedAutoService handoffs, the owner's manual
review (DriveRequestBulkService and DriveBulkShareService), the sharing drain
(DriveWorkDrain with the Checkout worker, DriveBulkShareWorker over the real
GoogleDrivePermissionAdapter, and the owner payout and refund workers), Stripe's
webhook path (process_webhook) and the owner's Stop. Requests, searches,
batches, effects, orders, payouts and refunds live in disposable PostgreSQL.

Faked: Google Drive v3 (an httpx fake: files.list in pages of at most 25 rows,
files.get and the permission endpoints over one in-memory ACL), Stripe
(Checkout sessions, the webhook signature check and refunds), Firebase identity
and the scheduler wake (counted, never sent). Every title is synthetic and
neutral. Search v2's owner name index (Gear 1) is off here so that Drive's own
25-row pages decide when each match is found.

Pay-at-Allow (DriveRequestPaymentStore.ensure_order_for_owner_allow) lands in
a parallel PR. Every scenario holds with or without it, except three that say
so in their skip condition: S0 and the paid S2 need it, the order-free S2 needs
its absence. S11 (expiry while pending) comes from the same settlement clause
as S4 and S5.
"""

# ruff: noqa: F401, F811 -- isolated PostgreSQL fixtures imported from their owners

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import text

from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services import drive_bulk_share_worker as bulk_worker_module
from hushh_mcp.services import drive_permission_executor as identity_module
from hushh_mcp.services import drive_request_bulk_service as bulk_module
from hushh_mcp.services import drive_request_owner_payout_worker as payout_worker_module
from hushh_mcp.services import drive_work_wake
from hushh_mcp.services import external_connector_oauth_service as oauth_module
from hushh_mcp.services import google_drive_rest_transport as rest
from hushh_mcp.services.drive_bulk_share_service import DriveBulkShareService
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_bulk_share_worker import DriveBulkShareWorker
from hushh_mcp.services.drive_owner_index_port import NoOwnerIndex
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_owner_search_worker import DriveOwnerSearchWorker
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.drive_request_owner_payout_service import (
    DriveRequestOwnerPayoutService,
)
from hushh_mcp.services.drive_request_owner_payout_worker import DriveRequestOwnerPayoutWorker
from hushh_mcp.services.drive_request_payment_checkout_worker import (
    DriveRequestPaymentCheckoutWorker,
)
from hushh_mcp.services.drive_request_payment_refund_worker import DriveRequestPaymentRefundWorker
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.drive_work_drain import DriveWorkDrain
from hushh_mcp.services.google_drive_adapter import (
    LIVE_POLICY_HASH,
    GoogleDriveAdapter,
    query_has_full_text_term,
)
from hushh_mcp.services.google_drive_permission_adapter import GoogleDrivePermissionAdapter
from tests.services.test_drive_request_bulk_postgres import request_bulk
from tests.services.test_drive_search_performance_proof import drive_query
from tests.services.test_drive_sharing_store import (
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)

PHRASE = "site inspection reports"
# The request brain cannot hold "7" as a subject word, so this search keeps
# the owner's review: the manual lane, where A approves exact files.
MANUAL_PHRASE = "Unit 7 site inspection reports"
PERIOD = {"periodStart": "2026-07-01", "periodEnd": "2026-09-30"}
FIRST_DAY = date(2026, 7, 1)
RECIPIENT = ("recipient", "1234567", "b@example.invalid")
OWNER_EMAIL = "a@example.invalid"
# A's profile price (the request_bulk fixture) prices a Trusted request; A
# allows a non-trusted one at a different price, so the two cannot be confused.
PROFILE_CENTS = 1000
ALLOW_CENTS = 750
GDOC = "application/vnd.google-apps.document"
PAY_AT_ALLOW = hasattr(DriveRequestPaymentStore, "ensure_order_for_owner_allow")
pay_at_allow_only = pytest.mark.skipif(
    not PAY_AT_ALLOW, reason="pay-at-Allow lands in a parallel PR"
)
TERMINAL_SEARCH = {"completed", "limited", "failed", "stopped", "superseded"}


# --- A's synthetic Drive ---------------------------------------------------


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def report(file_id, day, *, title="Site inspection report", modified=None, can_share=True):
    """A report whose title names the request and dates it."""
    created = datetime(day.year, day.month, day.day, 10, tzinfo=UTC)
    return {
        "id": file_id,
        "name": f"{title} {day.isoformat()}",
        "mimeType": GDOC,
        "createdTime": _stamp(created),
        "modifiedTime": _stamp(modified or created + timedelta(minutes=5)),
        "canShare": can_share,
        "content": "Site inspection report: findings, photos and follow-up actions.",
        "trashed": False,
    }


def in_period(count, *, prefix="m", title="Site inspection report", edited=None):
    """Matches: dated inside the picked period by title. edited moves them up
    Drive's newest-first title pass without changing their title date."""
    return [
        report(
            f"{prefix}-{index:03d}",
            FIRST_DAY + timedelta(days=index),
            title=title,
            modified=None if edited is None else edited + timedelta(minutes=index),
        )
        for index in range(count)
    ]


def thirty_five_matches():
    """3 recently edited matches share Drive's first title page with 22 stale
    files; 32 older matches follow on the title pass's later pages."""
    return in_period(3, prefix="a", edited=datetime(2026, 10, 5, tzinfo=UTC)) + [
        report(f"b-{index:03d}", FIRST_DAY + timedelta(days=3 + index)) for index in range(32)
    ]


def stale(count):
    """Title-dated before the picked period but edited this month: Drive's
    newest-first title pass lists them first, and the period rule drops them."""
    return [
        report(
            f"s-{index:03d}",
            date(2025, 3, 1) + timedelta(days=index),
            modified=datetime(2026, 10, 10, tzinfo=UTC) + timedelta(minutes=index),
        )
        for index in range(count)
    ]


def noise(count):
    """Drive's full-text search returns these, but no title word names the request."""
    created = datetime(2026, 8, 1, 9, tzinfo=UTC)
    return [
        {
            "id": f"n-{index:04d}",
            "name": f"Field visit summary {index:04d}",
            "mimeType": GDOC,
            "createdTime": _stamp(created),
            "modifiedTime": _stamp(created + timedelta(minutes=index)),
            "canShare": True,
            "content": "The site inspection report is attached.",
            "trashed": False,
        }
        for index in range(count)
    ]


class DriveWorld:
    """Drive v3 for A: files.list (at most 25 rows a page), files.get and one ACL.

    A fullText query keeps the table order (Drive's relevance order is
    unspecified), and a fullText query with orderBy is refused as Drive refuses
    it. permissions.create adds a reader to the ACL that permissions.list reads.
    """

    def __init__(self, files, *, already_shared=(), rejected=(), incomplete_tail=False):
        self.files = {item["id"]: item for item in files}
        assert len(self.files) == len(files)
        self.acl = {
            file_id: [
                {
                    "id": "owner-permission",
                    "type": "user",
                    "role": "owner",
                    "emailAddress": OWNER_EMAIL,
                }
            ]
            for file_id in self.files
        }
        for file_id in already_shared:
            self.acl[file_id].append(
                {
                    "id": f"prior-{file_id}",
                    "type": "user",
                    "role": "reader",
                    "emailAddress": RECIPIENT[2],
                }
            )
        # Google refuses a new reader on these, definitively (HTTP 400).
        self.rejected = set(rejected)
        # The last page of the full-text pass says Drive could not search everything.
        self.incomplete_tail = incomplete_tail
        self.list_pages = 0
        self.created = Counter()
        self.paid = False
        self.created_before_payment = []

    @staticmethod
    def _json(status, payload):
        return httpx.Response(status, stream=httpx.ByteStream(json.dumps(payload).encode()))

    def __call__(self, request):
        assert request.url.host == "www.googleapis.com", request.url.host
        path = request.url.path.removeprefix("/drive/v3")
        params = dict(request.url.params)
        if path == "/drives":
            return self._json(200, {"drives": []})
        if path == "/files":
            return self._list(params)
        parts = path.split("/")
        assert parts[1] == "files" and parts[2] in self.files, path
        item = self.files[parts[2]]
        if len(parts) == 3:
            assert request.method == "GET"
            return self._json(
                200,
                {
                    **{
                        key: item[key]
                        for key in ("id", "name", "mimeType", "modifiedTime", "createdTime")
                    },
                    "version": "3",
                    "trashed": False,
                    "isAppAuthorized": False,
                    "capabilities": {
                        "canShare": item["canShare"],
                        "canDownload": True,
                        "canAccessViaGenAi": True,
                    },
                },
            )
        assert parts[3] == "permissions", path
        if request.method == "GET":
            return self._json(200, {"permissions": list(self.acl[item["id"]])})
        if request.method == "DELETE":
            self.acl[item["id"]] = [p for p in self.acl[item["id"]] if p["id"] != parts[4]]
            return httpx.Response(204)
        assert request.method == "POST"
        body = json.loads(request.content)
        assert body["type"] == "user" and body["role"] == "reader", body
        assert params.get("sendNotificationEmail") == "false"
        if item["id"] in self.rejected:
            # Google's own error shape. Only a readable reason makes a 400
            # definitive: an unreadable body (or invalidSharingRequest) may
            # follow a real share, so the adapter reconciles it instead.
            return self._json(
                400,
                {
                    "error": {
                        "code": 400,
                        "message": "Sharing refused",
                        "errors": [{"reason": "badRequest", "message": "Sharing refused"}],
                    }
                },
            )
        permission = {
            "id": f"p-{item['id']}-{len(self.acl[item['id']])}",
            "type": "user",
            "role": "reader",
            "emailAddress": body["emailAddress"],
            **({"expirationTime": body["expirationTime"]} if "expirationTime" in body else {}),
        }
        self.acl[item["id"]].append(permission)
        if body["emailAddress"] == RECIPIENT[2]:
            self.created[item["id"]] += 1
            if not self.paid:
                self.created_before_payment.append(item["id"])
        return self._json(200, permission)

    def _list(self, params):
        q = params["q"]
        predicate = drive_query(q)
        rows = [item for item in self.files.values() if predicate(item)]
        if "orderBy" in params:
            assert not query_has_full_text_term(q), q
            field, direction = params["orderBy"].split()
            assert direction == "desc"
            rows.sort(key=lambda item: (item[field], item["id"]), reverse=True)
        offset = int(params.get("pageToken", "0"))
        chunk = rows[offset : offset + min(int(params["pageSize"]), 25)]
        self.list_pages += 1
        last = offset + len(chunk) >= len(rows)
        payload = {
            "files": [
                {
                    **{
                        key: item[key]
                        for key in ("id", "name", "mimeType", "createdTime", "modifiedTime")
                    },
                    "webViewLink": f"https://drive.google.com/file/d/{item['id']}/view",
                    "capabilities": {"canShare": item["canShare"]},
                }
                for item in chunk
            ],
            "incompleteSearch": bool(self.incomplete_tail and last and query_has_full_text_term(q)),
        }
        if not last:
            payload["nextPageToken"] = str(offset + len(chunk))
        return self._json(200, payload)

    def shared_with_b(self):
        """Files whose ACL holds B now, however the permission got there."""
        return {
            file_id
            for file_id, permissions in self.acl.items()
            if any(p.get("emailAddress") == RECIPIENT[2] for p in permissions)
        }


# --- Stripe, identity and the scheduler wake -------------------------------


class FakeStripe:
    """Hosted Checkout sessions, the webhook signature check and refunds."""

    def __init__(self):
        self.sessions = {}
        self._session_keys = {}
        self.refunds = []
        self.refund_creates = []
        self.checkout = SimpleNamespace(Session=SimpleNamespace(create=self._create_session))
        self.Webhook = SimpleNamespace(construct_event=self._construct_event)
        self.Refund = SimpleNamespace(
            create=self._create_refund, list=self._list_refunds, retrieve=self._retrieve_refund
        )

    def _create_session(self, **params):
        key = params["idempotency_key"]
        if key in self._session_keys:
            return self._session_keys[key]
        price = params["line_items"][0]["price_data"]
        session_id = f"cs_test_{len(self.sessions) + 1:04d}"
        session = {
            "id": session_id,
            "object": "checkout.session",
            "mode": params["mode"],
            "client_reference_id": params["client_reference_id"],
            "amount_total": price["unit_amount"],
            "currency": price["currency"],
            "livemode": False,
            "metadata": dict(params["metadata"]),
            "url": f"https://checkout.stripe.com/c/pay/{session_id}",
            "expires_at": params["expires_at"],
        }
        self.sessions[session_id] = session
        self._session_keys[key] = session
        return session

    @staticmethod
    def _construct_event(payload, signature, secret):
        assert signature and secret == os.environ["STRIPE_WEBHOOK_SECRET"]
        return json.loads(payload)

    def _list_refunds(self, *, payment_intent, limit, api_key):
        return {
            "data": [dict(r["public"]) for r in self.refunds if r["intent"] == payment_intent],
            "has_more": False,
        }

    def _create_refund(self, *, payment_intent, amount, metadata, api_key, idempotency_key):
        for refund in self.refunds:
            if refund["key"] == idempotency_key:
                return dict(refund["public"])
        public = {
            "id": f"re_test_{len(self.refunds) + 1:04d}",
            "object": "refund",
            "payment_intent": payment_intent,
            "amount": amount,
            "currency": "usd",
            "status": "succeeded",
        }
        self.refunds.append({"key": idempotency_key, "intent": payment_intent, "public": public})
        self.refund_creates.append(amount)
        return dict(public)

    def _retrieve_refund(self, refund_id, *, api_key):
        return next(dict(r["public"]) for r in self.refunds if r["public"]["id"] == refund_id)


async def _verified_recipient(user_id):
    if user_id != RECIPIENT[0]:
        raise DriveSharingError("recipient_google_identity_required")
    return VerifiedGoogleRecipient(*RECIPIENT, datetime.now(UTC))


async def _require_identity(recipient):
    if (recipient.get("user_id"), recipient.get("subject"), recipient.get("email")) != RECIPIENT:
        raise DriveSharingError("recipient_changed")


def _replace_everywhere(monkeypatch, replacements):
    """Swap a function in every loaded module that imported it by name."""
    for name, module in list(sys.modules.items()):
        if module is None or not (name == "hushh_mcp" or name.startswith("hushh_mcp.")):
            continue
        for original, replacement in replacements:
            for attribute, value in list(vars(module).items()):
                if value is original:
                    monkeypatch.setattr(module, attribute, replacement)


class WakeLog:
    """The scheduler wake, counted per stage and never sent."""

    def __init__(self):
        self.stages = Counter()

    async def wake(self, stage):
        if stage not in {"documents", "suggestions", "sharing", "v1"}:
            raise ValueError("invalid Drive stage")
        self.stages[stage] += 1
        return False

    def unsent(self, stage, outcome):
        # A wake that still reached the real function (for example through a
        # captured default) ends here in this environment: count it as well.
        self.stages[stage] += 1
        return False


class IdleWorker:
    """A sharing-drain stage this flow does not use (legacy grants, notices)."""

    async def run(self, **_):
        return {"outcomes": {}}


class GrantGate:
    """The sharing drain's Google grants, which a scenario may hold back."""

    def __init__(self, worker):
        self.worker = worker
        self.paused = False

    async def run(self, **kwargs):
        if self.paused:
            return {"outcomes": {}}
        return await self.worker.run(**kwargs)


def _connect_ledger_out_of_scope():
    # Hashcoin redemptions, bank payouts and Connect balances are separate
    # upkeep in the payout worker. Settlement of this request is not.
    raise ValueError("connect upkeep is out of scope")


def undelivered_refund(gross, *, confirmed, expected):
    """B's refund for approved files not delivered: gross x undelivered/approved."""
    assert (gross * confirmed) % expected == 0, "pick counts that divide the price evenly"
    return gross - gross * confirmed // expected


# --- The pipeline -----------------------------------------------------------


class Flow:
    """B asks, A allows (or B is Trusted), the Drive worker searches, B pays."""

    def __init__(self, monkeypatch, sharing, bulk, world):
        self.sharing = sharing
        self.bulk = bulk
        self.world = world
        self.db = sharing.db
        self.request_id = None
        self.price = None
        self.wakes = WakeLog()
        _replace_everywhere(
            monkeypatch,
            [
                (drive_work_wake.wake_drive_work, self.wakes.wake),
                (identity_module.recipient_identity_for_user, _verified_recipient),
                (identity_module.require_recipient_identity, _require_identity),
            ],
        )
        monkeypatch.setattr(drive_work_wake, "_not_woken", self.wakes.unsent, raising=False)
        # Grants are paced for Google; this suite has no provider quota.
        monkeypatch.setattr(bulk_worker_module, "_START_INTERVAL", 0.0, raising=False)
        real_client = httpx.AsyncClient
        monkeypatch.setattr(
            httpx,
            "AsyncClient",
            lambda **kwargs: real_client(**{**kwargs, "transport": httpx.MockTransport(world)}),
        )
        [row] = self.sql(
            """SELECT connection_generation FROM user_external_connector_connections
               WHERE user_id='owner' AND connector_id='google_drive'"""
        )
        self.generation = row["connection_generation"]
        connection = {
            "status": "connected",
            "validation_state": "verified",
            "verified_policy_hash": LIVE_POLICY_HASH,
            "connection_generation": self.generation,
        }
        credential = {
            "accessToken": "synthetic-access",
            "subject": "owner-google-subject",
            "oauthClientId": "synthetic-oauth-client",
        }
        self.oauth = SimpleNamespace(
            current_credential=AsyncMock(return_value=(connection, credential)),
            lifecycle=SimpleNamespace(read=AsyncMock(return_value=connection), db=self.db),
        )
        monkeypatch.setattr(oauth_module, "_singleton", SimpleNamespace(drive=lambda: self.oauth))
        self.store = DriveOwnerSearchStore(db=self.db)
        self.scanner = DriveOwnerSearchService(
            store=self.store,
            transport=rest.GoogleDriveRestTransport(oauth=self.oauth, adapter=GoogleDriveAdapter()),
            owner_index=NoOwnerIndex(),
        )
        monkeypatch.setattr(bulk_module, "DriveOwnerSearchService", lambda *_, **__: self.scanner)
        monkeypatch.setattr(bulk_module, "default_owner_index", NoOwnerIndex)
        monkeypatch.setattr(payout_worker_module, "connect_config", _connect_ledger_out_of_scope)
        self.stripe = FakeStripe()
        self.payment = DriveRequestPaymentService(db=self.db, stripe_api=self.stripe)
        self.auto = DriveTrustedAutoService(sharing=sharing, bulk=bulk, payment=self.payment)
        self.search_worker = DriveOwnerSearchWorker(self.scanner, trusted_auto=self.auto)
        self.bulk_worker = DriveBulkShareWorker(
            store=bulk,
            oauth=self.oauth,
            adapter=GoogleDrivePermissionAdapter(),
            verify_recipient=_require_identity,
            send_push=lambda *_, **__: 1,
        )
        self.grants = GrantGate(self.bulk_worker)
        idle = IdleWorker()
        self.drain = DriveWorkDrain(
            document_worker=idle,
            suggestion_worker=idle,
            search_worker=idle,
            permission_worker=idle,
            bulk_share_worker=self.grants,
            bulk_removal_worker=idle,
            checkout_worker=DriveRequestPaymentCheckoutWorker(service=self.payment),
            notification_worker=idle,
            refund_worker=DriveRequestPaymentRefundWorker(service=self.payment),
            owner_payout_worker=DriveRequestOwnerPayoutWorker(
                service=DriveRequestOwnerPayoutService(db=self.db, stripe_api=self.stripe)
            ),
            packet_order_worker=idle,
        )
        self.projections = DriveSuggestionStore(db=self.db, authority_key="synthetic-ledger-key")
        self.service = DriveSharingService(
            oauth=self.oauth,
            store=self.projections,
            verify_recipient=_require_identity,
            require_owner=AsyncMock(),
        )

    def sql(self, statement, params=None):
        with self.db.engine.begin() as connection:
            result = connection.execute(text(statement), params or {})
            return [dict(row) for row in result.mappings()] if result.returns_rows else []

    # B and A

    async def ask(self, *, phrase=PHRASE, trusted=False, allow_cents=ALLOW_CENTS):
        """B asks A; A taps Allow at the Allow price unless B is in A's Trusted circle."""
        if trusted:
            self.sql(
                """INSERT INTO one_location_circle_memberships
                   SELECT id,'recipient','active' FROM one_location_circles
                   WHERE owner_user_id='owner' AND system_kind='trusted'"""
            )
        created = await self.service.create(
            recipient=VerifiedGoogleRecipient(*RECIPIENT, datetime.now(UTC)),
            owner_user_id="owner",
            client_request_id=str(uuid4()),
            purpose=ShareRequestPurpose(purpose=phrase, **PERIOD),
            request_time_zone="UTC",
            expected_quote_version=1,
        )
        self.request_id = created["requestId"]
        self.price = PROFILE_CENTS if trusted else allow_cents
        if not trusted:
            await self.service.allow(
                user_id="owner",
                request_id=self.request_id,
                revision=created["revision"],
                amount_cents=allow_cents,
            )
        return self.request_id

    async def approve_positions(self, positions):
        """The owner's manual review: exactly these candidates, one batch."""
        prepared = await DriveRequestBulkService(
            sharing=self.sharing,
            search=self.scanner,
            bulk=self.bulk,
            require_owner=AsyncMock(),
            wake=self.wakes.wake,
        ).prepare(user_id="owner", request_id=self.request_id, positions=list(positions))
        return await DriveBulkShareService(
            store=self.bulk, require_owner=AsyncMock(), wake=self.wakes.wake
        ).approve(
            user_id="owner",
            share_id=prepared["shareId"],
            revision=prepared["revision"],
            review_digest=prepared["reviewDigest"],
        )

    async def deliver_some(self, *, approved, delivered):
        """After payment: hold Google back until all matches are approved, then let
        Google take only the first `delivered` grants."""
        self.grants.paused = True
        for _ in range(4):
            await self.search_drain()
            await self.sharing_drain()
            if self.effect_states() == Counter(queued=approved):
                break
        assert self.effect_states() == Counter(queued=approved), self.effect_states()
        await self.bulk_worker.run(max_jobs=delivered, deadline_seconds=80)
        assert sum(self.world.created.values()) == delivered
        self.grants.paused = False

    async def stop(self):
        """A stops sharing this request (Stop on A's delivery screen)."""
        prepared = await self.projections.prepare_revocation(
            user_id="owner", generation=self.generation, request_id=self.request_id
        )
        return await self.projections.confirm_revocation(
            user_id="owner",
            generation=self.generation,
            request_id=self.request_id,
            revision=prepared["revision"],
            directive_id=prepared["directiveId"],
            review_digest=prepared["reviewDigest"],
            grant_ids=[item["grantId"] for item in prepared["files"]],
            confirmed=True,
        )

    async def pay(self):
        """B completes the open Checkout; Stripe's signed webhook settles the order."""
        order = self.order()
        assert order is not None and order["status"] == "checkout_open", order
        session = self.stripe.sessions[order["stripe_checkout_session_id"]]
        assert session["amount_total"] == self.price
        event = {
            "id": f"evt_{uuid4().hex}",
            "object": "event",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    **session,
                    "payment_status": "paid",
                    "payment_intent": f"pi_{uuid4().hex[:24]}",
                }
            },
        }
        await self.payment.process_webhook(
            payload=json.dumps(event).encode(), signature="t=1,v1=synthetic"
        )
        assert self.order()["status"] == "paid"
        self.world.paid = True

    # Workers

    async def search_slice(self):
        """A short Drive worker drain: the create-time page or one slice of <= 4 pages."""
        return await self.search_worker.run(max_jobs=1, deadline_seconds=24)

    async def search_drain(self):
        """A full Drive worker drain, as the suggestions stage runs it."""
        return await self.search_worker.run(max_jobs=1, deadline_seconds=90)

    async def sharing_drain(self):
        return await self.drain.run(stage="sharing", deadline_seconds=205)

    async def until_checkout_opens(self, *, rounds=3):
        """Short search slices and sharing drains until B can pay.

        Returns the search as it stood when B's payment link was open, or
        None when B could never pay.
        """
        for _ in range(rounds):
            await self.search_slice()
            await self.sharing_drain()
            order = self.order()
            if order is not None and order["status"] == "checkout_open":
                return await self.search()
        return None

    async def until_quiet(self, *, rounds=10):
        """Drive worker and sharing drains until nothing changes any more."""
        previous = None
        for _ in range(rounds):
            await self.search_drain()
            await self.sharing_drain()
            current = self.fingerprint()
            if current == previous and current["search"] in TERMINAL_SEARCH:
                return current
            previous = current
        return previous

    async def settle(self):
        """One more sharing drain: any settlement work left runs here."""
        await self.sharing_drain()

    # Observations

    async def search(self):
        return await self.store.by_client(user_id="owner", client_request_id=self.request_id)

    def order(self):
        rows = self.sql(
            "SELECT * FROM drive_request_payment_orders WHERE request_id=:request",
            {"request": self.request_id},
        )
        return rows[0] if rows else None

    def payout(self):
        rows = self.sql(
            "SELECT * FROM drive_request_owner_payouts WHERE request_id=:request",
            {"request": self.request_id},
        )
        return rows[0] if rows else None

    def refunds(self):
        return self.sql(
            "SELECT * FROM drive_request_payment_refunds WHERE request_id=:request",
            {"request": self.request_id},
        )

    def request_status(self):
        [row] = self.sql(
            "SELECT status FROM drive_share_requests WHERE request_id=:request",
            {"request": self.request_id},
        )
        return row["status"]

    def batches(self):
        return self.sql(
            """SELECT share_id,status,file_count,approved_at IS NOT NULL AS approved
               FROM drive_bulk_shares WHERE user_id='owner' AND origin_request_id=:request
               ORDER BY created_at,share_id""",
            {"request": self.request_id},
        )

    def committed(self):
        """The search's committed results: position -> Drive file id."""
        rows = self.sql(
            """SELECT r.job_id,r.position,r.metadata_envelope
               FROM drive_owner_search_results r JOIN drive_owner_search_jobs j
                 ON j.job_id=r.job_id
               WHERE j.user_id='owner' AND j.client_request_id=:request
               ORDER BY r.position""",
            {"request": self.request_id},
        )
        return {
            row["position"]: self.store.search_cipher.open(
                row["metadata_envelope"],
                user_id="owner",
                resource_id=f"{row['job_id']}:{row['position']}",
                purpose="owner-search-result",
            )["id"]
            for row in rows
        }

    def frozen_files(self):
        """Every file frozen into a batch for this request: (share, file id)."""
        committed = self.committed()
        return [
            (str(row["share_id"]), committed[row["source_position"]])
            for row in self.sql(
                """SELECT share_id,source_position FROM drive_bulk_share_files
                   WHERE user_id='owner' AND origin_request_id=:request
                   ORDER BY share_id,source_position""",
                {"request": self.request_id},
            )
        ]

    def effect_states(self):
        return Counter(
            row["state"]
            for row in self.sql(
                """SELECT e.state FROM drive_bulk_share_effects e
                   JOIN drive_bulk_shares b ON b.share_id=e.share_id
                   WHERE b.origin_request_id=:request""",
                {"request": self.request_id},
            )
        )

    def fingerprint(self):
        rows = self.sql(
            """SELECT j.status AS search,j.pages_scanned,j.matched,
                 (SELECT status FROM drive_request_payment_orders
                    WHERE request_id=:request) AS order_status,
                 (SELECT status FROM drive_request_owner_payouts
                    WHERE request_id=:request) AS payout_status,
                 (SELECT status FROM drive_request_payment_refunds
                    WHERE request_id=:request) AS refund_status,
                 (SELECT status FROM drive_share_requests
                    WHERE request_id=:request) AS request_status
               FROM drive_owner_search_jobs j
               WHERE j.user_id='owner' AND j.client_request_id=:request""",
            {"request": self.request_id},
        )
        current = rows[0] if rows else {"search": None}
        return {
            **current,
            "effects": sorted(self.effect_states().items()),
            "batches": len(self.batches()),
            "granted": sum(self.world.created.values()),
        }

    async def payment_view(self):
        state = await self.payment.get_payment(
            requester_user_id="recipient", request_id=self.request_id
        )
        return state["paymentView"]

    async def delivery_to_b(self):
        return await self.service.delivery(
            user_id="recipient", request_id=self.request_id, views=True
        )


@pytest.fixture
def flow_factory(request_bulk, sharing, monkeypatch):
    def make(world):
        return Flow(monkeypatch, sharing, request_bulk, world)

    return make


def _settled_once(flow, *, expected, confirmed):
    """The owner payout was finalized on these counts; B's refund matches them."""
    refund_cents = undelivered_refund(flow.price, confirmed=confirmed, expected=expected)
    payout = flow.payout()
    assert payout is not None, "no owner payout ledger for a paid request"
    assert payout["finalized_at"] is not None, f"payout never settled: {payout['status']}"
    assert (payout["expected_files"], payout["confirmed_files"]) == (expected, confirmed)
    assert payout["refund_amount_cents"] == refund_cents
    assert payout["retained_amount_cents"] == flow.price - refund_cents
    refunds = flow.refunds()
    if refund_cents:
        assert [(row["amount_cents"], row["status"]) for row in refunds] == [
            (refund_cents, "succeeded")
        ]
        assert flow.stripe.refund_creates == [refund_cents]
    else:
        assert refunds == [] and flow.stripe.refund_creates == []
    return payout


async def _settle_again_is_a_no_op(flow, payout):
    keys = ("finalized_at", "expected_files", "confirmed_files", "refund_amount_cents")
    refunds = [(r["amount_cents"], r["status"], r["stripe_refund_id"]) for r in flow.refunds()]
    creates = list(flow.stripe.refund_creates)
    await flow.settle()
    after = flow.payout()
    assert {key: after[key] for key in keys} == {key: payout[key] for key in keys}
    assert [(r["amount_cents"], r["status"], r["stripe_refund_id"]) for r in flow.refunds()] == (
        refunds
    )
    assert flow.stripe.refund_creates == creates


# --- Scenarios ---------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("trusted", [False, True], ids=["allowed", "trusted"])
async def test_s1_checkout_opens_mid_search_and_all_35_stream_after_payment(flow_factory, trusted):
    """35 matches: 3 on Drive's first 25-row page, 32 on later pages."""
    matches = thirty_five_matches()
    world = DriveWorld([*stale(22), *matches, *noise(500)])
    flow = flow_factory(world)
    await flow.ask(trusted=trusted)

    search_when_payable = await flow.until_checkout_opens()
    assert search_when_payable is not None, (
        f"B can never pay: order={flow.order() and flow.order()['status']} "
        f"search={(await flow.search())['status']}"
    )
    # B's payment ask is live while A's agent is still searching, at A's
    # Allow price (a Trusted request: A's profile price).
    assert search_when_payable["status"] in {"queued", "running"}
    view = await flow.payment_view()
    assert (view["state"], view["amountCents"]) == ("payable", flow.price)
    assert world.created == Counter()
    assert world.shared_with_b() == set()

    await flow.pay()
    # Delivery starts while the search is still running: B is never idle.
    for _ in range(2):
        await flow.search_slice()
        await flow.sharing_drain()
        if world.created:
            break
    assert world.created, "nothing was shared after payment"
    assert (await flow.search())["status"] in {"queued", "running"}

    await flow.until_quiet()
    expected = {item["id"] for item in matches}
    assert world.created_before_payment == []
    assert dict(world.created) == dict.fromkeys(expected, 1)
    assert world.shared_with_b() == expected
    frozen = flow.frozen_files()
    assert sorted(file_id for _, file_id in frozen) == sorted(expected)
    assert all(batch["file_count"] <= 25 for batch in flow.batches())
    assert all(batch["approved"] for batch in flow.batches())
    delivered = await flow.delivery_to_b()
    assert (delivered["sharedCount"], delivered["fileCount"]) == (35, 35)
    payout = _settled_once(flow, expected=35, confirmed=35)
    await _settle_again_is_a_no_op(flow, payout)


@pytest.mark.asyncio
@pytest.mark.skipif(PAY_AT_ALLOW, reason="with pay-at-Allow the order exists from Allow")
async def test_s2_no_match_creates_no_order_and_grants_nothing(flow_factory):
    world = DriveWorld([*stale(5), *noise(20)])
    flow = flow_factory(world)
    await flow.ask()
    await flow.until_quiet()

    assert (await flow.search())["status"] == "completed"
    assert flow.request_status() == "no_match"
    assert flow.order() is None
    assert flow.batches() == []
    assert world.created == Counter() and world.shared_with_b() == set()


@pytest.mark.asyncio
@pay_at_allow_only
async def test_s2_paid_at_allow_no_match_is_refunded_in_full_once(flow_factory):
    world = DriveWorld([*stale(5), *noise(20)])
    flow = flow_factory(world)
    await flow.ask()
    # The payment ask is out before the search has looked at Drive.
    await flow.sharing_drain()
    assert flow.order()["status"] == "checkout_open"
    await flow.pay()
    await flow.until_quiet()

    assert flow.request_status() == "no_match"
    assert world.created == Counter() and world.shared_with_b() == set()
    assert [(row["amount_cents"], row["status"]) for row in flow.refunds()] == [
        (ALLOW_CENTS, "succeeded")
    ]
    assert flow.stripe.refund_creates == [ALLOW_CENTS]
    assert flow.order()["status"] == "refunded"
    creates = list(flow.stripe.refund_creates)
    await flow.settle()
    assert flow.stripe.refund_creates == creates


@pytest.mark.asyncio
@pay_at_allow_only
async def test_s0_paid_at_allow_checkout_opens_before_any_frozen_batch(flow_factory):
    world = DriveWorld([*in_period(4), *noise(10)])
    flow = flow_factory(world)
    await flow.ask()
    # The order exists from Allow, before the search has frozen anything.
    assert flow.order() is not None
    assert flow.batches() == []
    await flow.sharing_drain()
    assert flow.order()["status"] == "checkout_open"
    assert flow.batches() == []
    view = await flow.payment_view()
    assert (view["state"], view["amountCents"]) == ("payable", ALLOW_CENTS)
    await flow.pay()
    await flow.until_quiet()
    assert dict(world.created) == dict.fromkeys((f"m-{i:03d}" for i in range(4)), 1)


@pytest.mark.asyncio
async def test_s3_partial_delivery_refunds_the_three_failed_files_once(flow_factory):
    matches = in_period(10)
    world = DriveWorld(matches, rejected={"m-002", "m-005", "m-008"})
    flow = flow_factory(world)
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "B can never pay"
    await flow.pay()
    await flow.until_quiet()

    assert set(world.created) == {item["id"] for item in matches} - world.rejected
    assert world.shared_with_b() == set(world.created)
    # 10 approved, 7 delivered: 3/10 of the price comes back to B, once.
    payout = _settled_once(flow, expected=10, confirmed=7)
    await _settle_again_is_a_no_op(flow, payout)


@pytest.mark.asyncio
async def test_s4_owner_stop_mid_delivery_settles_once_for_undelivered_files(flow_factory):
    matches = in_period(20)
    world = DriveWorld(matches)
    flow = flow_factory(world)
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "B can never pay"
    await flow.pay()
    # All 20 are approved; Google has taken eight grants when A stops.
    await flow.deliver_some(approved=20, delivered=8)
    await flow.stop()
    await flow.until_quiet()

    assert sum(world.created.values()) == 8
    # 20 approved, 8 delivered: 12/20 of the price comes back to B, once.
    payout = _settled_once(flow, expected=20, confirmed=8)
    await _settle_again_is_a_no_op(flow, payout)


@pytest.mark.asyncio
async def test_s5_paid_request_whose_search_ends_incomplete_settles_once(flow_factory):
    matches = in_period(6)
    # The incomplete page comes long after B pays and the six are approved.
    world = DriveWorld([*matches, *noise(500)], incomplete_tail=True)
    flow = flow_factory(world)
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "B can never pay"
    await flow.pay()
    await flow.sharing_drain()
    await flow.search_slice()
    await flow.sharing_drain()
    assert (await flow.search())["incompleteSearch"] is False
    await flow.until_quiet()

    search = await flow.search()
    assert search["incompleteSearch"] is True
    assert search["status"] in TERMINAL_SEARCH
    assert dict(world.created) == dict.fromkeys((item["id"] for item in matches), 1)
    payout = _settled_once(flow, expected=6, confirmed=6)
    await _settle_again_is_a_no_op(flow, payout)


@pytest.mark.asyncio
async def test_s6_owner_approved_unpaid_batch_is_never_offered_until_paid(
    flow_factory, monkeypatch
):
    matches = in_period(25, title="Unit 7 site inspection report")
    world = DriveWorld(matches)
    flow = flow_factory(world)
    await flow.ask(phrase=MANUAL_PHRASE)
    await flow.until_quiet()
    assert (await flow.search())["status"] == "completed"
    # Owner review: the search freezes nothing on its own.
    assert flow.batches() == []
    candidates = flow.committed()
    assert len(candidates) == 25

    approved = await flow.approve_positions(sorted(candidates))
    claims = Counter()
    real_claim = DriveBulkShareStore.claim

    async def counted_claim(self, *, share_id, **kwargs):
        claims[str(share_id)] += 1
        return await real_claim(self, share_id=share_id, **kwargs)

    monkeypatch.setattr(DriveBulkShareStore, "claim", counted_claim)
    for _ in range(5):
        await flow.sharing_drain()
    assert claims[approved["shareId"]] == 0, (
        f"unpaid batch offered {claims[approved['shareId']]} times in 5 sharing drains"
    )
    assert world.created == Counter()

    await flow.pay()
    await flow.sharing_drain()
    assert dict(world.created) == dict.fromkeys(candidates.values(), 1)


@pytest.mark.asyncio
async def test_s7_unpaid_35_page_search_wakes_sharing_at_most_twice(flow_factory):
    # One title-pass page (2 matches + 23 stale), then 34 full-text pages.
    world = DriveWorld([*in_period(2), *stale(23), *noise(825)])
    flow = flow_factory(world)
    await flow.ask()
    flow.wakes.stages.clear()
    for _ in range(6):
        await flow.search_drain()
        if (await flow.search())["status"] in TERMINAL_SEARCH:
            break
    assert (await flow.search())["status"] == "completed"
    assert world.list_pages >= 35
    order = flow.order()
    assert order is not None and order["status"] in {"awaiting_payment", "checkout_open"}
    assert world.created == Counter()
    assert flow.wakes.stages["sharing"] <= 2, flow.wakes.stages


@pytest.mark.asyncio
async def test_s8_owner_approves_25_of_40_then_checkout_opens_and_only_those_25_stream(
    flow_factory,
):
    matches = in_period(40, title="Unit 7 site inspection report")
    world = DriveWorld(matches)
    flow = flow_factory(world)
    await flow.ask(phrase=MANUAL_PHRASE)
    await flow.until_quiet()
    candidates = flow.committed()
    assert len(candidates) == 40
    chosen = sorted(candidates)[:25]
    await flow.approve_positions(chosen)

    for _ in range(3):
        await flow.sharing_drain()
        if flow.order()["status"] == "checkout_open":
            break
    assert flow.order()["status"] == "checkout_open", "B can never pay for A's 25 files"
    assert world.created == Counter()
    await flow.pay()
    await flow.until_quiet()

    assert dict(world.created) == dict.fromkeys((candidates[p] for p in chosen), 1)


@pytest.mark.asyncio
async def test_s9_production_keeps_the_owner_review_contract(flow_factory, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("STRIPE_MODE", "live")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_local_only_synthetic_key")
    monkeypatch.setenv("CONNECTOR_PRODUCTION_OWNER_COHORT", "owner,recipient")
    clear_runtime_settings_caches()
    world = DriveWorld([*stale(3), *in_period(12), *noise(10)])
    flow = flow_factory(world)
    flow.sql(
        """INSERT INTO stripe_owner_payout_accounts
           (stripe_mode,user_id,stripe_account_id,details_submitted,payouts_enabled,account_ready)
           VALUES ('live','owner','acct_live_owner',TRUE,TRUE,TRUE)"""
    )
    # Production requests keep the whole-dollar price rule.
    await flow.ask(allow_cents=PROFILE_CENTS)
    await flow.until_quiet()

    # The old contract: candidates wait for A's exact review; nothing is
    # frozen, charged or shared automatically.
    search = await flow.search()
    assert search["status"] == "completed" and search["matched"] >= 12
    assert search["coverage"]["ownerReviewRequired"] is True
    assert flow.batches() == []
    assert flow.order() is None
    assert world.created == Counter()
    assert flow.request_status() == "pending"


@pytest.mark.asyncio
async def test_s10_files_b_already_has_count_as_delivered(flow_factory):
    matches = thirty_five_matches()
    prior = {"a-001", "b-020"}
    world = DriveWorld([*stale(22), *matches, *noise(60)], already_shared=prior)
    flow = flow_factory(world)
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "checkout refused for prior access"
    await flow.pay()
    await flow.until_quiet()

    expected = {item["id"] for item in matches}
    assert dict(world.created) == dict.fromkeys(expected - prior, 1)
    assert world.shared_with_b() == expected
    delivered = await flow.delivery_to_b()
    assert delivered["sharedCount"] == 35
    payout = _settled_once(flow, expected=35, confirmed=35)
    await _settle_again_is_a_no_op(flow, payout)


@pytest.mark.asyncio
async def test_s11_paid_request_that_expires_mid_delivery_settles_once(flow_factory):
    matches = in_period(20)
    world = DriveWorld(matches)
    flow = flow_factory(world)
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "B can never pay"
    await flow.pay()
    # All 20 are approved; Google has taken eight grants when the request
    # reaches its deadline, still pending.
    await flow.deliver_some(approved=20, delivered=8)
    flow.sql(
        """UPDATE drive_share_requests SET expires_at=clock_timestamp()
           WHERE request_id=:request AND status='pending'""",
        {"request": flow.request_id},
    )
    await flow.until_quiet()

    assert sum(world.created.values()) == 8
    payout = _settled_once(flow, expected=20, confirmed=8)
    await _settle_again_is_a_no_op(flow, payout)


# --- Review fixes: ended searches, parked starts, unpaid and void earnings ---


def _end_search(flow, status, *, error_code=None):
    """The request's search stops: Drive failed it for good or A stopped it."""
    flow.sql(
        """UPDATE drive_owner_search_jobs SET status=:status,error_code=:error,
             lease_id=NULL,lease_expires_at=NULL
           WHERE user_id='owner' AND client_request_id=:request""",
        {"request": flow.request_id, "status": status, "error": error_code},
    )


def _ended_by(ended):
    return {"failed": ("failed", "provider_unavailable"), "stopped": ("stopped", None)}[ended]


async def _paid_and_five_delivered(flow, world):
    """B paid; the five matches are shared while the search is still running."""
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "B can never pay"
    await flow.pay()
    for _ in range(3):
        await flow.search_slice()
        await flow.sharing_drain()
        if len(world.created) == 5:
            break
    assert sum(world.created.values()) == 5
    assert (await flow.search())["status"] in {"queued", "running"}


@pytest.mark.asyncio
@pytest.mark.parametrize("ended", ["failed", "stopped"])
async def test_s12_paid_request_whose_search_a_can_resume_never_settles_early(flow_factory, ended):
    """A failed or stopped search is not the end of delivery: A's Search again
    resumes it at its cursor. B is never charged in full for part of the set,
    and the request stays open for A to resume, until A stops or its deadline."""
    world = DriveWorld([*in_period(5), *noise(800)])
    flow = flow_factory(world)
    await _paid_and_five_delivered(flow, world)
    status, error_code = _ended_by(ended)
    _end_search(flow, status, error_code=error_code)
    for _ in range(3):
        await flow.settle()

    assert flow.request_status() == "pending"
    payout = flow.payout()
    assert (payout["status"], payout["finalized_at"]) == ("awaiting_delivery", None)
    assert flow.refunds() == [] and flow.stripe.refund_creates == []
    resumed = await flow.store.takeover_request(user_id="owner", request_id=flow.request_id)
    assert resumed is not None and resumed["status"] == "queued"


@pytest.mark.asyncio
@pytest.mark.parametrize("ended", ["failed", "stopped"])
async def test_s13_held_matches_survive_a_resumable_search_end_after_payment(flow_factory, ended):
    """The first slice froze five matches before B paid. The search then stops
    before they are approved: they stay held for A, nothing is refunded as a
    no-match, and A's Search again resumes the search."""
    world = DriveWorld([*in_period(5), *noise(800)])
    flow = flow_factory(world)
    await flow.ask()
    assert await flow.until_checkout_opens() is not None, "B can never pay"
    assert [(b["status"], b["approved"]) for b in flow.batches()] == [("review_ready", False)]
    await flow.pay()
    status, error_code = _ended_by(ended)
    _end_search(flow, status, error_code=error_code)
    for _ in range(3):
        await flow.settle()

    assert flow.request_status() == "pending"
    assert [(b["status"], b["approved"]) for b in flow.batches()] == [("review_ready", False)]
    assert flow.refunds() == [] and flow.stripe.refund_creates == []
    assert flow.payout()["status"] == "awaiting_delivery"
    resumed = await flow.store.takeover_request(user_id="owner", request_id=flow.request_id)
    assert resumed is not None and resumed["status"] == "queued"


@pytest.mark.asyncio
async def test_s14_paid_request_whose_drive_connection_changed_settles_once(flow_factory):
    """A search on a Drive connection that has since changed can never resume:
    takeover, retry and review all refuse it. Delivery ended; it settles once."""
    world = DriveWorld([*in_period(5), *noise(800)])
    flow = flow_factory(world)
    await _paid_and_five_delivered(flow, world)
    flow.sql(
        """UPDATE user_external_connector_connections
           SET connection_generation=connection_generation+1
           WHERE user_id='owner' AND connector_id='google_drive'"""
    )
    _end_search(flow, "failed", error_code="connection_changed")
    for _ in range(2):
        await flow.settle()

    assert flow.request_status() == "completed"
    payout = _settled_once(flow, expected=5, confirmed=5)
    await _settle_again_is_a_no_op(flow, payout)


@pytest.mark.asyncio
@pay_at_allow_only
async def test_s15_unpaid_request_that_finds_nothing_voids_its_earning_once(flow_factory):
    """Pay-at-Allow enrolls A's earning before the search. Nothing matched and
    B never paid: the earning is void, once, and leaves the payout lane."""
    world = DriveWorld([*stale(5), *noise(20)])
    flow = flow_factory(world)
    await flow.ask()
    await flow.sharing_drain()
    assert flow.order()["status"] == "checkout_open"
    await flow.until_quiet()

    assert flow.request_status() == "no_match"
    payout = flow.payout()
    assert (payout["status"], payout["finalized_at"]) == ("void", None)
    assert flow.refunds() == [] and flow.stripe.refund_creates == []
    await flow.settle()
    assert flow.payout()["updated_at"] == payout["updated_at"]


def _unshareable(count):
    """Matches by title and period that A's Drive does not let A share."""
    return [
        report(f"u-{index:03d}", FIRST_DAY + timedelta(days=index), can_share=False)
        for index in range(count)
    ]


@pytest.mark.asyncio
@pay_at_allow_only
async def test_s16_paid_request_whose_matches_a_cannot_share_is_refunded_and_void(
    flow_factory,
):
    """Every match fails Drive's canShare for A, so nothing can be sent: a full
    refund for B, a void earning for A, and no partial-share outcome."""
    world = DriveWorld([*_unshareable(3), *noise(20)])
    flow = flow_factory(world)
    await flow.ask()
    await flow.sharing_drain()
    await flow.pay()
    await flow.until_quiet()

    assert (await flow.search())["status"] == "completed"
    assert flow.batches() == [] and world.created == Counter()
    assert flow.request_status() == "no_match"
    assert [(row["amount_cents"], row["status"]) for row in flow.refunds()] == [
        (ALLOW_CENTS, "succeeded")
    ]
    assert flow.stripe.refund_creates == [ALLOW_CENTS]
    assert flow.order()["status"] == "refunded"
    assert flow.payout()["status"] == "void"
    await flow.settle()
    assert flow.stripe.refund_creates == [ALLOW_CENTS]
    assert flow.payout()["status"] == "void"


@pytest.mark.asyncio
@pay_at_allow_only
async def test_s17_unpaid_request_whose_matches_a_cannot_share_ends_and_stops_asking(
    flow_factory, monkeypatch
):
    """The search finished before B's link was made and found only files A
    cannot share. The request ends at once: B is not offered a checkout on
    every drain until the deadline, and A's earning is void."""
    world = DriveWorld([*_unshareable(3), *noise(20)])
    flow = flow_factory(world)
    await flow.ask()
    for _ in range(3):
        await flow.search_drain()
        if (await flow.search())["status"] in TERMINAL_SEARCH:
            break
    assert (await flow.search())["status"] == "completed"
    attempts = Counter()
    real = DriveRequestPaymentService.checkout

    async def counted(self, **kwargs):
        attempts[kwargs["request_id"]] += 1
        return await real(self, **kwargs)

    monkeypatch.setattr(DriveRequestPaymentService, "checkout", counted)
    for _ in range(3):
        await flow.sharing_drain()

    assert flow.request_status() == "no_match"
    assert attempts[flow.request_id] == 0
    assert flow.order()["status"] == "awaiting_payment"
    assert flow.payout()["status"] == "void"


async def _park_automatic_start(flow):
    """Three failed starts: the automatic queue never starts this search again."""
    for _ in range(3):
        await flow.sharing.defer_trusted_search(
            user_id="owner", request_id=flow.request_id, code="preparation_unavailable"
        )
    flow.sql(
        """UPDATE drive_share_requests SET preparation_next_at=clock_timestamp()
           WHERE request_id=:request""",
        {"request": flow.request_id},
    )
    due = await flow.sharing.due_trusted_searches(limit=20)
    assert flow.request_id not in {item["request_id"] for item in due}


@pytest.mark.asyncio
@pay_at_allow_only
async def test_s18_b_is_never_asked_to_pay_for_a_search_that_can_never_start(flow_factory, caplog):
    import logging

    world = DriveWorld([*in_period(4), *noise(10)])
    flow = flow_factory(world)
    await flow.ask()
    await _park_automatic_start(flow)
    caplog.set_level(logging.INFO, logger="hushh_mcp.services.drive_request_checkout_refusals")
    for _ in range(2):
        await flow.sharing_drain()

    order = flow.order()
    assert (order["status"], order["stripe_checkout_session_id"]) == ("awaiting_payment", None)
    assert flow.stripe.sessions == {}
    assert "drive_request_checkout.refused reason=search_parked code=payment_not_ready" in {
        record.getMessage() for record in caplog.records
    }
    assert (await flow.payment_view())["state"] != "payable"
    # The checkout lane's own gate names it, before any later authority check.
    with pytest.raises(DriveSharingError) as refused:
        await flow.bulk.autoshare_checkout_sources(user_id="owner", request_id=flow.request_id)
    assert (str(refused.value), refused.value.reason) == ("payment_not_ready", "search_parked")


@pytest.mark.asyncio
@pay_at_allow_only
async def test_s19_a_payment_made_after_the_search_start_parked_is_refunded(flow_factory):
    """B's link was made while the search was queued; its start then failed for
    good. A payment on that link is never kept: it is refunded in full."""
    world = DriveWorld([*in_period(4), *noise(10)])
    flow = flow_factory(world)
    await flow.ask()
    await flow.sharing_drain()
    assert flow.order()["status"] == "checkout_open"
    await _park_automatic_start(flow)
    await flow.pay()
    order = flow.order()
    assert (order["reconciliation_required"], order["reconciliation_reason"]) == (
        True,
        "authority_changed",
    )
    for _ in range(2):
        await flow.settle()

    assert [(row["amount_cents"], row["status"]) for row in flow.refunds()] == [
        (ALLOW_CENTS, "succeeded")
    ]
    assert flow.stripe.refund_creates == [ALLOW_CENTS]
    assert world.created == Counter()


@pytest.mark.asyncio
@pay_at_allow_only
async def test_s20_a_request_waits_for_the_owners_running_search_and_never_parks(flow_factory):
    """A runs one Drive search at a time. A second allowed request waits for
    the first search; waiting never counts toward the three failed starts, so
    it is never parked for good and B can still pay for it."""
    world = DriveWorld([*in_period(3), *noise(800)])
    flow = flow_factory(world)
    await flow.ask()
    await flow.search_slice()
    assert (await flow.search())["status"] in {"queued", "running"}
    second = await flow.ask()
    for _ in range(4):
        flow.sql(
            """UPDATE drive_share_requests SET preparation_next_at=clock_timestamp()
               WHERE request_id=:request""",
            {"request": second},
        )
        assert await flow.auto.start_pending(max_jobs=1) == {"started": 0, "deferred": 1}

    [row] = flow.sql(
        """SELECT preparation_attempts,preparation_error_code,bulk_search_started_at
           FROM drive_share_requests WHERE request_id=:request""",
        {"request": second},
    )
    assert tuple(row.values()) == (0, "trusted_auto_queued", None)
    await flow.sharing_drain()
    assert flow.order()["status"] == "checkout_open"
