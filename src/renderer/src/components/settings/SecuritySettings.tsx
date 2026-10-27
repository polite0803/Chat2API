import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/stores/settingsStore'

export function SecuritySettings() {
  const { t } = useTranslation()
  const { credentialEncryption, setCredentialEncryption, logDesensitization, setLogDesensitization } =
    useSettingsStore()

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{t('settings.security')}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="setting-list">
          <div className="setting-row">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.credentialEncryption')}</p>
              <p className="setting-hint">{t('settings.credentialEncryptionHelp')}</p>
            </div>
            <Switch checked={credentialEncryption} onCheckedChange={setCredentialEncryption} />
          </div>

          <div className="setting-row">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.logDesensitization')}</p>
              <p className="setting-hint">{t('settings.logDesensitizationHelp')}</p>
            </div>
            <Switch checked={logDesensitization} onCheckedChange={setLogDesensitization} />
          </div>

          <div className="p-5">
            <p className="text-meta font-medium text-[var(--text-muted)]">{t('settings.example')}</p>
            <div className="mt-2 space-y-1 font-mono text-meta text-[var(--text-dim)]">
              <p>sk-1234567890abcdef1234567890abcdef</p>
              <p>sk-1234****cdef</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
