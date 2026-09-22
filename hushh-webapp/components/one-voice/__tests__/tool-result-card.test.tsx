import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ToolResultCard,
  locationStatusRows,
  sosHeadline,
  sosReasonLine,
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
    // The pending tone is scoped to the armed Save My Soul alert only.
    expect(toneForResult({ status: "sos_grants_created" }, undefined)).toBe(
      "pending",
    );
    expect(toneForResult({ status: "sos_grants_created" }, false)).toBe(
      "pending",
    );
    expect(toneForResult({ status: "check_in_created" }, true)).toBe(
      "failure",
    );
    expect(toolResultFamily("trigger_save_my_soul")).toBe("sos");
    expect(toolResultFamily("report_save_my_soul_delivery")).toBe("sos");
    expect(toolResultFamily("stop_save_my_soul")).toBe("sos");
    // A report that replaced the trigger's timeline entry keeps the family.
    expect(toolResultFamily("", "sos_partial")).toBe("sos");
  });
});

describe("ToolResultCard: Save My Soul", () => {
  const ARMED: ToolResultPublic = {
    status: "sos_grants_created",
    spoken_facts: [
      "Alert armed for Priya Nair and Rahul Mehta; sending your position now.",
    ],
    grant_ids: ["grant_SECRET_a", "grant_SECRET_b"],
    armed: [
      {
        grant_id: "grant_SECRET_a",
        user_id: "usr_SECRET_priya",
        display_name: "Priya Nair",
      },
      {
        grant_id: "grant_SECRET_b",
        user_id: "usr_SECRET_rahul",
        display_name: "Rahul Mehta",
      },
    ],
    skipped_not_phone_verified: [
      { user_id: "usr_SECRET_sam", display_name: "Sam Lee" },
    ],
    note: "note_SECRET",
    client_step: {
      kind: "publish_location_envelopes",
      purpose: "sos",
      sos: true,
      grant_ids: ["grant_SECRET_a", "grant_SECRET_b"],
    },
  };

  it("renders sos_grants_created as armed and sending, never as Done and never as a failure", () => {
    const { container, rerender } = render(
      <ToolResultCard result={ARMED} tool="trigger_save_my_soul" ok={false} />,
    );
    const card = screen.getByTestId("one-voice-tool-result");
    expect(card).toHaveAttribute("data-tone", "pending");
    expect(card).toHaveAttribute("role", "status");
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Armed · sending your position");
    expect(container.textContent).not.toContain("Done");
    expect(container.textContent).not.toContain("didn't go through");
    expect(container.textContent).not.toContain("Nothing was changed");
    expect(container.textContent).not.toMatch(/\bSent\b/);
    expect(screen.getByRole("list", { name: "Alerting" })).toHaveTextContent(
      "Priya Nair",
    );
    expect(screen.getByRole("list", { name: "Alerting" })).toHaveTextContent(
      "Rahul Mehta",
    );
    expect(
      screen.getByRole("list", { name: "Couldn't include" }),
    ).toHaveTextContent("Sam Lee");
    expect(container.textContent).not.toMatch(
      /grant_SECRET|usr_SECRET|note_SECRET/,
    );

    // The relay flags the armed frame ok:false; unknown ok reads the same.
    rerender(<ToolResultCard result={ARMED} tool="trigger_save_my_soul" />);
    expect(screen.getByTestId("one-voice-tool-result")).toHaveAttribute(
      "data-tone",
      "pending",
    );
    expect(container.textContent).not.toContain("didn't go through");
  });

  it("renders the verified delivery report by name: reached, not reached, ended", () => {
    const partial: ToolResultPublic = {
      status: "sos_partial",
      spoken_facts: [
        "Your position reached Priya Nair.",
        "Your position has not reached Rahul Mehta; their share is armed but nothing was sent to them.",
      ],
      delivered: ["Priya Nair"],
      not_alerted: ["Rahul Mehta"],
      delivered_grant_ids: ["grant_SECRET_a"],
      not_alerted_grant_ids: ["grant_SECRET_b"],
      ended_grant_ids: ["grant_SECRET_c"],
      unknown_grant_ids: [],
      expected_grant_ids: ["grant_SECRET_a", "grant_SECRET_b"],
      alert_active: true,
      device_step: { status: "ok", late: false },
    };
    const { container, rerender } = render(
      <ToolResultCard
        result={partial}
        tool="report_save_my_soul_delivery"
        ok
      />,
    );
    expect(screen.getByTestId("one-voice-tool-result")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Partly sent");
    expect(screen.getByRole("list", { name: "Reached" })).toHaveTextContent(
      "Priya Nair",
    );
    expect(screen.getByRole("list", { name: "Not reached" })).toHaveTextContent(
      "Rahul Mehta",
    );
    expect(
      screen.getByRole("list", { name: "Ended shares" }),
    ).toHaveTextContent("1 share");
    expect(container.textContent).toContain("still armed");
    expect(container.textContent).not.toContain("Done");
    expect(container.textContent).not.toMatch(/grant_SECRET/);

    rerender(
      <ToolResultCard
        result={{
          status: "sos_sent",
          spoken_facts: ["Your position reached Priya Nair."],
          delivered: ["Priya Nair"],
          not_alerted: [],
          alert_active: true,
        }}
        tool="report_save_my_soul_delivery"
        ok
      />,
    );
    expect(screen.getByTestId("one-voice-tool-result")).toHaveAttribute(
      "data-tone",
      "success",
    );
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Sent");
    expect(screen.queryByText("Done")).toBeNull();
    expect(container.textContent).not.toContain("still armed");

    rerender(
      <ToolResultCard
        result={{
          status: "sos_not_sent",
          spoken_facts: ["Your position has not reached Priya Nair."],
          delivered: [],
          not_alerted: ["Priya Nair"],
          alert_active: true,
        }}
        tool="report_save_my_soul_delivery"
        ok={false}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Not sent");
    expect(screen.getByRole("list", { name: "Not reached" })).toHaveTextContent(
      "Priya Nair",
    );
    expect(container.textContent).not.toContain("didn't go through");
    expect(container.textContent).not.toContain("Nothing was changed");

    rerender(
      <ToolResultCard
        result={{
          status: "sos_unverified",
          reason_code: "verification_unavailable",
          spoken_facts: ["I couldn't confirm whether your position was sent."],
        }}
        tool="report_save_my_soul_delivery"
        ok={false}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't confirm delivery",
    );
    expect(container.textContent).not.toMatch(/\bSent\b/);
  });

  it("renders a stop by name: stopped and possibly still live", () => {
    const { container, rerender } = render(
      <ToolResultCard
        result={{
          status: "sos_partially_stopped",
          reason_code: "sos_partially_stopped",
          spoken_facts: [
            "1 location share to Priya Nair ended, but 1 share to Rahul Mehta may still be live.",
          ],
          stopped_count: 1,
          stopped: [
            {
              grant_id: "grant_SECRET_a",
              user_id: "usr_SECRET_priya",
              display_name: "Priya Nair",
            },
          ],
          unresolved: [
            {
              grant_id: "grant_SECRET_b",
              user_id: "usr_SECRET_rahul",
              display_name: "Rahul Mehta",
            },
          ],
          unresolved_grant_ids: ["grant_SECRET_b"],
          failed: [{ grant_id: "grant_SECRET_b", reason_code: "still_active" }],
        }}
        tool="stop_save_my_soul"
        ok
      />,
    );
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Partly stopped");
    expect(screen.getByRole("list", { name: "Stopped" })).toHaveTextContent(
      "Priya Nair",
    );
    expect(
      screen.getByRole("list", { name: "May still be live" }),
    ).toHaveTextContent("Rahul Mehta");
    expect(container.textContent).not.toContain("Done");
    expect(container.textContent).not.toMatch(/grant_SECRET|usr_SECRET/);

    rerender(
      <ToolResultCard
        result={{
          status: "sos_stopped",
          spoken_facts: ["Save My Soul stopped; 1 location share to Priya Nair ended."],
          stopped_count: 1,
          stopped: [{ grant_id: "grant_SECRET_a", user_id: "usr_SECRET_priya", display_name: "Priya Nair" }],
        }}
        tool="stop_save_my_soul"
        ok
      />,
    );
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Stopped");
    expect(screen.queryByText("Done")).toBeNull();

    rerender(
      <ToolResultCard
        result={{ status: "not_active", spoken_facts: ["Save My Soul isn't on."] }}
        tool="stop_save_my_soul"
        ok
      />,
    );
    expect(
      screen.getByTestId("one-voice-tool-result-headline"),
    ).toHaveTextContent("Nothing to stop");
  });

  it("explains an audience-changed refusal in plain words and stays a failure", () => {
    render(
      <ToolResultCard
        result={{
          status: "rejected",
          reason_code: "sos_audience_changed",
          spoken_facts: ["Your emergency contacts changed since I showed the card."],
        }}
        tool="trigger_save_my_soul"
        ok={false}
      />,
    );
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("That didn't go through");
    expect(card).toHaveTextContent("Nothing was sent");
    expect(sosReasonLine("sos_audience_changed")).toContain("Nothing was sent");
    expect(sosReasonLine("roster_full")).toContain("full");
    expect(sosReasonLine("sos_already_active")).toContain("already on");
    expect(sosReasonLine("other")).toBeNull();
  });

  it("writes Sent only for the verified sos_sent success", () => {
    expect(sosHeadline("sos_grants_created", "pending")).toBe(
      "Armed · sending your position",
    );
    expect(sosHeadline("sos_sent", "success")).toBe("Sent");
    // A mis-toned sos_sent (ok:false) never says Sent.
    expect(sosHeadline("sos_sent", "failure")).toBeNull();
    expect(sosHeadline("sos_partial", "neutral")).toBe("Partly sent");
    expect(sosHeadline("sos_not_sent", "failure")).toBe("Not sent");
    expect(sosHeadline("sos_unverified", "failure")).toBe(
      "Couldn't confirm delivery",
    );
    expect(sosHeadline("sos_stopped", "success")).toBe("Stopped");
    expect(sosHeadline("sos_partially_stopped", "neutral")).toBe(
      "Partly stopped",
    );
    expect(sosHeadline("renamed", "success")).toBeNull();
  });
});
