"""Independent owner-job worker, sharing the scheduler's service boundary."""

import asyncio
import os
import signal

from hushh_mcp.services.public_profile_discovery_service import PublicProfileDiscoveryService


async def main():
    if os.getenv("ONE_PUBLIC_PROFILE_DISCOVERY_ENABLED") != "true":
        raise SystemExit("Profile discovery is disabled")
    if os.getenv("ONE_PUBLIC_PROFILE_FIXTURE_MODE") == "true":
        if (
            os.getenv("DB_HOST") not in {"localhost", "127.0.0.1"}
            or not os.getenv("DB_NAME", "").startswith("hushh_profile_fixture_")
            or os.getenv("DB_UNIX_SOCKET")
        ):
            raise SystemExit("Fixture worker requires an isolated local database")
    stopping = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stopping.set)
    service = PublicProfileDiscoveryService()
    while not stopping.is_set():
        await service.drain(max_jobs=4)
        await service.drain_feed_outbox(max_rows=50)
        try:
            await asyncio.wait_for(stopping.wait(), timeout=2)
        except TimeoutError:
            pass


if __name__ == "__main__":
    asyncio.run(main())
