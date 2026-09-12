/** Retired transport compatibility. No sockets, microphone, or generated audio. */
export class GeminiLiveClient {
  constructor(..._args: unknown[]) { throw new Error("ONE_LIVE_RETIRED: use Talk to One commands."); }
}
export { GeminiLiveClient as GeminiLiveTransport };
