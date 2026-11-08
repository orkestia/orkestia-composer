// Undo and redo for one open workflow, shared by the step builder and the
// diagram: both edit the same recipe through the store, which records here.
// Edits that land within `mergeMs` of each other (typing a name, a drag that
// makes two changes) undo together.

export class History<T> {
  private past: T[] = []
  private future: T[] = []
  private lastAt = 0

  constructor(private readonly limit = 100, private readonly mergeMs = 600) {}

  /** `before` is what the edit replaced. */
  record(before: T, now = Date.now(), merge = true): void {
    if (!(merge && this.past.length && now - this.lastAt < this.mergeMs)) {
      this.past.push(before)
      if (this.past.length > this.limit) this.past.shift()
    }
    this.lastAt = now
    this.future = []
  }

  /** Start a new undo step even if the next edit comes quickly. */
  seal(): void { this.lastAt = 0 }

  undo(current: T): T | null {
    const prev = this.past.pop()
    if (prev === undefined) return null
    this.future.push(current)
    this.lastAt = 0
    return prev
  }

  redo(current: T): T | null {
    const next = this.future.pop()
    if (next === undefined) return null
    this.past.push(current)
    this.lastAt = 0
    return next
  }

  get canUndo(): boolean { return this.past.length > 0 }
  get canRedo(): boolean { return this.future.length > 0 }

  clear(): void { this.past = []; this.future = []; this.lastAt = 0 }
}
