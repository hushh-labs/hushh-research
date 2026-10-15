import React, { StrictMode } from "react";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WalletLiveCardCapture } from "@/components/wallet/wallet-live-card-capture";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("stops a late StrictMode stream and the current stream on cancel", async () => {
  const resolve: ((value: MediaStream) => void)[] = [];
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(done => resolve.push(done)));
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  const staleStop = vi.fn(), currentStop = vi.fn(), onCancel = vi.fn();
  render(<StrictMode><WalletLiveCardCapture onPhoto={vi.fn()} onCancel={onCancel} /></StrictMode>);
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  await act(async () => resolve[1]!({ getTracks: () => [{ stop: currentStop }] } as unknown as MediaStream));
  await act(async () => resolve[0]!({ getTracks: () => [{ stop: staleStop }] } as unknown as MediaStream));
  expect(staleStop).toHaveBeenCalledOnce(); expect(currentStop).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  expect(currentStop).toHaveBeenCalledOnce(); expect(onCancel).toHaveBeenCalledOnce();
  cleanup(); expect(currentStop).toHaveBeenCalledOnce();
});
