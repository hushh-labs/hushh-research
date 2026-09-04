/**
 * Orders native auth restores without persisting identity or token material.
 *
 * Capacitor can trigger a launch restore and an app-active restore around the
 * native Apple sheet. Only the newest operation is allowed to publish state.
 */
export class NativeAuthRestoreEpoch {
  private currentEpoch = 0;

  begin(): number {
    this.currentEpoch += 1;
    return this.currentEpoch;
  }

  invalidate(): void {
    this.currentEpoch += 1;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.currentEpoch;
  }
}
