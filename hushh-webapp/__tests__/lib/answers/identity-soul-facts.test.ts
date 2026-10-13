import { describe, expect, it } from "vitest";
import { projectApprovedSoulFacts } from "@/lib/answers/identity-soul-facts";

// Exactly what the identity intake writes (`suppliedIdentityFacts`).
const SOUL = [
  "# Soul.md",
  "",
  "## Facts",
  "",
  "- Legal name: Smirthika Dharmalingam",
  "- Date of birth: 1998-03-14",
  "- Sex: female",
  "- Citizenship: India / IN",
  "- Favourite coffee is a flat white",
  "",
].join("\n");

const NOW = new Date("2026-03-13T00:00:00Z");
const scope = (path: string) => `attr.identity.${path}`;

describe("approved identity facts come from the Soul bullets the product wrote", () => {
  it("answers a name request from the recorded legal name", () => {
    const [fact, ...rest] = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.full_name")],
      markdown: SOUL,
      now: NOW,
    });
    expect(rest).toHaveLength(0);
    expect(fact).toMatchObject({ path: "full_name", value: "Smirthika Dharmalingam" });
  });

  it("answers an age request with the age, and never the birth date", () => {
    const projected = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.declared_age")],
      markdown: SOUL,
      now: NOW,
    });
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      path: "declared_age",
      value: "27",
      derived: "age_from_date_of_birth",
    });
    // The birth date is a separate decision and was not approved here.
    expect(JSON.stringify(projected)).not.toContain("1998-03-14");
  });

  it("gives the birth date only when its own scope was approved", () => {
    const projected = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.date_of_birth")],
      markdown: SOUL,
      now: NOW,
    });
    expect(projected).toEqual([
      expect.objectContaining({ path: "date_of_birth", value: "1998-03-14" }),
    ]);
  });

  it("never hands over an unapproved fact, or the prose around it", () => {
    const projected = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.full_name")],
      markdown: SOUL,
      now: NOW,
    });
    const rendered = JSON.stringify(projected);
    expect(rendered).not.toContain("female");
    expect(rendered).not.toContain("India");
    expect(rendered).not.toContain("flat white");
    expect(rendered).not.toContain("1998-03-14");
  });

  it("says nothing rather than guessing when the fact was never recorded", () => {
    const projected = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.sex"), scope("identity_profile.declared_age")],
      markdown: "## Facts\n\n- Legal name: Someone\n",
      now: NOW,
    });
    // No sex recorded and no birth date to work an age from.
    expect(projected).toEqual([]);
  });

  it("does not infer sex from a name, a pronoun or anything else nearby", () => {
    const projected = projectApprovedSoulFacts({
      approvedScopes: [scope("identity_profile.sex")],
      markdown: "## Facts\n\n- Legal name: Smirthika Dharmalingam\n- She prefers window seats\n",
      now: NOW,
    });
    expect(projected).toEqual([]);
  });
});


it("never interprets another domain's same-named field as the owner's identity", () => {
  expect(projectApprovedSoulFacts({ approvedScopes: ["attr.health.identity_profile.sex", "attr.travel.identity_profile.full_name", "attr.health.identity_profile.*"], markdown: SOUL })).toEqual([]);
});

it("does not satisfy a nested lookalike scope with a canonical identity fact", () => {
  expect(projectApprovedSoulFacts({ approvedScopes: ["attr.identity.other.identity_profile.sex", "attr.identity.other.identity_profile.*"], markdown: "- Sex: female\n" })).toEqual([]);
});
