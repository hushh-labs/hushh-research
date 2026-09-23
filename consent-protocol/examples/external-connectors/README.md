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

The descriptor remains a public-catalog inspection example. It must not be
activated as a generic OAuth row. The retired `/api/one/drive/*` connection
routes are intentionally unavailable; the selected-file Drive connector owns
new connection, read, and sharing authority through the external connector
boundary. The descriptor contains no credentials, automatic activation, or grant
of file-sharing permission.
