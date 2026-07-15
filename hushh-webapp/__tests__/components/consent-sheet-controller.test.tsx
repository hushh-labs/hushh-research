import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConsentSheetProvider } from "@/components/consent/consent-sheet-controller";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
  search: "panel=consents",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/profile",
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
  }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

describe("ConsentSheetProvider", () => {
  it("redirects the legacy profile consent panel to the consent manager", async () => {
    render(
      <ConsentSheetProvider>
        <div>Profile content</div>
      </ConsentSheetProvider>,
    );

    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith(
        "/consents?tab=pending&from=%2Fprofile%3Ftab%3Dprivacy",
        { scroll: false },
      );
    });
  });
});
