"""The reserved-branch registry and its server enforcement.

``contracts/pkm/reserved-branches.v1.json`` decides which PKM branches belong to
an app feature and which writers may change them. Its own ``enforcement`` value
picks the mode: ``shadow`` only LOGS what it would refuse, ``enforce`` refuses.
The contract enforces since the migration release (Phase 2). The enforce tests
still set the mode explicitly, and each one keeps a negative control: the same
write in shadow mode (the rollback value), or the listed writer, goes through. The webapp side, including
the writer inventory and the device diff, is
``hushh-webapp/__tests__/lib/pkm/reserved-branches.test.ts``.
"""

from __future__ import annotations

import importlib
import logging
import pathlib
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import pkm_routes_shared
from api.routes.pkm_routes_shared import StructureDecisionPayload
from hushh_mcp.consent import reserved_branches
from hushh_mcp.consent.kyc_reply_authorization import issue_kyc_reply_authorization
from hushh_mcp.consent.reserved_branches import (
    evaluate_reserved_write,
    is_reserved_path,
    reserved_entry_for,
    writer,
)
from hushh_mcp.services.generated_contracts import BACKEND_ROOT, REPO_ROOT
from hushh_mcp.services.pkm_mutation_contracts import PkmMutationPlanV2
from mcp_modules.log_redaction import SensitiveLogFilter

_RELATIVE = ("contracts", "pkm", "reserved-branches.v1.json")


def test_all_three_copies_are_byte_identical() -> None:
    canonical = REPO_ROOT.joinpath(*_RELATIVE).read_bytes()
    for mirror in (
        BACKEND_ROOT.joinpath(*_RELATIVE),
        REPO_ROOT.joinpath("hushh-webapp", *_RELATIVE),
    ):
        assert mirror.read_bytes() == canonical, (
            f"{mirror} drifted; copy the canonical file over it"
        )


def test_wildcard_domain_is_reserved_apart_from_its_except_branch() -> None:
    assert reserved_entry_for("financial", "portfolio.holdings").owner_feature == "finance"
    assert reserved_entry_for("financial", "") is not None
    assert reserved_entry_for("financial", "agent_memory") is None
    assert reserved_entry_for("financial", "agent_memory.entities.mem_1") is None


def test_prefix_matches_on_a_segment_boundary_never_a_substring() -> None:
    assert is_reserved_path("location", "Saved_Places.home.label")
    assert not is_reserved_path("location", "saved_places_archive")
    assert not is_reserved_path("location", "agent_memory")
    assert not is_reserved_path("food", "preferences")


def test_writer_rules_match_the_typescript_loader() -> None:
    paths = ["saved_places.home"]
    assert writer("not_a_registered_writer") is None
    assert [
        r.reason
        for r in evaluate_reserved_write(
            domain="location", paths=paths, writer_id="not_a_registered_writer"
        )
    ] == ["writer_unknown"]
    assert [
        r.reason
        for r in evaluate_reserved_write(
            domain="location", paths=paths, writer_id="agent_chat_owner_request"
        )
    ] == ["memory_agent"]
    assert [
        r.reason
        for r in evaluate_reserved_write(
            domain="location", paths=paths, writer_id="kai_dashboard_portfolio_save"
        )
    ] == ["writer_not_listed"]
    assert (
        evaluate_reserved_write(
            domain="location", paths=paths, writer_id="one_location_saved_place_confirm"
        )
        == []
    )
    assert (
        evaluate_reserved_write(
            domain="wallet", paths=["summary"], writer_id="pkm_upgrade_orchestrator"
        )
        == []
    )


def test_server_writer_labels_are_catalogued() -> None:
    """The labels the SERVER assigns when a client names no writer of its own."""
    assert writer(PkmMutationPlanV2.model_fields["writer_id"].default).feature == "unattributed"
    assert (
        writer(StructureDecisionPayload.model_fields["source_agent"].default).writer_class
        == "memory_agent"
    )
    assert writer("pkm_upgrade_orchestrator").writer_class == "migration"


def _request(*, writer_id: str, scope: str, json_paths: tuple[str, ...] = ()) -> SimpleNamespace:
    return SimpleNamespace(
        mutation_plan=SimpleNamespace(writer_id=writer_id, proposed_scope=scope),
        upgrade_claim=None,
        structure_decision=SimpleNamespace(
            source_agent="pkm_structure_agent",
            top_level_scope_paths=[scope],
            json_paths=list(json_paths),
        ),
    )


def _shadow_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    """The shadow lines as production writes them, after the runtime redactor.

    ``server.py`` installs ``SensitiveLogFilter`` process-wide. It once turned
    ``writer=agent_chat_owner_request`` into ``writer=[REDACTED]`` (an argument
    of 24+ underscored characters reads as a uid), so the line is checked after
    the filter has run, not before.
    """
    lines = []
    for record in caplog.records:
        SensitiveLogFilter().filter(record)
        if "pkm.reserved_would_refuse" in record.getMessage():
            lines.append(record.getMessage())
    return lines


def test_shadow_logs_a_memory_agent_write_to_saved_places(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    pkm_routes_shared._shadow_reserved_branch_write(
        _request(writer_id="agent_chat_owner_request", scope="saved_places"), "location"
    )
    assert _shadow_lines(caplog) == [
        "pkm.reserved_would_refuse domain=location branch=saved_places "
        "writer=agent_chat_owner_request reason=memory_agent source=declared"
    ]


def test_shadow_is_silent_for_the_location_writer(caplog: pytest.LogCaptureFixture) -> None:
    """Negative control: the writer the registry lists produces no line."""
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    pkm_routes_shared._shadow_reserved_branch_write(
        _request(writer_id="one_location_saved_place_confirm", scope="saved_places"), "location"
    )
    assert _shadow_lines(caplog) == []


def test_shadow_sees_a_reserved_structure_path_behind_an_agent_memory_scope(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    pkm_routes_shared._shadow_reserved_branch_write(
        _request(
            writer_id="agent_chat_owner_request",
            scope="agent_memory",
            json_paths=("agent_memory.entities.mem_1", "identity_documents.passport_number"),
        ),
        "identity",
    )
    assert [line.split(" branch=")[1].split(" ")[0] for line in _shadow_lines(caplog)] == [
        "identity_documents"
    ]


def test_shadow_never_logs_an_unrecognized_client_label(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    request = _request(writer_id="x", scope="saved_places")
    request.mutation_plan = None
    request.structure_decision.source_agent = "Mallory\npkm.reserved_would_refuse forged=1"
    pkm_routes_shared._shadow_reserved_branch_write(request, "location")
    lines = _shadow_lines(caplog)
    assert lines and all("Mallory" not in line and "\n" not in line for line in lines)
    assert "writer=unrecognized reason=writer_unknown" in lines[0]


def test_shadow_can_never_block_a_write(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(**_kwargs):
        raise RuntimeError("registry unreadable")

    monkeypatch.setattr(pkm_routes_shared, "evaluate_reserved_write", broken)
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    pkm_routes_shared._shadow_reserved_branch_write(
        _request(writer_id="agent_chat_owner_request", scope="saved_places"), "location"
    )
    assert any("pkm.reserved_shadow_unavailable" in r.getMessage() for r in caplog.records)


def test_importing_the_loader_never_reads_the_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    """The packaged MCP runtime ships ``hushh_mcp`` without ``contracts/``.

    ``packages/hushh-mcp/scripts/stage-runtime.mjs`` copies no contracts, so a
    loader that read the file at import would crash every module importing it
    there. Re-executing the module with the contract unreadable must succeed.
    """
    real_open = pathlib.Path.open

    def guarded_open(self: pathlib.Path, *args, **kwargs):
        if self.name == "reserved-branches.v1.json":
            raise AssertionError("reserved-branches.v1.json was read at import time")
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "open", guarded_open)
    importlib.reload(reserved_branches)
    monkeypatch.undo()
    assert reserved_branches.registry_version() == 1


# ---------- enforcement (Phase 1) ----------

_OWNER = "user_123"


def test_the_contract_enforces_after_the_migration_release() -> None:
    """Phase 2 moved agent entries to their siblings (v5), then flipped the switch.

    Rollback is this one contract value back to ``shadow``.
    """
    assert reserved_branches.enforcement_mode() == "enforce"
    assert reserved_branches.memory_screen_policy() == "read_only_reserved"


def _plan(
    *,
    domain: str,
    scope: str,
    writer_id: str,
    client_version: str | None = "2.0.0",
    operation: str = "create",
) -> dict:
    plan_id = "pkm_plan_reserved_route_001"
    payload = {
        "version": 2,
        "plan_id": plan_id,
        "operation": operation,
        "proposed_domain": domain,
        "proposed_scope": scope,
        "friendly_domain_name": domain.title(),
        "friendly_scope_name": scope.title(),
        "confidence": 1.0,
        "explanation": "The owner reviewed this encrypted PKM write.",
        "writer_id": writer_id,
        "confirmation_receipt": {
            "version": 2,
            "receipt_id": "pkm_receipt_reserved_route_001",
            "plan_id": plan_id,
            "confirmed_by_user_id": _OWNER,
            "confirmed_at": datetime.now(UTC).isoformat(),
            "surface": "web",
            "displayed_domain": domain,
            "displayed_scope": scope,
        },
    }
    if operation == "delete":
        payload["source_scope_handle"] = "pending_scope_route_001"
    else:
        payload["target_scope_handle"] = "pending_scope_route_001"
    if client_version is not None:
        payload["client_version"] = client_version
    return payload


def _store_body(plan: dict, *, manifest_paths: tuple[str, ...] = (), **extra) -> dict:
    body = {
        "user_id": _OWNER,
        "domain": plan["proposed_domain"],
        "encrypted_blob": {"ciphertext": "Y2lwaGVy", "iv": "aXY=", "tag": "dGFn"},
        "summary": {},
        "mutation_plan": plan,
        **extra,
    }
    if manifest_paths:
        body["manifest"] = {"paths": [{"json_path": path} for path in manifest_paths]}
    return body


class _FakePkmService:
    def __init__(self, stored_paths: frozenset[str] | None = None) -> None:
        self.stored_paths = stored_paths
        self.stored: list[dict] = []

    async def get_manifest_json_paths(self, _user_id: str, _domain: str):
        return self.stored_paths

    async def get_mutation_sharing_impact(self, **_kwargs):
        return {
            "active_recipient_count": 0,
            "recipient_labels": [],
            "enters_next_export_revision": False,
            "affected_grant_ids": [],
            "affected_export_ids": [],
        }

    async def store_domain_data(self, **kwargs):
        self.stored.append(kwargs)
        return {"success": True, "data_version": 1, "updated_at": None}

    async def delete_domain_data(self, *_args, **_kwargs):
        return {"success": True, "deleted": True, "data_version": 2}


@pytest.fixture
def enforce(monkeypatch: pytest.MonkeyPatch):
    def _set(mode: str = "enforce") -> _FakePkmService:
        monkeypatch.setattr(pkm_routes_shared, "enforcement_mode", lambda: mode)
        service = _FakePkmService()
        monkeypatch.setattr(pkm_routes_shared, "get_pkm_service", lambda: service)
        monkeypatch.setattr(pkm_routes_shared, "_notify_location_pkm_changed", _no_push)
        return service

    return _set


async def _no_push(*_args, **_kwargs) -> None:
    return None


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(pkm_routes_shared.router)
    app.dependency_overrides[pkm_routes_shared.require_vault_owner_token] = lambda: {
        "user_id": _OWNER
    }
    return TestClient(app)


def test_enforce_refuses_a_chat_writer_on_saved_places_with_the_offer(enforce) -> None:
    service = enforce()
    response = _client().post(
        "/api/pkm/store-domain",
        json=_store_body(
            _plan(domain="location", scope="saved_places", writer_id="agent_chat_owner_request")
        ),
    )
    assert response.status_code == 403
    detail = response.json()["detail"]
    assert {
        "code",
        "domain",
        "branch",
        "owner_feature",
        "agent_memory_sibling",
        "offer_action",
        "registry_version",
    } <= set(detail)
    assert detail["code"] == "PKM_RESERVED_BRANCH_WRITER_FORBIDDEN"
    assert (detail["domain"], detail["branch"]) == ("location", "saved_places")
    assert detail["agent_memory_sibling"] == "location.agent_memory"
    assert detail["offer_action"]["route_pattern"] == "/one/location"
    assert detail["registry_version"] == 1
    assert service.stored == []


def test_enforce_accepts_the_location_writer_on_saved_places(enforce) -> None:
    """Negative control: the writer the entry lists is untouched by enforcement."""
    service = enforce()
    response = _client().post(
        "/api/pkm/store-domain",
        json=_store_body(
            _plan(
                domain="location",
                scope="saved_places",
                writer_id="one_location_saved_place_confirm",
            )
        ),
    )
    assert response.status_code == 200, response.text
    assert len(service.stored) == 1


def test_shadow_mode_lets_the_same_chat_write_through(enforce, caplog) -> None:
    """Negative control: the committed contract (shadow) never refuses, it counts."""
    service = enforce("shadow")
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    response = _client().post(
        "/api/pkm/store-domain",
        json=_store_body(
            _plan(domain="location", scope="saved_places", writer_id="agent_chat_owner_request")
        ),
    )
    assert response.status_code == 200
    assert len(service.stored) == 1
    assert any("pkm.reserved_would_refuse" in r.getMessage() for r in caplog.records)


def test_enforce_answers_an_unknown_writer_with_422(enforce) -> None:
    service = enforce()
    client = _client()
    unknown = client.post(
        "/api/pkm/store-domain",
        json=_store_body(
            _plan(domain="location", scope="saved_places", writer_id="brand_new_writer")
        ),
    )
    assert unknown.status_code == 422
    assert unknown.json()["detail"]["code"] == "PKM_WRITER_UNKNOWN"
    # Negative control: a catalogued writer on a branch it does not own is a 403.
    listed_elsewhere = client.post(
        "/api/pkm/store-domain",
        json=_store_body(
            _plan(domain="location", scope="saved_places", writer_id="one_wallet_add")
        ),
    )
    assert listed_elsewhere.status_code == 403
    assert service.stored == []


def _status(body: dict) -> int:
    return _client().post("/api/pkm/store-domain", json=body).status_code


def test_an_old_client_keeps_its_feature_writes_and_loses_only_agent_writes(enforce) -> None:
    """The old-client policy (personal-knowledge-model.md, Phase 2).

    Builds already in TestFlight and the App Store send no client_version. The
    writer catalog still applies to them; only the device-dependent checks are
    skipped; the 409 is reserved for an old client whose writer is unknown.
    """
    service = enforce()

    def old(domain: str, scope: str, writer_id: str, **extra) -> dict:
        return _store_body(
            _plan(domain=domain, scope=scope, writer_id=writer_id, client_version=None), **extra
        )

    # Legitimate Finance and Location writes from an old build go through.
    assert _status(old("location", "saved_places", "one_location_saved_place_confirm")) == 200
    assert _status(old("financial", "profile", "kai_profile_setup_sync")) == 200
    # ...and so does a chat fact filed in the sibling.
    assert _status(old("location", "agent_memory", "agent_chat_owner_request")) == 200
    assert len(service.stored) == 3
    # A memory-agent writer is refused on the app's branch, whatever the client.
    refused = _client().post(
        "/api/pkm/store-domain",
        json=old("location", "saved_places", "agent_chat_owner_request"),
    )
    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "PKM_RESERVED_BRANCH_WRITER_FORBIDDEN"
    # An unknown writer from an old client is the one case that says "update".
    stale = _client().post(
        "/api/pkm/store-domain", json=old("location", "saved_places", "brand_new_writer")
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "PKM_RESERVED_REGISTRY_OUTDATED"
    assert stale.json()["detail"]["min_client_version"] == "2.0.0"
    # Negative control: the same unknown writer from a current client is a 422.
    assert (
        _status(
            _store_body(
                _plan(domain="location", scope="saved_places", writer_id="brand_new_writer")
            )
        )
        == 422
    )
    assert len(service.stored) == 3


def test_an_old_clients_manifest_drift_is_not_read_as_a_reserved_change(enforce) -> None:
    """The manifest diff depends on the client's own builder; skipped for old builds only."""
    service = enforce()
    service.stored_paths = frozenset({"saved_places", "saved_places.locations"})
    drifted = ("saved_places", "saved_places.places", "visit_notes")

    def body(client_version: str | None) -> dict:
        return _store_body(
            _plan(
                domain="location",
                scope="saved_places",
                writer_id="one_location_saved_place_confirm",
                client_version=client_version,
            ),
            manifest_paths=drifted,
        )

    assert _status(body(None)) == 200
    # Negative control: a current client's manifest is held to the diff.
    assert _status(body("2.0.0")) == 403


def test_a_merged_chat_save_into_the_sibling_is_not_refused_for_the_branches_it_left_alone(
    enforce,
) -> None:
    """Regression: a merged save sends a structure decision for the WHOLE domain.

    manifest.ts lists every branch of the merged domain in json_paths and
    top_level_scope_paths. Judged as declared changes, a chat save into
    location.agent_memory read as a write to saved_places and was refused in
    enforce mode. Only paths the stored manifest does not hold are a change.
    """
    service = enforce()
    service.stored_paths = frozenset(
        {"saved_places", "saved_places.locations", "agent_memory", "agent_memory.entities"}
    )
    whole_domain = {
        "top_level_scope_paths": ["agent_memory", "saved_places"],
        "json_paths": [
            "agent_memory",
            "agent_memory.entities",
            "saved_places",
            "saved_places.locations",
        ],
    }
    plan = _plan(
        domain="location", scope="agent_memory", writer_id="agent_chat_owner_confirmed_card"
    )
    accepted = _client().post(
        "/api/pkm/store-domain", json=_store_body(plan, structure_decision=whole_domain)
    )
    assert accepted.status_code == 200, accepted.text
    # Negative control: a structure path the domain did not hold is still a change.
    smuggled = {
        **whole_domain,
        "json_paths": [*whole_domain["json_paths"], "visit_notes", "visit_notes.visits"],
    }
    refused = _client().post(
        "/api/pkm/store-domain", json=_store_body(plan, structure_decision=smuggled)
    )
    assert refused.status_code == 403
    assert refused.json()["detail"]["branches"] == ["visit_notes"]


def _concrete_branch(entry: reserved_branches.ReservedEntry) -> str:
    if entry.branch_prefix != reserved_branches.WILDCARD_BRANCH:
        return entry.branch_prefix
    return "profile" if entry.domain == "financial" else "items"


def _replayable() -> list[tuple[reserved_branches.ReservedEntry, reserved_branches.ReservedWriter]]:
    pairs = []
    for entry in reserved_branches.entries():
        for writer_id in sorted(entry.writer_ids):
            catalogued = writer(writer_id)
            assert catalogued is not None, writer_id
            pairs.append((entry, catalogued))
    return pairs


def test_every_listed_writer_may_write_its_own_entries() -> None:
    """Replay the whole writer inventory against its own entries, as enforce judges it."""
    pairs = _replayable()
    assert len(pairs) > 40
    for entry, catalogued in pairs:
        for mode in catalogued.authorization_modes:
            refusals = evaluate_reserved_write(
                domain=entry.domain,
                paths=[_concrete_branch(entry), f"{_concrete_branch(entry)}.detail"],
                writer_id=catalogued.writer_id,
                authorization_mode=mode,
                capabilities=[catalogued.requires_capability]
                if catalogued.requires_capability
                else [],
            )
            assert refusals == [], (entry.domain, entry.branch_prefix, catalogued.writer_id, mode)


@pytest.mark.parametrize("client_version", ["2.0.0", None])
def test_every_listed_writer_passes_the_store_route_in_enforce_mode(
    enforce, client_version
) -> None:
    """The same replay through /store-domain, for a current and an old client.

    Writers that require a capability (Location finalize, the KYC reply) need a
    minted authority object; their route behavior has its own tests above.
    """
    service = enforce()
    replayed = 0
    for entry, catalogued in _replayable():
        if catalogued.requires_capability:
            continue
        plan = _plan(
            domain=entry.domain,
            scope=_concrete_branch(entry),
            writer_id=catalogued.writer_id,
            client_version=client_version,
        )
        mode = catalogued.authorization_modes[0]
        plan["confirmation_receipt"]["authorization_mode"] = mode
        if mode == "owner_connected_source_sync":
            plan["confirmation_receipt"]["connected_source_provider"] = "plaid"
        response = _client().post("/api/pkm/store-domain", json=_store_body(plan))
        assert response.status_code == 200, (entry.domain, catalogued.writer_id, response.text)
        replayed += 1
    assert replayed == len(service.stored) > 40


def test_enforce_sees_a_reserved_manifest_path_behind_an_agent_memory_scope(enforce) -> None:
    """The scope says agent_memory; the shipped manifest adds identity_documents."""
    service = enforce()
    service.stored_paths = frozenset({"agent_memory", "agent_memory.entities"})
    body = _store_body(
        _plan(domain="identity", scope="agent_memory", writer_id="agent_chat_owner_request"),
        manifest_paths=(
            "agent_memory",
            "agent_memory.entities",
            "identity_documents",
            "identity_documents.passport_number",
            "updated_at",
        ),
    )
    smuggled = _client().post("/api/pkm/store-domain", json=body)
    assert smuggled.status_code == 403
    assert smuggled.json()["detail"]["branches"] == ["identity_documents"]
    # Negative control: the same manifest, already stored, is no change at all.
    service.stored_paths = frozenset(
        {
            "agent_memory",
            "agent_memory.entities",
            "identity_documents",
            "identity_documents.passport_number",
        }
    )
    unchanged = _client().post("/api/pkm/store-domain", json=body)
    assert unchanged.status_code == 200, unchanged.text


def test_shadow_names_a_manifest_diff_as_its_source(enforce, caplog) -> None:
    """Before the flip, shadow counts must separate a claim from a manifest change."""
    service = enforce("shadow")
    service.stored_paths = frozenset({"agent_memory"})
    caplog.set_level(logging.INFO, logger=pkm_routes_shared.logger.name)
    response = _client().post(
        "/api/pkm/store-domain",
        json=_store_body(
            _plan(domain="identity", scope="agent_memory", writer_id="agent_chat_owner_request"),
            manifest_paths=("agent_memory", "identity_documents"),
        ),
    )
    assert response.status_code == 200
    assert _shadow_lines(caplog) == [
        "pkm.reserved_would_refuse domain=identity branch=identity_documents "
        "writer=agent_chat_owner_request reason=memory_agent source=manifest_diff"
    ]


def test_enforce_applies_to_validate_and_to_whole_domain_delete(enforce) -> None:
    enforce()
    client = _client()
    validated = client.post(
        "/api/pkm/store-domain/validate",
        json=_store_body(
            _plan(domain="location", scope="saved_places", writer_id="agent_chat_owner_request")
        ),
    )
    assert validated.status_code == 403
    deleted = client.post(
        "/api/pkm/delete-domain",
        json={
            "user_id": _OWNER,
            "domain": "location",
            "expected_data_version": 3,
            "mutation_plan": _plan(
                domain="location",
                scope="saved_places",
                writer_id="agent_chat_owner_request",
                operation="delete",
            ),
        },
    )
    assert deleted.status_code == 403
    assert deleted.json()["detail"]["branch"] in {"saved_places", "visit_notes"}
    legacy = client.delete(f"/api/pkm/domain-data/{_OWNER}/wallet")
    assert legacy.status_code == 422  # no plan, so no writer: unattributed
    # Negative control: a domain with no reserved branch deletes as before.
    unreserved = client.delete(f"/api/pkm/domain-data/{_OWNER}/food")
    assert unreserved.status_code == 200


class _OpenRequests:
    def __init__(self, open_ids: set[str]) -> None:
        self.open_ids = open_ids

    async def is_open_workflow(self, *, user_id: str, workflow_id: str) -> bool:
        return user_id == _OWNER and workflow_id in self.open_ids


def test_the_kyc_reply_writer_needs_an_open_information_request(enforce, monkeypatch) -> None:
    service = enforce()
    request_id = str(uuid.uuid4())
    requests = _OpenRequests({request_id})
    monkeypatch.setattr(
        "hushh_mcp.services.gmail_personal_information_request_service."
        "get_personal_gmail_information_request_service",
        lambda: requests,
    )
    client = _client()
    plan = _plan(
        domain="identity",
        scope="identity_documents",
        writer_id="agent_chat_kyc_owner_confirmed",
    )
    bare = client.post("/api/pkm/store-domain", json=_store_body(plan))
    assert bare.status_code == 403
    assert bare.json()["detail"]["reason"] == "capability_missing"

    authority = issue_kyc_reply_authorization(user_id=_OWNER, information_request_id=request_id)
    bound = client.post(
        "/api/pkm/store-domain",
        json=_store_body(plan, kyc_reply_authorization=authority.model_dump(mode="json")),
    )
    assert bound.status_code == 200, bound.text
    assert service.stored[-1]["reserved_capabilities"] == frozenset({"information_request_id"})

    forged = authority.model_dump(mode="json")
    forged["token"] = "kycreplytoken_" + "0" * 64
    assert (
        client.post(
            "/api/pkm/store-domain", json=_store_body(plan, kyc_reply_authorization=forged)
        ).status_code
        == 422
    )
    other_owner = issue_kyc_reply_authorization(
        user_id="someone_else", information_request_id=request_id
    )
    assert (
        client.post(
            "/api/pkm/store-domain",
            json=_store_body(plan, kyc_reply_authorization=other_owner.model_dump(mode="json")),
        ).status_code
        == 422
    )
    requests.open_ids.clear()  # the owner answered or ignored the request
    closed = client.post(
        "/api/pkm/store-domain",
        json=_store_body(plan, kyc_reply_authorization=authority.model_dump(mode="json")),
    )
    assert closed.status_code == 422
    assert closed.json()["detail"]["reason"] == "kyc_reply_information_request_closed"
    expired = issue_kyc_reply_authorization(
        user_id=_OWNER,
        information_request_id=request_id,
        now=datetime.now(UTC) - timedelta(hours=1),
    )
    requests.open_ids.add(request_id)
    assert (
        client.post(
            "/api/pkm/store-domain",
            json=_store_body(plan, kyc_reply_authorization=expired.model_dump(mode="json")),
        ).status_code
        == 422
    )


def test_the_service_refuses_too_when_called_without_the_route(monkeypatch) -> None:
    """Defense in depth inside store_domain_data, for any caller but the route."""
    from hushh_mcp.services import personal_knowledge_model_service as service_module
    from hushh_mcp.services.pkm_mutation_contracts import PkmMutationPlanV2

    plan = PkmMutationPlanV2.model_validate(
        _plan(domain="location", scope="saved_places", writer_id="agent_chat_owner_request")
    )
    refusal = service_module.PersonalKnowledgeModelService._reserved_branch_refusal
    monkeypatch.setattr(service_module, "reserved_enforcement_mode", lambda: "enforce")
    detail = refusal(
        domain="location", mutation_plan=plan, structure_decision=None, capabilities=frozenset()
    )
    assert detail is not None and detail["code"] == "PKM_RESERVED_BRANCH_WRITER_FORBIDDEN"
    monkeypatch.setattr(service_module, "reserved_enforcement_mode", lambda: "shadow")
    assert (
        refusal(
            domain="location",
            mutation_plan=plan,
            structure_decision=None,
            capabilities=frozenset(),
        )
        is None
    )


@pytest.fixture
def shared_owner_placement(monkeypatch):
    """Exercise the real hub guard with an explicitly Shared route-test owner."""
    from hushh_mcp.services import owner_placement_guard

    placement = AsyncMock(return_value="shared")
    monkeypatch.setattr(owner_placement_guard, "pod_mode", lambda: False)
    monkeypatch.setattr(owner_placement_guard, "get_owner_hosting_mode", placement)
    return placement


def test_the_issuer_mints_only_for_an_open_request(monkeypatch, shared_owner_placement) -> None:
    from api.middleware import require_firebase_auth, require_vault_owner_token
    from api.routes.one import gmail_information_requests as routes

    request_id = str(uuid.uuid4())
    monkeypatch.setattr(routes, "_service", lambda: _OpenRequests({request_id}))
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[require_firebase_auth] = lambda: _OWNER
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": _OWNER}
    client = TestClient(app)
    minted = client.post(
        f"/api/one/email/information-requests/{request_id}/pkm-reply-authorization"
    )
    assert minted.status_code == 200
    assert minted.json()["information_request_id"] == request_id
    assert minted.json()["token"].startswith("kycreplytoken_")
    assert minted.headers["cache-control"] == "private, no-store"
    closed = client.post(
        f"/api/one/email/information-requests/{uuid.uuid4()}/pkm-reply-authorization"
    )
    assert closed.status_code == 404
