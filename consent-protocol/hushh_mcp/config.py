# hushh_mcp/config.py

import os
import sys

from dotenv import load_dotenv

dotenv_path = os.path.join(os.path.dirname(__file__), "..", ".env")

# Load .env file into environment (override=False means Secret Manager/Cloud Run env vars take precedence)
load_dotenv(dotenv_path=dotenv_path, override=False)

# ==================== Test/CI Detection ====================
#
# Unit tests should not require real secrets. Pytest sets PYTEST_CURRENT_TEST
# for each collected test item, which we can use to enable deterministic defaults.
_IS_TESTING = (
    os.getenv("TESTING", "").strip().lower() == "true"
    or "PYTEST_CURRENT_TEST" in os.environ
    or "pytest" in sys.modules
)

# ==================== Security Keys ====================

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY or len(SECRET_KEY) < 32:
    if _IS_TESTING:
        # 32+ chars; deterministic and safe for tests only.
        SECRET_KEY = "test_secret_key_min_32_chars_long________"
    else:
        raise ValueError("❌ SECRET_KEY must be set in .env and at least 32 characters long")

VAULT_ENCRYPTION_KEY = os.getenv("VAULT_ENCRYPTION_KEY")
if not VAULT_ENCRYPTION_KEY or len(VAULT_ENCRYPTION_KEY) != 64:
    if _IS_TESTING:
        # 64 hex chars (256-bit AES key) for tests only.
        VAULT_ENCRYPTION_KEY = "0" * 64
    else:
        raise ValueError("❌ VAULT_ENCRYPTION_KEY must be a 64-character hex string (256-bit AES key)")

# ==================== Expiration Settings ====================

# Default expiry durations (in milliseconds)
# 7 days
DEFAULT_CONSENT_TOKEN_EXPIRY_MS = int(
    os.getenv("DEFAULT_CONSENT_TOKEN_EXPIRY_MS", 1000 * 60 * 60 * 24 * 7)
)  # 30 days
DEFAULT_TRUST_LINK_EXPIRY_MS = int(
    os.getenv("DEFAULT_TRUST_LINK_EXPIRY_MS", 1000 * 60 * 60 * 24 * 30)
)

# ==================== Environment Info ====================

ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
AGENT_ID = os.getenv("AGENT_ID", "agent_hushh_default")
HUSHH_HACKATHON = os.getenv("HUSHH_HACKATHON", "disabled").lower() == "enabled"

# IMPORTANT (Cloud Run):
# Secret Manager values are commonly stored with a trailing newline. If we pass that
# through to gRPC metadata (Gemini SDK), it can error with "Illegal header value".
_raw_google_api_key = os.getenv("GOOGLE_API_KEY")
GOOGLE_API_KEY = _raw_google_api_key.strip() if _raw_google_api_key else None

# ==================== Defaults Export ====================

__all__ = [
    "SECRET_KEY",
    "VAULT_ENCRYPTION_KEY",
    "DEFAULT_CONSENT_TOKEN_EXPIRY_MS",
    "DEFAULT_TRUST_LINK_EXPIRY_MS",
    "ENVIRONMENT",
    "AGENT_ID",
    "HUSHH_HACKATHON",
    "GOOGLE_API_KEY",
]
