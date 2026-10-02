/**
 * The structured resume the Career Agent keeps in the owner's PKM
 * (professional domain, `resume`). Produced by the Resume Extractor, reviewed
 * and edited by the owner, then encrypted on their device. Never stored anywhere
 * else; an application sends a plain-text rendering only on explicit consent.
 */

export interface ResumeRole {
  title: string;
  organization: string;
  location: string;
  start: string;
  end: string;
  highlights: string[];
}

export interface ResumeEducation {
  institution: string;
  degree: string;
  field: string;
  start: string;
  end: string;
}

export interface Resume {
  name: string;
  headline: string;
  location: string;
  summary: string;
  experience: ResumeRole[];
  education: ResumeEducation[];
  skills: string[];
  links: { label: string; url: string }[];
}

const text = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = <T>(v: unknown, map: (x: Record<string, unknown>) => T, max = 40): T[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
        .slice(0, max)
        .map(map)
    : [];
const strings = (v: unknown, max = 60) =>
  Array.isArray(v) ? v.map((x) => text(x, 200)).filter(Boolean).slice(0, max) : [];

/** Coerce anything (extractor output, PKM data) into a well-formed Resume. */
export function normalizeResume(raw: unknown): Resume {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    name: text(r.name, 160),
    headline: text(r.headline, 200),
    location: text(r.location, 200),
    summary: text(r.summary, 2000),
    experience: list(r.experience, (x) => ({
      title: text(x.title, 160),
      organization: text(x.organization, 160),
      location: text(x.location, 160),
      start: text(x.start, 40),
      end: text(x.end, 40),
      highlights: strings(x.highlights, 12),
    })),
    education: list(r.education, (x) => ({
      institution: text(x.institution, 200),
      degree: text(x.degree, 160),
      field: text(x.field, 160),
      start: text(x.start, 40),
      end: text(x.end, 40),
    })),
    skills: strings(r.skills),
    links: list(r.links, (x) => ({ label: text(x.label, 60), url: text(x.url, 500) }), 12).filter(
      (l) => /^https?:\/\//.test(l.url),
    ),
  };
}

export function isEmptyResume(r: Resume): boolean {
  return !r.name && !r.summary && r.experience.length === 0 && r.education.length === 0 && r.skills.length === 0;
}

/** Plain text sent with an application (capped at the careers limit). */
export function resumeToText(r: Resume): string {
  const span = (a: string, b: string) => [a, b].filter(Boolean).join(" – ");
  const lines: string[] = [r.name, r.headline, r.location].filter(Boolean);
  if (r.summary) lines.push("", r.summary);
  if (r.experience.length) {
    lines.push("", "EXPERIENCE");
    for (const e of r.experience) {
      lines.push([e.title, e.organization].filter(Boolean).join(", ") + (span(e.start, e.end) ? ` (${span(e.start, e.end)})` : ""));
      for (const h of e.highlights) lines.push(`- ${h}`);
    }
  }
  if (r.education.length) {
    lines.push("", "EDUCATION");
    for (const e of r.education) {
      const what = [e.degree, e.field].filter(Boolean).join(", ");
      lines.push([e.institution, what].filter(Boolean).join(" · ") + (span(e.start, e.end) ? ` (${span(e.start, e.end)})` : ""));
    }
  }
  if (r.skills.length) lines.push("", "SKILLS", r.skills.join(", "));
  if (r.links.length) lines.push("", "LINKS", ...r.links.map((l) => `${l.label ? `${l.label}: ` : ""}${l.url}`));
  return lines.join("\n").slice(0, 20000);
}

/** First and last name for the application form. */
export function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}
