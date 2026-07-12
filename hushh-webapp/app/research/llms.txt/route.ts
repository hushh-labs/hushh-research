import { BLOG_POSTS } from "@/lib/research/blog";
import {
  PCHP_SPEC_META,
  PCHP_SPEC_SECTIONS,
} from "@/lib/research/pchp-spec";

export const dynamic = "force-static";

/**
 * llms.txt — machine-readable index of the Hushh Research surface, in the
 * emerging convention MCP's docs popularized. Ease of adoption applies to
 * agents as much as to humans: an agent should be able to discover and read
 * the PCHP specification as easily as a developer can.
 */
export function GET() {
  const lines: string[] = [
    "# Hushh Research & Papers",
    "",
    "> Open protocols from Hushh, donated to the commons. Flagship: PCHP — the",
    "> Personal Consent Handshake Protocol, an open standard for sharing personal",
    "> data with consent and control built into every transaction.",
    "",
    `PCHP protocol version: ${PCHP_SPEC_META.version} (spec ${PCHP_SPEC_META.semver}, ${PCHP_SPEC_META.status}, updated ${PCHP_SPEC_META.updated}).`,
    "License: specification text CC0 1.0 (public domain); schema and reference code Apache-2.0.",
    "",
    "## Specification",
    "",
    ...PCHP_SPEC_SECTIONS.map(
      (section) =>
        `- [${section.label}](/research/protocol#${section.id}): ${section.summary}`
    ),
    "",
    "## Blog",
    "",
    ...BLOG_POSTS.map(
      (post) => `- [${post.title}](/blog/${post.slug}): ${post.excerpt}`
    ),
    "",
    "## Other",
    "",
    "- [Research & Papers home](/research)",
    "- [Developer docs](/developers)",
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
