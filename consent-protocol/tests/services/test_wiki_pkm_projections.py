"""Phase 3 (#9370) conformance tests: revision-bound PKM projections, 8-state availability, and anti-broadening."""

from __future__ import annotations

import pytest

import hushh_mcp.consent.scope_generator as scope_generator_mod
from hushh_mcp.consent.scope_generator import DynamicScopeGenerator
from hushh_mcp.services.personal_knowledge_model_service import (
    PersonalKnowledgeModelService,
)
from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService
from hushh_mcp.services.pkm_preparation_contracts import PKMAgentLabStructureRequest
from hushh_mcp.services.pkm_scope_availability import PkmScopeAvailabilityResolver
from hushh_mcp.services.pod_files.storage import FilesLocalStore
from hushh_mcp.services.wiki_memory import (
    NON_REQUESTABLE_PROJECTION_STATES,
    WIKI_CLAIM_PROJECTION_PROFILE,
    WIKI_PROJECTION_STATES,
    WikiLibrary,
    WikiProjectionEngine,
    WikiRefused,
    WikiTombstone,
)


async def _allowed() -> None:
    return None


@pytest.fixture
def wiki(tmp_path) -> WikiLibrary:
    return WikiLibrary(
        owner="owner-phase3",
        key=b"P" * 32,
        store=FilesLocalStore(str(tmp_path)),
        check=_allowed,
        account_generation=2,
        library_id="lib-phase3",
    )


async def _seed_verified_page(wiki: WikiLibrary) -> dict:
    src = await wiki.register_source(
        {
            "source_id": "wsr_aaaa1111bbbb2222",
            "kind": "chat_turn",
            "locator": "chat:c10/m1",
            "content_sha256": "d" * 64,
            "observed_at": "2026-11-14",
            "consent_derived": False,
        },
        idempotency_key="seed-src-1",
    )
    return await wiki.create_page(
        page_id="wpg_1234567890abcdef",
        title="Career & Preferences",
        folder="work/projects",
        tldr="Principal architect preferences.",
        status_as_of="2026-11-14",
        body="Verified career and travel context.",
        claims=[
            {
                "claim_id": "wcl_1111111111111111",
                "statement": "Works as Principal Systems Architect in San Francisco.",
                "status": "active",
                "confidence": 0.96,
                "source_ids": [src["source_id"]],
                "observed_at": "2026-11-14",
            },
            {
                "claim_id": "wcl_2222222222222222",
                "statement": "Checking balance is $950,000 at Chase.",
                "status": "active",
                "confidence": 0.80,
                "source_ids": [src["source_id"]],
                "observed_at": "2026-11-14",
            },
            {
                "claim_id": "wcl_3333333333333333",
                "statement": "Possibly relocating to Tokyo next spring.",
                "status": "uncertain",
                "confidence": 0.45,
                "source_ids": [src["source_id"]],
                "observed_at": "2026-11-14",
            },
        ],
        idempotency_key="seed-page-1",
    )


@pytest.mark.asyncio
async def test_projection_domain_guards_specialist_conflicts_and_anti_broadening(
    wiki: WikiLibrary,
) -> None:
    page = await _seed_verified_page(wiki)
    engine = WikiProjectionEngine(wiki)

    # 1. Missing explicit target_domain/json_path refuses implicit folder-to-attr.* conversion.
    with pytest.raises(WikiRefused, match="WIKI_PROJECTION_MAPPING_REQUIRED"):
        await engine.derive_projection(
            page_id=page["page_id"],
            claim_id="wcl_1111111111111111",
            target_domain=None,
            json_path=None,
            idempotency_key="missing-map",
        )

    # 2. Reserved / specialist / private domains are refused with WIKI_PROJECTION_DOMAIN_FORBIDDEN.
    for forbidden in (
        "one_memory",
        "one_wiki",
        "source_library",
        "secrets",
        "financial",
        "identity",
        "consent",
        "kyc_identity",
        "work/projects",
    ):
        with pytest.raises(WikiRefused, match="WIKI_PROJECTION_DOMAIN_FORBIDDEN"):
            await engine.derive_projection(
                page_id=page["page_id"],
                claim_id="wcl_1111111111111111",
                target_domain=forbidden,
                json_path="summary.role",
                idempotency_key=f"forbid-{forbidden}",
            )

    # 3. Anti-broadening: active_recipient_count > 0 holds newly derived leaf in private_candidate!
    candidate = await engine.derive_projection(
        page_id=page["page_id"],
        claim_id="wcl_1111111111111111",
        target_domain="professional",
        json_path="career.role",
        idempotency_key="derive-cand-1",
        active_recipient_count=2,
    )
    assert candidate["state"] == "private_candidate"
    assert candidate["exposure_eligibility"] is False

    # Explicit owner confirmation promotes private_candidate -> materialized.
    confirmed = await engine.confirm_candidate_projection(
        candidate["receipt_id"],
        idempotency_key="confirm-cand-1",
    )
    assert confirmed["state"] == "materialized"
    assert confirmed["exposure_eligibility"] is True
    assert confirmed["source_revision"] == 2

    # 4. Typed-specialist disagreement (Finance / KYC / Consent) marks receipt conflicted without overwriting specialist!
    specialist_state = {
        "financial": {"checking_balance": "$12,400"},
        "identity": {"legal_name": "Alex Rivera"},
    }
    conflicted = await engine.derive_projection(
        page_id=page["page_id"],
        claim_id="wcl_2222222222222222",
        target_domain="lifestyle",
        json_path="budget.checking_balance",
        proposed_value="$950,000",
        specialist_snapshot=specialist_state,
        idempotency_key="derive-spec-conflict",
    )
    assert conflicted["state"] == "conflicted"
    assert conflicted["exposure_eligibility"] is False
    assert conflicted["specialist_disagreement"] == {
        "authority": "financial",
        "reason": "authoritative_value_mismatch",
        "path": "financial.checking_balance",
    }
    # Authoritative specialist snapshot remains untouched and its secret/dollar value is not leaked in metadata
    assert "$12,400" not in str(conflicted)

    # Uncertain claims also stay conflicted and non-requestable.
    uncertain_rec = await engine.derive_projection(
        page_id=page["page_id"],
        claim_id="wcl_3333333333333333",
        target_domain="travel",
        json_path="plans.relocation",
        idempotency_key="derive-uncertain",
    )
    assert uncertain_rec["state"] == "conflicted"
    assert uncertain_rec["exposure_eligibility"] is False


@pytest.mark.asyncio
async def test_lifecycle_staleness_tombstone_fences_and_out_of_order_retry_rejection(
    wiki: WikiLibrary,
) -> None:
    page = await _seed_verified_page(wiki)
    engine = WikiProjectionEngine(wiki)

    receipt = await engine.derive_projection(
        page_id=page["page_id"],
        claim_id="wcl_1111111111111111",
        target_domain="professional",
        json_path="career.role",
        idempotency_key="derive-live-1",
        active_recipient_count=0,
    )
    assert receipt["state"] == "materialized"
    assert receipt["exposure_eligibility"] is True

    # Retracting + tombstoning the claim transitions the receipt to stale (exposure_eligibility=False).
    updated_claims = [
        ({**c, "status": "retracted"} if c["claim_id"] == "wcl_1111111111111111" else c)
        for c in page["claims"]
    ]
    edited = await wiki.edit_page(
        page["page_id"],
        expected_revision=page["revision"],
        idempotency_key="retract-role-claim",
        claims=updated_claims,
    )
    await wiki.put_tombstone(
        WikiTombstone(
            tombstone_id="wtb_9999888877776666",
            target_kind="claim",
            target_id="wcl_1111111111111111",
            reason_code="retracted",
            created_at=1_700_000_000_000,
            page_id=page["page_id"],
        ),
        idempotency_key="tb-role-claim",
    )

    synced = await engine.sync_page_lifecycle(page["page_id"])
    assert len(synced) == 1
    assert synced[0]["state"] == "stale"
    assert synced[0]["exposure_eligibility"] is False
    assert synced[0]["tombstone_id"] == "wtb_9999888877776666"
    assert synced[0]["page_revision"] == edited["revision"]

    # Out-of-order retry from an older page_revision MUST fail closed with WIKI_PROJECTION_STALE_REVISION.
    with pytest.raises(WikiRefused, match="WIKI_PROJECTION_STALE_REVISION"):
        await wiki.put_projection_receipt(
            {
                **receipt,
                "page_revision": 1,
                "source_revision": 1,
                "state": "materialized",
                "exposure_eligibility": True,
            },
            idempotency_key="stale-retry-old-rev",
        )

    # Trying to resurrect a tombstoned receipt at the SAME revision MUST fail closed with WIKI_PROJECTION_TOMBSTONED.
    with pytest.raises(WikiRefused, match="WIKI_PROJECTION_TOMBSTONED"):
        await wiki.put_projection_receipt(
            {
                **synced[0],
                "tombstone_id": None,
                "state": "materialized",
                "exposure_eligibility": True,
            },
            idempotency_key="resurrect-same-rev",
        )

    # Confirming a tombstoned/stale receipt is also refused.
    with pytest.raises(WikiRefused, match="WIKI_PROJECTION_NOT_CONFIRMABLE"):
        await engine.confirm_candidate_projection(
            synced[0]["receipt_id"],
            idempotency_key="confirm-stale-refused",
        )


@pytest.mark.asyncio
async def test_eight_state_availability_never_coerces_non_materialized_to_unknown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1. PersonalKnowledgeModelService._sanitize_manifest_summary_projection preserves all 8 states.
    raw_summary = {
        "scope_materialization": {
            "career": {"state": "materialized", "materialized_leaf_count": 2},
            "candidate_sec": {"state": "private_candidate", "materialized_leaf_count": 0},
            "stale_sec": {"state": "stale", "materialized_leaf_count": 0},
            "conflict_sec": {"state": "conflicted", "materialized_leaf_count": 0},
            "pending_sec": {"state": "pending", "materialized_leaf_count": 0},
            "failed_sec": {"state": "failed", "materialized_leaf_count": 0},
            "empty_sec": {"state": "empty", "materialized_leaf_count": 0},
            "legacy_sec": {"state": "unknown", "materialized_leaf_count": 0},
        }
    }
    sanitized = PersonalKnowledgeModelService._sanitize_manifest_summary_projection(raw_summary)
    mat_map = sanitized["scope_materialization"]
    assert set(mat_map.keys()) == set(raw_summary["scope_materialization"].keys())
    for key, expected in raw_summary["scope_materialization"].items():
        assert mat_map[key]["state"] == expected["state"]

    # 2. PkmScopeAvailabilityResolver keeps all 6 non-requestable states non-requestable!
    class _StubScopeGen:
        async def get_available_scope_entries(self, user_id: str) -> list[dict]:
            return [
                {
                    "scope": f"attr.professional.{st}_branch.*",
                    "materialization_state": st,
                    "materialized_leaf_count": 1 if st == "materialized" else 0,
                    "source_manifest_revision": 4,
                }
                for st in WIKI_PROJECTION_STATES
            ]

    resolver = PkmScopeAvailabilityResolver(scope_generator=_StubScopeGen())
    all_scopes = [f"attr.professional.{st}_branch.*" for st in WIKI_PROJECTION_STATES]
    requestable, blocked = await resolver.filter_requestable(
        user_id="owner-phase3", scopes=all_scopes
    )
    assert requestable == [
        "attr.professional.materialized_branch.*",
        "attr.professional.unknown_branch.*",
    ]
    for st in NON_REQUESTABLE_PROJECTION_STATES:
        assert f"attr.professional.{st}_branch.*" in blocked

    # 3. DynamicScopeGenerator withholds non-requestable branches AND withholds domain wildcard when a branch is private_candidate/stale/conflicted.
    gen = DynamicScopeGenerator()

    async def _fake_read_rows(_db_fn, _uid: str, *, connection=None) -> dict[str, list[dict]]:
        return {
            "pkm_index": [{"available_domains": ["professional"]}],
            "pkm_manifests": [
                {
                    "domain": "professional",
                    "manifest_version": 3,
                    "top_level_scope_paths": ["career", "draft_wiki"],
                    "externalizable_paths": ["career.role", "draft_wiki.role"],
                    "summary_projection": {
                        "scope_materialization": {
                            "career": {"state": "materialized", "materialized_leaf_count": 1},
                            "draft_wiki": {
                                "state": "private_candidate",
                                "materialized_leaf_count": 0,
                            },
                        }
                    },
                }
            ],
            "pkm_manifest_paths": [
                {
                    "domain": "professional",
                    "json_path": "career.role",
                    "path_type": "leaf",
                    "exposure_eligibility": True,
                },
                {
                    "domain": "professional",
                    "json_path": "draft_wiki.role",
                    "path_type": "leaf",
                    "exposure_eligibility": True,
                },
            ],
            "pkm_scope_registry": [
                {
                    "domain": "professional",
                    "scope_handle": "h_career",
                    "scope_label": "Career",
                    "manifest_version": 3,
                    "exposure_enabled": True,
                    "visibility_posture": "consent_required",
                    "summary_projection": {
                        "top_level_scope_path": "career",
                        "materialization_state": "materialized",
                        "materialized_leaf_count": 1,
                        "consumer_visible": True,
                    },
                },
                {
                    "domain": "professional",
                    "scope_handle": "h_draft",
                    "scope_label": "Draft Wiki",
                    "manifest_version": 3,
                    "exposure_enabled": True,
                    "visibility_posture": "consent_required",
                    "summary_projection": {
                        "top_level_scope_path": "draft_wiki",
                        "materialization_state": "private_candidate",
                        "materialized_leaf_count": 0,
                        "consumer_visible": True,
                    },
                },
            ],
        }

    monkeypatch.setattr(scope_generator_mod, "read_scope_catalog_rows", _fake_read_rows)
    discovered = await gen.get_available_scope_entries("owner-phase3")
    discovered_scopes = {item["scope"] for item in discovered}
    assert "attr.professional.career.*" in discovered_scopes
    assert "attr.professional.career.role" in discovered_scopes
    assert "attr.professional.draft_wiki.*" not in discovered_scopes
    assert "attr.professional.draft_wiki.role" not in discovered_scopes
    # Domain wildcard is withheld because draft_wiki is private_candidate (prevents wildcard broadening!)
    assert "attr.professional.*" not in discovered_scopes


@pytest.mark.asyncio
async def test_agent_lab_wiki_claim_projection_profile_bounds(wiki: WikiLibrary) -> None:
    await _seed_verified_page(wiki)
    engine = WikiProjectionEngine(wiki)
    payload = await engine.build_agent_lab_claim_payload(domain="professional")
    assert payload["memory_profile"] == WIKI_CLAIM_PROJECTION_PROFILE

    req = PKMAgentLabStructureRequest(
        user_id="owner-phase3",
        message="Project verified professional claims.",
        current_domains=["professional"],
        simulated_state=payload["simulated_state"],
        memory_profile="wiki_claim_projection_v1",
    )
    summary = PKMAgentLabService._build_state_summary(
        req.simulated_state, memory_profile=req.memory_profile
    )
    # Active claims only (uncertain claim wcl_3333333333333333 is excluded from projection payload!)
    assert len(summary["recent_memories"]) == 2
    assert all(len(m["message"]) > 20 for m in summary["recent_memories"])

    # Exceeding 64 items fails closed
    with pytest.raises(ValueError, match="Wiki claim projection snapshot exceeds its bound"):
        PKMAgentLabService._build_state_summary(
            {
                "domains": ["professional"],
                "memories": [{"message": "claim"} for _ in range(65)],
            },
            memory_profile="wiki_claim_projection_v1",
        )
