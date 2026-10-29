import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface StatsCardProps {
  title: string
  value: string | number
  icon: LucideIcon
  trend?: {
    /** `null` means the comparison has no data behind it, which is not the same as 0%. */
    value: number | null
    label?: string
  }
  /** Use "negative" when a rising value is bad (e.g. latency). */
  trendPolarity?: 'positive' | 'negative'
  className?: string
}

export function StatsCard({
  title,
  value,
  icon: Icon,
  trend,
  trendPolarity = 'positive',
  className,
}: StatsCardProps) {
  const { t } = useTranslation()

  const getTrendIcon = () => {
    if (!trend || trend.value === null) return null
    if (trend.value > 0) return <TrendingUp className="h-3 w-3" />
    if (trend.value < 0) return <TrendingDown className="h-3 w-3" />
    return <Minus className="h-3 w-3" />
  }

  const getTrendColor = () => {
    if (!trend || trend.value === null || trend.value === 0) return 'text-[var(--text-muted)]'
    const isGood = trendPolarity === 'negative' ? trend.value < 0 : trend.value > 0
    return isGood ? 'text-[var(--success)]' : 'text-[var(--error)]'
  }

  return (
    <Card hover className={cn('p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="stat-label">{title}</p>
        <Icon className="h-[15px] w-[15px] shrink-0 text-[var(--text-dim)]" />
      </div>
      <p className="stat-value mt-2">{value}</p>
      <div className={cn('mt-1.5 flex items-center gap-1 text-meta', getTrendColor())}>
        {trend && (
          trend.value === null ? (
            <span className="text-[var(--text-dim)]">{t('dashboard.trendUnavailable')}</span>
          ) : (
            <>
              {getTrendIcon()}
              <span className="tabular-nums">
                {trend.value > 0 ? '+' : ''}
                {trend.value}%
              </span>
            </>
          )
        )}
        {trend?.label && (
          <span className="ml-1 text-[var(--text-dim)]">{trend.label}</span>
        )}
      </div>
    </Card>
  )
}
