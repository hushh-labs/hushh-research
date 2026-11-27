// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { NativeWorkspaceSurfaceSection } from "@/lib/capacitor/native-workspace-surface";
import { normalizeResume } from "@/lib/career/resume";
const state = vi.hoisted(() => ({ owner: "owner-a", load: vi.fn(), roles: vi.fn(), saveResume: vi.fn(), apply: vi.fn(), parse: vi.fn(), receipt: vi.fn(), record: vi.fn(), track: vi.fn(), sections: [] as NativeWorkspaceSurfaceSection[], back: null as null | (() => boolean), depth: 0 }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: state.track }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: state.owner }, userId: state.owner }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true, vaultKey: "synthetic-key", vaultOwnerToken: "synthetic-token" }) }));
vi.mock("@/lib/capacitor/native-workspace-surface", () => ({ NativeWorkspaceRoute: ({ children, sections }: { children: ReactNode; sections: NativeWorkspaceSurfaceSection[] }) => { state.sections = sections; return children; } }));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: (_path: string, depth: number, back: () => boolean) => { state.depth = depth; state.back = back; } }));
vi.mock("@/components/app-ui/app-page-shell", () => ({ AppPageShell: ({ children }: { children: ReactNode }) => <main>{children}</main>, AppPageContentRegion: ({ children }: { children: ReactNode }) => <div>{children}</div>, AppPageHeaderRegion: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/app-ui/page-sections", () => ({ PageHeader: () => <h1>Career</h1> }));
vi.mock("@/components/icons", () => ({ Briefcase: () => null }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ Button: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
vi.mock("@/lib/capacitor/native-feedback", () => ({ nativeFeedbackToast: { error: vi.fn(), message: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/services/career-pkm-service", () => ({ CareerPkmService: { load: state.load, saveResume: state.saveResume, recordApplication: state.record } }));
vi.mock("@/lib/services/career-service", () => ({ CareerService: { listRoles: state.roles, parseResume: state.parse, applyToRole: state.apply, issueConsentReceipt: state.receipt } }));
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import CareerPage from "@/app/one/career/page";
beforeEach(() => { vi.clearAllMocks(); state.owner = "owner-a"; publishValidatedAuthSessionOwner(state.owner); state.roles.mockResolvedValue([]); });
it("does not expose a previous owner's late resume to another unlocked owner", async () => {
  let resolveOld!: (value: unknown) => void;
  state.load.mockImplementation(({ userId }: { userId: string }) => userId === "owner-a"
    ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ resume: normalizeResume({ name: "Synthetic new owner" }), applications: [] }));
  const view = render(<CareerPage />);
  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(1));
  state.owner = "owner-b";
  view.rerender(<CareerPage />);
  await screen.findByText("Synthetic new owner");
  await act(async () => { resolveOld({ resume: normalizeResume({ name: "Synthetic old owner" }), applications: [] }); });
  expect(screen.queryByText("Synthetic old owner")).toBeNull();
  expect(screen.getByText("Synthetic new owner")).toBeVisible();
  expect(state.load).toHaveBeenCalledTimes(2);
});
it("reports a failed read and retries through the existing reader", async () => {
  state.load.mockRejectedValueOnce(new Error("synthetic failure")).mockResolvedValue({ resume: normalizeResume({ name: "Synthetic recovered resume" }), applications: [] });
  render(<CareerPage />);
  await screen.findByText("Couldn’t load your resume. Try again.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Synthetic recovered resume")).toBeVisible();
});

it("authored Back cancels a resume draft without calling the existing writer", async () => {
  state.load.mockResolvedValue({ resume: normalizeResume({ name: "Synthetic saved resume" }), applications: [] });
  render(<CareerPage />);
  await screen.findByText("Synthetic saved resume");
  act(() => { state.sections.flatMap(section => section.rows).find(row => row.key === "edit")!.run!(); });
  fireEvent.change(screen.getByLabelText("name", { exact: false }), { target: { value: "Synthetic unsaved draft" } });
  expect(state.depth).toBe(1);
  act(() => { expect(state.back!()).toBe(true); });
  expect(screen.queryByText("Check your resume")).toBeNull();
  expect(screen.getByText("Synthetic saved resume")).toBeVisible();
  expect(state.saveResume).not.toHaveBeenCalled();
});

it("retains the draft when the coordinator does not commit the save", async () => {
  state.load.mockResolvedValue({ resume: normalizeResume({ name: "Synthetic saved resume" }), applications: [] });
  state.saveResume.mockResolvedValue({ success: false });
  render(<CareerPage />);
  await screen.findByText("Synthetic saved resume");
  act(() => { state.sections.flatMap(section => section.rows).find(row => row.key === "edit")!.run!(); });
  fireEvent.change(screen.getByLabelText("name", { exact: false }), { target: { value: "Synthetic unsaved draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save to my knowledge model" }));
  await waitFor(() => expect(state.saveResume).toHaveBeenCalledOnce());
  expect(state.track).toHaveBeenCalledExactlyOnceWith("one_career_action", { action: "resume_save", result: "error" });
  expect(screen.getByText("Check your resume")).toBeVisible();
  expect(screen.getByLabelText("name", { exact: false })).toHaveValue("Synthetic unsaved draft");
  state.saveResume.mockResolvedValue({ success: true });
  fireEvent.click(screen.getByRole("button", { name: "Save to my knowledge model" }));
  await screen.findByText("Synthetic unsaved draft");
  expect(state.track).toHaveBeenNthCalledWith(2, "one_career_action", { action: "resume_save", result: "success" });
  expect(screen.queryByText("Check your resume")).toBeNull();
  expect(state.sections[0]!.rows.find(row => row.key === "resume-summary")!.label).toBe("Synthetic unsaved draft");
});

it("native Apply opens exact-content review and Cancel never sends an application", async () => {
  const resume = normalizeResume({ name: "Synthetic Candidate", summary: "Synthetic reviewed resume" });
  state.load.mockResolvedValue({ resume, applications: [] });
  state.roles.mockResolvedValue([{ family: "vacancy", slug: "synthetic-role", title: "Synthetic role", group: "Synthetic team", cities: [] }]);
  const scroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  try {
    render(<CareerPage />);
    await screen.findByText("Synthetic Candidate");
    await waitFor(() => expect(state.sections.flatMap(section => section.rows).some(row => row.key === "role:vacancy:synthetic-role")).toBe(true));
    act(() => { state.sections.flatMap(section => section.rows).find(row => row.key === "role:vacancy:synthetic-role")!.run!(); });
    expect(screen.getByText("Apply to Synthetic role?")).toBeVisible();
    expect(screen.getByText(/Synthetic reviewed resume/)).toBeVisible();
    expect(state.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    expect(screen.queryByText("Apply to Synthetic role?")).toBeNull();
    expect(state.apply).not.toHaveBeenCalled();
  } finally { HTMLElement.prototype.scrollIntoView = scroll; }
});

it.each([true, false])("observes a resume parse terminal result (success: %s) without file content", async (success) => {
  state.load.mockResolvedValue({ resume: null, applications: [] });
  if (success) state.parse.mockResolvedValue({ resume: normalizeResume({ name: "Private resume" }), truncated: false });
  else state.parse.mockRejectedValue(new Error("Private provider diagnostic"));
  const view = render(<CareerPage />);
  await waitFor(() => expect(state.load).toHaveBeenCalledOnce());
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["private content"], "private-resume.pdf", { type: "application/pdf" })] } });
  await waitFor(() => expect(state.track).toHaveBeenCalledExactlyOnceWith("one_career_action", { action: "resume_parse", result: success ? "success" : "error" }));
});

it.each([true, false])("observes the application result independently of receipt persistence (success: %s)", async (success) => {
  state.load.mockResolvedValue({ resume: normalizeResume({ name: "Private candidate", summary: "Private resume" }), applications: [] });
  state.roles.mockResolvedValue([{ family: "vacancy", slug: "private-role", title: "Private role", group: "Team", cities: [] }]);
  state.receipt.mockResolvedValue("private-receipt");
  state.record.mockResolvedValue({ success: false });
  if (success) state.apply.mockResolvedValue({ reference: "private-reference" });
  else state.apply.mockRejectedValue(new Error("Private provider failure"));
  const scroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  try {
    render(<CareerPage />);
    await screen.findByText("Private candidate");
    fireEvent.click(await screen.findByRole("button", { name: "Apply", exact: true }));
    expect(state.track).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send application" }));
    await waitFor(() => expect(state.track).toHaveBeenCalledExactlyOnceWith("one_career_action", { action: "application_send", result: success ? "success" : "error" }));
    expect(state.apply).toHaveBeenCalledOnce();
    expect(state.record).toHaveBeenCalledTimes(success ? 1 : 0);
  } finally { HTMLElement.prototype.scrollIntoView = scroll; }
});

it("does not attribute a late resume save to the next owner", async () => {
  state.load.mockResolvedValue({ resume: normalizeResume({ name: "Private resume" }), applications: [] });
  let finish!: (result: { success: boolean }) => void;
  state.saveResume.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<CareerPage />);
  await screen.findByText("Private resume");
  act(() => { state.sections.flatMap(section => section.rows).find(row => row.key === "edit")!.run!(); });
  fireEvent.click(screen.getByRole("button", { name: "Save to my knowledge model" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  state.owner = "owner-b";
  publishValidatedAuthSessionOwner(state.owner);
  view.rerender(<CareerPage />);
  await act(async () => finish({ success: true }));
  expect(state.track).not.toHaveBeenCalled();
});
