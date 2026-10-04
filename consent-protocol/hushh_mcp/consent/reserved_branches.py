"""Which PKM branches an app feature owns, and which writers may change them.

The Python half of ``contracts/pkm/reserved-branches.v1.json``. The TypeScript
half is ``hushh-webapp/lib/pkm/reserved-branches.ts``; the contract exists so
the two read one list instead of drifting, the same reason
``internal-path-keys.v1.json`` exists.

:func:`evaluate_reserved_write` answers "would this write be refused". The
contract's own ``enforcement`` value (:func:`enforcement_mode`) decides what the
store routes do with the answer: ``shadow`` only logs it, ``enforce`` refuses
with :func:`refusal_detail`. The switch is a reviewed contract value, never an
environment flag, so the server and the device read the same one.

Loading is lazy and cached. The packaged MCP runtime
(``packages/hushh-mcp/scripts/stage-runtime.mjs``) copies ``hushh_mcp`` but no
``contracts/`` directory, so reading the file at import time would break any
module that merely imports this one there.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from hushh_mcp.services.generated_contracts import generated_contract_path

_CONTRACT_PATH = generated_contract_path("pkm", "reserved-branches.v1.json")

WILDCARD_BRANCH = "*"

WriterClass = Literal["feature", "memory_agent", "migration"]
RefusalReason = Literal[
    "writer_unknown",
    "memory_agent",
    "writer_not_listed",
    "auto_save_mode",
    "capability_missing",
]
EnforcementMode = Literal["shadow", "enforce"]
MemoryScreenPolicy = Literal["read_only_reserved", "editable"]

_WRITER_CLASSES: frozenset[str] = frozenset({"feature", "memory_agent", "migration"})
_ENFORCEMENT_MODES: frozenset[str] = frozenset({"shadow", "enforce"})
_MEMORY_SCREEN_POLICIES: frozenset[str] = frozenset({"read_only_reserved", "editable"})

# Authorization modes that write without the owner reviewing this write. A
# reserved branch changes only by its feature's own control, so these never
# reach one, whatever the writer.
AUTO_SAVE_AUTHORIZATION_MODES: frozenset[str] = frozenset(
    {"owner_auto_save_policy", "product_default_auto_save_policy"}
)

REFUSAL_CODE_FORBIDDEN = "PKM_RESERVED_BRANCH_WRITER_FORBIDDEN"
REFUSAL_CODE_WRITER_UNKNOWN = "PKM_WRITER_UNKNOWN"
REFUSAL_CODE_REGISTRY_OUTDATED = "PKM_RESERVED_REGISTRY_OUTDATED"


@dataclass(frozen=True)
class ReservedWriter:
    writer_id: str
    feature: str
    writer_class: WriterClass
    surfaces: tuple[str, ...]
    authorization_modes: tuple[str, ...]
    requires_capability: str | None


@dataclass(frozen=True)
class ReservedOfferAction:
    """Where the owner commits a re-routed fact: the feature's own screen."""

    route_pattern: str
    action_id: str
    label_template: str

    def label(self, noun: str | None) -> str:
        text = " ".join(str(noun or "").split())[:48] or "this"
        return self.label_template.replace("{label}", text)


@dataclass(frozen=True)
class ReservedEntry:
    domain: str
    branch_prefix: str
    except_prefixes: tuple[str, ...]
    owner_feature: str
    writer_ids: frozenset[str]
    agent_memory_sibling: str | None
    shareable: str
    send_to_model: str
    offer_action: ReservedOfferAction | None = None


@dataclass(frozen=True)
class ReservedRefusal:
    """One would-be refusal. Carries labels only, never a stored value."""

    domain: str
    branch: str
    writer_id: str
    reason: RefusalReason


def _normalize_path(path: str | None) -> str:
    segments = [segment.strip().lower() for segment in str(path or "").split(".")]
    return ".".join(segment for segment in segments if segment)


def _is_at_or_below(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + ".")


@lru_cache(maxsize=1)
def _contract() -> dict:
    with _CONTRACT_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


@lru_cache(maxsize=1)
def _writers() -> dict[str, ReservedWriter]:
    writers: dict[str, ReservedWriter] = {}
    for writer_id, raw in _contract()["writers"].items():
        if writer_id.startswith("$"):
            continue
        writer_class = str(raw["class"])
        if writer_class not in _WRITER_CLASSES:
            raise ValueError(f"reserved_branches_writer_class_invalid:{writer_id}")
        writers[writer_id] = ReservedWriter(
            writer_id=writer_id,
            feature=str(raw["feature"]),
            writer_class=writer_class,  # type: ignore[arg-type]
            surfaces=tuple(raw["surfaces"]),
            authorization_modes=tuple(raw["authorization_modes"]),
            requires_capability=raw.get("requires_capability"),
        )
    return writers


def _offer_action(raw: object) -> ReservedOfferAction | None:
    if not isinstance(raw, dict):
        return None
    return ReservedOfferAction(
        route_pattern=str(raw["route_pattern"]),
        action_id=str(raw["action_id"]),
        label_template=str(raw["label_template"]),
    )


@lru_cache(maxsize=1)
def _entries() -> tuple[ReservedEntry, ...]:
    return tuple(
        ReservedEntry(
            domain=str(raw["domain"]).strip().lower(),
            branch_prefix=str(raw["branch_prefix"]).strip().lower(),
            except_prefixes=tuple(_normalize_path(item) for item in raw["except"]),
            owner_feature=str(raw["owner_feature"]),
            writer_ids=frozenset(raw["writer_ids"]),
            agent_memory_sibling=raw.get("agent_memory_sibling"),
            shareable=str(raw["shareable"]),
            send_to_model=str(raw["send_to_model"]),
            offer_action=_offer_action(raw.get("offer_action")),
        )
        for raw in _contract()["entries"]
    )


def registry_version() -> int:
    return int(_contract()["version"])


def enforcement_mode() -> EnforcementMode:
    """``shadow`` (log only) or ``enforce`` (refuse). Fails closed on anything else."""
    mode = str(_contract().get("enforcement") or "").strip().lower()
    if mode not in _ENFORCEMENT_MODES:
        raise ValueError("reserved_branches_enforcement_mode_invalid")
    return mode  # type: ignore[return-value]


def memory_screen_policy() -> MemoryScreenPolicy:
    policy = str(_contract().get("memory_screen_policy") or "").strip().lower()
    if policy not in _MEMORY_SCREEN_POLICIES:
        raise ValueError("reserved_branches_memory_screen_policy_invalid")
    return policy  # type: ignore[return-value]


def min_client_version() -> str:
    return str(_contract()["min_client_version"])


def _semver(value: str | None) -> tuple[int, int, int] | None:
    parts = str(value or "").strip().split(".")
    if len(parts) != 3 or not all(part.isdigit() and len(part) <= 6 for part in parts):
        return None
    return int(parts[0]), int(parts[1]), int(parts[2])


def client_version_is_current(client_version: str | None) -> bool:
    """True when a client reports at least ``min_client_version``.

    A client that reports nothing predates the registry, which is exactly the
    client that cannot run the device-side value diff, so it is not current.
    """
    reported = _semver(client_version)
    minimum = _semver(min_client_version())
    if minimum is None:
        raise ValueError("reserved_branches_min_client_version_invalid")
    return reported is not None and reported >= minimum


def domain_has_reserved_entries(domain: str | None) -> bool:
    canonical = str(domain or "").strip().lower()
    return any(entry.domain == canonical for entry in _entries())


def entries() -> tuple[ReservedEntry, ...]:
    return _entries()


def writer(writer_id: str | None) -> ReservedWriter | None:
    """The catalogued writer for ``writer_id``, or None when it is unknown."""
    return _writers().get(str(writer_id or "").strip().lower())


def reserved_entry_for(domain: str | None, path: str | None) -> ReservedEntry | None:
    """The entry that reserves ``path`` (dotted, relative to ``domain``), if any.

    A ``*`` entry reserves the whole domain, including the domain root, apart
    from its ``except`` branches. Any other entry reserves its prefix and
    everything beneath it.
    """
    canonical_domain = str(domain or "").strip().lower()
    normalized = _normalize_path(path)
    for entry in _entries():
        if entry.domain != canonical_domain:
            continue
        if any(_is_at_or_below(normalized, item) for item in entry.except_prefixes):
            continue
        if entry.branch_prefix == WILDCARD_BRANCH:
            return entry
        if normalized and _is_at_or_below(normalized, entry.branch_prefix):
            return entry
    return None


def is_reserved_path(domain: str | None, path: str | None) -> bool:
    return reserved_entry_for(domain, path) is not None


def _branch_label(entry: ReservedEntry, path: str) -> str:
    if entry.branch_prefix != WILDCARD_BRANCH:
        return entry.branch_prefix
    head = path.split(".", 1)[0]
    return head or WILDCARD_BRANCH


def evaluate_reserved_write(
    *,
    domain: str | None,
    paths: Iterable[str | None],
    writer_id: str | None,
    authorization_mode: str | None = None,
    capabilities: Iterable[str] = (),
) -> list[ReservedRefusal]:
    """Every reserved branch this write touches that its writer may not change.

    Rules, identical on the device: an unknown writer is refused; a
    ``migration`` writer is never refused here (its authority is the
    server-verified upgrade claim); a ``memory_agent`` writer is refused on
    every reserved branch; any other writer is refused unless the entry lists
    it, unless it writes under an auto-save authorization, or unless it lacks
    the capability its catalogue entry requires (Location's finalize authority,
    the KYC reply's information-request authority). ``capabilities`` names the
    capabilities the caller has ALREADY verified; naming one is not proof.
    """
    canonical_domain = str(domain or "").strip().lower()
    normalized_writer = str(writer_id or "").strip().lower()
    catalogued = writer(normalized_writer)
    if catalogued is not None and catalogued.writer_class == "migration":
        return []
    mode = str(authorization_mode or "").strip().lower()
    held = {str(item).strip().lower() for item in capabilities}
    refusals: dict[tuple[str, str], ReservedRefusal] = {}
    for raw_path in paths:
        normalized = _normalize_path(raw_path)
        entry = reserved_entry_for(canonical_domain, normalized)
        if entry is None:
            continue
        if catalogued is None:
            reason: RefusalReason = "writer_unknown"
        elif catalogued.writer_class == "memory_agent":
            reason = "memory_agent"
        elif normalized_writer not in entry.writer_ids:
            reason = "writer_not_listed"
        elif mode in AUTO_SAVE_AUTHORIZATION_MODES:
            reason = "auto_save_mode"
        elif catalogued.requires_capability and catalogued.requires_capability not in held:
            reason = "capability_missing"
        else:
            continue
        branch = _branch_label(entry, normalized)
        refusals.setdefault(
            (branch, reason),
            ReservedRefusal(
                domain=canonical_domain,
                branch=branch,
                writer_id=normalized_writer,
                reason=reason,
            ),
        )
    return list(refusals.values())


def entry_for_refusal(refusal: ReservedRefusal) -> ReservedEntry | None:
    return reserved_entry_for(refusal.domain, refusal.branch)


def refusal_code(refusals: Iterable[ReservedRefusal]) -> str:
    """422 code for an uncatalogued writer, else the 403 forbidden code."""
    return (
        REFUSAL_CODE_WRITER_UNKNOWN
        if any(item.reason == "writer_unknown" for item in refusals)
        else REFUSAL_CODE_FORBIDDEN
    )


def refusal_detail(refusal: ReservedRefusal, *, code: str | None = None) -> dict[str, object]:
    """The refusal body. Labels and routes only: never a stored value."""
    entry = entry_for_refusal(refusal)
    offer = entry.offer_action if entry else None
    return {
        "code": code or refusal_code([refusal]),
        "domain": refusal.domain,
        "branch": refusal.branch,
        "reason": refusal.reason,
        "owner_feature": entry.owner_feature if entry else None,
        "agent_memory_sibling": entry.agent_memory_sibling if entry else None,
        "offer_action": (
            {
                "route_pattern": offer.route_pattern,
                "action_id": offer.action_id,
                "label_template": offer.label_template,
            }
            if offer
            else None
        ),
        "registry_version": registry_version(),
    }


def sibling_for(domain: str | None, path: str | None) -> tuple[ReservedEntry, str, str] | None:
    """Where a chat fact aimed at a reserved ``path`` belongs instead.

    Returns ``(entry, sibling_domain, sibling_branch)`` for the entry that
    reserves the path, or None when the path is not reserved or the entry keeps
    no chat facts (``agent_memory_sibling`` null: KYC internals, runtime
    credentials, Secrets).
    """
    entry = reserved_entry_for(domain, path)
    if entry is None or not entry.agent_memory_sibling:
        return None
    sibling_domain, _, sibling_branch = entry.agent_memory_sibling.partition(".")
    if not sibling_domain or not sibling_branch:
        return None
    return entry, sibling_domain, sibling_branch


def reserved_table_for_prompt() -> list[dict[str, str | None]]:
    """The model-facing table: which branches an app owns and where chat facts go."""
    rows: list[dict[str, str | None]] = []
    for entry in _entries():
        branch = (
            f"{entry.domain}.* (except {', '.join(entry.except_prefixes)})"
            if entry.branch_prefix == WILDCARD_BRANCH and entry.except_prefixes
            else f"{entry.domain}.*"
            if entry.branch_prefix == WILDCARD_BRANCH
            else f"{entry.domain}.{entry.branch_prefix}"
        )
        rows.append(
            {
                "reserved_branch": branch,
                "owner_app": entry.owner_feature,
                "agent_memory_sibling": entry.agent_memory_sibling,
            }
        )
    return rows
