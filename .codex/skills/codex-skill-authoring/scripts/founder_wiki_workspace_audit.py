#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any
from urllib import request


REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_MCP_URL = "https://mcp.hushh.ai/mcp"
TOKEN_ENV = "HUSHH_FOUNDER_WIKI_MCP_TOKEN"
ANONYMOUS_PUBLIC_PAGE_COUNT = 77
ANONYMOUS_TOOL_COUNT = 8

PRODUCT_CANON = [
    "hussh://docs/non-negotiables",
    "hussh://wiki/index",
    "wiki/products/one.md",
    "wiki/products/kai.md",
    "wiki/products/nav.md",
    "wiki/products/pchp.md",
    "wiki/concepts/personal-operating-layer.md",
    "wiki/concepts/byoa.md",
    "wiki/concepts/world-model.md",
    "wiki/concepts/aha-moment.md",
    "wiki/concepts/mlx-on-one-surfaces.md",
    "wiki/concepts/app-intents-conformance.md",
    "wiki/concepts/llm-wiki-pattern.md",
    "wiki/concepts/openclaw.md",
    "wiki/concepts/hu-ssh.md",
    "wiki/concepts/signature-vault.md",
    "wiki/concepts/north-star-user-persona.md",
    "wiki/concepts/one-lens.md",
    "wiki/concepts/pchp-brand-side-endpoint.md",
    "wiki/products/ibrokerage.md",
    "wiki/projects/one-email-kyc-wiki-integration.md",
]

REPO_ALIGNMENT_FILES = [
    ".codex/skills/codex-skill-authoring/references/founder-wiki-north-star-probe.md",
    ".codex/skills/codex-skill-authoring/references/truth-first-operating-kernel.md",
    ".codex/skills/codex-skill-authoring/references/skill-contract.md",
    ".codex/skills/codex-skill-authoring/scripts/skill_lint.py",
    ".codex/skills/pr-governance-review/SKILL.md",
    ".codex/skills/pr-governance-review/references/review-axes.md",
    ".codex/skills/pr-governance-review/scripts/pr_review_checklist.py",
    ".codex/skills/future-planner/SKILL.md",
    ".codex/skills/founder-brief-curation/SKILL.md",
    ".codex/skills/comms-community/SKILL.md",
    ".codex/skills/comms-community/references/reply-rules.md",
    ".codex/skills/agent-orchestration-governance/SKILL.md",
    ".codex/skills/agent-orchestration-governance/references/delegation-contract.md",
    "docs/reference/operations/coding-agent-mcp.md",
]

REQUIRED_SKILL_PHRASES = [
    "Founder Wiki North-Star Probe",
    "current_state_vs_north_star_drift",
    "private wiki evidence",
]

REQUIRED_MCP_DOC_PHRASES = [
    "bearer_token_env_var",
    TOKEN_ENV,
    "authorization-code + PKCE",
    "not enough by themselves",
]

PR_GATE_KEYWORDS = [
    "openclaw",
    "hu-ssh",
    "signature vault",
    "one lens",
    "one email kyc",
    "ibrokerage",
    "pchp brand-side",
    "north-star user",
]

SAFE_SEARCH_PATH_PREFIXES = (
    "wiki/concepts/",
    "wiki/products/",
    "wiki/projects/one-email-kyc-wiki-integration.md",
)


class AuditError(RuntimeError):
    pass


@dataclass(frozen=True)
class McpClient:
    url: str
    token: str
    timeout: int = 45

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params or {},
        }
        body = json.dumps(payload).encode("utf-8")
        req = request.Request(
            self.url,
            data=body,
            method="POST",
            headers={
                "Accept": "application/json, text/event-stream",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        with request.urlopen(req, timeout=self.timeout, context=ssl_context()) as response:
            raw = response.read().decode("utf-8", errors="replace")
        message = parse_mcp_response(raw)
        if "error" in message:
            raise AuditError(f"{method} failed: {message['error']}")
        result = message.get("result")
        if not isinstance(result, dict):
            raise AuditError(f"{method} returned unexpected payload")
        return result

    def tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        result = self.call("tools/call", {"name": name, "arguments": arguments or {}})
        content = result.get("content")
        if not content or not isinstance(content, list):
            return result
        first = content[0]
        if not isinstance(first, dict):
            return result
        text = first.get("text")
        if not isinstance(text, str):
            return result
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"text": text}


def parse_mcp_response(raw: str) -> dict[str, Any]:
    if raw.lstrip().startswith("{"):
        return json.loads(raw)
    data_lines = []
    for line in raw.splitlines():
        if line.startswith("data: "):
            data_lines.append(line[6:])
    if not data_lines:
        raise AuditError("MCP response did not contain JSON or SSE data")
    last = data_lines[-1]
    return json.loads(last)


def ssl_context() -> ssl.SSLContext:
    for candidate in (
        os.environ.get("SSL_CERT_FILE"),
        os.environ.get("REQUESTS_CA_BUNDLE"),
        os.environ.get("CURL_CA_BUNDLE"),
        "/etc/ssl/cert.pem",
        "/opt/homebrew/etc/ca-certificates/cert.pem",
    ):
        if candidate and Path(candidate).exists():
            return ssl.create_default_context(cafile=candidate)
    return ssl.create_default_context()


def read_repo_text(path: str) -> str:
    target = REPO_ROOT / path
    if not target.exists():
        return ""
    return target.read_text(encoding="utf-8", errors="replace")


def safe_page_summary(path: str, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {"path": path, "read": False, "metadata": {}}
    frontmatter = payload.get("frontmatter") or payload.get("metadata") or {}
    body = payload.get("body") or payload.get("text") or payload.get("content") or ""
    title = payload.get("title") or frontmatter.get("name") or frontmatter.get("title") or path
    return {
        "path": path,
        "read": True,
        "title": str(title),
        "type": str(frontmatter.get("type", "")),
        "visibility": str(frontmatter.get("visibility", "")),
        "has_tldr": "TL;DR" in body or "TLDR" in body,
        "has_status": "Status as of" in body,
    }


def read_canon_page(client: McpClient, path: str) -> dict[str, Any]:
    if path.startswith("hussh://"):
        result = client.call("resources/read", {"uri": path})
        contents = result.get("contents") or []
        text = ""
        if contents and isinstance(contents[0], dict):
            text = str(contents[0].get("text") or "")
        return {
            "path": path,
            "read": bool(text),
            "title": path,
            "type": "resource",
            "visibility": "private" if "visibility: private" in text else "",
            "has_tldr": "TL;DR" in text or "TLDR" in text,
            "has_status": "Status as of" in text,
        }
    return safe_page_summary(path, client.tool("wiki_read", {"path": path}))


def classify_workspace_alignment(canon_pages: list[dict[str, Any]]) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    founder_probe = read_repo_text(
        ".codex/skills/codex-skill-authoring/references/founder-wiki-north-star-probe.md"
    )
    pr_script = read_repo_text(".codex/skills/pr-governance-review/scripts/pr_review_checklist.py")
    mcp_doc = read_repo_text("docs/reference/operations/coding-agent-mcp.md")

    for page in canon_pages:
        path = page["path"]
        if path not in founder_probe:
            findings.append(
                {
                    "classification": "doc_missing",
                    "surface": "Founder Wiki Product Canon",
                    "detail": f"{path} is missing from the repo-local Product Canon reference.",
                }
            )
        if path.startswith("wiki/") and path not in pr_script:
            findings.append(
                {
                    "classification": "pr_gate_missing",
                    "surface": "PR governance Product Canon",
                    "detail": f"{path} is missing from PR governance founder-wiki probe pages.",
                }
            )

    for keyword in PR_GATE_KEYWORDS:
        if keyword not in pr_script.lower():
            findings.append(
                {
                    "classification": "pr_gate_missing",
                    "surface": "PR governance trigger keywords",
                    "detail": f"`{keyword}` is not represented in founder-wiki PR trigger keywords.",
                }
            )

    mcp_doc_lower = mcp_doc.lower()
    for phrase in REQUIRED_MCP_DOC_PHRASES:
        if phrase.lower() not in mcp_doc_lower:
            findings.append(
                {
                    "classification": "doc_missing",
                    "surface": "MCP operations docs",
                    "detail": f"`{phrase}` is missing from Founder Wiki MCP setup guidance.",
                }
            )

    for rel in REPO_ALIGNMENT_FILES:
        text = read_repo_text(rel)
        if not text:
            findings.append(
                {
                    "classification": "doc_missing",
                    "surface": rel,
                    "detail": "Expected workspace alignment file is missing.",
                }
            )
            continue
        if rel.startswith(".codex/skills/") and rel.endswith((".md", "SKILL.md")):
            text_lower = text.lower()
            for phrase in REQUIRED_SKILL_PHRASES:
                if phrase.lower() not in text_lower:
                    findings.append(
                        {
                            "classification": "skill_missing",
                            "surface": rel,
                            "detail": f"`{phrase}` is missing.",
                        }
                    )

    if not findings:
        findings.append(
            {
                "classification": "aligned",
                "surface": "workspace",
                "detail": "Founder Wiki Product Canon is represented across docs, skills, PR governance, and planning surfaces checked by this audit.",
            }
        )
    return findings


def safe_search_paths(rows: list[Any]) -> list[str]:
    paths: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        path = str(row.get("path") or row.get("uri") or "")
        if not path.startswith(SAFE_SEARCH_PATH_PREFIXES):
            continue
        paths.append(path)
    return paths


def render_report(
    *,
    mcp_url: str,
    tool_names: list[str],
    resources: list[dict[str, Any]],
    page_total: int,
    canon_pages: list[dict[str, Any]],
    lint_summary: dict[str, Any],
    search_hits: dict[str, list[str]],
    findings: list[dict[str, str]],
) -> str:
    classifications = sorted({finding["classification"] for finding in findings})
    lines = [
        f"# Founder Wiki Workspace Audit - {date.today().isoformat()}",
        "",
        "## Private MCP Status",
        "",
        f"- MCP URL: `{mcp_url}`",
        f"- Auth: `bearer_token_env_var:{TOKEN_ENV}`",
        f"- Authenticated tool count: `{len(tool_names)}`",
        f"- Wiki page count from `wiki_list`: `{page_total}`",
        f"- Resource count: `{len(resources)}`",
        f"- Private mode verdict: `{'authenticated' if len(tool_names) > ANONYMOUS_TOOL_COUNT and page_total > ANONYMOUS_PUBLIC_PAGE_COUNT else 'not_authenticated_or_public_only'}`",
        "",
        "## Product Canon Pages Checked",
        "",
    ]
    for page in canon_pages:
        lines.append(
            f"- `{page['path']}` - read `{str(page['read']).lower()}`, type `{page.get('type', '')}`, visibility `{page.get('visibility', '')}`"
        )
    lines.extend(
        [
            "",
            "## Repo Surfaces Checked",
            "",
            *[f"- `{path}`" for path in REPO_ALIGNMENT_FILES],
            "",
            "## Wiki Search Coverage",
            "",
        ]
    )
    for query, hits in search_hits.items():
        lines.append(f"- `{query}`: {', '.join(f'`{hit}`' for hit in hits[:8])}")
    lines.extend(
        [
            "",
            "## Wiki Lint Summary",
            "",
            f"- Summary: `{json.dumps(lint_summary, sort_keys=True)}`",
            "",
            "## Classifications",
            "",
            f"- Classes present: {', '.join(f'`{value}`' for value in classifications)}",
        ]
    )
    for finding in findings:
        lines.append(
            f"- `{finding['classification']}` - `{finding['surface']}`: {finding['detail']}"
        )
    lines.extend(
        [
            "",
            "## Recommended Repo-Only Patches",
            "",
        ]
    )
    actionable = [f for f in findings if f["classification"] != "aligned"]
    if actionable:
        for finding in actionable:
            lines.append(
                f"- Patch `{finding['surface']}` for `{finding['classification']}`: {finding['detail']}"
            )
    else:
        lines.append("- No additional repo patch required by this private MCP audit.")
    lines.extend(
        [
            "",
            "## Redaction Boundary",
            "",
            "- Raw HCT omitted.",
            "- Private page bodies omitted.",
            "- Private legal, fund, and personal details omitted.",
            "- Public PR comments must not cite private wiki evidence.",
            "",
        ]
    )
    return "\n".join(lines)


def run_audit(args: argparse.Namespace) -> int:
    token = os.environ.get(TOKEN_ENV, "").strip()
    if not token:
        raise AuditError(f"{TOKEN_ENV} is required")
    if not token.startswith("HCT:"):
        raise AuditError(f"{TOKEN_ENV} must contain an HCT bearer token")

    client = McpClient(url=args.mcp_url, token=token)
    client.call(
        "initialize",
        {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "hushh-founder-wiki-workspace-audit", "version": "1.0.0"},
        },
    )
    tools_result = client.call("tools/list")
    resources_result = client.call("resources/list")
    tool_names = sorted(tool["name"] for tool in tools_result.get("tools", []) if isinstance(tool, dict))
    resources = [
        resource
        for resource in resources_result.get("resources", [])
        if isinstance(resource, dict)
    ]
    wiki_list = client.tool("wiki_list", {})
    page_total = int(wiki_list.get("total") or len(wiki_list.get("entries") or []))
    if args.require_private and (len(tool_names) <= ANONYMOUS_TOOL_COUNT or page_total <= ANONYMOUS_PUBLIC_PAGE_COUNT):
        raise AuditError(
            "Founder Wiki MCP did not expose private mode; expected more than "
            f"{ANONYMOUS_TOOL_COUNT} tools and more than {ANONYMOUS_PUBLIC_PAGE_COUNT} pages"
        )

    canon_pages = [read_canon_page(client, page) for page in PRODUCT_CANON]
    search_queries = {
        "One Kai Nav PCHP": "One Kai Nav PCHP personal operating layer",
        "PKM World Model OpenClaw": "PKM World Model OpenClaw LLM Wiki",
        "BYOA on-device": "BYOA BYOK MLX on-device App Intents",
        "Aha iBrokerage Signature": "Aha Moment iBrokerage Signature Vault One Email KYC",
    }
    search_hits: dict[str, list[str]] = {}
    for label, query in search_queries.items():
        result = client.tool("wiki_search", {"query": query, "max_results": 12})
        rows = result.get("results") or result.get("items") or result.get("pages") or []
        search_hits[label] = safe_search_paths(rows)
    lint = client.tool("wiki_lint", {"stale_days": 90})
    lint_summary = lint.get("summary", {}) if isinstance(lint, dict) else {}
    findings = classify_workspace_alignment(canon_pages)
    report = render_report(
        mcp_url=args.mcp_url,
        tool_names=tool_names,
        resources=resources,
        page_total=page_total,
        canon_pages=canon_pages,
        lint_summary=lint_summary,
        search_hits=search_hits,
        findings=findings,
    )
    if args.output:
        output_path = Path(args.output)
        if not output_path.is_absolute():
            output_path = REPO_ROOT / output_path
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(report, encoding="utf-8")
        print(f"wrote {output_path.relative_to(REPO_ROOT)}")
    if args.text:
        print(report)
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audit Founder Wiki private MCP alignment with repo governance.")
    parser.add_argument("--mcp-url", default=DEFAULT_MCP_URL)
    parser.add_argument(
        "--output",
        default=f"tmp/founder-wiki-workspace-audit-{date.today().isoformat()}.md",
    )
    parser.add_argument("--text", action="store_true", help="Print report text to stdout.")
    parser.add_argument(
        "--no-require-private",
        dest="require_private",
        action="store_false",
        help="Allow anonymous/public-only mode. Not allowed for the main audit SOP.",
    )
    parser.set_defaults(require_private=True)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        return run_audit(args)
    except AuditError as exc:
        print(f"founder wiki workspace audit failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
