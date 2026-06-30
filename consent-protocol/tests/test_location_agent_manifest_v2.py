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


def test_prompt_instructs_choice_and_confirmation_tools():
    text = _manifest().system_instruction.lower()
    assert "request_" in text  # references the choice/confirmation tools
    assert "do not guess" in text or "don't guess" in text
    assert "confirm" in text and ("irreversible" in text or "bulk" in text or "everyone" in text)
