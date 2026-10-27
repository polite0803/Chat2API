import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

interface PageHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
  onBack?: () => void
  backLabel?: string
}

/**
 * Single, consistent header for every page: title + description + actions.
 * Optional back affordance for drilled-in views (provider accounts, details).
 */
export function PageHeader({
  title,
  description,
  actions,
  onBack,
  backLabel,
}: PageHeaderProps) {
  return (
    <header className="mb-5 space-y-3">
      {onBack && (
        <button type="button" className="page-back" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
          <span>{backLabel}</span>
        </button>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="page-title truncate">{title}</h1>
          {description && <p className="page-description max-w-2xl">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
