"""
Dry-run verification for Bug #408 fix.
Mirrors the 5 tests shown in the GitHub issue screenshots.
Writes results to bug408_results.log (UTF-8).
"""
import builtins
import os
import sys
import types

sys.path.insert(0, os.path.dirname(__file__))

# Minimal env setup BEFORE any hushh_mcp imports
os.environ["APP_SIGNING_KEY"] = "test-signing-key-dryrun-must-be-at-least-32-chars-long"
os.environ["VAULT_DATA_KEY"] = "a" * 64  # 64-char hex string (256-bit AES key)
os.environ["TESTING"] = "true"

# Mock DB drivers so tests work without real DB infrastructure


for mod_name in ["asyncpg", "psycopg2", "psycopg2.extras", "psycopg2.extensions", "psycopg"]:
    if mod_name not in sys.modules:
        mock = types.ModuleType(mod_name)
        sys.modules[mod_name] = mock

# psycopg2.extras needs a Json adapter stub (used by db_client.py)
_extras = sys.modules["psycopg2.extras"]
if not hasattr(_extras, "Json"):
    _extras.Json = lambda obj: obj  # type: ignore[attr-defined]

LOG_FILE = os.path.join(os.path.dirname(__file__), "bug408_results.log")
log = open(LOG_FILE, "w", encoding="utf-8")

results = []

def out(msg=""):
    log.write(msg + "\n")
    log.flush()

def check(label, ok, detail=""):
    tag = "[PASS]" if ok else "[FAIL]"
    out(f"{tag} {label}")
    if detail:
        out(f"       {detail}")
    results.append(ok)

out("=" * 60)
out(" Bug #408 Dry-Run - 5 Tests")
out("=" * 60)

# -- TEST 1 --
out("\n[TEST 1] ConsentScope.AGENT_KAI_EXECUTE exists")
try:
    from hushh_mcp.constants import ConsentScope
    val = ConsentScope.AGENT_KAI_EXECUTE
    check("AGENT_KAI_EXECUTE attribute exists", True, f"value = '{val.value}'")
except AttributeError as e:
    check("AGENT_KAI_EXECUTE attribute exists", False, str(e))

# -- TEST 2 --
out("\n[TEST 2] ConsentScope('agent.kai.execute') resolves without error")
try:
    from hushh_mcp.constants import ConsentScope
    scope = ConsentScope("agent.kai.execute")
    check("ConsentScope('agent.kai.execute') resolves", True, f"-> {scope}")
except ValueError as e:
    check("ConsentScope('agent.kai.execute') resolves", False, str(e))

# -- TEST 3 --
out("\n[TEST 3] resolve_scope_to_enum('agent.kai.execute') returns correct enum")
try:
    from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum
    from hushh_mcp.constants import ConsentScope
    result = resolve_scope_to_enum("agent.kai.execute")
    correct = result == ConsentScope.AGENT_KAI_EXECUTE
    wrong_scope = result == ConsentScope.AGENT_KAI_ANALYZE
    if correct:
        check("Returns AGENT_KAI_EXECUTE (not AGENT_KAI_ANALYZE)", True, f"-> {result}")
    elif wrong_scope:
        check("Returns AGENT_KAI_EXECUTE (not AGENT_KAI_ANALYZE)", False,
              "BUG: silently returned AGENT_KAI_ANALYZE - privilege escalation")
    else:
        check("Returns AGENT_KAI_EXECUTE (not AGENT_KAI_ANALYZE)", False, f"Unexpected: {result}")
except Exception as e:
    check("Returns AGENT_KAI_EXECUTE (not AGENT_KAI_ANALYZE)", False, f"Raised: {e}")

# -- TEST 4 --
out("\n[TEST 4] get_scope_display_metadata('agent.kai.execute') + enum round-trip")
try:
    from hushh_mcp.consent.scope_helpers import get_scope_display_metadata
    from hushh_mcp.constants import ConsentScope
    meta = get_scope_display_metadata("agent.kai.execute")
    scope_str = "agent.kai.execute"
    enum_val = ConsentScope(scope_str)
    check("Display metadata + enum round-trip works", True,
          f"label='{meta['label']}', enum='{enum_val}'")
except Exception as e:
    check("Display metadata + enum round-trip works", False, str(e))

# -- TEST 5 --
out("\n[TEST 5] validate_token() with agent.kai.execute scope returns (True, ..., payload)")
try:
    from hushh_mcp.consent.token import issue_token, validate_token
    from hushh_mcp.constants import ConsentScope

    token_obj = issue_token(
        user_id="user_test",
        agent_id="agent_kai",
        scope=ConsentScope.AGENT_KAI_EXECUTE,
    )
    valid, reason, payload = validate_token(token_obj.token)
    if valid and payload is not None:
        check("validate_token returns (True, None, payload)", True,
              f"scope_str='{payload.scope_str}'")
    else:
        check("validate_token returns (True, None, payload)", False,
              f"valid={valid}, reason='{reason}'")
except Exception as e:
    check("validate_token returns (True, None, payload)", False, f"Exception: {e}")

# -- SUMMARY --
out("\n" + "=" * 60)
passed = sum(results)
total = len(results)
out(f" Result: {passed}/{total} tests passed")
if passed == total:
    out(" ALL TESTS PASSED - Bug #408 is fixed.")
else:
    out(f" {total - passed} test(s) FAILED - fix incomplete.")
out("=" * 60)

log.close()

# Also print the log file path so the user knows where to look

builtins.print(f"Results written to: {LOG_FILE}")
