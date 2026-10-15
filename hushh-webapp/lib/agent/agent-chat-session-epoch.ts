/** Rejects Calendar confirmation work after the owner or conversation changes. */
export class AgentChatSessionEpoch {
  value = 0;

  start(): void {
    this.value += 1;
  }

  isCurrent(value: number): boolean {
    return this.value === value;
  }
}
