import { reservedOwnerFor } from "@/lib/pkm/reserved-branches";
import { PersonalKnowledgeModelService } from "@/lib/services/personal-knowledge-model-service";

export type WorldModelFact = {
  id: string;
  domain: string;
  statement: string;
  sources: { title: string; url: string }[];
};

/** Read-only graph projection of owner-approved records; never a second store. */
export function projectWorldModelFacts(
  domain: string,
  value: unknown,
): WorldModelFact[] {
  const facts: WorldModelFact[] = [];
  const visit = (item: unknown, path: string[], depth: number) => {
    if (depth > 16 || !item || typeof item !== "object" || Array.isArray(item))
      return;
    if (reservedOwnerFor(domain, path)) return;
    const row = item as Record<string, unknown>;
    if (
      (row.kind === "profile_fact" ||
        (row.kind === undefined &&
          Array.isArray(row.sources) &&
          row.sources.length > 0)) &&
      row.status !== "deleted" &&
      row.status !== "retracted" &&
      typeof row.summary === "string"
    ) {
      const sources = Array.isArray(row.sources)
        ? row.sources.flatMap((source) => {
            if (!source || typeof source !== "object") return [];
            const { title, url } = source as Record<string, unknown>;
            if (typeof title !== "string" || typeof url !== "string") return [];
            try {
              const parsed = new URL(url);
              if (
                parsed.protocol !== "https:" ||
                parsed.username ||
                parsed.password
              )
                return [];
            } catch {
              return [];
            }
            return [{ title, url }];
          })
        : [];
      facts.push({
        id: `${domain}:${path.join(".")}`,
        domain,
        statement: row.summary,
        sources,
      });
      return;
    }
    for (const [key, child] of Object.entries(row))
      visit(child, [...path, key], depth + 1);
  };
  visit(value, [], 0);
  return facts;
}

export const PersonalWorldModelService = {
  async load(input: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    assertCurrent: () => Promise<void>;
  }): Promise<WorldModelFact[]> {
    await input.assertCurrent();
    const metadata = await PersonalKnowledgeModelService.getMetadata(
      input.userId,
      true,
      input.vaultOwnerToken,
    );
    const facts: WorldModelFact[] = [];
    // Bounded concurrency and fresh authority before every protected domain read.
    for (let start = 0; start < metadata.domains.length; start += 4) {
      const groups = await Promise.all(
        metadata.domains
          .slice(start, start + 4)
          .filter((domain) => !reservedOwnerFor(domain.key, []))
          .map(async (domain) => {
            await input.assertCurrent();
            const data = await PersonalKnowledgeModelService.loadDomainData({
              ...input,
              domain: domain.key,
            });
            await input.assertCurrent();
            return projectWorldModelFacts(domain.key, data);
          }),
      );
      facts.push(...groups.flat());
    }
    return facts;
  },
};
