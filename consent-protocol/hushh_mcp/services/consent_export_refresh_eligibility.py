"""Internal owner refresh eligibility; canonical consent storage owns admission."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol

from hushh_mcp.consent.pkm_scope_policy import is_source_library_pkm_scope
from hushh_mcp.consent.scope_helpers import scope_matches


class RefreshManifest(Protocol):
    @property
    def top_level_scope_paths(self) -> Iterable[object]: ...

    @property
    def externalizable_paths(self) -> Iterable[object]: ...


async def continuous_refresh_tokens_for_domain_write(
    *, user_id: str, domain: str, manifest: RefreshManifest
) -> list[str]:
    """Select v2 continuous exports from the canonical internal candidate query.

    Staged paid terms remain owner refresh inputs before activation; this
    operation neither publishes an export nor grants requester access.
    """
    if is_source_library_pkm_scope(f"attr.{domain}.*"):
        return []
    from hushh_mcp.services.consent_db import ConsentDBService

    consent_service = ConsentDBService()
    active_tokens = await consent_service.get_continuous_refresh_candidates_for_domain(
        user_id, domain
    )
    candidate_scopes = {f"attr.{domain}.*"}
    candidate_scopes.update(
        f"attr.{domain}.{path}.*"
        for path in manifest.top_level_scope_paths
        if isinstance(path, str) and path.strip()
    )
    candidate_scopes.update(
        f"attr.{domain}.{path}"
        for path in manifest.externalizable_paths
        if isinstance(path, str) and path.strip()
    )
    candidate_scopes.add("pkm.read")
    refresh_tokens: list[str] = []
    for token in active_tokens:
        granted_scope = str(token.get("scope") or "").strip()
        consent_token = str(token.get("token_id") or "").strip()
        if not granted_scope or not consent_token:
            continue
        if not any(scope_matches(granted_scope, candidate) for candidate in candidate_scopes):
            continue
        metadata = token.get("_refresh_metadata") or (
            await consent_service.get_consent_export_metadata(consent_token)
        )
        if (
            metadata
            and metadata.get("is_strict_zero_knowledge")
            and metadata.get("refresh_policy") == "continuous_until_expiry"
            and int(metadata.get("envelope_version") or 1) == 2
            and str(metadata.get("scope_handle") or "").strip()
        ):
            refresh_tokens.append(consent_token)
    return sorted(set(refresh_tokens))
