import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { normalizeResume } from "@/lib/career/resume";

const state = vi.hoisted(() => ({ load: vi.fn(), roles: vi.fn(), save: vi.fn(), parse: vi.fn(), apply: vi.fn(), track: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "owner-a" }, userId: "owner-a" }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true, vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-token" }) }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: state.track }));
vi.mock("@/components/app-ui/app-page-shell", () => ({ AppPageShell: ({ children }: { children: ReactNode }) => <main>{children}</main>, AppPageContentRegion: ({ children }: { children: ReactNode }) => <div>{children}</div>, AppPageHeaderRegion: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/app-ui/page-sections", () => ({ PageHeader: () => <h1>Career</h1> }));
vi.mock("@/components/icons", () => ({ Briefcase: () => null }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), message: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/services/career-pkm-service", () => ({ CareerPkmService: { load: state.load, saveResume: state.save } }));
vi.mock("@/lib/services/career-service", () => ({ CareerService: { listRoles: state.roles, parseResume: state.parse } }));
vi.mock("@/lib/career/apply", () => ({ applyWithSavedResume: state.apply }));

import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import CareerPage from "@/app/one/career/page";

const resume = normalizeResume({ name: "PRIVATE_CANDIDATE", summary: "PRIVATE_RESUME_CONTENT" });
beforeEach(() => {
  vi.clearAllMocks();
  publishValidatedAuthSessionOwner("owner-a");
  state.load.mockResolvedValue({ resume, applications: [] });
  state.roles.mockResolvedValue([]);
});

it.each(["success", "error"] as const)("records the actual resume parse %s without file contents", async result => {
  if (result === "success") state.parse.mockResolvedValue({ resume, truncated: false });
  else state.parse.mockRejectedValue(new Error("PRIVATE_PROVIDER_DIAGNOSTIC"));
  render(<CareerPage />);
  await screen.findByText("PRIVATE_CANDIDATE");
  fireEvent.change(screen.getByLabelText("Upload your resume"), { target: { files: [new File(["PRIVATE_FILE_CONTENT"], "PRIVATE_FILENAME.pdf")] } });
  await waitFor(() => expect(state.track).toHaveBeenCalledExactlyOnceWith("one_career_action", { action: "resume_parse", result }));
  expect(JSON.stringify(state.track.mock.calls)).not.toContain("PRIVATE");
});

it.each([true, false])("records the returned save commitment %s without changing Main's UI flow", async committed => {
  state.save.mockResolvedValue({ success: committed });
  render(<CareerPage />);
  await screen.findByText("PRIVATE_CANDIDATE");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save to my knowledge model" }));
  await waitFor(() => expect(state.track).toHaveBeenCalledExactlyOnceWith("one_career_action", { action: "resume_save", result: committed ? "success" : "error" }));
  expect(JSON.stringify(state.track.mock.calls)).not.toContain("PRIVATE");
});

it.each(["success", "error"] as const)("records the application attempt %s and preserves partial receipt semantics", async result => {
  state.roles.mockResolvedValue([{ family: "vacancy", slug: "PRIVATE_ROLE_ID", title: "Synthetic role", group: "Synthetic team", cities: [] }]);
  if (result === "success") state.apply.mockResolvedValue({ result: {}, receiptSaved: false, receipt: { receipt_id: "PRIVATE_RECEIPT_ID", role_slug: "PRIVATE_ROLE_ID", role_title: "Synthetic role", sent_at: "2026-11-27T00:00:00Z" } });
  else state.apply.mockRejectedValue(new Error("PRIVATE_PROVIDER_DIAGNOSTIC"));
  render(<CareerPage />);
  await screen.findByText("PRIVATE_CANDIDATE");
  fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
  expect(state.track).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send application" }));
  await waitFor(() => expect(state.track).toHaveBeenCalledExactlyOnceWith("one_career_action", { action: "application_send", result }));
  expect(JSON.stringify(state.track.mock.calls)).not.toContain("PRIVATE");
});
