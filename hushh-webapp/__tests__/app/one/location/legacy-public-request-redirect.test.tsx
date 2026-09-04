import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  token: "public-token" as string | undefined,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: mocks.token }),
  useRouter: () => ({ replace: mocks.replace }),
}));

import LegacyPublicLocationRequestRedirect from "@/app/one/location/request/[token]/page-client";

/**
 * Public location links moved from `/one/location/request/<token>` to
 * `/one/location/view/<token>`. Links minted under the old path are already
 * inside messages that were sent, so it cannot 404 — and on the Capacitor
 * static export there is no proxy in front of it to redirect.
 */
describe("legacy /one/location/request/[token]", () => {
  beforeEach(() => {
    mocks.replace.mockClear();
    mocks.token = "public-token";
  });

  it("forwards to the view path, carrying the token", async () => {
    render(<LegacyPublicLocationRequestRedirect />);

    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith(
        "/one/location/view/public-token",
      ),
    );
    // `replace`, not `push`: Back must not bounce between the two paths.
    expect(screen.getByText(/Opening shared location/i)).toBeTruthy();
  });

  it("sends a link with no token to the Location hub", async () => {
    mocks.token = "";
    render(<LegacyPublicLocationRequestRedirect />);

    // `/one/location/view/` with nothing after it can only ever render "this
    // link is invalid", which is a worse answer than a screen with something
    // on it to act on.
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/one/location"),
    );
  });
});
