/**
 * Debounce + coalescing + stale-result detection for Live Mode.
 *
 * - Each `schedule()` bumps the generation and restarts the debounce timer.
 * - At most one run is in flight per key; edits during a run are coalesced
 *   into a single follow-up run (backpressure).
 * - `isCurrent(gen)` lets callers drop results of superseded runs.
 *
 * Pure (no vscode import) for unit testing.
 */

export type LiveRunner = (generation: number) => Promise<void>;

interface Slot {
  generation: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: boolean;
  dirty: boolean;
  runner: LiveRunner;
}

export class LiveScheduler {
  private slots = new Map<string, Slot>();

  constructor(private debounceMs: () => number) {}

  schedule(key: string, runner: LiveRunner): number {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { generation: 0, timer: undefined, running: false, dirty: false, runner };
      this.slots.set(key, slot);
    }
    slot.runner = runner;
    slot.generation++;
    if (slot.timer) clearTimeout(slot.timer);
    const s = slot;
    s.timer = setTimeout(() => {
      s.timer = undefined;
      this.fire(key, s);
    }, this.debounceMs());
    return slot.generation;
  }

  private fire(key: string, slot: Slot): void {
    if (slot.running) {
      slot.dirty = true; // run once more when the current run finishes
      return;
    }
    slot.running = true;
    slot.dirty = false;
    const gen = slot.generation;
    slot
      .runner(gen)
      .catch(() => undefined)
      .finally(() => {
        slot.running = false;
        if (this.slots.get(key) !== slot) return;
        if (slot.dirty && !slot.timer) this.fire(key, slot);
      });
  }

  isCurrent(key: string, generation: number): boolean {
    return this.slots.get(key)?.generation === generation;
  }

  /** Invalidate pending and in-flight work for a key (e.g. live mode off). */
  cancel(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.timer) clearTimeout(slot.timer);
    this.slots.delete(key);
  }

  cancelAll(): void {
    for (const key of [...this.slots.keys()]) this.cancel(key);
  }

  isRunning(key: string): boolean {
    return this.slots.get(key)?.running ?? false;
  }
}
