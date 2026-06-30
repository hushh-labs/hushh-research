import os

from hushh_mcp.hushh_adk.manifest import ManifestLoader


def _manifest():
    path = os.path.join(
        os.path.dirname(__file__), "..", "hushh_mcp", "agents", "location", "agent.yaml"
    )
    return ManifestLoader.load(os.path.normpath(path))


def test_prompt_permits_handoff_and_public_links():
    text = _manifest().system_instruction.lower()
    # the new sanctioned paths are described
    assert "public link" in text
    assert "browser" in text or "client" in text
    # still refuses the dangerous patterns
    assert "without owner approval" in text
    assert "notification" in text  # refuses coordinates in notifications
    # never offers unsupported channels
    assert "sms" in text or "email" in text


def test_prompt_still_forbids_agent_returning_coordinates():
    text = _manifest().system_instruction.lower()
    assert "coordinate" in text
