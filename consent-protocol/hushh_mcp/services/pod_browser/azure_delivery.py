"""Browser delivery over the existing owner Files queue and leased-message scaler."""

from __future__ import annotations

import os
import time
from urllib.parse import urlsplit

from hushh_mcp.services.pod_platform import workload_platform
from hushh_mcp.services.pod_queue_transport import OwnerAzureQueue, OwnerQueueRefused

from .contracts import BrowserBinding, BrowserRefused
from .delivery import BrowserDelivery


def browser_queue_url() -> str:
    blob = urlsplit(os.getenv("POD_STORAGE_AZURE_BLOB_URL", ""))
    queue = urlsplit(os.getenv("POD_FILES_AZURE_QUEUE_URL", ""))
    account = blob.netloc.removesuffix(".blob.core.windows.net")
    if (
        workload_platform() != "azure"
        or os.getenv("POD_BROWSER_DELIVERY_MODE") != "owner_files_queue_v1"
        or os.getenv("POD_FILES_ENABLED", "").lower() not in {"1", "true"}
        or blob.scheme != "https"
        or not account
        or blob.netloc != account + ".blob.core.windows.net"
        or blob.path != "/pod"
        or blob.query
        or blob.fragment
        or blob.username
        or queue.scheme != "https"
        or queue.netloc != account + ".queue.core.windows.net"
        or queue.path != "/files-organization"
        or queue.query
        or queue.fragment
        or queue.username
        or not os.getenv("HUSSH_POD_KEY_VAULT_KEY")
    ):
        raise BrowserRefused("BROWSER_TASK_DELIVERY_UNAVAILABLE")
    return queue.geturl()


class AzureBrowserDelivery:
    def require_ready(self) -> None:
        browser_queue_url()

    async def publish(self, binding: BrowserBinding, delivery: BrowserDelivery) -> None:
        self.require_ready()
        if delivery.task_id != binding.task_id or delivery.incarnation != binding.incarnation:
            raise BrowserRefused("BROWSER_TASK_DELIVERY_REFUSED")
        remaining = binding.expires_at - int(time.time())
        if remaining <= 0:
            raise BrowserRefused("BROWSER_AUTHORIZATION_EXPIRED")
        queue = OwnerAzureQueue(browser_queue_url())
        try:
            await queue.send_payload(
                delivery.model_dump(mode="json"), ttl=min(1000, remaining + 40)
            )
        except OwnerQueueRefused:
            raise BrowserRefused("BROWSER_TASK_DELIVERY_UNCONFIRMED") from None
        finally:
            queue.session.close()
        from hushh_mcp.services.pod_files.azure_queue import wake_consumer

        wake_consumer()
