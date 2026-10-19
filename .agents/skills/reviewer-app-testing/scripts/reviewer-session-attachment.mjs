import { randomUUID } from "node:crypto";

/** One selected-page lifecycle; all authentication and vault authority stays in the app. */
class ExistingReviewerSession {
  constructor(page, ports) {
    this.page = page;
    this.ports = ports;
    this.nonce = randomUUID();
    this.baseline = null;
    this.retired = false;
    this.retire = () => { this.retired = true; };
    this.frameChanged = frame => {
      if (frame === page.mainFrame()) void this.assertCurrent().catch(this.retire);
    };
  }
  read() {
    return this.page.evaluate(id => {
      const bridge = window.__HUSHH_NATIVE_TEST__;
      return bridge?.reviewerAttachmentId === id && bridge.reviewerAuthMode === "human_authenticated"
        ? bridge.reviewerSessionSnapshot?.() ?? null : null;
    }, this.nonce);
  }
  async assertCurrent() {
    const { page, ports, baseline } = this;
    if (this.retired || page.isClosed() || new URL(page.url()).origin !== ports.appOrigin) {
      this.retired = true;
      throw new Error("Existing reviewer session retired.");
    }
    const state = await this.read().catch(() => null);
    if (this.retired || page.isClosed() || new URL(page.url()).origin !== ports.appOrigin ||
        !state?.ownerMatches || !state.authReady || !state.unlocked ||
        !Number.isSafeInteger(state.authGeneration) || !Number.isSafeInteger(state.vaultEpoch) ||
        baseline && (state.authGeneration !== baseline.authGeneration || state.vaultEpoch !== baseline.vaultEpoch)) {
      this.retired = true;
      throw new Error("Existing reviewer session retired.");
    }
    return state;
  }
  async dispose() {
    this.retired = true;
    if (this.routeHandler) await this.page.unroute("**/*", this.routeHandler).catch(() => undefined);
    this.capture?.dispose();
    this.page.off("close", this.retire);
    this.page.off("domcontentloaded", this.retire);
    this.page.off("framenavigated", this.frameChanged);
    await this.lease?.evaluate(cleanup => cleanup()).catch(() => undefined);
    await this.lease?.dispose().catch(() => undefined);
  }
  async install() {
    const { page, ports } = this;
    this.readOnlyGuard = await ports.installReadOnlyMutationGuard({ route: async (pattern, handler) => {
      this.routeHandler = async route => {
        try {
          if (this.baseline) await this.assertCurrent();
          await handler({ request: () => route.request(), fulfill: response => route.fulfill(response),
            continue: async options => {
              if (this.baseline) await this.assertCurrent();
              return route.continue(options);
            } });
        } catch {
          this.retired = true;
          await route.fulfill({ status: 409, contentType: "application/json",
            body: '{"code":"REVIEWER_SESSION_RETIRED"}' }).catch(() => undefined);
          // Disposal can finish an in-flight route; the lease stays retired even
          // when its refusal cannot be delivered. Never retry or forward it.
        }
      };
      await page.route(pattern, this.routeHandler);
    } }, { appOrigin: ports.appOrigin, reviewerAuthMode: "human_authenticated",
      allowMemoryPreparation: ports.allowMemoryPreparation,
      admitOwnerPodMemoryPreparation: async request => {
        if (!this.baseline || !ports.admitOwnerPodMemoryPreparation) return false;
        await this.assertCurrent();
        const admitted = await ports.admitOwnerPodMemoryPreparation(request);
        await this.assertCurrent();
        return admitted === true;
      },
      admitOwnerPodConnectorOperation: async request => {
        if (!this.baseline || !ports.admitOwnerPodConnectorOperation) return false;
        await this.assertCurrent();
        const admitted = await ports.admitOwnerPodConnectorOperation(request);
        await this.assertCurrent();
        return admitted === true;
      },
      admitProviderOAuth: ports.admitProviderOAuth, admitMutation: async request => {
        if (!this.baseline) return false;
        await this.assertCurrent();
        return ports.admitMutation ? await ports.admitMutation(request) : false;
      } });
    this.capture = ports.attachMemoryOnlyCapture(page);
    this.lease = await page.evaluateHandle(({ expectedUserId, nonce, policy }) => {
      const prior = window.__HUSHH_NATIVE_TEST__;
      if (prior?.enabled || prior?.reviewerAttachmentId) throw new Error("Reviewer observation already owned.");
      const observer = { enabled: true, autoReviewerLogin: true, reviewerAuthMode: "human_authenticated",
        expectedUserId, reviewerMutationPolicy: policy, reviewerAttachmentId: nonce };
      window.__HUSHH_NATIVE_TEST__ = observer;
      window.dispatchEvent(new CustomEvent("hushh:native-test-config-updated"));
      return () => {
        if (window.__HUSHH_NATIVE_TEST__ !== observer) return;
        if (prior === undefined) delete window.__HUSHH_NATIVE_TEST__;
        else window.__HUSHH_NATIVE_TEST__ = prior;
        window.dispatchEvent(new CustomEvent("hushh:native-test-config-updated"));
      };
    }, { expectedUserId: ports.reviewerUid, nonce: this.nonce,
      policy: ports.admitMutation ? "bounded_mutation" : "read_only" });
    page.on("close", this.retire);
    page.on("domcontentloaded", this.retire);
    page.on("framenavigated", this.frameChanged);
  }
  async admit(evidence) {
    const { page, ports } = this;
    await page.waitForFunction(id => window.__HUSHH_NATIVE_TEST__?.reviewerAttachmentId === id &&
      typeof window.__HUSHH_NATIVE_TEST__.reviewerSessionSnapshot === "function", this.nonce, { timeout: ports.timeoutMs });
    if (evidence === "visible_unlock") {
      const state = await this.read();
      if (!state?.ownerMatches || !state.authReady || state.unlocked) throw new Error("Visible vault challenge required.");
      await page.locator("#unlock-passphrase").waitFor({ state: "visible", timeout: ports.timeoutMs });
      await page.waitForFunction(() => window.__HUSHH_NATIVE_TEST__?.bootstrapState === "vault_unlocked",
        null, { timeout: ports.timeoutMs });
    }
    this.baseline = await this.assertCurrent();
    await ports.assertVaultContinuity(page, "Existing reviewer admission");
    await this.assertCurrent();
  }
  async navigateInApp(href, options) {
    await this.assertCurrent();
    await this.ports.navigateInApp(this.page, href, options);
    await this.assertCurrent();
  }
}

/** Borrow one owner-selected page; never authenticate, unlock or own its browser. */
export function createExistingReviewerAttachment(ports) {
  return async (page, { evidence = "warm_only" } = {}) => {
    if (!ports.humanAuthenticated || !["warm_only", "visible_unlock"].includes(evidence) ||
        page.isClosed() || new URL(page.url()).origin !== ports.appOrigin ||
        new URL(ports.appOrigin).protocol !== "https:" || new URL(ports.appOrigin).origin !== ports.appOrigin ||
        page.mainFrame().parentFrame() !== null) {
      throw new Error("Existing reviewer attachment refused.");
    }
    const session = new ExistingReviewerSession(page, ports);
    try {
      await session.install();
      await session.admit(evidence);
      return { page, capture: session.capture, readOnlyGuard: session.readOnlyGuard, evidence,
        assertCurrent: () => session.assertCurrent(), dispose: () => session.dispose(),
        navigateInApp: (href, options) => session.navigateInApp(href, options) };
    } catch (error) { await session.dispose(); throw error; }
  };
}
