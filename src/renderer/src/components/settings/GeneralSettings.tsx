import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSettingsStore, CloseBehavior, OAuthProxyMode } from '@/stores/settingsStore'

export function GeneralSettings() {
  const { t } = useTranslation()
  const {
    autoStart,
    setAutoStart,
    autoStartProxy,
    setAutoStartProxy,
    minimizeToTray,
    setMinimizeToTray,
    closeBehavior,
    setCloseBehavior,
    enableNotifications,
    setEnableNotifications,
    oauthProxyMode,
    setOauthProxyMode,
  } = useSettingsStore()

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{t('settings.behavior')}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="setting-list">
          <div className="setting-row">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.autoStart')}</p>
              <p className="setting-hint">{t('settings.autoStartHelp')}</p>
            </div>
            <Switch checked={autoStart} onCheckedChange={setAutoStart} />
          </div>

          <div className="setting-row">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.autoStartProxy')}</p>
              <p className="setting-hint">{t('settings.autoStartProxyHelp')}</p>
            </div>
            <Switch checked={autoStartProxy} onCheckedChange={setAutoStartProxy} />
          </div>

          <div className="setting-row">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.minimizeToTray')}</p>
              <p className="setting-hint">{t('settings.minimizeToTrayHelp')}</p>
            </div>
            <Switch checked={minimizeToTray} onCheckedChange={setMinimizeToTray} />
          </div>

          <div className="setting-row setting-row-wrap">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.closeBehavior')}</p>
              <p className="setting-hint">{t('settings.closeBehaviorDesc')}</p>
            </div>
            <Select value={closeBehavior} onValueChange={(value) => setCloseBehavior(value as CloseBehavior)}>
              <SelectTrigger className="h-9 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minimize">{t('settings.closeBehaviorMinimize')}</SelectItem>
                <SelectItem value="close">{t('settings.closeBehaviorClose')}</SelectItem>
                <SelectItem value="ask">{t('settings.closeBehaviorAsk')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="setting-row">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.enableNotifications')}</p>
              <p className="setting-hint">{t('settings.enableNotificationsHelp')}</p>
            </div>
            <Switch checked={enableNotifications} onCheckedChange={setEnableNotifications} />
          </div>

          <div className="setting-row setting-row-wrap">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.oauthProxyMode')}</p>
              <p className="setting-hint">{t('settings.oauthProxyModeHelp')}</p>
            </div>
            <Select value={oauthProxyMode} onValueChange={(value) => setOauthProxyMode(value as OAuthProxyMode)}>
              <SelectTrigger className="h-9 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">{t('settings.oauthProxySystem')}</SelectItem>
                <SelectItem value="none">{t('settings.oauthProxyNone')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
