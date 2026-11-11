"""Manifest revisions remain bounded independently of contract versions."""

import pytest
from pydantic import ValidationError

from api.routes.pkm_routes_shared import (
    DomainManifestPayload,
    DomainManifestResponse,
    PublicProfileProjectionRequest,
    ScopeExposureRequest,
    ScopeExposureResponse,
)


class TestManifestRevisionBounds:
    def test_manifest_version_bounds(self):
        """A stored revision crosses 1000 without changing contract versions."""
        for revision in (999, 1000, 1001):
            assert DomainManifestPayload(manifest_version=revision).manifest_version == revision
            assert (
                DomainManifestResponse(
                    user_id="owner", domain="financial", manifest_version=revision
                ).manifest_version
                == revision
            )
            assert (
                ScopeExposureRequest(
                    user_id="owner", expected_manifest_version=revision
                ).expected_manifest_version
                == revision
            )
            assert (
                ScopeExposureResponse(success=True, manifest_version=revision).manifest_version
                == revision
            )
            projection = PublicProfileProjectionRequest(
                user_id="owner",
                top_level_scope_path="$.financial",
                manifest_version=revision,
                source_manifest_revision=revision,
            )
            assert projection.manifest_version == projection.source_manifest_revision == revision
        for model, fields in (
            (DomainManifestPayload, {"manifest_version": 1_000_001}),
            (ScopeExposureRequest, {"user_id": "owner", "expected_manifest_version": 1_000_001}),
        ):
            with pytest.raises(ValidationError):
                model(**fields)
