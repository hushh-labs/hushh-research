// hushh-webapp/lib/capacitor/account.ts
import { registerPlugin } from "@capacitor/core";

export interface HushhAccountPlugin {
  deleteAccount(options?: {
    authToken: string;
    target?: "investor" | "ria" | "both";
    backendUrl?: string;
  }): Promise<{
    success: boolean;
    message?: string;
    requested_target?: "investor" | "ria" | "both";
    deleted_target?: "investor" | "ria" | "both";
    account_deleted?: boolean;
    remaining_personas?: Array<"investor" | "ria">;
  }>;
}

export const HushhAccount = registerPlugin<HushhAccountPlugin>("HushhAccount");
