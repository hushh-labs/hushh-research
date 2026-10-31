"""Pure prompt presentation of stored screening criteria."""


def screening_rubric(rows: list[dict]) -> str:
    if not rows:
        return ""

    investable = [r for r in rows if r.get("section") == "investable_requirements"]
    avoid = [r for r in rows if r.get("section") == "automatic_avoid_triggers"]
    math = [r for r in rows if r.get("section") == "the_math"]

    def fmt_rules(rs: list[dict], max_items: int) -> str:
        parts: list[str] = []
        for r in rs[:max_items]:
            idx = r.get("rule_index")
            title = (r.get("title") or "").strip()
            detail = (r.get("detail") or "").strip()
            if idx:
                parts.append(f"{idx}. {title} — {detail}")
            else:
                parts.append(f"- {title} — {detail}")
        return "\n".join(parts)

    math_lines = []
    for r in math[:6]:
        title = (r.get("title") or "").strip()
        value = (r.get("value_text") or r.get("detail") or "").strip()
        if title and value:
            math_lines.append(f"- {title}: {value}")

    return (
        "RENAISSANCE SCREENING RUBRIC\n"
        "INVESTABLE REQUIREMENTS (all must be met):\n"
        f"{fmt_rules(investable, 12)}\n\n"
        "AUTOMATIC AVOID TRIGGERS (any one disqualifies):\n"
        f"{fmt_rules(avoid, 20)}\n\n"
        "THE MATH:\n"
        f"{chr(10).join(math_lines)}\n"
    ).strip()
