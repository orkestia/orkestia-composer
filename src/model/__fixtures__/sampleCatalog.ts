// Test catalog: platform-style types (slack.*, ticket.*, control.*,
// aws.ses.*) with their fields, an example "Events" app, and a small "Shop"
// app so the demo recipe reads like a business process. Hosts serve the live
// catalog.
import { staticCatalog, type CatalogEntry, type CatalogField } from '../catalog'

const org: CatalogField = { name: 'organization_uuid', type: 'uuid', required: true, automatic: true }
const slackConnection: CatalogField = { name: 'connection_uuid', type: 'uuid', required: true, description: 'Slack workspace connection' }

const entries: CatalogEntry[] = [
  // ---- Shop (sample app) ----
  {
    type: 'shop.order.get', title: 'Get an order', app: 'Shop', readOnly: true,
    description: 'Look up one order with its items and totals.',
    inputs: [org, { name: 'order_id', type: 'string', required: true, description: 'Order number or ID' }],
    outputs: [
      { name: 'number', type: 'string' }, { name: 'total', type: 'float' }, { name: 'currency', type: 'string' },
      { name: 'status', type: 'string' }, { name: 'customer_email', type: 'email' },
      { name: 'items', type: 'list', fields: [{ name: 'sku', type: 'string' }, { name: 'name', type: 'string' }, { name: 'quantity', type: 'integer' }, { name: 'price', type: 'float' }] },
    ],
  },
  {
    type: 'shop.customer.find', title: 'Find a customer', app: 'Shop', readOnly: true,
    description: 'Find a customer by email address.',
    inputs: [org, { name: 'email', type: 'email', required: true }],
    outputs: [{ name: 'customer_id', type: 'string' }, { name: 'name', type: 'string' }, { name: 'email', type: 'email' }, { name: 'tier', type: 'string' }, { name: 'phone', type: 'string' }],
  },
  {
    type: 'shop.order.list', title: 'List orders', app: 'Shop', readOnly: true,
    description: 'Orders that match a status, newest first.',
    inputs: [org, { name: 'status', type: 'string', options: ['new', 'paid', 'shipped', 'cancelled'] }, { name: 'limit', type: 'integer' }],
    outputs: [{ name: 'orders', type: 'list', fields: [{ name: 'order_id', type: 'string' }, { name: 'number', type: 'string' }, { name: 'total', type: 'float' }, { name: 'customer_email', type: 'email' }] }, { name: 'count', type: 'integer' }],
  },
  {
    type: 'shop.stock.reserve', title: 'Reserve stock', app: 'Shop', readOnly: false,
    description: 'Hold units of a product for an order.',
    inputs: [org, { name: 'sku', type: 'string', required: true }, { name: 'quantity', type: 'integer', required: true }, { name: 'order_id', type: 'string' }],
    outputs: [{ name: 'reservation_id', type: 'string' }, { name: 'remaining', type: 'integer' }],
  },
  {
    type: 'shop.stock.release', title: 'Release stock', app: 'Shop', readOnly: false,
    description: 'Give back units held by a reservation.',
    inputs: [org, { name: 'reservation_id', type: 'string' }, { name: 'sku', type: 'string', required: true }],
    outputs: [{ name: 'released', type: 'boolean' }],
  },
  {
    type: 'shop.order.update-status', title: 'Change an order’s status', app: 'Shop', readOnly: false,
    description: 'Move an order to a new status.',
    inputs: [org, { name: 'order_id', type: 'string', required: true }, { name: 'status', type: 'string', required: true, options: ['paid', 'confirmed', 'shipped', 'cancelled'] }, { name: 'note', type: 'text' }],
    outputs: [{ name: 'status', type: 'string' }, { name: 'updated_at', type: 'datetime' }],
  },
  // ---- Slack ----
  {
    type: 'slack.message.send', title: 'Send a Slack message', app: 'Slack', readOnly: false,
    description: 'Send a Slack message with an organization-scoped Slack connection.',
    inputs: [org, slackConnection, { name: 'channel', type: 'string', required: true, description: 'Channel name or ID' }, { name: 'text', type: 'text', required: true, description: 'Message text (Slack mrkdwn)' }, { name: 'thread_ts', type: 'string', description: 'Reply in this thread' }, { name: 'unfurl_links', type: 'boolean' }],
    outputs: [{ name: 'channel', type: 'string' }, { name: 'message_ts', type: 'string' }, { name: 'thread_ts', type: 'string' }, { name: 'permalink', type: 'string' }],
  },
  {
    type: 'slack.approval.request', title: 'Ask for approval in Slack', app: 'Slack', readOnly: false, asksPerson: true,
    description: 'Post an approve/reject message and wait for someone to answer.',
    inputs: [org, slackConnection, { name: 'channel', type: 'string', required: true }, { name: 'prompt', type: 'text', required: true, description: 'What you are asking' }, { name: 'note', type: 'text' }, { name: 'approve_label', type: 'string' }, { name: 'reject_label', type: 'string' }, { name: 'timeout_seconds', type: 'integer' }],
    outputs: [{ name: 'decision', type: 'string' }, { name: 'decided_by_name', type: 'string' }, { name: 'decided_at', type: 'datetime' }, { name: 'permalink', type: 'string' }, { name: 'status', type: 'string' }],
  },
  {
    type: 'slack.channel.resolve', title: 'Find a Slack channel', app: 'Slack', readOnly: false,
    description: 'Resolve a Slack channel name, channel id, or DM target into a conversation id.',
    inputs: [org, slackConnection, { name: 'channel', type: 'string', required: true, description: 'Channel id, #name, or DM target' }, { name: 'allow_dm', type: 'boolean' }],
    outputs: [{ name: 'channel', type: 'string' }, { name: 'channel_name', type: 'string' }, { name: 'channel_type', type: 'string' }, { name: 'resolved', type: 'boolean' }],
  },
  // ---- Email ----
  {
    type: 'aws.ses.send_email', title: 'Send an email', app: 'Email (AWS SES)', readOnly: false,
    description: 'Send an email through Amazon SES.',
    inputs: [org, { name: 'connection_uuid', type: 'uuid', required: true, description: 'AWS connection' }, { name: 'to', type: 'email', required: true }, { name: 'subject', type: 'string', required: true }, { name: 'body', type: 'text', required: true }, { name: 'from_address', type: 'email' }],
    outputs: [{ name: 'message_id', type: 'string' }],
  },
  // ---- Tickets ----
  {
    type: 'ticket.open', title: 'Open a ticket', app: 'Tickets', readOnly: false,
    description: 'Create a ticket, or add to the matching open one.',
    inputs: [org, { name: 'kind', type: 'string', required: true, options: ['incident', 'task', 'info'] }, { name: 'title', type: 'string', required: true }, { name: 'body', type: 'text' }, { name: 'priority', type: 'string', options: ['page', 'priority', 'routine', 'deferred'] }, { name: 'labels', type: 'list' }],
    outputs: [{ name: 'ticket_uuid', type: 'uuid' }, { name: 'created', type: 'boolean' }, { name: 'status', type: 'string' }],
  },
  {
    type: 'ticket.get', title: 'Get a ticket', app: 'Tickets', readOnly: true,
    description: 'Read one ticket with its links and evidence.',
    inputs: [org, { name: 'ticket_uuid', type: 'uuid', required: true }],
    outputs: [{ name: 'ticket', type: 'dict', fields: [{ name: 'title', type: 'string' }, { name: 'status', type: 'string' }, { name: 'priority', type: 'string' }] }],
  },
  {
    type: 'ticket.comment', title: 'Comment on a ticket', app: 'Tickets', readOnly: false,
    inputs: [org, { name: 'ticket_uuid', type: 'uuid', required: true }, { name: 'body', type: 'text', required: true }],
    outputs: [{ name: 'event_uuid', type: 'uuid' }],
  },
  // ---- Events ----
  {
    type: 'example.events.dispatch', title: 'Send an event', app: 'Events', readOnly: false,
    description: 'Send an event to a recipient’s inbox.',
    inputs: [org, { name: 'recipient_uuid', type: 'uuid', required: true }, { name: 'event_type', type: 'string', required: true }, { name: 'payload', type: 'json' }],
    outputs: [{ name: 'envelope_uuid', type: 'uuid' }],
  },
  // ---- Built-in helpers ----
  {
    type: 'control.value.format', title: 'Format text', app: 'Helpers', readOnly: true,
    description: 'Fill {0}…{7} in a template.',
    inputs: [{ name: 'template', type: 'text', required: true }, ...[0, 1, 2, 3].map((i): CatalogField => ({ name: `arg${i}`, type: 'json' }))],
    outputs: [{ name: 'result', type: 'string' }],
  },
  {
    type: 'control.value.build', title: 'Build a record', app: 'Helpers', readOnly: true,
    description: 'Put values together into one record.',
    inputs: [{ name: 'fields', type: 'dict', required: true }, { name: 'drop_null', type: 'boolean' }],
    outputs: [{ name: 'result', type: 'dict' }],
  },
  {
    type: 'control.predicate.compare', title: 'Compare two values', app: 'Helpers', readOnly: true,
    description: 'Check a value against another (equal, greater than…).',
    inputs: [{ name: 'a', type: 'json', description: 'Left-hand value' }, { name: 'op', type: 'string', required: true, options: ['eq', 'ne', 'in', 'not_in', 'truthy', 'falsy', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'regex', 'is_null', 'not_null'] }, { name: 'b', type: 'json', description: 'Right-hand value' }],
    outputs: [{ name: 'result', type: 'boolean' }, { name: 'a', type: 'json' }, { name: 'op', type: 'string' }, { name: 'b', type: 'json' }],
  },
  {
    type: 'control.collection.slice', title: 'Take part of a list', app: 'Helpers', readOnly: true,
    description: 'Keep the first N items of a list.',
    inputs: [{ name: 'items', type: 'list', required: true }, { name: 'start', type: 'integer' }, { name: 'stop', type: 'integer' }],
    outputs: [{ name: 'result', type: 'list' }, { name: 'count', type: 'integer' }],
  },
  {
    type: 'control.time.now', title: 'Get the current time', app: 'Helpers', readOnly: true,
    inputs: [{ name: 'format', type: 'string' }],
    outputs: [{ name: 'now', type: 'datetime' }],
  },
  {
    type: 'flow.wait', title: 'Wait', app: 'Helpers', readOnly: true,
    description: 'Pause before the next step.',
    inputs: [{ name: 'seconds', type: 'integer', required: true }],
    outputs: [{ name: 'waited_seconds', type: 'integer' }],
  },
]

export const sampleCatalog = staticCatalog(entries)
export const sampleEntries = entries
