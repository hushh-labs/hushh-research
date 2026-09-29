"""What another person may never ask for, whatever the owner's catalog says.

Contract C4 (consent lifecycle, 2026-09-28): a deny-list of sensitive domains is
never requestable by another person -- ``runtime_secrets``, credentials, keys and
tokens, anything vault- or connector-secret-shaped. Measured on UAT the same day:
"Runtime Secrets" was offered in a person's request catalog.

Why a domain check was missing: path segments already pass through
``is_internal_manifest_path`` (which blocks ``secrets``, ``api_key`` and the like
at any depth), but a domain wildcard such as ``attr.runtime_secrets.*`` has no
path, and ``attr.runtime_secrets.llm.*`` has an innocent one. The domain itself
was never checked. This predicate checks both, and it is applied at the single
point every person-to-person catalog read and request validation passes through
(``ConnectionsService._safe_information_scope_entries``).

Pure and import-safe: no database, no network, so a pod can call it too.
"""

from __future__ import annotations

from hushh_mcp.consent.internal_path_keys import is_internal_manifest_path, is_secret_shaped_key
from hushh_mcp.consent.pkm_scope_policy import normalize_pkm_scope
from hushh_mcp.services.domain_contracts import (
    INTERNAL_ONLY_DOMAIN_SLUGS,
    RESERVED_DYNAMIC_DOMAIN_SLUGS,
    canonical_top_level_domain,
)

# Protocol namespaces and runtime-only domains. Owner-managed reserved domains
# (wallet, source_library) are NOT listed: their own sharing policy decides
# which of their branches may leave, and the path check below still blocks any
# secret-shaped branch of theirs.
DENIED_REQUEST_DOMAINS: frozenset[str] = frozenset(
    {*INTERNAL_ONLY_DOMAIN_SLUGS, *RESERVED_DYNAMIC_DOMAIN_SLUGS}
)


def is_scope_requestable_by_others(scope: str | None) -> bool:
    """Whether another person may ever request this ``attr.*`` scope.

    Fails closed: anything that is not a well-formed ``attr.<domain>`` scope is
    refused. A True here is necessary, never sufficient: the owner's catalog,
    the domain sharing policy and the owner's own approval still apply.
    """
    domain, path = normalize_pkm_scope(scope)
    if not domain:
        return False
    if domain in DENIED_REQUEST_DOMAINS:
        return False
    if canonical_top_level_domain(domain) in DENIED_REQUEST_DOMAINS:
        return False
    if is_secret_shaped_key(domain):
        return False
    if not path:
        return True
    if is_internal_manifest_path(path):
        return False
    return not any(is_secret_shaped_key(segment) for segment in path.split("."))


__all__ = ["DENIED_REQUEST_DOMAINS", "is_scope_requestable_by_others"]
