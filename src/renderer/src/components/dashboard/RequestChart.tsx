import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Activity } from 'lucide-react'

export interface ChartDataPoint {
  time: string
  requests: number
  success: number
  failed: number
}

export interface RequestChartProps {
  data: ChartDataPoint[]
  className?: string
}

const CHART_WIDTH = 640
const CHART_HEIGHT = 260
const CHART_PADDING = {
  top: 18,
  right: 18,
  bottom: 38,
  left: 44,
}

export function RequestChart({ data, className }: RequestChartProps) {
  const { t } = useTranslation()
  const series = useMemo(() => [
    { key: 'requests' as const, label: t('dashboard.totalRequests'), color: 'hsl(var(--primary))' },
    { key: 'success' as const, label: t('common.success'), color: 'hsl(142, 76%, 36%)' },
    { key: 'failed' as const, label: t('common.error'), color: 'hsl(0, 84%, 60%)' },
  ], [t])

  const chart = useMemo(() => {
    const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right
    const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom
    const maxValue = Math.max(1, ...data.flatMap(point => [point.requests, point.success, point.failed]))
    const yTicks = [maxValue, Math.ceil(maxValue / 2), 0]
    const xStep = data.length > 1 ? plotWidth / (data.length - 1) : 0
    const labelEvery = Math.max(1, Math.ceil(data.length / 6))

    const x = (index: number) => CHART_PADDING.left + index * xStep
    const y = (value: number) => CHART_PADDING.top + (1 - value / maxValue) * plotHeight
    const pathFor = (key: keyof Pick<ChartDataPoint, 'requests' | 'success' | 'failed'>) =>
      data
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(2)} ${y(point[key]).toFixed(2)}`)
        .join(' ')

    return { plotWidth, plotHeight, maxValue, yTicks, labelEvery, x, y, pathFor }
  }, [data])

  return (
    <Card className={cn('', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-[15px] w-[15px] text-[var(--text-muted)]" />
          {t('dashboard.requestsTrend')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[240px] w-full">
          {data.length === 0 ? (
            <div className="empty-state h-full">
              <div className="empty-state-icon">
                <Activity className="h-5 w-5" />
              </div>
              <p className="empty-state-title">{t('common.noData')}</p>
              <p className="empty-state-hint">
                {t('dashboard.chartEmptyHint', { defaultValue: '' })}
              </p>
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              className="h-full w-full overflow-visible"
              role="img"
              aria-label={t('dashboard.requestsTrend')}
            >
              {chart.yTicks.map(tick => (
                <g key={tick}>
                  <line
                    x1={CHART_PADDING.left}
                    x2={CHART_WIDTH - CHART_PADDING.right}
                    y1={chart.y(tick)}
                    y2={chart.y(tick)}
                    stroke="hsl(var(--border))"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={CHART_PADDING.left - 10}
                    y={chart.y(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-[var(--text-muted)] text-caption"
                  >
                    {tick}
                  </text>
                </g>
              ))}

              {data.map((point, index) => (
                index % chart.labelEvery === 0 || index === data.length - 1 ? (
                  <text
                    key={`${point.time}-${index}`}
                    x={chart.x(index)}
                    y={CHART_HEIGHT - 10}
                    textAnchor="middle"
                    className="fill-[var(--text-muted)] text-caption"
                  >
                    {point.time}
                  </text>
                ) : null
              ))}

              {series.map(item => (
                <path
                  key={item.key}
                  d={chart.pathFor(item.key)}
                  fill="none"
                  stroke={item.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </svg>
          )}
        </div>

        {data.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-caption text-[var(--text-muted)]">
            {series.map(item => (
              <div key={item.key} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
