import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  bootstrapStateMock,
  updatePreVaultStateMock,
  loadPendingOnboardingMock,
  peekIdentityMock,
  refreshIdentityMock,
} = vi.hoisted(() => ({
  bootstrapStateMock: vi.fn(),
  updatePreVaultStateMock: vi.fn(),
  loadPendingOnboardingMock: vi.fn(),
  peekIdentityMock: vi.fn(),
  refreshIdentityMock: vi.fn(),
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    peekCachedIdentity: peekIdentityMock,
    refreshIdentityForSession: refreshIdentityMock,
    hasVerifiedPhone: (identity: { phone_verified?: boolean } | null) => identity?.phone_verified === true,
  },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: vi.fn().mockResolvedValue("test-token") },
}));

vi.mock("@/lib/services/pre-vault-user-state-service", () => ({
  PreVaultUserStateService: {
    bootstrapState: bootstrapStateMock,
    updatePreVaultState: updatePreVaultStateMock,
    isSetupResolved: (state: {
      setupCompleted?: boolean | null;
      setupCompletedAt?: number | null;
    }) => state?.setupCompleted === true,
  },
}));

vi.mock("@/lib/services/pre-vault-onboarding-service", () => ({
  PreVaultOnboardingService: {
    load: loadPendingOnboardingMock,
  },
}));

import {
  buildOneSetupRoute,
  buildPhoneMandateRoute,
  buildProfileVaultRoute,
  normalizeInternalRouteHref,
  ROUTES,
} from "@/lib/navigation/routes";
import { OneSetupGateService } from "@/lib/services/one-setup-gate-service";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";

describe("PostAuthRouteService", () => {
  beforeEach(() => {
    peekIdentityMock.mockReset();
    refreshIdentityMock.mockReset();
  });

  it("initializes a missing fresh-account phone claim before requiring verification", async () => {
    bootstrapStateMock.mockResolvedValue({ hasVault: false, setupCompleted: false, phoneVerified: null });
    loadPendingOnboardingMock.mockResolvedValue(null);
    refreshIdentityMock.mockResolvedValue({ phone_verified: false });
    await expect(PostAuthRouteService.resolveAfterLogin({ userId: "new-user", idToken: "google-token", hostname: "one.hushh.ai" }))
      .resolves.toBe(buildPhoneMandateRoute(ROUTES.ONE_SETUP_CONNECTIONS));
    expect(refreshIdentityMock).toHaveBeenCalledWith("new-user", "google-token");
  });

  it("honors a newer verified identity over a negative bootstrap hint", async () => {
    bootstrapStateMock.mockResolvedValue({ hasVault: false, setupCompleted: false, phoneVerified: false });
    loadPendingOnboardingMock.mockResolvedValue(null);
    peekIdentityMock.mockReturnValue({ data: { phone_verified: true } });
    await expect(PostAuthRouteService.resolveAfterLogin({ userId: "user", hostname: "one.hushh.ai" }))
      .resolves.toBe(ROUTES.ONE_SETUP_CONNECTIONS);
    expect(refreshIdentityMock).not.toHaveBeenCalled();
  });
  it.each([
    "/circle/join?code=23456789ABCD",
    "/circle/join?invite=real_token",
    "/one/location/invite/real_token",
  ])(
    "retains the invitation when reauthenticating during phone verification: %s",
    async (destination) => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: false,
        setupCompleted: false,
        phoneVerified: false,
      });
      const redirectPath = buildPhoneMandateRoute(destination);
      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "recipient",
          redirectPath,
          hostname: "uat.one.hushh.ai",
        }),
      ).resolves.toBe(redirectPath);
      bootstrapStateMock.mockResolvedValue({
        hasVault: false,
        setupCompleted: false,
        phoneVerified: true,
      });
      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "recipient",
          redirectPath,
        }),
      ).resolves.toBe(buildOneSetupRoute({ returnTo: destination }));
      bootstrapStateMock.mockResolvedValue({
        hasVault: true,
        setupCompleted: true,
        phoneVerified: true,
      });
      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "recipient",
          redirectPath,
        }),
      ).resolves.toBe(destination);
    },
  );

  it.each([
    "https://evil.example/circle/join?code=23456789ABCD",
    "//evil.example/circle/join",
    "/register-phone?redirect=%2Fregister-phone",
  ])(
    "does not promote an unsafe or recursive phone return target: %s",
    async (target) => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: true,
        setupCompleted: true,
        phoneVerified: true,
      });
      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "recipient",
          redirectPath: buildPhoneMandateRoute(target),
        }),
      ).resolves.toBe(ROUTES.HOME);
    },
  );
  it.each([
    "/one/setup",
    "/one/setup/",
    "/one/setup/connections",
    "/one/setup/connections/",
    "/one/setup/connections/index.html",
  ])(
    "preserves an unfinished setup invitation when a vault already exists: %s",
    async (setupRoute) => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: true,
        setupCompleted: false,
        phoneVerified: true,
      });
      const redirectPath =
        setupRoute +
        "?return_to=" +
        encodeURIComponent("/circle/join?code=23456789ABCD");
      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "recipient",
          redirectPath,
        }),
      ).resolves.toBe(redirectPath);
    },
  );
  it.each([
    "/one/setup",
    "/one/setup/",
    "/one/setup/connections",
    "/one/setup/connections/",
    "/one/setup/connections/index.html",
  ])(
    "keeps invite context when reauthenticating inside %s",
    async (setupRoute) => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: false,
        setupCompleted: false,
        phoneVerified: true,
      });
      const destination = "/circle/join?code=23456789ABCD";
      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "new-recipient",
          redirectPath:
            setupRoute + "?return_to=" + encodeURIComponent(destination),
        }),
      ).resolves.toBe(buildOneSetupRoute({ returnTo: destination }));
    },
  );
  it.each([
    "/circle/join?code=23456789ABCD",
    "/circle/join/?invite=real_token",
    "/one/location/invite/real_token",
    "/one/connect?tab=circles&action=join-circle&code=23456789ABCD",
    "/one/connect/?tab=circles&action=join-circle&code=23456789ABCD",
  ])(
    "preserves invitation intent through new-account setup: %s",
    async (destination) => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: false,
        setupCompleted: false,
        phoneVerified: true,
      });
      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "new-recipient",
          redirectPath: destination,
        }),
      ).resolves.toBe(buildOneSetupRoute({ returnTo: destination }));
    },
  );

  it.each(["/one/profile/security/", "/one/profile/security/index.html"])(
    "retains a native token invitation during vault reauthentication: %s",
    async (profileRoute) => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: false,
        setupCompleted: true,
        phoneVerified: true,
      });
      const destination = "/circle/join?invite=real_token";
      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "recipient",
          redirectPath:
            profileRoute +
            "?unlock_vault=1&return_to=" +
            encodeURIComponent(destination),
        }),
      ).resolves.toBe(buildProfileVaultRoute(destination));
    },
  );

  it("keeps a Circle invitation through required phone verification", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: false,
      phoneVerified: false,
    });
    const destination = "/circle/join?code=23456789ABCD";
    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "new-recipient",
        redirectPath: destination,
        hostname: "uat.one.hushh.ai",
      }),
    ).resolves.toBe(buildPhoneMandateRoute(destination));
  });

  it("retains a Circle intent when setup is complete but the vault is absent", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: true,
      phoneVerified: true,
    });
    const destination = "/circle/join?code=23456789ABCD";
    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "recipient",
        redirectPath: destination,
      }),
    ).resolves.toBe(buildProfileVaultRoute(destination));
  });
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    bootstrapStateMock.mockReset();
    updatePreVaultStateMock.mockReset();
    loadPendingOnboardingMock.mockReset();
  });

  it("returns to the Hushh Tech launch after Firebase sign-in without setup", async () => {
    const launchPath =
      "/products/hushh-tech/launch?audience=hushh-tech-uat&state=state-value";

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "research-user",
        redirectPath: launchPath,
        idToken: "firebase-id-token",
      }),
    ).resolves.toBe(launchPath);
    expect(bootstrapStateMock).not.toHaveBeenCalled();
  });

  it.each([
    "/\\evil.example/products/hushh-tech/launch",
    "/%5Cevil.example/products/hushh-tech/launch",
    "//evil.example/products/hushh-tech/launch",
    "/products/hushh-tech/launch\n?audience=hushh-tech-uat",
  ])("rejects an unsafe post-login redirect: %s", (redirect) => {
    expect(normalizeInternalRouteHref(redirect)).toBeNull();
  });

  it("keeps the canonical launch path and query unchanged", () => {
    const redirect =
      "/products/hushh-tech/launch?audience=hushh-tech-uat&state=state-value";
    expect(normalizeInternalRouteHref(redirect)).toBe(redirect);
  });

  it("routes vault users with unresolved onboarding straight to the AI-choice step", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      setupCompleted: false,
      setupCompletedAt: null,
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({ userId: "user_123" }),
    ).resolves.toBe(ROUTES.ONE_SETUP_CONNECTIONS);
  });

  it("keeps the provider token attached to the authoritative setup bootstrap", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: false,
      setupCompletedAt: null,
      phoneVerified: true,
    });

    await PostAuthRouteService.resolveAfterLogin({
      userId: "native_apple_user",
      idToken: "native-apple-id-token",
    });

    expect(bootstrapStateMock).toHaveBeenCalledWith("native_apple_user", {
      idToken: "native-apple-id-token",
    });
  });

  it("routes an existing organic-login user to Chat, never a stored persona", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      setupCompleted: true,
      setupCompletedAt: 1,
      phoneVerified: true,
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "existing_ria_user",
        redirectPath: ROUTES.HOME,
        idToken: "valid-id-token",
      }),
    ).resolves.toBe(ROUTES.HOME);
  });

  it("preserves an explicit RIA deep link without making RIA the login authority", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      setupCompleted: true,
      setupCompletedAt: 1,
      phoneVerified: true,
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "existing_user",
        redirectPath: ROUTES.RIA_HOME,
        idToken: "valid-id-token",
      }),
    ).resolves.toBe(ROUTES.RIA_HOME);
  });

  it("preserves a notification deep link while unresolved onboarding is completed", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      setupCompleted: false,
      setupCompletedAt: null,
    });
    const notificationRoute =
      "/one/location?section=shared&grantId=grant-notification-1";

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: notificationRoute,
      }),
    ).resolves.toBe(buildOneSetupRoute({ returnTo: notificationRoute }));
  });

  it("does not nest an existing setup return target after login", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      setupCompleted: false,
      setupCompletedAt: null,
    });
    const setupRoute = buildOneSetupRoute({
      returnTo: "/one/location?section=shared&grantId=grant-notification-1",
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: setupRoute,
      }),
    ).resolves.toBe(setupRoute);
  });

  it("returns a resolved setup user to the saved notification target", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      setupCompleted: true,
      setupCompletedAt: 1,
    });
    const notificationRoute =
      "/one/location?section=shared&grantId=grant-notification-1";

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: buildOneSetupRoute({ returnTo: notificationRoute }),
      }),
    ).resolves.toBe(notificationRoute);
  });

  it("keeps vault users on the requested route when onboarding is resolved", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      setupCompleted: true,
      setupCompletedAt: 1,
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: ROUTES.KAI_PORTFOLIO,
      }),
    ).resolves.toBe(ROUTES.KAI_PORTFOLIO);
  });

  it("does not send completed vault users back into onboarding from a stale redirect", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      setupCompleted: true,
      setupCompletedAt: 1,
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: ROUTES.ONE_SETUP_KAI,
      }),
    ).resolves.toBe(ROUTES.HOME);
  });

  it("bridges completed pre-vault onboarding before sending no-vault users home", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: null,
      setupCompletedAt: null,
      setupSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue({
      completed: true,
      skipped: false,
      completed_at: "2026-03-17T12:00:00.000Z",
      answers: {
        investment_horizon: "long_term",
        drawdown_response: "stay",
        volatility_preference: "moderate",
      },
    });
    updatePreVaultStateMock.mockResolvedValue({});

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      }),
    ).resolves.toBe(ROUTES.HOME);
    expect(updatePreVaultStateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps interrupted pre-vault onboarding on the AI-choice step after restart", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: null,
      setupCompletedAt: null,
      setupSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue({
      completed: false,
      skipped: false,
      completed_at: null,
      answers: {
        investment_horizon: "long_term",
        drawdown_response: null,
        volatility_preference: null,
      },
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      }),
    ).resolves.toBe(ROUTES.ONE_SETUP_CONNECTIONS);
    expect(updatePreVaultStateMock).not.toHaveBeenCalled();
  });

  it("does not bridge malformed completed local onboarding without skip or full answers", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: null,
      setupCompletedAt: null,
      setupSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue({
      completed: true,
      skipped: false,
      completed_at: "2026-03-17T12:00:00.000Z",
      answers: {
        investment_horizon: "long_term",
        drawdown_response: null,
        volatility_preference: "moderate",
      },
    });

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      }),
    ).resolves.toBe(ROUTES.ONE_SETUP_CONNECTIONS);
    expect(updatePreVaultStateMock).not.toHaveBeenCalled();
  });

  it("bridges explicit skipped pre-vault onboarding before sending no-vault users home", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: null,
      setupCompletedAt: null,
      setupSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue({
      completed: true,
      skipped: true,
      completed_at: "2026-03-17T12:00:00.000Z",
      answers: {
        investment_horizon: null,
        drawdown_response: null,
        volatility_preference: null,
      },
    });
    updatePreVaultStateMock.mockResolvedValue({});

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      }),
    ).resolves.toBe(ROUTES.HOME);
    expect(updatePreVaultStateMock).toHaveBeenCalledTimes(1);
  });

  it("routes no-vault users without a verified phone to the phone mandate before onboarding", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      phoneVerified: false,
      setupCompleted: false,
      setupCompletedAt: null,
      setupSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: null,
      }),
    ).resolves.toBe(buildPhoneMandateRoute(ROUTES.ONE_SETUP_CONNECTIONS));
  });

  it("keeps completed no-vault accounts home without repeating phone onboarding", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: true,
      setupCompletedAt: 1,
      setupSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "",
      }),
    ).resolves.toBe(ROUTES.HOME);
  });

  it("does not route no-vault users with a verified phone through the phone mandate", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: true,
      setupCompletedAt: 1,
      setupSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: "+16505550101",
      }),
    ).resolves.toBe(ROUTES.HOME);
  });

  it("does not route backend phone-verified users back to the phone mandate", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: true,
      setupCompletedAt: 1,
      setupSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: null,
        phoneVerified: true,
      }),
    ).resolves.toBe(ROUTES.HOME);
  });

  it("uses the backend verified-phone claim when a native session omits its local number", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: true,
      setupCompletedAt: 1,
      setupSkipped: false,
      phoneVerified: true,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "native-user",
        phoneNumber: null,
        phoneVerified: null,
      }),
    ).resolves.toBe(ROUTES.HOME);
  });

  it("routes phone-verified no-vault Invite to One users through the shared vault flow", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: true,
      setupCompletedAt: 1,
      setupSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    const inviteRedirect = "/one/location/invite/invite_token_123";

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: inviteRedirect,
        phoneVerified: true,
      }),
    ).resolves.toBe(buildProfileVaultRoute(inviteRedirect));
  });

  it("keeps the Invite to One token for an established no-vault account", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: true,
      setupCompletedAt: 1,
      setupSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    const inviteRedirect = "/one/location/invite/invite_token_123";

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: inviteRedirect,
        phoneNumber: null,
        phoneVerified: false,
        hostname: "uat.one.hushh.ai",
      }),
    ).resolves.toBe(buildProfileVaultRoute(inviteRedirect));
  });

  it("preserves Invite to One return targets that are already inside the profile vault handoff", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: true,
      setupCompletedAt: 1,
      setupSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    const inviteRedirect = "/one/location/invite/invite_token_123";
    const profileVaultRoute = buildProfileVaultRoute(inviteRedirect);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: profileVaultRoute,
        phoneVerified: true,
      }),
    ).resolves.toBe(profileVaultRoute);
  });

  it("keeps established vault accounts on the invitation without phone onboarding", async () => {
    bootstrapStateMock.mockResolvedValue({
      hasVault: true,
      setupCompleted: true,
      setupCompletedAt: 1,
    });

    const inviteRedirect = "/one/location/invite/invite_token_123";

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        redirectPath: inviteRedirect,
        phoneNumber: null,
        phoneVerified: false,
        hostname: "uat.one.hushh.ai",
      }),
    ).resolves.toBe(inviteRedirect);
  });

  it("skips the phone mandate for localhost development sessions", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: true,
      setupCompletedAt: 1,
      setupSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: null,
        hostname: "localhost",
      }),
    ).resolves.toBe(ROUTES.HOME);
  });
  it("skips the phone mandate for localhost hostname variants in development", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      setupCompleted: true,
      setupCompletedAt: 1,
      setupSkipped: false,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: null,
        hostname: "127.0.0.1",
      }),
    ).resolves.toBe(ROUTES.HOME);
  });

  it("does not exempt the dev deployment from the phone mandate", async () => {
    // A fresh dev account must verify its phone before provisioning. A
    // completed account is exempt regardless of host, as tested above.
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "development");
    bootstrapStateMock.mockResolvedValue({
      hasVault: false,
      phoneVerified: false,
      setupCompleted: false,
      setupCompletedAt: null,
      setupSkipped: null,
    });
    loadPendingOnboardingMock.mockResolvedValue(null);

    await expect(
      PostAuthRouteService.resolveAfterLogin({
        userId: "user_123",
        phoneNumber: null,
        hostname: "dev.one.hushh.ai",
      })
    ).resolves.toBe(buildPhoneMandateRoute(ROUTES.ONE_SETUP_CONNECTIONS));
  });

  describe("first-run One Setup gate", () => {
    beforeEach(() => {
      OneSetupGateService.reset("user_gate");
    });

    // These two used to assert ROUTES.ONE_SETUP for an unseen first-run vault
    // user. That was correct while the default home route was ROUTES.ONE_HOME
    // (the dashboard) -- a setup surface a resolved user could safely visit
    // and leave. Once the canonical home route became ROUTES.HOME (chat),
    // the same redirect walked straight into OnboardingJourneyGuard's
    // unconditional "eject a resolved account from any setup surface" rule,
    // so the person never reached the nudge OR chat -- they landed back on
    // the dashboard instead. See `applyFirstRunSetupGate`'s comment.
    it("does not nudge a first-run vault user into setup when the destination is chat", async () => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: true,
        setupCompleted: true,
        setupCompletedAt: 1,
      });

      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "user_gate",
          phoneVerified: true,
          enableFirstRunSetupGate: true,
        }),
      ).resolves.toBe(ROUTES.HOME);
    });

    it("does not nudge a first-run no-vault user into setup when the destination is chat", async () => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: false,
        setupCompleted: true,
        setupCompletedAt: 1,
        setupSkipped: false,
      });
      loadPendingOnboardingMock.mockResolvedValue(null);

      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "user_gate",
          phoneVerified: true,
          enableFirstRunSetupGate: true,
        }),
      ).resolves.toBe(ROUTES.HOME);
    });

    it("does not gate when the setup nudge has already been seen", async () => {
      OneSetupGateService.markSeen("user_gate");
      bootstrapStateMock.mockResolvedValue({
        hasVault: true,
        setupCompleted: true,
        setupCompletedAt: 1,
      });

      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "user_gate",
          phoneVerified: true,
          enableFirstRunSetupGate: true,
        }),
      ).resolves.toBe(ROUTES.HOME);
    });

    it("does not gate when the caller has not opted in", async () => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: true,
        setupCompleted: true,
        setupCompletedAt: 1,
      });

      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "user_gate",
          phoneVerified: true,
        }),
      ).resolves.toBe(ROUTES.HOME);
    });

    it("does not gate when an explicit redirect target is present", async () => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: true,
        setupCompleted: true,
        setupCompletedAt: 1,
      });

      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "user_gate",
          redirectPath: ROUTES.KAI_PORTFOLIO,
          phoneVerified: true,
          enableFirstRunSetupGate: true,
        }),
      ).resolves.toBe(ROUTES.KAI_PORTFOLIO);
    });

    it("routes a user with unresolved onboarding straight to the AI-choice step", async () => {
      bootstrapStateMock.mockResolvedValue({
        hasVault: true,
        setupCompleted: false,
        setupCompletedAt: null,
      });

      await expect(
        PostAuthRouteService.resolveAfterLogin({
          userId: "user_gate",
          phoneVerified: true,
          enableFirstRunSetupGate: true,
        }),
      ).resolves.toBe(ROUTES.ONE_SETUP_CONNECTIONS);
    });
  });
  it.each([null, undefined])("does not interpret unknown phone status (%s) as a fresh-account challenge", async (phoneVerified) => {
    bootstrapStateMock.mockResolvedValue({ hasVault: false, setupCompleted: false, phoneVerified });
    loadPendingOnboardingMock.mockResolvedValue(null);
    await expect(PostAuthRouteService.resolveAfterLogin({ userId: "user", hostname: "one.hushh.ai" }))
      .rejects.toThrow("Unable to verify account onboarding");
  });

  it("does not interpret unknown vault ownership as a fresh account", async () => {
    bootstrapStateMock.mockResolvedValue({ hasVault: null, setupCompleted: false, phoneVerified: false });
    loadPendingOnboardingMock.mockResolvedValue(null);
    await expect(PostAuthRouteService.resolveAfterLogin({ userId: "user", hostname: "one.hushh.ai" }))
      .rejects.toThrow("Unable to verify account onboarding");
  });

});
