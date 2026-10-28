"""Read-only route auth labels for the service API capability catalog."""

from __future__ import annotations

import ast
from typing import Any


def _endpoint_auth_boundary(route: Any) -> str:
    """Classify only the route's auth boundary, never its request values."""
    dependant = getattr(route, "dependant", None)
    dependencies = getattr(dependant, "dependencies", None) or []
    names = {
        str(getattr(getattr(dependency, "call", None), "__name__", ""))
        for dependency in dependencies
    }
    # These exact placement guards retain the underlying authentication
    # dependency and additionally refuse private owners on hub content routes.
    # This catalog label never admits an owner or binds an executable action.
    if names & {"require_vault_owner_token", "hub_content_owner"}:
        return "vault_owner"
    if names & {"require_firebase_auth", "hub_content_firebase"}:
        return "firebase_auth"
    return "not_declared"


def _source_auth_boundary(node: ast.AST) -> str:
    """Read a declared auth dependency from a route source fallback."""
    names = {child.id for child in ast.walk(node) if isinstance(child, ast.Name)}
    # These exact placement guards retain the underlying authentication
    # dependency and additionally refuse private owners on hub content routes.
    # This catalog label never admits an owner or binds an executable action.
    if names & {"require_vault_owner_token", "hub_content_owner"}:
        return "vault_owner"
    if names & {"require_firebase_auth", "hub_content_firebase"}:
        return "firebase_auth"
    return "not_declared"
