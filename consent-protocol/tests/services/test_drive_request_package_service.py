"""Content-evaluation boundaries; no provider writes or payment collaborators."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_request_package_assessment import (
    BoundDocumentAssessment,
    BoundDocumentBatchAssessment,
    PackageAssessment,
)
from hushh_mcp.services.drive_request_package_service import (
    DriveRequestPackageService,
    assessment_policy_version,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError


def document(ref="p1", decision="include"):
    return BoundDocumentAssessment(
        document_ref=ref,
        decision=decision,
        confidence=88,
        reason="Content evidence",
        citations=[{"source_ref": ref + ":content", "quote": "Statement September 2026"}],
        covered_periods=[],
        source_version="7",
    )


def job(count=1):
    return dict(
        user_id="owner",
        job_id="job",
        request_id="request",
        purpose={"topic": "statement"},
        candidates=[
            dict(
                position=i,
                document_ref=f"p{i}",
                metadata={
                    "id": f"file{i}",
                    "name": "Statement",
                    "mimeType": "application/pdf",
                    "shareable": True,
                },
            )
            for i in range(1, count + 1)
        ],
    )


def setup_work(work):
    store = SimpleNamespace(
        claim_evaluation=AsyncMock(return_value=work),
        require_evaluation_current=AsyncMock(),
        commit_evaluations=AsyncMock(),
        release_evaluation=AsyncMock(),
        finalize_package=AsyncMock(return_value={"status": "ready"}),
        package_evidence_page=AsyncMock(),
        due_evaluations=AsyncMock(),
    )
    reader = SimpleNamespace(
        read_compilation_match=AsyncMock(
            return_value=(SimpleNamespace(version="7"), "Statement September 2026", False)
        )
    )
    assessor = AsyncMock(return_value=BoundDocumentBatchAssessment(documents=[document()]))
    final = AsyncMock(
        return_value=PackageAssessment(
            decision="partial",
            coverage_status="partial",
            selected_document_refs=["p1"],
            confidence=87,
            importance=145,
            suggested_price_cents=1250,
            rationale="Requested records",
            coverage_summary="One month",
            gaps=["October unavailable"],
        )
    )
    wake = AsyncMock()
    service = DriveRequestPackageService(
        store=store,
        reader_factory=lambda **_: reader,
        document_assessor=assessor,
        package_assessor=final,
        wake=wake,
    )
    return service, store, reader, assessor, final, wake


async def test_read_and_final_model_use_separate_leases_and_persist_no_body():
    service, store, reader, assessor, final, wake = setup_work(job())
    assert await service.run_one(user_id="owner", job_id="job") == "queued"
    final.assert_not_awaited()
    store.finalize_package.assert_not_awaited()
    assert store.require_evaluation_current.await_count >= 4
    observed = store.commit_evaluations.call_args.kwargs["observations"][0]
    assert observed["source_version"] == "7" and len(observed["content_fingerprint"]) == 64
    assert "text" not in observed and "body" not in observed
    assert observed["assessment"]["citations"][0]["quote"] == "Statement September 2026"
    store.release_evaluation.assert_awaited_once()
    wake.assert_awaited_once_with("suggestions")


async def test_v1_evaluation_uses_marked_claim_and_v1_wake():
    work = job()
    work["v1_statement_search"] = True
    work["purpose"] = {
        "purpose": "Schwab brokerage statements",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-10-09",
    }
    service, store, reader, assessor, _, wake = setup_work(work)
    body = "Charles Schwab Account Statement. Period: 2026-09-01 to 2026-10-09."
    reader.read_compilation_match.return_value = (SimpleNamespace(version="7"), body, False)
    assessor.return_value = BoundDocumentBatchAssessment(
        documents=[
            BoundDocumentAssessment(
                document_ref="p1",
                decision="include",
                confidence=92,
                weightage_out_of_10=9.0,
                record_type_claim="brokerage statement",
                entity_claim="Charles Schwab",
                period_role="statement_coverage",
                reason="Verified statement.",
                citations=[{"source_ref": "p1:content", "quote": body}],
                covered_periods=[
                    {
                        "period_start": "2026-09-01",
                        "period_end": "2026-10-09",
                        "source_refs": ["p1:content"],
                    }
                ],
                source_version="7",
            )
        ]
    )
    assert await service.run_one(user_id="owner", job_id="job", v1_only=True) == "queued"
    assert store.claim_evaluation.call_args.kwargs["v1_only"] is True
    assert (
        store.commit_evaluations.call_args.kwargs["observations"][0]["assessment"]["decision"]
        == "include"
    )
    wake.assert_awaited_once_with("v1")


async def test_revocation_after_provider_read_prevents_model_and_commit():
    service, store, reader, assessor, final, wake = setup_work(job())
    store.require_evaluation_current.side_effect = [
        None,
        DriveReadError("background_preparation_required"),
    ]
    assert await service.run_one(user_id="owner", job_id="job") == "unavailable"
    assessor.assert_not_awaited()
    store.commit_evaluations.assert_not_awaited()
    assert store.release_evaluation.call_args.kwargs["retryable"] is False


async def test_unreadable_file_is_accounted_without_model_invention():
    service, store, reader, assessor, final, wake = setup_work(job())
    reader.read_compilation_match.side_effect = DriveReadError("unsupported_format")
    assert await service.run_one(user_id="owner", job_id="job") == "queued"
    assessor.assert_not_awaited()
    item = store.commit_evaluations.call_args.kwargs["observations"][0]
    assert item["assessment"] is None and item["unreadable_reason"] == "unsupported_format"


async def test_provider_failure_is_retryable_and_does_not_skip_candidate():
    service, store, reader, assessor, final, wake = setup_work(job())
    reader.read_compilation_match.side_effect = DriveReadError("provider_unavailable")
    assert await service.run_one(user_id="owner", job_id="job") == "unavailable"
    store.commit_evaluations.assert_not_awaited()
    assert store.release_evaluation.call_args.kwargs["retryable"] is True


async def test_truncated_document_cannot_hide_context_loss():
    service, store, reader, assessor, final, wake = setup_work(job())
    reader.read_compilation_match.return_value = (SimpleNamespace(version="7"), "x" * 21000, False)
    assert await service.run_one(user_id="owner", job_id="job") == "queued"
    assert assessor.call_args.kwargs["retrieved"]["truncated"] is True
    assert store.commit_evaluations.call_args.kwargs["observations"][0]["truncated"] is True


async def test_v1_long_document_preserves_late_content_without_false_truncation():
    work = job()
    work["v1_statement_search"] = True
    work["purpose"] = {"periodStart": "2026-09-01", "periodEnd": "2026-09-30"}
    service, store, reader, assessor, _, _ = setup_work(work)
    late = "Charles Schwab statement period September 1 - September 30, 2026"
    reader.read_compilation_match.return_value = (
        SimpleNamespace(version="7"),
        "account activity\n" * 2100 + late,
        False,
    )
    assessor.return_value = BoundDocumentBatchAssessment(documents=[document(decision="exclude")])
    assert await service.run_one(user_id="owner", job_id="job", v1_only=True) == "queued"
    retrieved = assessor.call_args.kwargs["retrieved"]
    assert late in "".join(item["text"] for item in retrieved["untrusted_external_content"])
    assert retrieved["truncated"] is False
    observed = store.commit_evaluations.call_args.kwargs["observations"][0]
    assert observed["truncated"] is False
    assert observed["assessment"]["decision"] == "exclude"


async def test_v1_docx_omitted_image_signal_stays_incomplete_after_text_assessment():
    work = job()
    work["v1_statement_search"] = True
    work["candidates"][0]["metadata"]["mimeType"] = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    service, store, reader, assessor, _, _ = setup_work(work)
    reader.read_compilation_match.return_value = (
        SimpleNamespace(version="7"),
        "Charles Schwab Account Statement. September 1 to September 30, 2026.",
        True,
    )
    assessor.return_value = BoundDocumentBatchAssessment(documents=[document(decision="exclude")])
    assert await service.run_one(user_id="owner", job_id="job", v1_only=True) == "queued"
    observed = store.commit_evaluations.call_args.kwargs["observations"][0]
    assert observed["truncated"] is True
    assert assessor.call_args.kwargs["retrieved"]["truncated"] is True


async def test_v1_pdf_page_evidence_binds_late_period_to_original_source():
    work = job()
    work["v1_statement_search"] = True
    work["purpose"] = {
        "purpose": "Schwab brokerage statements",
        "periodStart": "2026-09-01",
        "periodEnd": "2026-09-30",
    }
    service, store, reader, assessor, _, _ = setup_work(work)
    late = "Charles Schwab brokerage statement. September 1, 2026 to September 30, 2026."
    reader.read_request_visual_pages = AsyncMock(
        return_value=(
            SimpleNamespace(version="7"),
            [
                SimpleNamespace(page_number=1, text="account activity " * 2000),
                SimpleNamespace(page_number=2, text=late),
            ],
            False,
            "a" * 64,
        )
    )
    assessor.return_value = BoundDocumentBatchAssessment(
        documents=[
            BoundDocumentAssessment(
                document_ref="p1",
                decision="include",
                confidence=94,
                weightage_out_of_10=8.5,
                record_type_claim="brokerage statement",
                entity_claim="Charles Schwab",
                period_role="statement_coverage",
                reason="Source verifies the requested statement.",
                citations=[{"source_ref": "p1:page:2", "quote": late}],
                covered_periods=[
                    {
                        "period_start": "2026-09-01",
                        "period_end": "2026-09-30",
                        "source_refs": ["p1:page:2"],
                    }
                ],
                source_version="7",
            )
        ]
    )
    assert await service.run_one(user_id="owner", job_id="job", v1_only=True) == "queued"
    reader.read_compilation_match.assert_not_awaited()
    observation = store.commit_evaluations.call_args.kwargs["observations"][0]
    assert observation["truncated"] is False
    assert observation["content_fingerprint"] == "a" * 64
    assert observation["assessment"]["decision"] == "include"
    assert observation["assessment"]["citations"][0]["source_ref"] == "p1:page:2"


async def test_v1_pdf_cursor_or_ocr_gap_never_becomes_complete():
    work = job()
    work["v1_statement_search"] = True
    work["purpose"] = {"periodStart": "2026-09-01", "periodEnd": "2026-09-30"}
    service, store, reader, assessor, _, _ = setup_work(work)
    reader.read_request_visual_pages = AsyncMock(
        return_value=(
            SimpleNamespace(version="7"),
            [SimpleNamespace(page_number=1, text="partial OCR September 2026")],
            True,
            "b" * 64,
        )
    )
    assessor.return_value = BoundDocumentBatchAssessment(documents=[document(decision="exclude")])
    assert await service.run_one(user_id="owner", job_id="job", v1_only=True) == "queued"
    observed = store.commit_evaluations.call_args.kwargs["observations"][0]
    assert observed["truncated"] is True
    assert assessor.call_args.kwargs["retrieved"]["truncated"] is True


async def test_v1_original_image_routes_through_page_ocr_and_keeps_gap():
    work = job()
    work["v1_statement_search"] = True
    work["candidates"][0]["metadata"]["mimeType"] = "image/png"
    service, store, reader, assessor, _, _ = setup_work(work)
    reader.read_request_visual_pages = AsyncMock(
        return_value=(
            SimpleNamespace(version="7"),
            [SimpleNamespace(page_number=1, text="partial OCR September 2026")],
            True,
            "c" * 64,
        )
    )
    assessor.return_value = BoundDocumentBatchAssessment(documents=[document(decision="exclude")])
    assert await service.run_one(user_id="owner", job_id="job", v1_only=True) == "queued"
    reader.read_compilation_match.assert_not_awaited()
    reader.read_request_visual_pages.assert_awaited_once()
    observed = store.commit_evaluations.call_args.kwargs["observations"][0]
    assert observed["truncated"] is True
    assert observed["content_fingerprint"] == "c" * 64


async def test_v1_large_batch_splits_whole_documents_across_bounded_model_calls():
    work = job(2)
    work["v1_statement_search"] = True
    work["purpose"] = {"periodStart": "2026-09-01", "periodEnd": "2026-09-30"}
    service, store, reader, assessor, _, _ = setup_work(work)
    reader.read_compilation_match.return_value = (
        SimpleNamespace(version="7"),
        "irrelevant rows\n" * 6500,
        False,
    )

    async def exclude_group(*, retrieved, **_):
        refs = {source["document_ref"] for source in retrieved["untrusted_external_content"]}
        assert len(refs) == 1
        return BoundDocumentBatchAssessment(
            documents=[document(ref=ref, decision="exclude") for ref in refs]
        )

    assessor.side_effect = exclude_group
    assert await service.run_one(user_id="owner", job_id="job", v1_only=True) == "queued"
    assert assessor.await_count == 2
    observed = store.commit_evaluations.call_args.kwargs["observations"]
    assert all(not item["truncated"] for item in observed)
    assert all(item["assessment"]["decision"] == "exclude" for item in observed)


async def test_final_assembly_accounts_for_all_pages_and_exclusions():
    work = job(0)
    service, store, reader, assessor, final, wake = setup_work(work)

    def item(i, decision):
        return dict(
            position=i,
            assessment_policy_version=assessment_policy_version(),
            assessment=document(f"p{i}", decision).model_dump(),
            truncated=False,
            unreadable_reason=None,
        )

    store.package_evidence_page.side_effect = [
        {
            "items": [item(1, "include"), item(2, "exclude")],
            "next_position": 2,
            "counts": {"candidates": 3, "evaluated": 3},
        },
        {
            "items": [
                dict(
                    position=3,
                    assessment_policy_version=assessment_policy_version(),
                    assessment=None,
                    truncated=False,
                    unreadable_reason="unsupported_format",
                )
            ],
            "next_position": None,
            "counts": {"candidates": 3, "evaluated": 3},
        },
    ]
    assert await service.run_one(user_id="owner", job_id="job") == "ready"
    reader.read_compilation_match.assert_not_awaited()
    assert final.call_args.kwargs["retrieval_counts"] == {
        "candidates": 3,
        "evaluated": 3,
        "excluded": 1,
        "unreadable": 1,
    }
    assert final.call_args.kwargs["unreadable"] == [{"reason": "unsupported_format", "count": 1}]
    assert len(final.call_args.kwargs["assessments"]) == 1
    assert store.finalize_package.call_args.kwargs["policy_version"].startswith("package-v1:")


async def test_over_budget_final_does_not_silently_drop_selected_candidates():
    service, store, reader, assessor, final, wake = setup_work(job(0))
    items = [
        dict(
            position=i,
            assessment_policy_version=assessment_policy_version(),
            assessment=document(f"p{i}").model_dump(),
            truncated=False,
            unreadable_reason=None,
        )
        for i in range(1, 122)
    ]
    store.package_evidence_page.side_effect = [
        {
            "items": items[:100],
            "next_position": 100,
            "counts": {"candidates": 121, "evaluated": 121},
        },
        {
            "items": items[100:],
            "next_position": None,
            "counts": {"candidates": 121, "evaluated": 121},
        },
    ]
    assert await service.run_one(user_id="owner", job_id="job") == "unavailable"
    final.assert_not_awaited()
    store.finalize_package.assert_not_awaited()
    assert store.release_evaluation.call_args.kwargs["error"] == "package_budget_exceeded"


async def test_cancel_releases_lease_without_publishing():
    service, store, reader, assessor, final, wake = setup_work(job())
    reader.read_compilation_match.side_effect = asyncio.CancelledError
    with pytest.raises(asyncio.CancelledError):
        await service.run_one(user_id="owner", job_id="job")
    store.release_evaluation.assert_awaited_once()
    store.commit_evaluations.assert_not_awaited()


async def test_revoked_claim_does_not_cancel_next_request():
    service, store, reader, assessor, final, wake = setup_work(job())
    store.due_evaluations.return_value = [
        {"user_id": "owner", "job_id": "revoked"},
        {"user_id": "owner", "job_id": "current"},
    ]
    store.claim_evaluation.side_effect = [DriveReadError("background_preparation_required"), job()]
    assert await service.run(max_jobs=2) == {"unavailable": 1, "queued": 1}
    assert store.commit_evaluations.await_count == 1


async def test_failed_read_cancels_sibling_before_lease_release():
    service, store, reader, assessor, final, wake = setup_work(job(2))
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def read(*, match):
        if match["file_id"] == "file1":
            await started.wait()
            raise DriveReadError("background_preparation_required")
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    reader.read_compilation_match.side_effect = read

    async def release(*args, **kwargs):
        assert cancelled.is_set()

    store.release_evaluation.side_effect = release
    assert await service.run_one(user_id="owner", job_id="job") == "unavailable"
    assessor.assert_not_awaited()
    store.commit_evaluations.assert_not_awaited()


async def test_policy_change_during_resume_never_relabels_old_assessments():
    service, store, reader, assessor, final, wake = setup_work(job(0))
    store.package_evidence_page.return_value = {
        "items": [
            dict(
                position=1,
                assessment=document().model_dump(),
                truncated=False,
                unreadable_reason=None,
                assessment_policy_version="previous-policy",
            )
        ],
        "next_position": None,
        "counts": {"candidates": 1, "evaluated": 1},
    }
    assert await service.run_one(user_id="owner", job_id="job") == "unavailable"
    final.assert_not_awaited()
    store.finalize_package.assert_not_awaited()
    assert store.release_evaluation.call_args.kwargs["retryable"] is False


def test_semantic_provider_policy_preserves_default_and_invalidates_azure_binding(monkeypatch):
    import hashlib
    from pathlib import Path

    from hushh_mcp.services import drive_request_package_assessment as assessment
    from hushh_mcp.services import drive_request_package_service as service

    monkeypatch.setattr(service, "resolve_fleet_model_name", lambda _: "synthetic-gemini")
    monkeypatch.setattr(assessment, "validate_semantic_model_binding", lambda value: value)
    monkeypatch.setenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "azure_openai")
    manifest = Path(service.__file__).resolve().parents[1] / "agents/documents/agent.yaml"
    old = "package-v1:" + hashlib.sha256(manifest.read_bytes() + b"\0synthetic-gemini").hexdigest()
    assert service.assessment_policy_version() == old
    selected = {
        "provider": "gemini",
        "deployment": "synthetic-gemini",
        "config_fingerprint": "a",
        "approval_generation": None,
    }
    assert service.assessment_policy_version(selected) == old
    selected.update(
        provider="azure_openai", deployment="synthetic-azure", approval_generation="generation-one"
    )
    azure = service.assessment_policy_version(selected)
    assert azure != old
    for key in ("deployment", "config_fingerprint", "approval_generation"):
        assert service.assessment_policy_version({**selected, key: "changed"}) != azure
    assert service.assessment_policy_version() == old


@pytest.mark.parametrize(
    "field", ["provider", "deployment", "config_fingerprint", "approval_generation"]
)
def test_malformed_semantic_binding_fails_closed_before_model_resolution(field):
    from hushh_mcp.services.drive_request_package_assessment import (
        validate_semantic_model_binding,
    )

    binding = {
        "provider": "gemini",
        "deployment": "synthetic-gemini",
        "config_fingerprint": "synthetic-config",
        "approval_generation": None,
    }
    binding[field] = ["untrusted"]
    with pytest.raises(ValueError, match="Invalid Documents model binding"):
        validate_semantic_model_binding(binding)


@pytest.mark.parametrize("assemble", [False, True])
async def test_legacy_package_genes_never_dispatch_an_azure_bound_request(monkeypatch, assemble):
    from hushh_mcp.services import drive_request_package_assessment as assessment

    monkeypatch.setattr(assessment, "validate_semantic_model_binding", lambda value: value)
    work = job(0 if assemble else 1)
    work["checkpoint"] = {"semantic_model_binding": {"provider": "azure_openai"}}
    service, store, reader, assessor, final, _ = setup_work(work)
    assert await service.run_one(user_id="owner", job_id="job") == "unavailable"
    reader.read_compilation_match.assert_not_awaited()
    assessor.assert_not_awaited()
    final.assert_not_awaited()
    store.finalize_package.assert_not_awaited()
    assert store.release_evaluation.call_args.kwargs["error"] == "assessment_policy_changed"


async def test_private_semantic_binding_keeps_one_approval_generation_and_composes_guard(
    monkeypatch,
):
    from hushh_mcp.services import drive_request_package_assessment as assessment
    from hushh_mcp.services import private_text_processing_approval_service as approval

    monkeypatch.setattr(
        assessment,
        "semantic_request_model_binding",
        lambda: {"provider": "azure_openai", "approval_generation": "sealed-generation"},
    )
    grant = object()
    acquire = AsyncMock(return_value=grant)
    approval_guard = AsyncMock()
    monkeypatch.setattr(approval, "require_private_azure_text_approval", acquire)
    monkeypatch.setattr(
        approval,
        "private_azure_text_require_current",
        lambda value: approval_guard if value is grant else None,
    )
    monkeypatch.setattr(
        assessment, "build_semantic_request_azure_model", lambda **kwargs: SimpleNamespace(**kwargs)
    )
    request_guard = AsyncMock()
    model = await assessment.private_semantic_request_model(
        user_id="synthetic", require_current=request_guard
    )
    await model.require_current()
    await model.require_current()
    acquire.assert_awaited_once_with("synthetic", expected_generation="sealed-generation")
    assert approval_guard.await_count == 2 and request_guard.await_count == 3
    request_guard.side_effect = PermissionError("lease ended")
    with pytest.raises(assessment.RequestAssessmentAuthorityError):
        await model.require_current()
    assert approval_guard.await_count == 2
    request_guard.side_effect = None
    approval_guard.side_effect = PermissionError("approval generation changed")
    with pytest.raises(PermissionError):
        await model.require_current()


def test_uat_policy_binding_is_explicit_frozen_and_invalidated_on_policy_change(monkeypatch):
    from hushh_mcp.services import drive_request_package_assessment as assessment
    from hushh_mcp.services import private_text_processing_approval_service as approval
    from hushh_mcp.services.drive_request_package_service import assessment_policy_version

    monkeypatch.setenv("ENVIRONMENT", "uat")
    monkeypatch.delenv("HUSHH_DEPLOY_ENV", raising=False)
    monkeypatch.setenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", "azure_openai")
    generation = approval.private_drive_text_policy()["generation"]
    binding = assessment.semantic_request_model_binding(
        provider="azure_openai", approval_generation=generation, authorization_basis="uat_policy"
    )
    assert assessment.validate_semantic_model_binding(binding) == binding
    legacy = {k: v for k, v in binding.items() if k != "authorization_basis"}
    assert assessment.validate_semantic_model_binding(legacy) == legacy
    assert assessment_policy_version(binding) != assessment_policy_version(legacy)
    assert assessment.validate_semantic_model_binding(None)["provider"] == "gemini"
    for invalid in ("administrator", "owner_approval", None, True):
        with pytest.raises(ValueError):
            assessment.validate_semantic_model_binding({**binding, "authorization_basis": invalid})
    monkeypatch.setattr(approval, "private_drive_text_policy", lambda: None)
    with pytest.raises(ValueError, match="policy changed"):
        assessment.validate_semantic_model_binding(binding)
    assert assessment.validate_semantic_model_binding(legacy) == legacy


@pytest.mark.parametrize(
    "provider,environment",
    [("azure_openai", "production"), ("azure_openai", "development")],
)
def test_semantic_azure_selection_fails_closed_outside_trusted_uat(
    monkeypatch, provider, environment
):
    from hushh_mcp.services.drive_request_package_assessment import semantic_request_model_binding

    monkeypatch.setenv("DRIVE_REQUEST_SEMANTIC_MODEL_PROVIDER", provider)
    monkeypatch.setenv("ENVIRONMENT", environment)
    with pytest.raises(ValueError):
        semantic_request_model_binding()
