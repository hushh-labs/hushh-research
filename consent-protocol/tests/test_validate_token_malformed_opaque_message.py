"""
Regression test for validate_token()'s malformed-token error message (CWE-209).

Attach point: hushh_mcp/consent/token.py (validate_token)

Bug: the except (ValueError, UnicodeDecodeError, binascii.Error) branch in
validate_token() returned f"Malformed token: {str(e)}", forwarding raw parser
exception text to the caller, while the other two malformed-token branches in
the same function already used the static "Malformed token" message. Fixed
to match: drop the exception text, return the static message everywhere.

Note: an earlier version of this PR also changed _BoundedRevocationCache.add()
to evict the soonest-expiring entry when the size cap is hit. That change is
NOT included here: canonical's docstring and the existing
test_size_cap_does_not_evict_unexpired_revocations (tests/test_token_revocation_cache.py)
make it explicit that revocation entries are deliberately never evicted for
size pressure, only for TTL expiry, because evicting an unexpired revocation
would let a revoked token validate as not-revoked again under cache pressure.
Applying the eviction change would have broken that existing test and
reintroduced a real security regression.
"""

import ast
import pathlib

import pytest

from hushh_mcp.consent.token import validate_token

# ===========================================================================
# validate_token — CWE-209: malformed token reason must not leak exception text
# ===========================================================================


@pytest.mark.parametrize(
    "bad_token",
    [
        "not_a_token",
        "hushh_consent:!!invalid_base64!!.sig",
        "hushh_consent:dGVzdA==.bad_sig",
        "",
        "hushh_consent:",
        "hushh_consent:no_dot_separator",
    ],
)
def test_malformed_token_reason_is_opaque(bad_token):
    """
    validate_token() must return the static string 'Malformed token' for any
    structurally broken token — no exception text must leak into the reason.
    """
    valid, reason, token_obj = validate_token(bad_token)
    assert not valid
    assert token_obj is None

    # Reason must be a single static string with no exception detail embedded
    if reason and reason != "Token has been revoked":
        assert reason in {
            "Malformed token",
            "Invalid token prefix",
            "Token expired",
        }, (
            f"Malformed token reason leaks implementation detail: {reason!r}"
        )
        if reason == "Malformed token":
            # Must not contain a colon followed by exception text
            assert ":" not in reason, (
                f"Reason appears to embed exception text: {reason!r}"
            )


# ===========================================================================
# validate_token — G004 + logging: no f-string loggers remain
# ===========================================================================


REPO_ROOT = pathlib.Path(__file__).parent.parent
TOKEN_PY = REPO_ROOT / "hushh_mcp/consent/token.py"


def test_no_fstring_loggers_in_token_py():
    """AST check: no logger calls use JoinedStr (f-string) as first argument."""
    source = TOKEN_PY.read_text()
    tree = ast.parse(source, filename=str(TOKEN_PY))

    violations = []

    class Visitor(ast.NodeVisitor):
        def visit_Call(self, node):
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr in (
                "debug", "info", "warning", "error", "critical", "exception",
            ):
                if node.args and isinstance(node.args[0], ast.JoinedStr):
                    violations.append(node.lineno)
            self.generic_visit(node)

    Visitor().visit(tree)
    assert violations == [], (
        "hushh_mcp/consent/token.py still has f-string logger calls at lines: "
        + ", ".join(str(n) for n in violations)
    )
