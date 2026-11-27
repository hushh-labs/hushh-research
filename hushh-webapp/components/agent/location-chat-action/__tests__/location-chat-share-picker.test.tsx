import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { LocationChatSharePicker } from "../location-chat-share-picker";
import { OneLocationService } from "@/lib/one-location/service";

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    listCircles: vi.fn(async () => [{ id: "circle-1", name: "Family" }]),
    listRecipientsPage: vi.fn(async ({ query }: { query?: string }) => ({
      items: query === "Priya" ? [
        { userId: "priya-1", displayName: "Priya", canReceiveLocation: true },
        { userId: "priya-2", displayName: "Priya", canReceiveLocation: true },
      ] : query === "Neelesh" ? [
        { userId: "neelesh", displayName: "Neelesh Meena", canReceiveLocation: true },
      ] : [{ userId: "maya", displayName: "Maya", canReceiveLocation: true }],
      page: 1, hasMore: false,
    })),
  },
}));

test("carry exact typed suggestions into the editable private audience without guessing ambiguous names", async () => {
  const onSelectionChange = vi.fn();
  const onContinue = vi.fn();
  render(<LocationChatSharePicker ownerId="owner" token="owner-token" busy={false}
    suggestedPeople={["Maya", "Priya"]} suggestedCircles={["Family"]}
    onSelectionChange={onSelectionChange} onContinue={onContinue} onBack={() => {}} />);
  await screen.findByRole("button", { name: "Remove Maya from the audience" });
  await screen.findByRole("button", { name: "Remove Family from the audience" });
  expect(screen.queryByRole("button", { name: "Remove Priya from the audience" })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "Find Priya" }));
  expect(await screen.findAllByRole("button", { name: "Priya", exact: true })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Remove Maya from the audience" }));
  expect(screen.queryByRole("radio")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledWith("share_live", [{ label: "Family", circleId: "circle-1" }]);
  await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith({
    mode: "share_live", targets: [{ label: "Family", circleId: "circle-1" }],
  }));
});

test("carries a unique first-name Connection into review without sharing", async () => {
  const onContinue = vi.fn();
  render(<LocationChatSharePicker ownerId="owner" token="owner-token" busy={false}
    suggestedPeople={["Neelesh"]} onContinue={onContinue} onBack={() => {}} />);

  await screen.findByRole("button", { name: "Remove Neelesh Meena from the audience" });
  expect(onContinue).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledWith("share_live", [{ label: "Neelesh Meena", personUserId: "neelesh" }]);
});

test("requests can page to a person without a receiving key and include a Circle without offering sharing", async () => {
  vi.mocked(OneLocationService.listRecipientsPage).mockImplementation(async ({ page = 1 }) => ({
    items: [{ userId: page === 1 ? "maya" : "neelesh", displayName: page === 1 ? "Maya" : "Neelesh", canReceiveLocation: false }],
    page, hasMore: page === 1, total: 2,
  } as Awaited<ReturnType<typeof OneLocationService.listRecipientsPage>>));
  const onContinue = vi.fn();
  render(<LocationChatSharePicker ownerId="owner" token="owner-token" busy={false}
    initialMode="ask" onContinue={onContinue} onBack={() => {}} />);

  expect(screen.queryByRole("radio")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Show more connections" }));
  const person = await screen.findByRole("button", { name: "Neelesh", exact: true });
  expect(person).toBeEnabled();
  fireEvent.click(person);
  fireEvent.click(await screen.findByRole("button", { name: "Family", exact: true }));
  expect(onContinue).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledExactlyOnceWith("ask", [
    { label: "Neelesh", personUserId: "neelesh" }, { label: "Family", circleId: "circle-1" },
  ]);
});
