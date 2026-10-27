/**
 * Provider filter bar: search, type and status. Kept intentionally flat -
 * add/refresh actions live in the page header.
 */

import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Search, X } from 'lucide-react'
import type { ProviderStatus, ProviderType } from '@/types/electron'
import { cn } from '@/lib/utils'

export type FilterType = 'all' | ProviderType | 'enabled' | 'disabled'
export type StatusFilter = 'all' | ProviderStatus

interface ProviderFilterProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  typeFilter: FilterType
  onTypeFilterChange: (filter: FilterType) => void
  statusFilter: StatusFilter
  onStatusFilterChange: (filter: StatusFilter) => void
  stats?: {
    total: number
    builtin: number
    custom: number
    enabled: number
    online: number
  }
}

export function ProviderFilter({
  searchQuery,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  statusFilter,
  onStatusFilterChange,
  stats,
}: ProviderFilterProps) {
  const { t } = useTranslation()

  const typeFilterOptions: { value: FilterType; labelKey: string }[] = [
    { value: 'all', labelKey: 'providers.allTypes' },
    { value: 'builtin', labelKey: 'providers.builtin' },
    { value: 'custom', labelKey: 'providers.custom' },
    { value: 'enabled', labelKey: 'providers.enabledOnly' },
    { value: 'disabled', labelKey: 'providers.disabledOnly' },
  ]

  const statusFilterOptions: { value: StatusFilter; labelKey: string; dot: string }[] = [
    { value: 'all', labelKey: 'providers.allStatus', dot: 'bg-[var(--text-dim)]' },
    { value: 'online', labelKey: 'providers.online', dot: 'bg-[var(--success)]' },
    { value: 'offline', labelKey: 'providers.offline', dot: 'bg-[var(--error)]' },
    { value: 'unknown', labelKey: 'providers.unknown', dot: 'bg-[var(--warning)]' },
  ]

  const hasActiveFilters =
    typeFilter !== 'all' || statusFilter !== 'all' || searchQuery !== ''

  const handleClearFilters = () => {
    onSearchChange('')
    onTypeFilterChange('all')
    onStatusFilterChange('all')
  }

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-dim)]" />
          <Input
            placeholder={t('providers.searchProviders')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 pr-9"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-0.5 top-1/2 h-8 w-8 -translate-y-1/2"
              onClick={() => onSearchChange('')}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Select value={typeFilter} onValueChange={(v) => onTypeFilterChange(v as FilterType)}>
            <SelectTrigger className="h-9 w-[140px] text-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {typeFilterOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={statusFilter}
            onValueChange={(v) => onStatusFilterChange(v as StatusFilter)}
          >
            <SelectTrigger className="h-9 w-[130px] text-body">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {statusFilterOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <span className="flex items-center gap-2">
                    <span className={cn('h-2 w-2 rounded-full', option.dot)} />
                    {t(option.labelKey)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={handleClearFilters}>
              {t('common.reset')}
            </Button>
          )}
        </div>
      </div>

      {stats && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-[var(--text-muted)]">
          <span>
            {t('providers.total')} {stats.total}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="status-dot status-dot-online" />
            {stats.online} {t('providers.onlineCount')}
          </span>
          <span>
            {stats.enabled} {t('providers.enabled')}
          </span>
          <span>
            {stats.builtin} {t('providers.builtin')} · {stats.custom} {t('providers.custom')}
          </span>
        </div>
      )}
    </div>
  )
}

export default ProviderFilter
