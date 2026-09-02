"""Domain-aware policy for PKM branches and scopes that may leave the vault.

This policy is deliberately independent of manifest freshness.  It protects
newly structured PKM, legacy manifest rows, already-issued grants and direct
export retrieval with the same small decision function.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.domain_contracts import (
    DOMAIN_SHARING_POLICY_REGISTRY,
    get_domain_sharing_policy,
    is_owner_managed_reserved_domain,
)


def normalize_pkm_scope(scope: str | None) -> tuple[str, str]:
    """Return ``(domain, path)`` for an ``attr.*`` scope without wildcards."""
    parts = [part.strip().lower() for part in str(scope or "").split(".") if part.strip()]
    if len(parts) < 2 or parts[0] != "attr":
        return "", ""
    domain = parts[1]
    path = ".".join(part for part in parts[2:] if part != "*")
    return domain, path


def is_source_library_pkm_scope(scope: str | None) -> bool:
    """Whether ``scope`` addresses the reserved Source Library PKM domain."""

    domain, _path = normalize_pkm_scope(scope)
    return domain == "source_library"


def is_reserved_domain_scope(scope: str | None) -> bool:
    """Whether an ``attr.*`` scope addresses an owner-managed reserved PKM domain.

    Reserved domains (``source_library``, ``payment_cards``) are protocol-owned:
    natural-language structuring must never invent or repurpose them, and
    consent surfaces render them with an explicit reserved indicator so a
    reserved grant is never mistaken for an ordinary dynamic-domain grant.
    """

    domain, _path = normalize_pkm_scope(scope)
    return bool(domain) and is_owner_managed_reserved_domain(domain)


def consent_token_scope_value(token_obj: Any) -> str:
    """Return the signed scope string from a parsed consent token.

    Dynamic ``attr.*`` tokens retain their real authority in ``scope_str`` but
    expose ``PKM_READ`` through the legacy typed ``scope`` field.  Policy gates
    must therefore never stringify the enum field directly.
    """

    scope_str = str(getattr(token_obj, "scope_str", "") or "").strip()
    if scope_str:
        return scope_str
    scope = getattr(token_obj, "scope", "")
    return str(getattr(scope, "value", scope) or "").strip()


def _path_matches_prefix(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(f"{prefix}.")


def is_externalizable_pkm_manifest_path(*, domain: str | None, path: str | None) -> bool:
    """Whether a manifest leaf may participate in a scoped encrypted export."""

    normalized_domain = str(domain or "").strip().lower()
    normalized_path = str(path or "").strip().lower().strip(".")
    if not normalized_domain or not normalized_path:
        return False

    policy = get_domain_sharing_policy(normalized_domain)
    allowed_prefixes = policy.allowed_manifest_path_prefixes
    if allowed_prefixes is not None and not any(
        _path_matches_prefix(normalized_path, prefix) for prefix in allowed_prefixes
    ):
        return False
    if any(
        _path_matches_prefix(normalized_path, prefix)
        for prefix in policy.denied_manifest_path_prefixes
    ):
        return False
    path_parts = frozenset(part for part in normalized_path.split(".") if part)
    if path_parts.intersection(policy.denied_manifest_path_parts):
        return False
    return True


def is_external_requestable_pkm_scope(scope: str | None) -> bool:
    """Whether an exact ``attr.*`` scope may be requested or delivered."""

    raw_parts = [part.strip().lower() for part in str(scope or "").split(".") if part.strip()]
    if len(raw_parts) < 2 or raw_parts[0] != "attr":
        return False
    domain, path = normalize_pkm_scope(scope)
    policy = get_domain_sharing_policy(domain)

    if policy.requestable_scopes is not None:
        return ".".join(raw_parts) in policy.requestable_scopes
    if not path:
        return policy.allow_domain_wildcard
    return is_externalizable_pkm_manifest_path(domain=domain, path=path)


def is_public_pkm_projection_allowed(domain: str | None) -> bool:
    """Whether a domain may publish a separate owner-approved public projection."""

    return get_domain_sharing_policy(str(domain or "")).allow_public_projection


def is_private_pkm_export_scope(scope: str | None) -> bool:
    """Whether an encrypted PKM scope is retired from external delivery.

    ``attr.financial.*`` is intentionally retired too: an older broad export
    can contain analysis-history source artifacts even when its current
    manifest has since been corrected.  Narrow financial branches remain
    requestable when materialized and consented.
    """
    domain, _path = normalize_pkm_scope(scope)
    if domain not in DOMAIN_SHARING_POLICY_REGISTRY:
        return False
    return not is_external_requestable_pkm_scope(scope)


def is_private_pkm_manifest_path(*, domain: str | None, path: str | None) -> bool:
    """Path form of :func:`is_private_pkm_export_scope` for manifest walkers."""
    normalized_domain = str(domain or "").strip().lower()
    normalized_path = str(path or "").strip().lower().strip(".")
    if normalized_domain not in DOMAIN_SHARING_POLICY_REGISTRY:
        return False
    if not normalized_path:
        return False
    return not is_externalizable_pkm_manifest_path(
        domain=normalized_domain,
        path=normalized_path,
    )
