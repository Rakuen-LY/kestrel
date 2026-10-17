import type { ServerEventEnvelope, SessionEvent } from "@kestrel/protocol";

export type EventListener = (envelope: ServerEventEnvelope) => void;

/**
 * Fan-out plus a bounded replay buffer. Clients pass `Last-Event-ID` and resume
 * without gaps; the buffer is intentionally in-memory because session state is
 * the durable record.
 */
export class EventHub {
  private seq = 0;
  private readonly buffer: ServerEventEnvelope[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly globalListeners = new Set<EventListener>();

  constructor(private readonly capacity = 10_000) {}

  publish(event: SessionEvent): ServerEventEnvelope {
    this.seq += 1;
    const envelope: ServerEventEnvelope = { seq: this.seq, at: new Date().toISOString(), event };
    this.buffer.push(envelope);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);

    const sessionId = "sessionId" in event ? event.sessionId : undefined;
    if (sessionId) {
      for (const listener of this.listeners.get(sessionId) ?? []) listener(envelope);
    }
    for (const listener of this.globalListeners) listener(envelope);
    return envelope;
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  subscribeAll(listener: EventListener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  /** Envelopes newer than `lastEventId`, optionally scoped to a session. */
  replay(lastEventId: number, sessionId?: string): ServerEventEnvelope[] {
    return this.buffer.filter(
      (envelope) =>
        envelope.seq > lastEventId &&
        (!sessionId || ("sessionId" in envelope.event ? envelope.event.sessionId === sessionId : true)),
    );
  }

  get latestSeq(): number {
    return this.seq;
  }

  clear(): void {
    this.buffer.length = 0;
    this.listeners.clear();
    this.globalListeners.clear();
  }
}
