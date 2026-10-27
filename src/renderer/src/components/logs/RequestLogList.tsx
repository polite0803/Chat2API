import { useState, useEffect, useRef, useCallback, useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { List, type RowComponentProps } from 'react-window'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RequestLogDetail } from './RequestLogDetail'
import { RequestLogStats } from './RequestLogStats'
import { Trash2, FileText } from 'lucide-react'
import type { RequestLogEntry } from '@/types/electron'

interface RequestLogStatsData {
  total: number
  success: number
  error: number
  todayTotal: number
  todaySuccess: number
  todayError: number
}

interface RowProps {
  logs: RequestLogEntry[]
  onSelectLog: (log: RequestLogEntry) => void
}

const ITEM_HEIGHT = 72

function getStatusColor(status: 'success' | 'error', statusCode: number) {
  if (status === 'success') return 'badge-success'
  if (statusCode >= 500) return 'badge-error'
  if (statusCode >= 400) return 'badge-warning'
  return 'badge-error'
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatLatency(ms: number) {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

interface RequestLogListProps {
  highlightId?: string
}

export function RequestLogList({ highlightId }: RequestLogListProps) {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<RequestLogEntry[]>([])
  const [stats, setStats] = useState<RequestLogStatsData | null>(null)
  const [selectedLog, setSelectedLog] = useState<RequestLogEntry | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'error'>('all')
  const [isLoading, setIsLoading] = useState(true)
  const [showClearDialog, setShowClearDialog] = useState(false)
  const logsRef = useRef<RequestLogEntry[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const consumedHighlightRef = useRef<string | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 800, height: 400 })

  const fetchLogs = useCallback(async () => {
    try {
      const filter = statusFilter === 'all' ? {} : { status: statusFilter }
      const result = await window.electronAPI?.requestLogs?.get({ ...filter, limit: 200 })
      if (result) {
        if (JSON.stringify(result) !== JSON.stringify(logsRef.current)) {
          logsRef.current = result
          setLogs(result)
        }
      }
    } catch (error) {
      console.error('Failed to fetch request logs:', error)
    }
  }, [statusFilter])

  const fetchStats = useCallback(async () => {
    try {
      const result = await window.electronAPI?.requestLogs?.getStats()
      if (result) {
        setStats(result)
      }
    } catch (error) {
      console.error('Failed to fetch request log stats:', error)
    }
  }, [])

  const refreshLogs = useCallback(async () => {
    await Promise.all([fetchLogs(), fetchStats()])
  }, [fetchLogs, fetchStats])

  useEffect(() => {
    setIsLoading(true)
    refreshLogs().finally(() => setIsLoading(false))
  }, [refreshLogs])

  useEffect(() => {
    const interval = setInterval(() => {
      refreshLogs().catch((error) => {
        console.error('Failed to refresh request logs:', error)
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [refreshLogs])

  useEffect(() => {
    if (!highlightId || consumedHighlightRef.current === highlightId || logs.length === 0) return
    const target = logs.find(log => log.id === highlightId)
    if (target) {
      setSelectedLog(target)
      consumedHighlightRef.current = highlightId
    }
  }, [highlightId, logs])

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setContainerSize({
          width: containerRef.current.clientWidth,
          height: Math.max(100, Math.min(600, logs.length * ITEM_HEIGHT)),
        })
      }
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [logs.length])

  const handleClearLogs = async () => {
    await window.electronAPI?.requestLogs?.clear()
    logsRef.current = []
    setLogs([])
    fetchStats()
    setShowClearDialog(false)
  }

  const handleSelectLog = useCallback((log: RequestLogEntry) => {
    setSelectedLog(log)
  }, [])

  const RowComponent = useCallback(
    ({ index, style, logs: rowLogs, onSelectLog }: RowComponentProps<RowProps>): ReactElement | null => {
      const log = rowLogs[index]
      if (!log) return null

      return (
        <div
          style={style}
          className="px-2 pb-2"
          onClick={() => onSelectLog(log)}
        >
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 cursor-pointer transition-colors h-[68px]">
            <Badge variant="outline" className={getStatusColor(log.status, log.statusCode)}>
              {log.statusCode}
            </Badge>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm truncate">{log.model}</span>
                {log.actualModel && log.actualModel !== log.model && (
                  <span className="text-xs text-muted-foreground">→ {log.actualModel}</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                <span>{log.providerName || log.providerId}</span>
                {log.accountName && (
                  <>
                    <span>·</span>
                    <span>{log.accountName}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs text-muted-foreground flex-shrink-0">
              <span className="tabular-nums">{formatLatency(log.latency)}</span>
              <span>{formatTime(log.timestamp)}</span>
            </div>
          </div>
        </div>
      )
    },
    []
  )

  const rowProps = useMemo<RowProps>(() => ({
    logs,
    onSelectLog: handleSelectLog,
  }), [logs, handleSelectLog])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold">{t('logs.requestLogs')}</h2>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | 'success' | 'error')}>
            <SelectTrigger className="w-32">
              <SelectValue placeholder={t('logs.filter')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('logs.all')}</SelectItem>
              <SelectItem value="success">{t('common.success')}</SelectItem>
              <SelectItem value="error">{t('common.error')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refreshLogs}>
            {t('dashboard.refresh')}
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setShowClearDialog(true)}>
            {t('logs.clearLogs')}
          </Button>
        </div>
      </div>

      {stats && <RequestLogStats stats={stats} />}

      <div ref={containerRef} className="flex-1 mt-4">
        {isLoading ? (
          <div className="flex h-32 items-center justify-center text-[var(--text-muted)]">
            {t('common.loading')}
          </div>
        ) : logs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <FileText className="h-5 w-5" />
            </div>
            <p className="empty-state-title">{t('logs.noRequestLogs')}</p>
            <p className="empty-state-hint">{t('logs.noRequestLogsHint')}</p>
          </div>
        ) : (
          <List
            rowComponent={RowComponent}
            rowCount={logs.length}
            rowHeight={ITEM_HEIGHT}
            rowProps={rowProps}
            style={{
              width: containerSize.width,
              height: containerSize.height,
            }}
            className="scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
          />
        )}
      </div>

      {selectedLog && (
        <RequestLogDetail log={selectedLog} onClose={() => setSelectedLog(null)} />
      )}

      <Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-full bg-destructive/10 flex items-center justify-center">
                <Trash2 className="h-4 w-4 text-destructive" />
              </div>
              {t('logs.clearConfirm')}
            </DialogTitle>
            <DialogDescription>
              {t('logs.clearConfirmDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClearDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleClearLogs}>
              {t('logs.clearLogs')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
