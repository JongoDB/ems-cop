import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { CheckCircle, XCircle, Circle, Loader } from 'lucide-react'

interface PlaybookStage {
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
}

interface PlaybookExecution {
  id: string
  playbook_id: string
  stages: PlaybookStage[]
  status: string
  started_at: string
  completed_at?: string | null
}

interface PlaybookProgressProps {
  executionId: string
  className?: string
}

const STATUS_ICON: Record<string, typeof Circle> = {
  pending: Circle,
  running: Loader,
  completed: CheckCircle,
  failed: XCircle,
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#6b7280',
  running: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
}

export default function PlaybookProgress({ executionId, className = '' }: PlaybookProgressProps) {
  const [execution, setExecution] = useState<PlaybookExecution | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchExecution = useCallback(async () => {
    try {
      const data = await apiFetch<PlaybookExecution>(
        `/c2/containment/playbook-executions/${executionId}`
      )
      setExecution(data)
    } catch {
      setExecution(null)
    } finally {
      setLoading(false)
    }
  }, [executionId])

  useEffect(() => {
    fetchExecution()
    const interval = setInterval(fetchExecution, 5000)
    return () => clearInterval(interval)
  }, [fetchExecution])

  if (loading) {
    return (
      <div className={className} style={{ color: 'var(--color-text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
        Loading playbook...
      </div>
    )
  }

  if (!execution) {
    return (
      <div className={className} style={{ color: 'var(--color-text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
        Playbook execution not found
      </div>
    )
  }

  const stages = execution.stages || []

  return (
    <div className={className}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        overflowX: 'auto',
        padding: '8px 0',
      }}>
        {stages.map((stage, index) => {
          const Icon = STATUS_ICON[stage.status] || Circle
          const color = STATUS_COLORS[stage.status] || '#6b7280'
          const isRunning = stage.status === 'running'

          return (
            <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 4,
                  minWidth: 72,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    borderRadius: '50%',
                    border: `2px solid ${color}`,
                    background: stage.status === 'completed' ? color : 'transparent',
                    animation: isRunning ? 'pulse 2s infinite' : undefined,
                  }}
                >
                  <Icon
                    size={14}
                    style={{
                      color: stage.status === 'completed' ? '#fff' : color,
                      animation: isRunning ? 'spin 1s linear infinite' : undefined,
                    }}
                  />
                </div>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: color,
                  fontWeight: stage.status === 'running' ? 700 : 400,
                  letterSpacing: 0.5,
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                }}>
                  {stage.name}
                </span>
              </div>
              {index < stages.length - 1 && (
                <div
                  style={{
                    width: 24,
                    height: 2,
                    background: stage.status === 'completed' ? '#22c55e' : 'var(--color-border)',
                    flexShrink: 0,
                    marginBottom: 20,
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
