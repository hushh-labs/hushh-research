/** Carries only the HTTP status across encrypted PKM write layers. */
export class PkmStoreDomainError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PkmStoreDomainError";
  }
}
