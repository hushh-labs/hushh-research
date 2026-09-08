import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionPersonAvatar,
  connectionAvatarInitials,
} from "@/components/connections/connection-person-avatar";

class ImageProbe extends EventTarget {
  static instances: ImageProbe[] = [];
  src = "";
  complete = false;
  naturalWidth = 0;
  referrerPolicy = "";
  constructor() {
    super();
    ImageProbe.instances.push(this);
  }
  settle(success: boolean) {
    this.complete = true;
    this.naturalWidth = success ? 64 : 0;
    this.dispatchEvent(new Event(success ? "load" : "error"));
  }
}

describe("canonical person avatar", () => {
  beforeEach(() => {
    ImageProbe.instances = [];
    vi.stubGlobal("Image", ImageProbe);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["Manish Kumar Gupta", "MG"],
    ["Aparna", "AP"],
    [" J ", "J"],
    ["", "?"],
  ])("keeps Connect's initials for %s", (name, initials) => {
    expect(connectionAvatarInitials(name)).toBe(initials);
  });

  it("preserves a complete uploaded image, and shows initials after an image error", async () => {
    const photo = "data:image/png;base64," + "YWJj".repeat(400);
    const { container } = render(
      <ConnectionPersonAvatar
        label="Manish Kumar Gupta"
        photoUrl={photo}
        size="list"
      />,
    );
    await waitFor(() => expect(ImageProbe.instances.length).toBeGreaterThan(0));
    const image = ImageProbe.instances.at(-1)!;
    expect(image.src).toBe(photo);
    expect(image.referrerPolicy).toBe("no-referrer");
    act(() => image.settle(true));
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute("src", photo),
    );
    expect(container.querySelector("img")).toHaveClass("object-cover");
    act(() => image.settle(false));
    await waitFor(() => expect(screen.getByText("MG")).toBeInTheDocument());
    expect(container.querySelector("img")).toBeNull();
  });

  it("recovers from a failed image when the profile changes and clears a removed photo", async () => {
    const { container, rerender } = render(
      <ConnectionPersonAvatar
        label="Aparna"
        photoUrl="https://example.test/old.png"
      />,
    );
    await waitFor(() => expect(ImageProbe.instances.length).toBeGreaterThan(0));
    act(() => ImageProbe.instances.at(-1)!.settle(false));
    rerender(
      <ConnectionPersonAvatar
        label="Aparna"
        photoUrl="https://example.test/new.png"
      />,
    );
    await waitFor(() =>
      expect(ImageProbe.instances.at(-1)?.src).toBe(
        "https://example.test/new.png",
      ),
    );
    act(() => ImageProbe.instances.at(-1)!.settle(true));
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "https://example.test/new.png",
      ),
    );
    rerender(<ConnectionPersonAvatar label="Aparna" photoUrl={null} />);
    expect(container.querySelector("img")).toBeNull();
    await waitFor(() => expect(screen.getByText("AP")).toBeInTheDocument());
  });
});
