"""Generates scope_matches() golden vectors from the real Python implementation.

scope_matches() (hushh_mcp/consent/scope_helpers.py) delegates to
DynamicScopeGenerator.is_dynamic_scope/parse_scope/matches_wildcard
(hushh_mcp/consent/scope_generator.py), all of which are pure string parsing
-- no DB access despite the generator class owning a lazy `self.supabase`
property. That property is never touched by this call path, so generating
vectors here does not require live Supabase credentials.

Run with the backend's own venv:

    cd hushh-desktop/windows-daemon
    ../backend/.venv/Scripts/python.exe scripts/generate_scope_golden_vectors.py
"""

import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from hushh_mcp.consent.scope_helpers import scope_matches  # noqa: E402

cases = [
    # (name, granted, requested, expected)
    ("exact_static_match", "vault.owner", "vault.owner", True),
    ("exact_dynamic_match", "attr.financial.holdings", "attr.financial.holdings", True),
    ("vault_owner_grants_dynamic", "vault.owner", "attr.financial.holdings", True),
    ("vault_owner_grants_static", "vault.owner", "agent.kai.chat", True),
    ("pkm_read_grants_dynamic", "pkm.read", "attr.financial.holdings", True),
    ("pkm_read_grants_dynamic_wildcard", "pkm.read", "attr.financial.*", True),
    ("pkm_read_does_not_grant_static", "pkm.read", "agent.kai.chat", False),
    ("domain_wildcard_grants_specific", "attr.financial.*", "attr.financial.holdings", True),
    ("domain_wildcard_grants_nested_path", "attr.financial.*", "attr.financial.profile.risk_score", True),
    ("domain_wildcard_blocks_other_domain", "attr.financial.*", "attr.food.groceries", False),
    ("domain_wildcard_matches_itself", "attr.financial.*", "attr.financial.*", True),
    ("subintent_wildcard_grants_child", "attr.financial.profile.*", "attr.financial.profile.risk_score", True),
    ("subintent_wildcard_grants_itself", "attr.financial.profile.*", "attr.financial.profile.*", True),
    ("subintent_wildcard_blocks_sibling", "attr.financial.profile.*", "attr.financial.holdings", False),
    ("subintent_wildcard_blocks_parent_domain_wildcard", "attr.financial.profile.*", "attr.financial.*", False),
    ("specific_path_does_not_grant_sibling", "attr.financial.holdings", "attr.financial.expenses", False),
    ("specific_path_does_not_grant_domain_wildcard", "attr.financial.holdings", "attr.financial.*", False),
    ("domain_level_no_wildcard_does_not_grant_child", "attr.financial", "attr.financial.holdings", False),
    ("static_to_static_mismatch", "agent.kai.chat", "agent.kai.execute", False),
    ("static_dynamic_cross_type_mismatch", "attr.financial.holdings", "agent.kai.chat", False),
    ("case_normalization_domain_wildcard", "attr.Financial.*", "attr.financial.holdings", True),
    ("case_sensitivity_exact_path_not_normalized", "attr.Financial.Holdings", "attr.financial.holdings", False),
    ("unrelated_dynamic_scopes_no_relation", "attr.food.groceries", "attr.financial.holdings", False),
    ("reverse_direction_not_symmetric", "attr.financial.holdings", "attr.financial.*", False),
]

output = []
for name, granted, requested, expected in cases:
    actual = scope_matches(granted, requested)
    assert actual == expected, f"{name}: scope_matches({granted!r}, {requested!r}) = {actual}, expected {expected}"
    output.append({"name": name, "grantedScope": granted, "requestedScope": requested, "expectedMatches": actual})

out_path = Path(__file__).resolve().parents[1] / "fixtures" / "scope_matches_golden_vectors.json"
out_path.write_text(json.dumps({"cases": output}, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"Wrote {len(output)} scope_matches cases to {out_path}")
