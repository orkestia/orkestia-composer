// @vitest-environment jsdom
// Following a run on the cards. For an app backend each step read is a platform run of its own, so
// the editor reads the steps every third poll, and always once after the run has ended.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CompositionEditor } from './CompositionEditor'
import { createFixtureBackend, fixtureCatalog, sampleCompositions } from './fixtures'
import type { RunInspector, RunState } from './host'
import { builder, compileFor } from './store'

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  globalThis.localStorage?.clear()
})

async function following(kind: 'app' | 'member', endsAtPoll: number) {
  const backend = createFixtureBackend({ definitions: sampleCompositions({ childNames: 'slug' }), kind })
  render(<CompositionEditor backend={backend} catalog={fixtureCatalog} host={{ scopeKey: 'test', platform: 'mac' }} />)
  fireEvent.click(await screen.findByRole('button', { name: (n) => n.startsWith('Confirm big orders') && !/each/i.test(n) }))
  await screen.findAllByText('Get the order')
  const entry = builder.state.entries.find((e) => e.key === 'confirm-big-orders')!
  const names = Object.keys(compileFor(entry.recipe!).owners)

  let polls = 0
  let ended = false
  const inspected: number[] = []
  backend.state = async (id): Promise<RunState> => {
    ended = ++polls > endsAtPoll
    return { workflow_id: id, is_terminal: ended, terminal_status: ended ? 'success' : null, state_data: {} }
  }
  // Steps read before the end are still running; a read after it sees them finished.
  backend.inspect = async (id): Promise<RunInspector> => {
    inspected.push(polls)
    const status = ended ? 'succeeded' : 'running'
    return { workflow_id: id, workflow_type: '', state_name: '', terminal_status: null, layers: [{ name: 'steps', index: 0, steps: names.map((n) => ({ step_name: n, workflow_type: '', status })) }] }
  }
  vi.useFakeTimers()
  const done = builder.follow(entry.key, 'wf_paced', entry.live!.workflow_type)
  for (let i = 0; i < 20 && builder.state.runs[entry.key]?.status === 'running'; i++) await vi.advanceTimersByTimeAsync(1500)
  await done
  return { inspected, steps: Object.values(builder.state.runs[entry.key].steps) }
}

describe('following a run', () => {
  it('reads an app run’s steps every third poll, and once after it ends', async () => {
    // Ends on the 5th poll (i = 4): steps read at i = 0, 3 and after the end.
    const late = await following('app', 4)
    expect(late.inspected).toEqual([1, 4, 5])
    expect(late.steps.every((s) => s === 'succeeded')).toBe(true)
  })

  it('reads the steps after the end even when the run ends on a third poll', async () => {
    // Ends on the 4th poll (i = 3): the state read comes first, so the step read sees the end.
    const onThird = await following('app', 3)
    expect(onThird.inspected).toEqual([1, 4])
    expect(onThird.steps.every((s) => s === 'succeeded')).toBe(true)
  })

  it('reads a member run’s steps on every poll', async () => {
    const member = await following('member', 2)
    expect(member.inspected).toHaveLength(3)
  })
})
