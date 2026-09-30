import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ToolResultCard,
  locationStatusRows,
  mailCoverageLine,
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
    expect(toolResultFamily("read_mail")).toBe("mail");
    // read_mail shares ok/empty/rejected with every family, so unlike SOS the
    // mail family must not be inferred from a status.
    expect(toolResultFamily("", "ok")).toBe("generic");
  });

  it("keeps every returned row, in the position the server gave it", () => {
    const result: ToolResultPublic = {
      status: "ok",
      spoken_facts: ["I found 2 messages."],
      answer: "Two invoices are waiting.",
      sources: [{ source_ref: "mail:1", label: "Mail", kind: "metadata" }],
      items: [
        { source_ref: "mail:1", subject: "March invoice", sender: "Acme" },
        // A row the reader could not name. Dropping it renumbered everything
        // below it, so "the second one" pointed at the third message while the
        // person was looking at the second. It is shown unlabelled instead, and
        // nothing is invented to fill it.
        { source_ref: "mail:2" },
        { source_ref: "mail:3", subject: "Statement", sender: "Bookkeeping" },
      ],
      coverage: { unit: "messages", returned: 3, assessed: 9 },
    };
    const { container } = render(
      <ToolResultCard result={result} tool="read_mail" ok />,
    );
    expect(screen.getByText("March invoice")).toBeInTheDocument();
    expect(screen.getByText("No subject")).toBeInTheDocument();
    const list = screen.getByLabelText("Mail");
    expect(list.children).toHaveLength(3);
    // The position the person reads is the ordinal the server resolves, so the
    // unnamed row still occupies two and "Statement" is still three.
    expect(list.children[1]).toHaveAttribute("data-source-ref", "mail:2");
    expect(list.children[2]).toHaveAttribute("data-source-ref", "mail:3");
    expect(container.textContent).toContain("3 of 9 checked");
  });

  it("shows what each message is about when its text was read", () => {
    const result: ToolResultPublic = {
      status: "ok",
      spoken_facts: ["I have those 2 messages."],
      answer: "Priya needs the deck; the invoice is overdue.",
      sources: [{ source_ref: "mail:1", label: "Mail", kind: "message" }],
      items: [
        {
          source_ref: "mail:1",
          subject: "Q3 deck",
          sender: "Priya Nair",
          received_at: "2026-09-28T09:00:00.000Z",
          gist: "Priya wants the Q3 deck by Friday.",
        },
        // No text was supplied for this one, so the backend refused a gist.
        // The row still appears; it just says less.
        { source_ref: "mail:2", subject: "Invoice", sender: "Accounts" },
      ],
      coverage: { unit: "messages", returned: 2, content_depth: "message" },
    };
    render(<ToolResultCard result={result} tool="read_mail" ok />);

    expect(
      screen.getByText("Priya wants the Q3 deck by Friday."),
    ).toBeInTheDocument();
    expect(screen.getByText("Invoice")).toBeInTheDocument();
    expect(screen.getByLabelText("Mail").children).toHaveLength(2);
  });

  it("omits a count the server did not establish rather than printing zero", () => {
    expect(mailCoverageLine({ unit: "messages", content_depth: "metadata" })).toBe(
      "headers only",
    );
    expect(mailCoverageLine({ returned: 0, unit: "messages" })).toBe(
      "0 messages",
    );
    expect(mailCoverageLine(null)).toBeNull();
    expect(mailCoverageLine({})).toBeNull();
    // A needs-reply row is a conversation, not a message.
    expect(mailCoverageLine({ returned: 3, unit: "threads" })).toBe(
      "3 conversations",
    );
    // Nothing narrowed the read, so the count is the front of the mailbox and
    // says so. Five bodies is the reader's budget, not the size of the inbox.
    expect(
      mailCoverageLine({ returned: 5, unit: "messages", scope: "newest" }),
    ).toBe("newest 5 messages");
    expect(
      mailCoverageLine({ returned: 5, unit: "messages", scope: "search" }),
    ).toBe("5 messages");
    // An assessed-vs-returned split still wins: it is the more specific fact.
    expect(
      mailCoverageLine({ returned: 3, assessed: 9, unit: "messages", scope: "newest" }),
    ).toBe("3 of 9 checked");
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


describe("ToolResultCard: opening a mail original", () => {
  const CONV = "22222222-2222-4222-8222-222222222222";

  function mailResult(items: Record<string, unknown>[]): ToolResultPublic {
    return {
      status: "ok",
      spoken_facts: ["I read your 3 newest messages."],
      answer: "Priya needs the deck.",
      sources: [{ source_ref: "mail:1", label: "Mail", kind: "message" }],
      items,
      coverage: { unit: "messages", returned: items.length, scope: "newest" },
      offer_revision: 7,
      conversation_id: CONV,
    };
  }

  const THREE = [
    { source_ref: "mail:1", subject: "Q3 deck", sender: "Priya" },
    // No subject and no sender. It used to be dropped, which renumbered the rows
    // under it; the Open below must still send the server's ordinal 3.
    { source_ref: "mail:2" },
    { source_ref: "mail:3", subject: "Invoice", sender: "Acme" },
  ];

  it("sends the server's ordinal, the offer revision and the offer's conversation", async () => {
    const calls: unknown[] = [];
    const onOpenMail = async (input: unknown) => {
      calls.push(input);
      return {
        sourceRef: "mail:3",
        subject: "Invoice",
        sender: "Acme",
        receivedAt: null,
        body: "The March invoice is attached.",
        bodyTruncated: false,
      };
    };
    render(
      <ToolResultCard
        result={mailResult(THREE)}
        tool="read_mail"
        ok
        onOpenMail={onOpenMail}
      />,
    );

    const buttons = screen.getAllByTestId("one-voice-mail-open");
    expect(buttons).toHaveLength(3);
    // The third row. Its ordinal is 3 even though the row above it is unlabelled
    // -- the number comes from source_ref, never from a count of the DOM.
    expect(buttons[2]).toHaveAttribute("data-ordinal", "3");
    fireEvent.click(buttons[2]);

    await waitFor(() => {
      expect(
        screen.getByText("The March invoice is attached."),
      ).toBeInTheDocument();
    });
    expect(calls).toEqual([
      { ordinal: 3, offerRevision: 7, conversationId: CONV },
    ]);
  });

  it("shows analysis by category while Open stays bound to the original row", async () => {
    const calls: unknown[] = [];
    const result = mailResult([
      { source_ref: "mail:1", subject: "Status note", sender: "Alex" },
      {
        source_ref: "mail:2", subject: "Project review", sender: "Priya",
        analysis: [
          {
            category: "action_items", source_ref: "mail:2",
            detail: "Review the proposal by Friday.", state: "active",
          },
          {
            category: "meetings", source_ref: "mail:2",
            detail: "Meeting moved to 4 pm.", state: "rescheduled",
          },
        ],
      },
    ]);
    result.coverage = {
      unit: "messages", returned: 2, scope: "search",
      analysis_requested: ["personal_info", "action_items", "meetings"],
      analysis_failed: ["personal_info"],
      findings_action_items: 1, findings_meetings: 1,
    };
    render(
      <ToolResultCard
        result={result}
        tool="read_mail"
        ok
        onOpenMail={async (input) => {
          calls.push(input);
          return {
            sourceRef: "mail:2", subject: "Project review", sender: "Priya",
            receivedAt: null, body: "Please review the proposal by Friday.",
            bodyTruncated: false,
          };
        }}
      />,
    );
    const headings = screen.getByTestId("one-voice-mail-analysis-headings");
    expect(headings).toHaveTextContent("Personal-information requests: unavailable");
    expect(headings).toHaveTextContent("Action items: 1");
    expect(headings).toHaveTextContent("Meetings in Mail: 1");
    expect(screen.getByText("Review the proposal by Friday.")).toBeInTheDocument();
    expect(screen.getByText("Meeting moved to 4 pm.")).toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId("one-voice-mail-open")[1]);
    await waitFor(() => expect(screen.getByTestId("one-voice-mail-original")).toBeInTheDocument());
    expect(calls).toEqual([{ ordinal: 2, offerRevision: 7, conversationId: CONV }]);
  });

  it("closing returns to the same list in the same order", async () => {
    const onOpenMail = async () => ({
      sourceRef: "mail:1",
      subject: "Q3 deck",
      sender: "Priya",
      receivedAt: null,
      body: "Friday please.",
      bodyTruncated: false,
    });
    render(
      <ToolResultCard
        result={mailResult(THREE)}
        tool="read_mail"
        ok
        onOpenMail={onOpenMail}
      />,
    );
    const order = () =>
      Array.from(screen.getByLabelText("Mail").children).map((row) =>
        row.getAttribute("data-source-ref"),
      );
    const before = order();

    fireEvent.click(screen.getAllByTestId("one-voice-mail-open")[0]);
    await waitFor(() =>
      expect(screen.getByText("Friday please.")).toBeInTheDocument(),
    );
    // Expanding in place is what makes Back free: the list never unmounted.
    expect(order()).toEqual(before);

    fireEvent.click(screen.getAllByTestId("one-voice-mail-open")[0]);
    await waitFor(() =>
      expect(screen.queryByTestId("one-voice-mail-original")).toBeNull(),
    );
    expect(order()).toEqual(before);
  });

  it("says the list moved on rather than opening something else", async () => {
    const onOpenMail = async () => {
      throw Object.assign(new Error("stale"), { reason: "offer_superseded" });
    };
    render(
      <ToolResultCard
        result={mailResult(THREE)}
        tool="read_mail"
        ok
        onOpenMail={onOpenMail}
      />,
    );

    fireEvent.click(screen.getAllByTestId("one-voice-mail-open")[0]);

    await waitFor(() => {
      expect(
        screen.getByTestId("one-voice-mail-open-error"),
      ).toHaveTextContent("This list has been replaced");
    });
  });

  it("offers no Open control when the rows carry no offer to open against", () => {
    const unbound = mailResult(THREE);
    delete unbound.offer_revision;
    render(
      <ToolResultCard
        result={unbound}
        tool="read_mail"
        ok
        onOpenMail={async () => {
          throw new Error("must not be called");
        }}
      />,
    );
    // Rows still render; there is simply nothing to resolve a position against.
    expect(screen.getByLabelText("Mail").children).toHaveLength(3);
    expect(screen.queryAllByTestId("one-voice-mail-open")).toHaveLength(0);
  });

  it("renders no Open control at all without a handler, so bare renders are unchanged", () => {
    render(<ToolResultCard result={mailResult(THREE)} tool="read_mail" ok />);
    expect(screen.queryAllByTestId("one-voice-mail-open")).toHaveLength(0);
  });
});

describe("ToolResultCard: a spoken open runs the same code as a tap", () => {
  const CONV = "22222222-2222-4222-8222-222222222222";
  const ROWS = [
    { source_ref: "mail:1", subject: "Q3 deck", sender: "Priya" },
    { source_ref: "mail:2", subject: "March invoice", sender: "Acme" },
  ];

  function result(): ToolResultPublic {
    return {
      status: "ok",
      spoken_facts: ["I read your 2 newest messages."],
      answer: "Two findings.",
      sources: [],
      items: ROWS,
      coverage: { unit: "messages", returned: 2, scope: "newest" },
      offer_revision: 7,
      conversation_id: CONV,
    };
  }

  async function speakOpen(detail: Record<string, unknown>) {
    const { ONE_VOICE_OPEN_MAIL_EVENT } = await import(
      "@/lib/one-voice/directives"
    );
    const settled: Array<[string, string | undefined]> = [];
    window.dispatchEvent(
      new CustomEvent(ONE_VOICE_OPEN_MAIL_EVENT, {
        detail: {
          offerRevision: 7,
          conversationId: CONV,
          ...detail,
          settle: (status: string, reason?: string) =>
            settled.push([status, reason]),
        },
      }),
    );
    return settled;
  }

  it("opens the row the directive names, through the same resolver", async () => {
    const calls: unknown[] = [];
    render(
      <ToolResultCard
        result={result()}
        tool="read_mail"
        ok
        onOpenMail={async (input) => {
          calls.push(input);
          return {
            sourceRef: "mail:2",
            subject: "March invoice",
            sender: "Acme",
            receivedAt: null,
            body: "Invoice 4471 is overdue.",
            bodyTruncated: false,
          };
        }}
      />,
    );

    const settled = await speakOpen({ ordinal: 2 });

    await waitFor(() =>
      expect(screen.getByText("Invoice 4471 is overdue.")).toBeInTheDocument(),
    );
    // The same controller call a tap makes, with the same binding.
    expect(calls).toEqual([
      { ordinal: 2, offerRevision: 7, conversationId: CONV },
    ]);
    // Settled once the message is on screen, not when the handler returned.
    await waitFor(() => expect(settled).toEqual([["opened", undefined]]));
    // The list is still there: a spoken open does not take away the rows the
    // ordinal refers to.
    expect(screen.getByLabelText("Mail").children).toHaveLength(2);
  });

  it("refuses a directive for a list this card is not showing, without asking", async () => {
    const calls: unknown[] = [];
    render(
      <ToolResultCard
        result={result()}
        tool="read_mail"
        ok
        onOpenMail={async (input) => {
          calls.push(input);
          throw new Error("must not be called");
        }}
      />,
    );

    const stale = await speakOpen({ ordinal: 2, offerRevision: 6 });
    const foreign = await speakOpen({ ordinal: 2, conversationId: "other" });

    expect(stale).toEqual([["failed", "offer_mismatch"]]);
    expect(foreign).toEqual([["failed", "offer_mismatch"]]);
    // Position two of another list is not position two of this one, and the
    // refusal happens before any request rather than after a wrong answer.
    expect(calls).toEqual([]);
    expect(screen.queryByTestId("one-voice-mail-original")).toBeNull();
  });
});
