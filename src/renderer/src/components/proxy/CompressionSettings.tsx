/**
 * Context compression settings.
 *
 * Only two controls by design (review decision 4): a master switch and a
 * strength dial. Everything else is a fixed constant in the compressor, so there
 * is no knob here that silently does nothing.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { Minimize2 } from 'lucide-react'
import type { CompressionConfig } from '@/types/electron'

const AGGRESSIVENESS = ['conservative', 'moderate', 'aggressive'] as const

const DEFAULT_CONFIG: CompressionConfig = { enabled: false, aggressiveness: 'moderate' }

export function CompressionSettings() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [config, setConfig] = useState<CompressionConfig>(DEFAULT_CONFIG)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    void loadConfig()
  }, [])

  const loadConfig = async () => {
    try {
      const appConfig = await window.electronAPI.config.get()
      if (appConfig?.compression) setConfig(appConfig.compression)
    } catch (error) {
      console.error('Failed to load compression config:', error)
    }
  }

  const handleChange = (updates: Partial<CompressionConfig>) => {
    setConfig(previous => ({ ...previous, ...updates }))
    setHasChanges(true)
  }

  const saveConfig = async () => {
    try {
      await window.electronAPI.config.update({ compression: config })
      setHasChanges(false)
      toast({ title: t('common.success'), description: t('compression.configSaved') })
    } catch (error) {
      console.error('Failed to save compression config:', error)
      toast({
        title: t('common.error'),
        description: t('compression.configSaveFailed'),
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Minimize2 className="h-5 w-5" />
          {t('compression.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg">
          <div className="space-y-0.5">
            <Label htmlFor="compression-enabled">{t('compression.enable')}</Label>
            <p className="text-sm text-muted-foreground">{t('compression.enableHint')}</p>
          </div>
          <Switch
            id="compression-enabled"
            checked={config.enabled}
            onCheckedChange={checked => handleChange({ enabled: checked })}
          />
        </div>

        {config.enabled && (
          <div className="space-y-3 pt-4 border-t">
            <div className="space-y-0.5">
              <Label htmlFor="compression-aggressiveness">{t('compression.aggressiveness')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('compression.aggressivenessHint')}
              </p>
            </div>
            <div className="flex gap-2">
              {AGGRESSIVENESS.map(level => (
                <Button
                  key={level}
                  type="button"
                  variant={config.aggressiveness === level ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleChange({ aggressiveness: level })}
                >
                  {t(`compression.level.${level}`)}
                </Button>
              ))}
            </div>
          </div>
        )}

        {hasChanges && (
          <div className="flex justify-end">
            <Button onClick={() => void saveConfig()}>{t('common.save')}</Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
