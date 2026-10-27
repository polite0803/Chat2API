import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTheme } from '@/hooks/useTheme'
import { useSettingsStore, Theme, Language } from '@/stores/settingsStore'
import { Sun, Moon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

const THEME_OPTIONS = [
  { value: 'light', labelKey: 'settings.themeLight', icon: Sun },
  { value: 'dark', labelKey: 'settings.themeDark', icon: Moon },
] as const

export function AppearanceSettings() {
  const { t } = useTranslation()
  const { theme, setTheme, isDark } = useTheme()
  const { sidebarCollapsed, setSidebarCollapsed, language, setLanguage } = useSettingsStore()

  // When the user follows the system theme, show the theme that is actually active
  const resolvedTheme: Theme = theme === 'system' ? (isDark ? 'dark' : 'light') : theme

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>{t('settings.appearance')}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="setting-list">
          <div className="setting-row setting-row-wrap">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.theme')}</p>
              <p className="setting-hint">{t('settings.themeSettingsDesc')}</p>
            </div>
            <div className="flex gap-1 rounded-lg bg-[var(--segment-track)] p-1">
              {THEME_OPTIONS.map(({ value, labelKey, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTheme(value as Theme)}
                  aria-pressed={resolvedTheme === value}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-meta font-medium transition-colors',
                    resolvedTheme === value
                      ? 'bg-[var(--segment-thumb)] text-[var(--text-primary)] shadow-sm'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div className="setting-row setting-row-wrap">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.language')}</p>
              <p className="setting-hint">{t('settings.languageSettingsDesc')}</p>
            </div>
            <Select value={language} onValueChange={(value) => setLanguage(value as Language)}>
              <SelectTrigger className="h-9 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh-CN">{t('settings.languageZh')}</SelectItem>
                <SelectItem value="en-US">{t('settings.languageEn')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="setting-row">
            <div className="space-y-0.5">
              <p className="setting-label">{t('settings.sidebarCollapsed')}</p>
              <p className="setting-hint">{t('settings.sidebarCollapsedHelp')}</p>
            </div>
            <Switch checked={sidebarCollapsed} onCheckedChange={setSidebarCollapsed} />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
