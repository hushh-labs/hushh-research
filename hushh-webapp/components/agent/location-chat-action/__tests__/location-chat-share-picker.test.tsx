import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { LocationChatSharePicker } from "../location-chat-share-picker";

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
  fireEvent.click(screen.getByRole("radio", { name: "Current pin" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledWith("share_pin", [{ label: "Family", circleId: "circle-1" }]);
  await waitFor(() => expect(onSelectionChange).toHaveBeenLastCalledWith({
    mode: "share_pin", targets: [{ label: "Family", circleId: "circle-1" }],
  }));
});

test("carries a unique first-name Connection into review without sharing", async () => {
  const onContinue = vi.fn();
  render(<LocationChatSharePicker ownerId="owner" token="owner-token" busy={false}
    suggestedPeople={["Neelesh"]} onContinue={onContinue} onBack={() => {}} />);

  await screen.findByRole("button", { name: "Remove Neelesh Meena from the audience" });
  expect(onContinue).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: "Current pin" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledWith("share_pin", [{ label: "Neelesh Meena", personUserId: "neelesh" }]);
});
