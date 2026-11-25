"""Stage 2a verification: Unified Zero-Content Wake Coalescer, 6-surface prompt-injection
quarantine, non-aggressive memory/wiki curation, Sentinel connector egress allowlist,
and zero-PII Muse notifications across Personal Sandbox (ace), GCP BYOC, and Azure BYOC.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import pod_maintenance, pod_wake
from hushh_mcp.operons.background_quarantine import (
    UNTRUSTED_BACKGROUND_SURFACES,
    can_supersede_existing_fact,
    evaluate_background_curation_candidate,
    quarantine_tools_for_background_turn,
)
from hushh_mcp.services.feed_attention_push import build_muse_background_push
from hushh_mcp.services.pod_background_prep import run_pod_background_prep
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
from hushh_mcp.services.pod_config import PodConfig, apply_changes
from hushh_mcp.services.pod_wake_coalescer import (
    ZeroContentViolationError,
    ZeroContentWakeCoalescer,
    dispatch_authenticated_pod_tick,
    validate_zero_content_signal,
)

OWNER_UID = "uid-stage2a-owner"
HUSHH_ID = "ha1_stage2atestowner0000000000000"
POD_KEY = b"\x22" * 32


def _make_log(tmp_path: Path, name: str = "commit_log") -> PodCommitLog:
    return PodCommitLog(LocalObjectStore(str(tmp_path / name)), POD_KEY, owner_id=HUSHH_ID)


def test_six_surface_quarantine_strips_all_outbound_and_unclassified_tools() -> None:
    assert len(UNTRUSTED_BACKGROUND_SURFACES) == 6
    candidate_tools: dict[str, Any] = {
        # Safe read & staging tools:
        "ask_email_agent": {"kind": "read"},
        "calendar_events": {"kind": "read"},
        "read_google_drive": {"kind": "read"},
        "search_contacts": {"kind": "read"},
        "github_list_issues": {"access": "read", "readOnlyHint": True},
        "stage_local_draft": {"kind": "stage"},
        "open_gmail_email_draft": {"kind": "stage"},
        "propose_calendar_event": {"kind": "stage"},
        "stage_vault_proposal": {"kind": "stage"},
        # Dangerous outbound / mutating / exfiltrating tools that MUST be stripped:
        "send_gmail_message": {"kind": "write"},
        "delete_gmail_thread": {"kind": "write"},
        "create_calendar_event": {"kind": "write"},
        "share_drive_file": {"kind": "write"},
        "pay_invoice_stripe": {"kind": "write"},
        "run_terminal_command": {"kind": "exec"},
        "commit_vault_domain": {"kind": "vault_write"},
        # Unclassified MCP tool without read-only proof -> fail closed!
        "slack_mystery_tool": {"description": "posts to channel"},
        # Even if mislabeled readOnlyHint=True, a send/delete name is stripped:
        "send_external_webhook": {"access": "read", "readOnlyHint": True},
    }

    for surface in UNTRUSTED_BACKGROUND_SURFACES:
        result = quarantine_tools_for_background_turn(candidate_tools, active_surfaces=(surface,))
        assert result.quarantine_active is True
        assert result.surfaces == (surface,)
        assert set(result.admitted_tools) == {
            "ask_email_agent",
            "calendar_events",
            "read_google_drive",
            "search_contacts",
            "github_list_issues",
            "stage_local_draft",
            "open_gmail_email_draft",
            "propose_calendar_event",
            "stage_vault_proposal",
        }
        for forbidden in (
            "send_gmail_message",
            "delete_gmail_thread",
            "create_calendar_event",
            "share_drive_file",
            "pay_invoice_stripe",
            "run_terminal_command",
            "commit_vault_domain",
            "slack_mystery_tool",
            "send_external_webhook",
        ):
            assert forbidden in result.stripped_tool_names


def test_non_aggressive_curation_filters_noise_stages_vault_and_blocks_owner_override() -> None:
    # 1. Low-signal promotional / newsletter / OTP / no-reply noise is dropped:
    promo = evaluate_background_curation_candidate(
        surface="gmail",
        summary_text="Flash sale 50% off! Click here to unsubscribe from our newsletter.",
        sender_hint="marketing@shop.example.com",
    )
    assert promo.decision == "drop_low_signal"

    otp = evaluate_background_curation_candidate(
        surface="gmail",
        summary_text="Your one-time passcode security code is 492811. Do not reply.",
        sender_hint="no-reply@auth.example.com",
    )
    assert otp.decision == "drop_low_signal"

    # 2. Sovereign Vault capital documents stage as 1-tap owner-unlock proposals:
    tax_doc = evaluate_background_curation_candidate(
        surface="drive",
        summary_text="2025 Form 1099 brokerage statement uploaded to shared folder",
        target_domain="tax",
    )
    assert tax_doc.decision == "stage_vault_proposal"

    # 3. Durable project / meeting context auto-curates with explicit provenance:
    meeting = evaluate_background_curation_candidate(
        surface="calendar",
        summary_text="Architecture sign-off with Priya moved to Thursday at 2pm PST",
        source_ref="evt_123",
    )
    assert meeting.decision == "auto_curate_memory_and_wiki"
    assert meeting.provenance == {
        "provenance_kind": "connector_background",
        "connector_surface": "calendar",
        "source_label": "from Calendar",
        "trust_tier": "external_derived",
        "reversible": True,
        "source_ref": "evt_123",
    }

    # 4. External background facts can NEVER override owner_direct facts or consent rules:
    assert (
        can_supersede_existing_fact(
            existing_metadata={"provenance_kind": "owner_direct", "author": "user"},
            candidate_metadata=meeting.provenance,
        )
        is False
    )
    assert (
        can_supersede_existing_fact(
            existing_metadata={"provenance_kind": "consent_rule"},
            candidate_metadata=meeting.provenance,
        )
        is False
    )
    assert (
        can_supersede_existing_fact(
            existing_metadata={"provenance_kind": "connector_background"},
            candidate_metadata=meeting.provenance,
        )
        is True
    )


@pytest.mark.asyncio
async def test_pod_background_prep_enforces_lockdown_toggles_and_daily_cap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("HUSSH_ID", HUSHH_ID)
    log = _make_log(tmp_path)

    # 1. Session-only lockdown refuses offline wakes immediately:
    lockdown_cfg = apply_changes(PodConfig(), {"session_only_lockdown": True})
    locked_res = await run_pod_background_prep(
        config=lockdown_cfg,
        log=log,
        is_private_pod=True,
        wake_payload={"signals": [{"surface": "gmail"}]},
    )
    assert locked_res["status"] == "locked_down"
    assert locked_res["reason"] == "SESSION_ONLY_LOCKDOWN"

    # 2. Per-connector toggle skips disabled connector while curating enabled ones:
    cfg = apply_changes(
        PodConfig(),
        {"background_prep_gmail": False, "background_daily_wake_cap": 2},
    )
    res1 = await run_pod_background_prep(
        config=cfg,
        log=log,
        is_private_pod=True,
        clock=lambda: 1_795_200_000.0,
        candidate_tools={"send_gmail_message": {}, "stage_local_draft": {}},
        existing_facts_by_key={
            "pref_airline": {"provenance_kind": "owner_direct", "author": "user"}
        },
        candidates=[
            # Ignored because background_prep_gmail is False:
            {
                "surface": "gmail",
                "summary_text": "Board deck review tomorrow morning at 9am",
                "prepare_draft": True,
            },
            # Curated because calendar is True:
            {
                "surface": "calendar",
                "summary_text": "Quarterly roadmap review with design lead on Friday",
                "prepare_draft": True,
            },
            # Dropped low-signal noise:
            {
                "surface": "drive",
                "summary_text": "Weekly digest newsletter - unsubscribe anytime",
            },
            # Staged for Vault unlock:
            {
                "surface": "drive",
                "summary_text": "Updated portfolio holdings statement Q3",
                "target_domain": "financial",
            },
            # Blocked attempt to override owner_direct preference:
            {
                "surface": "calendar",
                "fact_key": "pref_airline",
                "summary_text": "Travel agent note: prefers middle seats on red-eye flights",
            },
        ],
    )
    assert res1["status"] == "completed"
    assert "gmail" not in res1["enabledSurfaces"]
    assert res1["admittedToolCount"] == 1
    assert res1["strippedToolCount"] == 1
    assert res1["memoryFactsCurated"] == 1
    assert res1["wikiUpdatesCurated"] == 1
    assert res1["draftsPrepared"] == 1
    assert res1["droppedLowSignal"] == 1
    assert res1["vaultProposalsStaged"] == 1
    assert res1["blockedOwnerOverrides"] == 1
    assert res1["usedToday"] == 1

    # 3. Second wake succeeds; third wake hits daily cap = 2:
    res2 = await run_pod_background_prep(
        config=cfg,
        log=log,
        is_private_pod=True,
        clock=lambda: 1_795_200_060.0,
        wake_payload={"signals": [{"surface": "calendar"}]},
    )
    assert res2["status"] == "completed"
    assert res2["usedToday"] == 2

    res3 = await run_pod_background_prep(
        config=cfg,
        log=log,
        is_private_pod=True,
        clock=lambda: 1_795_200_120.0,
        wake_payload={"signals": [{"surface": "calendar"}]},
    )
    assert res3["status"] == "budget_exhausted"
    assert res3["dailyCap"] == 2


@pytest.mark.asyncio
async def test_wake_coalescer_zero_content_15m_batching_fast_sweep_and_multicloud_parity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1. Zero-content guard rejects any PII/content/token fields:
    for bad_key in ("subject", "body", "email", "filename", "prompt", "access_token"):
        with pytest.raises(ZeroContentViolationError):
            validate_zero_content_signal({"trigger_kind": "gmail", bad_key: "secret"})

    now = {"t": 1_000_000.0}
    dispatched_calls: list[tuple[str, dict[str, Any]]] = []

    async def fake_dispatcher(owner_id: str, body: dict[str, Any]) -> dict[str, Any]:
        dispatched_calls.append((owner_id, body))
        return {"dispatched": True, "hostingTarget": "ace", "backgroundStatus": "completed"}

    coalescer = ZeroContentWakeCoalescer(
        dispatcher=fake_dispatcher,
        clock=lambda: now["t"],
        batch_debounce_seconds=900.0,
        daily_wake_cap=3,
    )

    # 2. Routine Gmail + Drive + Calendar signals within 15m coalesce without booting pod:
    r1 = await coalescer.ingest_signal(
        owner_user_id=OWNER_UID, signal={"trigger_kind": "gmail", "signal_id": "sig_1"}
    )
    assert r1["outcome"] == "coalesced"
    assert r1["dueInSeconds"] == 900
    assert dispatched_calls == []

    # Duplicate signal_id is ignored:
    dup = await coalescer.ingest_signal(
        owner_user_id=OWNER_UID, signal={"trigger_kind": "gmail", "signal_id": "sig_1"}
    )
    assert dup["outcome"] == "deduplicated"
    assert dup["coalescedCount"] == 1

    r2 = await coalescer.ingest_signal(
        owner_user_id=OWNER_UID, signal={"trigger_kind": "drive", "signal_id": "sig_2"}
    )
    assert r2["outcome"] == "coalesced"
    assert r2["coalescedCount"] == 2
    assert dispatched_calls == []

    # Before 15m elapsed -> drain dispatches nothing:
    now["t"] += 300.0
    early_drain = await coalescer.drain_due()
    assert early_drain["dispatched"] == 0

    # At +900s -> ONE coalesced wake fires carrying both gmail & drive surfaces:
    now["t"] += 601.0
    due_drain = await coalescer.drain_due()
    assert due_drain["dispatched"] == 1
    assert len(dispatched_calls) == 1
    assert dispatched_calls[0][1] == {
        "wakePriority": "batch",
        "coalescedCount": 2,
        "triggers": ["gmail", "drive"],
        "signals": [{"surface": "gmail"}, {"surface": "drive"}],
    }

    # 3. Fast-path Circle request wakes in 0s AND sweeps queued batch signals in ONE wake:
    await coalescer.ingest_signal(
        owner_user_id=OWNER_UID,
        signal={"trigger_kind": "calendar", "signal_id": "sig_3", "quiet_hours_active": True},
    )
    fast = await coalescer.ingest_signal(
        owner_user_id=OWNER_UID,
        signal={"trigger_kind": "circle_request", "signal_id": "cir_1"},
    )
    assert fast["outcome"] == "dispatched"
    assert fast["priority"] == "fast"
    assert fast["coalescedCount"] == 2
    assert coalescer.pending_owner_count() == 0
    assert dispatched_calls[1][1]["triggers"] == ["calendar", "circle_request"]

    # 4. Multi-cloud dispatch parity across Personal Sandbox (ace), user_gcp, and user_azure:
    targets = [
        ("ace", "https://sandbox-edge.dev.hussh.ai/u/ha1_ace"),
        ("user_gcp", "https://one-pod-gcp.a.run.app"),
        ("user_azure", "https://one-pod-az.eastus2.azurecontainerapps.io"),
    ]
    seen_posts: list[tuple[str, str]] = []

    def fake_post(url: str, *, json: dict, headers: dict, timeout: float, allow_redirects: bool):
        seen_posts.append((url, headers.get("Authorization", "")))
        return SimpleNamespace(
            status_code=200,
            json=lambda: {"ok": True, "backgroundPrep": {"status": "completed"}},
        )

    for target, pod_url in targets:
        row = {"deployment_target": target, "backend_metadata": {"url": pod_url}}

        class _Repo:
            def __init__(self, snapshot: dict[str, Any]) -> None:
                self._snapshot = snapshot

            async def get(self, _uid: str) -> dict[str, Any]:
                return self._snapshot

        out = await dispatch_authenticated_pod_tick(
            OWNER_UID,
            {"wakePriority": "fast", "signals": [{"surface": "gmail"}]},
            registry=_Repo(row),
            http_post=fake_post,
            token_mint=lambda aud: f"oidc-for-{aud}",
        )
        assert out == {
            "dispatched": True,
            "podStatus": 200,
            "hostingTarget": target,
            "backgroundStatus": "completed",
        }
    assert [u for u, _ in seen_posts] == [
        "https://sandbox-edge.dev.hussh.ai/u/ha1_ace/pod/tick",
        "https://one-pod-gcp.a.run.app/pod/tick",
        "https://one-pod-az.eastus2.azurecontainerapps.io/pod/tick",
    ]


def test_muse_background_notifications_carry_zero_pii_and_exact_deep_links() -> None:
    drafts = build_muse_background_push("pod_drafts_ready", ref_id="wake_01", count=2)
    assert drafts["title"] == "Hussh One"
    assert drafts["body"] == "One prepared 2 drafts for review"
    assert drafts["deep_link"] == "/?review=drafts"
    assert drafts["include_user_id"] is False

    capped = build_muse_background_push("pod_drafts_ready", ref_id="wake_02", count=14)
    assert capped["body"] == "One prepared 9+ drafts for review"

    circle = build_muse_background_push("circle_rule_fulfilled", ref_id="rcpt_99", count=1)
    assert circle["body"] == "Trusted circle rule fulfilled · 1 receipt"
    assert circle["deep_link"] == "/consents?tab=receipts"

    req = build_muse_background_push("information_request_ready", ref_id="req_77")
    assert req["body"] == "Document request ready to allow"
    assert req["deep_link"] == "/consents?tab=requests"

    brief = build_muse_background_push("pod_brief_updated", ref_id="brf_11")
    assert brief["body"] == "One updated your workspace brief"
    assert brief["deep_link"] == "/"

    serialized = json.dumps([drafts, circle, req, brief], default=sorted)
    for forbidden in (OWNER_UID, HUSHH_ID, "@", "$"):
        assert forbidden not in serialized

    with pytest.raises(ValueError):
        build_muse_background_push("pod_drafts_ready", ref_id="secret subject line!")


def test_pod_wake_signal_route_and_pod_tick_background_wiring(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(pod_wake, "_require_enabled", lambda: None)
    app = FastAPI()
    app.include_router(pod_wake.router)
    app.dependency_overrides[require_firebase_auth] = lambda: OWNER_UID
    client = TestClient(app)

    bad = client.post(
        "/api/one/pod/wake/signal",
        json={"trigger_kind": "gmail", "subject": "Confidential M&A"},
    )
    assert bad.status_code == 400
    assert bad.json()["detail"]["code"] == "ZERO_CONTENT_VIOLATION"

    good = client.post(
        "/api/one/pod/wake/signal",
        json={"trigger_kind": "gmail", "signal_id": "route_sig_01"},
    )
    assert good.status_code == 200
    assert good.json()["outcome"] in {"coalesced", "deduplicated"}

    # Verify /pod/tick includes backgroundPrep alongside memoryBankRebuild & gmailNotifications:
    from hushh_mcp.services import scheduler_identity

    monkeypatch.setenv("HUSSH_POD_TICK_AUDIENCE", "https://edge.dev/u/ha1")
    monkeypatch.setenv("HUSSH_POD_TICK_ALLOWED_EMAILS", "hub@example.iam.gserviceaccount.com")
    monkeypatch.setattr(
        scheduler_identity,
        "verify_scheduler_request",
        lambda **_: SimpleNamespace(email="hub@example.iam.gserviceaccount.com"),
    )

    async def fake_mem():
        return {"outcome": "not_needed"}

    async def fake_gmail():
        return {"status": "disabled"}

    async def fake_bg(*, wake_payload=None):
        return {
            "status": "completed",
            "quarantineActive": True,
            "receivedPriority": (wake_payload or {}).get("wakePriority"),
        }

    monkeypatch.setattr(pod_maintenance, "memory_bank_rebuild_job", fake_mem)
    monkeypatch.setattr(pod_maintenance, "gmail_notification_job", fake_gmail)
    monkeypatch.setattr(pod_maintenance, "background_prep_job", fake_bg)

    tick_app = FastAPI()
    tick_app.include_router(pod_maintenance.router)
    tick_client = TestClient(tick_app)
    tick_resp = tick_client.post(
        "/pod/tick",
        json={"wakePriority": "fast", "signals": [{"surface": "gmail"}]},
        headers={"Authorization": "Bearer valid-oidc"},
    )
    assert tick_resp.status_code == 200
    tick_json = tick_resp.json()
    assert tick_json["work"] == "background_prep"
    assert tick_json["backgroundPrep"] == {
        "status": "completed",
        "quarantineActive": True,
        "receivedPriority": "fast",
    }


@pytest.mark.asyncio
async def test_scheduled_goal_wake_routes_to_goal_surface_quarantines_tools_and_seals_without_chat_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from hushh_mcp.services.chat_key import request_has_chat_key
    from hushh_mcp.services.pod_background_prep import (
        GOAL_PREP_RECORD_KIND,
        SCHEDULED_GOAL_SURFACE,
    )

    validated = validate_zero_content_signal(
        {"trigger_kind": "scheduled_goal", "signal_id": "goal_01"}
    )
    assert validated["trigger_kind"] == "scheduled_goal"
    for bad_key in ("prompt", "title", "subject"):
        with pytest.raises(ZeroContentViolationError):
            validate_zero_content_signal({"trigger_kind": "scheduled_goal", bad_key: "secret"})

    dispatched: list[tuple[str, dict[str, Any]]] = []

    async def fake_dispatcher(owner_id: str, body: dict[str, Any]) -> dict[str, Any]:
        dispatched.append((owner_id, body))
        return {"dispatched": True, "hostingTarget": "ace", "backgroundStatus": "completed"}

    coalescer = ZeroContentWakeCoalescer(dispatcher=fake_dispatcher)
    wake_res = await coalescer.ingest_signal(
        owner_user_id=OWNER_UID,
        signal={"trigger_kind": "scheduled_goal", "signal_id": "goal_01"},
    )
    assert wake_res["outcome"] == "dispatched"
    assert wake_res["priority"] == "fast"
    assert len(dispatched) == 1
    assert dispatched[0][1]["signals"] == [{"surface": SCHEDULED_GOAL_SURFACE}]

    monkeypatch.setenv("HUSSH_ID", HUSHH_ID)
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    assert request_has_chat_key(OWNER_UID) is False

    log = _make_log(tmp_path)
    cfg = apply_changes(PodConfig(), {"background_prep_gmail": False})
    res = await run_pod_background_prep(
        config=cfg,
        log=log,
        is_private_pod=True,
        clock=lambda: 1_795_300_000.0,
        wake_payload=dispatched[0][1],
        candidate_tools={"send_gmail_message": {}, "stage_local_draft": {}},
        candidates=[
            {
                "surface": SCHEDULED_GOAL_SURFACE,
                "goal_id": "goal_01",
                "summary_text": "SECRET_GOAL_TEXT Rebalance Q4 index fund",
            }
        ],
    )
    assert res["status"] == "completed"
    assert res["scheduledGoalActive"] is True
    assert res["goalsPrepared"] == 1
    assert res["goalCustodyMode"] == "pod_dek_sealed"
    assert res["quarantineActive"] is True
    assert res["admittedToolCount"] == 1
    assert res["strippedToolCount"] == 1

    records = await log.replay()
    goal_records = [r for r in records if r["kind"] == GOAL_PREP_RECORD_KIND]
    assert len(goal_records) == 1
    entry = goal_records[0]["payload"]["entries"][0]
    assert entry["goalId"] == "goal_01"
    assert entry["provenance"]["chat_key_required"] is False

    for path in tmp_path.rglob("*"):
        if path.is_file():
            assert b"SECRET_GOAL_TEXT" not in path.read_bytes()


@pytest.mark.asyncio
async def test_scheduled_goal_custody_fails_closed_on_missing_foreign_fenced_or_tampered_log_and_preserves_chat_key_boundary(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from hushh_mcp.services.chat_key import ChatCipher, ChatKeyUnavailableError
    from hushh_mcp.services.pod_background_prep import (
        SCHEDULED_GOAL_SURFACE,
        stage_scheduled_goal_prep,
    )
    from hushh_mcp.services.pod_commit_log import PodLogFenced, PodLogTampered

    monkeypatch.setenv("HUSSH_ID", HUSHH_ID)
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    log = _make_log(tmp_path)

    # 1. session_only_lockdown refuses scheduled_goal wake with zero log writes:
    lockdown_cfg = apply_changes(PodConfig(), {"session_only_lockdown": True})
    locked = await run_pod_background_prep(
        config=lockdown_cfg,
        log=log,
        is_private_pod=True,
        wake_payload={"signals": [{"surface": SCHEDULED_GOAL_SURFACE}]},
        candidates=[
            {
                "surface": SCHEDULED_GOAL_SURFACE,
                "goal_id": "goal_02",
                "summary_text": "SECRET_LOCKDOWN_GOAL Do not stage",
            }
        ],
    )
    assert locked["status"] == "locked_down"
    assert locked["goalsPrepared"] == 0
    assert await log.replay() == []

    # 2. Missing log or wrong owner log fails closed:
    sample = [{"goal_id": "goal_02", "summary_text": "Quarterly check-in goal"}]
    with pytest.raises(PermissionError, match="GOAL_PREP_CUSTODY_UNAVAILABLE"):
        await stage_scheduled_goal_prep(None, hushh_id=HUSHH_ID, candidates=sample, now_s=1000.0)

    foreign_log = PodCommitLog(
        LocalObjectStore(str(tmp_path / "foreign_log")), POD_KEY, owner_id="ha1_foreign"
    )
    with pytest.raises(PermissionError, match="GOAL_PREP_CUSTODY_UNAVAILABLE"):
        await stage_scheduled_goal_prep(
            foreign_log, hushh_id=HUSHH_ID, candidates=sample, now_s=1000.0
        )

    # 3. Stage once, then tamper a ciphertext record on disk and verify PodLogTampered:
    tamper_log = _make_log(tmp_path, "tamper_log")
    assert (
        await stage_scheduled_goal_prep(
            tamper_log, hushh_id=HUSHH_ID, candidates=sample, now_s=1000.0
        )
        == 1
    )
    record_files = list((tmp_path / "tamper_log" / "records").glob("*.bin"))
    assert len(record_files) == 1
    raw = bytearray(record_files[0].read_bytes())
    raw[-1] ^= 0xFF
    record_files[0].write_bytes(bytes(raw))
    with pytest.raises(PodLogTampered):
        await tamper_log.replay()

    # 4. Fenced log raises PodLogFenced:
    fenced_log = _make_log(tmp_path, "fenced_log")
    await fenced_log.fence_for_erasure(owner_id=HUSHH_ID, attempt_id="erase-1")
    with pytest.raises(PodLogFenced):
        await stage_scheduled_goal_prep(
            fenced_log, hushh_id=HUSHH_ID, candidates=sample, now_s=1000.0
        )

    # 5. Interactive ChatCipher boundary remains strictly enforced without X-Hussh-Chat-Key:
    with pytest.raises(ChatKeyUnavailableError):
        ChatCipher().seal("x", owner_id=OWNER_UID, aad="t:c:r")
