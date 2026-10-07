"""Synthetic ports for the browser's owner and transport boundary tests."""

import asyncio
from dataclasses import dataclass, field

from hushh_mcp.services.pod_browser.contracts import (
    BrowserAction,
    BrowserBinding,
    BrowserFrame,
    BrowserNetworkPermit,
    BrowserReadiness,
    BrowserRefused,
)
from hushh_mcp.services.pod_browser.control import BrowserControl


def binding(**changes):
    return BrowserBinding(
        **dict(
            {
                "owner_id": "owner",
                "pod_id": "pod",
                "incarnation": "epoch",
                "task_id": "task",
                "environment": "development",
                "expires_at": 2000,
            },
            **changes,
        )
    )


def readiness(**changes):
    return BrowserReadiness(
        **{
            "cloud": "gcp",
            "component_digest": "sha256:" + "a" * 64,
            "isolated": True,
            "direct_egress_denied": True,
            "broker_bridge_verified": True,
            "ephemeral_bridge_verified": True,
            "private_access_denied": True,
            "model_transport_verified": True,
            "model_name": "gemini-3.7-flash",
            "model_transport": "google.adk.models.google_llm.Gemini",
            **changes,
        }
    )


@dataclass
class Authority:
    revoked: bool = False
    approved: bool = False
    journal: list = field(default_factory=list)

    async def check_binding(self, value):
        if self.revoked or value.owner_id != "owner" or value.incarnation != "epoch":
            raise BrowserRefused("BROWSER_BINDING_REFUSED")

    async def check_no_pending_dispatch(self, value):
        await self.check_binding(value)

    async def authorize_action(self, value, action):
        await self.check_binding(value)
        if action.operation == "type" and not self.approved:
            raise BrowserRefused("BROWSER_APPROVAL_REQUIRED")

    async def journal_dispatch(self, value, action):
        self.journal.append((action.sequence, "dispatch"))

    async def settle_dispatch(self, value, action, *, uncertain):
        self.journal.append((action.sequence, "uncertain" if uncertain else "settled"))

    async def authorize_request(self, value, request, commitment):
        await self.check_binding(value)
        if not self.approved:
            raise BrowserRefused("BROWSER_APPROVAL_REQUIRED")
        return BrowserNetworkPermit(effect_receipt_required=False)


@dataclass
class Executor:
    calls: list = field(default_factory=list)
    fail: bool = False
    entered: asyncio.Event = field(default_factory=asyncio.Event)
    release: asyncio.Event | None = None

    async def initialize(self):
        self.calls.append("initialize")

    async def execute(self, action):
        self.calls.append(action.operation)
        self.entered.set()
        if self.release:
            await self.release.wait()
        if self.fail:
            raise BrowserRefused("BROWSER_TRANSPORT_UNAVAILABLE")
        return BrowserFrame(
            sequence=action.sequence,
            width=1280,
            height=720,
            png=b"\x89PNG\r\n\x1a\nfixture",
            url="https://example.com/",
        )

    async def close(self):
        self.calls.append("close")


def control(*, ready=None, auth=None, driver=None, bound=None, clock=lambda: 1000):
    return BrowserControl(
        binding=bound or binding(),
        readiness=ready or readiness(),
        executor=driver or Executor(),
        authority=auth or Authority(),
        wall_clock=clock,
        clock=clock,
    )


class _BrowserConsent(Authority):
    """Synthetic exact approvals only; not a runtime authority adapter."""

    def __init__(self):
        super().__init__()
        self.grants = set()

    def approve(self, purpose, terms):
        import json

        self.grants.add((purpose, json.dumps(terms, sort_keys=True)))

    async def require(self, bound, purpose, terms):
        import json

        await self.check_binding(bound)
        if (purpose, json.dumps(terms, sort_keys=True)) not in self.grants:
            raise BrowserRefused("BROWSER_OWNER_APPROVAL_REQUIRED")


def _remembered(now=1000):
    from hushh_mcp.services.pod_browser.session_state import persistent_state

    return persistent_state(
        {
            "cookies": [
                {
                    "name": "persistent",
                    "value": "synthetic-session",
                    "domain": "example.com",
                    "path": "/",
                    "expires": now + 100,
                    "httpOnly": True,
                    "secure": True,
                    "sameSite": "Strict",
                },
                {
                    "name": "session-only",
                    "value": "not-retained",
                    "domain": "example.com",
                    "path": "/",
                    "expires": -1,
                    "httpOnly": True,
                    "secure": True,
                    "sameSite": "Lax",
                },
            ],
            "origins": [
                {
                    "origin": "https://example.com",
                    "localStorage": [{"name": "setting", "value": "fixture"}],
                }
            ],
        },
        frozenset({"https://example.com"}),
        now=now,
    )


async def _session_fixture(tmp_path, store=None):
    from hushh_mcp.services.pod_browser.sessions import BrowserSessions
    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

    auth, closed = _BrowserConsent(), []

    async def fence(site):
        closed.append(site)

    store = store or LocalObjectStore(str(tmp_path))
    log = PodCommitLog(store, b"S" * 32, owner_id="owner")
    sessions = BrowserSessions(
        owner_id="owner",
        store=store,
        log=log,
        custody_key=b"S" * 32,
        consent=auth,
        readiness=readiness(),
        fence_live_contexts=fence,
        clock=lambda: 1000,
    )
    site = sessions.site_id("https://example.com", "opaque-account")
    state, origins = _remembered(), frozenset({"https://example.com"})
    auth.approve(
        "session_remember",
        {
            "site": site,
            "generation": 0,
            "origins": sorted(origins),
            "state": state.model_dump(mode="json"),
        },
    )
    return sessions, auth, store, log, site, state, origins, closed


def browser_export_package():
    import base64
    import time

    from hushh_mcp.consent.export_envelope import (
        ConsentExportAadV2,
        ConsentExportEnvelopeSubmissionV2,
        connector_key_fingerprint,
    )
    from hushh_mcp.services.pod_browser.information import (
        AuthorizedScopedExport,
        InformationField,
    )
    from tests.helpers.consent_export_crypto import (
        encrypt_export_for_connector,
        generate_connector_key,
    )

    private, public = generate_connector_key()
    field = InformationField(
        domain="preferences",
        path="favorite_color",
        export_revision=2,
        source_content_revision=11,
        source_manifest_revision=7,
    )
    aad = ConsentExportAadV2(
        app_id="browser-task",
        grant_id="synthetic-grant",
        export_id="123e4567-e89b-12d3-a456-426614174000",
        revision=2,
        machine_scope=field.scope,
        scope_handle="s_fixture_scope",
        recipient_key_fingerprint=connector_key_fingerprint(public),
        expires_at_ms=int((time.time() + 60) * 1000),
    )
    encrypted = encrypt_export_for_connector(
        {
            "preferences": {"favorite_color": "blue"},
            "__export_metadata": {
                "source_domain": "preferences",
                "approved_paths": ["favorite_color"],
            },
        },
        connector_public_key_b64=public,
        connector_key_id="fixture",
        aad=aad,
    )
    package = AuthorizedScopedExport(
        binding=binding(),
        field=field,
        app_id=aad.app_id,
        grant_id=aad.grant_id,
        recipient_fingerprint=aad.recipient_key_fingerprint,
        source_content_revision=11,
        source_manifest_revision=7,
        envelope=ConsentExportEnvelopeSubmissionV2.model_validate(encrypted["exportEnvelope"]),
        iv_b64=encrypted["encryptedIv"],
        tag_b64=encrypted["encryptedTag"],
        ciphertext=base64.b64decode(encrypted["encryptedData"]),
        connector_private_key=private,
        wrapped_key_bundle={
            "wrapped_export_key": encrypted["wrappedExportKey"],
            "wrapped_key_iv": encrypted["wrappedKeyIv"],
            "wrapped_key_tag": encrypted["wrappedKeyTag"],
            "sender_public_key": encrypted["senderPublicKey"],
            "wrapping_alg": encrypted["wrappingAlg"],
        },
    )

    return package, field


def task_runtime_fixture(monkeypatch, *, ready=None, model=None, log=None):
    """Synthetic adapters prove composition, never provider qualification."""
    import json
    from types import SimpleNamespace

    from hushh_mcp.services.pod_browser.consent import private_commitment
    from hushh_mcp.services.pod_browser.task_contracts import (
        BrowserOwnerAccess,
        BrowserReviewOffer,
        BrowserTaskRequest,
    )
    from hushh_mcp.services.pod_browser.task_runtime import BrowserTaskRuntime
    from hushh_mcp.services.pod_upgrade_admission import PodUpgradeAdmission

    monkeypatch.setenv("POD_COMPUTER_USE_ENABLED", "true")
    auth, driver = Authority(approved=True), Executor()

    class Log:
        def __init__(self):
            self.records = []

        async def require_open(self):
            return None

        async def replay(self):
            return list(self.records)

        async def append(self, kind, payload):
            # Simulate an immutable sealed-log record, never retaining DTO references.
            record = {"kind": kind, "payload": json.loads(json.dumps(payload))}
            self.records.append(record)
            return record

    class Reviews:
        def __init__(self):
            self.offers, self.grants = {}, set()

        async def check_binding(self, bound):
            await auth.check_binding(bound)

        def identity(self, bound, purpose, terms):
            return (bound.task_id, purpose, private_commitment(b"r" * 32, terms))

        async def require(self, bound, purpose, terms):
            await self.check_binding(bound)
            if self.identity(bound, purpose, terms) not in self.grants:
                raise BrowserRefused("BROWSER_OWNER_APPROVAL_REQUIRED")

        async def offer_review(self, bound, purpose, terms):
            identity = self.identity(bound, purpose, terms)
            review_id = "review_" + identity[2]
            self.offers[review_id] = (bound, identity)
            return BrowserReviewOffer(review_id=review_id, purpose=purpose, terms=terms)

        async def confirm_review(self, bound, review_id):
            await self.check_binding(bound)
            original, identity = self.offers[review_id]
            if bound != original:
                raise BrowserRefused("BROWSER_REVIEW_CHANGED")
            self.grants.add(identity)

    class Launcher:
        readiness = ready or readiness()
        calls = 0

        async def launch(self, bound, **ports):
            self.calls += 1
            await ports["consent"].check_binding(bound)
            return driver

    class Model:
        model_name = readiness().model_name
        transport = readiness().model_transport

        def __init__(self):
            self.entered, self.release = asyncio.Event(), asyncio.Event()

        async def run(self, *, control, processing, goal):
            await processing.require()
            await control.execute(
                BrowserAction(
                    operation="observe",
                    sequence=control.next_sequence,
                    control_epoch=control.control_epoch,
                )
            )
            self.entered.set()
            await self.release.wait()
            return {"outcome": "completed", "summary": "Finished the requested task."}

    async def check():
        if auth.revoked:
            raise BrowserRefused("BROWSER_OWNER_REFUSED")

    log, reviews, launcher, model = log or Log(), Reviews(), Launcher(), model or Model()
    admission = PodUpgradeAdmission(log_resolver=lambda: None)
    runtime = BrowserTaskRuntime(
        owner_id="owner",
        pod_id="pod",
        incarnation="epoch",
        launcher=launcher,
        model=model,
        reviews=reviews,
        source=SimpleNamespace(),
        authority_factory=lambda _bound, _consent: auth,
        log=log,
        admission=admission,
        clock=lambda: 1000,
    )
    owner = BrowserOwnerAccess("owner", "pod", "epoch", 1900, check)
    request = BrowserTaskRequest(
        request_id="request_1",
        goal="Open the selected page.",
        allowed_origins=("https://example.com",),
    )
    return SimpleNamespace(
        runtime=runtime,
        auth=auth,
        driver=driver,
        log=log,
        reviews=reviews,
        launcher=launcher,
        model=model,
        owner=owner,
        request=request,
        admission=admission,
    )


async def approved_task(fixture):
    snapshot = await fixture.runtime.start(fixture.owner, fixture.request)
    await fixture.runtime._tasks[snapshot.binding.task_id].worker
    snapshot = await fixture.runtime.read(fixture.owner, snapshot.binding.task_id)
    assert snapshot.phase == "needs_owner"
    assert fixture.launcher.calls == 0  # no screen before provider-processing receipt
    snapshot = await fixture.runtime.confirm_review(
        fixture.owner, snapshot.binding.task_id, snapshot.review.review_id
    )
    await asyncio.wait_for(fixture.model.entered.wait(), 2)
    return await fixture.runtime.read(fixture.owner, snapshot.binding.task_id)
