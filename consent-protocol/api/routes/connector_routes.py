"""Compose connector sharing and its isolated financial/workflow adapters."""

from fastapi import FastAPI

from api.routes import (
    drive_request_payments,
    drive_searches,
    drive_sharing,
    drive_work_drain,
    external_connectors,
    profile_discovery_work_drain,
    scope_commerce,
    scope_commerce_work,
)


def register_connector_routes(app: FastAPI) -> None:
    """Retain canonical router order, authority, prefixes and separate webhooks."""
    for router in (
        external_connectors.router,
        drive_sharing.router,
        drive_request_payments.router,
        drive_request_payments.webhook_router,
        scope_commerce.router,
        scope_commerce.webhook_router,
        scope_commerce_work.router,
        drive_searches.router,
        drive_work_drain.router,
        profile_discovery_work_drain.router,
    ):
        app.include_router(router)
