#!/usr/bin/env python3
"""Generate the pod specialist capability matrix from manifests, the declaration
table and facts parsed out of the pod runtime source.

One row per authored ``AgentManifestV2`` manifest. Each row joins three things
that used to live in three heads:

* what the manifest authors (id, parent, status, surfaces, scopes);
* what ``POD_SPECIALIST_EXECUTION`` in ``pod_specialist_runtime.py`` DECLARES
  about running that agent in the owner's pod (executes in the pod, where its
  facts come from, what it may write, who confirms, and why);
* what the source actually DOES, parsed rather than trusted: the registered
  specialists, the ids ``service_for`` accepts, the hub doors and their scopes,
  the tool names One binds, and which pod port reads through the hub.

The matrix carries a ``disagreements`` list. It is empty only when every
declaration matches the derived facts; otherwise the generator refuses to write
(and ``--check`` fails), so the artifact can never be a tidy story that the
runtime contradicts. Hub-owned capabilities stay declared as hub-owned; nothing
here claims a capability is hub-independent because a manifest exists.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
AGENTS_ROOT = ROOT / "hushh_mcp" / "agents"
OUTPUT = REPO_ROOT / "contracts" / "agents" / "pod-specialist-capability-matrix.v1.json"
# Mirrored inside the Docker build context for the same reason the registry is;
# see hushh_mcp/services/generated_contracts.py.
BACKEND_OUTPUT = ROOT / "contracts" / "agents" / "pod-specialist-capability-matrix.v1.json"
OUTPUTS = (OUTPUT, BACKEND_OUTPUT)

RUNTIME_PATH = ROOT / "hushh_mcp" / "services" / "pod_specialist_runtime.py"
DISPATCH_INIT_PATH = ROOT / "hushh_mcp" / "adk_bridge" / "__init__.py"
DOOR_SPECIALIST_PATH = ROOT / "hushh_mcp" / "one_adk" / "pod_data_door_specialist.py"
POD_RELAY_PATH = ROOT / "api" / "routes" / "one" / "pod_relay.py"
POD_SPECIALIST_ROUTE_PATH = ROOT / "api" / "routes" / "one" / "pod_specialist.py"
TEXT_RUNTIME_PATH = ROOT / "hushh_mcp" / "one_adk" / "text_runtime.py"
DELEGATION_PATH = ROOT / "hushh_mcp" / "adk_bridge" / "delegation.py"
LEDGER_PATH = REPO_ROOT / "config" / "pod-completion-ledger.yaml"
LEDGER_ITEM_ID = "specialists-run-in-pod"

sys.path.insert(0, str(ROOT))

from hushh_mcp.hushh_adk.manifest import ManifestLoader  # noqa: E402

INFORMATION_SOURCES = ("pkm_projection", "hub_door", "none", "hub")
WRITE_SCOPES = ("none", "proposal_only", "confirmed_action")
CONFIRMATION_OWNERS = ("owner_browser", "owner", "none", "hub")
DECLARATION_FIELDS = (
    "executes_in_pod",
    "information_source",
    "write_scope",
    "confirmation_owner",
    "why",
)


# --------------------------------------------------------------------------- #
# Facts parsed from source. Parsing, not importing, so the generator reads what
# the file says today and a refactor that moves a constant fails loudly here.
# --------------------------------------------------------------------------- #


def _module(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _literal_assignment(path: Path, name: str) -> Any:
    """The literal value of a module-level ``NAME = <literal>`` assignment."""
    for node in _module(path).body:
        targets: list[ast.expr] = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets = [node.target]
        else:
            continue
        if any(isinstance(target, ast.Name) and target.id == name for target in targets):
            return ast.literal_eval(node.value)
    raise ValueError(f"{path.name} no longer defines a literal {name}")


def declaration_table() -> dict[str, dict[str, Any]]:
    """``POD_SPECIALIST_EXECUTION`` read from source without importing the runtime.

    Importing ``pod_specialist_runtime`` pulls the whole backend configuration
    (signing keys and all) into a generator that only needs a table of words.
    The table is authored as ``_declare(...)`` calls with constant keywords, and
    module-level string constants may stand in for a repeated ``why``; anything
    else is refused so the table stays readable without executing it.
    """
    tree = _module(RUNTIME_PATH)
    constants: dict[str, Any] = {}
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Constant)
        ):
            constants[node.targets[0].id] = node.value.value

    def resolve(expr: ast.expr) -> Any:
        if isinstance(expr, ast.Constant):
            return expr.value
        if isinstance(expr, ast.Name) and expr.id in constants:
            return constants[expr.id]
        if isinstance(expr, ast.Tuple):
            return tuple(resolve(item) for item in expr.elts)
        raise ValueError("POD_SPECIALIST_EXECUTION must be authored from constants")

    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names, value = [node.target.id], node.value
        elif isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        else:
            continue
        if "POD_SPECIALIST_EXECUTION" not in names or not isinstance(value, ast.Dict):
            continue
        table: dict[str, dict[str, Any]] = {}
        for key, item in zip(value.keys, value.values, strict=True):
            agent_id = resolve(key) if key is not None else None
            if not isinstance(agent_id, str):
                raise ValueError("POD_SPECIALIST_EXECUTION keys must be agent id strings")
            if isinstance(item, ast.Call):
                table[agent_id] = {
                    str(keyword.arg): resolve(keyword.value)
                    for keyword in item.keywords
                    if keyword.arg
                }
            elif isinstance(item, ast.Dict):
                table[agent_id] = ast.literal_eval(item)
            else:
                raise ValueError(f"{agent_id}: declaration must be a _declare(...) call")
        return table
    raise ValueError("pod_specialist_runtime.py no longer defines POD_SPECIALIST_EXECUTION")


def registered_specialists() -> list[str]:
    text = DISPATCH_INIT_PATH.read_text(encoding="utf-8")
    return sorted(set(re.findall(r'register_specialist\(\s*"([^"]+)"', text)))


def _function_named(tree: ast.AST, name: str) -> ast.AsyncFunctionDef | ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == name:
            return node
    raise ValueError(f"function {name!r} not found")


def service_for_accepts() -> list[str]:
    """Every agent id ``service_for`` compares against and can therefore serve.

    Reads the ``agent_id == "..."`` branches and the ``agent_id not in {...}``
    refusal set. Anything not named here is refused with the adapter-unavailable
    error, which is the roster the matrix must agree with.
    """
    function = _function_named(_module(RUNTIME_PATH), "service_for")
    accepted: set[str] = set()
    for node in ast.walk(function):
        if not isinstance(node, ast.Compare):
            continue
        if not (isinstance(node.left, ast.Name) and node.left.id == "agent_id"):
            continue
        for comparator in node.comparators:
            try:
                value = ast.literal_eval(comparator)
            except ValueError:
                continue
            if isinstance(value, str):
                accepted.add(value)
            elif isinstance(value, (set, tuple, list, frozenset)):
                accepted.update(item for item in value if isinstance(item, str))
    return sorted(accepted)


def pod_port_hub_reads() -> dict[str, dict[str, Any]]:
    """Per pod port class: whether it reads through the hub, and which doors."""
    ports: dict[str, dict[str, Any]] = {}
    for node in _module(RUNTIME_PATH).body:
        if not isinstance(node, ast.ClassDef) or not node.name.endswith("ReadPort"):
            continue
        doors: set[str] = set()
        reads_hub = False
        for inner in ast.walk(node):
            if isinstance(inner, ast.Call):
                callee = inner.func
                callee_name = (
                    callee.id
                    if isinstance(callee, ast.Name)
                    else callee.attr
                    if isinstance(callee, ast.Attribute)
                    else ""
                )
                if callee_name in {"_hub_read", "read_specialist", "PodHubClient"}:
                    reads_hub = True
                if callee_name in {"_hub_read", "read_specialist"}:
                    # asyncio.to_thread(_hub_read, "door", ...) puts the door second.
                    for arg in inner.args[:2]:
                        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                            doors.add(arg.value)
                            break
                if callee_name == "to_thread":
                    for arg in inner.args:
                        if isinstance(arg, ast.Name) and arg.id == "_hub_read":
                            reads_hub = True
                    for arg in inner.args[1:2]:
                        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                            doors.add(arg.value)
            if isinstance(inner, ast.Name) and inner.id == "PodHubClient":
                reads_hub = True
        ports[node.name] = {"reads_hub": reads_hub, "doors": sorted(doors)}
    return ports


def specialist_door_names() -> dict[str, str]:
    return dict(_literal_assignment(DOOR_SPECIALIST_PATH, "_SPECIALIST_DOOR_NAMES"))


def pod_data_door_names() -> list[str]:
    return list(_literal_assignment(POD_RELAY_PATH, "POD_DATA_DOOR_NAMES"))


def required_door_scopes() -> dict[str, str]:
    return dict(_literal_assignment(POD_SPECIALIST_ROUTE_PATH, "_REQUIRED_SCOPE"))


def specialist_tool_sources() -> dict[str, list[str]]:
    """One's tool name -> (agent id, label), inverted to agent id -> tool names."""
    raw = _literal_assignment(TEXT_RUNTIME_PATH, "_SPECIALIST_TOOL_SOURCES")
    by_agent: dict[str, list[str]] = {}
    for tool_name, (agent_id, _label) in raw.items():
        by_agent.setdefault(agent_id, []).append(tool_name)
    return {agent_id: sorted(tools) for agent_id, tools in sorted(by_agent.items())}


def specialist_a2a_scopes() -> dict[str, str]:
    """``SPECIALIST_A2A_SCOPE_MAP`` as agent id -> scope string, parsed."""
    tree = _module(DELEGATION_PATH)
    for node in tree.body:
        target_names = []
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            target_names = [node.target.id]
            value = node.value
        elif isinstance(node, ast.Assign):
            target_names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            value = node.value
        else:
            continue
        if "SPECIALIST_A2A_SCOPE_MAP" not in target_names or not isinstance(value, ast.Dict):
            continue
        from hushh_mcp.constants import ConsentScope  # noqa: PLC0415

        mapping: dict[str, str] = {}
        for key, item in zip(value.keys, value.values, strict=True):
            if not (isinstance(key, ast.Constant) and isinstance(item, ast.Attribute)):
                continue
            mapping[str(key.value)] = str(getattr(ConsentScope, item.attr).value)
        return mapping
    raise ValueError("SPECIALIST_A2A_SCOPE_MAP not found")


def door_to_agent(
    doors: dict[str, str], scopes: dict[str, str], a2a_scopes: dict[str, str]
) -> dict[str, str]:
    """Which agent each hub door serves: by the door registry first, else by the
    door's required scope matching the specialist's A2A scope."""
    mapping = {door: agent for agent, door in doors.items()}
    for door, scope in scopes.items():
        if door in mapping:
            continue
        for agent_id, agent_scope in a2a_scopes.items():
            if agent_scope == scope:
                mapping[door] = agent_id
    return mapping


def live_evidence() -> dict[str, Any] | None:
    """The ledger's receipt for ``specialists-run-in-pod`` when one is recorded."""
    try:
        import yaml  # noqa: PLC0415
    except ModuleNotFoundError:
        return None
    if not LEDGER_PATH.exists():
        return None
    data = yaml.safe_load(LEDGER_PATH.read_text(encoding="utf-8")) or {}
    for item in data.get("assertions") or []:
        if not isinstance(item, dict) or item.get("id") != LEDGER_ITEM_ID:
            continue
        check = item.get("check") or {}
        artifact = check.get("artifact")
        if not artifact or not (REPO_ROOT / str(artifact)).is_file():
            return None
        return {
            "ledger_item": LEDGER_ITEM_ID,
            "artifact": str(artifact),
            "artifact_sha256": check.get("artifact_sha256"),
            "verified_on": check.get("verified_on"),
        }
    return None


# --------------------------------------------------------------------------- #
# The join and the consistency rules
# --------------------------------------------------------------------------- #


def _manifests() -> list[Any]:
    manifests = []
    for path in sorted(AGENTS_ROOT.glob("*/agent.yaml")):
        manifests.append((path, ManifestLoader.load(str(path))))
    return manifests


def build_matrix(declarations: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    if declarations is None:
        declarations = declaration_table()

    registered = registered_specialists()
    accepted = service_for_accepts()
    ports = pod_port_hub_reads()
    doors = specialist_door_names()
    door_names = pod_data_door_names()
    door_scopes = required_door_scopes()
    tools = specialist_tool_sources()
    a2a_scopes = specialist_a2a_scopes()
    door_agent = door_to_agent(doors, door_scopes, a2a_scopes)
    hub_doors_by_agent: dict[str, set[str]] = {}
    for port in ports.values():
        if not port["reads_hub"]:
            continue
        for door in port["doors"]:
            agent_id = door_agent.get(door)
            if agent_id:
                hub_doors_by_agent.setdefault(agent_id, set()).add(door)

    disagreements: list[str] = []
    for agent_id in sorted(accepted):
        if agent_id not in registered:
            disagreements.append(
                f"{agent_id}: service_for accepts it but no specialist is registered for it"
            )

    manifests = _manifests()
    manifest_ids = {manifest.id for _path, manifest in manifests}
    for declared_id in sorted(declarations):
        if declared_id not in manifest_ids:
            disagreements.append(f"{declared_id}: declared but no manifest authors it")

    rows: list[dict[str, Any]] = []
    for path, manifest in manifests:
        declared = declarations.get(manifest.id)
        derived = {
            "registered_specialist": manifest.id in registered,
            "pod_dispatchable": manifest.id in accepted,
            "hub_doors": sorted(hub_doors_by_agent.get(manifest.id, set())),
            "door": doors.get(manifest.id),
            "door_required_scope": door_scopes.get(doors.get(manifest.id, ""), None),
            "one_tool_names": tools.get(manifest.id, []),
            "a2a_scope": a2a_scopes.get(manifest.id),
        }
        if declared is None:
            disagreements.append(f"{manifest.id}: manifest exists but nothing is declared")
        else:
            disagreements.extend(_check_row(manifest.id, declared, derived))
        rows.append(
            {
                "id": manifest.id,
                "parent": manifest.parent,
                "status": manifest.status,
                "manifest_path": path.relative_to(REPO_ROOT).as_posix(),
                "a2a_surface": bool(manifest.surfaces.a2a),
                "required_scopes": list(manifest.required_scope_strings()),
                "declared": dict(declared) if declared is not None else None,
                "derived": derived,
            }
        )

    return {
        "schema_version": "1.0.0",
        "source": {
            "manifests": "consent-protocol/hushh_mcp/agents/*/agent.yaml",
            "declaration_table": (
                "consent-protocol/hushh_mcp/services/pod_specialist_runtime.py"
                "::POD_SPECIALIST_EXECUTION"
            ),
            "derived_from": sorted(
                p.relative_to(REPO_ROOT).as_posix()
                for p in (
                    RUNTIME_PATH,
                    DISPATCH_INIT_PATH,
                    DOOR_SPECIALIST_PATH,
                    POD_RELAY_PATH,
                    POD_SPECIALIST_ROUTE_PATH,
                    TEXT_RUNTIME_PATH,
                    DELEGATION_PATH,
                )
            ),
        },
        "vocabulary": {
            "information_source": list(INFORMATION_SOURCES),
            "write_scope": list(WRITE_SCOPES),
            "confirmation_owner": list(CONFIRMATION_OWNERS),
        },
        "fleet": {
            "registered_specialists": registered,
            "pod_dispatchable": accepted,
            "pod_ports": ports,
            "specialist_doors": doors,
            "pod_data_door_names": door_names,
            "door_required_scopes": door_scopes,
            "door_agents": {door: door_agent[door] for door in sorted(door_agent)},
        },
        "agents": rows,
        "disagreements": disagreements,
        "live_evidence": live_evidence(),
    }


def _check_row(agent_id: str, declared: dict[str, Any], derived: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    missing = [field for field in DECLARATION_FIELDS if field not in declared]
    if missing:
        return [f"{agent_id}: declaration is missing {', '.join(missing)}"]
    executes = declared["executes_in_pod"]
    source = declared["information_source"]
    if not isinstance(executes, bool):
        problems.append(f"{agent_id}: executes_in_pod must be a bool")
        return problems
    if source not in INFORMATION_SOURCES:
        problems.append(f"{agent_id}: information_source {source!r} is not in the vocabulary")
    if declared["write_scope"] not in WRITE_SCOPES:
        problems.append(
            f"{agent_id}: write_scope {declared['write_scope']!r} is not in the vocabulary"
        )
    if declared["confirmation_owner"] not in CONFIRMATION_OWNERS:
        problems.append(
            f"{agent_id}: confirmation_owner {declared['confirmation_owner']!r} "
            "is not in the vocabulary"
        )
    if not str(declared["why"] or "").strip():
        problems.append(f"{agent_id}: why must say why")

    if agent_id == "agent_one":
        # The routing head is served by the pod turn route, not by service_for.
        if not executes:
            problems.append("agent_one: the routing head runs in the pod turn route")
        if source != "pkm_projection":
            problems.append("agent_one: the head grounds on the PKM projection")
        return problems

    if executes != derived["pod_dispatchable"]:
        problems.append(
            f"{agent_id}: declared executes_in_pod={executes} but service_for "
            f"{'accepts' if derived['pod_dispatchable'] else 'refuses'} it"
        )
        return problems
    if executes:
        reads_hub = bool(derived["hub_doors"])
        if reads_hub and source != "hub_door":
            problems.append(
                f"{agent_id}: its pod port reads the hub door(s) {derived['hub_doors']} "
                f"but information_source is {source!r}"
            )
        if not reads_hub and source == "hub_door":
            problems.append(
                f"{agent_id}: declared hub_door but no pod port reads a hub door for it"
            )
        if source == "hub":
            problems.append(f"{agent_id}: executes in the pod, so 'hub' is not its source")
    else:
        expected = "hub_door" if derived["door"] else "hub"
        if source != expected:
            problems.append(
                f"{agent_id}: not pod-dispatchable, so information_source must be "
                f"{expected!r} (door={derived['door']!r}), not {source!r}"
            )
    return problems


def render(matrix: dict[str, Any]) -> str:
    return json.dumps(matrix, indent=2, sort_keys=True) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    matrix = build_matrix()
    if matrix["disagreements"]:
        for line in matrix["disagreements"]:
            print(f"capability matrix disagreement: {line}", file=sys.stderr)
        return 1
    rendered = render(matrix)
    if args.check:
        stale = [
            target
            for target in OUTPUTS
            if not target.exists() or target.read_text(encoding="utf-8") != rendered
        ]
        if stale:
            for target in stale:
                print(f"stale pod specialist capability matrix: {target}", file=sys.stderr)
            return 1
        print(
            f"Pod specialist capability matrix is current ({len(matrix['agents'])} agents, "
            "0 disagreements)."
        )
        return 0
    for target in OUTPUTS:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(rendered, encoding="utf-8")
        print(f"Generated {target.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
