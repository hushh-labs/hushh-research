import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Auth, private handles, SDP and media must never enter browser artifacts.
test.use({ trace: "off", screenshot: "off", video: "off", permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required", "--allow-loopback-in-peer-connection"] } });
test.setTimeout(90_000);

type ObservedWindow = Window & {
  callingRehearsalSignIn: (owner: "alice" | "bob", password: string) => Promise<void>;
  callingPeers: RTCPeerConnection[];
  callingTracks: MediaStreamTrack[];
};

async function participant(context: BrowserContext, owner: "alice" | "bob"): Promise<Page> {
  const origin = process.env.CALLING_REHEARSAL_ORIGIN;
  const password = process.env.CALLING_REHEARSAL_PASSWORD;
  if (!origin?.startsWith("http://127.0.0.1:") || !password) throw new Error("Run through test:calling:realtime.");
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" || url.protocol === "data:" ? route.continue() : route.abort();
  });
  await context.addInitScript(() => {
    const view = window as ObservedWindow;
    view.callingPeers = [];
    view.callingTracks = [];
    const Peer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(configuration?: RTCConfiguration) { super(configuration); view.callingPeers.push(this);
      }
    };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await capture(constraints);
      view.callingTracks.push(...stream.getTracks());
      return stream;
    };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", () => console.error(`rehearsal ${owner}: browser error`));
  page.on("requestfailed", request => console.error(`rehearsal module/request failed: ${new URL(request.url()).pathname}`));
  page.on("response", response => { if (response.status() >= 400) console.log(`rehearsal ${owner} HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });
  console.log(`rehearsal ${owner}: loading real calling surface`);
  await page.goto(origin);
  await page.waitForFunction(() => typeof (window as ObservedWindow).callingRehearsalSignIn === "function");
  await page.evaluate(({ owner, password }) => (window as ObservedWindow).callingRehearsalSignIn(owner, password), { owner, password });
  console.log(`rehearsal ${owner}: signed in; waiting for enrolled call control`);
  await expect(page.getByRole("button", { name: "Start voice call", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
  return page;
}

async function mediaEvidence(page: Page) {
  return page.evaluate(async () => {
    const peer = (window as ObservedWindow).callingPeers.at(-1);
    if (!peer || peer.connectionState !== "connected") return false;
    const report = await peer.getStats();
    const stats = [...report.values()];
    const inbound = stats.find(row => row.type === "inbound-rtp" && row.kind === "audio");
    const outbound = stats.find(row => row.type === "outbound-rtp" && row.kind === "audio");
    const transport = stats.find(row => row.type === "transport" && row.selectedCandidatePairId);
    const pair = transport ? report.get(transport.selectedCandidatePairId) : undefined;
    return Boolean(inbound?.packetsReceived > 0 && outbound?.packetsSent > 0 && pair?.state === "succeeded"
      && report.get(pair.localCandidateId)?.candidateType === "relay"
      && report.get(pair.remoteCandidateId)?.candidateType === "relay");
  });
}

test("two authenticated owners exchange relay-only audio and stop capture on hangup", async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ permissions: ["microphone"] }), browser.newContext({ permissions: ["microphone"] })]);
  try {
    const [alice, bob] = await Promise.all([participant(contexts[0]!, "alice"), participant(contexts[1]!, "bob")]);
    await alice.getByRole("button", { name: "Start voice call", exact: true }).click();
    console.log("rehearsal: caller pressed start");
    try { await expect(bob.getByText("Incoming voice call", { exact: true })).toBeVisible({ timeout: 20_000 }); }
    catch (error) { console.error(await alice.getByRole("status").allTextContents()); throw error; }
    await bob.getByRole("button", { name: "Answer", exact: true }).click();
    await Promise.all([expect(alice.getByRole("heading", { name: "Verify this conversation" })).toBeVisible(),
      expect(bob.getByRole("heading", { name: "Verify this conversation" })).toBeVisible()]);
    const aliceCode = await alice.locator('[role="dialog"] code').innerText();
    // Preserve the comparison without printing either code on assertion failure.
    expect(await bob.locator('[role="dialog"] code').innerText() === aliceCode).toBe(true);
    await Promise.all([alice.getByRole("button", { name: "We compared the code" }).click(),
      bob.getByRole("button", { name: "We compared the code" }).click()]);
    await expect.poll(() => mediaEvidence(alice), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => mediaEvidence(bob), { timeout: 20_000 }).toBe(true);
    await alice.getByRole("button", { name: "Mute", exact: true }).click();
    expect(await alice.evaluate(() => (window as ObservedWindow).callingTracks.every(track => !track.enabled))).toBe(true);
    await alice.getByRole("button", { name: "Unmute", exact: true }).click();
    await alice.getByRole("button", { name: "End call", exact: true }).click();
    for (const page of [alice, bob]) {
      await expect.poll(() => page.evaluate(() => {
        const view = window as ObservedWindow;
        return view.callingPeers.length > 0 && view.callingPeers.every(peer => peer.connectionState === "closed")
          && view.callingTracks.length > 0 && view.callingTracks.every(track => track.readyState === "ended");
      })).toBe(true);
    }
  } finally { await Promise.allSettled(contexts.map(context => context.close())); }
});

test("recipient declines a ringing call without opening their microphone", async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ permissions: ["microphone"] }), browser.newContext({ permissions: ["microphone"] })]);
  try {
    const [alice, bob] = await Promise.all([participant(contexts[0]!, "alice"), participant(contexts[1]!, "bob")]);
    await alice.getByRole("button", { name: "Start voice call", exact: true }).click();
    await expect(bob.getByText("Incoming voice call", { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(await bob.evaluate(() => (window as ObservedWindow).callingTracks.length)).toBe(0);
    await bob.getByRole("button", { name: "Decline", exact: true }).click();
    for (const page of [alice, bob]) {
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Start voice call", exact: true })).toBeEnabled();
    }
    await expect.poll(() => alice.evaluate(() => (window as ObservedWindow).callingTracks.every(track => track.readyState === "ended"))).toBe(true);
    expect(await bob.evaluate(() => (window as ObservedWindow).callingTracks.length)).toBe(0);
  } finally { await Promise.allSettled(contexts.map(context => context.close())); }
});
