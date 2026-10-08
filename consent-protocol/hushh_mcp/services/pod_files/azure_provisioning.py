"""Azure Files installed-configuration readback behind the existing backend."""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.azure_agent_observation import assigned_identity


def require_installation(app: dict[str, Any], *, storage_id: str, identity_id: str) -> None:
    template = (app.get("properties") or {}).get("template") or {}
    containers = template.get("containers") or []
    if len(containers) != 1:
        raise ValueError("Files requires the verified single-worker pod")
    entries = containers[0].get("env") or []
    env = {entry.get("name"): entry.get("value") for entry in entries}
    if len(env) != len(entries):
        raise ValueError("Pod environment contains duplicate settings")
    account = storage_id.rsplit("/", 1)[-1]
    principal, client = assigned_identity(app, identity_id)
    properties = app.get("properties") or {}
    if (
        not principal
        or not client
        or (properties.get("configuration") or {}).get("activeRevisionsMode") != "Single"
        or (template.get("scale") or {}).get("maxReplicas") != 1
    ):
        raise ValueError("Files requires the owner's identity and single-writer configuration")
    expected = {
        "POD_FILES_ENABLED": "true",
        "POD_FILES_AZURE_STORAGE_RESOURCE_ID": storage_id,
        "POD_FILES_AZURE_QUEUE_URL": f"https://{account}.queue.core.windows.net/files-organization",
        "POD_STORAGE_AZURE_BLOB_URL": f"https://{account}.blob.core.windows.net/pod",
        "AZURE_CLIENT_ID": client,
    }
    if any(env.get(key) != value for key, value in expected.items()):
        raise ValueError("Files installation configuration is not verified")
    rules = (template.get("scale") or {}).get("rules") or []
    matching = [rule.get("custom") for rule in rules if rule.get("name") == "files"]
    if matching != [
        {
            "type": "azure-queue",
            "identity": identity_id,
            "metadata": {
                "accountName": account,
                "queueName": "files-organization",
                "queueLength": "1",
                "activationQueueLength": "0",
                "queueLengthStrategy": "all",
            },
        }
    ]:
        raise ValueError("Files queue lifecycle is not verified")
