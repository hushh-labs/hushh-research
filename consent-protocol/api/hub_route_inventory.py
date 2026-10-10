"""Owned connector catalog and parser joined by the one canonical hub classifier."""

CONNECTOR_INVENTORY = """
[CONTENT]
GET /api/connectors/google_drive/picker/native/pending
GET /api/connectors/google_drive/documents
GET /api/connectors/google_drive/searches
GET /api/connectors/google_drive/searches/{job_id}
GET /api/connectors/google_drive/searches/{job_id}/results
GET /api/connectors/google_drive/sharing/bulk
GET /api/connectors/google_drive/sharing/bulk/{share_id}
GET /api/connectors/google_drive/sharing/bulk/{share_id}/files
GET /api/connectors/google_drive/sharing/requests/{request_id}/review
GET /api/connectors/google_drive/sharing/requests/{request_id}/search
GET /api/connectors/google_drive/sharing/requests/{request_id}/search/files
POST /api/connectors/google_drive/documents/select
POST /api/connectors/google_drive/documents/{document_id}/sync
POST /api/connectors/google_drive/live/verify
POST /api/connectors/google_drive/picker/native/confirm
POST /api/connectors/google_drive/picker/native/start
POST /api/connectors/google_drive/picker/session
POST /api/connectors/google_drive/searches
POST /api/connectors/google_drive/sharing/bulk
POST /api/connectors/google_drive/sharing/bulk/{share_id}/approve
POST /api/connectors/google_drive/sharing/bulk/{share_id}/retry
POST /api/connectors/google_drive/sharing/owner-shares
POST /api/connectors/google_drive/sharing/owner-shares/{request_id}/share
POST /api/connectors/google_drive/sharing/owner/compile/stream
POST /api/connectors/google_drive/sharing/queries/{request_id}/allow
POST /api/connectors/google_drive/sharing/queries/{request_id}/share
POST /api/connectors/google_drive/sharing/requests/{request_id}/approve
POST /api/connectors/google_drive/sharing/requests/{request_id}/bulk
POST /api/connectors/google_drive/sharing/requests/{request_id}/prepare
POST /api/connectors/google_drive/sharing/requests/{request_id}/prepare/stream
POST /api/connectors/google_drive/sharing/requests/{request_id}/review/refresh
POST /api/connectors/google_drive/sharing/requests/{request_id}/search
POST /api/connectors/oauth/complete
POST /api/connectors/oauth/complete/web
POST /api/connectors/oauth/native/finalize
POST /api/connectors/{connector_id}/connect/api-key
POST /api/connectors/{connector_id}/connect/oauth/start
POST /api/connectors/{connector_id}/mcp/catalog
POST /api/connectors/{connector_id}/mcp/oauth/begin
POST /api/connectors/{connector_id}/mcp/oauth/complete
POST /api/connectors/{connector_id}/mcp/review
POST /api/connectors/{connector_id}/mcp/verify
[AUTHORITY]
POST /api/connectors/google_drive/documents/{document_id}/processing
POST /api/connectors/google_drive/live/background
POST /api/connectors/google_drive/searches/{job_id}/stop
POST /api/connectors/{connector_id}/mcp/confirm
[NETWORK]
GET /api/connectors/google_drive/sharing/bulk/received
GET /api/connectors/google_drive/sharing/bulk/received/{share_id}/files
GET /api/connectors/google_drive/sharing/queries
GET /api/connectors/google_drive/sharing/queries/{request_id}
GET /api/connectors/google_drive/sharing/requests
GET /api/connectors/google_drive/sharing/requests/by-client/{client_request_id}
GET /api/connectors/google_drive/sharing/requests/{request_id}
GET /api/connectors/google_drive/sharing/requests/{request_id}/context
GET /api/connectors/google_drive/sharing/requests/{request_id}/delivery
GET /api/connectors/google_drive/sharing/requests/{request_id}/delivery/files
GET /api/connectors/google_drive/sharing/requests/{request_id}/payment
GET /api/connectors/google_drive/sharing/rules
POST /api/connectors/google_drive/sharing/bulk/{share_id}/stop
POST /api/connectors/google_drive/sharing/queries
POST /api/connectors/google_drive/sharing/queries/{request_id}/cancel
POST /api/connectors/google_drive/sharing/queries/{request_id}/deny
POST /api/connectors/google_drive/sharing/requests
POST /api/connectors/google_drive/sharing/requests/{request_id}/cancel
POST /api/connectors/google_drive/sharing/requests/{request_id}/decline
POST /api/connectors/google_drive/sharing/requests/{request_id}/payment/checkout
POST /api/connectors/google_drive/sharing/requests/{request_id}/revocation/confirm
POST /api/connectors/google_drive/sharing/requests/{request_id}/revocation/prepare
POST /api/connectors/google_drive/sharing/rules/{rule_id}/revoke
[CONNECTOR_ADMIN]
DELETE /api/connectors/google_drive/documents/{document_id}
GET /api/connectors/google_drive/live/background
GET /api/connectors/google_drive/picker/native/callback
GET /api/connectors/oauth/native/callback
GET /api/connectors/oauth/native/pending
POST /api/connectors/google_drive/picker/native/cancel
POST /api/connectors/{connector_id}/disconnect
POST /api/connectors/{connector_id}/mcp/oauth/cancel
[SUPPORT]
GET /api/connectors
POST /api/connectors/registrations
"""


def parse_inventory(text, RouteClass):
    classes = {}
    pending = {}
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            current = RouteClass(line[1:-1])
            continue
        if current is None:
            raise ValueError(f"route listed before any class: {line}")
        methods, path, *marker = line.split()
        for method in methods.split(","):
            key = (method, path)
            if key in classes:
                raise ValueError(f"route classified twice: {method} {path}")
            classes[key] = current
            if marker:
                if current is not RouteClass.CONTENT or not marker[0].startswith("@pending:"):
                    raise ValueError(f"only a CONTENT route may be pending: {line}")
                pending[key] = marker[0].removeprefix("@pending:")
    return classes, pending
