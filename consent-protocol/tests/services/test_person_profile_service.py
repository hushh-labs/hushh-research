from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hushh_mcp.services.person_profile_service import (
    PersonProfileNotFoundError,
    PersonProfileService,
)


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

    async def get_active_token_export_revisions(self, _tokens):
        return {}


class _ConsentWithGrant(_Consent):
    async def get_active_tokens(self, *_args, **_kwargs):
        return [
            {
                "token_id": "token-1",
                "scope": "attr.professional.job",
                "request_id": "request-1",
                "issued_at": 1,
                "expires_at": None,
            }
        ]

    async def get_active_token_export_revisions(self, tokens):
        assert tokens == ["token-1"]
        return {"token-1": 7}


@pytest.mark.asyncio
async def test_connected_contact_email_requires_a_current_active_edge(monkeypatch):
    service = PersonProfileService(connections=_Connections(), consent_db=_Consent())
    person_ref = "11111111-1111-4111-8111-111111111111"
    row = {
        "user_id": "subject",
        "public_person_ref": person_ref,
        "display_name": "Fixture Person",
        "email": "must-not-enter-public-projection@example.test",
    }
    monkeypatch.setattr(service, "_profile_row", lambda _ref: row)
    monkeypatch.setattr(
        "hushh_mcp.services.person_profile_service.get_db",
        lambda: SimpleNamespace(execute_raw=lambda *_args: SimpleNamespace(data=[])),
    )
    assert "contactEmail" not in service.get_public_profile(person_ref)

    edge_active = True
    contact_queries = []

    def read_one(sql, params):
        if "FROM connections edge" in sql:
            contact_queries.append(params)
            return {"email": "friend@example.test"} if edge_active else None
        return {"public_person_ref": "viewer-ref"}

    monkeypatch.setattr(service, "_execute_one", read_one)
    monkeypatch.setattr(service, "_relationship", lambda *_args: {"status": "connected"})
    connected = await service.get_viewer_profile(
        viewer_user_id="viewer", public_person_ref=person_ref
    )
    assert connected["contactEmail"] == "friend@example.test"
    assert contact_queries == [{"viewer": "viewer", "subject": "subject"}]

    edge_active = False
    revoked = await service.get_viewer_profile(
        viewer_user_id="viewer", public_person_ref=person_ref
    )
    assert revoked["contactEmail"] is None

    monkeypatch.setattr(service, "_relationship", lambda *_args: {"status": "pending_outgoing"})
    pending = await service.get_viewer_profile(
        viewer_user_id="viewer", public_person_ref=person_ref
    )
    assert pending["contactEmail"] is None
    assert len(contact_queries) == 2


@pytest.mark.asyncio
async def test_profile_catalog_pages_all_fields_and_resets_when_authority_changes(monkeypatch):
    from hushh_mcp.services.person_profile_service import _scope_ref

    person_ref = "11111111-1111-4111-8111-111111111111"
    entries = [
        {
            "scope": f"attr.financial.fixture_{index:04d}",
            "domain": "financial",
            "label": f"Fixture {index}",
        }
        for index in range(600)
    ] + [{"scope": "attr.professional.job", "domain": "professional", "label": "Test employer"}]
    service = PersonProfileService(
        connections=SimpleNamespace(get_exact_requestable_scope_entries=lambda *_args: entries),
        consent_db=_Consent(),
    )
    monkeypatch.setattr(
        service,
        "_profile_row",
        lambda _ref: {
            "user_id": "subject",
            "public_person_ref": person_ref,
            "display_name": "Fixture Person",
        },
    )
    monkeypatch.setattr(service, "_execute_one", lambda *_args: {"public_person_ref": "viewer-ref"})
    monkeypatch.setattr(service, "_relationship", lambda *_args: {"status": "none"})
    monkeypatch.setattr(
        "hushh_mcp.services.person_profile_service.get_db",
        lambda: SimpleNamespace(
            execute_raw=lambda *_args: SimpleNamespace(data=[]),
        ),
    )
    page = await service.get_viewer_profile(
        viewer_user_id="viewer", public_person_ref=person_ref, catalog_page=1
    )
    assert len(page["requestableScopes"]) == 100
    assert page["scopeCatalog"]["totalCount"] == 601
    revision = page["scopeCatalog"]["catalogRevision"]
    refs = {item["scopeRef"] for item in page["requestableScopes"]}
    while page["scopeCatalog"]["hasMore"]:
        page = await service.get_viewer_profile(
            viewer_user_id="viewer",
            public_person_ref=person_ref,
            catalog_page=page["scopeCatalog"]["nextPage"],
            catalog_revision=revision,
        )
        assert page["scopeCatalog"]["catalogRevision"] == revision
        refs.update(item["scopeRef"] for item in page["requestableScopes"])
    assert len(refs) == 601
    professional = _scope_ref(person_ref, "attr.professional.job")
    assert professional in {item["scopeRef"] for item in page["requestableScopes"]}
    assert page["scopeCatalog"]["nextPage"] is None
    # Exact validation does not depend on the loaded page.
    assert (
        service.resolve_scope_refs(
            viewer_user_id="viewer", public_person_ref=person_ref, scope_refs=[professional]
        )[1][0]["scopeRef"]
        == professional
    )
    entries.pop()
    reset = await service.get_viewer_profile(
        viewer_user_id="viewer",
        public_person_ref=person_ref,
        catalog_page=7,
        catalog_revision=revision,
    )
    assert reset["scopeCatalog"]["paginationReset"] is True
    assert reset["scopeCatalog"]["page"] == 1
    with pytest.raises(ValueError, match="unavailable"):
        service.resolve_scope_refs(
            viewer_user_id="viewer", public_person_ref=person_ref, scope_refs=[professional]
        )


@pytest.mark.asyncio
async def test_profile_compatibility_catalog_walks_beyond_five_hundred_entries(monkeypatch):
    from hushh_mcp.services.person_profile_service import _scope_ref

    person_ref = "11111111-1111-4111-8111-111111111111"
    entries = [
        {
            "scope": f"attr.financial.fixture_{index:04d}",
            "domain": "financial",
            "label": f"Fixture {index}",
        }
        for index in range(600)
    ] + [{"scope": "attr.professional.job", "domain": "professional", "label": "Test employer"}]

    class _PagedConnections:
        def get_information_scope_catalog(
            self, _viewer, _subject, *, page=1, limit=100, catalog_revision=""
        ):
            revision = "stable-revision"
            if catalog_revision and catalog_revision != revision:
                page = 1
            start = (page - 1) * limit
            items = entries[start : start + limit]
            has_more = start + len(items) < len(entries)
            return {
                "items": items,
                "catalogRevision": revision,
                "hasMore": has_more,
                "nextPage": page + 1 if has_more else None,
            }

    service = PersonProfileService(connections=_PagedConnections(), consent_db=_Consent())
    monkeypatch.setattr(
        service,
        "_profile_row",
        lambda _ref: {
            "user_id": "subject",
            "public_person_ref": person_ref,
            "display_name": "Fixture Person",
        },
    )
    monkeypatch.setattr(service, "_execute_one", lambda *_args: {"public_person_ref": "viewer-ref"})
    # The request-history read goes through the module's get_db, not through
    # the two methods patched above. Left unpatched this test only passes when
    # the process happens to have no database configured, so it turns red the
    # moment any earlier test in the run installs one.
    monkeypatch.setattr(
        "hushh_mcp.services.person_profile_service.get_db",
        lambda: SimpleNamespace(
            execute_raw=lambda *_args: SimpleNamespace(data=[]),
        ),
    )

    page = await service.get_viewer_profile(
        viewer_user_id="viewer", public_person_ref=person_ref, catalog_page=1
    )

    assert page["scopeCatalog"]["totalCount"] == 601
    professional = _scope_ref(person_ref, "attr.professional.job")
    assert professional not in {item["scopeRef"] for item in page["requestableScopes"]}
    tail_page = await service.get_viewer_profile(
        viewer_user_id="viewer",
        public_person_ref=person_ref,
        catalog_page=7,
        catalog_revision=page["scopeCatalog"]["catalogRevision"],
    )
    assert professional in {item["scopeRef"] for item in tail_page["requestableScopes"]}
    assert (
        service.resolve_scope_refs(
            viewer_user_id="viewer", public_person_ref=person_ref, scope_refs=[professional]
        )[1][0]["scopeRef"]
        == professional
    )


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


@pytest.mark.asyncio
async def test_viewer_profile_exposes_export_revision_as_metadata_for_grants() -> None:
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
            [{"request_id": "request-1", "bundle_id": "bundle-older-than-history-limit"}],
            [],
            [],
            [],
        ]
    )
    db = SimpleNamespace(execute_raw=lambda *_args, **_kwargs: SimpleNamespace(data=next(rows)))
    service = PersonProfileService(connections=_Connections(), consent_db=_ConsentWithGrant())
    with patch("hushh_mcp.services.person_profile_service.get_db", lambda: db):
        payload = await service.get_viewer_profile(
            viewer_user_id="viewer",
            public_person_ref="11111111-1111-4111-8111-111111111111",
        )
    assert payload["grants"][0]["exportRevision"] == 7
    assert payload["grants"][0]["bundleId"] == "bundle-older-than-history-limit"


class _ConsentWithHistory(_Consent):
    """Ledger stub: each request id resolves to a fixed latest action."""

    def __init__(self, latest_by_request: dict[str, str | None]) -> None:
        self._latest_by_request = latest_by_request

    async def get_request_status(self, _subject_user_id: str, request_id: str):
        action = self._latest_by_request.get(request_id)
        if action is None:
            return None
        return {"action": action, "expires_at": None}


class _ConsentWithBatchedHistory(_ConsentWithHistory):
    def __init__(self, latest_by_request: dict[str, str | None]) -> None:
        super().__init__(latest_by_request)
        self.batch_calls = 0
        self.single_calls = 0

    async def get_request_statuses(self, _subject_user_id: str, request_ids: list[str]):
        self.batch_calls += 1
        return {
            request_id: {"action": action, "expires_at": None}
            for request_id in request_ids
            if (action := self._latest_by_request.get(request_id)) is not None
        }

    async def get_request_status(self, _subject_user_id: str, request_id: str):
        self.single_calls += 1
        return await super().get_request_status(_subject_user_id, request_id)


def _request_row(request_id: str, *, cancelled_at: str | None = None) -> dict:
    return {
        "bundle_id": "bundle-1",
        "purpose": "Verify identity",
        "duration_seconds": 3600,
        "created_at": "2026-09-14T00:00:00+00:00",
        "cancelled_at": cancelled_at,
        "request_id": request_id,
        "scope_ref": "psr_abc",
        "label": "Legal name",
        "sensitivity": "sensitive",
    }


@pytest.mark.asyncio
async def test_viewer_profile_batches_request_status_reads() -> None:
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
            [_request_row("request-1"), _request_row("request-2")],
            [],
            [],
        ]
    )
    db = SimpleNamespace(execute_raw=lambda *_args, **_kwargs: SimpleNamespace(data=next(rows)))
    consent = _ConsentWithBatchedHistory({"request-1": "REQUESTED", "request-2": "CONSENT_DENIED"})
    service = PersonProfileService(connections=_Connections(), consent_db=consent)
    with patch("hushh_mcp.services.person_profile_service.get_db", lambda: db):
        payload = await service.get_viewer_profile(
            viewer_user_id="viewer",
            public_person_ref="11111111-1111-4111-8111-111111111111",
        )
    assert [item["status"] for item in payload["requestHistory"]] == ["pending", "denied"]
    assert consent.batch_calls == 1
    assert consent.single_calls == 0


@pytest.mark.asyncio
async def test_viewer_request_history_reports_a_withdrawn_request_as_cancelled() -> None:
    """A CANCELLED ledger row is its own state, never "pending" or "denied".

    Also covers the bundle-only fallback: a row stamped cancelled_at whose
    ledger never recorded the withdrawal reads the same way.
    """
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
            [
                _request_row("req-cancelled"),
                _request_row("req-stamped-only", cancelled_at="2026-09-14T01:00:00+00:00"),
                _request_row("req-denied"),
                _request_row("req-pending"),
            ],
            [],
            [],
        ]
    )
    db = SimpleNamespace(execute_raw=lambda *_args, **_kwargs: SimpleNamespace(data=next(rows)))
    consent = _ConsentWithHistory(
        {
            "req-cancelled": "CANCELLED",
            "req-stamped-only": "REQUESTED",
            "req-denied": "CONSENT_DENIED",
            "req-pending": "REQUESTED",
        }
    )
    service = PersonProfileService(connections=_Connections(), consent_db=consent)
    with patch("hushh_mcp.services.person_profile_service.get_db", lambda: db):
        payload = await service.get_viewer_profile(
            viewer_user_id="viewer",
            public_person_ref="11111111-1111-4111-8111-111111111111",
        )

    by_request = {item["requestId"]: item["status"] for item in payload["requestHistory"]}
    assert by_request == {
        "req-cancelled": "cancelled",
        "req-stamped-only": "cancelled",
        "req-denied": "denied",
        "req-pending": "pending",
    }


@pytest.mark.asyncio
async def test_scope_catalog_search_finds_food_for_restaurant_and_pages_the_rest(monkeypatch):
    """Contract C4: the Change picker searches on the server, with synonyms.

    UAT 2026-09-28: "restaurant" matched nothing because search covered only the
    100 loaded rows, and rows read "Preferences Entities Entities Summary".
    """
    from hushh_mcp.services.person_profile_service import _scope_ref

    person_ref = "11111111-1111-4111-8111-111111111111"
    entries = [
        {
            "scope": "attr.food.preferences.entities.entities.summary",
            "domain": "food",
            "label": "Preferences Entities Entities Summary",
        },
        {"scope": "attr.health.fitness_goals.*", "domain": "health", "label": "Fitness Goals"},
        {"scope": "attr.food.*", "domain": "food", "label": "Food Domain", "wildcard": True},
    ] + [
        {
            "scope": f"attr.professional.field_{index:02d}",
            "domain": "professional",
            "label": f"Project {index:02d}",
        }
        for index in range(25)
    ]
    service = PersonProfileService(
        connections=SimpleNamespace(get_exact_requestable_scope_entries=lambda *_args: entries),
        consent_db=_Consent(),
    )
    monkeypatch.setattr(
        service,
        "_profile_row",
        lambda _ref: {"user_id": "subject", "public_person_ref": person_ref, "display_name": "K"},
    )

    found = await service.search_scope_catalog(
        viewer_user_id="viewer", public_person_ref=person_ref, query="favorite restaurant"
    )
    assert [item["label"] for item in found["items"]] == [
        "Food preferences",
        "Food & dining information",
    ]
    assert found["items"][0]["why"] == '"restaurant" relates to food & dining'
    assert found["items"][0]["scopeRef"] == _scope_ref(
        person_ref, "attr.food.preferences.entities.entities.summary"
    )
    # ``scope`` is the same opaque ref; the raw scope never leaves the server.
    assert found["items"][0]["scope"] == found["items"][0]["scopeRef"]
    assert "attr." not in str(found)
    assert found["totalCount"] == 2

    pages, page, revision = [], 1, ""
    while page:
        result = await service.search_scope_catalog(
            viewer_user_id="viewer",
            public_person_ref=person_ref,
            page=page,
            limit=10,
            catalog_revision=revision,
        )
        pages.append(result)
        revision, page = result["catalogRevision"], result["nextPage"]
    assert [len(result["items"]) for result in pages] == [10, 10, 8]
    assert [result["hasMore"] for result in pages] == [True, True, False]
    assert len({item["scopeRef"] for result in pages for item in result["items"]}) == 28
    assert {"domain": "food", "count": 2, "label": "Food & dining"} in pages[0]["domains"]

    # A person cannot open their own catalog as a viewer.
    with pytest.raises(PersonProfileNotFoundError):
        await service.search_scope_catalog(viewer_user_id="subject", public_person_ref=person_ref)


@pytest.mark.asyncio
async def test_the_catalog_a_person_reads_has_no_schema_fields_app_state_or_duplicates(
    monkeypatch,
):
    """Localhost run 2026-09-28: "restaurant" listed Kind, Food status, Observations,
    "Food preferences" twice, and elsewhere "Canonical V2 parse fallback".

    Presentation only: every hidden row stays requestable by reference, so an
    earlier request naming one still validates.
    """
    from hushh_mcp.consent.scope_labels import human_scope_label
    from hushh_mcp.services.person_profile_service import _scope_ref

    person_ref = "11111111-1111-4111-8111-111111111111"
    stored = "Preferences Entities Entities {}"
    entries = [
        {"scope": "attr.food.*", "domain": "food", "label": "Food Domain", "wildcard": True},
        {
            "scope": "attr.food.preferences.*",
            "domain": "food",
            "label": "Preferences",
            "wildcard": True,
        },
        *(
            {
                "scope": f"attr.food.preferences.entities._entities.{field}",
                "domain": "food",
                "label": stored.format(field.title()),
            }
            for field in ("kind", "status", "summary")
        ),
        {
            "scope": "attr.food.preferences.observations._items",
            "domain": "food",
            "label": "Observations",
        },
        {
            "scope": "attr.food.dietary_constraints.*",
            "domain": "food",
            "label": "Dietary Constraints",
            "wildcard": True,
        },
        {
            "scope": "attr.financial.canonical_v2.parse_fallback",
            "domain": "financial",
            "label": "Canonical V2 Parse Fallback",
        },
    ]
    # Negative control: the stored catalog alone repeats a label.
    raw_labels = [
        human_scope_label(entry["scope"], entry["label"])
        for entry in entries
        if entry["domain"] == "food"
    ]
    assert raw_labels.count("Food preferences") == 3

    service = PersonProfileService(
        connections=SimpleNamespace(get_exact_requestable_scope_entries=lambda *_args: entries),
        consent_db=_Consent(),
    )
    monkeypatch.setattr(
        service,
        "_profile_row",
        lambda _ref: {"user_id": "subject", "public_person_ref": person_ref, "display_name": "K"},
    )
    catalog = await service.get_requestable_catalog(
        viewer_user_id="viewer", public_person_ref=person_ref
    )
    found = await service.search_scope_catalog(
        viewer_user_id="viewer", public_person_ref=person_ref, query="favorite restaurant"
    )
    for labels in (
        [item["label"] for item in catalog["requestableScopes"]],
        [item["label"] for item in found["items"]],
    ):
        assert len(labels) == len(set(labels))
        assert not any(
            word in label.lower()
            for label in labels
            for word in ("kind", "status", "observations", "fallback")
        )
    assert found["items"][0]["label"] == "Food preferences"
    assert found["items"][0]["scopeRef"] == _scope_ref(person_ref, "attr.food.preferences.*")

    hidden = _scope_ref(person_ref, "attr.food.preferences.entities._entities.kind")
    _row, resolved = service.resolve_scope_refs(
        viewer_user_id="viewer", public_person_ref=person_ref, scope_refs=[hidden]
    )
    assert resolved[0]["scope"] == "attr.food.preferences.entities._entities.kind"
