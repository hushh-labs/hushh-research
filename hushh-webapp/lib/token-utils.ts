export function truncateSignature(signature: string): string {
  return signature.length > 8 ? `${signature.slice(0, 8)}...` : signature;
}
