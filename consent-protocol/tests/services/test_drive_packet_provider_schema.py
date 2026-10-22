"""Provider grammar projection must preserve data fields and host acceptance rules."""

from copy import deepcopy

import pytest
from google.genai import _transformers
from pydantic import BaseModel, Field, ValidationError

from hushh_mcp.services.drive_citation_references import (
    ReferencedDocumentFacts,
    ReferencedPageFacts,
    ReferencedRecordStatus,
    resolve_references,
)
from hushh_mcp.services.drive_packet_contract import (
    CanonicalPacketKey,
    DocumentFacts,
    DocumentPageFacts,
    EvidenceModel,
    PacketAssessment,
    PacketProposal,
    PacketRequestMatch,
    PacketVerification,
    PacketVerificationProposal,
    PageCitation,
    PricingAssessment,
    RecordStatus,
)


def assert_required_properties_exist(node):
    if isinstance(node, dict):
        assert set(node.get("required", [])) <= set(node.get("properties", {}))
        for value in node.values():
            assert_required_properties_exist(value)
    elif isinstance(node, list):
        for value in node:
            assert_required_properties_exist(value)


@pytest.mark.parametrize(
    "model",
    [
        DocumentPageFacts,
        DocumentFacts,
        PacketAssessment,
        PacketProposal,
        ReferencedPageFacts,
        ReferencedDocumentFacts,
        PacketVerification,
        PacketVerificationProposal,
        PacketRequestMatch,
    ],
)
def test_all_provider_schemas_preserve_required_names_after_sdk_expansion(model):
    schema = model.model_json_schema()
    assert_required_properties_exist(schema)
    expanded = deepcopy(schema)
    _transformers.process_schema(expanded, None)
    assert_required_properties_exist(expanded)


def test_projection_does_not_treat_data_property_names_as_keywords():
    class NamedFields(EvidenceModel):
        title: str = Field(min_length=1)
        default: str
        minimum: int

    schema = NamedFields.model_json_schema()
    assert set(schema["properties"]) == {"title", "default", "minimum"}
    assert "minLength" not in schema["properties"]["title"]
    assert "title" in CanonicalPacketKey.model_json_schema()["properties"]
    assert "title" in PacketAssessment.model_json_schema()["properties"]


def test_provider_projection_keeps_original_strict_host_constraints():
    # The provider projection does not rewrite Pydantic's validation schema.
    raw = BaseModel.model_json_schema.__func__(PageCitation)
    assert raw["properties"]["quote"]["maxLength"] == 1000
    for value in [
        {"page": 0, "quote": "source"},
        {"page": "1", "quote": "source"},
        {"page": 1, "quote": ""},
        {"page": 1, "quote": "x" * 1001},
        {"page": 1, "quote": "source", "invented": True},
    ]:
        with pytest.raises(ValidationError):
            PageCitation.model_validate(value)
    with pytest.raises(ValidationError):
        CanonicalPacketKey(key="key", title="", description="Description")
    with pytest.raises(ValidationError):
        PricingAssessment(
            rubric_version="drive-packet-price-v1",
            useful_scope="single",
            coverage="complete",
            quality="verified",
            rationale="One period",
            suggested_price_cents=50001,
        )


def test_new_model_status_and_checker_fields_are_required_without_rewriting_history():
    for model in (ReferencedPageFacts, ReferencedDocumentFacts):
        assert "record_status" in model.model_json_schema()["required"]
    assert "correct_record_status" in PacketVerificationProposal.model_json_schema()["required"]
    assert "correct_standalone_value" in PacketVerificationProposal.model_json_schema()["required"]
    assert "standalone_value" in PacketProposal.model_json_schema()["required"]
    assert "utility_rationale" in PacketProposal.model_json_schema()["required"]
    legacy = {
        "state": "ready",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_coverage": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }
    assert PacketVerification.model_validate(legacy).correct_record_status is None
    assert PacketVerification.model_validate(legacy).correct_standalone_value is None
    with pytest.raises(ValidationError):
        PacketVerificationProposal.model_validate(legacy)
    with pytest.raises(ValidationError):
        PacketVerificationProposal.model_validate(
            {**legacy, "correct_record_status": True, "correct_standalone_value": False}
        )
    assert (
        PacketVerificationProposal.model_validate(
            {**legacy, "correct_record_status": True, "correct_standalone_value": True}
        ).state
        == "ready"
    )


def test_record_status_does_not_promote_a_cited_source_assertion_to_completion():
    status = {
        "status": "completed",
        "evidence_basis": "source_assertion",
        "explanation": "The template states that this agreement was signed.",
        "citations": [{"page": 1, "quote": "This agreement was signed."}],
    }
    with pytest.raises(ValidationError, match="completed record requires completion evidence"):
        RecordStatus.model_validate(status)
    draft = {**status, "status": "draft", "evidence_basis": "documentary_form"}
    assert RecordStatus.model_validate(draft).status == "draft"
    with pytest.raises(ValidationError, match="requires citations"):
        RecordStatus.model_validate({**draft, "citations": []})


def test_status_reference_resolution_keeps_claim_and_counterevidence_together():
    claim = "This agreement was signed."
    qualification = "Draft only. Signatory: [Signature]. Verify before finalizing."
    result = ReferencedPageFacts(
        pages=[1, 2],
        document_type=None,
        issuer=None,
        subject=None,
        account=None,
        record_status=ReferencedRecordStatus(
            status="draft",
            evidence_basis="documentary_form",
            explanation="Draft and signature placeholder; execution is not established.",
            citation_refs=["p1s0", "p2s0"],
        ),
        periods=[],
        date_evidence=[],
        topics=[],
        facts=[],
        missing_information=[],
        ambiguous=False,
    )
    resolved = resolve_references(
        result,
        {"p1s0": {"page": 1, "quote": claim}, "p2s0": {"page": 2, "quote": qualification}},
    )
    assert [c.quote for c in resolved.record_status.citations] == [claim, qualification]
    legacy = resolved.model_dump(exclude={"record_status"})
    assert DocumentPageFacts.model_validate(legacy).record_status.status == "unknown"
    with pytest.raises(ValueError, match="unknown citation reference"):
        resolve_references(result, {"p1s0": {"page": 1, "quote": claim}})
