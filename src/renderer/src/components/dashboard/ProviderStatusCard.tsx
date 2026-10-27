import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Server } from 'lucide-react'
import type { ProviderStatus } from '@/types/electron'

export interface ProviderStats {
  id: string
  name: string
  status: ProviderStatus
  requestCount: number
  successCount: number
  quotaUsed?: number
  quotaTotal?: number
  latency?: number
}

export interface ProviderStatusCardProps {
  providers: ProviderStats[]
  className?: string
}

export function ProviderStatusCard({ providers, className }: ProviderStatusCardProps) {
  const { t } = useTranslation()

  const statusDot = (status: ProviderStatus) => {
    switch (status) {
      case 'online':
        return 'status-dot-online'
      case 'offline':
        return 'status-dot-offline'
      default:
        return 'bg-[var(--warning)]'
    }
  }

  const statusText = (status: ProviderStatus) => {
    switch (status) {
      case 'online':
        return t('providers.online')
      case 'offline':
        return t('providers.offline')
      default:
        return t('providers.unknown')
    }
  }

  const getSuccessRate = (success: number, total: number) => {
    if (total === 0) return 0
    return Math.round((success / total) * 100)
  }

  return (
    <Card className={cn('flex h-full flex-col p-5', className)}>
      <div className="flex items-center gap-2">
        <Server className="h-[15px] w-[15px] text-[var(--text-muted)]" />
        <h3 className="card-heading">
          {t('dashboard.providerStats')}
        </h3>
      </div>

      {providers.length === 0 ? (
        <div className="empty-state flex-1">
          <div className="empty-state-icon">
            <Server className="h-5 w-5" />
          </div>
          <p className="empty-state-title">{t('providers.noProvidersFound')}</p>
          <p className="empty-state-hint">{t('providers.clickToAddProvider')}</p>
        </div>
      ) : (
        <div className="mt-3 max-h-[420px] space-y-1 overflow-y-auto pr-1">
          {providers.map((provider) => {
            const successRate = getSuccessRate(provider.successCount, provider.requestCount)

            return (
              <div
                key={provider.id}
                className="rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--surface-hover)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn('status-dot shrink-0', statusDot(provider.status))} />
                    <span className="truncate text-label">{provider.name}</span>
                  </div>
                  <span className="shrink-0 text-caption text-[var(--text-dim)]">
                    {statusText(provider.status)}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 pl-4 text-caption">
                  <div>
                    <span className="text-[var(--text-dim)]">{t('dashboard.totalRequests')}</span>
                    <p className="font-medium tabular-nums">
                      {provider.requestCount.toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <span className="text-[var(--text-dim)]">{t('dashboard.successRate')}</span>
                    <p className="font-medium tabular-nums">{successRate}%</p>
                  </div>
                  <div>
                    <span className="text-[var(--text-dim)]">{t('providers.latency')}</span>
                    <p className="font-medium tabular-nums">
                      {provider.latency ? `${provider.latency}ms` : '-'}
                    </p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
