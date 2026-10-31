"""Official Drive MCP configuration is read-only and uses the existing registry."""

from pathlib import Path

from hushh_mcp.services.external_mcp_connector_descriptor import load_and_validate_descriptor


def test_google_drive_descriptor_uses_official_mcp_and_read_only_authority():
    descriptor = load_and_validate_descriptor(
        Path(__file__).parents[1] / "examples/external-connectors/google_drive.json"
    )
    assert descriptor.connector_id == "google_drive"
    assert descriptor.auth_style == "oauth"
    assert descriptor.raw["mcpEndpoint"] == "https://drivemcp.googleapis.com/mcp/v1"
    assert descriptor.raw["oauthScopes"] == ["https://www.googleapis.com/auth/drive.readonly"]
    assert "clientSecret" not in descriptor.raw
    assert "is_active" not in descriptor.raw
