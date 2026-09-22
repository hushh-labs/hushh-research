"""Bounded encrypted PKM request fields reject malformed sizes before services."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.routes.pkm_routes_shared import StoreDomainRequest

_VALID_BLOB = {"ciphertext": "YWJjZGVmZ2g=", "iv": "aXY=", "tag": "dGFn"}


def _request(blob_override: dict) -> StoreDomainRequest:
    return StoreDomainRequest.model_validate(
        {
            "user_id": "synthetic-owner",
            "domain": "financial",
            "encrypted_blob": {**_VALID_BLOB, **blob_override},
            "summary": {},
        }
    )


@pytest.mark.parametrize(
    ("field", "size", "error_type"),
    [
        ("ciphertext", 0, "string_too_short"),
        ("ciphertext", 10_000_001, "string_too_long"),
        ("iv", 0, "string_too_short"),
        ("iv", 513, "string_too_long"),
        ("tag", 0, "string_too_short"),
        ("tag", 513, "string_too_long"),
    ],
)
def test_encrypted_blob_field_bounds(field: str, size: int, error_type: str) -> None:
    with pytest.raises(ValidationError) as error:
        _request({field: "A" * size})
    assert [(item["loc"], item["type"]) for item in error.value.errors()] == [
        (("encrypted_blob", field), error_type)
    ]


def test_valid_request_accepts_encrypted_blob() -> None:
    request = _request({})
    assert request.encrypted_blob.ciphertext == _VALID_BLOB["ciphertext"]
    assert request.summary == {}
