// @vitest-environment jsdom
//
// Reported: sharing again with somebody who could already see you for two
// hours, this time for fifteen minutes, silently ended the two-hour share.
// The backend has always replaced rather than extended; what was missing was
// anything on screen saying so before the button.
//
// These are the two surfaces that say it: the amber read-back under the
// confirm step's recipient rail, and the dialog that makes the owner agree
// before the request goes out.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ShareReplacementConfirmDialog,
  ShareReplacementNotice,
  type ShareReplacementRow,
} from "@/components/one-location/redesign/share-replacement-notice";

function row(overrides: Partial<ShareReplacementRow> = {}): ShareReplacementRow {
  return {
    recipientUserId: "user_b",
    label: "Aarti",
    untilStopped: false,
    remainingLabel: "1h 47m more",
    ...overrides,
  };
}

describe("ShareReplacementNotice", () => {
  it("renders nothing when the new share takes no time away", () => {
    // The ordinary case -- a first share, or a longer one. A warning that
    // appears on every share is a warning nobody reads.
    const { container } = render(
      <ShareReplacementNotice rows={[]} newDurationLabel="15 min" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names the person, what they have, and what replaces it", () => {
    render(
      <ShareReplacementNotice rows={[row()]} newDurationLabel="15 min" />,
    );

    expect(
      screen.getByTestId("one-location-share-replacement-notice"),
    ).toBeTruthy();
    const text = screen.getByTestId(
      "one-location-share-replacement-notice",
    ).textContent;
    expect(text).toContain("Aarti can see you for 1h 47m more");
    expect(text).toContain("15 min");
  });

  it("lists every person when a share goes to several at once", () => {
    // Only the people who lose time reach this component, so each name here is
    // somebody the owner is about to take time from.
    render(
      <ShareReplacementNotice
        rows={[
          row(),
          row({ recipientUserId: "user_c", label: "Ravi", remainingLabel: "40 more min" }),
          row({ recipientUserId: "user_d", label: "Meera", remainingLabel: "3 more hours" }),
        ]}
        newDurationLabel="15 min"
      />,
    );

    expect(screen.getAllByTestId("one-location-share-replacement-row")).toHaveLength(3);
    for (const name of ["Aarti", "Ravi", "Meera"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("writes an open-ended share into the sentence, not into a noun slot", () => {
    // The worst case: an end time imposed on a share that had none. It has no
    // remaining figure, and dropping the standalone label into the sentence
    // produced "Aarti has Until you stop." -- broken prose on the one screen
    // whose job is being understood before a button is pressed.
    render(
      <ShareReplacementNotice
        rows={[row({ untilStopped: true, remainingLabel: "Until you stop" })]}
        newDurationLabel="15 min"
      />,
    );

    const text = screen.getByTestId(
      "one-location-share-replacement-notice",
    ).textContent;
    expect(text).toContain("Aarti can see you until you stop.");
    expect(text).not.toContain("has Until you stop");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Invalid Date");
  });
});

describe("ShareReplacementConfirmDialog", () => {
  function renderDialog(
    rows: ShareReplacementRow[],
    onConfirm = vi.fn(),
    onOpenChange = vi.fn(),
  ) {
    render(
      <ShareReplacementConfirmDialog
        open
        onOpenChange={onOpenChange}
        rows={rows}
        newDurationLabel="15 min"
        busy={false}
        onConfirm={onConfirm}
      />,
    );
    return { onConfirm, onOpenChange };
  }

  it("renders nothing when there is nothing to confirm", () => {
    const { container } = render(
      <ShareReplacementConfirmDialog
        open
        onOpenChange={vi.fn()}
        rows={[]}
        newDurationLabel="15 min"
        busy={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("states the trade before it asks for it", () => {
    renderDialog([row()]);

    expect(screen.getByRole("alertdialog").textContent).toContain(
      "Aarti can see you for 1h 47m more",
    );
    expect(screen.getByRole("alertdialog").textContent).toContain("15 min");
  });

  it("starts the share only when the owner accepts", () => {
    const { onConfirm } = renderDialog([row()]);

    fireEvent.click(
      screen.getByTestId("one-location-share-replacement-accept"),
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps the running share when the owner backs out", () => {
    // Backing out must not post anything. The whole point of the dialog is
    // that the two-hour share survives an accidental fifteen-minute re-share.
    const { onConfirm } = renderDialog([row()]);

    fireEvent.click(
      screen.getByTestId("one-location-share-replacement-cancel"),
    );
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows each person's before and after when several are affected", () => {
    renderDialog([
      row(),
      row({ recipientUserId: "user_c", label: "Ravi", remainingLabel: "40 more min" }),
    ]);

    const list = screen.getByTestId(
      "one-location-share-replacement-confirm-list",
    );
    expect(list.textContent).toContain("Aarti");
    expect(list.textContent).toContain("1h 47m more");
    expect(list.textContent).toContain("Ravi");
    expect(list.textContent).toContain("40 more min");
  });
});
