"""Security/completeness enforcement tests for PR 3522 - voice agent realtime migration docs."""

import os

HUSHH_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VOICE_GUIDE = os.path.join(HUSHH_ROOT, "docs", "guides", "voice-agent-realtime-migration.md")
CONTRIB = os.path.join(HUSHH_ROOT, "contributing.md")


def _read(p):
    assert os.path.exists(p), f"Missing: {p}"
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def test_voice_migration_guide_exists():
    assert os.path.exists(VOICE_GUIDE)


def test_voice_guide_has_security_section():
    content = _read(VOICE_GUIDE).lower()
    assert any(k in content for k in ["auth", "token", "consent", "permission", "security"]), (
        "Voice migration guide must address auth/consent for realtime connections"
    )


def test_voice_guide_not_empty():
    content = _read(VOICE_GUIDE)
    assert len(content.strip()) > 200, "Voice migration guide must have meaningful content"


def test_contributing_md_exists():
    assert os.path.exists(CONTRIB)


def test_contributing_md_has_content():
    content = _read(CONTRIB)
    assert len(content.strip()) > 100
