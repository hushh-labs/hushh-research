import { expect, it } from "vitest";
import { prepareAutoApprovalCommand } from "@/lib/one-location/command-settings";

const context = {
  owner: "owner",
  ruleVersion: 4,
  circles: [
    { id: "one", name: "Goa" },
    { id: "two", name: "Goa" },
  ],
};
it("requires a real scope and never infers enabled from arbitrary text", () => {
  expect(
    prepareAutoApprovalCommand({ ...context, slots: { enabled: "enable" } })
      .status,
  ).toBe("blocked");
  expect(
    prepareAutoApprovalCommand({ ...context, slots: { enabled: "on" } }).status,
  ).toBe("blocked");
  expect(
    prepareAutoApprovalCommand({
      ...context,
      slots: { enabled: "on", scope: "all_contacts" },
    }),
  ).toMatchObject({
    status: "ready",
    binding: {
      owner: "owner",
      enabled: true,
      scope: { kind: "all_contacts" },
      ruleVersion: 4,
    },
  });
});
it("keeps duplicate circle names as an explicit choice and rejects invented ids", () => {
  const slots = { enabled: "on", scope: "circle", circle: "Goa" };
  expect(prepareAutoApprovalCommand({ ...context, slots })).toMatchObject({
    status: "blocked",
    choices: [{ id: "one" }, { id: "two" }],
  });
  expect(
    prepareAutoApprovalCommand({ ...context, slots, chosenCircleId: "one" }),
  ).toMatchObject({
    status: "ready",
    binding: { scope: { kind: "circle", circleId: "one" } },
  });
  expect(
    prepareAutoApprovalCommand({
      ...context,
      slots,
      chosenCircleId: "invented",
    }).status,
  ).toBe("blocked");
});
it("can turn off without inventing or retaining a future audience", () => {
  expect(
    prepareAutoApprovalCommand({ ...context, slots: { enabled: "off" } }),
  ).toMatchObject({
    status: "ready",
    binding: { enabled: false, scope: null },
  });
});
