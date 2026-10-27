import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Sun, Moon, Languages, Play, Pause } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'

const platform = window.electronAPI?.app?.platform
// Windows / Linux render the system caption buttons on top of the header
const hasCaptionOverlay = platform === 'win32' || platform === 'linux'

export function Header() {
  const { t } = useTranslation()
  const { toggleTheme, isDark } = useTheme()
  const { language, setLanguage } = useSettingsStore()
  const navigate = useNavigate()
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false)
  const [port, setPort] = useState(8080)
  const [host, setHost] = useState('127.0.0.1')

  useEffect(() => {
    if (!window.electronAPI?.proxy?.onStatusChanged) return

    const unsubscribe = window.electronAPI.proxy.onStatusChanged((status) => {
      setProxyEnabled(status.isRunning)
      if (status.port) setPort(status.port)
      setHost(status.host || '127.0.0.1')
    })

    window.electronAPI.proxy.getStatus().then((status) => {
      setProxyEnabled(status.isRunning)
      if (status.port) setPort(status.port)
      setHost(status.host || '127.0.0.1')
    })

    window.electronAPI.config?.get?.().then((config) => {
      if (!config) return
      setPort(config.proxyPort || 8080)
      setHost(config.proxyHost || '127.0.0.1')
    })

    const unsubscribeConfig = window.electronAPI.config?.onConfigChanged?.((config) => {
      setPort(config.proxyPort || 8080)
      setHost(config.proxyHost || '127.0.0.1')
    })

    return () => {
      unsubscribe()
      unsubscribeConfig?.()
    }
  }, [])

  const handleToggleProxy = async () => {
    if (proxyLoading) return
    setProxyLoading(true)
    try {
      if (proxyEnabled) {
        await window.electronAPI.proxy.stop()
        setProxyEnabled(false)
      } else {
        await window.electronAPI.proxy.start()
        setProxyEnabled(true)
      }
    } finally {
      setProxyLoading(false)
    }
  }

  const toggleLanguage = () => {
    setLanguage(language === 'zh-CN' ? 'en-US' : 'zh-CN')
  }

  return (
    <header
      className={cn(
        'glass-topbar drag-region flex h-12 shrink-0 items-center justify-between px-4',
        hasCaptionOverlay && 'pr-[138px]'
      )}
    >
      <div className="no-drag flex items-center gap-1.5">
        <span
          className={cn(
            'status-dot',
            proxyLoading
              ? 'animate-pulse bg-[var(--warning)]'
              : proxyEnabled
                ? 'status-dot-online'
                : 'bg-[var(--text-dim)]'
          )}
        />
        <button
          type="button"
          onClick={() => navigate('/proxy')}
          className={cn(
            'rounded-md px-1.5 py-1 font-mono text-meta tabular-nums transition-colors',
            proxyEnabled
              ? 'text-[var(--text-primary)] hover:text-[var(--accent-primary)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
          )}
          title={t('nav.proxy')}
        >
          {host}:{port}
        </button>
        <button
          type="button"
          onClick={handleToggleProxy}
          disabled={proxyLoading}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-50',
            proxyEnabled
              ? 'text-[var(--accent-primary)] hover:bg-[var(--accent-soft-hover)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
          )}
          title={proxyEnabled ? t('proxyStatus.stop') : t('proxyStatus.start')}
        >
          {proxyLoading ? (
            <span className="text-micro leading-none">...</span>
          ) : proxyEnabled ? (
            <Pause className="h-3 w-3" />
          ) : (
            <Play className="h-3 w-3" />
          )}
        </button>
      </div>

      <div className="no-drag flex items-center gap-1">
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          title={isDark ? t('settings.themeLight') : t('settings.themeDark')}
        >
          {isDark ? <Sun className="h-[15px] w-[15px]" /> : <Moon className="h-[15px] w-[15px]" />}
        </button>

        <button
          type="button"
          onClick={toggleLanguage}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          title={language === 'zh-CN' ? t('header.switchToEnglish') : t('header.switchToChinese')}
        >
          <Languages className="h-[15px] w-[15px]" />
        </button>
      </div>
    </header>
  )
}
