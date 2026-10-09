"""Keep rendered request capacity and retained-turn qualification consistent."""

from typing import Any


def qualified_request_spec(container: dict[str, Any], cpu_millis: int) -> dict[str, Any]:
    slots = 1 if cpu_millis < 1000 else 8
    container["env"].append({"name": "HUSSH_POD_REQUEST_CONCURRENCY", "value": str(slots)})
    return {"containers": [container], "containerConcurrency": slots}
