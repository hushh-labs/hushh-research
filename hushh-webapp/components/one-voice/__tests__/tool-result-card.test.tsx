import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ToolResultCard,
  locationStatusRows,
  toneForResult,
  toolResultFamily,
} from "@/components/one-voice/tool-result-card";
import type { ToolResultPublic } from "@/lib/one-voice/protocol";

afterEach(() => cleanup());

describe("ToolResultCard", () => {
  it("renders spoken_facts as the summary and a Done chip only for ok:true + success status", () => {
    const result: ToolResultPublic = {
      status: "created",
      spoken_facts: ["Created the Family circle."],
      circle: {
        circle_id: "0f7d8e5c-1111-2222-3333-444455556666",
        name: "Family",
        kind: "family",
        member_count: 1,
        is_owner: true,
      },
    };
    const { container, rerender } = render(
      <ToolResultCard result={result} tool="create_circle" ok />,
    );
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Done");
    expect(screen.getByText("Created the Family circle.")).toBeInTheDocument();
    expect(screen.getByText("Family")).toBeInTheDocument();
    expect(screen.getByText("1 member · Yours")).toBeInTheDocument();
    expect(container.textContent).not.toContain("0f7d8e5c");
    expect(screen.getByTestId("one-voice-tool-result")).toHaveAttribute(
      "data-tone",
      "success",
    );

    // The same payload with ok:false is never success.
    rerender(
      <ToolResultCard result={result} tool="create_circle" ok={false} />,
    );
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.getByTestId("one-voice-tool-result")).toHaveAttribute(
      "data-tone",
      "failure",
    );

    // Unknown ok never renders as success either.
    rerender(<ToolResultCard result={result} tool="create_circle" />);
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.getByTestId("one-voice-tool-result")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
  });

  it("shows ok:false inline as an error, never a toast", () => {
    render(
      <ToolResultCard
        result={{
          status: "rejected",
          reason_code: "NOT_CONNECTED",
          spoken_facts: ["Alex isn't connected with you yet."],
        }}
        tool="share_with"
        ok={false}
      />,
    );
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("That didn't go through");
    expect(card).toHaveTextContent("Alex isn't connected with you yet.");
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });

  it("renders three distinct location rows and never says On without both facts", () => {
    const rows = locationStatusRows({
      status: "ok",
      sharing_state: "on",
      os_permission_reported: "denied",
      precision: "approximate",
    });
    expect(rows?.devicePermission.value).toBe("Denied");
    expect(rows?.appSharing.value).toBe("Waiting on device permission");
    expect(rows?.precision?.value).toBe("Approximate");

    render(
      <ToolResultCard
        result={{
          status: "ok",
          sharing_state: "on",
          os_permission_reported: "denied",
          precision: "precise",
          spoken_facts: [
            "Sharing with people is on, but your device location permission is denied.",
          ],
        }}
        tool="get_location_status"
        ok
      />,
    );
    const list = screen.getByRole("list", { name: "Location status" });
    expect(list).toHaveTextContent("Device permission");
    expect(list).toHaveTextContent("Sharing with people");
    expect(list).toHaveTextContent("Precision");
    expect(list.querySelectorAll("li")).toHaveLength(3);
    const values = Array.from(list.querySelectorAll("li")).map(
      (li) => li.lastElementChild?.textContent,
    );
    expect(values).toEqual([
      "Denied",
      "Waiting on device permission",
      "Precise",
    ]);
    expect(values).not.toContain("On");
  });

  it("says On only when sharing_state is on and the OS permission is granted", () => {
    expect(
      locationStatusRows({
        status: "ok",
        sharing_state: "on",
        os_permission_reported: "granted",
      })?.appSharing.value,
    ).toBe("On");
    expect(
      locationStatusRows({
        status: "ok",
        sharing_state: "on",
        os_permission_reported: "prompt",
      })?.appSharing.value,
    ).not.toBe("On");
    expect(
      locationStatusRows({
        status: "ok",
        sharing_state: "off",
        os_permission_reported: "granted",
      })?.appSharing.value,
    ).toBe("Off");
    expect(
      locationStatusRows({
        status: "ok",
        sharing_state: "unset",
        os_permission_reported: "unknown",
      })?.appSharing.value,
    ).toBe("Not set up");
    expect(locationStatusRows({ status: "ok" })).toBeNull();
  });

  it("renders people, shares and links by name without ids or grant ids", () => {
    const { container, rerender } = render(
      <ToolResultCard
        result={{
          status: "ok",
          spoken_facts: ["You have 2 connections."],
          connected: [
            {
              user_id: "usr_SECRET_a",
              display_name: "Priya Sharma",
              relationship: "connected",
              photo_url: null,
            },
            {
              user_id: "usr_SECRET_b",
              display_name: "Alex Chen",
              relationship: "connected",
              photo_url: null,
            },
          ],
          pending_outgoing: [
            {
              request_id: "req_SECRET",
              user_id: "usr_SECRET_c",
              display_name: "Sam Lee",
            },
          ],
        }}
        tool="list_people"
        ok
      />,
    );
    expect(screen.getByText("Priya Sharma")).toBeInTheDocument();
    expect(screen.getByText("Alex Chen")).toBeInTheDocument();
    expect(screen.getByText("Sam Lee")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/usr_SECRET|req_SECRET/);

    rerender(
      <ToolResultCard
        result={{
          status: "ok",
          spoken_facts: ["You're sharing your location with 1 person."],
          outgoing: [
            {
              grant_id: "grant_SECRET",
              direction: "outgoing",
              status: "active",
              counterpart_user_id: "usr_SECRET_a",
              counterpart_name: "Priya Sharma",
              duration_mode: "until_stopped",
              awaiting_first_position: true,
            },
          ],
          incoming: [],
        }}
        tool="list_shares"
        ok
      />,
    );
    expect(screen.getByText("You share with")).toBeInTheDocument();
    expect(screen.getByText("Priya Sharma")).toBeInTheDocument();
    expect(
      screen.getByText("until stopped, no position yet"),
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/grant_SECRET|usr_SECRET/);

    rerender(
      <ToolResultCard
        result={{
          status: "ok",
          spoken_facts: ["You have 1 live public link."],
          links: [
            {
              invite_id: "inv_SECRET",
              status: "active",
              url: "https://hussh.one/l/abc",
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            },
            {
              invite_id: "inv_SECRET2",
              status: "revoked",
              url: "https://hussh.one/l/def",
            },
          ],
        }}
        tool="list_links"
        ok
      />,
    );
    expect(screen.getByText("https://hussh.one/l/abc")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(container.textContent).not.toContain("inv_SECRET");
  });

  it("classifies tools into families and tones", () => {
    expect(toolResultFamily("list_people")).toBe("people");
    expect(toolResultFamily("rename_circle")).toBe("circles");
    expect(toolResultFamily("share_with")).toBe("shares");
    expect(toolResultFamily("create_public_link")).toBe("links");
    expect(toolResultFamily("get_location_settings")).toBe("status");
    expect(toolResultFamily("open_screen")).toBe("generic");
    expect(toneForResult({ status: "confirmation_required" }, undefined)).toBe(
      "failure",
    );
    expect(toneForResult({ status: "ok" }, undefined)).toBe("neutral");
    expect(toneForResult({ status: "grant_created" }, true)).toBe("failure");
    expect(toneForResult({ status: "empty" }, true)).toBe("neutral");
    expect(toneForResult({ status: "renamed" }, true)).toBe("success");
  });
});
