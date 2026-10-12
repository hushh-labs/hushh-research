import { registerPlugin } from "@capacitor/core";

export interface HushhCardScannerPlugin {
  recognize(options: { image: string; requestId: string }): Promise<{ text: string }>;
  cancel(options: { requestId: string }): Promise<void>;
}

export const nativeCardScanner = registerPlugin<HushhCardScannerPlugin>("HushhCardScanner");
