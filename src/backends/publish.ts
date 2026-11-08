// Publishing without publishing twice. One idempotency key per attempt: a
// retry of the same attempt sends the same key, and the platform answers with
// the receipt it already has. When a publish times out, its status is checked
// before anyone is offered a retry.
import type { CompositionBackend, PublishInput, PublishReceipt } from '../ui/host'
import { ComposerError, isComposerError } from './errors'

export interface PublishRecovery {
  /** How many status checks after a timeout (default 5). The first is immediate. */
  attempts?: number
  /** Between checks, in ms (default 2000). */
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** A fresh idempotency key: one per publish attempt. */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Publish; on a timeout (or a publish of the same key still in progress),
 * check `publishStatus` until it says how the attempt ended. Resolves the
 * receipt; rejects with the attempt's refusal, or PUBLISH_PENDING (retryable:
 * retry with the same key) when it still hasn't finished.
 */
export async function publishWithRecovery(backend: Pick<CompositionBackend, 'publish' | 'publishStatus'>, input: PublishInput, recovery: PublishRecovery = {}): Promise<PublishReceipt> {
  if (!backend.publish) throw new ComposerError('ENTRY_POINT_MISSING', { detail: 'publish' })
  try {
    return await backend.publish(input)
  } catch (error) {
    if (!isComposerError(error) || !error.retryable || !backend.publishStatus) throw error
  }
  const attempts = recovery.attempts ?? 5
  const sleep = recovery.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(recovery.intervalMs ?? 2000)
    try {
      const status = await backend.publishStatus(input.idempotencyKey)
      if ('composition_uuid' in status) return status
    } catch (error) {
      // A refusal is how the attempt ended; a timeout or a hiccup is worth another look.
      if (isComposerError(error) && !error.retryable && error.code !== 'UNKNOWN') throw error
    }
  }
  throw new ComposerError('PUBLISH_PENDING', { data: { idempotency_key: input.idempotencyKey } })
}
