import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { RequestLogList } from '@/components/logs'

export default function LogsPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const highlightId = searchParams.get('highlight') || undefined

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('logs.pageTitle')}</h1>
          <p className="text-muted-foreground">{t('logs.pageDescription')}</p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <RequestLogList highlightId={highlightId} />
        </CardContent>
      </Card>
    </div>
  )
}
