import { useState, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { useWorkflowStore } from '../stores/workflowStore'
import WorkflowProgressBar from '../components/workflow/WorkflowProgressBar'
import ApprovalActions from '../components/workflow/ApprovalActions'
import WorkflowRunViewer from '../components/workflow/WorkflowRunViewer'
import type { WorkflowRun, Workflow } from '../types/workflow'
import {
  Plus, Search, ChevronLeft, ChevronRight,
  X, MessageSquare, ArrowRight,
} from 'lucide-react'

interface TicketRecord {
  id: string
  ticket_number: string
  title: string
  status: string
  priority: string
  ticket_type: string
  description: string
  creator_name: string | null
  assignee_name: string | null
  created_by: string
  assigned_to: string | null
  tags: string[]
  workflow_run_id: string | null
  current_stage_id: string | null
  created_at: string
  updated_at: string
}

interface TicketComment {
  id: string
  body: string
  author_name: string | null
  author_id: string
  parent_id: string | null
  created_at: string
}

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280',
  submitted: '#3b82f6',
  in_review: '#f59e0b',
  approved: '#10b981',
  rejected: '#ef4444',
  in_progress: '#8b5cf6',
  paused: '#f59e0b',
  completed: '#10b981',
  closed: '#6b7280',
  cancelled: '#6b7280',
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f59e0b',
  medium: '#3b82f6',
  low: '#6b7280',
}

const TRANSITIONS: Record<string, { action: string; label: string }[]> = {
  draft: [{ action: 'submit', label: 'SUBMIT' }],
  submitted: [
    { action: 'review', label: 'START REVIEW' },
    { action: 'reject', label: 'REJECT' },
  ],
  in_review: [
    { action: 'approve', label: 'APPROVE' },
    { action: 'reject', label: 'REJECT' },
  ],
  approved: [{ action: 'start', label: 'START WORK' }],
  in_progress: [
    { action: 'pause', label: 'PAUSE' },
    { action: 'complete', label: 'COMPLETE' },
  ],
  paused: [{ action: 'resume', label: 'RESUME' }],
  completed: [{ action: 'close', label: 'CLOSE' }],
}

export default function TicketsPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  const [tickets, setTickets] = useState<TicketRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)

  // Detail / Create modal state
  const [selectedTicket, setSelectedTicket] = useState<TicketRecord | null>(null)
  const [comments, setComments] = useState<TicketComment[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [newComment, setNewComment] = useState('')

  // Workflow state for selected ticket
  const [workflowRun, setWorkflowRun] = useState<WorkflowRun | null>(null)
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const { fetchWorkflowRun } = useWorkflowStore()

  // Create form
  const [createTitle, setCreateTitle] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createPriority, setCreatePriority] = useState('medium')

  const limit = 20

  const fetchTickets = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(limit))
      params.set('sort', 'created_at')
      params.set('order', 'desc')
      if (statusFilter) params.set('status', statusFilter)
      if (priorityFilter) params.set('priority', priorityFilter)
      if (searchQuery) params.set('search', searchQuery)

      const data = await apiFetch<{ data: TicketRecord[]; pagination: { total: number } }>(
        `/tickets?${params.toString()}`
      )
      setTickets(data.data)
      setTotal(data.pagination.total)
    } catch {
      setTickets([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, priorityFilter, searchQuery])

  useEffect(() => {
    fetchTickets()
  }, [fetchTickets])

  const fetchComments = async (ticketId: string) => {
    try {
      const data = await apiFetch<{ data: TicketComment[] }>(`/tickets/${ticketId}/comments`)
      setComments(data.data)
    } catch {
      setComments([])
    }
  }

  const fetchTicketWorkflow = async (ticket: TicketRecord) => {
    if (ticket.workflow_run_id) {
      try {
        const run = await fetchWorkflowRun(ticket.workflow_run_id)
        setWorkflowRun(run)
        if (run) {
          const wf = await apiFetch<Workflow>(`/workflows/${run.workflow_id}`)
          setWorkflow(wf)
        }
      } catch {
        setWorkflowRun(null)
        setWorkflow(null)
      }
    } else {
      setWorkflowRun(null)
      setWorkflow(null)
    }
  }

  const openDetail = async (ticket: TicketRecord) => {
    setSelectedTicket(ticket)
    setShowCreate(false)
    await Promise.all([
      fetchComments(ticket.id),
      fetchTicketWorkflow(ticket),
    ])
  }

  const refreshTicketWorkflow = async () => {
    if (selectedTicket?.workflow_run_id) {
      const run = await fetchWorkflowRun(selectedTicket.workflow_run_id)
      setWorkflowRun(run)
    }
    // Also refresh the ticket itself
    if (selectedTicket) {
      try {
        const data = await apiFetch<{ data: TicketRecord }>(`/tickets/${selectedTicket.id}`)
        setSelectedTicket(data.data)
      } catch { /* ignore */ }
    }
    fetchTickets()
  }

  const handleTransition = async (ticketId: string, action: string) => {
    await apiFetch(`/tickets/${ticketId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    })
    const data = await apiFetch<{ data: TicketRecord }>(`/tickets/${ticketId}`)
    setSelectedTicket(data.data)
    // Refetch workflow if ticket was submitted (workflow may have been auto-created)
    await fetchTicketWorkflow(data.data)
    fetchTickets()
  }

  const handleAddComment = async () => {
    if (!selectedTicket || !newComment.trim()) return
    await apiFetch(`/tickets/${selectedTicket.id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: newComment }),
    })
    setNewComment('')
    await fetchComments(selectedTicket.id)
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createTitle.trim()) return
    await apiFetch('/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: createTitle,
        description: createDesc,
        priority: createPriority,
      }),
    })
    setCreateTitle('')
    setCreateDesc('')
    setCreatePriority('medium')
    setShowCreate(false)
    fetchTickets()
  }

  const isWorkflowManaged = !!(workflowRun && workflowRun.status === 'active')
  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <>
      <div className="tickets-layout">
          {/* Toolbar */}
          <div className="tickets-toolbar">
            <div className="toolbar-left">
              <h1 className="page-title">TICKETS</h1>
              <span className="ticket-count">{total} total</span>
            </div>
            <div className="toolbar-right">
              <div className="filter-group">
                <select
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value); setPage(1); setSearchParams(e.target.value ? { status: e.target.value } : {}); }}
                  className="filter-select"
                >
                  <option value="">All Status</option>
                  {Object.keys(STATUS_COLORS).map((s) => (
                    <option key={s} value={s}>{s.replace('_', ' ').toUpperCase()}</option>
                  ))}
                </select>
                <select
                  value={priorityFilter}
                  onChange={(e) => { setPriorityFilter(e.target.value); setPage(1); }}
                  className="filter-select"
                >
                  <option value="">All Priority</option>
                  {Object.keys(PRIORITY_COLORS).map((p) => (
                    <option key={p} value={p}>{p.toUpperCase()}</option>
                  ))}
                </select>
                <div className="search-box">
                  <Search size={14} />
                  <input
                    type="text"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
                    className="search-input"
                  />
                </div>
              </div>
              <button onClick={() => { setShowCreate(true); setSelectedTicket(null); }} className="create-btn">
                <Plus size={14} />
                NEW TICKET
              </button>
            </div>
          </div>

          {/* Table */}
          <div className="tickets-table-wrap">
            <table className="tickets-table">
              <thead>
                <tr>
                  <th>NUMBER</th>
                  <th>TITLE</th>
                  <th>STATUS</th>
                  <th>PRIORITY</th>
                  <th>CREATOR</th>
                  <th>ASSIGNEE</th>
                  <th>CREATED</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="table-empty">Loading...</td></tr>
                ) : tickets.length === 0 ? (
                  <tr><td colSpan={7} className="table-empty">No tickets found</td></tr>
                ) : (
                  tickets.map((t) => (
                    <tr key={t.id} onClick={() => openDetail(t)} className="ticket-row">
                      <td className="mono-cell">{t.ticket_number}</td>
                      <td className="title-cell">{t.title}</td>
                      <td>
                        <span className="status-badge" style={{ borderColor: STATUS_COLORS[t.status] || '#6b7280', color: STATUS_COLORS[t.status] || '#6b7280' }}>
                          {t.status.replace('_', ' ').toUpperCase()}
                        </span>
                      </td>
                      <td>
                        <span className="priority-dot" style={{ backgroundColor: PRIORITY_COLORS[t.priority] || '#6b7280' }} />
                        {t.priority.toUpperCase()}
                      </td>
                      <td>{t.creator_name || '—'}</td>
                      <td>{t.assignee_name || '—'}</td>
                      <td className="mono-cell">{new Date(t.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="pagination">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="page-btn">
                <ChevronLeft size={14} />
              </button>
              <span className="page-info">PAGE {page} OF {totalPages}</span>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="page-btn">
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Side Panel: Detail or Create */}
        {(selectedTicket || showCreate) && (
          <div className="side-panel">
            <button className="panel-close" onClick={() => { setSelectedTicket(null); setShowCreate(false); setWorkflowRun(null); setWorkflow(null); }}>
              <X size={16} />
            </button>

            {showCreate ? (
              <div className="panel-content">
                <h2 className="panel-title">NEW TICKET</h2>
                <form onSubmit={handleCreate} className="create-form">
                  <div className="form-group">
                    <label className="form-label">TITLE</label>
                    <input
                      type="text"
                      value={createTitle}
                      onChange={(e) => setCreateTitle(e.target.value)}
                      className="form-input"
                      placeholder="Ticket title"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">DESCRIPTION</label>
                    <textarea
                      value={createDesc}
                      onChange={(e) => setCreateDesc(e.target.value)}
                      className="form-input form-textarea"
                      placeholder="Describe the task..."
                      rows={4}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">PRIORITY</label>
                    <select value={createPriority} onChange={(e) => setCreatePriority(e.target.value)} className="form-input">
                      <option value="low">LOW</option>
                      <option value="medium">MEDIUM</option>
                      <option value="high">HIGH</option>
                      <option value="critical">CRITICAL</option>
                    </select>
                  </div>
                  <button type="submit" className="submit-btn">CREATE TICKET</button>
                </form>
              </div>
            ) : selectedTicket ? (
              <div className="panel-content">
                <span className="mono-cell panel-ticket-number">{selectedTicket.ticket_number}</span>
                <h2 className="panel-title">{selectedTicket.title}</h2>

                {/* Workflow Progress Bar */}
                {workflow && workflowRun && (
                  <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--color-border)' }}>
                    <WorkflowProgressBar
                      stages={workflow.stages}
                      currentStageId={workflowRun.current_stage_id}
                      status={workflowRun.status}
                    />
                  </div>
                )}

                {/* Workflow Approval Actions (replaces manual transitions when active) */}
                {isWorkflowManaged && workflowRun && (
                  <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--color-border)' }}>
                    <ApprovalActions
                      run={workflowRun}
                      transitions={workflow?.transitions ?? []}
                      onAction={refreshTicketWorkflow}
                    />
                  </div>
                )}

                <div className="detail-meta">
                  <div className="meta-row">
                    <span className="meta-label">STATUS</span>
                    <span className="status-badge" style={{ borderColor: STATUS_COLORS[selectedTicket.status], color: STATUS_COLORS[selectedTicket.status] }}>
                      {selectedTicket.status.replace('_', ' ').toUpperCase()}
                    </span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">PRIORITY</span>
                    <span>
                      <span className="priority-dot" style={{ backgroundColor: PRIORITY_COLORS[selectedTicket.priority] }} />
                      {selectedTicket.priority.toUpperCase()}
                    </span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">CREATOR</span>
                    <span>{selectedTicket.creator_name || '—'}</span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">ASSIGNEE</span>
                    <span>{selectedTicket.assignee_name || 'Unassigned'}</span>
                  </div>
                </div>

                {selectedTicket.description && (
                  <div className="detail-description">
                    <h3 className="detail-section-title">DESCRIPTION</h3>
                    <p>{selectedTicket.description}</p>
                  </div>
                )}

                {/* Transition Buttons (hidden when workflow is managing approvals) */}
                {!isWorkflowManaged && TRANSITIONS[selectedTicket.status] && (
                  <div className="transition-actions">
                    {TRANSITIONS[selectedTicket.status].map((t) => (
                      <button
                        key={t.action}
                        onClick={() => handleTransition(selectedTicket.id, t.action)}
                        className={`transition-btn ${t.action === 'reject' || t.action === 'cancel' ? 'danger' : ''}`}
                      >
                        <ArrowRight size={12} />
                        {t.label}
                      </button>
                    ))}
                    {selectedTicket.status !== 'closed' && selectedTicket.status !== 'cancelled' && (
                      <button
                        onClick={() => handleTransition(selectedTicket.id, 'cancel')}
                        className="transition-btn danger"
                      >
                        <X size={12} />
                        CANCEL
                      </button>
                    )}
                  </div>
                )}

                {/* Workflow Run History */}
                {workflowRun && (
                  <div style={{ marginBottom: 16 }}>
                    <WorkflowRunViewer runId={workflowRun.id} history={workflowRun.history} />
                  </div>
                )}

                {/* Comments */}
                <div className="comments-section">
                  <h3 className="detail-section-title">
                    <MessageSquare size={14} />
                    COMMENTS ({comments.length})
                  </h3>
                  <div className="comments-list">
                    {comments.map((c) => (
                      <div key={c.id} className="comment-item">
                        <div className="comment-header">
                          <span className="comment-author">{c.author_name || 'Unknown'}</span>
                          <span className="comment-date">{new Date(c.created_at).toLocaleString()}</span>
                        </div>
                        <p className="comment-body">{c.body}</p>
                      </div>
                    ))}
                  </div>
                  <div className="comment-form">
                    <textarea
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      className="form-input form-textarea"
                      placeholder="Add a comment..."
                      rows={2}
                    />
                    <button onClick={handleAddComment} className="submit-btn" disabled={!newComment.trim()}>
                      POST
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        )}
    </>
  )
}
