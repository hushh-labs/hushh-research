"""Static deletion inventory over the canonical account and connector erasure graph."""

import ast
import re


def delete_targets(backend_root, erasure_methods, connector_erasers, string_constants) -> set[str]:
    """Tables named by a DELETE anywhere in the full-account erasure path."""
    source = (backend_root / "hushh_mcp/services/account_service.py").read_text(encoding="utf-8")
    account_service = next(
        node
        for node in ast.parse(source).body
        if isinstance(node, ast.ClassDef) and node.name == "AccountService"
    )
    methods = {
        node.name: node
        for node in account_service.body
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    }
    # Keys of the whitelisted per-table delete queries resolve to their SQL.
    keyed_sql: dict[str, str] = {}
    for node in ast.walk(methods["__init__"]):
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values, strict=True):
                if isinstance(key, ast.Constant) and isinstance(value, ast.Call):
                    keyed_sql[key.value] = keyed_sql.get(key.value, "") + " ".join(
                        string_constants(value)
                    )
    fragments: list[str] = []
    for method in erasure_methods:
        for constant in string_constants(methods[method]):
            fragments.append(constant)
            fragments.append(keyed_sql.get(constant, ""))
    for drive_path, drive_functions in connector_erasers:
        drive_tree = ast.parse((backend_root / drive_path).read_text(encoding="utf-8"))
        for node in drive_tree.body:
            if isinstance(node, ast.FunctionDef) and node.name in drive_functions:
                fragments.extend(string_constants(node))
    return {
        name.lower() for name in re.findall(r"\bDELETE\s+FROM\s+(\w+)", "\n".join(fragments), re.I)
    }
