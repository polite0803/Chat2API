import { useTranslation } from 'react-i18next'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  MoreVertical,
  Edit,
  Trash2,
  Copy,
  RefreshCw,
  Users,
  Plus,
  LogIn,
  Download,
  Settings,
  Plug,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Provider, ProviderStatus } from '@/types/electron'
import opencodeIcon from '@/assets/providers/opencode.svg'

const providerIcons: Record<string, string> = {
  opencode: opencodeIcon,
}

interface ProviderCardProps {
  provider: Provider
  status?: ProviderStatus
  accountCount: number
  activeAccountCount: number
  onToggle: (id: string, enabled: boolean) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onCheckStatus: (id: string) => void
  onManageAccounts: (id: string) => void
  onUpdateModels?: (id: string) => void
  onManageModels?: (id: string) => void
  className?: string
}

const statusDots: Record<ProviderStatus, string> = {
  online: 'status-dot-online',
  offline: 'status-dot-offline',
  unknown: 'bg-[var(--warning)]',
}

export function ProviderCard({
  provider,
  status,
  accountCount,
  activeAccountCount,
  onToggle,
  onEdit,
  onDelete,
  onDuplicate,
  onCheckStatus,
  onManageAccounts,
  onUpdateModels,
  onManageModels,
  className,
}: ProviderCardProps) {
  const { t } = useTranslation()
  const isBuiltin = provider.type === 'builtin'
  const icon = providerIcons[provider.id]
  // 现场检查的结果优先：provider.status 是上次落库的那份快照，
  // 否则第一次检查记下来的旧值会把后来的新结果一直盖住
  const currentStatus = status || provider.status || 'unknown'

  const statusTexts: Record<ProviderStatus, string> = {
    online: t('providers.online'),
    offline: t('providers.offline'),
    unknown: t('providers.unknown'),
  }

  const getProviderName = () => {
    if (isBuiltin && provider.id) {
      return t(`${provider.id}.name`, { defaultValue: provider.name })
    }
    return provider.name
  }

  const getProviderDescription = () => {
    if (isBuiltin && provider.id) {
      return t(`${provider.id}.description`, { defaultValue: provider.description })
    }
    return provider.description
  }

  return (
    <Card hover className={cn('flex flex-col p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--glass-border)] bg-[var(--surface-hover)]">
            {icon ? (
              <img src={icon} alt={provider.name} className="h-6 w-6 object-contain" />
            ) : (
              <Plug className="h-4 w-4 text-[var(--text-muted)]" />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-subtitle font-semibold">{getProviderName()}</h3>
              {isBuiltin && (
                <span className="badge-soft">
                  {t('providers.builtin')}
                </span>
              )}
            </div>
            <p className="mt-0.5 line-clamp-1 text-meta text-[var(--text-muted)]">
              {getProviderDescription() ||
                `${provider.supportedModels?.length || 0} ${t('providers.models').toLowerCase()}`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <div className="mr-1 flex items-center gap-1.5">
            <span className={cn('status-dot', statusDots[currentStatus])} />
            <span className="text-caption text-[var(--text-muted)]">
              {statusTexts[currentStatus]}
            </span>
          </div>
          <Switch
            checked={provider.enabled}
            onCheckedChange={(checked) => onToggle(provider.id, checked)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onManageAccounts(provider.id)}>
                <Users className="mr-2 h-4 w-4" />
                {t('providers.accountManagement')} ({activeAccountCount}/{accountCount})
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCheckStatus(provider.id)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('providers.checkStatus')}
              </DropdownMenuItem>
              {isBuiltin && (
                <DropdownMenuItem onClick={() => onManageModels?.(provider.id)}>
                  <Settings className="mr-2 h-4 w-4" />
                  {t('providers.manageModels')}
                </DropdownMenuItem>
              )}
              {isBuiltin && provider.supportsModelFetch && (
                <DropdownMenuItem onClick={() => onUpdateModels?.(provider.id)}>
                  <Download className="mr-2 h-4 w-4" />
                  {t('providers.updateModels')}
                </DropdownMenuItem>
              )}
              {!isBuiltin && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onEdit(provider.id)}>
                    <Edit className="mr-2 h-4 w-4" />
                    {t('providers.editProvider')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onDuplicate(provider.id)}>
                    <Copy className="mr-2 h-4 w-4" />
                    {t('providers.duplicateProvider')}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onDelete(provider.id)} className="text-[var(--error)]">
                <Trash2 className="mr-2 h-4 w-4" />
                {t('providers.deleteProvider')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div className="grid flex-1 grid-cols-3 gap-4 text-meta">
          <div className="flex flex-col gap-0.5">
            <span className="text-[var(--text-dim)]">{t('providers.accounts')}</span>
            <span className="font-medium tabular-nums">
              {activeAccountCount} / {accountCount}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[var(--text-dim)]">{t('providers.models')}</span>
            <span className="font-medium tabular-nums">
              {provider.supportedModels?.length || 0}
            </span>
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[var(--text-dim)]">{t('providers.authType')}</span>
            <span className="truncate font-medium">{getAuthTypeLabel(provider.authType)}</span>
          </div>
        </div>

        <Button
          size="sm"
          variant={accountCount === 0 ? 'default' : 'outline'}
          onClick={() => onManageAccounts(provider.id)}
          className="shrink-0"
        >
          {accountCount === 0 ? (
            <>
              <Plus className="h-4 w-4" />
              {t('providers.addAccount')}
            </>
          ) : (
            <>
              <LogIn className="h-4 w-4" />
              {t('providers.accountManagement')}
            </>
          )}
        </Button>
      </div>
    </Card>
  )
}

function getAuthTypeLabel(authType: string): string {
  const labels: Record<string, string> = {
    oauth: 'OAuth',
    token: 'API Key',
    cookie: 'Cookie',
    userToken: 'User Token',
    refresh_token: 'Refresh Token',
    jwt: 'JWT',
    realUserID_token: 'UserID+Token',
    tongyi_sso_ticket: 'SSO Ticket',
  }
  return labels[authType] || authType
}

export default ProviderCard
