import { registerPlugin } from "@capacitor/core";

export interface HushhCardScannerPlugin {
  recognize(options: { image: string; requestId: string }): Promise<{ cardText: string }>;
  cancel(options: { requestId: string }): Promise<void>;
}

export const nativeCardScanner = registerPlugin<HushhCardScannerPlugin>("HushhCardScanner");

export interface HushhCardCapturePlugin {
  takePhoto(options: { requestId: string }): Promise<{ dataUrl?: string; cancelled?: boolean }>;
  cancel(options: { requestId: string }): Promise<void>;
}
export const nativeCardCapture = registerPlugin<HushhCardCapturePlugin>("HushhCardCapture");
