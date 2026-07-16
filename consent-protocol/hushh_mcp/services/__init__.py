# hushh_mcp/services/__init__.py
"""Service-layer public exports.

Keep package import free of database and vault configuration side effects.  A
number of callers import a narrow service module (including the synthetic PKM
evaluator); eagerly importing the legacy database services here would make
that narrow operation require unrelated runtime keys.
"""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .consent_db import ConsentDBService
    from .investor_db import InvestorDBService
    from .vault_db import VaultDBService
    from .vault_keys_service import VaultKeysService

__all__ = [
    "VaultDBService",
    "ConsentDBService",
    "InvestorDBService",
    "VaultKeysService",
]

_EXPORT_MODULES = {
    "ConsentDBService": ".consent_db",
    "InvestorDBService": ".investor_db",
    "VaultDBService": ".vault_db",
    "VaultKeysService": ".vault_keys_service",
}


def __getattr__(name: str) -> Any:
    """Resolve legacy package exports only when a caller asks for one."""
    module_name = _EXPORT_MODULES.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module_name, __name__), name)
    globals()[name] = value
    return value
