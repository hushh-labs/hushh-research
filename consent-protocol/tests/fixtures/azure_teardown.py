"""Bounded synthetic deleted-resource API bodies, with an excluded recovery handle."""

from hushh_mcp.services.azure_setup_plan import tags

CREATED = "2026-10-01T00:00:00Z"
DELETED = "2026-10-15T00:00:00Z"
PURGE = "2027-01-13T00:00:00Z"


def retention_body(inputs, path, deleted_path):
    return {
        "id": deleted_path,
        "location": inputs.location,
        "tags": tags(inputs),
        "properties": {
            "location": inputs.location,
            "vaultId": path,
            "tags": tags(inputs),
            "purgeProtectionEnabled": True,
            "deletionDate": DELETED,
            "scheduledPurgeDate": PURGE,
            "storageAccountResourceId": path,
            "creationTime": CREATED,
            "deletionTime": DELETED,
            "restoreReference": "synthetic-private-recovery-handle",
        },
    }
