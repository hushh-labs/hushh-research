import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  native: false,
  join: vi.fn(),
  open: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));
vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: { joinMeeting: mocks.join },
}));
vi.mock("@/lib/capacitor/oauth-return", () => ({
  HushhOAuthReturn: { openExternalUrl: mocks.open },
}));
import { joinCalendarMeeting } from "@/lib/calendar/join-meeting";

describe("live Calendar join handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.native = false;
  });
  it("reserves the browser gesture before reading and closes after session loss", async () => {
    const popup = {
      opener: {},
      closed: false,
      close: vi.fn(),
      location: { replace: vi.fn() },
    };
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(popup as unknown as Window);
    let finish!: (value: string) => void;
    mocks.join.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let current = true;
    const pending = joinCalendarMeeting("vault", "event", () => current);
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.opener).toBeNull();
    current = false;
    finish("https://meet.google.com/abc-defg-hij");
    await pending;
    expect(popup.close).toHaveBeenCalledOnce();
    expect(popup.location.replace).not.toHaveBeenCalled();
    open.mockRestore();
  });
  it.each(["ios", "android"])(
    "opens the revalidated meeting using the %s native adapter",
    async () => {
      mocks.native = true;
      mocks.join.mockResolvedValue("https://meet.google.com/abc-defg-hij");
      await joinCalendarMeeting("vault", "event");
      expect(mocks.open).toHaveBeenCalledWith({
        url: "https://meet.google.com/abc-defg-hij",
      });
    },
  );
});
