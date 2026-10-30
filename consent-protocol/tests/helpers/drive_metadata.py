"""Synthetic provider metadata shared by Drive adapter contract cases."""


def metadata(**changes):
    return {
        "id": "selected-file",
        "name": "Synthetic report",
        "mimeType": "text/plain",
        "version": "1",
        "modifiedTime": "2026-09-22T00:00:00Z",
        "size": "14",
        "trashed": False,
        "isAppAuthorized": True,
        "capabilities": {"canDownload": True, "canAccessViaGenAi": True},
        **changes,
    }
