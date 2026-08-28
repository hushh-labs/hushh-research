from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hushh_mcp.services.person_profile_service import PersonProfileService


class _Connections:
    def get_information_scope_catalog(self, *_args, **_kwargs):
        return {
            "items": [
                {
                    "scope": "attr.identity.legal_name",
                    "label": "Legal name",
                    "description": "Name used on official records",
                    "domain": "identity",
                    "sensitivity": "sensitive",
                    "wildcard": False,
                }
            ]
        }


class _Consent:
    async def get_active_tokens(self, *_args, **_kwargs):
        return []


@pytest.mark.asyncio
async def test_viewer_profile_exposes_opaque_scope_metadata_without_raw_scope() -> None:
    rows = iter(
        [
            [
                {
                    "user_id": "subject",
                    "public_person_ref": "11111111-1111-4111-8111-111111111111",
                    "display_name": "A Person",
                    "photo_url": None,
                    "is_verified_ria": False,
                }
            ],
            [{"public_person_ref": "22222222-2222-4222-8222-222222222222"}],
            [],
            [],
            [],
        ]
    )
    db = SimpleNamespace(execute_raw=lambda *_args, **_kwargs: SimpleNamespace(data=next(rows)))
    service = PersonProfileService(connections=_Connections(), consent_db=_Consent())
    with patch("hushh_mcp.services.person_profile_service.get_db", lambda: db):
        payload = await service.get_viewer_profile(
            viewer_user_id="viewer",
            public_person_ref="11111111-1111-4111-8111-111111111111",
        )
    assert payload["requestableScopes"][0]["scopeRef"].startswith("psr_")
    assert "scope" not in payload["requestableScopes"][0]
    assert payload["relationship"]["status"] == "none"
