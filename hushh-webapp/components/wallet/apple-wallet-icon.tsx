import Image from "next/image";

/** The supplied Apple Wallet artwork; the surrounding action provides its label. */
export function AppleWalletIcon() {
  return <Image src="/wallet/apple-wallet-icon.png" alt="" aria-hidden width={20} height={20} unoptimized className="mr-2 h-5 w-5 shrink-0" />;
}
