#!/usr/bin/env python3
"""
Local Worktree & Dependency Hygiene CLI (Zero Dependencies)

Canonical standard:
  https://wiki.hussh.si/wiki/reference/local-worktree-and-dependency-hygiene

Enforces:
  - Disk-headroom thresholds (default: warn < 30 GB, hard-stop < 15 GB)
  - Remove-after-use lifecycle (no arbitrary active-concurrency cap; flags any
    clean remote-backed/merged worktrees left behind after use)
  - Detection of duplicate (non-symlinked) node_modules and heavy build caches
  - Detection of orphaned non-git worktree stub directories (hard fail)
  - Zero-risk safe pruning (--prune-safe --execute) strictly for clean,
    remote-backed worktrees and orphaned non-git stubs
"""

from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import shutil
import subprocess
import sys
from typing import Any

DEFAULT_WARN_GB = 30.0
DEFAULT_STOP_GB = 15.0
DEFAULT_STALE_DAYS = 14

HEAVY_SUBPATHS = (
    "node_modules",
    ".next",
    "dist",
    "build",
    "out",
    ".turbo",
    ".venv",
    "hushh-webapp/node_modules",
    "hushh-webapp/.next",
    "hushh-webapp/ios",
    "hushh-webapp/out",
    "apps/reader/.next",
    "apps/careers/.next",
    "scripts/whatsapp-bridge/node_modules",
)

SAFE_IGNORED_STRIP_PATHS = (
    "node_modules",
    ".next",
    "dist",
    "build",
    "out",
    ".turbo",
    ".cache",
    "hushh-webapp/node_modules",
    "hushh-webapp/.next",
    "hushh-webapp/out",
    "apps/reader/.next",
    "apps/careers/.next",
    "scripts/whatsapp-bridge/node_modules",
)


def run_cmd(cmd: list[str], cwd: pathlib.Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
    )


def git(cwd: pathlib.Path, *args: str) -> subprocess.CompletedProcess[str]:
    return run_cmd(["git", "-C", str(cwd), *args])


def du_mb(path: pathlib.Path) -> float:
    if not path.exists() or path.is_symlink():
        return 0.0
    res = run_cmd(["du", "-sk", str(path)])
    if res.returncode != 0 or not res.stdout.strip():
        return 0.0
    try:
        return round(int(res.stdout.split()[0]) / 1024.0, 1)
    except ValueError:
        return 0.0


def disk_stats_gb(anchor: pathlib.Path) -> dict[str, float]:
    target = anchor if anchor.exists() else pathlib.Path.home()
    usage = shutil.disk_usage(target)
    gb = 1024.0 ** 3
    return {
        "total_gb": round(usage.total / gb, 2),
        "used_gb": round(usage.used / gb, 2),
        "free_gb": round(usage.free / gb, 2),
    }


def parse_worktree_list(repo: pathlib.Path) -> list[dict[str, str]]:
    res = git(repo, "worktree", "list", "--porcelain")
    if res.returncode != 0:
        return []
    entries: list[dict[str, str]] = []
    cur: dict[str, str] = {}
    for line in res.stdout.splitlines():
        if not line.strip():
            if cur:
                entries.append(cur)
                cur = {}
            continue
        if " " in line:
            k, v = line.split(" ", 1)
            cur[k] = v
        else:
            cur[line] = "true"
    if cur:
        entries.append(cur)
    return entries


def find_main_repo_from_cwd(cwd: pathlib.Path) -> pathlib.Path | None:
    res = git(cwd, "rev-parse", "--git-common-dir")
    if res.returncode != 0 or not res.stdout.strip():
        return None
    common = pathlib.Path(res.stdout.strip())
    if not common.is_absolute():
        common = (cwd / common).resolve()
    else:
        common = common.resolve()
    if common.name == ".git":
        return common.parent
    return None


def discover_repos(workspace_root: pathlib.Path) -> list[pathlib.Path]:
    repos: list[pathlib.Path] = []
    if not workspace_root.exists():
        return repos
    for child in sorted(workspace_root.iterdir()):
        if child.is_dir() and (child / ".git").is_dir():
            repos.append(child.resolve())
    return repos


def audit_worktree(main_repo: pathlib.Path, wt_path: pathlib.Path, stale_days: int) -> dict[str, Any]:
    exists = wt_path.exists()
    info: dict[str, Any] = {
        "repo": main_repo.name,
        "repo_path": str(main_repo),
        "name": wt_path.name,
        "path": str(wt_path),
        "exists": exists,
        "size_mb": 0.0,
        "branch": "",
        "head_sha": "",
        "last_commit_date": "",
        "age_days": 0,
        "stale": False,
        "dirty_count": 0,
        "unpushed_count": 0,
        "remote_refs": [],
        "duplicate_node_modules": [],
        "heavy_artifacts_mb": {},
        "classification": "MISSING_METADATA",
    }
    if not exists:
        return info

    info["size_mb"] = du_mb(wt_path)
    info["branch"] = git(wt_path, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    info["head_sha"] = git(wt_path, "rev-parse", "--short", "HEAD").stdout.strip()
    dt_raw = git(wt_path, "log", "-1", "--format=%ci").stdout.strip()[:10]
    info["last_commit_date"] = dt_raw
    if dt_raw:
        try:
            d = datetime.date.fromisoformat(dt_raw)
            age = (datetime.date.today() - d).days
            info["age_days"] = age
            info["stale"] = age >= stale_days
        except ValueError:
            pass

    st = [l for l in git(wt_path, "status", "--porcelain").stdout.splitlines() if l.strip()]
    unpushed = [l for l in git(wt_path, "log", "--oneline", "HEAD", "--not", "--remotes").stdout.splitlines() if l.strip()]
    remotes = [
        b.strip()
        for b in git(main_repo, "branch", "-r", "--contains", info["head_sha"]).stdout.splitlines()
        if b.strip()
    ]
    info["dirty_count"] = len(st)
    info["unpushed_count"] = len(unpushed)
    info["remote_refs"] = remotes[:5]

    for rel in HEAVY_SUBPATHS:
        sub = wt_path / rel
        if sub.is_symlink():
            continue
        if sub.is_dir():
            mb = du_mb(sub)
            if mb >= 10.0:
                info["heavy_artifacts_mb"][rel] = mb
            if sub.name == "node_modules" and mb >= 10.0:
                info["duplicate_node_modules"].append({"path": rel, "size_mb": mb})

    if info["dirty_count"] > 0:
        info["classification"] = "DIRTY"
    elif info["unpushed_count"] > 0:
        info["classification"] = "LOCAL_UNPUSHED"
    else:
        info["classification"] = "SAFE_TO_PRUNE"

    return info


def find_orphan_stubs(pool_dir: pathlib.Path, registered_paths: set[pathlib.Path]) -> list[dict[str, Any]]:
    stubs: list[dict[str, Any]] = []
    if not pool_dir.exists():
        return stubs
    for child in sorted(pool_dir.iterdir()):
        if not child.is_dir():
            continue
        resolved = child.resolve()
        if resolved in registered_paths:
            continue
        if not (child / ".git").exists():
            stubs.append({
                "name": child.name,
                "path": str(resolved),
                "size_mb": du_mb(child),
            })
    return stubs


def active_process_hits(target_path: pathlib.Path) -> list[str]:
    ps = run_cmd(["ps", "aux"]).stdout
    needle = str(target_path)
    hits: list[str] = []
    for line in ps.splitlines():
        if needle in line and "worktree-hygiene" not in line and "worktree_hygiene" not in line:
            hits.append(line.strip()[:140])
    return hits


def prune_safe_items(report: dict[str, Any], execute: bool) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    touched_repos: set[pathlib.Path] = set()

    for wt in report["worktrees"]:
        if wt["classification"] != "SAFE_TO_PRUNE":
            continue
        wt_path = pathlib.Path(wt["path"])
        main_repo = pathlib.Path(wt["repo_path"])
        action: dict[str, Any] = {
            "kind": "worktree",
            "name": wt["name"],
            "path": wt["path"],
            "repo": wt["repo"],
            "reclaim_mb": wt["size_mb"],
            "status": "DRY_RUN",
        }
        if execute:
            hits = active_process_hits(wt_path)
            if hits:
                action["status"] = "SKIPPED_ACTIVE_PROCESS"
                actions.append(action)
                continue
            st = git(wt_path, "status", "--porcelain").stdout.strip()
            unpushed = git(wt_path, "log", "--oneline", "HEAD", "--not", "--remotes").stdout.strip()
            if st or unpushed:
                action["status"] = "SKIPPED_BECAME_DIRTY"
                actions.append(action)
                continue
            for rel in SAFE_IGNORED_STRIP_PATHS:
                sub = wt_path / rel
                if sub.is_symlink():
                    sub.unlink()
                elif sub.is_dir():
                    shutil.rmtree(sub)
            git(wt_path, "clean", "-fdX")
            res = git(main_repo, "worktree", "remove", str(wt_path))
            if res.returncode != 0:
                action["status"] = f"FAILED: {res.stderr.strip()}"
            else:
                if wt_path.exists():
                    shutil.rmtree(wt_path)
                action["status"] = "REMOVED"
                touched_repos.add(main_repo)
        actions.append(action)

    for stub in report["orphan_stubs"]:
        stub_path = pathlib.Path(stub["path"])
        action = {
            "kind": "orphan_stub",
            "name": stub["name"],
            "path": stub["path"],
            "repo": "-",
            "reclaim_mb": stub["size_mb"],
            "status": "DRY_RUN",
        }
        if execute and stub_path.exists() and not (stub_path / ".git").exists():
            shutil.rmtree(stub_path)
            action["status"] = "REMOVED"
        actions.append(action)

    if execute:
        for repo in sorted(touched_repos):
            git(repo, "worktree", "prune", "--verbose")

    return actions


def print_human_report(report: dict[str, Any]) -> None:
    d = report["disk"]
    status = report["disk_status"]
    print(f"=== Worktree & Dependency Hygiene Audit ({report['scope']}) ===")
    print(f"Disk Free: {d['free_gb']:.2f} GB / {d['total_gb']:.2f} GB [{status}] "
          f"(warn < {report['thresholds']['warn_gb']:.0f} GB, stop < {report['thresholds']['stop_gb']:.0f} GB)")
    print(f"Linked Worktrees: {len(report['worktrees'])} "
          f"(total {report['total_worktree_gb']:.2f} GB) | "
          f"Orphan Non-Git Stubs: {len(report['orphan_stubs'])}")

    if report["worktrees"]:
        print("\nLinked Worktrees:")
        for wt in sorted(report["worktrees"], key=lambda x: x["size_mb"], reverse=True):
            dup_nm = sum(x["size_mb"] for x in wt["duplicate_node_modules"])
            dup_tag = f" | DUP node_modules={dup_nm:.0f}MB" if dup_nm > 0 else ""
            stale_tag = f" | STALE({wt['age_days']}d)" if wt["stale"] else ""
            print(
                f"  [{wt['classification']:14s}] {wt['size_mb']:7.1f} MB  "
                f"{wt['repo']}/{wt['name']}  "
                f"(br={wt['branch']}, dirty={wt['dirty_count']}, unpushed={wt['unpushed_count']})"
                f"{dup_tag}{stale_tag}"
            )

    if report["orphan_stubs"]:
        print("\nOrphaned Non-Git Stubs:")
        for s in report["orphan_stubs"]:
            print(f"  [ORPHAN_STUB   ] {s['size_mb']:7.1f} MB  {s['path']}")

    if report["violations"]:
        print("\nPreflight Violations (HARD FAIL):")
        for v in report["violations"]:
            print(f"  - {v}")

    if report["warnings"]:
        print("\nWarnings:")
        for w in report["warnings"]:
            print(f"  - {w}")

    if not report["violations"] and not report["warnings"]:
        print("\nStatus: HEALTHY (all disk, worktree teardown, and dependency hygiene checks passed)")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit, preflight-check, and safely prune local git worktrees and duplicated dependencies."
    )
    parser.add_argument("--audit", action="store_true", help="Run read-only audit (default mode).")
    parser.add_argument("--check", action="store_true", help="Exit non-zero on hard hygiene violations (preflight gate).")
    parser.add_argument("--fail-on-unused", action="store_true", help="In --check mode, also fail when clean remote-backed worktrees were not removed after use.")
    parser.add_argument("--prune-safe", action="store_true", help="Preview (or with --execute, remove) clean remote-backed worktrees and orphan stubs.")
    parser.add_argument("--execute", action="store_true", help="Actually delete items in --prune-safe mode (dry-run without this flag).")
    parser.add_argument("--all", action="store_true", help="Audit all repositories under --workspace-root instead of only the current repository.")
    parser.add_argument("--repo", type=pathlib.Path, help="Audit a specific repository path.")
    parser.add_argument("--workspace-root", type=pathlib.Path, default=pathlib.Path.home() / "Documents/GitHub")
    parser.add_argument("--worktree-pool", type=pathlib.Path, default=pathlib.Path.home() / ".local/share/hushh-task-worktrees")
    parser.add_argument("--warn-gb", type=float, default=DEFAULT_WARN_GB)
    parser.add_argument("--stop-gb", type=float, default=DEFAULT_STOP_GB)
    parser.add_argument("--stale-days", type=int, default=DEFAULT_STALE_DAYS)
    parser.add_argument("--json", action="store_true", help="Emit JSON output.")
    args = parser.parse_args()

    repos: list[pathlib.Path] = []
    scope = "global"
    if args.repo:
        main_repo = find_main_repo_from_cwd(args.repo.resolve()) or args.repo.resolve()
        repos = [main_repo]
        scope = main_repo.name
    elif not args.all:
        detected = find_main_repo_from_cwd(pathlib.Path.cwd())
        if detected:
            repos = [detected]
            scope = detected.name
        else:
            repos = discover_repos(args.workspace_root)
    else:
        repos = discover_repos(args.workspace_root)

    worktrees: list[dict[str, Any]] = []
    registered_paths: set[pathlib.Path] = set()

    for repo in repos:
        entries = parse_worktree_list(repo)
        if not entries:
            continue
        main_path = pathlib.Path(entries[0]["worktree"]).resolve()
        registered_paths.add(main_path)
        for e in entries[1:]:
            wt_p = pathlib.Path(e["worktree"]).resolve()
            registered_paths.add(wt_p)
            worktrees.append(audit_worktree(main_path, wt_p, args.stale_days))

    if scope != "global":
        for r in discover_repos(args.workspace_root):
            for e in parse_worktree_list(r):
                registered_paths.add(pathlib.Path(e["worktree"]).resolve())

    orphan_stubs = find_orphan_stubs(args.worktree_pool, registered_paths)
    disk = disk_stats_gb(args.workspace_root if args.workspace_root.exists() else pathlib.Path.home())

    if disk["free_gb"] < args.stop_gb:
        disk_status = "HARD_STOP"
    elif disk["free_gb"] < args.warn_gb:
        disk_status = "WARN"
    else:
        disk_status = "OK"

    violations: list[str] = []
    warnings: list[str] = []

    if disk["free_gb"] < args.stop_gb:
        violations.append(
            f"Free disk space is {disk['free_gb']:.2f} GB (< {args.stop_gb:.0f} GB hard stop). "
            "Refuse new worktrees and fresh dependency installs until space is reclaimed."
        )
    elif disk["free_gb"] < args.warn_gb:
        warnings.append(
            f"Free disk space is {disk['free_gb']:.2f} GB (< {args.warn_gb:.0f} GB warning threshold)."
        )

    if orphan_stubs:
        violations.append(
            f"Found {len(orphan_stubs)} orphaned non-git worktree stub(s) in {args.worktree_pool}."
        )

    safe_unused = [wt["name"] for wt in worktrees if wt["classification"] == "SAFE_TO_PRUNE"]
    if safe_unused:
        msg = (
            f"Found {len(safe_unused)} clean, remote-backed worktree(s) not removed after use "
            f"({', '.join(safe_unused)}). Run --prune-safe --execute to remove."
        )
        if args.fail_on_unused:
            violations.append(msg)
        else:
            warnings.append(msg)

    dup_nm_wts = [wt["name"] for wt in worktrees if wt["duplicate_node_modules"]]
    if dup_nm_wts:
        warnings.append(
            f"Duplicate non-symlinked node_modules found inside {len(dup_nm_wts)} worktree(s): {', '.join(dup_nm_wts)}."
        )

    total_wt_gb = round(sum(wt["size_mb"] for wt in worktrees) / 1024.0, 2)
    report: dict[str, Any] = {
        "scope": scope,
        "disk": disk,
        "disk_status": disk_status,
        "thresholds": {
            "warn_gb": args.warn_gb,
            "stop_gb": args.stop_gb,
            "stale_days": args.stale_days,
        },
        "total_worktree_gb": total_wt_gb,
        "worktrees": worktrees,
        "orphan_stubs": orphan_stubs,
        "violations": violations,
        "warnings": warnings,
    }

    if args.prune_safe:
        actions = prune_safe_items(report, execute=args.execute)
        report["prune_actions"] = actions
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            mode = "EXECUTE" if args.execute else "DRY-RUN (pass --execute to remove)"
            print(f"=== Safe Prune [{mode}] ===")
            if not actions:
                print("Nothing safe to prune (0 clean remote-backed worktrees, 0 orphan stubs).")
            for a in actions:
                print(f"  [{a['status']:20s}] {a['reclaim_mb']:7.1f} MB  {a['kind']}: {a['name']}")
        return 0

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_human_report(report)

    if args.check and violations:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
