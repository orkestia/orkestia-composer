// Sample data: one recipe built the way a person would ("Confirm big
// orders"), and three example compositions in the library format opened
// through the decompiler, to judge how existing work reads.
import type { CompositionDefinition } from '../definition'
import { decompile } from '../decompile'
import { uid, type Recipe, type Step, type Value } from '../recipe'
import { sampleCatalog } from './sampleCatalog'
import approval from './samples/release-candidate-approval-dispatch.json'
import notify from './samples/release-status-notification-reconcile.json'
import lag from './samples/package-rows-lag-summary.json'

const lit = (value: unknown): Value => ({ kind: 'literal', value })

function step(id: string, name: string, title: string, workflowType: string, fields: Record<string, Value>, extra: Partial<Step> = {}): Step {
  return { kind: 'step', id, name, autoName: true, title, workflowType, fields, undo: [], stopOnFail: false, alongside: false, ...extra }
}

export function confirmBigOrders(): Recipe {
  const ifId = uid('c')
  const eachId = uid('c')
  return {
    name: 'confirm-big-orders',
    title: 'Confirm big orders',
    description: 'Ask a manager before confirming orders over 1,000, then reserve stock and tell the customer.',
    inputs: [
      { id: 'i_org', name: 'organization_uuid', label: 'Organization', type: 'uuid', required: true, hidden: true },
      { id: 'i_order', name: 'order_id', label: 'Order', type: 'string', required: true, description: 'Order number' },
      { id: 'i_email', name: 'customer_email', label: 'Customer email', type: 'email', required: true },
    ],
    blocks: [
      step('s_customer', 'find_the_customer', 'Find the customer', 'shop.customer.find', {
        email: { kind: 'ref', ref: { kind: 'input', name: 'customer_email' } },
      }),
      step('s_order', 'get_the_order', 'Get the order', 'shop.order.get', {
        order_id: { kind: 'ref', ref: { kind: 'input', name: 'order_id' } },
      }),
      {
        kind: 'if', id: ifId,
        condition: { kind: 'compare', left: { kind: 'step', step: 's_order', path: 'total' }, op: 'gt', value: 1000 },
        blocks: [
          step('s_ask', 'ask_a_manager', 'Ask a manager', 'slack.approval.request', {
            connection_uuid: lit(''),
            channel: lit('#sales-approvals'),
            prompt: { kind: 'text', parts: ['Approve order ', { kind: 'step', step: 's_order', path: 'number' }, ' for ', { kind: 'step', step: 's_customer', path: 'name' }, '?'] },
          }, { stopOnFail: true }),
        ],
      },
      {
        kind: 'foreach', id: eachId, list: { kind: 'step', step: 's_order', path: 'items' }, as: 'item', onError: 'fail',
        blocks: [
          step('s_reserve', 'reserve_stock', 'Reserve stock', 'shop.stock.reserve', {
            sku: { kind: 'ref', ref: { kind: 'item', loop: eachId, path: 'sku' } },
            quantity: { kind: 'ref', ref: { kind: 'item', loop: eachId, path: 'quantity' } },
            order_id: { kind: 'ref', ref: { kind: 'input', name: 'order_id' } },
          }, {
            undo: [{
              id: 'u_release', name: 'release_stock', title: 'Release stock', workflowType: 'shop.stock.release',
              fields: { sku: { kind: 'ref', ref: { kind: 'item', loop: eachId, path: 'sku' } } },
            }],
          }),
        ],
      },
      step('s_confirm', 'confirm_the_order', 'Confirm the order', 'shop.order.update-status', {
        order_id: { kind: 'ref', ref: { kind: 'input', name: 'order_id' } },
        status: lit('confirmed'),
      }),
      step('s_email', 'email_the_customer', 'Email the customer', 'aws.ses.send_email', {
        connection_uuid: lit(''),
        to: { kind: 'ref', ref: { kind: 'step', step: 's_customer', path: 'email' } },
        subject: { kind: 'text', parts: ['Your order ', { kind: 'step', step: 's_order', path: 'number' }, ' is confirmed'] },
        body: { kind: 'text', parts: ['Hi ', { kind: 'step', step: 's_customer', path: 'name' }, ', thanks for your order. We’ve reserved everything and will ship soon.'] },
      }),
    ],
    returns: [
      { id: 'r_status', name: 'status', value: { kind: 'ref', ref: { kind: 'step', step: 's_confirm', path: 'status' } } },
      { id: 'r_email', name: 'email_id', value: { kind: 'ref', ref: { kind: 'step', step: 's_email', path: 'message_id' } } },
    ],
    runs: { mode: 'app', everyMinutes: 60 },
    readOnly: [],
    metadata: {},
  }
}

export const libraryDefinitions = [approval, notify, lag] as unknown as CompositionDefinition[]

export function sampleRecipes(): Recipe[] {
  return [confirmBigOrders(), ...libraryDefinitions.map((d) => decompile(d, sampleCatalog))]
}
