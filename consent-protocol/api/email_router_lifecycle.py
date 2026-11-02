"""Require the baked Email router before UAT accepts traffic."""

from __future__ import annotations

import asyncio
import logging
import os
import time


async def warm_email_router_for_startup(logger: logging.Logger) -> None:
    environment = os.getenv("HUSHH_DEPLOY_ENV") or os.getenv("ENVIRONMENT") or "local"
    if environment.strip().lower() != "uat":
        return
    if not os.getenv("HUSHH_EMAIL_ROUTER_MODEL_CACHE"):
        raise RuntimeError("The required UAT Email router cache is unavailable")

    from hushh_mcp.services.email_oss.routing import warm_email_router

    started = time.perf_counter()
    try:
        async with asyncio.timeout(45):
            await warm_email_router()
    except Exception as error:
        logger.error("startup.email_router_unavailable reason=%s", type(error).__name__)
        raise RuntimeError("The required UAT Email router could not start") from None
    logger.info(
        "startup.email_router_warmed elapsed_ms=%.0f", (time.perf_counter() - started) * 1000
    )
