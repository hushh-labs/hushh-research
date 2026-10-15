/** Rejects callbacks after the owner or conversation generation changes. */
export class AgentChatSessionEpoch {
  value = 0;

  constructor(private readonly retire: () => void = () => {}) {}

  start(): void {
    this.value += 1;
    this.retire();
  }

  isCurrent(value: number): boolean {
    return this.value === value;
  }
}
