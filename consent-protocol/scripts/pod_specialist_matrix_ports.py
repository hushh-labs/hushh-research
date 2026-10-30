"""Static read-port evidence from the runtime's explicit local bindings."""

from __future__ import annotations

import ast
from pathlib import Path


def read_port_classes(runtime_path: Path, marketplace_port_path: Path) -> list[ast.ClassDef]:
    runtime = ast.parse(runtime_path.read_text(encoding="utf-8"), filename=str(runtime_path))
    classes = [
        node
        for node in runtime.body
        if isinstance(node, ast.ClassDef) and node.name.endswith("ReadPort")
    ]
    for node in runtime.body:
        if not (
            isinstance(node, ast.ImportFrom)
            and node.level == 0
            and node.module == "hushh_mcp.services.pod_marketplace_ports"
        ):
            continue
        exported = ast.parse(
            marketplace_port_path.read_text(encoding="utf-8"),
            filename=str(marketplace_port_path),
        )
        definitions = {
            definition.name: definition
            for definition in exported.body
            if isinstance(definition, ast.ClassDef)
        }
        for alias in node.names:
            if alias.name != "PodMarketplaceReadPort":
                continue
            if alias.asname not in {None, alias.name} or alias.name not in definitions:
                raise ValueError("Marketplace read ports must remain explicit same-name reexports")
            classes.append(definitions[alias.name])
    return classes
