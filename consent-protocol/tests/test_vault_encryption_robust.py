"""Security enforcement tests for PR 3502 — vault encryption docs."""

import os

HUSHH_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VAULT_DOC = os.path.join(HUSHH_ROOT, "docs", "guides", "vault-encryption-explained.md")


def _r(p):
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def test_vault_doc_exists():
    assert os.path.exists(VAULT_DOC)


def test_vault_doc_has_encryption_info():
    assert any(k in _r(VAULT_DOC).lower() for k in ["encrypt", "aes", "key", "cipher"])


def test_vault_doc_has_key_rotation():
    assert any(k in _r(VAULT_DOC).lower() for k in ["rotat", "refresh", "renew", "cycle"])


def test_vault_doc_has_access_control():
    assert any(
        k in _r(VAULT_DOC).lower() for k in ["access", "consent", "scope", "auth", "permission"]
    )


def test_vault_doc_not_empty():
    assert len(_r(VAULT_DOC).strip()) > 300
