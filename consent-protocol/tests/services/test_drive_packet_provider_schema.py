"""Provider grammar projection must preserve data fields and host acceptance rules."""

from copy import deepcopy

import pytest
from google.genai import _transformers
from pydantic import BaseModel, Field, ValidationError

from hushh_mcp.services.drive_packet_contract import (
    CanonicalPacketKey,
    DocumentFacts,
    DocumentPageFacts,
    EvidenceModel,
    PacketAssessment,
    PacketRequestMatch,
    PacketVerification,
    PageCitation,
    PricingAssessment,
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
        PacketVerification,
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
