import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BackgroundShareToggle } from "@/app/one/location/background-share-toggle";

describe("BackgroundShareToggle", () => {
  it("requests Always auth and enables when granted", async () => {
    const onEnabledChange = vi.fn();
    const requestAlways = vi.fn().mockResolvedValue({ background: "available" });
    render(
      <BackgroundShareToggle
        enabled={false}
        onEnabledChange={onEnabledChange}
        requestAlwaysAuthorization={requestAlways}
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(requestAlways).toHaveBeenCalled());
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("stays off and shows guidance when Always is denied", async () => {
    const onEnabledChange = vi.fn();
    const requestAlways = vi.fn().mockResolvedValue({ background: "foreground-only" });
    render(
      <BackgroundShareToggle
        enabled={false}
        onEnabledChange={onEnabledChange}
        requestAlwaysAuthorization={requestAlways}
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(requestAlways).toHaveBeenCalled());
    expect(onEnabledChange).not.toHaveBeenCalledWith(true);
    expect(screen.getByText(/Always/i)).toBeInTheDocument();
  });

  it("turns off immediately without requesting auth", async () => {
    const onEnabledChange = vi.fn();
    const requestAlways = vi.fn().mockResolvedValue({ background: "available" });
    render(
      <BackgroundShareToggle
        enabled={true}
        onEnabledChange={onEnabledChange}
        requestAlwaysAuthorization={requestAlways}
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onEnabledChange).toHaveBeenCalledWith(false);
    expect(requestAlways).not.toHaveBeenCalled();
  });
});
