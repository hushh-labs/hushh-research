import { describe, expect, it } from "vitest";

import { HOME_FAQ } from "@/lib/seo/faq-data";
import { SITE_URL } from "@/lib/seo/site";
import {
  buildFaqGraph,
  buildOrganizationGraph,
} from "@/lib/seo/structured-data";

describe("seo: organization @graph", () => {
  it("describes Organization, WebSite, and SoftwareApplication", () => {
    const graph = buildOrganizationGraph();
    const nodes = (graph["@graph"] as Array<Record<string, unknown>>).map(
      (n) => n["@type"],
    );
    expect(nodes).toContain("Organization");
    expect(nodes).toContain("WebSite");
    expect(nodes).toContain("SoftwareApplication");
  });

  it("anchors every node to the canonical origin", () => {
    const graph = buildOrganizationGraph();
    for (const node of graph["@graph"] as Array<Record<string, unknown>>) {
      const id = node["@id"];
      if (typeof id === "string") {
        expect(id.startsWith(SITE_URL)).toBe(true);
      }
    }
  });

  it("lists the four-agent ontology in the app feature list", () => {
    const graph = buildOrganizationGraph();
    const app = (graph["@graph"] as Array<Record<string, unknown>>).find(
      (n) => n["@type"] === "SoftwareApplication",
    );
    const features = (app?.featureList as string[]).join(" ");
    expect(features).toMatch(/One/);
    expect(features).toMatch(/Kai/);
    expect(features).toMatch(/Nav/);
    expect(features).toMatch(/KYC/);
  });
});

describe("seo: FAQ @graph", () => {
  it("emits a FAQPage with one Question per FAQ item", () => {
    const graph = buildFaqGraph(HOME_FAQ);
    expect(graph["@type"]).toBe("FAQPage");
    const entities = graph.mainEntity as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(HOME_FAQ.length);
    for (const entity of entities) {
      expect(entity["@type"]).toBe("Question");
      const answer = entity.acceptedAnswer as Record<string, unknown>;
      expect(answer["@type"]).toBe("Answer");
      expect(typeof answer.text).toBe("string");
    }
  });
});
