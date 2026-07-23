import { useMemo, useState, type ReactNode } from 'react'
import { defineGenieTool, GenieToolError, useGenieTools } from 'genie-react'
import { z } from 'zod'

const TICKET_STATUSES = ['open', 'waiting', 'resolved'] as const
const TICKET_PRIORITIES = ['urgent', 'high', 'normal'] as const
const SUPPORT_OWNERS = ['maya', 'omar', 'sara'] as const

type TicketStatus = (typeof TICKET_STATUSES)[number]
type TicketPriority = (typeof TICKET_PRIORITIES)[number]
type SupportOwner = (typeof SUPPORT_OWNERS)[number]

interface SupportNote {
  id: string
  body: string
  visibility: 'internal' | 'customer'
  author: SupportOwner | 'agent'
  createdAt: string
}

interface SupportTicket {
  id: string
  subject: string
  summary: string
  status: TicketStatus
  priority: TicketPriority
  customer: {
    name: string
    company: string
    plan: 'starter' | 'growth' | 'enterprise'
    health: 'healthy' | 'watch' | 'at_risk'
    lifetimeValue: number
  }
  assignee: SupportOwner | null
  tags: string[]
  lastReplyMinutes: number
  version: number
  notes: SupportNote[]
}

const INITIAL_TICKETS: SupportTicket[] = [
  {
    id: 'SUP-1042',
    subject: 'Checkout fails after applying annual credit',
    summary:
      'Payment confirmation returns to checkout when an annual account credit covers part of the invoice.',
    status: 'open',
    priority: 'urgent',
    customer: {
      name: 'Lina Haddad',
      company: 'Atlas Freight',
      plan: 'enterprise',
      health: 'at_risk',
      lifetimeValue: 184000,
    },
    assignee: null,
    tags: ['billing', 'checkout', 'regression'],
    lastReplyMinutes: 18,
    version: 3,
    notes: [],
  },
  {
    id: 'SUP-1038',
    subject: 'SSO group mapping is delayed',
    summary: 'New workspace members do not inherit their IdP group permissions for several minutes.',
    status: 'waiting',
    priority: 'high',
    customer: {
      name: 'David Chen',
      company: 'Northstar Labs',
      plan: 'enterprise',
      health: 'watch',
      lifetimeValue: 92000,
    },
    assignee: 'maya',
    tags: ['sso', 'permissions'],
    lastReplyMinutes: 47,
    version: 5,
    notes: [
      {
        id: 'NOTE-1',
        body: 'Asked the identity team to inspect the sync worker.',
        visibility: 'internal',
        author: 'maya',
        createdAt: '2026-07-23T08:12:00.000Z',
      },
    ],
  },
  {
    id: 'SUP-1031',
    subject: 'CSV export uses the wrong timezone',
    summary: 'Scheduled exports render midnight in UTC instead of the workspace timezone.',
    status: 'open',
    priority: 'normal',
    customer: {
      name: 'Amal Rahman',
      company: 'Cedar Analytics',
      plan: 'growth',
      health: 'healthy',
      lifetimeValue: 24000,
    },
    assignee: 'omar',
    tags: ['exports', 'timezone'],
    lastReplyMinutes: 126,
    version: 2,
    notes: [],
  },
  {
    id: 'SUP-1024',
    subject: 'Invite delivery recovered',
    summary: 'Invitation emails were delayed during a provider incident and are now delivering.',
    status: 'resolved',
    priority: 'high',
    customer: {
      name: 'Noah Williams',
      company: 'Juniper Health',
      plan: 'growth',
      health: 'healthy',
      lifetimeValue: 38000,
    },
    assignee: 'sara',
    tags: ['email', 'incident'],
    lastReplyMinutes: 340,
    version: 8,
    notes: [
      {
        id: 'NOTE-2',
        body: 'Confirmed the provider backlog is clear and shared the incident report.',
        visibility: 'customer',
        author: 'sara',
        createdAt: '2026-07-23T06:30:00.000Z',
      },
    ],
  },
]

const ticketStatusSchema = z.enum(TICKET_STATUSES)
const ticketPrioritySchema = z.enum(TICKET_PRIORITIES)
const supportOwnerSchema = z.enum(SUPPORT_OWNERS)
const ticketIdSchema = z
  .string()
  .trim()
  .regex(/^SUP-\d{4}$/, 'expected a ticket id like SUP-1042')

const queueTicketSchema = z.object({
  id: ticketIdSchema,
  subject: z.string(),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  assignee: supportOwnerSchema.nullable(),
  company: z.string(),
  plan: z.enum(['starter', 'growth', 'enterprise']),
  lastReplyMinutes: z.number().int().nonnegative(),
  version: z.number().int().positive(),
})

const ticketDetailSchema = z.object({
  id: ticketIdSchema,
  subject: z.string(),
  summary: z.string(),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  customer: z.object({
    name: z.string(),
    company: z.string(),
    plan: z.enum(['starter', 'growth', 'enterprise']),
    health: z.enum(['healthy', 'watch', 'at_risk']),
    lifetimeValue: z.number().int().nonnegative(),
  }),
  assignee: supportOwnerSchema.nullable(),
  tags: z.array(z.string()),
  lastReplyMinutes: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  notes: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      visibility: z.enum(['internal', 'customer']),
      author: z.union([supportOwnerSchema, z.literal('agent')]),
      createdAt: z.iso.datetime(),
    }),
  ),
})

function normalizeTicketId(ticketId: string): string {
  return ticketId.trim().toUpperCase()
}

function priorityRank(priority: TicketPriority): number {
  return TICKET_PRIORITIES.indexOf(priority)
}

function ticketOrThrow(tickets: SupportTicket[], rawTicketId: string): SupportTicket {
  const ticketId = normalizeTicketId(rawTicketId)
  const ticket = tickets.find((candidate) => candidate.id === ticketId)
  if (!ticket) {
    throw new GenieToolError(`ticket "${ticketId}" was not found`, {
      code: 'TICKET_NOT_FOUND',
      hint: 'call app_support_queue to discover current ticket ids',
    })
  }
  return ticket
}

export function SupportDeskPanel(): ReactNode {
  const [tickets, setTickets] = useState<SupportTicket[]>(INITIAL_TICKETS)
  const [selectedId, setSelectedId] = useState(INITIAL_TICKETS[0]?.id ?? '')
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'active'>('active')
  const [noteDraft, setNoteDraft] = useState('')

  const visibleTickets = useMemo(
    () =>
      tickets
        .filter((ticket) =>
          statusFilter === 'active' ? ticket.status !== 'resolved' : ticket.status === statusFilter,
        )
        .sort(
          (left, right) =>
            priorityRank(left.priority) - priorityRank(right.priority) ||
            left.lastReplyMinutes - right.lastReplyMinutes,
        ),
    [statusFilter, tickets],
  )
  const selectedTicket = tickets.find((ticket) => ticket.id === selectedId) ?? visibleTickets[0]
  const activeCount = tickets.filter((ticket) => ticket.status !== 'resolved').length
  const urgentCount = tickets.filter(
    (ticket) => ticket.status !== 'resolved' && ticket.priority === 'urgent',
  ).length
  const unassignedCount = tickets.filter(
    (ticket) => ticket.status !== 'resolved' && ticket.assignee === null,
  ).length

  const tools = [
    defineGenieTool({
      name: 'support_queue',
      title: 'Inspect support queue',
      group: 'support',
      kind: 'query',
      description:
        'Returns a compact, priority-sorted support queue with workload totals. Filter by status, priority, or owner before choosing a ticket for app_support_ticket or an operation.',
      input: z
        .object({
          status: z.enum(['active', ...TICKET_STATUSES]).default('active'),
          priority: ticketPrioritySchema.optional(),
          owner: z.enum([...SUPPORT_OWNERS, 'unassigned']).optional(),
          limit: z.number().int().min(1).max(20).default(10),
        })
        .strict(),
      output: z.object({
        summary: z.object({
          matched: z.number().int().nonnegative(),
          active: z.number().int().nonnegative(),
          urgent: z.number().int().nonnegative(),
          unassigned: z.number().int().nonnegative(),
        }),
        tickets: z.array(queueTicketSchema),
      }),
      handler: ({ status, priority, owner, limit }) => {
        const matches = tickets
          .filter((ticket) => (status === 'active' ? ticket.status !== 'resolved' : ticket.status === status))
          .filter((ticket) => priority === undefined || ticket.priority === priority)
          .filter(
            (ticket) =>
              owner === undefined ||
              (owner === 'unassigned' ? ticket.assignee === null : ticket.assignee === owner),
          )
          .sort(
            (left, right) =>
              priorityRank(left.priority) - priorityRank(right.priority) ||
              left.lastReplyMinutes - right.lastReplyMinutes,
          )
        return {
          summary: {
            matched: matches.length,
            active: activeCount,
            urgent: urgentCount,
            unassigned: unassignedCount,
          },
          tickets: matches.slice(0, limit).map((ticket) => ({
            id: ticket.id,
            subject: ticket.subject,
            status: ticket.status,
            priority: ticket.priority,
            assignee: ticket.assignee,
            company: ticket.customer.company,
            plan: ticket.customer.plan,
            lastReplyMinutes: ticket.lastReplyMinutes,
            version: ticket.version,
          })),
        }
      },
    }),
    defineGenieTool({
      name: 'support_ticket',
      title: 'Read ticket context',
      group: 'support',
      kind: 'query',
      description:
        'Returns the complete customer, issue, ownership, version, tags, and note history for one support ticket. Read this before changing ownership or resolving a case.',
      input: z.object({ ticketId: ticketIdSchema }).strict(),
      output: ticketDetailSchema,
      handler: ({ ticketId }) => ticketOrThrow(tickets, ticketId),
    }),
    defineGenieTool({
      name: 'support_assign',
      title: 'Assign support owner',
      group: 'support_ops',
      kind: 'action',
      idempotent: true,
      description:
        'Safely assigns an active ticket to an on-call owner. Pass expectedVersion from a queue read to prevent overwriting newer work; repeating the same assignment is a no-op.',
      input: z
        .object({
          ticketId: ticketIdSchema,
          owner: supportOwnerSchema,
          expectedVersion: z.number().int().positive().optional(),
        })
        .strict(),
      output: z.object({
        ticketId: ticketIdSchema,
        owner: supportOwnerSchema,
        previousOwner: supportOwnerSchema.nullable(),
        version: z.number().int().positive(),
        changed: z.boolean(),
      }),
      handler: ({ ticketId, owner, expectedVersion }) => {
        const ticket = ticketOrThrow(tickets, ticketId)
        if (ticket.status === 'resolved') {
          throw new GenieToolError(`${ticket.id} is already resolved`, {
            code: 'TICKET_CLOSED',
            hint: 'choose an active ticket from app_support_queue',
          })
        }
        if (expectedVersion !== undefined && ticket.version !== expectedVersion) {
          throw new GenieToolError(
            `${ticket.id} changed from version ${expectedVersion} to ${ticket.version}`,
            {
              code: 'VERSION_CONFLICT',
              hint: `refresh with app_support_ticket {"ticketId":"${ticket.id}"} and retry deliberately`,
            },
          )
        }
        if (ticket.assignee === owner) {
          return {
            ticketId: ticket.id,
            owner,
            previousOwner: owner,
            version: ticket.version,
            changed: false,
          }
        }
        const previousOwner = ticket.assignee
        const nextVersion = ticket.version + 1
        setTickets((current) =>
          current.map((candidate) =>
            candidate.id === ticket.id
              ? { ...candidate, assignee: owner, version: nextVersion }
              : candidate,
          ),
        )
        return {
          ticketId: ticket.id,
          owner,
          previousOwner,
          version: nextVersion,
          changed: true,
        }
      },
    }),
    defineGenieTool({
      name: 'support_add_note',
      title: 'Add support note',
      group: 'support_ops',
      kind: 'action',
      description:
        'Adds a concise internal or customer-visible note to an active ticket and returns its generated id. Use internal visibility for handoff context; customer notes are shown as outbound updates.',
      input: z
        .object({
          ticketId: ticketIdSchema,
          body: z.string().trim().min(5).max(280),
          visibility: z.enum(['internal', 'customer']).default('internal'),
        })
        .strict(),
      output: z.object({
        ticketId: ticketIdSchema,
        noteId: z.string(),
        visibility: z.enum(['internal', 'customer']),
        version: z.number().int().positive(),
      }),
      handler: ({ ticketId, body, visibility }) => {
        const ticket = ticketOrThrow(tickets, ticketId)
        if (ticket.status === 'resolved') {
          throw new GenieToolError(`cannot add a note to resolved ticket ${ticket.id}`, {
            code: 'TICKET_CLOSED',
            hint: 'add notes only to active tickets returned by app_support_queue',
          })
        }
        const noteId = `NOTE-${ticket.notes.length + ticket.version + 1}`
        const nextVersion = ticket.version + 1
        const note: SupportNote = {
          id: noteId,
          body,
          visibility,
          author: 'agent',
          createdAt: new Date().toISOString(),
        }
        setTickets((current) =>
          current.map((candidate) =>
            candidate.id === ticket.id
              ? { ...candidate, notes: [...candidate.notes, note], version: nextVersion }
              : candidate,
          ),
        )
        return { ticketId: ticket.id, noteId, visibility, version: nextVersion }
      },
    }),
    defineGenieTool({
      name: 'support_resolve',
      title: 'Resolve support ticket',
      group: 'support_ops',
      kind: 'action',
      description:
        'Resolves an assigned active ticket and records a required resolution note. Guarded: unassigned, stale, or already-resolved tickets fail with a recovery hint instead of mutating state.',
      input: z
        .object({
          ticketId: ticketIdSchema,
          resolution: z.string().trim().min(12).max(280),
          expectedVersion: z.number().int().positive(),
        })
        .strict(),
      output: z.object({
        ticketId: ticketIdSchema,
        status: z.literal('resolved'),
        resolvedBy: supportOwnerSchema,
        noteId: z.string(),
        version: z.number().int().positive(),
      }),
      handler: ({ ticketId, resolution, expectedVersion }) => {
        const ticket = ticketOrThrow(tickets, ticketId)
        if (ticket.status === 'resolved') {
          throw new GenieToolError(`${ticket.id} was already resolved`, {
            code: 'ALREADY_RESOLVED',
            hint: 'no action is needed; inspect another active ticket',
          })
        }
        if (ticket.assignee === null) {
          throw new GenieToolError(`${ticket.id} has no owner`, {
            code: 'OWNER_REQUIRED',
            hint: `assign it first with app_support_assign {"ticketId":"${ticket.id}","owner":"maya","expectedVersion":${ticket.version}}`,
          })
        }
        if (ticket.version !== expectedVersion) {
          throw new GenieToolError(
            `${ticket.id} changed from version ${expectedVersion} to ${ticket.version}`,
            {
              code: 'VERSION_CONFLICT',
              hint: `refresh with app_support_ticket {"ticketId":"${ticket.id}"} before resolving`,
            },
          )
        }
        const noteId = `NOTE-${ticket.notes.length + ticket.version + 1}`
        const nextVersion = ticket.version + 1
        const note: SupportNote = {
          id: noteId,
          body: resolution,
          visibility: 'customer',
          author: ticket.assignee,
          createdAt: new Date().toISOString(),
        }
        setTickets((current) =>
          current.map((candidate) =>
            candidate.id === ticket.id
              ? {
                  ...candidate,
                  status: 'resolved',
                  notes: [...candidate.notes, note],
                  version: nextVersion,
                }
              : candidate,
          ),
        )
        return {
          ticketId: ticket.id,
          status: 'resolved' as const,
          resolvedBy: ticket.assignee,
          noteId,
          version: nextVersion,
        }
      },
    }),
  ]
  useGenieTools(tools)

  const addNoteFromUi = (): void => {
    if (!selectedTicket || noteDraft.trim().length < 5) return
    const note: SupportNote = {
      id: `NOTE-${selectedTicket.notes.length + selectedTicket.version + 1}`,
      body: noteDraft.trim(),
      visibility: 'internal',
      author: 'agent',
      createdAt: new Date().toISOString(),
    }
    setTickets((current) =>
      current.map((ticket) =>
        ticket.id === selectedTicket.id
          ? { ...ticket, notes: [...ticket.notes, note], version: ticket.version + 1 }
          : ticket,
      ),
    )
    setNoteDraft('')
  }

  return (
    <section id="support-desk" aria-labelledby="support-desk-title">
      <header className="support-header">
        <div>
          <span className="support-eyebrow">APP-DEFINED TOOL WORKFLOW</span>
          <h2 id="support-desk-title">Support command center</h2>
          <p>Live queue state shared by this UI and five agent-callable tools.</p>
        </div>
        <span className="support-live">
          <i aria-hidden="true" /> synced
        </span>
      </header>

      <div className="support-metrics" aria-label="Queue summary">
        <div>
          <span>Active</span>
          <strong data-testid="support-active-count">{activeCount}</strong>
        </div>
        <div>
          <span>Urgent</span>
          <strong>{urgentCount}</strong>
        </div>
        <div>
          <span>Unassigned</span>
          <strong>{unassignedCount}</strong>
        </div>
      </div>

      <div className="support-toolbar">
        <div className="support-filters" aria-label="Filter tickets">
          {(['active', ...TICKET_STATUSES] as const).map((status) => (
            <button
              key={status}
              type="button"
              className={statusFilter === status ? 'is-active' : undefined}
              onClick={() => setStatusFilter(status)}
            >
              {status}
            </button>
          ))}
        </div>
        <code>app.support · app.support_ops</code>
      </div>

      <div className="support-workspace">
        <div className="support-queue" aria-label="Support tickets">
          {visibleTickets.map((ticket) => (
            <button
              key={ticket.id}
              type="button"
              className={selectedTicket?.id === ticket.id ? 'support-ticket is-selected' : 'support-ticket'}
              onClick={() => setSelectedId(ticket.id)}
            >
              <span className={`priority-dot priority-${ticket.priority}`} aria-hidden="true" />
              <span className="support-ticket-copy">
                <span>
                  <b>{ticket.id}</b>
                  <small>{ticket.customer.company}</small>
                </span>
                <strong>{ticket.subject}</strong>
                <span>
                  <small>{ticket.assignee ? `@${ticket.assignee}` : 'unassigned'}</small>
                  <small>{ticket.lastReplyMinutes}m ago</small>
                </span>
              </span>
            </button>
          ))}
          {visibleTickets.length === 0 && <p className="support-empty">No tickets match this view.</p>}
        </div>

        {selectedTicket && (
          <article className="support-detail" data-testid="support-ticket-detail">
            <div className="support-detail-topline">
              <span className={`support-priority priority-${selectedTicket.priority}`}>
                {selectedTicket.priority}
              </span>
              <span>{selectedTicket.status}</span>
              <span>v{selectedTicket.version}</span>
            </div>
            <h3>{selectedTicket.subject}</h3>
            <p>{selectedTicket.summary}</p>

            <dl className="support-customer">
              <div>
                <dt>Customer</dt>
                <dd>{selectedTicket.customer.name}</dd>
              </div>
              <div>
                <dt>Plan</dt>
                <dd>{selectedTicket.customer.plan}</dd>
              </div>
              <div>
                <dt>Health</dt>
                <dd>{selectedTicket.customer.health.replace('_', ' ')}</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>{selectedTicket.assignee ? `@${selectedTicket.assignee}` : 'unassigned'}</dd>
              </div>
            </dl>

            <div className="support-tags">
              {selectedTicket.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>

            <label className="support-note">
              <span>Internal handoff note</span>
              <textarea
                value={noteDraft}
                placeholder="Add useful context for the next responder…"
                maxLength={280}
                onChange={(event) => setNoteDraft(event.target.value)}
              />
            </label>
            <div className="support-actions">
              <button type="button" disabled={noteDraft.trim().length < 5} onClick={addNoteFromUi}>
                Add note
              </button>
              <button
                type="button"
                className="support-assign"
                disabled={selectedTicket.status === 'resolved'}
                onClick={() => {
                  setTickets((current) =>
                    current.map((ticket) =>
                      ticket.id === selectedTicket.id
                        ? {
                            ...ticket,
                            assignee: ticket.assignee === 'maya' ? 'omar' : 'maya',
                            version: ticket.version + 1,
                          }
                        : ticket,
                    ),
                  )
                }}
              >
                {selectedTicket.assignee ? 'Rotate owner' : 'Assign Maya'}
              </button>
            </div>
            <p className="support-note-count" aria-live="polite">
              {selectedTicket.notes.length} timeline note
              {selectedTicket.notes.length === 1 ? '' : 's'}
            </p>
          </article>
        )}
      </div>
    </section>
  )
}
