# External connector configurations

These secret-free descriptors use the existing operator-curated connector
registry. A descriptor is not an activated connector or proof of Chat readiness.
Do not insert a second hardcoded provider catalog in the UI.

## Google Drive

`google_drive.json` targets Google's official Streamable HTTP MCP service and
requests read-only Drive access. Provider documentation:
[Configure the Drive MCP server](https://developers.google.com/workspace/drive/api/guides/configure-mcp-server).

Validate and inspect the public tool catalog from `consent-protocol`:

```sh
python scripts/ops/configure_external_mcp_connector.py check examples/external-connectors/google_drive.json
python scripts/ops/configure_external_mcp_connector.py probe examples/external-connectors/google_drive.json
```

The public catalog includes write tools as well as reads. Catalog discovery does
not authorize their execution. Before activation, verify owner-bound OAuth,
registered redirects, encrypted credential storage, refresh and disconnect,
native return handling, and exact tool authorization. Never enable the dormant
generic specialist as an arbitrary tool dispatcher under information-only
authority. Copy/create and onward email delivery require separately reviewed
action authority; document contents cannot supply that authority.

The application adapter `google_drive_mcp_service.py` uses the existing shared
Google connection owner, not a second generic OAuth credential for the same
provider. It pins the official endpoint and rejects tools outside its explicit
read set. The descriptor above remains a public-catalog inspection example: do
not activate it as a generic OAuth row alongside the Google connection.

Read-only Drive connection-management APIs and a shared Google callback API now
use this same credential owner. They expose no private file reads. Current
integration gaps: Chat invocation authority, the Drive sidebar connection caller
and authenticated read acceptance remain open. A neutral browser callback and
read-only native Drive SDK bridge exist, but are not a completed user flow. Google
callback publication now has generation fencing and atomic local transactions;
its provider-side revoke/reauthorization ordering remains unverified. Generic
external OAuth also lacks the full refresh/native lifecycle and is not a
shortcut. The descriptor contains no credentials, automatic activation, or
grant of file-sharing permission.
