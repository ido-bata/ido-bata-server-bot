/**
 * Bounded ring buffer used by the structured logger to retain the most
 * recent emitted events for tools like the TUI log panel.
 *
 * The buffer is intentionally a tiny FIFO: the logger does NOT need
 * efficient random access, only push and trim-from-front. We shift on
 * overflow so the oldest entry is always dropped first, matching how a
 * `tail -F` style consumer reads it.
 */

/** A normalized log record that the ring buffer can hold. */
export type RingLogEvent = {
  level: number;
  time: number;
  pid?: number;
  hostname?: string;
  service?: string;
  /** Pino emits the user-facing message under `message` because we set `messageKey: "message"`. */
  message?: string;
  /** Optional component binding carried by child loggers. */
  component?: string;
  /** Free-form structured fields the caller attached to the record. */
  [key: string]: unknown;
};

/** Hard floor / ceiling for the ring size regardless of env or setRingSize input. */
export const RING_MIN = 10;
export const RING_MAX = 10_000;

export class LogRingBuffer {
  private readonly entries: RingLogEvent[] = [];
  private capacity: number;

  constructor(initialCapacity: number) {
    this.capacity = clamp(initialCapacity);
  }

  /** Returns the current capacity (bounded by {@link RING_MIN} / {@link RING_MAX}). */
  get maxSize(): number {
    return this.capacity;
  }

  /** Replace the capacity at runtime. Existing entries are trimmed if the new cap is smaller. */
  setCapacity(next: number): void {
    this.capacity = clamp(next);
    while (this.entries.length > this.capacity) {
      this.entries.shift();
    }
  }

  /** Push a record, dropping the oldest entry when the buffer overflows. */
  push(record: RingLogEvent): void {
    this.entries.push(record);
    while (this.entries.length > this.capacity) {
      this.entries.shift();
    }
  }

  /** Number of records currently stored. */
  get size(): number {
    return this.entries.length;
  }

  /** A read-only snapshot of the buffer (oldest first). */
  snapshot(): readonly RingLogEvent[] {
    return this.entries.slice();
  }

  /** Drop every entry. */
  clear(): void {
    this.entries.length = 0;
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return RING_MIN;
  }
  const rounded = Math.floor(value);
  if (rounded < RING_MIN) {
    return RING_MIN;
  }
  if (rounded > RING_MAX) {
    return RING_MAX;
  }
  return rounded;
}
