import asyncio
import importlib.util
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")

spec = importlib.util.spec_from_file_location(
    'kai_tools', Path('mcp_modules/tools/kai_tools.py')
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

async def run():
    cases = [
        ("analyze AAPL",    m.handle_kai_analyze_stock({"symbol": "AAPL"})),
        ("analyze Apple",   m.handle_kai_analyze_stock({"symbol": "Apple"})),
        ("analyze nvidia",  m.handle_kai_analyze_stock({"symbol": "nvidia"})),
        ("missing symbol",  m.handle_kai_analyze_stock({})),
        ("gibberish",       m.handle_kai_analyze_stock({"symbol": "NOTVALID1234567890"})),
        ("dashboard",       m.handle_kai_open_dashboard({})),
        ("import",          m.handle_kai_open_import({})),
        ("history default", m.handle_kai_open_history({})),
        ("history debate",  m.handle_kai_open_history({"tab": "debate"})),
        ("consent",         m.handle_kai_open_consent({})),
        ("profile",         m.handle_kai_open_profile({})),
        ("optimize",        m.handle_kai_open_optimize({})),
        ("home",            m.handle_kai_open_home({})),
        ("back",            m.handle_kai_navigate_back({})),
        ("resume",          m.handle_kai_resume_active_analysis({})),
        ("cancel",          m.handle_kai_cancel_active_analysis({})),
    ]

    all_passed = True
    for label, coro in cases:
        r = await coro
        p = json.loads(r[0].text)
        status = p["status"]
        action = p.get("action_id", "N/A")
        msg = p["message"]
        icon = "OK" if status in {"success", "error"} else "FAIL"
        print(f"[{icon}] {label:<22} status={status:<7} action={action:<30} msg={msg}")
        if icon == "FAIL":
            all_passed = False

    print()
    print("All smoke tests passed" if all_passed else "SOME TESTS FAILED")

asyncio.run(run())
