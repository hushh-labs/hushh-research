// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CirclePhotoEditor } from "@/components/connect/circles/circle-photo-editor";

import {
  CircleDetailFlow,
  CirclesSection,
  CreateCircleFlow,
  useCreateCircleFlow,
  JoinCircleFlow,
} from "@/components/one-location/redesign/circles/named-circle-flows";
import { CIRCLE_MEMBER_MENU_CLASSNAME } from "@/components/one-location/redesign/circles/circle-member-row-layout";
import { useCreateCirclePeopleModel } from "@/components/one-location/redesign/circles/create-circle-people-step";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import type {
  OneLocationCircleDetail,
  OneLocationCircleInvitePreview,
  OneLocationCircleMemberInvite,
  OneLocationCircleMemberPage,
} from "@/lib/one-location/types";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function circle(id: string, name: string): OneLocationCircleDetail {
  return {
    id,
    name,
    kind: "family",
    role: "owner",
    memberCount: 1,
    memberLimit: 20,
    viewerCapabilities: {
      canInviteMembers: true,
      canViewInviteCode: true,
      canRotateInviteCode: true,
      canManageCircle: true,
      canModerateInvites: true,
    },
    members: [
      {
        userId: "owner-user",
        displayName: "Owner",
        role: "owner",
        phoneVerified: true,
        secureLocationReady: true,
      },
    ],
  };
}

function createProps() {
  return {
    busy: false,
    onSubmit: vi.fn(async () => circle("new-circle", "Roommates")),
    onLoadPeople: vi.fn(async () => ({
      eligibleConnections: [{ connectionId: "c-asha", userId: "asha", displayName: "Asha Meena", isRia: false }],
      pendingInvites: [], remainingCapacity: 99, page: 1, hasMore: false, totalCount: 1,
    })),
    onAddPeople: vi.fn(async () => undefined),
    onComplete: vi.fn(),
  };
}

function detailProps(
  onLoad: (circleId: string) => Promise<OneLocationCircleDetail>,
) {
  return {
    currentUserId: "owner-user",
    busy: false,
    onBack: vi.fn(),
    onLoad,
    onRename: vi.fn(async (circleId: string, name: string) =>
      circle(circleId, name),
    ),
    onGenerateCode: vi.fn(),
    onCopyCode: vi.fn(),
    onShareCode: vi.fn(),
    onShareWithMember: vi.fn(),
    onRemoveMember: vi.fn(),
    onLoadEligibleConnections: vi.fn(async () => ({
      eligibleConnections: [],
      pendingInvites: [],
      remainingCapacity: 0,
    })),
    onInviteConnections: vi.fn(),
    onCancelMemberInvite: vi.fn(),
    onConnectMember: vi.fn(async () => undefined),
    onLeave: vi.fn(),
    onDelete: vi.fn(),
  };
}

describe("named Circle flows", () => {
  it.each([false, true])("uses the SMS text-style Add people entry for named circles (living=%s)", async (livingCircleExperience) => {
    render(<CircleDetailFlow circleId="family" livingCircleExperience={livingCircleExperience} {...detailProps(async () => circle("family", "Family"))} />);
    const add = await screen.findByRole("button", { name: "Add people", exact: true });
    expect(add).toHaveClass("bg-transparent");
    expect(add.querySelector("svg.profile-pane-icon .profile-pane-icon-accent")).toBeTruthy();
    expect(add.querySelector('[data-slot="settings-row-chevron"]')).toBeNull();
    fireEvent.click(add);
    expect(await screen.findByRole("dialog", { name: "Add people" })).toBeVisible();
  });

  it("retains the created ID if the server drops a custom type, then updates it on retry", async () => {
    const props = createProps();
    const saved = { ...circle("new-circle", "Investments"), kind: "other" as const };
    const onSubmit = vi.fn().mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, customTypeLabel: "Finance" });
    const { result } = renderHook(() => useCreateCircleFlow({ ...props, onSubmit, customTypesSupported: true }));
    act(() => { result.current.changeDraft({ name: "Investments", kind: "other", customTypeLabel: "Finance" }); });
    await act(async () => { expect(await result.current.prepare()).toBe(false); });
    expect(result.current.savedCircle?.id).toBe("new-circle");
    await act(async () => { expect(await result.current.prepare()).toBe(true); });
    expect(onSubmit).toHaveBeenLastCalledWith("Investments", "other", "new-circle", "Finance");
  });

  it("allows changing a saved Circle's type after the refreshed list reaches the cap", async () => {
    const props = createProps();
    const onSubmit = vi.fn().mockImplementation(async (name: string, _kind: string, _id?: string, label?: string) => ({ ...circle("new-circle", name), kind: "other", customTypeLabel: label }));
    const { result, rerender } = renderHook(({ types }) => useCreateCircleFlow({ ...props, onSubmit, customTypesSupported: true, customTypes: types }), { initialProps: { types: ["Finance", "Sports"] } });
    act(() => { result.current.changeDraft({ name: "Trips", kind: "other", customTypeLabel: "Travel" }); });
    await act(async () => { expect(await result.current.prepare()).toBe(true); });
    act(() => result.current.backToDetails());
    rerender({ types: ["Finance", "Sports", "Travel"] });
    act(() => { result.current.setCustomTypeLabel("Work"); });
    expect(result.current.canSubmit).toBe(true);
    await act(async () => { expect(await result.current.prepare()).toBe(true); });
    expect(onSubmit).toHaveBeenLastCalledWith("Trips", "other", "new-circle", "Work");
  });
  it("offers saved custom types and saves a different Circle name under that type", async () => {
    const props = createProps();
    props.onSubmit.mockResolvedValue({ ...circle("new-circle", "Investments"), kind: "other", customTypeLabel: "Finance" });
    render(<CreateCircleFlow {...props} customTypesSupported customTypes={["Finance"]} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Circle name" }), { target: { value: "Investments" } });
    fireEvent.click(screen.getByRole("radio", { name: "Finance", exact: true }));
    expect(screen.getByRole("textbox", { name: "Type name (optional)" })).toHaveValue("Finance");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith("Investments", "other", undefined, "Finance"));
    await screen.findByRole("button", { name: "Add people later" });
  });

  it("bounds new custom types while allowing an existing type to be reused", () => {
    render(<CreateCircleFlow {...createProps()} customTypesSupported customTypes={["Finance", "Sports", "Travel"]} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Circle name" }), { target: { value: "Project team" } });
    fireEvent.click(screen.getByRole("radio", { name: "Other", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "Type name (optional)" }), { target: { value: "Work" } });
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByText(/Delete a type before adding another/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Finance", exact: true }));
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    expect(screen.getAllByRole("radio")).toHaveLength(6);
  });

  it("does not expose custom-type controls without backend support", () => {
    render(<CreateCircleFlow {...createProps()} customTypes={["Finance"]} />);
    fireEvent.click(screen.getByRole("radio", { name: "Other", exact: true }));
    expect(screen.queryByRole("radio", { name: "Finance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Type name (optional)" })).not.toBeInTheDocument();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("retains the 20-person batch cap and allows deselection at capacity", async () => {
    const props = createProps();
    const people = Array.from({ length: 21 }, (_, index) => ({
      connectionId: `connection-${index}`, userId: `person-${index}`, displayName: `Person ${index}`, isRia: false,
    }));
    const onLoad = vi.fn(async () => ({ eligibleConnections: people, pendingInvites: [], remainingCapacity: 99, page: 1, hasMore: false, totalCount: people.length }));
    const { result } = renderHook(() => useCreateCirclePeopleModel({
      circleId: "new-circle", circleName: "Roommates", active: true,
      onLoad, onAdd: props.onAddPeople, onComplete: props.onComplete, onBack: vi.fn(), onSavingChange: vi.fn(),
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { people.forEach(person => result.current.add(person.userId)); });
    expect(result.current.limit).toBe(20);
    expect(result.current.selected).toHaveLength(20);
    act(() => result.current.remove("person-0"));
    act(() => result.current.add("person-20"));
    await act(async () => result.current.finish(true));
    expect(props.onAddPeople).toHaveBeenCalledWith("new-circle", people.slice(1).map(person => person.userId));
  });

  it.each([true, false])("settles the retained people model before creating another Circle (add selected: %s)", async (addSelected) => {
    const props = createProps();
    const { result, rerender } = renderHook(({ circleId }) => useCreateCirclePeopleModel({
      circleId, circleName: "Roommates", active: true,
      onLoad: props.onLoadPeople, onAdd: props.onAddPeople,
      onComplete: props.onComplete, onBack: vi.fn(), onSavingChange: vi.fn(),
    }), { initialProps: { circleId: "first-circle" } });

    for (const circleId of ["first-circle", "second-circle"]) {
      if (circleId === "second-circle") rerender({ circleId });
      await waitFor(() => expect(result.current.loading).toBe(false));
      if (addSelected) act(() => result.current.add("asha"));
      await act(async () => result.current.finish(addSelected));
      expect(props.onComplete).toHaveBeenLastCalledWith(circleId);
      expect(result.current.saving).toBe(false);
      expect(result.current.mutationPending()).toBe(false);
    }
    expect(props.onComplete).toHaveBeenCalledTimes(2);
    expect(props.onAddPeople).toHaveBeenCalledTimes(addSelected ? 2 : 0);
    if (addSelected) expect(props.onAddPeople).toHaveBeenLastCalledWith("second-circle", ["asha"]);
  });

  it("adds selected contacts in step 2 without creating another Circle on retry", async () => {
    const props = createProps();
    props.onAddPeople.mockRejectedValueOnce(new Error("Temporarily unavailable"));
    render(<CreateCircleFlow {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Circle name" }), { target: { value: "Roommates" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const choice = await screen.findByRole("button", { name: "Add Asha Meena" });
    expect(choice).toHaveAccessibleDescription("Connection details unavailable");
    fireEvent.click(choice);
    expect(props.onAddPeople).not.toHaveBeenCalled();
    expect(props.onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person", exact: true }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not add those people. Try again or add people later."));
    expect(screen.getByRole("button", { name: "Remove Asha Meena" })).toBeEnabled();
    expect(props.onComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person", exact: true }));
    await waitFor(() => expect(props.onComplete).toHaveBeenCalledWith("new-circle"));
    expect(props.onAddPeople).toHaveBeenNthCalledWith(2, "new-circle", ["asha"]);
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("can defer people while contacts are loading or unavailable", async () => {
    const props = createProps();
    props.onLoadPeople.mockRejectedValue(new Error("Unavailable"));
    render(<CreateCircleFlow {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Circle name" }), { target: { value: "Roommates" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Could not load your contacts.");
    fireEvent.click(screen.getByRole("button", { name: "Add people later" }));
    expect(props.onComplete).toHaveBeenCalledWith("new-circle");
    expect(props.onAddPeople).not.toHaveBeenCalled();
  });

  it("Back retains the saved Circle and selection, then updates changed details", async () => {
    const props = createProps();
    render(<CreateCircleFlow {...props} pathname={ROUTES.CONNECT} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Circle name" }), { target: { value: "Roommates" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Asha Meena" }));
    act(() => { expect(unwindBackLayer(ROUTES.CONNECT, new URLSearchParams("action=create-circle"))).toBe(true); });
    expect(screen.getByRole("textbox", { name: "Circle name" })).toHaveValue("Roommates");
    fireEvent.change(screen.getByRole("textbox", { name: "Circle name" }), { target: { value: "Close friends" } });
    fireEvent.click(screen.getByRole("radio", { name: "Friends" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(props.onSubmit).toHaveBeenLastCalledWith("Close friends", "friends", "new-circle"));
    expect(screen.getByRole("button", { name: "Remove Asha Meena" })).toBeInTheDocument();
  });

  it("consumes Back and repeated add taps until membership is saved", async () => {
    const props = createProps();
    let resolveAdd!: () => void;
    props.onAddPeople.mockImplementation(() => new Promise<void>((resolve) => { resolveAdd = resolve; }));
    render(<CreateCircleFlow {...props} pathname={ROUTES.CONNECT} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Circle name" }), { target: { value: "Roommates" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Asha Meena" }));
    const add = screen.getByRole("button", { name: "Add 1 person", exact: true });
    fireEvent.click(add);
    fireEvent.click(add);
    act(() => { expect(unwindBackLayer(ROUTES.CONNECT, new URLSearchParams("action=create-circle"))).toBe(true); });
    expect(screen.getByRole("heading", { name: "Add people" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add people later" })).toBeDisabled();
    expect(props.onAddPeople).toHaveBeenCalledTimes(1);
    await act(async () => resolveAdd());
    expect(props.onComplete).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("retains the selected identity and an early rename through roster loading (saved: %s)", async (saveRename) => {
    let overview!: (value: OneLocationCircleDetail) => void;
    let roster!: (value: OneLocationCircleMemberPage) => void;
    const props = detailProps(vi.fn());
    const onLoadOverview = vi.fn(() => new Promise<OneLocationCircleDetail>((resolve) => { overview = resolve; }));
    const pendingRoster = new Promise<OneLocationCircleMemberPage>((resolve) => { roster = resolve; });
    const onLoadMembersPage = vi.fn(() => pendingRoster);
    render(<CircleDetailFlow circleId="emergency" initialCircleSummary={{ id: "emergency", name: "Emergency contacts", memberCount: 3 }}
      {...props} onLoadOverview={onLoadOverview} onLoadMembersPage={onLoadMembersPage} />);
    expect(screen.getByRole("heading", { name: "Emergency contacts" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading circle members" })).toBeInTheDocument();
    expect(screen.queryByText("Loading Circle…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    await act(async () => overview(circle("emergency", "Updated circle")));
    expect(screen.getByRole("heading", { name: "Updated circle" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading circle members" })).toBeInTheDocument();
    expect(screen.queryByText("No members found")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    fireEvent.change(await screen.findByLabelText("Circle name"), { target: { value: "My renamed circle" } });
    if (saveRename) {
      fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
      await waitFor(() => expect(screen.queryByLabelText("Circle name")).not.toBeInTheDocument());
    }
    await act(async () => roster({ items: circle("emergency", "Updated circle").members, page: 1, hasMore: false, totalCount: 1 }));
    if (saveRename) {
      expect(screen.getByRole("heading", { name: "My renamed circle" })).toBeInTheDocument();
    } else {
      expect(screen.getByLabelText("Circle name")).toHaveValue("My renamed circle");
      expect(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
    }
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading circle members" })).not.toBeInTheDocument();
  });

  it("keeps a newer member search when the initial roster finishes late", async () => {
    const current = { ...circle("family", "Family"), memberCount: 8 };
    const asha = { ...current.members[0]!, userId: "asha", displayName: "Asha Rao", role: "member" as const };
    let initialRoster!: (page: OneLocationCircleMemberPage) => void;
    const pending = new Promise<OneLocationCircleMemberPage>((resolve) => { initialRoster = resolve; });
    const onLoadMembersPage = vi.fn((_id: string, options: { query?: string }) => options.query
      ? Promise.resolve({ items: [asha], page: 1, hasMore: false, totalCount: 1 })
      : pending);
    render(<CircleDetailFlow circleId="family" {...detailProps(vi.fn())}
      onLoadOverview={async () => current} onLoadMembersPage={onLoadMembersPage} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Search members" }), { target: { value: "Asha" } });
    await screen.findByText("Asha Rao");
    await act(async () => initialRoster({ items: [...current.members, asha], page: 1, hasMore: false, totalCount: 8 }));
    expect(screen.getByRole("textbox", { name: "Search members" })).toHaveValue("Asha");
    expect(screen.getByText("Asha Rao")).toBeInTheDocument();
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(screen.getByText("1 match")).toBeInTheDocument();
  });

  it("keeps a failed first roster distinct from an empty circle and recovers on retry", async () => {
    const current = circle("emergency", "Emergency contacts");
    const props = detailProps(vi.fn());
    const onLoadOverview = vi.fn(async () => current);
    const onLoadMembersPage = vi.fn().mockRejectedValue(new Error("Members unavailable"));
    render(<CircleDetailFlow circleId="emergency" {...props} onLoadOverview={onLoadOverview} onLoadMembersPage={onLoadMembersPage} />);
    await screen.findByText("Members unavailable");
    expect(screen.getByRole("heading", { name: "Emergency contacts" })).toBeInTheDocument();
    expect(screen.queryByText("No members found")).not.toBeInTheDocument();
    expect(screen.queryByText("Try a different name.")).not.toBeInTheDocument();
    onLoadMembersPage.mockResolvedValue({ items: current.members, page: 1, hasMore: false, totalCount: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Retry", exact: true }));
    await screen.findByText("Owner");
    expect(screen.queryByText("Members unavailable")).not.toBeInTheDocument();
  });

  it("closes an open invitation sheet as soon as fresh overview revokes permission while the roster is pending", async () => {
    const current = circle("family", "Family");
    const props = detailProps(vi.fn());
    props.onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [{ connectionId: "connection-asha", userId: "asha", displayName: "Asha Rao" }],
      pendingInvites: [], remainingCapacity: 19,
    }));
    const onLoadOverview = vi.fn().mockResolvedValue(current);
    const onLoadMembersPage = vi.fn().mockResolvedValue({ items: current.members, page: 1, hasMore: false, totalCount: 1 });
    const view = render(<CircleDetailFlow circleId="family" {...props} onLoadOverview={onLoadOverview} onLoadMembersPage={onLoadMembersPage} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    fireEvent.click(await screen.findByRole("button", { name: /^(?!View ).*Asha Rao/i }));
    expect(screen.getByRole("button", { name: "Add 1 person" })).toBeEnabled();
    onLoadOverview.mockResolvedValue({ ...current, viewerCapabilities: { ...current.viewerCapabilities, canInviteMembers: false } });
    let rejectRoster!: (error: Error) => void;
    const pendingRoster = new Promise((_, reject) => { rejectRoster = reject; });
    onLoadMembersPage.mockReturnValue(pendingRoster);
    view.rerender(<CircleDetailFlow circleId="family" reloadSignal={1} {...props} onLoadOverview={onLoadOverview} onLoadMembersPage={onLoadMembersPage} />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add people" })).not.toBeInTheDocument());
    expect(props.onInviteConnections).not.toHaveBeenCalled();
    await act(async () => rejectRoster(new Error("Members unavailable")));
    expect(screen.queryByRole("button", { name: "Add 1 person" })).not.toBeInTheDocument();
  });

  it("withholds old detail and ignores late responses after an unlock scope changes", async () => {
    const first = circle("same-circle", "Old private circle");
    let stale!: (value: OneLocationCircleDetail) => void;
    const load = vi.fn().mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise((resolve) => { stale = resolve; }))
      .mockRejectedValueOnce(new Error("New session unavailable"));
    const props = detailProps(load);
    const view = render(<CircleDetailFlow circleId="same-circle" sessionScope="first-unlock" {...props} />);
    await screen.findByRole("heading", { name: "Old private circle" });
    view.rerender(<CircleDetailFlow circleId="same-circle" sessionScope="first-unlock" reloadSignal={1} {...props} />);
    await waitFor(() => expect(stale).toBeDefined());
    view.rerender(<CircleDetailFlow circleId="same-circle" sessionScope="next-unlock" reloadSignal={1}
      initialCircleSummary={{ id: "another-circle", name: "Wrong seed", memberCount: 3 }} {...props} />);
    expect(screen.queryByRole("heading", { name: "Old private circle" })).not.toBeInTheDocument();
    expect(screen.queryByText("Wrong seed")).not.toBeInTheDocument();
    await screen.findByText("New session unavailable");
    await act(async () => stale(first));
    expect(screen.queryByRole("heading", { name: "Old private circle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("guides a new circle through a failed add, retry, confirmed membership, and opening chat", async () => {
    let current = circle("family", "Family");
    const props = detailProps(vi.fn(async () => current));
    props.onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: current.memberCount === 1 ? [{
        connectionId: "connection-asha", userId: "asha", displayName: "Asha Rao",
      }] : [],
      pendingInvites: [],
      remainingCapacity: 20 - current.memberCount,
    }));
    props.onInviteConnections = vi.fn()
      .mockRejectedValueOnce(new Error("Try again"))
      .mockImplementation(async () => {
        current = { ...current, memberCount: 2, members: [...current.members, {
          userId: "asha", displayName: "Asha Rao", role: "member",
          phoneVerified: true, secureLocationReady: true,
        }] };
      });
    const onComplete = vi.fn();
    render(<CircleDetailFlow circleId="family" livingCircleExperience memberSetup
      onMemberSetupComplete={onComplete} renderChat={() => <p>Circle conversation</p>} {...props} />);
    await openCirclePeoplePicker();
    expect(screen.getByRole("dialog", { name: "Add people" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Add your first member" })).toBeNull();
    expect(screen.queryByText(/Choose at least one connection below/)).toBeNull();
    expect(screen.getByText("Circle conversation")).not.toBeVisible();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Add Asha Rao to Family" }));
    fireEvent.click(screen.getByRole("button", { name: "Add people", exact: true }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Try again"));
    const retry = screen.getByRole("button", { name: "Add people", exact: true });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
    fireEvent.click(retry);
    fireEvent.click(retry);
    await screen.findByRole("heading", { name: "Your Circle is ready" });
    expect(props.onInviteConnections).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(screen.getByText("Circle conversation")).toBeVisible();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it.each([
    { count: 1, chatIntent: false, view: "Members" },
    { count: 2, chatIntent: false, view: "Chat" },
    { count: 1, chatIntent: true, view: "Chat" },
  ])("opens $view for count=$count and chatIntent=$chatIntent without a creation flag", async ({ count, chatIntent, view }) => {
    const props = detailProps(async () => ({ ...circle("family", "Family"), memberCount: count }));
    render(<CircleDetailFlow circleId="family" livingCircleExperience chatIntent={chatIntent}
      renderChat={() => <p>Circle conversation</p>} {...props} />);
    await screen.findByRole("heading", { name: "Family" });
    await waitFor(() => expect(screen.getByRole("tab", { name: view })).toHaveAttribute("aria-selected", "true"));
    if (count === 1 && !chatIntent) {
      // Established solo circles can still contain history after members leave.
      expect(screen.getByRole("tab", { name: "Chat" })).toBeEnabled();
    }
  });

  it("retains an explicit chat entry after consuming its URL intent and refreshing the roster", async () => {
    const props = detailProps(vi.fn(async () => circle("family", "Family")));
    const renderChat = () => <p>Circle conversation</p>;
    const { rerender } = render(<CircleDetailFlow circleId="family" livingCircleExperience chatIntent
      renderChat={renderChat} {...props} />);
    await screen.findByRole("heading", { name: "Family" });
    rerender(<CircleDetailFlow circleId="family" livingCircleExperience chatIntent={false}
      reloadSignal={1} renderChat={renderChat} {...props} />);
    await waitFor(() => expect(props.onLoad).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Circle conversation")).toBeVisible();
  });

  it("offers recovery without eligible connections and waits for membership after sharing a code", async () => {
    const current = { ...circle("family", "Family"), activeInviteCode: {
      id: "code-1", circleId: "family", code: "2345-6789-ABCD", expiresAt: null,
    } };
    const props = detailProps(vi.fn(async () => current));
    props.onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [], pendingInvites: [], remainingCapacity: 19,
    }));
    render(<CircleDetailFlow circleId="family" livingCircleExperience memberSetup
      renderChat={() => <p>Circle conversation</p>} {...props} />);
    await openCirclePeoplePicker();
    await screen.findByText("No connections available to add.");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /Invite code/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Share invite" }));
    await waitFor(() => expect(props.onShareCode).toHaveBeenCalledWith(current, current.activeInviteCode.code));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("tab", { name: "Members" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Chat" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
    expect(props.onInviteConnections).not.toHaveBeenCalled();
  });

  it.each(["tap"] as const)(
    "adds a Connect circle candidate by %s and refreshes the orbit, roster, and eligible list",
    async (method) => {
      let current = circle("family", "Family");
      const onLoad = vi.fn(async () => current);
      const props = detailProps(onLoad);
      props.onLoadEligibleConnections = vi.fn(async () => ({
        eligibleConnections: current.memberCount === 1 ? [{
          connectionId: "connection-asha",
          userId: "asha",
          displayName: "member@example.test",
          photoUrl: null,
          isRia: false,
        }] : [],
        pendingInvites: [],
        remainingCapacity: 20 - current.memberCount,
      }));
      props.onInviteConnections = vi.fn(async () => {
        current = {
          ...current,
          memberCount: 2,
          members: [...current.members, {
            userId: "asha",
            displayName: "member@example.test",
            role: "member",
            phoneVerified: true,
            secureLocationReady: true,
          }],
        };
      });
      render(<CircleDetailFlow circleId="family" livingCircleExperience {...props} />);
    await openCirclePeoplePicker();
      const addButton = await screen.findByRole("checkbox", { name: "Add Hussh member to Family" });

      expect(method).toBe("tap");
      fireEvent.click(addButton);
      expect(props.onInviteConnections).not.toHaveBeenCalled();
      expect(addButton).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByRole("button", { name: "Add people", exact: true }));
      await waitFor(() => expect(props.onInviteConnections).toHaveBeenCalledWith("family", ["asha"]));
      await waitFor(() => expect(within(screen.getByTestId("one-location-circle-members")).getByText("Hussh member")).toBeTruthy());
      expect(screen.queryByText("member@example.test")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Add Hussh member to Family" })).toBeNull());
      expect(props.onInviteConnections).toHaveBeenCalledTimes(1);
    },
  );

  it("distinguishes sanitized names with relationship context and submits the selected identity", async () => {
    const props = detailProps(vi.fn(async () => circle("family", "Family")));
    props.onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [
        { connectionId: "connection-one", userId: "one", displayName: "one@example.test", photoUrl: null, isRia: false, connectedAt: "2026-10-18T10:00:00Z" },
        { connectionId: "connection-two", userId: "two", displayName: "two@example.test", photoUrl: null, isRia: false, connectedAt: "2026-10-19T11:30:00Z" },
        { connectionId: "connection-three", userId: "three", displayName: "***1234", photoUrl: null, isRia: false, connectedAt: "invalid" },
      ], pendingInvites: [], remainingCapacity: 19,
    }));
    render(<CircleDetailFlow circleId="family" livingCircleExperience {...props} />);
    await openCirclePeoplePicker();
    const choices = await screen.findAllByRole("checkbox", { name: "Add Hussh member to Family" });
    expect(choices).toHaveLength(3);
    expect(choices[0]).toHaveAccessibleDescription(/^Connected /);
    expect(choices[1]).toHaveAccessibleDescription(/^Connected /);
    const description = (choice: HTMLElement) => document.getElementById(choice.getAttribute("aria-describedby")!)!.textContent!;
    const selectedDescription = description(choices[1]);
    expect(description(choices[0])).not.toBe(selectedDescription);
    expect(choices[2]).toHaveAccessibleDescription("Connection details unavailable");
    expect(choices[0].getAttribute("aria-describedby")).not.toBe(choices[1].getAttribute("aria-describedby"));
    expect(screen.queryByText(/one@example|two@example|\*\*\*1234/)).toBeNull();
    fireEvent.click(choices[1]);
    fireEvent.click(screen.getByRole("tab", { name: "Selected (1)" }));
    expect(screen.getByRole("checkbox", { name: "Add Hussh member to Family" })).toHaveAccessibleDescription(selectedDescription);
    fireEvent.click(screen.getByRole("button", { name: "Add people", exact: true }));
    await waitFor(() => expect(props.onInviteConnections).toHaveBeenCalledWith("family", ["two"]));
  });

  it("selects multiple people instantly, batches one save, and keeps choices available during slow reconciliation", async () => {
    const people = ["Asha", "Jordan", "Alex"].map((name) => ({
      connectionId: `c-${name}`, userId: name, displayName: name,
    }));
    let finishSave!: () => void;
    let finishRead!: () => void;
    const slowRead = new Promise<void>((resolve) => { finishRead = resolve; });
    const current = circle("family", "Family");
    const onLoad = vi.fn().mockResolvedValueOnce(current).mockImplementation(async () => {
      await slowRead;
      throw new Error("Roster temporarily unavailable");
    });
    const props = detailProps(onLoad);
    props.onLoadEligibleConnections = vi.fn().mockResolvedValueOnce({
      eligibleConnections: people, pendingInvites: [], remainingCapacity: 3,
    }).mockImplementation(async () => {
      await slowRead;
      return { eligibleConnections: [people[2]], pendingInvites: [], remainingCapacity: 1 };
    });
    props.onInviteConnections = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    render(<CircleDetailFlow circleId="family" livingCircleExperience {...props} />);
    await openCirclePeoplePicker();
    const asha = await screen.findByRole("checkbox", { name: "Add Asha to Family" });
    fireEvent.click(asha);
    fireEvent.click(screen.getByRole("checkbox", { name: "Add Jordan to Family" }));
    expect(asha).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: "Add Jordan to Family" })).toHaveAttribute("aria-checked", "true");
    expect(props.onInviteConnections).not.toHaveBeenCalled();
    const commit = screen.getByRole("button", { name: "Add people", exact: true });
    fireEvent.click(commit);
    fireEvent.click(commit);
    expect(props.onInviteConnections).toHaveBeenCalledExactlyOnceWith("family", ["Asha", "Jordan"]);
    expect(screen.getByRole("button", { name: "Adding people…" })).toBeDisabled();
    expect(screen.getByRole("dialog", { name: "Add people" })).toBeVisible();
    await act(async () => finishSave());
    await openCirclePeoplePicker();
    const alex = screen.getByRole("checkbox", { name: "Add Alex to Family" });
    expect(alex).toBeEnabled();
    expect(screen.queryByText("Loading connections…")).toBeNull();
    fireEvent.click(alex);
    expect(alex).toHaveAttribute("aria-checked", "true");
    await act(async () => finishRead());
    expect(alex).toHaveAttribute("aria-checked", "true");
    expect(toast.success).toHaveBeenCalledWith("Circle members updated.");
    expect(toast.error).not.toHaveBeenCalledWith("Could not add them.");
    expect(screen.getByText("Roster temporarily unavailable")).toBeVisible();
  });

  it("reserves selection capacity and reconciles removed selections on a live refresh", async () => {
    const people = ["Asha", "Jordan"].map((name) => ({
      connectionId: `c-${name}`, userId: name, displayName: name,
    }));
    const props = detailProps(async () => circle("family", "Family"));
    props.onLoadEligibleConnections = vi.fn().mockResolvedValueOnce({
      eligibleConnections: people, pendingInvites: [], remainingCapacity: 1,
    }).mockResolvedValue({ eligibleConnections: [people[1]], pendingInvites: [], remainingCapacity: 1 });
    const view = render(<CircleDetailFlow circleId="family" livingCircleExperience {...props} />);
    await openCirclePeoplePicker();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Add Asha to Family" }));
    const jordan = screen.getByRole("checkbox", { name: "Add Jordan to Family" });
    expect(jordan).toBeDisabled();
    fireEvent.click(jordan);
    expect(screen.getByRole("button", { name: "Add people", exact: true })).toBeEnabled();
    view.rerender(<CircleDetailFlow circleId="family" livingCircleExperience reloadSignal={1} {...props} />);
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Add Asha to Family" })).toBeNull());
    expect(screen.getByRole("button", { name: "Add people", exact: true })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Add Jordan to Family" })).toBeEnabled();
    expect(props.onInviteConnections).not.toHaveBeenCalled();
  });

  it.each(["circle", "owner", "unlock"])("ignores a late member save after the %s scope changes", async (scope) => {
    let finishSave!: () => void;
    const props = detailProps(async (id) => circle(id, id === "family" ? "Family" : "Friends"));
    props.onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [{ connectionId: "c-asha", userId: "asha", displayName: "Asha" }],
      pendingInvites: [], remainingCapacity: 19,
    }));
    props.onInviteConnections = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const initial = { circleId: "family", currentUserId: "owner-user", sessionScope: "unlock-1" };
    const view = render(<CircleDetailFlow {...props} {...initial} livingCircleExperience />);
    await openCirclePeoplePicker();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Add Asha to Family" }));
    fireEvent.click(screen.getByRole("button", { name: "Add people", exact: true }));
    const next = { ...initial, ...(scope === "circle" ? { circleId: "friends" } : scope === "owner" ? { currentUserId: "new-owner" } : { sessionScope: "unlock-2" }) };
    view.rerender(<CircleDetailFlow {...props} {...next} livingCircleExperience />);
    await openCirclePeoplePicker();
    const candidate = await screen.findByRole("checkbox", { name: `Add Asha to ${scope === "circle" ? "Friends" : "Family"}` });
    fireEvent.click(candidate);
    const reads = props.onLoadEligibleConnections.mock.calls.length;
    const successes = vi.mocked(toast.success).mock.calls.length;
    await act(async () => finishSave());
    expect(candidate).toHaveAttribute("aria-checked", "true");
    expect(props.onLoadEligibleConnections).toHaveBeenCalledTimes(reads);
    expect(toast.success).toHaveBeenCalledTimes(successes);
    expect(screen.getByRole("button", { name: "Add people", exact: true })).toBeEnabled();
  });

  it("keeps a valid later selection when a live update removes an earlier selection and reduces capacity", async () => {
    const people = ["Asha", "Jordan"].map((name) => ({
      connectionId: `c-${name}`, userId: name, displayName: name,
    }));
    const props = detailProps(async () => circle("family", "Family"));
    props.onLoadEligibleConnections = vi.fn().mockResolvedValueOnce({
      eligibleConnections: people, pendingInvites: [], remainingCapacity: 2,
    }).mockResolvedValue({ eligibleConnections: [people[1]], pendingInvites: [], remainingCapacity: 1 });
    const view = render(<CircleDetailFlow circleId="family" livingCircleExperience {...props} />);
    await openCirclePeoplePicker();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Add Asha to Family" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Add Jordan to Family" }));
    view.rerender(<CircleDetailFlow circleId="family" livingCircleExperience reloadSignal={1} {...props} />);
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Add Asha to Family" })).toBeNull());
    expect(screen.getByRole("checkbox", { name: "Add Jordan to Family" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Add people", exact: true })).toBeEnabled();
  });

  it.each(["circle", "owner", "unlock"])("keeps a new legacy submission locked when an old save settles after the %s changes", async (scope) => {
    let firstSave!: () => void;
    let secondSave!: () => void;
    const props = detailProps(async (id) => circle(id, "Family"));
    props.onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [{ connectionId: "c-asha", userId: "asha", displayName: "Asha" }],
      pendingInvites: [], remainingCapacity: 19,
    }));
    props.onInviteConnections = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { firstSave = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { secondSave = resolve; }));
    const initial = { circleId: "family", currentUserId: "owner-user", sessionScope: "unlock-1" };
    const view = render(<CircleDetailFlow {...props} {...initial} />);
    const submit = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Add people", exact: true }));
      const sheet = await screen.findByRole("dialog", { name: "Add people" });
      fireEvent.click(await within(sheet).findByRole("button", { name: /^(?!View ).*Asha/ }));
      fireEvent.click(within(sheet).getByRole("button", { name: "Add 1 person", exact: true }));
    };
    await submit();
    const next = { ...initial, ...(scope === "circle" ? { circleId: "friends" } : scope === "owner" ? { currentUserId: "new-owner" } : { sessionScope: "unlock-2" }) };
    view.rerender(<CircleDetailFlow {...props} {...next} />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add people" })).toBeNull());
    await submit();
    await act(async () => firstSave());
    expect(screen.getByRole("dialog", { name: "Add people" })).toBeVisible();
    const pending = within(screen.getByRole("dialog", { name: "Add people" })).getByRole("button", { name: "Add 1 person", exact: true });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(props.onInviteConnections).toHaveBeenCalledTimes(2);
    await act(async () => secondSave());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add people" })).toBeNull());
  });

  it("bounds an inline batch when a paged search reports less capacity without losing valid off-page choices", async () => {
    const people = ["Asha", "Jordan", "Alex"].map((name) => ({
      connectionId: `c-${name}`, userId: name, displayName: name,
    }));
    const props = detailProps(async () => circle("family", "Family"));
    const onLoadEligibleConnectionsPage = vi.fn(async (_id: string, options: { query?: string }) => ({
      eligibleConnections: options.query ? [people[2]!] : people,
      pendingInvites: [], remainingCapacity: options.query ? 1 : 3,
      page: 1, hasMore: false, totalCount: options.query ? 1 : 8,
    }));
    props.onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: people, pendingInvites: [], remainingCapacity: 1,
    }));
    render(<CircleDetailFlow circleId="family" livingCircleExperience {...props}
      onLoadEligibleConnectionsPage={onLoadEligibleConnectionsPage} />);
    await openCirclePeoplePicker();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Add Asha to Family" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Add Jordan to Family" }));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search connections to add" }), { target: { value: "Alex" } });
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Add Asha to Family" })).toBeNull());
    expect(screen.getByRole("checkbox", { name: "Add Alex to Family" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add people", exact: true })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add people", exact: true }));
    expect(props.onInviteConnections).toHaveBeenCalledExactlyOnceWith("family", ["Asha"]);
  });

  it("can search and remove an off-page selection from the Selected view without inviting", async () => {
    const asha = { connectionId: "c-asha", userId: "asha", displayName: "Asha" };
    const jordan = { connectionId: "c-jordan", userId: "jordan", displayName: "Jordan" };
    const props = detailProps(async () => circle("family", "Family"));
    props.onLoadEligibleConnections = vi.fn(async () => ({ eligibleConnections: [asha], pendingInvites: [], remainingCapacity: 3 }));
    const loadPage = vi.fn(async (_id: string, options: { query?: string }) => ({
      eligibleConnections: options.query ? [jordan] : [asha], pendingInvites: [],
      remainingCapacity: 3, page: 1, hasMore: false, totalCount: 1,
    }));
    render(<CircleDetailFlow circleId="family" livingCircleExperience {...props} onLoadEligibleConnectionsPage={loadPage} />);
    await openCirclePeoplePicker();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Add Asha to Family" }));
    const search = screen.getByRole("searchbox", { name: "Search connections to add" });
    fireEvent.change(search, { target: { value: "Jordan" } });
    await screen.findByRole("checkbox", { name: "Add Jordan to Family" });
    fireEvent.click(screen.getByRole("tab", { name: "Selected (1)" }));
    expect(screen.queryByRole("checkbox", { name: "Add Asha to Family" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveFocus();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Add Asha to Family" }));
    expect(screen.getByRole("tab", { name: "Selected (0)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Add people", exact: true })).toBeDisabled();
    expect(props.onInviteConnections).not.toHaveBeenCalled();
  });

  it("reaches later eligible connections through inline expansion, pagination, and search", async () => {
    const firstPage = Array.from({ length: 7 }, (_, index) => ({
      connectionId: `connection-${index + 1}`,
      userId: `person-${index + 1}`,
      displayName: `Person ${index + 1}`,
    }));
    const lastPerson = {
      connectionId: "connection-8",
      userId: "person-8",
      displayName: "Person 8",
    };
    const onLoadEligibleConnectionsPage = vi.fn(async (
      _circleId: string,
      options: { page: number; limit: number; query?: string },
    ) => ({
      eligibleConnections: options.query
        ? [lastPerson]
        : options.page === 2
          ? [lastPerson]
          : firstPage,
      pendingInvites: [],
      remainingCapacity: 19,
      page: options.page,
      hasMore: !options.query && options.page === 1,
      totalCount: options.query ? 1 : 8,
    }));
    const props = detailProps(async () => circle("family", "Family"));
    render(
      <CircleDetailFlow
        circleId="family"
        livingCircleExperience
        {...props}
        onLoadEligibleConnectionsPage={onLoadEligibleConnectionsPage}
      />,
    );
    await openCirclePeoplePicker();
    expect(screen.getByRole("dialog", { name: "Add people" })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Add Person 7 to Family" })).toBeVisible();


    expect(screen.getByRole("checkbox", { name: "Add Person 7 to Family" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more connections" }));
    expect(await screen.findByRole("checkbox", { name: "Add Person 8 to Family" })).toBeTruthy();
    expect(onLoadEligibleConnectionsPage).toHaveBeenCalledWith("family", {
      page: 2,
      limit: 50,
      query: undefined,
    });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search connections to add" }), {
      target: { value: "Person 8" },
    });
    await waitFor(() => expect(onLoadEligibleConnectionsPage).toHaveBeenCalledWith("family", {
      page: 1,
      limit: 50,
      query: "Person 8",
    }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Add Person 1 to Family" })).toBeNull());
    fireEvent.click(screen.getByRole("checkbox", { name: "Add Person 8 to Family" }));
    fireEvent.click(screen.getByRole("button", { name: "Add people", exact: true }));
    await waitFor(() => expect(props.onInviteConnections).toHaveBeenCalledWith("family", ["person-8"]));
  });

  it("offers Proceed to SMS only when the SMS Circle has another member", async () => {
    const onProceedToSms = vi.fn();
    const ownerOnly = circle("sms-circle", "SMS Circle");
    const { rerender } = render(
      <CircleDetailFlow
        circleId="sms-circle"
        {...detailProps(async () => ownerOnly)}
        onProceedToSms={onProceedToSms}
      />,
    );

    await screen.findByText("SMS Circle");
    expect(
      screen.queryByRole("button", { name: "Proceed to SMS" }),
    ).toBeNull();

    const withContact = {
      ...ownerOnly,
      memberCount: 2,
      members: [
        ...ownerOnly.members,
        {
          userId: "contact-user",
          displayName: "Jhumma Kumari",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
      ],
    };
    rerender(
      <CircleDetailFlow
        key="sms-circle-with-contact"
        circleId="sms-circle"
        {...detailProps(async () => withContact)}
        onProceedToSms={onProceedToSms}
      />,
    );

    const proceed = await screen.findByRole("button", {
      name: "Proceed to SMS",
    });
    const members = screen.getByTestId("one-location-circle-members");
    expect(
      members.compareDocumentPosition(proceed) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(proceed).toHaveClass("max-w-[244px]", "min-h-12", "rounded-full");
    expect(screen.getByTestId("one-location-proceed-to-sms-row")).toHaveClass(
      "flex",
      "justify-center",
    );
    fireEvent.click(proceed);
    expect(onProceedToSms).toHaveBeenCalledTimes(1);
  });

  it("renders viewer-relative contact provenance in a Circle roster", async () => {
    const onLoad = vi.fn(async () => ({
      ...circle("circle-1", "Family"),
      memberCount: 2,
      members: [
        ...circle("circle-1", "Family").members,
        {
          userId: "contact-user",
          displayName: "Asha Contact",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "connected" as const,
          connectedFromContacts: true,
          photoUrl: "https://cdn.example.test/asha-contact.jpg",
          isRia: true,
        },
      ],
    }));

    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("Asha Contact")).toBeTruthy();
    const roster = screen.getByTestId("one-location-circle-members");
    expect(
      roster.querySelector(
        '[data-photo-url="https://cdn.example.test/asha-contact.jpg"]',
      ),
    ).toBeTruthy();
    expect(within(roster).getByLabelText("Verified advisor")).toBeTruthy();
    const badge = within(roster).getByLabelText("Connected from your contacts");
    expect(badge).toBeTruthy();
    expect(badge.closest('[data-slot="avatar"]')).toBeTruthy();
    expect(badge.querySelector("svg")).toBeTruthy();
    expect(screen.getByText("Asha Contact")).toHaveAttribute("title", "Asha Contact");
  });

  it("uses bounded member pages and keeps duplicate names addressable by user id", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "Legacy"));
    const onLoadOverview = vi.fn(async () => ({
      ...circle("circle-1", "Family"),
      members: undefined,
      memberCount: 5000,
    }));
    const onLoadMembersPage = vi.fn(
      async (
        _circleId: string,
        options: { page: number; limit: number; query?: string },
      ) => ({
        items:
          options.query === "nobody"
            ? []
            : options.page === 1
              ? [
                  {
                    userId: "same-1",
                    displayName: "Same Name",
                    role: "member" as const,
                    phoneVerified: true,
                    secureLocationReady: true,
                  },
                ]
              : [
                  {
                    userId: "same-2",
                    displayName: "Same Name",
                    role: "member" as const,
                    phoneVerified: true,
                    secureLocationReady: true,
                    connectedFromContacts: true,
                  },
                ],
        page: options.page,
        hasMore: options.page === 1,
        totalCount: options.query === "nobody" ? 0 : 5000,
      }),
    );

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onLoadOverview={onLoadOverview}
        onLoadMembersPage={onLoadMembersPage}
      />,
    );

    expect(await screen.findByText("Same Name")).toBeTruthy();
    expect(onLoad).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByTestId("one-location-circle-members-load-more"),
    );
    await waitFor(() =>
      expect(screen.getAllByText("Same Name")).toHaveLength(2),
    );
    expect(screen.getByLabelText("Connected from your contacts")).toBeTruthy();
    expect(onLoadMembersPage).toHaveBeenCalledWith(
      "circle-1",
      expect.objectContaining({ page: 2, limit: 50 }),
    );

    fireEvent.change(screen.getByLabelText("Search members"), {
      target: { value: "nobody" },
    });
    await waitFor(() =>
      expect(screen.getByText("No members found")).toBeTruthy(),
    );
    const retainedSearch = screen.getByLabelText("Search members");
    expect(retainedSearch).toHaveValue("nobody");
    fireEvent.change(retainedSearch, { target: { value: "" } });
    expect(screen.getByLabelText("Search members")).toHaveValue("");
  }, 15000);

  it("creates a Circle without a type selector and keeps a failed submission recoverable", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("Circle limit reached."))
      .mockResolvedValueOnce(circle("new-circle", "Meena Family"));

    render(<CreateCircleFlow {...createProps()} onSubmit={onSubmit} showCircleType={false} />);

    expect(screen.queryByText("Circle type")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();

    fireEvent.change(
      screen.getByPlaceholderText("Family, close friends, project team"),
      {
      target: { value: "Meena Family" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Circle limit reached."),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit).toHaveBeenLastCalledWith("Meena Family", "family", undefined);
  });

  it("blocks Create only while the name is empty, and says so visibly", async () => {
    const onSubmit = vi.fn().mockResolvedValue(circle("new-circle", "A"));
    render(<CreateCircleFlow {...createProps()} onSubmit={onSubmit} />);

    const create = screen.getByRole("button", { name: "Next" });
    const input = screen.getByPlaceholderText(
      "Family, close friends, project team",
    );

    // Nothing typed: the button is genuinely blocked, and it is painted as a
    // neutral fill rather than a half-opacity accent that still reads as live.
    expect(create).toBeDisabled();
    expect(create.className).toContain("disabled:bg-black/10");
    expect(create.className).toContain("disabled:opacity-100");
    expect(screen.queryByText("Enter a Circle name.")).toBeNull();

    // Whitespace is not a name.
    fireEvent.change(input, { target: { value: "   " } });
    expect(create).toBeDisabled();

    // Leaving the field alone must not validate when a host closes the form.
    fireEvent.blur(input);
    expect(screen.queryByText("Enter a Circle name.")).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid", "true");

    // Choosing a Type is not the Circle name; the form explains the blocked CTA.
    fireEvent.click(screen.getByRole("radio", { name: "Friends" }));
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-invalid", "true"),
    );
    expect(screen.getByText("Enter a Circle name.")).toBeTruthy();
    expect(input).toHaveAttribute(
      "aria-describedby",
      "one-location-create-circle-name-help",
    );

    // One character is.
    fireEvent.change(input, { target: { value: "A" } });
    expect(create).toBeEnabled();
    expect(input).not.toHaveAttribute("aria-describedby");

    fireEvent.click(create);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("A", "friends", undefined));
  });

  it("finds a connection from the first letter of any of their names", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "Meena Family"));
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: [
            {
              userId: "conn-1",
              displayName: "Asha Meena",
              photoUrl: "https://cdn.example.test/asha-circle.jpg",
              connectionOrigin: "one" as const,
              connectedFromContacts: true,
              isRia: true,
            },
            {
              userId: "conn-2",
              displayName: "Neel Shah",
              connectionOrigin: "one" as const,
            },
          ],
          pendingInvites: [],
          remainingCapacity: 5,
        }))}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    expect(await screen.findByText("Asha Meena")).toBeTruthy();
    const ashaRow = screen.getByTestId("one-location-circle-eligible-conn-1");
    expect(
      ashaRow.querySelector(
        '[data-photo-url="https://cdn.example.test/asha-circle.jpg"]',
      ),
    ).toBeTruthy();
    expect(within(ashaRow).getByLabelText("Verified advisor")).toBeTruthy();
    expect(
      within(ashaRow).getByLabelText("Connected from your contacts"),
    ).toBeTruthy();

    // "Asha Meena" and "Neel Shah" BOTH contain an "n", so a substring filter
    // returned both and one-letter search looked broken. Only Neel's name
    // BEGINS with one.
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "n" },
    });
    expect(screen.getByText("Neel Shah")).toBeTruthy();
    expect(screen.queryByText("Asha Meena")).toBeNull();

    // A later word counts as a beginning too.
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "m" },
    });
    expect(screen.getByText("Asha Meena")).toBeTruthy();
    expect(screen.queryByText("Neel Shah")).toBeNull();
  });

  it("previews before joining and discloses connection and location boundaries", async () => {
    const preview: OneLocationCircleInvitePreview = {
      name: "Meena Family",
      kind: "family",
      ownerDisplayName: "Meena",
      memberCount: 3,
      expiresAt: "2026-07-27T00:00:00Z",
      alreadyMember: false,
    };
    const onResolve = vi.fn(async () => preview);
    const onJoin = vi.fn(async () => undefined);

    render(
      <JoinCircleFlow busy={false} onResolve={onResolve} onJoin={onJoin} />,
    );

    fireEvent.change(screen.getByLabelText("Circle invite code"), {
      target: {
        value: "Join my BEST TEAM EVER Circle on One with code 2345-6789-ABCD.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review Circle" }));

    expect(await screen.findByText("Meena Family")).toBeTruthy();
    expect(screen.queryByText("You're already in this Circle.")).toBeNull();
    expect(screen.queryByText(/current and future Circle members/i)).toBeNull();
    expect(screen.getByText(/Location and SMS stay private/i)).toBeTruthy();
    expect(onResolve).toHaveBeenCalledWith("2345-6789-ABCD");

    fireEvent.click(screen.getByRole("button", { name: "Join Circle" }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith("2345-6789-ABCD"));
  });

  it("pre-fills the code input from initialCode (a shared /circle/join link)", () => {
    render(
      <JoinCircleFlow
        busy={false}
        initialCode="2345-6789-ABCD"
        onResolve={async () => ({}) as OneLocationCircleInvitePreview}
        onJoin={async () => undefined}
      />,
    );

    expect(screen.getAllByRole("textbox").map((input) => (input as HTMLInputElement).value))
      .toEqual(["2345", "6789", "ABCD"]);
  });

  it("opens an already-joined Circle after review and lets the code be changed", async () => {
    const preview: OneLocationCircleInvitePreview = {
      name: "Meena Family",
      kind: "family",
      ownerDisplayName: "Meena",
      memberCount: 1,
      expiresAt: "2026-07-27T00:00:00Z",
      alreadyMember: true,
    };
    const onResolve = vi.fn(async () => preview);
    const onJoin = vi.fn(async () => undefined);

    render(
      <JoinCircleFlow busy={false} onResolve={onResolve} onJoin={onJoin} />,
    );

    fireEvent.change(screen.getByLabelText("Circle invite code"), {
      target: { value: "2345-6789-ABCD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review Circle" }));

    expect(await screen.findByRole("button", { name: "Open Circle" })).toBeTruthy();
    expect(screen.getByText("Meena · 1 member")).toBeTruthy();
    expect(screen.getByText("You're already in this Circle.")).toBeTruthy();

    // "Use Another Code" asks first so an accidental tap cannot wipe the
    // reviewed preview. Answering Yes runs the same clear-and-refocus flow.
    // (While the modal is open the background is inert, so the preview is
    // asserted again only after the dialog closes.)
    fireEvent.click(screen.getByRole("button", { name: "Use Another Code" }));
    expect(
      await screen.findByText(/Are you sure you don't want to join/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(screen.queryByRole("button", { name: "Open Circle" })).toBeNull();
    await waitFor(() =>
      expect(screen.getByLabelText("Circle invite code")).toHaveFocus(),
    );
    expect(screen.getByLabelText("Circle invite code")).toHaveValue("");
  });

  it("keeps the reviewed preview when the discard confirm answers No", async () => {
    const preview: OneLocationCircleInvitePreview = {
      name: "Meena Family",
      kind: "family",
      ownerDisplayName: "Meena",
      memberCount: 1,
      expiresAt: "2026-07-27T00:00:00Z",
      alreadyMember: true,
    };
    const onResolve = vi.fn(async () => preview);
    const onJoin = vi.fn(async () => undefined);

    render(
      <JoinCircleFlow busy={false} onResolve={onResolve} onJoin={onJoin} />,
    );

    fireEvent.change(screen.getByLabelText("Circle invite code"), {
      target: { value: "2345-6789-ABCD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review Circle" }));

    expect(await screen.findByRole("button", { name: "Open Circle" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Use Another Code" }));
    expect(
      await screen.findByText(/Are you sure you don't want to join/i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await waitFor(() =>
      expect(
        screen.queryByText(/Are you sure you don't want to join/i),
      ).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Open Circle" })).toBeTruthy();
    expect(screen.getAllByRole("textbox").map((input) => (input as HTMLInputElement).value))
      .toEqual(["2345", "6789", "ABCD"]);
  });

  it("ignores a stale preview and joins the exact code that was reviewed", async () => {
    let resolveFirst:
      ((value: OneLocationCircleInvitePreview) => void) | undefined;
    let resolveSecond:
      ((value: OneLocationCircleInvitePreview) => void) | undefined;
    const first = new Promise<OneLocationCircleInvitePreview>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<OneLocationCircleInvitePreview>((resolve) => {
      resolveSecond = resolve;
    });
    const onResolve = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const onJoin = vi.fn(async () => undefined);

    render(
      <JoinCircleFlow busy={false} onResolve={onResolve} onJoin={onJoin} />,
    );

    const input = screen.getByLabelText("Circle invite code");
    fireEvent.change(input, { target: { value: "2345-6789-ABCD" } });
    fireEvent.click(screen.getByRole("button", { name: "Review Circle" }));
    fireEvent.change(input, { target: { value: "BCDE-FGHJ-KMNP" } });
    fireEvent.click(screen.getByRole("button", { name: "Review Circle" }));

    await act(async () => {
      resolveSecond?.({
        name: "Reviewed Circle",
        kind: "friends",
        ownerDisplayName: "Owner B",
        memberCount: 2,
        expiresAt: "2026-07-27T00:00:00Z",
        alreadyMember: false,
      });
      await second;
    });
    expect(await screen.findByText("Reviewed Circle")).toBeTruthy();

    await act(async () => {
      resolveFirst?.({
        name: "Stale Circle",
        kind: "family",
        ownerDisplayName: "Owner A",
        memberCount: 4,
        expiresAt: "2026-07-27T00:00:00Z",
        alreadyMember: false,
      });
      await first;
    });
    expect(screen.queryByText("Stale Circle")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Join Circle" }));
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith("BCDE-FGHJ-KMNP"));
  });

  it("ignores a stale detail response after the selected Circle changes", async () => {
    let resolveFirst: ((value: OneLocationCircleDetail) => void) | undefined;
    let resolveSecond: ((value: OneLocationCircleDetail) => void) | undefined;
    const first = new Promise<OneLocationCircleDetail>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<OneLocationCircleDetail>((resolve) => {
      resolveSecond = resolve;
    });
    const onLoad = vi.fn((circleId: string) =>
      circleId === "circle-one" ? first : second,
    );
    const props = detailProps(onLoad);
    const view = render(<CircleDetailFlow circleId="circle-one" {...props} />);

    view.rerender(<CircleDetailFlow circleId="circle-two" {...props} />);
    await act(async () => {
      resolveSecond?.(circle("circle-two", "Second Circle"));
      await second;
    });
    expect(await screen.findByText("Second Circle")).toBeTruthy();

    await act(async () => {
      resolveFirst?.(circle("circle-one", "Stale Circle"));
      await first;
    });
    expect(screen.queryByText("Stale Circle")).toBeNull();
    expect(screen.getByText("Second Circle")).toBeTruthy();
  });

  it("never calls the detail API for an empty Circle id", async () => {
    const onLoad = vi.fn();

    render(<CircleDetailFlow circleId="" {...detailProps(onLoad)} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This Circle link is incomplete.",
    );
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("lets an invited person join or decline without a Connect request", async () => {
    const invite: OneLocationCircleMemberInvite = {
      id: "invite-1",
      circleId: "circle-1",
      circleName: "Meena Family",
      circleKind: "family",
      inviterUserId: "owner-user",
      inviterDisplayName: "Meena",
      inviteeUserId: "friend-user",
      inviteeDisplayName: "Asha",
      status: "pending",
      expiresAt: "2026-07-27T00:00:00Z",
      createdAt: "2026-07-24T00:00:00Z",
    };
    const onAcceptInvite = vi.fn(async () => undefined);
    const onDeclineInvite = vi.fn(async () => undefined);

    const view = render(
      <CirclesSection
        circles={[]}
        incomingInvites={[invite]}
        incomingInvitesLoading={false}
        incomingInvitesError={null}
        focusedInviteId="invite-1"
        focusedInviteResolutionReady
        inviteBusy={false}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        onOpen={vi.fn()}
        onAcceptInvite={onAcceptInvite}
        onDeclineInvite={onDeclineInvite}
        onRetryInvites={vi.fn()}
        onDismissFocusedInvite={vi.fn()}
      />,
    );

    expect(screen.getByText("Meena Family")).toBeTruthy();
    expect(
      screen.getByTestId("one-location-circle-invite-invite-1"),
    ).toHaveAttribute("data-focused", "true");
    expect(
      screen.queryByText(/Join first\. Sharing stays private\./i),
    ).toBeNull();
    const joinButton = screen.getByRole("button", { name: "Join" });
    fireEvent.click(joinButton);
    fireEvent.click(joinButton);
    await waitFor(() =>
      expect(onAcceptInvite).toHaveBeenCalledWith("invite-1"),
    );
    expect(onAcceptInvite).toHaveBeenCalledTimes(1);

    view.rerender(
      <CirclesSection
        circles={[]}
        incomingInvites={[invite]}
        incomingInvitesLoading={false}
        incomingInvitesError={null}
        focusedInviteId="invite-1"
        focusedInviteResolutionReady
        inviteBusy={false}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        onOpen={vi.fn()}
        onAcceptInvite={onAcceptInvite}
        onDeclineInvite={onDeclineInvite}
        onRetryInvites={vi.fn()}
        onDismissFocusedInvite={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(onDeclineInvite).toHaveBeenCalledWith("invite-1"),
    );
  });

  it("shows a retry action when incoming Circle invitations fail to load", () => {
    const onRetryInvites = vi.fn();

    render(
      <CirclesSection
        circles={[]}
        incomingInvites={[]}
        incomingInvitesLoading={false}
        incomingInvitesError="Check your connection and try again."
        focusedInviteId={null}
        focusedInviteResolutionReady
        inviteBusy={false}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        onOpen={vi.fn()}
        onAcceptInvite={vi.fn()}
        onDeclineInvite={vi.fn()}
        onRetryInvites={onRetryInvites}
        onDismissFocusedInvite={vi.fn()}
      />,
    );

    expect(screen.getByText("Circle invitations unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryInvites).toHaveBeenCalledTimes(1);
  });

  it("keeps cached invites visible beside a background refresh warning", () => {
    render(
      <CirclesSection
        circles={[]}
        incomingInvites={[
          {
            id: "invite-cached",
            circleId: "circle-1",
            circleName: "Cached Family",
            circleKind: "family",
            inviterUserId: "owner-user",
            inviterDisplayName: "Meena",
            inviteeUserId: "friend-user",
            status: "pending",
          },
        ]}
        incomingInvitesLoading={false}
        incomingInvitesError="Check your connection and try again."
        focusedInviteId="invite-cached"
        focusedInviteResolutionReady
        inviteBusy={false}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        onOpen={vi.fn()}
        onAcceptInvite={vi.fn()}
        onDeclineInvite={vi.fn()}
        onRetryInvites={vi.fn()}
        onDismissFocusedInvite={vi.fn()}
      />,
    );

    expect(screen.getByText("Circle invitations unavailable")).toBeTruthy();
    expect(screen.getByText("Cached Family")).toBeTruthy();
    expect(
      screen.getByTestId("one-location-circle-invite-invite-cached"),
    ).toHaveAttribute("data-focused", "true");
  });

  it("shows and dismisses a deep-linked invitation that is no longer pending", () => {
    const onDismissFocusedInvite = vi.fn();
    const section = (focusResolved: boolean) => (
      <CirclesSection
        circles={[]}
        incomingInvites={[]}
        incomingInvitesLoading={false}
        incomingInvitesError={null}
        focusedInviteId="invite-expired"
        focusedInviteResolutionReady={focusResolved}
        inviteBusy={false}
        onCreate={vi.fn()}
        onJoin={vi.fn()}
        onOpen={vi.fn()}
        onAcceptInvite={vi.fn()}
        onDeclineInvite={vi.fn()}
        onRetryInvites={vi.fn()}
        onDismissFocusedInvite={onDismissFocusedInvite}
      />
    );
    const view = render(section(false));

    expect(
      screen.queryByText("Circle invitation no longer available"),
    ).toBeNull();
    view.rerender(section(true));
    expect(
      screen.getByText("Circle invitation no longer available"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissFocusedInvite).toHaveBeenCalledTimes(1);
  });

  it("lets an owner search and invite multiple existing connections", async () => {
    const onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [
        {
          connectionId: "connection-1",
          userId: "asha-user",
          displayName: "Asha Meena",
        },
        {
          connectionId: "connection-2",
          userId: "neel-user",
          displayName: "Neel Shah",
        },
      ],
      pendingInvites: [
        {
          id: "pending-1",
          circleId: "circle-1",
          circleName: "Meena Family",
          circleKind: "family" as const,
          inviterUserId: "owner-user",
          inviterDisplayName: "Owner",
          inviteeUserId: "pending-user",
          inviteeDisplayName: "Pending Friend",
          status: "pending",
        },
      ],
      remainingCapacity: 2,
    }));
    const onInviteConnections = vi.fn(async () => undefined);
    const onCancelMemberInvite = vi.fn(async () => undefined);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={onLoadEligibleConnections}
        onInviteConnections={onInviteConnections}
        onCancelMemberInvite={onCancelMemberInvite}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    expect(await screen.findByText("Asha Meena")).toBeTruthy();
    expect(screen.getByText("Neel Shah")).toBeTruthy();
    expect(screen.getByText("Pending Friend")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "Neel" },
    });
    expect(screen.queryByText("Asha Meena")).toBeNull();
    expect(screen.getByText("Neel Shah")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(onCancelMemberInvite).toHaveBeenCalledWith("pending-1"),
    );

    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Asha Meena/i }));
    expect(
      screen.getByRole("button", {
        name: /^(?!View ).*Asha Meena/i,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Neel Shah/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2 people" }));

    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenCalledWith("circle-1", [
        "asha-user",
        "neel-user",
      ]),
    );
  });

  it("lets a member share the Circle code and invite their own connection", async () => {
    const inviteCode = {
      id: "code-1",
      circleId: "circle-1",
      code: "2345-6789-ABCD",
      expiresAt: "2026-08-01T00:00:00Z",
    };
    const memberCircle = {
      ...circle("circle-1", "Friends"),
      role: "member" as const,
      activeInviteCode: inviteCode,
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: true,
        canRotateInviteCode: false,
        canManageCircle: false,
        canModerateInvites: false,
      },
    };
    const onCopyCode = vi.fn(async () => undefined);
    const onShareCode = vi.fn(async () => undefined);
    const onInviteConnections = vi.fn(async () => undefined);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => memberCircle)}
        currentUserId="member-user"
        onCopyCode={onCopyCode}
        onShareCode={onShareCode}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: [
            {
              connectionId: "connection-1",
              userId: "friend-user",
              displayName: "Friend User",
            },
          ],
          pendingInvites: [],
          remainingCapacity: 1,
        }))}
        onInviteConnections={onInviteConnections}
      />,
    );

    expect(await screen.findByText("Friends")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add people" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Replace code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete circle" })).toBeNull();
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    const leaveCircle = screen.getByRole("button", { name: "Leave circle" });
    expect(leaveCircle).toHaveClass("w-full", "max-w-[320px]");
    expect(screen.getByTestId("one-location-leave-circle-row")).toHaveClass(
      "flex",
      "justify-center",
    );
    expect(
      screen
        .getByTestId("one-location-leave-circle-icon")
        .querySelector('[opacity="0.2"]'),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Invite code/i }));
    expect(await screen.findByText(inviteCode.code)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    fireEvent.click(screen.getByRole("button", { name: "Share invite" }));
    await waitFor(() => {
      expect(onCopyCode).toHaveBeenCalledWith(inviteCode.code);
      expect(onShareCode).toHaveBeenCalledWith(
        expect.objectContaining({ id: "circle-1", role: "member" }),
        inviteCode.code,
      );
    });

    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Invite code" })).getByRole(
        "button",
        { name: "Close" },
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Invite code" }),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add people" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /^(?!View ).*Friend User/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));
    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenCalledWith("circle-1", [
        "friend-user",
      ]),
    );
  });

  it("keeps shared-code rotation and Circle management owner-only", async () => {
    const currentCode = {
      id: "code-1",
      circleId: "circle-1",
      code: "2345-6789-ABCD",
      expiresAt: "2026-08-01T00:00:00Z",
    };
    const rotatedCode = {
      ...currentCode,
      id: "code-2",
      code: "BCDE-FGHJ-KMNP",
    };
    const ownerCircle = {
      ...circle("circle-1", "Family"),
      activeInviteCode: currentCode,
    };
    const onGenerateCode = vi.fn(async () => rotatedCode);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onGenerateCode={onGenerateCode}
      />,
    );

    expect(await screen.findByText("Family")).toBeTruthy();
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete circle" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Invite code/i }));
    expect(await screen.findByText(currentCode.code)).toBeTruthy();
    const inviteCodeSheet = screen.getByRole("dialog", {
      name: "Invite code",
    });
    fireEvent.click(
      within(inviteCodeSheet).getByRole("button", { name: "Replace code" }),
    );
    const confirmDialog = await screen.findByRole("alertdialog", {
      name: "Replace invite code?",
    });
    expect(confirmDialog.closest('[data-slot="sheet-content"]')).toBeNull();
    expect(confirmDialog).toHaveClass("z-[714]");
    expect(
      document.querySelector('[data-slot="alert-dialog-overlay"]'),
    ).toHaveClass("z-[713]");
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Replace code" }),
    );

    await waitFor(() =>
      expect(onGenerateCode).toHaveBeenCalledWith("circle-1", true),
    );
    expect(await screen.findByText(rotatedCode.code)).toBeTruthy();
  });

  it("dismisses only the replace-code confirmation and keeps the invite sheet close button responsive", async () => {
    const currentCode = {
      id: "code-1",
      circleId: "circle-1",
      code: "2345-6789-ABCD",
      expiresAt: "2026-08-01T00:00:00Z",
    };
    const ownerCircle = {
      ...circle("circle-1", "Family"),
      activeInviteCode: currentCode,
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
      />,
    );

    expect(await screen.findByText("Family")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Invite code/i }));
    expect(await screen.findByText(currentCode.code)).toBeTruthy();

    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Invite code" })).getByRole(
        "button",
        { name: "Replace code" },
      ),
    );
    const confirmDialog = await screen.findByRole("alertdialog", {
      name: "Replace invite code?",
    });
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("alertdialog", { name: "Replace invite code?" }),
      ).toBeNull();
    });
    const inviteCodeSheet = screen.getByRole("dialog", {
      name: "Invite code",
    });
    fireEvent.click(
      within(inviteCodeSheet).getByRole("button", { name: "Close" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Invite code" })).toBeNull();
    });
  });

  it("requires an explicit owner refresh for an unreadable legacy code", async () => {
    const refreshedCode = {
      id: "code-2",
      circleId: "circle-1",
      code: "BCDE-FGHJ-KMNP",
      expiresAt: "2026-08-01T00:00:00Z",
    };
    const ownerCircle = {
      ...circle("circle-1", "Family"),
      activeInviteCode: null,
      inviteCodeNeedsOwnerRotation: true,
    };
    const onGenerateCode = vi.fn(async () => refreshedCode);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onGenerateCode={onGenerateCode}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /Invite code/i }),
    );
    const createCode = await screen.findByRole("button", {
      name: "Create code",
    });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const secondaryAction = cancel.closest(
      '[data-action-priority="secondary"]',
    );
    expect(secondaryAction).toBeTruthy();
    expect(secondaryAction).not.toHaveClass("border-t");
    expect(secondaryAction).not.toHaveClass("pt-2");
    fireEvent.click(createCode);
    await waitFor(() =>
      expect(onGenerateCode).toHaveBeenCalledWith("circle-1", true),
    );
    expect(await screen.findByText(refreshedCode.code)).toBeTruthy();
  });

  it("caps selection at the Circle's remaining capacity", async () => {
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: [
            {
              connectionId: "connection-1",
              userId: "asha-user",
              displayName: "Asha Meena",
            },
            {
              connectionId: "connection-2",
              userId: "neel-user",
              displayName: "Neel Shah",
            },
          ],
          pendingInvites: [],
          remainingCapacity: 1,
        }))}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    expect(await screen.findByText("Asha Meena")).toBeTruthy();

    const asha = screen.getByRole("button", {
      name: /^(?!View ).*Asha Meena/i,
    });
    const neel = screen.getByRole("button", {
      name: /^(?!View ).*Neel Shah/i,
    });
    expect(asha).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(asha);
    expect(asha).toHaveAttribute("aria-pressed", "true");
    expect(neel).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add 1 person" })).toBeEnabled();
  });

  it("shows SMS Circle capacity below Add people and keeps selection within that limit", async () => {
    const smsCircle = {
      ...circle("sms-circle", "Emergency Circle"),
      memberCount: 10,
      memberLimit: 11,
      isSystem: true,
      systemKind: "sms" as const,
    };
    render(
      <CircleDetailFlow
        circleId="sms-circle"
        {...detailProps(async () => smsCircle)}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: [
            { connectionId: "connection-1", userId: "asha", displayName: "Asha Meena" },
            { connectionId: "connection-2", userId: "neel", displayName: "Neel Shah" },
          ],
          pendingInvites: [],
          remainingCapacity: 1,
        }))}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    const sheet = await screen.findByRole("dialog", { name: "Add people" });
    expect(
      await within(sheet).findByText("You can add 1 more person."),
    ).toBeInTheDocument();
    expect(within(sheet).queryByText("Choose connections.")).toBeNull();

    const asha = within(sheet).getByRole("button", { name: /^(?!View ).*Asha Meena/i });
    const neel = within(sheet).getByRole("button", { name: /^(?!View ).*Neel Shah/i });
    fireEvent.click(asha);
    expect(neel).toBeDisabled();
    expect(within(sheet).getByRole("button", { name: "Add 1 person" })).toBeEnabled();
  });

  it("renders Circle full even if a stale eligible row is returned", async () => {
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: [
            {
              connectionId: "connection-stale",
              userId: "stale-user",
              displayName: "Stale Candidate",
            },
          ],
          pendingInvites: [],
          remainingCapacity: 0,
        }))}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    expect(await screen.findByText("No room left in this Circle")).toBeTruthy();
    expect(screen.queryByText("Stale Candidate")).toBeNull();
  });

  it("reloads eligibility and clears stale selection after send failure", async () => {
    const onLoadEligibleConnections = vi
      .fn()
      .mockResolvedValueOnce({
        eligibleConnections: [
          {
            connectionId: "connection-1",
            userId: "asha-user",
            displayName: "Asha Meena",
          },
        ],
        pendingInvites: [],
        remainingCapacity: 1,
      })
      .mockResolvedValueOnce({
        eligibleConnections: [
          {
            connectionId: "connection-2",
            userId: "neel-user",
            displayName: "Neel Shah",
          },
        ],
        pendingInvites: [],
        remainingCapacity: 1,
      });

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={onLoadEligibleConnections}
        onInviteConnections={vi.fn(async () => {
          throw new Error("Circle capacity changed.");
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    const asha = await screen.findByRole("button", {
      name: /^(?!View ).*Asha Meena/i,
    });
    fireEvent.click(asha);
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));

    await waitFor(() =>
      expect(onLoadEligibleConnections).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByText("Asha Meena")).toBeNull();
    expect(await screen.findByText("Neel Shah")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^(?!View ).*Neel Shah/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      within(screen.getByRole("dialog", { name: "Add people" })).getByRole(
        "button",
        { name: "Add people" },
      ),
    ).toBeDisabled();
  });

  it("opens a quiet rename sheet, then shows the new name without refetching", async () => {
    const onRename = vi.fn(async (circleId: string, name: string) =>
      circle(circleId, name),
    );
    const onLoad = vi.fn(async () => circle("circle-1", "Meena Family"));

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onRename={onRename}
      />,
    );

    expect(await screen.findByText("Meena Family")).toBeTruthy();
    expect(screen.queryByText("You're already in this Circle.")).toBeNull();
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = (await screen.findByLabelText(
      "Circle name",
    )) as HTMLInputElement;
    expect(input).toHaveClass("rounded-[14px]");
    expect(input).toHaveClass(
      "focus-visible:border-border",
      "focus-visible:ring-0",
    );
    expect(input.className).not.toContain(
      "focus-visible:border-[color:var(--app-accent)]",
    );
    expect(input.className).not.toContain("focus-visible:ring-[3px]");


    // Only an empty name blocks the write; one character is a name.
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Enter a name.")).toBeTruthy();

    fireEvent.change(input, { target: { value: "M" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    fireEvent.change(input, { target: { value: "  Meena Home  " } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith("circle-1", "Meena Home"),
    );
    // Header, the delete confirmation copy and the add-people sheet all read the
    // renamed Circle without waiting for a refetch.
    expect(await screen.findByText("Meena Home")).toBeTruthy();
    // Saved state closes the sheet back to the quiet edit affordance.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull(),
    );
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("keeps rename controls out of the steady-state Circle detail page", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "Meena Family"));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("Meena Family")).toBeTruthy();
    expect(screen.queryByText("You're already in this Circle.")).toBeNull();
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const save = await screen.findByRole("button", { name: "Save" });
    expect(save.querySelector("svg")).toBeNull();
    expect(save.textContent).toBe("Save");
  });

  it("saves the Circle name on Enter and reverts it on Escape", async () => {
    const onRename = vi.fn(async (circleId: string, name: string) =>
      circle(circleId, name),
    );

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onRename={onRename}
      />,
    );

    await screen.findByText("Meena Family");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = (await screen.findByLabelText(
      "Circle name",
    )) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "Typed then abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByLabelText("Circle name")).toBeNull(),
    );
    expect(onRename).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const nextInput = (await screen.findByLabelText(
      "Circle name",
    )) as HTMLInputElement;
    fireEvent.change(nextInput, { target: { value: "Meena Home" } });
    fireEvent.keyDown(nextInput, { key: "Enter" });
    await waitFor(() =>
      expect(onRename).toHaveBeenCalledWith("circle-1", "Meena Home"),
    );
  });

  it("removes a member from a labelled destructive menu action, behind a labelled overflow trigger", async () => {
    const onRemoveMember = vi.fn(async () => undefined);
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          userId: "friend-user",
          displayName: "John Smith",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onRemoveMember={onRemoveMember}
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "Actions for John Smith",
    });
    // Radix opens DropdownMenuTrigger on pointerdown (no PointerEvent in
    // jsdom) or on Enter/Space keydown — use the keyboard path here.
    fireEvent.keyDown(trigger, { key: "Enter" });

    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Remove from Circle/i }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove", hidden: true }),
    );
    await waitFor(() =>
      expect(onRemoveMember).toHaveBeenCalledWith("circle-1", "friend-user"),
    );
  });

  it("spends a roster row's trailing edge only on relationships the viewer can act on", async () => {
    const onConnectMember = vi.fn(async () => undefined);
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          userId: "known-user",
          displayName: "Divya Rajendran",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "connected" as const,
        },
        {
          userId: "stranger-user",
          displayName: "Sharu Khan",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "none" as const,
        },
        {
          userId: "waiting-user",
          displayName: "Asha Meena",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "pending_outgoing" as const,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onConnectMember={onConnectMember}
      />,
    );

    await screen.findByText("Divya Rajendran");

    // Already connected is the steady state of a roster, so it is said to the
    // accessibility tree and to nothing else. A grey, disabled, button-shaped
    // "Connected" beside every name was the report this row was rebuilt for.
    expect(screen.queryByRole("button", { name: /^Connected$/ })).toBeNull();
    expect(screen.queryByTestId("circle-member-connect-known-user")).toBeNull();

    // Waiting on them is news, but nothing here can advance it: a status, not
    // a control.
    expect(
      screen.getByTestId("circle-member-relationship-waiting-user").tagName,
    ).toBe("SPAN");
    expect(
      screen.queryByTestId("circle-member-connect-waiting-user"),
    ).toBeNull();

    // The one row with something to ask for keeps a real, pressable control.
    const connect = screen.getByTestId("circle-member-connect-stranger-user");
    expect(connect).toHaveAccessibleName("Connect with Sharu Khan");
    fireEvent.click(connect);
    await waitFor(() =>
      // The identity rides along, because the caller puts this person in
      // front of the same capability review the Connect directory opens, and
      // that sheet has to name who the request is going to.
      expect(onConnectMember).toHaveBeenCalledWith(
        "circle-1",
        "stranger-user",
        { displayName: "Sharu Khan", photoUrl: null },
      ),
    );
  });

  it("shows every member of a joined Circle and Connect only for the four strangers", async () => {
    const members: OneLocationCircleDetail["members"] = [
      {
        userId: "owner-user",
        displayName: "Circle owner",
        role: "owner",
        phoneVerified: true,
        secureLocationReady: true,
        relationship: "connected",
      },
      {
        userId: "viewer-user",
        displayName: "You",
        role: "member",
        phoneVerified: true,
        secureLocationReady: true,
        relationship: "self",
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        userId: `known-${index + 1}`,
        displayName: `Connected member ${index + 1}`,
        role: "member" as const,
        phoneVerified: true,
        secureLocationReady: true,
        relationship: "connected" as const,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        userId: `stranger-${index + 1}`,
        displayName: `New member ${index + 1}`,
        role: "member" as const,
        phoneVerified: true,
        secureLocationReady: true,
        relationship: "none" as const,
        canConnect: true,
      })),
    ];
    const joinedCircle: OneLocationCircleDetail = {
      ...circle("circle-1", "Friends of friends"),
      role: "member",
      memberCount: 10,
      viewerCapabilities: {
        canInviteMembers: false,
        canViewInviteCode: false,
        canRotateInviteCode: false,
        canManageCircle: false,
        canModerateInvites: false,
      },
      members,
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => joinedCircle)}
        currentUserId="viewer-user"
      />,
    );

    const roster = await screen.findByTestId("one-location-circle-members");
    const rosterRows = roster.querySelector(
      '[data-slot="settings-group-shell"] > div',
    );
    expect(rosterRows?.children).toHaveLength(10);
    expect(screen.getAllByText("10 people").length).toBeGreaterThanOrEqual(1);
    expect(
      within(roster).getAllByRole("button", { name: /^Connect with / }),
    ).toHaveLength(4);
    expect(within(roster).getByText("Connected member 4")).toBeTruthy();
    expect(within(roster).getByText("New member 4")).toBeTruthy();
  });

  it("sends an incoming request to where it can actually be answered", async () => {
    const onConnectMember = vi.fn(async () => undefined);
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          userId: "asked-user",
          displayName: "Neel Shah",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "pending_incoming" as const,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onConnectMember={onConnectMember}
      />,
    );

    // This used to be an ENABLED button whose handler ran only for
    // `action === "connect"`, so the single row with something waiting on it
    // offered the one control on the screen that did nothing at all.
    const respond = await screen.findByTestId(
      "circle-member-respond-asked-user",
    );
    // The consent centre, not `/one/connect`. From a Circle hosted ON Connect,
    // a bare `/one/connect` href is a navigation whose only change is the query
    // string disappearing -- which the App Router refuses -- so the one row
    // with something waiting on it did nothing at all when tapped. A different
    // pathname works from either host, and it is where Connect's own Respond
    // already goes.
    const href = respond.getAttribute("href") ?? "";
    expect(href).not.toBe(ROUTES.CONNECT);
    expect(href).toBe(buildConsentCenterHref("pending"));
    fireEvent.click(respond);
    expect(onConnectMember).not.toHaveBeenCalled();
  });

  it("holds the roster's action column open on rows that have no menu", async () => {
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          userId: "ready-user",
          displayName: "Ready Ronnie",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
      />,
    );

    await screen.findByText("Ready Ronnie");

    // The viewer's own row has neither Share (self) nor Remove (owner), and
    // used to render nothing at all there — so the kebab column stepped in and
    // out by 44px from row to row down the list.
    const spacers = screen.getAllByTestId("circle-member-menu-spacer");
    expect(spacers).toHaveLength(1);
    expect(spacers[0].className).toContain(CIRCLE_MEMBER_MENU_CLASSNAME);
    expect(spacers[0]).toHaveAttribute("aria-hidden", "true");
  });

  // Reported on a Trusted Circle reading "Ankit Kumar Singh / JHUMMA KUMARI
  // (You · Owner) / Neelesh Meena" -- the roster was A-Z, and the owner is
  // whoever the alphabet puts in the middle. "Owner hamesha sabse upar hi
  // rahega, sabhi kind ke circles ke liye", so both kinds are asserted here
  // rather than only the one that was photographed.
  it.each([
    ["a Trusted Circle", "trusted" as const],
    ["an ordinary Circle", null],
  ])("puts the owner at the top of %s", async (_label, systemKind) => {
    const roster = {
      ...circle("circle-1", systemKind === "trusted" ? "Trusted" : "Family"),
      systemKind,
      memberCount: 3,
      members: [
        {
          userId: "ankit-user",
          displayName: "Ankit Kumar Singh",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
        // Alphabetically between the two members, which is exactly where the
        // report found them.
        {
          userId: "owner-user",
          displayName: "Jhumma Kumari",
          role: "owner" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
        {
          userId: "neelesh-user",
          displayName: "Neelesh Meena",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => roster)}
      />,
    );

    const owner = await screen.findByText("Jhumma Kumari");
    for (const memberName of ["Ankit Kumar Singh", "Neelesh Meena"]) {
      expect(
        owner.compareDocumentPosition(screen.getByText(memberName)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }

    // A partition, not a re-sort: the two members keep the A-Z order they
    // had underneath the owner.
    expect(
      screen
        .getByText("Ankit Kumar Singh")
        .compareDocumentPosition(screen.getByText("Neelesh Meena")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("stops hoisting the owner once the roster is answering a search", async () => {
    // The owner leads a ROSTER. A searched list is answering a question, and
    // both search paths rank a name that begins with the query above one that
    // merely contains it -- hoisting the owner through that would put the
    // wrong person first on the one screen where the reader has already said
    // who they want. "Ankit Kumar Singh" and "Jhumma Kumari" both have a word
    // beginning with "ku", so A-Z inside the rank decides, and Ankit wins.
    const filler = Array.from({ length: 7 }, (_unused, index) => ({
      userId: `filler-${index}`,
      displayName: `Zz Filler ${index}`,
      role: "member" as const,
      phoneVerified: true,
      secureLocationReady: true,
    }));

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ({
          ...circle("circle-1", "Family"),
          memberCount: 9,
          members: [
            {
              userId: "owner-user",
              displayName: "Jhumma Kumari",
              role: "owner" as const,
              phoneVerified: true,
              secureLocationReady: true,
            },
            {
              userId: "ankit-user",
              displayName: "Ankit Kumar Singh",
              role: "member" as const,
              phoneVerified: true,
              secureLocationReady: true,
            },
            ...filler,
          ],
        }))}
      />,
    );

    fireEvent.change(await screen.findByPlaceholderText("Search members"), {
      target: { value: "ku" },
    });

    const ankit = await screen.findByText("Ankit Kumar Singh");
    expect(
      ankit.compareDocumentPosition(screen.getByText("Jhumma Kumari")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Sheet spacing and reachability are measured by circle-invite-picker.layout.spec.ts.

  it("scopes quick actions to the row's own member and hides actions that don't apply", async () => {
    const onShareWithMember = vi.fn();
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          // Share-ready member: both menu actions apply.
          userId: "ready-user",
          displayName: "Ready Ronnie",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
        {
          // A missing Location key still excludes sharing.
          userId: "pending-user",
          displayName: "Pending Priya",
          role: "member" as const,
          phoneVerified: false,
          secureLocationReady: false,
        },
        {
          // A verified phone is only needed for SMS. Location setup is ready.
          userId: "no-phone-user",
          displayName: "No Phone Nina",
          role: "member" as const,
          phoneVerified: false,
          secureLocationReady: true,
        },
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
        onShareWithMember={onShareWithMember}
      />,
    );

    // The owner row (viewer, not removable, share excluded as self) gets no
    // overflow trigger at all — nothing valid to act on.
    await screen.findByText("Ready Ronnie");
    expect(
      screen.queryByRole("button", { name: "Actions for Owner" }),
    ).toBeNull();

    // Pending Priya cannot yet receive a share: only Remove is offered.
    const priyaTrigger = screen.getByRole("button", {
      name: "Actions for Pending Priya",
    });
    fireEvent.keyDown(priyaTrigger, { key: "Enter" });
    expect(
      await screen.findByRole("menuitem", { name: /Remove from Circle/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Share location/i }),
    ).toBeNull();
    fireEvent.keyDown(document.activeElement ?? priyaTrigger, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: /Remove from Circle/i }),
      ).toBeNull(),
    );

    const ninaTrigger = screen.getByRole("button", {
      name: "Actions for No Phone Nina",
    });
    fireEvent.keyDown(ninaTrigger, { key: "Enter" });
    expect(
      await screen.findByRole("menuitem", { name: /Remove from Circle/i }),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Share location/i }),
    );
    expect(onShareWithMember).toHaveBeenCalledWith("circle-1", "no-phone-user");
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: /Share location/i })).toBeNull(),
    );

    // Ready Ronnie's row offers both, and triggering Share calls back with
    // exactly Ronnie's id — not a stale id left over from another row.
    const ronnieTrigger = screen.getByRole("button", {
      name: "Actions for Ready Ronnie",
    });
    fireEvent.keyDown(ronnieTrigger, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Share location/i }),
    );
    expect(onShareWithMember).toHaveBeenCalledWith("circle-1", "ready-user");
    expect(onShareWithMember).not.toHaveBeenCalledWith(
      "circle-1",
      "pending-user",
    );
  });

  it("filters the Members list by name, case-insensitively, and shows an empty state for no match", async () => {
    const ownerCircle = {
      ...circle("circle-1", "Meena Family"),
      members: [
        ...circle("circle-1", "Meena Family").members,
        {
          userId: "friend-user",
          displayName: "John Smith",
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        },
        ...Array.from({ length: 7 }, (_, index) => ({
          userId: `extra-user-${index}`,
          displayName: `Circle Member ${index}`,
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        })),
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ownerCircle)}
      />,
    );

    await screen.findByText("John Smith");
    expect(screen.getByText("You · Owner")).toBeInTheDocument();

    const search = screen.getByPlaceholderText("Search members");

    // Partial, uppercase query — filtering is instant on every keystroke and
    // case never matters, same contract as the Add People connection search.
    fireEvent.change(search, { target: { value: "JOH" } });
    expect(screen.getByText("John Smith")).toBeInTheDocument();
    expect(screen.queryByText("You · Owner")).not.toBeInTheDocument();

    // Zero matches gets a real empty state, not a blank list.
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(await screen.findByText("No members found")).toBeInTheDocument();
    expect(screen.queryByText("John Smith")).not.toBeInTheDocument();

    // Clearing the query restores the original, unfiltered roster.
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("John Smith")).toBeInTheDocument();
    expect(screen.getByText("You · Owner")).toBeInTheDocument();
    expect(screen.queryByText("No members found")).not.toBeInTheDocument();
  });

  it("uses the page scroller on phones and bounds the Members list on larger screens", async () => {
    const rosterCircle = {
      ...circle("circle-1", "Meena Family"),
      memberLimit: 100,
      members: [
        ...circle("circle-1", "Meena Family").members,
        ...Array.from({ length: 80 }, (_, index) => ({
          userId: `member-${index}`,
          displayName: `Synced Contact ${index}`,
          role: "member" as const,
          phoneVerified: true,
          secureLocationReady: true,
        })),
      ],
    };

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => rosterCircle)}
      />,
    );

    await screen.findByText("Synced Contact 0");

    // "Delete circle" remains in source order even with 81 rows above it.
    expect(
      screen.getByRole("button", { name: "Delete circle" }),
    ).toBeInTheDocument();

    const membersGroup = screen.getByTestId("one-location-circle-members");
    const shell = membersGroup.querySelector(
      '[data-slot="settings-group-shell"]',
    );
    expect(shell?.className).toContain("sm:max-h-[60vh]");
    expect(shell?.className).not.toMatch(/(?:^|\s)max-h-\[60vh\](?:\s|$)/);
    const scrollRegion = shell?.firstElementChild as HTMLElement | null;
    expect(scrollRegion?.className).toContain("sm:overflow-y-auto");
    expect(scrollRegion?.className).toContain("sm:overscroll-contain");
    expect(scrollRegion?.className).not.toMatch(
      /(?:^|\s)overflow-y-auto(?:\s|$)/,
    );
    expect(scrollRegion?.className).not.toMatch(
      /(?:^|\s)overscroll-contain(?:\s|$)/,
    );
  });

  it("keeps the member search bar hidden for a small Circle", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "Meena Family"));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("You · Owner")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search members")).toBeNull();
  });

  it("closes the add-people sheet after inviting, for one person or many", async () => {
    const eligibility = {
      eligibleConnections: [
        {
          connectionId: "connection-1",
          userId: "asha-user",
          displayName: "Asha Meena",
        },
        {
          connectionId: "connection-2",
          userId: "neel-user",
          displayName: "Neel Shah",
        },
      ],
      pendingInvites: [],
      remainingCapacity: 2,
    };
    const onInviteConnections = vi.fn(async () => undefined);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={vi.fn(async () => eligibility)}
        onInviteConnections={onInviteConnections}
      />,
    );

    // Single selection.
    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    fireEvent.click(await screen.findByRole("button", { name: /^(?!View ).*Asha Meena/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));

    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenCalledWith("circle-1", [
        "asha-user",
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add people" })).toBeNull(),
    );

    // Multiple selection — reopening starts from a cleared selection.
    fireEvent.click(screen.getByRole("button", { name: "Add people" }));
    fireEvent.click(await screen.findByRole("button", { name: /^(?!View ).*Asha Meena/i }));
    fireEvent.click(screen.getByRole("button", { name: /^(?!View ).*Neel Shah/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2 people" }));

    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenLastCalledWith("circle-1", [
        "asha-user",
        "neel-user",
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add people" })).toBeNull(),
    );
  });

  it("keeps Circle detail invitations within the 20-person API batch", async () => {
    const invitees = Array.from({ length: 21 }, (_, index) => ({
      connectionId: `connection-${index + 1}`,
      userId: `user-${index + 1}`,
      displayName: `Person ${String(index + 1).padStart(2, "0")}`,
    }));
    const onInviteConnections = vi.fn(async () => undefined);

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => ({
          ...circle("circle-1", "Meena Family"),
          memberLimit: 100,
        }))}
        onLoadEligibleConnections={vi.fn(async () => ({
          eligibleConnections: invitees,
          pendingInvites: [],
          remainingCapacity: 99,
        }))}
        onInviteConnections={onInviteConnections}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    expect(
      await screen.findByText(/Add up to 20 people at a time/i),
    ).toBeTruthy();
    for (const invitee of invitees.slice(0, 20)) {
      fireEvent.click(
        within(
          screen.getByTestId(`one-location-circle-eligible-${invitee.userId}`),
        ).getByRole("button"),
      );
    }
    expect(
      within(
        screen.getByTestId("one-location-circle-eligible-user-21"),
      ).getByRole("button"),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Add 20 people" }));

    await waitFor(() =>
      expect(onInviteConnections).toHaveBeenCalledWith(
        "circle-1",
        invitees.slice(0, 20).map((invitee) => invitee.userId),
      ),
    );
  }, 15000);

  it("lets an SMS Circle owner select ten contacts and shows only the remaining count", async () => {
    const contacts = Array.from({ length: 11 }, (_, index) => ({
      connectionId: `sms-connection-${index + 1}`,
      userId: `sms-person-${index + 1}`,
      displayName: `SMS Person ${index + 1}`,
    }));
    const onInviteConnections = vi.fn(async () => undefined);
    render(<CircleDetailFlow
      circleId="sms-circle"
      {...detailProps(async () => ({
        ...circle("sms-circle", "SMS Circle"), systemKind: "sms", isSystem: true, memberLimit: 11,
        viewerCapabilities: {
          canInviteMembers: true,
          canViewInviteCode: false,
          canRotateInviteCode: false,
          canManageCircle: true,
          canModerateInvites: true,
        },
      }))}
      onLoadEligibleConnections={vi.fn(async () => ({
        eligibleConnections: contacts, pendingInvites: [], remainingCapacity: 10,
      }))}
      onInviteConnections={onInviteConnections}
    />);

    const addPeople = await screen.findByRole("button", { name: "Add people" });
    expect(screen.queryByRole("heading", { name: "Invite" })).toBeNull();
    expect(screen.queryByTestId("one-location-circle-invite-card")).toBeNull();
    expect(addPeople).toHaveClass("bg-transparent", "hover:text-[color:var(--app-accent)]", "active:text-[color:var(--app-accent)]");
    expect(addPeople.querySelector("svg.profile-pane-icon .profile-pane-icon-accent")).toBeTruthy();
    expect(addPeople.querySelector('[data-slot="settings-row-chevron"]')).toBeNull();
    fireEvent.click(addPeople);
    const sheet = await screen.findByRole("dialog", { name: "Add people" });
    expect(await within(sheet).findByText("You can add 10 more people.")).toBeInTheDocument();
    expect(within(sheet).queryByText("Choose connections.")).toBeNull();
    expect(within(sheet).queryByText(/SMS Circle limit|available;|right now/i)).toBeNull();
    for (const contact of contacts.slice(0, 10)) {
      fireEvent.click(within(screen.getByTestId(`one-location-circle-eligible-${contact.userId}`)).getByRole("button"));
    }
    expect(within(screen.getByTestId("one-location-circle-eligible-sms-person-11")).getByRole("button")).toBeDisabled();
    fireEvent.click(within(sheet).getByRole("button", { name: "Add 10 people" }));
    await waitFor(() => expect(onInviteConnections).toHaveBeenCalledWith(
      "sms-circle", contacts.slice(0, 10).map((contact) => contact.userId),
    ));
  });

  it("keeps the sheet open when sending fails so the selection can be retried", async () => {
    const onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [
        {
          connectionId: "connection-1",
          userId: "asha-user",
          displayName: "Asha Meena",
        },
      ],
      pendingInvites: [],
      remainingCapacity: 1,
    }));

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(async () => circle("circle-1", "Meena Family"))}
        onLoadEligibleConnections={onLoadEligibleConnections}
        onInviteConnections={vi.fn(async () => {
          throw new Error("Circle capacity changed.");
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    fireEvent.click(await screen.findByRole("button", { name: /^(?!View ).*Asha Meena/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Circle capacity changed."),
    );
    expect(screen.getByRole("dialog", { name: "Add people" })).toBeTruthy();
  });

  it("closes invitation controls when server capability is revoked", async () => {
    const memberCircle = {
      ...circle("circle-1", "Friends"),
      role: "member" as const,
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: true,
        canRotateInviteCode: false,
        canManageCircle: false,
        canModerateInvites: false,
      },
    };
    const revokedCircle = {
      ...memberCircle,
      viewerCapabilities: {
        ...memberCircle.viewerCapabilities,
        canInviteMembers: false,
        canViewInviteCode: false,
      },
    };
    const onLoad = vi
      .fn()
      .mockResolvedValueOnce(memberCircle)
      .mockResolvedValueOnce(revokedCircle);
    const onLoadEligibleConnections = vi.fn(async () => ({
      eligibleConnections: [
        {
          connectionId: "connection-1",
          userId: "friend-user",
          displayName: "Friend User",
        },
      ],
      pendingInvites: [],
      remainingCapacity: 1,
    }));

    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onLoadEligibleConnections={onLoadEligibleConnections}
        onInviteConnections={vi.fn(async () => {
          throw new Error("You are no longer allowed to invite people.");
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /^(?!View ).*Friend User/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add 1 person" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Add people" })).toBeNull(),
    );
    expect(onLoad).toHaveBeenCalledTimes(2);
    expect(onLoadEligibleConnections).toHaveBeenCalledTimes(1);
  });
  it("offers a system Circle's owner neither destructive door", async () => {
    // The branch used to be a two-way `isOwner && !isSystem`, so the owner of
    // their own emergency Circle fell through to "Leave circle" -- which
    // `_end_membership` refuses with LOCATION_CIRCLE_OWNER_LEAVE_INVALID every
    // single time. The only control at the bottom of the screen was one that
    // could not work.
    const systemCircle = {
      ...circle("circle-sms", "SMS Circle"),
      isSystem: true,
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: false,
        canRotateInviteCode: false,
        canManageCircle: true,
        canModerateInvites: true,
      },
    };
    render(
      <CircleDetailFlow
        circleId="circle-sms"
        {...detailProps(vi.fn(async () => systemCircle))}
      />,
    );

    expect(await screen.findByText("SMS Circle")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Leave circle/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete circle/i })).toBeNull();
    expect(
      screen.queryByText(/managed for you, so it can.t be left or deleted/i),
    ).toBeNull();
  });

  it("still offers an ordinary Circle's owner the delete door", async () => {
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(vi.fn(async () => circle("circle-1", "Meena Family")))}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /Delete circle/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Leave circle/i })).toBeNull();
  });
});

it("withholds circle photo editing when owner authority is absent or lost", async () => {
  const save = vi.fn();
  const view = render(<CirclePhotoEditor circleId="first" photoUrl={null} canEdit onUpdate={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Change circle photo" }));
  await screen.findByRole("dialog", { name: "Circle photo" });
  view.rerender(<CirclePhotoEditor circleId="first" photoUrl={null} canEdit={false} onUpdate={save} />);
  expect(screen.queryByRole("button", { name: "Change circle photo" })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Circle photo" })).not.toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});

describe("a Trusted Circle offers no control that cannot work", () => {
  function trustedCircle(): OneLocationCircleDetail {
    return {
      id: "trusted-circle",
      name: "Trusted",
      kind: "other",
      role: "owner",
      memberCount: 2,
      // No ceiling: the connection graph is not capped.
      memberLimit: null,
      isSystem: false,
      systemKind: "trusted",
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: false,
        canRotateInviteCode: false,
        canManageCircle: true,
        canModerateInvites: true,
        canDeleteCircle: false,
        canLeaveCircle: false,
      },
      members: [
        {
          userId: "owner-user",
          displayName: "Owner",
          role: "owner",
          phoneVerified: true,
          secureLocationReady: true,
        },
        {
          userId: "member-user",
          displayName: "Asha",
          role: "member",
          phoneVerified: true,
          secureLocationReady: true,
        },
      ],
    };
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows neither Delete nor Leave", async () => {
    // Trusted is deliberately NOT `is_system`, so the guard written for the SMS
    // Circle -- `isOwner && circle.isSystem` -- let it fall through to a Delete
    // button that the API and a database trigger both refuse.
    const onLoad = vi.fn(async () => trustedCircle());
    render(
      <CircleDetailFlow circleId="trusted-circle" {...detailProps(onLoad)} />,
    );

    await screen.findByText("Trusted");
    expect(screen.queryByRole("button", { name: /Delete circle/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Leave circle/i })).toBeNull();
    expect(
      screen.queryByText(/Everyone you're connected to is in this Circle/i),
    ).toBeNull();
    expect(screen.queryByText(/choose who is in it/i)).toBeNull();
  });

  it("offers the same member actions as an ordinary Circle", async () => {
    // Trusted membership is now an ordinary explicit membership: removing it
    // does not remove the underlying connection.
    const onLoad = vi.fn(async () => trustedCircle());
    render(
      <CircleDetailFlow circleId="trusted-circle" {...detailProps(onLoad)} />,
    );

    await screen.findByText("Asha");
    expect(
      screen.getByRole("button", { name: "Actions for Asha" }),
    ).toBeTruthy();
  });

  it("still lets an ordinary Circle's owner remove a member", async () => {
    // The narrowing is about Trusted, not about rosters in general.
    const ordinary = { ...trustedCircle(), systemKind: null, id: "circle-1" };
    ordinary.viewerCapabilities = {
      ...ordinary.viewerCapabilities!,
      canDeleteCircle: true,
      canLeaveCircle: false,
    };
    const onLoad = vi.fn(async () => ordinary as OneLocationCircleDetail);
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    await screen.findByText("Asha");
    expect(screen.getByRole("button", { name: /Delete circle/i })).toBeTruthy();
  });
});

describe("a roster row can take back a request it sent", () => {
  function circleWithPending(): OneLocationCircleDetail {
    return {
      id: "circle-1",
      name: "K Family",
      kind: "family",
      role: "owner",
      memberCount: 2,
      memberLimit: 100,
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: true,
        canRotateInviteCode: true,
        canManageCircle: true,
        canModerateInvites: true,
      },
      members: [
        {
          userId: "owner-user",
          displayName: "Owner",
          role: "owner",
          phoneVerified: true,
          secureLocationReady: true,
        },
        {
          userId: "waiting-user",
          displayName: "Sharu Khan",
          role: "member",
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "pending_outgoing",
        },
      ],
    } as OneLocationCircleDetail;
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("offers Cancel where the caller can act, not a dead status", async () => {
    // The Connect directory has always offered Cancel on exactly this row
    // state. The roster showed the same fact -- "Requested" -- with nothing to
    // do about it, so the two screens disagreed about what a pending request
    // is: news on one, a decision you can still change on the other.
    const onCancelMemberRequest = vi.fn(async () => undefined);
    const onLoad = vi.fn(async () => circleWithPending());
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onCancelMemberRequest={onCancelMemberRequest}
      />,
    );

    const cancel = await screen.findByTestId(
      "circle-member-cancel-waiting-user",
    );
    expect(cancel).toBeTruthy();
    // And the bare status is gone, so the row carries one control, not both.
    expect(
      screen.queryByTestId("circle-member-relationship-waiting-user"),
    ).toBeNull();

    fireEvent.click(cancel);
    await waitFor(() =>
      expect(onCancelMemberRequest).toHaveBeenCalledWith(
        "circle-1",
        "waiting-user",
      ),
    );
  });

  it("falls back to the status where the caller cannot cancel", async () => {
    // A surface with no cancel of its own must not grow a button that does
    // nothing. The Location hub is that surface today.
    const onLoad = vi.fn(async () => circleWithPending());
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(
      await screen.findByTestId("circle-member-relationship-waiting-user"),
    ).toHaveTextContent("Requested");
    expect(
      screen.queryByTestId("circle-member-cancel-waiting-user"),
    ).toBeNull();
  });
});

describe("a caller-requested re-read keeps the screen where it was", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([false, true])("preserves an active rename through a refresh started before editing (paged: %s)", async (paged) => {
    const saved = circle("circle-1", "K Family");
    let finishRefresh!: (value: OneLocationCircleDetail) => void;
    const loader = vi.fn().mockResolvedValueOnce(saved)
      .mockImplementationOnce(() => new Promise<OneLocationCircleDetail>((resolve) => { finishRefresh = resolve; }));
    const props = detailProps(paged ? vi.fn() : loader);
    const paging = paged ? {
      onLoadOverview: loader,
      onLoadMembersPage: vi.fn(async () => ({ items: saved.members, page: 1, hasMore: false, totalCount: 1 })),
    } : {};
    const view = render(<CircleDetailFlow circleId="circle-1" {...props} {...paging} reloadSignal={0} />);
    await screen.findByRole("heading", { name: "K Family" });
    view.rerender(<CircleDetailFlow circleId="circle-1" {...props} {...paging} reloadSignal={1} />);
    expect(loader).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    const input = await screen.findByLabelText("Circle name");
    fireEvent.change(input, { target: { value: "  Our   Family  " } });
    await act(async () => finishRefresh(saved));
    expect(input).toHaveValue("  Our   Family  ");
    expect(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await screen.findByRole("heading", { name: "Our Family" });
    expect(props.onRename).toHaveBeenCalledWith("circle-1", "Our Family");
  });

  it("syncs an untouched rename to the refreshed name and disables normalized unchanged or blank names", async () => {
    const onLoad = vi.fn().mockResolvedValueOnce(circle("circle-1", "K Family"))
      .mockResolvedValueOnce(circle("circle-1", "Our Family"));
    const props = detailProps(onLoad);
    const view = render(<CircleDetailFlow circleId="circle-1" {...props} reloadSignal={0} />);
    await screen.findByRole("heading", { name: "K Family" });
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    const input = await screen.findByLabelText("Circle name");
    view.rerender(<CircleDetailFlow circleId="circle-1" {...props} reloadSignal={1} />);
    await waitFor(() => expect(input).toHaveValue("Our Family"));
    const save = screen.getByRole("button", { name: "Save", exact: true });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: " Our   Family " } });
    expect(save).toBeDisabled();
    for (const whitespace of ["\u0085", "\u001c", "\u001d", "\u001e", "\u001f"]) {
      fireEvent.change(input, { target: { value: `${whitespace}Our${whitespace}Family${whitespace}` } });
      expect(save).toBeDisabled();
      fireEvent.change(input, { target: { value: whitespace } });
      expect(save).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: "   " } });
    expect(save).toBeDisabled();
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("keeps a failed rename draft for retry and submits only once while saving", async () => {
    let rejectSave!: (reason: Error) => void;
    const props = detailProps(async () => circle("circle-1", "K Family"));
    props.onRename = vi.fn().mockImplementationOnce(() => new Promise<OneLocationCircleDetail>((_resolve, reject) => { rejectSave = reject; }))
      .mockImplementationOnce(async (id: string, name: string) => circle(id, name));
    render(<CircleDetailFlow circleId="circle-1" {...props} />);
    await screen.findByRole("heading", { name: "K Family" });
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    const input = await screen.findByLabelText("Circle name");
    fireEvent.change(input, { target: { value: "Our Family" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledTimes(1);
    expect(input).toBeDisabled();
    await act(async () => rejectSave(new Error("Try again")));
    expect(input).toHaveValue("Our Family");
    expect(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByLabelText("Circle name")).toBeNull());
    expect(props.onRename).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Our Family" })).toBeInTheDocument();
  });

  it.each([false, true])("does not let a stale overview undo a successful rename (read failed: %s)", async (readFailed) => {
    let finishRefresh!: (value: OneLocationCircleDetail) => void;
    let rejectRefresh!: (reason: Error) => void;
    const saved = circle("circle-1", "K Family");
    const onLoad = vi.fn().mockResolvedValueOnce(saved)
      .mockImplementationOnce(() => new Promise<OneLocationCircleDetail>((resolve, reject) => { finishRefresh = resolve; rejectRefresh = reject; }));
    const props = detailProps(onLoad);
    const view = render(<CircleDetailFlow circleId="circle-1" {...props} reloadSignal={0} />);
    await screen.findByRole("heading", { name: "K Family" });
    view.rerender(<CircleDetailFlow circleId="circle-1" {...props} reloadSignal={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    fireEvent.change(await screen.findByLabelText("Circle name"), { target: { value: "Our Family" } });
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await screen.findByRole("heading", { name: "Our Family" });
    await act(async () => readFailed ? rejectRefresh(new Error("Outdated refresh failed")) : finishRefresh(saved));
    expect(screen.getByRole("heading", { name: "Our Family" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Circle name")).toBeNull();
    expect(screen.queryByText("Outdated refresh failed")).toBeNull();
  });

  it.each(["circle", "owner", "unlock"])("ignores a pending rename after changing the %s scope", async (scope) => {
    let finishSave!: (value: OneLocationCircleDetail) => void;
    const props = detailProps(async (id) => circle(id, id === "circle-1" ? "K Family" : "Other Circle"));
    props.onRename = vi.fn(() => new Promise<OneLocationCircleDetail>((resolve) => { finishSave = resolve; }));
    const initial = { circleId: "circle-1", currentUserId: "owner-user", sessionScope: "unlock-1" };
    const view = render(<CircleDetailFlow {...props} {...initial} />);
    await screen.findByRole("heading", { name: "K Family" });
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    fireEvent.change(await screen.findByLabelText("Circle name"), { target: { value: "Our Family" } });
    fireEvent.keyDown(screen.getByLabelText("Circle name"), { key: "Enter" });
    const next = { ...initial, ...(scope === "circle" ? { circleId: "circle-2" } : scope === "owner" ? { currentUserId: "other-owner" } : { sessionScope: "unlock-2" }) };
    view.rerender(<CircleDetailFlow {...props} {...next} />);
    await waitFor(() => expect(screen.queryByLabelText("Circle name")).toBeNull());
    await screen.findByRole("heading", { name: scope === "circle" ? "Other Circle" : "K Family" });
    await act(async () => finishSave(circle("circle-1", "Our Family")));
    expect(screen.queryByRole("heading", { name: "Our Family" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit", exact: true }));
    expect(await screen.findByLabelText("Circle name")).toHaveValue(scope === "circle" ? "Other Circle" : "K Family");
    expect(screen.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  });

  it("re-reads on a bumped signal", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "K Family"));
    const props = detailProps(onLoad);
    const view = render(
      <CircleDetailFlow circleId="circle-1" {...props} reloadSignal={0} />,
    );
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));

    view.rerender(
      <CircleDetailFlow circleId="circle-1" {...props} reloadSignal={1} />,
    );

    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(2));
  });

  it("does not re-read when the signal has not moved", async () => {
    // Every unrelated re-render must not put a request on the wire.
    const onLoad = vi.fn(async () => circle("circle-1", "K Family"));
    const props = detailProps(onLoad);
    const view = render(
      <CircleDetailFlow circleId="circle-1" {...props} reloadSignal={3} />,
    );
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));

    view.rerender(
      <CircleDetailFlow circleId="circle-1" {...props} reloadSignal={3} />,
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it("reconciles an open Add people picker and drops a removed connection", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "K Family"));
    const onLoadEligibleConnections = vi
      .fn()
      .mockResolvedValueOnce({
        eligibleConnections: [
          {
            connectionId: "connection-asha",
            userId: "asha-user",
            displayName: "Asha Meena",
          },
        ],
        pendingInvites: [],
        remainingCapacity: 4,
      })
      .mockResolvedValueOnce({
        eligibleConnections: [],
        pendingInvites: [],
        remainingCapacity: 4,
      });
    const props = {
      ...detailProps(onLoad),
      onLoadEligibleConnections,
    };
    const view = render(
      <CircleDetailFlow circleId="circle-1" {...props} reloadSignal={0} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    const asha = await screen.findByRole("button", { name: /^(?!View ).*Asha Meena/i });
    fireEvent.click(asha);
    expect(screen.getByRole("button", { name: "Add 1 person" })).toBeEnabled();

    view.rerender(
      <CircleDetailFlow circleId="circle-1" {...props} reloadSignal={1} />,
    );

    await waitFor(() =>
      expect(onLoadEligibleConnections).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByText("Asha Meena")).toBeNull();
    expect(
      within(screen.getByRole("dialog", { name: "Add people" })).getByRole(
        "button",
        { name: "Add people" },
      ),
    ).toBeDisabled();
  });

  it("keeps a valid page-one selection while more eligible people load", async () => {
    const onLoad = vi.fn(async () => circle("circle-1", "K Family"));
    const onLoadEligibleConnectionsPage = vi.fn(
      async (
        _circleId: string,
        options: { page: number; limit: number; query?: string },
      ) => ({
        eligibleConnections: [
          options.page === 1
            ? {
                connectionId: "connection-asha",
                userId: "asha-user",
                displayName: "Asha Meena",
              }
            : {
                connectionId: "connection-ravi",
                userId: "ravi-user",
                displayName: "Ravi Meena",
              },
        ],
        pendingInvites: [],
        remainingCapacity: 4,
        page: options.page,
        hasMore: options.page === 1,
        totalCount: 2,
      }),
    );
    render(
      <CircleDetailFlow
        circleId="circle-1"
        {...detailProps(onLoad)}
        onLoadEligibleConnectionsPage={onLoadEligibleConnectionsPage}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add people" }));
    fireEvent.click(await screen.findByRole("button", { name: /^(?!View ).*Asha Meena/i }));
    expect(screen.getByRole("button", { name: "Add 1 person" })).toBeEnabled();

    fireEvent.click(
      screen.getByRole("button", { name: "Load more connections" }),
    );
    await screen.findByRole("button", { name: /Ravi Meena/i });

    // Page two is not the complete authority. Loading it must not interpret a
    // page-one selection as removed.
    expect(screen.getByRole("button", { name: "Add 1 person" })).toBeEnabled();
  });
});

describe("an impatient second tap never makes a second Circle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates once however many times Create is pressed", async () => {
    // The host clears its busy flag in a `finally`, which runs before the
    // navigation it then starts has committed -- so there is a guaranteed
    // render with this form still mounted, the name still in state and the
    // button live again. Two taps made two identically-named Circles and two
    // success toasts.
    let release: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<OneLocationCircleDetail>((resolve) => {
          release = () => resolve(circle("new-circle", "Roommates"));
        }),
    );

    render(<CreateCircleFlow {...createProps()} onSubmit={onSubmit} />);

    fireEvent.change(
      screen.getByPlaceholderText("Family, close friends, project team"),
      { target: { value: "Roommates" } },
    );
    const create = screen.getByRole("button", { name: "Next" });
    fireEvent.click(create);
    fireEvent.click(create);
    fireEvent.click(create);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    release?.();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it("lets a failed create be retried", async () => {
    // The guard must not outlive a failure, or one server hiccup makes the
    // form permanently dead with the name still typed into it.
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(circle("new-circle", "Meena Family"));

    render(<CreateCircleFlow {...createProps()} onSubmit={onSubmit} />);
    fireEvent.change(
      screen.getByPlaceholderText("Family, close friends, project team"),
      { target: { value: "Roommates" } },
    );
    const create = screen.getByRole("button", { name: "Next" });

    fireEvent.click(create);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    fireEvent.click(create);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });
});

describe("a Circle with only the current user stays compact", () => {
  function emptyCircle(
    systemKind: "trusted" | "sms" | null,
    canInvite = true,
  ): OneLocationCircleDetail {
    return {
      id: "circle-1",
      name: systemKind === "trusted" ? "Trusted" : "SMS Circle",
      kind: "other",
      role: "owner",
      memberCount: 1,
      memberLimit: 100,
      isSystem: systemKind === "sms",
      systemKind,
      viewerCapabilities: {
        canInviteMembers: canInvite,
        canViewInviteCode: systemKind === null,
        canRotateInviteCode: systemKind === null,
        canManageCircle: true,
        canModerateInvites: true,
      },
      members: [
        {
          userId: "owner-user",
          displayName: "Owner",
          role: "owner",
          phoneVerified: true,
          secureLocationReady: true,
        },
      ],
    } as OneLocationCircleDetail;
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not blame a search the person never ran", async () => {
    // Both branches used to be one, so a Circle with nobody in it said
    // "No members found · Try a different name" and offered nothing. Three
    // Circles reach this state without being asked for -- the SMS Circle and
    // Trusted arrive on their own, and onboarding makes one more -- so it is
    // the first thing many people ever see here.
    const onLoad = vi.fn(async () => emptyCircle("sms"));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("You · Owner")).toBeTruthy();
    expect(screen.queryByText("No one's in this Circle yet")).toBeNull();
    expect(screen.queryByText("Try a different name.")).toBeNull();
  });

  it("offers one Add people action without a second empty-state button", async () => {
    // A Circle you can add to already has an "Add people" action on this screen.
    // A second identical button is not a second option, it is the same one
    // twice -- and it made "Add people" ambiguous to anything looking for it.
    const onLoad = vi.fn(async () => emptyCircle("sms"));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    await screen.findByText("SMS Circle");
    expect(screen.getAllByRole("button", { name: /Add people/i })).toHaveLength(
      1,
    );
    expect(
      screen.queryByTestId("one-location-circle-empty-find-people"),
    ).toBeNull();
  });

  it("keeps the owner row when the reader cannot act", async () => {
    const onLoad = vi.fn(async () => emptyCircle("sms", false));
    render(<CircleDetailFlow circleId="circle-1" {...detailProps(onLoad)} />);

    expect(await screen.findByText("You · Owner")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add people/i })).toBeNull();
  });

});

async function openCirclePeoplePicker() {
  const tab = screen.queryByRole("tab", { name: "Members" });
  if (tab && tab.getAttribute("aria-selected") !== "true") fireEvent.click(tab);
  fireEvent.click(await screen.findByTestId("one-location-circle-add-people-row"));
  await screen.findByRole("dialog", { name: "Add people" });
}
