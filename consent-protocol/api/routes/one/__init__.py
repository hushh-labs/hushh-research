"""One route package; the shared hub router is composed only when requested.

Private pods import their reviewed leaf routes without loading the unrelated hub
control plane. ``from api.routes.one import router`` keeps the existing hub API.
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import APIRouter

__all__ = ["router"]


def __getattr__(name: str) -> "APIRouter":
    if name != "router":
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from ._hub_router import router

    globals()[name] = router
    return router
