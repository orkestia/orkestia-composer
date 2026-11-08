// Typed refusals. The platform refuses with stable codes; backends turn them
// into ComposerError so hosts and the editor can branch on `code` and show a
// translated message.
import { msg, t } from '../ui/i18n'
import type { Json } from '../ui/host'

/**
 * The stable refusal codes of the end-user authoring verbs (the two lower-case
 * ones come from the end-user principal checks every end-user verb shares).
 * PUBLISH_ABANDONED, IDEMPOTENCY_KEY_REUSED and INTERNAL_ERROR end an attempt:
 * the next publish starts with a new key.
 */
export const REFUSAL_CODES = [
  'AUTHORING_NOT_ENABLED', 'CAPABILITY_REQUIRED', 'VERSION_CONFLICT', 'STEP_NOT_AUTHORABLE', 'UNSCOPED_INPUT',
  'NESTED_NOT_IN_WORKSPACE', 'WORKSPACE_MISMATCH', 'QUOTA_EXCEEDED', 'RESERVED_NAME', 'WORKSPACE_REQUIRED',
  'NOT_FOUND', 'PUBLISH_IN_PROGRESS', 'VALIDATION_FAILED', 'IDEMPOTENCY_KEY_REUSED', 'PUBLISH_ABANDONED', 'INTERNAL_ERROR',
  'end_user_principal_required', 'organization_mismatch',
] as const

export type RefusalCode = (typeof REFUSAL_CODES)[number]

/**
 * A refusal code, or one the backend raises itself: the platform did not
 * answer in time, a publish is still pending after checking, the app does not
 * offer an entry point, a schedule runs too often, or anything else.
 */
export type ComposerErrorCode = RefusalCode | 'TIMEOUT' | 'PUBLISH_PENDING' | 'ENTRY_POINT_MISSING' | 'SCHEDULE_TOO_FREQUENT' | 'UNKNOWN'

const MESSAGES: Record<ComposerErrorCode, string> = {
  AUTHORING_NOT_ENABLED: msg('Building workflows isn’t turned on for this app.'),
  CAPABILITY_REQUIRED: msg('You don’t have permission to do that in this workspace.'),
  VERSION_CONFLICT: msg('Someone saved a newer version while you were editing.'),
  STEP_NOT_AUTHORABLE: msg('It uses a step this app doesn’t let you use.'),
  UNSCOPED_INPUT: msg('A step takes an account or workspace from the run’s answers. Leave that to the platform.'),
  NESTED_NOT_IN_WORKSPACE: msg('It runs another workflow that isn’t published in this workspace.'),
  WORKSPACE_MISMATCH: msg('It belongs to another workspace.'),
  QUOTA_EXCEEDED: msg('This workspace has reached its limit. Archive something first, or ask an admin.'),
  RESERVED_NAME: msg('That name is reserved. Pick another one.'),
  WORKSPACE_REQUIRED: msg('Pick a workspace first.'),
  NOT_FOUND: msg('It doesn’t exist, or you can’t see it.'),
  PUBLISH_IN_PROGRESS: msg('This publish is still in progress. Try again in a moment.'),
  VALIDATION_FAILED: msg('It didn’t pass the platform’s checks, so it was kept as a draft.'),
  IDEMPOTENCY_KEY_REUSED: msg('That publish attempt was already used for something else. Publish again to start a new one.'),
  PUBLISH_ABANDONED: msg('That publish attempt was abandoned. Publish again to start a new one.'),
  INTERNAL_ERROR: msg('The platform ran into a problem of its own. Try again later.'),
  end_user_principal_required: msg('Sign in to this app to build workflows.'),
  organization_mismatch: msg('It belongs to another organization.'),
  TIMEOUT: msg('The platform didn’t answer in time.'),
  PUBLISH_PENDING: msg('Publishing is taking longer than usual. Try again: it won’t publish twice.'),
  ENTRY_POINT_MISSING: msg('This app isn’t set up for building workflows yet.'),
  SCHEDULE_TOO_FREQUENT: msg('That schedule runs more often than this app allows.'),
  UNKNOWN: msg('Something went wrong.'),
}

/** The translated message for a code (in the editor's current locale). */
export function errorMessage(code: ComposerErrorCode): string {
  return t(MESSAGES[code] ?? MESSAGES.UNKNOWN)
}

/** Codes worth retrying as they are (the same attempt, the same idempotency key). */
const RETRYABLE = new Set<ComposerErrorCode>(['TIMEOUT', 'PUBLISH_PENDING', 'PUBLISH_IN_PROGRESS'])

export class ComposerError extends Error {
  readonly code: ComposerErrorCode
  /** What the platform said beyond the code (the steps refused, the checks that failed…). */
  readonly detail?: string
  /** The refusal's own fields (`head_version` for VERSION_CONFLICT, `request_uuid`…). */
  readonly data: Json
  readonly retryable: boolean

  constructor(code: ComposerErrorCode, options: { detail?: string; data?: Json; cause?: unknown } = {}) {
    const base = code === 'UNKNOWN' && options.detail ? options.detail : errorMessage(code)
    super(code !== 'UNKNOWN' && options.detail ? `${base} (${options.detail})` : base, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ComposerError'
    this.code = code
    this.detail = options.detail
    this.data = options.data ?? {}
    this.retryable = RETRYABLE.has(code)
  }

  /** For VERSION_CONFLICT: the version that is newest now, when the platform said. */
  get headVersion(): number | null {
    const v = Number(this.data.head_version)
    return Number.isFinite(v) && this.data.head_version !== undefined && this.data.head_version !== null ? v : null
  }
}

export function isComposerError(error: unknown, code?: ComposerErrorCode): error is ComposerError {
  return error instanceof ComposerError && (code === undefined || error.code === code)
}
