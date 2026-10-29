/**
 * Output verbosity steering settings.
 *
 * A separate card from `CompressionSettings` on purpose: that one rewrites
 * request bytes (bounded by prompt-cache economics), this one changes how much
 * the model writes back. A user may want one without the other.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { MessageSquareOff } from 'lucide-react'
import type { OutputSteeringConfig } from '@/types/electron'

const LEVELS = [1, 2, 3] as const

const DEFAULT_CONFIG: OutputSteeringConfig = { enabled: false, level: 2 }

export function OutputSteeringSettings() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [config, setConfig] = useState<OutputSteeringConfig>(DEFAULT_CONFIG)
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    void loadConfig()
  }, [])

  const loadConfig = async () => {
    try {
      const appConfig = await window.electronAPI.config.get()
      if (appConfig?.outputSteering) setConfig(appConfig.outputSteering)
    } catch (error) {
      console.error('Failed to load output steering config:', error)
    }
  }

  const handleChange = (updates: Partial<OutputSteeringConfig>) => {
    setConfig(previous => ({ ...previous, ...updates }))
    setHasChanges(true)
  }

  const saveConfig = async () => {
    try {
      await window.electronAPI.config.update({ outputSteering: config })
      setHasChanges(false)
      toast({ title: t('common.success'), description: t('outputSteering.configSaved') })
    } catch (error) {
      console.error('Failed to save output steering config:', error)
      toast({
        title: t('common.error'),
        description: t('outputSteering.configSaveFailed'),
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquareOff className="h-5 w-5" />
          {t('outputSteering.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg">
          <div className="space-y-0.5">
            <Label htmlFor="output-steering-enabled">{t('outputSteering.enable')}</Label>
            <p className="text-sm text-muted-foreground">{t('outputSteering.enableHint')}</p>
          </div>
          <Switch
            id="output-steering-enabled"
            checked={config.enabled}
            onCheckedChange={checked => handleChange({ enabled: checked })}
          />
        </div>

        {config.enabled && (
          <div className="space-y-3 pt-4 border-t">
            <div className="space-y-0.5">
              <Label>{t('outputSteering.level')}</Label>
              <p className="text-sm text-muted-foreground">{t('outputSteering.levelHint')}</p>
            </div>
            <div className="flex gap-2">
              {LEVELS.map(level => (
                <Button
                  key={level}
                  type="button"
                  variant={config.level === level ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleChange({ level })}
                >
                  {t(`outputSteering.levels.${level}`)}
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
