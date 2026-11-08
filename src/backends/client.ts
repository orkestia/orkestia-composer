// The one thing a backend needs from its host: a way to run workflows as the
// signed-in person. Hosts pass their own client (an organization member's
// console client, or an app's end-user client signed in with Orkestia); this
// is the smallest shape both have, so the package never imports an SDK.
import type { Json, RunState } from '../ui/host'

export interface WorkflowsClientLike {
  /**
   * Run a workflow to its end and resolve its output (`state_data`). Rejects
   * when it fails or times out. To let backends tell refusals apart, reject
   * with an Error that carries the run's output on `data` (or a refusal code
   * on `code`); a timeout should say "timed out" or be named `TimeoutError`.
   */
  run<T = Json>(workflowType: string, input?: Json, timeoutMs?: number): Promise<T>
  /** Start a run and resolve its first state (with `workflow_id`). */
  start(workflowType: string, input: Json): Promise<RunState>
  /** A run's current state. */
  state(workflowId: string): Promise<RunState>
  /** A GET against the workflow API, by path (`/api/workflows/types/...`). Optional: features that need it switch off. */
  get?<T = Json>(path: string): Promise<T>
  /** A POST against the workflow API, by path. Optional: features that need it switch off. */
  post?<T = Json>(path: string, body: Json): Promise<T>
}
