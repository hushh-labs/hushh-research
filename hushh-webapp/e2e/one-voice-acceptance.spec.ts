import { expect, test, type Page } from "@playwright/test";

import {
  CONVERSATION_ID,
  mockVoiceRelay,
  pendingAction,
  toolResult,
  type ClientFrame,
  type RelayStep,
  type ServerFrame,
} from "./fixtures/one-voice-relay";
import {
  hasReviewerSession,
  openReviewerSession,
} from "./fixtures/reviewer-session";

/**
 * Acceptance flows for Talk to One (One Live Voice) against a MOCKED relay.
 *
 * The relay is scripted per turn (see fixtures/one-voice-relay.ts); the client,
 * the reducer, the docked panel, and the Location screens are real. Every
 * assertion is about what the client SENT (auth first, receipt tokens, cancel)
 * and what the UI could only have rendered from a server frame. No audio is
 * asserted: the conversation is driven through the panel's "Type instead"
 * affordance, which sends the same `text` frame a transcript would produce.
 */

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

const PRIYA = {
  user_id: "u-priya",
  public_person_ref: "ref-priya",
  display_name: "Priya Nair",
  photo_url: null,
  relationship: "connected",
  has_location_key: true,
  phone_verified: true,
  match_tier: 0,
};
const AYESHA = {
  user_id: "u-ayesha",
  public_person_ref: "ref-ayesha",
  display_name: "Ayesha Sharma",
  photo_url: null,
  relationship: "connected",
  has_location_key: true,
  phone_verified: true,
  match_tier: 3,
};
const AISHA = {
  user_id: "u-aisha",
  public_person_ref: "ref-aisha",
  display_name: "Aisha Khan",
  photo_url: null,
  relationship: "connected",
  has_location_key: true,
  phone_verified: true,
  match_tier: 3,
};

async function startSession(page: Page): Promise<void> {
  await page
    .getByTestId("one-voice-agent-bar")
    .waitFor({ state: "visible", timeout: 60_000 });
  await page
    .locator('[data-native-voice-control-id="one_voice_agent_bar_start"]')
    .click();
  await page
    .getByTestId("one-voice-panel")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function say(page: Page, text: string): Promise<void> {
  const toggle = page.getByTestId("one-voice-type-instead");
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.getByTestId("one-voice-type-input").fill(text);
  await page.getByTestId("one-voice-type-send").click();
}

test.describe("Talk to One acceptance (mocked relay, real client + UI)", () => {
  test.skip(
    !hasReviewerSession(),
    "needs REVIEWER_UID/REVIEWER_VAULT_PASSPHRASE and E2E_REVIEWER_SIGNIN=1",
  );

  test("the auth frame is the first thing on the wire and nothing goes to googleapis", async ({
    page,
  }) => {
    const relay = await mockVoiceRelay(page, []);
    const providerRequests: string[] = [];
    page.on("request", (request) => {
      if (/googleapis\.com/.test(request.url()))
        providerRequests.push(request.url());
    });
    await openReviewerSession(page);
    await startSession(page);
    const auth = await relay.waitFor((frame) => frame.type === "auth");
    expect(relay.sent[0]?.type).toBe("auth");
    expect(String(auth.vault_owner_token)).toMatch(/^HCT:/);
    expect(auth.conversation_id).toHaveLength(36);
    expect(relay.ticketCalls).toBe(1);
    expect(providerRequests).toEqual([]);
  });

  test("(3) with no connections, asking for John offers the invite flow and never a request", async ({
    page,
  }) => {
    const relay = await mockVoiceRelay(page, [
      {
        reply: [
          toolResult("resolve_person", {
            status: "no_connections",
            needs: "invite",
            candidates: [],
            spoken_facts: ["You don't have anyone connected yet."],
          }),
        ],
      },
    ]);
    const requestPosts: string[] = [];
    await page.route("**/api/one/location/requests", async (route) => {
      requestPosts.push(route.request().method());
      await route.fulfill({ status: 500, body: "should never be called" });
    });
    await openReviewerSession(page);
    await startSession(page);
    await say(page, "Ask John for his location");
    await expect(page.getByTestId("one-voice-tool-result")).toContainText(
      "anyone connected yet",
    );
    expect(requestPosts).toEqual([]);
    expect(page.getByTestId("one-voice-pending-action")).toHaveCount(0);
    expect(relay.sent.filter((f) => f.type === "confirm_action")).toEqual([]);
  });

  test("(4) a mispronounced name renders a candidate picker; picking sends candidate.choose", async ({
    page,
  }) => {
    const relay = await mockVoiceRelay(page, [
      {
        reply: [
          toolResult("resolve_person", {
            status: "multiple",
            needs: "disambiguation",
            candidates: [AYESHA, AISHA],
            spoken_facts: [],
          }),
          {
            type: "candidate_picker",
            kind: "person",
            question: "Which one do you mean?",
            candidates: [AYESHA, AISHA],
          },
        ],
      },
    ]);
    await openReviewerSession(page);
    await startSession(page);
    await say(page, "Ask Aisha for her location");
    const picker = page.getByRole("button", { name: /Ayesha Sharma/ });
    await expect(picker).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Aisha Khan/ }),
    ).toBeVisible();
    await expect(page.getByTestId("one-voice-panel")).not.toContainText(
      "u-ayesha",
    );
    await picker.click();
    const choice = await relay.waitFor((f) => f.type === "candidate.choose");
    expect(choice).toMatchObject({ kind: "person", id: "u-ayesha" });
  });

  test("(5) creating a Family circle and inviting Priya confirms the exact person and reports real results", async ({
    page,
  }) => {
    const relay = await mockVoiceRelay(page, [
      {
        reply: [
          pendingAction({
            pending_action_id: "11111111-aaaa-4aaa-8aaa-111111111111",
            tool: "create_circle",
            gateway_action_id: "location.create_circle",
            summary: "create the Family circle",
            tier: "voice",
            args: { name: "Family", kind: "family" },
          }),
        ],
      },
      {
        when: (f) => f.type === "text" && /priya/i.test(String(f.text)),
        reply: [
          toolResult("confirm_person", {
            status: "confirmed",
            spoken_facts: ["Priya Nair, connected"],
          }),
          { type: "entity_card", kind: "person", ...PRIYA },
          pendingAction({
            pending_action_id: "22222222-bbbb-4bbb-8bbb-222222222222",
            tool: "add_circle_member",
            gateway_action_id: "location.add_to_circle",
            summary: "invite Priya Nair to Family",
            tier: "voice",
            entities: [{ kind: "person", ...PRIYA }],
          }),
        ],
      },
    ]);
    await openReviewerSession(page);
    await startSession(page);
    await say(page, "Create a Family circle");
    await expect(page.getByTestId("one-voice-pending-action")).toContainText(
      "create the Family circle",
    );
    await relay.waitFor((f) => f.type === "pending_action.shown");
    relay.emit([
      {
        type: "pending_action.resolved",
        pending_action_id: "11111111-aaaa-4aaa-8aaa-111111111111",
        status: "executed",
        result_public: {
          status: "created",
          circle_id: "c".repeat(36),
          name: "Family",
          spoken_facts: ["Created the Family circle."],
        },
      },
    ]);
    await expect(page.getByTestId("one-voice-pending-action")).toHaveCount(0);
    await expect(page.getByTestId("one-voice-tool-result")).toContainText(
      /Created the Family circle/,
    );
    await say(page, "Invite Priya to it");
    await expect(page.getByTestId("one-voice-panel-entities")).toContainText(
      "Priya Nair",
    );
    await expect(page.getByTestId("one-voice-pending-action")).toContainText(
      "invite Priya Nair to Family",
    );
    await expect(page.getByTestId("one-voice-panel")).not.toContainText(
      "u-priya",
    );
    // Voice-tier: the client reports the card was shown; no receipt is ever sent for it.
    await relay.waitFor(
      (f) =>
        f.type === "pending_action.shown" &&
        f.pending_action_id === "22222222-bbbb-4bbb-8bbb-222222222222",
    );
    expect(relay.sent.filter((f) => f.type === "confirm_action")).toEqual([]);
  });

  test("(7) cancel clears the pending card, sends cancel_action, and Stop ends the socket", async ({
    page,
  }) => {
    const relay = await mockVoiceRelay(page, [
      {
        reply: [
          pendingAction({
            pending_action_id: "33333333-cccc-4ccc-8ccc-333333333333",
            tool: "turn_sharing_off",
            gateway_action_id: "location.set_sharing_enabled",
            summary: "turn location sharing off and stop your active shares",
            tier: "tap",
          }),
        ],
      },
    ]);
    await openReviewerSession(page);
    await startSession(page);
    await say(page, "Turn my location off");
    await expect(page.getByTestId("one-voice-pending-action")).toContainText(
      "turn location sharing off",
    );
    await expect(
      page.getByTestId("one-voice-pending-instruction"),
    ).toContainText(/Tap Confirm/i);
    await page.getByTestId("one-voice-pending-cancel").click();
    const cancel = await relay.waitFor((f) => f.type === "cancel_action");
    expect(cancel.pending_action_id).toBe(
      "33333333-cccc-4ccc-8ccc-333333333333",
    );
    relay.emit([
      {
        type: "pending_action.resolved",
        pending_action_id: "33333333-cccc-4ccc-8ccc-333333333333",
        status: "cancelled",
        result_public: null,
      },
    ]);
    await expect(page.getByTestId("one-voice-pending-confirm")).toHaveCount(0);
    expect(relay.sent.filter((f) => f.type === "confirm_action")).toEqual([]);
    await page.getByTestId("one-voice-stop").click();
    await relay.waitFor((f) => f.type === "end");
  });

  test("(2)(9) a tap confirmation carries the receipt token, and success renders only from the resolved frame", async ({
    page,
  }) => {
    const relay = await mockVoiceRelay(page, [
      {
        reply: [
          pendingAction({
            pending_action_id: "44444444-dddd-4ddd-8ddd-444444444444",
            tool: "turn_sharing_off",
            gateway_action_id: "location.set_sharing_enabled",
            summary: "turn location sharing off and stop your active shares",
            tier: "tap",
          }),
        ],
      },
    ]);
    await openReviewerSession(page);
    await startSession(page);
    await say(page, "Turn my location off");
    await expect(page.getByTestId("one-voice-pending-action")).toBeVisible();
    // A transcript claiming success must not render success.
    relay.emit([
      {
        type: "transcript.output",
        text: "Done, sharing is off.",
        final: true,
        turn_id: "t-x",
      },
    ]);
    await expect(page.getByTestId("one-voice-pending-resolved")).toHaveCount(0);
    await page.getByTestId("one-voice-pending-confirm").click();
    const confirm = await relay.waitFor((f) => f.type === "confirm_action");
    expect(confirm).toMatchObject({
      pending_action_id: "44444444-dddd-4ddd-8ddd-444444444444",
      receipt_token: "receipt-e2e",
      source: "tap",
    });
    relay.emit([
      {
        type: "pending_action.resolved",
        pending_action_id: "44444444-dddd-4ddd-8ddd-444444444444",
        status: "executed",
        result_public: {
          status: "off",
          spoken_facts: ["Sharing is off. I stopped 2 active shares."],
          revoked_grant_ids: ["g1", "g2"],
        },
      },
      toolResult("turn_sharing_off", {
        status: "off",
        spoken_facts: ["Sharing is off. I stopped 2 active shares."],
      }),
    ]);
    await expect(page.getByTestId("one-voice-pending-resolved")).toContainText(
      "Sharing is off",
    );
  });

  test("(6) 'show my profile' opens the real profile from a navigate directive", async ({
    page,
  }) => {
    const relay = await mockVoiceRelay(page, [
      {
        reply: [
          toolResult("open_screen", {
            status: "navigation_dispatched",
            screen: "profile",
            gateway_action_id: "route.profile",
            spoken_facts: ["Opening it now."],
          }),
          {
            type: "ui_directive",
            directive_id: "d-profile",
            kind: "navigate",
            payload: { gateway_action_id: "route.profile", screen: "profile" },
          },
        ],
      },
    ]);
    await openReviewerSession(page);
    await startSession(page);
    await say(page, "Show my profile");
    const settled = await relay.waitFor((f) => f.type === "ui.settled");
    expect(settled.directive_id).toBe("d-profile");
    await expect(
      page.getByRole("heading", { name: /profile/i }).first(),
    ).toBeVisible({ timeout: 30_000 });
    expect(CONVERSATION_ID).toHaveLength(36);
  });
});

/**
 * This device's Location switch through Live Voice. The relay is scripted
 * (`tool.started` -> `client_step.request {kind: set_location_updates}` ->
 * interim `tool.result location_updates_pending`); everything after that is
 * real: the step bridge, the navigation to /one/location, the Location
 * screen's own switch handler, and the `client_step.result` the client sends
 * back. All three requests run in ONE page session so the second "enable"
 * can only answer `already_on` from the state the first one produced.
 */
test.describe("Talk to One: this device's Location switch (mocked relay, real page)", () => {
  // launchOptions stay at the file's top-level `test.use` (a describe-level
  // override would force a new worker); only the extra permission and a
  // fixed position are added here so the real switch can take a fix.
  test.use({
    permissions: ["microphone", "geolocation"],
    geolocation: { latitude: 37.7749, longitude: -122.4194 },
  });

  test.skip(
    !hasReviewerSession(),
    "needs REVIEWER_UID/REVIEWER_VAULT_PASSPHRASE and E2E_REVIEWER_SIGNIN=1",
  );

  const RESUME_TOOL = "resume_device_location_updates";
  const PAUSE_TOOL = "pause_device_location_updates";
  const RESUME_ACTION = "location.resume_updates";
  const PAUSE_ACTION = "location.pause_updates";
  const STEP_TIMEOUT_S = 45;

  function deviceStep(
    callId: string,
    stepId: string,
    desired: "on" | "off",
  ): RelayStep {
    const tool = desired === "on" ? RESUME_TOOL : PAUSE_TOOL;
    const actionId = desired === "on" ? RESUME_ACTION : PAUSE_ACTION;
    return {
      reply: [
        { type: "tool.started", call_id: callId, tool, args_public: {} },
        {
          type: "client_step.request",
          step_id: stepId,
          kind: "set_location_updates",
          payload: {
            desired_state: desired,
            gateway_action_id: actionId,
            timeout_s: STEP_TIMEOUT_S,
          },
          timeout_s: STEP_TIMEOUT_S,
        },
        {
          ...toolResult(tool, {
            status: "location_updates_pending",
            desired_state: desired,
            gateway_action_id: actionId,
            spoken_facts: [
              `Switching location updates ${desired} for this device now.`,
            ],
          }),
          call_id: callId,
        },
      ],
    };
  }

  function settled(
    callId: string,
    desired: "on" | "off",
    spoken: string,
  ): ServerFrame[] {
    const tool = desired === "on" ? RESUME_TOOL : PAUSE_TOOL;
    const actionId = desired === "on" ? RESUME_ACTION : PAUSE_ACTION;
    return [
      {
        ...toolResult(tool, {
          status: desired,
          desired_state: desired,
          gateway_action_id: actionId,
          observed_state: desired,
          changed: true,
          spoken_facts: [spoken],
        }),
        call_id: callId,
      },
      { type: "state", state: "complete", turn_id: null },
    ];
  }

  function stepResultFor(stepId: string) {
    return (f: ClientFrame) =>
      f.type === "client_step.result" && f.step_id === stepId;
  }

  test("enable, enable again, then disable drives the real switch and reports each step once", async ({
    page,
  }) => {
    const relay = await mockVoiceRelay(page, [
      deviceStep("c1", "st-1", "on"),
      deviceStep("c2", "st-2", "on"),
      deviceStep("c3", "st-3", "off"),
    ]);
    const accountSettingsPatches: string[] = [];
    const revokeRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (
        request.method() === "PATCH" &&
        url.includes("/api/one/location/account-settings")
      ) {
        accountSettingsPatches.push(url);
      }
      if (/revoke/.test(url)) revokeRequests.push(`${request.method()} ${url}`);
    });
    const switchLocator = page.locator(
      '[data-voice-control-id="one-location-updates-toggle"]',
    );
    const statusLocator = page.getByTestId("one-location-header-status");
    const resultCard = page.getByTestId("one-voice-tool-result");

    await openReviewerSession(page, "/one");
    await startSession(page);
    await relay.waitFor((f) => f.type === "auth");

    // (a) From /one: the step navigates to /one/location, runs the switch's
    // own handler, and reports the device's real state -- never a coordinate.
    await say(page, "Can you enable my location?");
    const first = await relay.waitFor(stepResultFor("st-1"), 45_000);
    expect(first.status).toBe("ok");
    const firstPayload = first.payload as Record<string, unknown>;
    expect(firstPayload).toMatchObject({
      outcome: "on",
      observed_state: "on",
      gateway_action_id: RESUME_ACTION,
      desired_state: "on",
    });
    expect(JSON.stringify(firstPayload)).not.toMatch(/latitude|longitude|\blat\b/i);
    await expect(page).toHaveURL(/\/one\/location(?:[?#].*)?$/, {
      timeout: 15_000,
    });
    await expect(switchLocator).toHaveAttribute("aria-checked", "true", {
      timeout: 15_000,
    });
    await expect(statusLocator).toHaveText("Location on", { timeout: 30_000 });
    // The interim pending result never renders a card; the settled one does.
    await expect(resultCard).toHaveCount(0);
    relay.emit(settled("c1", "on", "Location is on."));
    await expect(resultCard).toContainText("Location is on.", {
      timeout: 10_000,
    });
    expect(accountSettingsPatches).toEqual([]);
    expect(revokeRequests).toEqual([]);

    // (b) The same request again is answered from module-level truth: no
    // navigation, no handler run, no network side effect.
    const urlBefore = page.url();
    await say(page, "enable my location again please");
    const second = await relay.waitFor(stepResultFor("st-2"), 45_000);
    expect(second.status).toBe("ok");
    expect(second.payload as Record<string, unknown>).toMatchObject({
      outcome: "already_on",
      observed_state: "on",
      gateway_action_id: RESUME_ACTION,
      navigated: false,
    });
    expect(page.url()).toBe(urlBefore);
    await expect(switchLocator).toHaveAttribute("aria-checked", "true");
    expect(accountSettingsPatches).toEqual([]);
    relay.emit([
      {
        ...toolResult(RESUME_TOOL, {
          status: "already_on",
          desired_state: "on",
          gateway_action_id: RESUME_ACTION,
          observed_state: "on",
          changed: false,
          spoken_facts: ["Location is already on."],
        }),
        call_id: "c2",
      },
      { type: "state", state: "complete", turn_id: null },
    ]);
    await expect(resultCard).toContainText("Location is already on.", {
      timeout: 10_000,
    });

    // (c) Pause runs the switch's other handler on the mounted page.
    await say(page, "turn my location off");
    const third = await relay.waitFor(stepResultFor("st-3"), 45_000);
    expect(third.status).toBe("ok");
    const thirdPayload = third.payload as Record<string, unknown>;
    expect(thirdPayload).toMatchObject({
      outcome: "off",
      observed_state: "off",
      gateway_action_id: PAUSE_ACTION,
      desired_state: "off",
    });
    expect(JSON.stringify(thirdPayload)).not.toMatch(/latitude|longitude|\blat\b/i);
    await expect(switchLocator).toHaveAttribute("aria-checked", "false", {
      timeout: 15_000,
    });
    await expect(statusLocator).toHaveText("Location off", { timeout: 15_000 });
    relay.emit(settled("c3", "off", "Location is off."));
    await expect(resultCard).toContainText("Location is off.", {
      timeout: 10_000,
    });

    // Across the whole conversation nothing touched account-level sharing.
    expect(accountSettingsPatches).toEqual([]);
    expect(revokeRequests).toEqual([]);
    expect(
      relay.sent.filter((f) => f.type === "client_step.result").map((f) => f.step_id),
    ).toEqual(["st-1", "st-2", "st-3"]);
  });
});
