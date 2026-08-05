"""Policy for PKM branches that are private source material, never exports.

This policy is deliberately independent of manifest freshness.  It protects
newly structured PKM, legacy manifest rows, already-issued grants and direct
export retrieval with the same small decision function.
"""

from __future__ import annotations

_PRIVATE_FINANCIAL_PATH_PREFIXES = ("analysis_history",)
_PRIVATE_ARTIFACT_PATH_PARTS = frozenset(
    {
        "agent_votes",
        "debate_transcript",
        "raw_card",
        "stream_diagnostics",
        "transcript",
    }
)


def normalize_pkm_scope(scope: str | None) -> tuple[str, str]:
    """Return ``(domain, path)`` for an ``attr.*`` scope without wildcards."""
    parts = [part.strip().lower() for part in str(scope or "").split(".") if part.strip()]
    if len(parts) < 2 or parts[0] != "attr":
        return "", ""
    domain = parts[1]
    path = ".".join(part for part in parts[2:] if part != "*")
    return domain, path


def is_private_pkm_export_scope(scope: str | None) -> bool:
    """Whether an encrypted PKM scope is retired from external delivery.

    ``attr.financial.*`` is intentionally retired too: an older broad export
    can contain analysis-history source artifacts even when its current
    manifest has since been corrected.  Narrow financial branches remain
    requestable when materialized and consented.
    """
    domain, path = normalize_pkm_scope(scope)
    if domain != "financial":
        return False
    if not path:
        return True
    path_parts = tuple(part for part in path.split(".") if part)
    if any(
        path == prefix or path.startswith(f"{prefix}.")
        for prefix in _PRIVATE_FINANCIAL_PATH_PREFIXES
    ):
        return True
    return any(part in _PRIVATE_ARTIFACT_PATH_PARTS for part in path_parts)


def is_private_pkm_manifest_path(*, domain: str | None, path: str | None) -> bool:
    """Path form of :func:`is_private_pkm_export_scope` for manifest walkers."""
    normalized_domain = str(domain or "").strip().lower()
    normalized_path = str(path or "").strip().lower().strip(".")
    if normalized_domain != "financial":
        return False
    if not normalized_path:
        return False
    return is_private_pkm_export_scope(f"attr.{normalized_domain}.{normalized_path}")
