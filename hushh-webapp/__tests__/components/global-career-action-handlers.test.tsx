import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listRoles = vi.fn();
const applyToRole = vi.fn();
const issueConsentReceipt = vi.fn();
const load = vi.fn();
const recordApplication = vi.fn();
let unlocked = true;

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "u1" } }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: "k", vaultOwnerToken: "t", isVaultUnlocked: unlocked }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), message: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/services/career-service", () => ({
  CareerService: {
    listRoles: () => listRoles(),
    applyToRole: (p: unknown) => applyToRole(p),
    issueConsentReceipt: (p: unknown) => issueConsentReceipt(p),
  },
}));
vi.mock("@/lib/services/career-pkm-service", () => ({
  CareerPkmService: { load: (p: unknown) => load(p), recordApplication: (p: unknown) => recordApplication(p) },
}));

import { GlobalCareerActionHandlers } from "@/components/agent/global-career-action-handlers";
import { describeDirectiveForOwner } from "@/lib/agent/action-directive-summary";
import { resolveLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { normalizeResume } from "@/lib/career/resume";

const ROLE = {
  slug: "agent-engineer",
  family: "vacancy",
  title: "Agent Engineer",
  group: "Engineering",
  summary: "Build Agent One.",
  url: "https://careers.hushh.ai/roles/agent-engineer",
  cities: ["Kirkland"],
  remoteEligible: true,
};
const RESUME = normalizeResume({
  name: "Ada Lovelace",
  location: "Kirkland, WA",
  summary: "Engineer.",
  links: [{ label: "LinkedIn", url: "https://www.linkedin.com/in/ada" }],
});

function run(actionId: string, slots: Record<string, unknown>) {
  const handler = resolveLocalOnboardingHandler(actionId);
  if (!handler) throw new Error(`${actionId} is not mounted`);
  return handler(slots);
}

beforeEach(() => {
  unlocked = true;
  listRoles.mockReset().mockResolvedValue([ROLE]);
  applyToRole.mockReset().mockResolvedValue({ reference: "HR-1", statusLink: "https://s", emailed: true });
  issueConsentReceipt.mockReset().mockResolvedValue("cr_server_issued");
  load.mockReset().mockResolvedValue({ resume: RESUME, applications: [] });
  recordApplication.mockReset().mockResolvedValue(undefined);
});

describe("careers from Agent One chat", () => {
  it("lists open roles with the exact slug and family apply needs", async () => {
    render(<GlobalCareerActionHandlers />);
    const result = await run("careers.list_roles", { query: "agent" });
    expect(result.status).toBe("succeeded");
    expect(result.data).toMatchObject({ total: 1, roles: [{ slug: "agent-engineer", family: "vacancy" }] });
  });

  it("applies with the saved resume and records a receipt", async () => {
    render(<GlobalCareerActionHandlers />);
    const result = await run("careers.apply", { slug: "agent-engineer", family: "vacancy" });
    expect(result.status).toBe("succeeded");
    expect(applyToRole).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Ada", lastName: "Lovelace", location: "Kirkland, WA" }),
    );
    expect(recordApplication).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain("HR-1");
  });

  it("applies with the receipt hussh issued, not one made on the device", async () => {
    render(<GlobalCareerActionHandlers />);
    await run("careers.apply", { slug: "agent-engineer", family: "vacancy" });
    expect(issueConsentReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ shared: expect.objectContaining({ name: "Ada Lovelace" }) }),
    );
    expect(applyToRole).toHaveBeenCalledWith(expect.objectContaining({ consentReceiptId: "cr_server_issued" }));
  });

  it("sends nothing when hussh cannot record the confirmation", async () => {
    issueConsentReceipt.mockRejectedValue(new Error("We couldn't record your confirmation. Nothing was sent."));
    render(<GlobalCareerActionHandlers />);
    const result = await run("careers.apply", { slug: "agent-engineer", family: "vacancy" });
    expect(result.status).toBe("failed");
    expect(applyToRole).not.toHaveBeenCalled();
  });

  it("refuses a role the portal does not list, and sends nothing", async () => {
    render(<GlobalCareerActionHandlers />);
    const result = await run("careers.apply", { slug: "made-up-role", family: "vacancy" });
    expect(result.status).toBe("failed");
    expect(applyToRole).not.toHaveBeenCalled();
  });

  it("stops without a saved resume and points to the Career page", async () => {
    load.mockResolvedValue({ resume: null, applications: [] });
    render(<GlobalCareerActionHandlers />);
    const result = await run("careers.apply", { slug: "agent-engineer", family: "vacancy" });
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("/one/career");
    expect(applyToRole).not.toHaveBeenCalled();
  });

  it("reports a failed application as failed, with no receipt", async () => {
    applyToRole.mockRejectedValue(new Error("That role is no longer accepting applications."));
    render(<GlobalCareerActionHandlers />);
    const result = await run("careers.apply", { slug: "agent-engineer", family: "vacancy" });
    expect(result.status).toBe("failed");
    expect(recordApplication).not.toHaveBeenCalled();
  });

  it("does not offer apply while the vault is locked", () => {
    unlocked = false;
    const { unmount } = render(<GlobalCareerActionHandlers />);
    expect(resolveLocalOnboardingHandler("careers.apply")).toBeNull();
    unmount();
  });

  it("names the role and what is shared on the confirmation card", () => {
    const card = describeDirectiveForOwner("careers.apply", "Apply to a hussh role", { slug: "agent-engineer" });
    expect(card).toContain('"agent-engineer"');
    expect(card).toContain("name, location, resume and links");
  });
});
