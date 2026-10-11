import type { Metadata } from "next";
import { WalletEncryptedCardViewer } from "@/components/wallet/wallet-encrypted-card-viewer";

export const metadata: Metadata = {
  title: "Open encrypted card",
  robots: { index: false, follow: false },
};

export default function OpenEncryptedCardPage() {
  return <WalletEncryptedCardViewer />;
}
