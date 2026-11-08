// A WorkflowsClientLike that answers from handlers, for backend tests. No network.
import type { Json, RunState } from '../../ui/host'
import type { WorkflowsClientLike } from '../client'

export type Handler = (input: Json, call: { type: string; timeoutMs?: number }) => unknown | Promise<unknown>

/** An error shaped like a failed run: the run's output on `data`. */
export class RunFailed extends Error {
  constructor(message: string, readonly data: Json = {}) {
    super(message)
  }
}

export interface FakeClient extends WorkflowsClientLike {
  calls: Array<{ type: string; input: Json }>
  gets: string[]
  posts: Array<{ path: string; body: Json }>
  starts: Array<{ type: string; input: Json }>
  states: Map<string, RunState>
  on(type: string, handler: Handler): FakeClient
  onGet(path: string | RegExp, handler: (path: string) => unknown): FakeClient
  inputsOf(type: string): Json[]
}

export function fakeClient(options: { withGet?: boolean; withPost?: boolean } = {}): FakeClient {
  const handlers = new Map<string, Handler>()
  const getHandlers: Array<[string | RegExp, (path: string) => unknown]> = []
  let seq = 0
  const client: FakeClient = {
    calls: [], gets: [], posts: [], starts: [], states: new Map(),
    on(type, handler) { handlers.set(type, handler); return client },
    onGet(path, handler) { getHandlers.push([path, handler]); return client },
    inputsOf: (type) => client.calls.filter((c) => c.type === type).map((c) => c.input),
    async run<T>(type: string, input: Json = {}, timeoutMs?: number): Promise<T> {
      client.calls.push({ type, input: structuredClone(input) })
      const handler = handlers.get(type)
      if (!handler) throw new RunFailed(`no handler for ${type}`)
      return (await handler(input, { type, timeoutMs })) as T
    },
    async start(type, input) {
      client.starts.push({ type, input })
      const workflow_id = `wf_${++seq}`
      const state: RunState = { workflow_id, workflow_type: type, state_name: 'running', is_terminal: false, terminal_status: null }
      client.states.set(workflow_id, state)
      return state
    },
    async state(id) {
      const s = client.states.get(id)
      if (!s) throw new Error(`no run ${id}`)
      return s
    },
  }
  if (options.withGet !== false) {
    client.get = async <T,>(path: string): Promise<T> => {
      client.gets.push(path)
      const match = getHandlers.find(([p]) => (typeof p === 'string' ? p === path : p.test(path)))
      if (!match) throw new Error(`no GET handler for ${path}`)
      return match[1](path) as T
    }
  }
  if (options.withPost) {
    client.post = async <T,>(path: string, body: Json): Promise<T> => {
      client.posts.push({ path, body })
      return { decisions: [{ field: 'channel', status: 'options', options: [{ value: 'C1', label: '#general' }] }] } as T
    }
  }
  return client
}
