import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui/card'
import { TrendingUp, CheckCircle, XCircle, Activity } from 'lucide-react'

interface RequestLogStats {
  total: number
  success: number
  error: number
  todayTotal: number
  todaySuccess: number
  todayError: number
}

interface RequestLogStatsProps {
  stats: RequestLogStats
}

export function RequestLogStats({ stats }: RequestLogStatsProps) {
  const { t } = useTranslation()
  const successRate = stats.todayTotal > 0 
    ? Math.round((stats.todaySuccess / stats.todayTotal) * 100) 
    : 0

  const statCards = [
    {
      label: t('logs.todayRequests'),
      value: stats.todayTotal,
      icon: TrendingUp,
    },
    {
      label: t('logs.todaySuccess'),
      value: stats.todaySuccess,
      icon: CheckCircle,
    },
    {
      label: t('logs.todayErrors'),
      value: stats.todayError,
      icon: XCircle,
    },
    {
      label: t('dashboard.successRate'),
      value: `${successRate}%`,
      icon: Activity,
    },
  ]

  return (
    <div className="grid grid-cols-4 gap-4">
      {statCards.map((stat, index) => (
        <Card key={index} hover className="p-5">
          <div className="flex items-start justify-between gap-3">
            <p className="stat-label">{stat.label}</p>
            <stat.icon className="h-[15px] w-[15px] shrink-0 text-[var(--text-dim)]" />
          </div>
          <p className="stat-value mt-2">{stat.value}</p>
        </Card>
      ))}
    </div>
  )
}
