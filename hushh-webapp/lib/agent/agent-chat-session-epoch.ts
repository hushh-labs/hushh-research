/** Retires callbacks from a closed chat, including after a new chat opens. */
export class AgentChatSessionEpoch {
  value = 0;
  closed = false;

  end(): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.value += 1;
    return true;
  }

  start(): void {
    this.closed = false;
    this.value += 1;
  }

  isCurrent(value: number): boolean {
    return !this.closed && this.value === value;
  }
}
