import { useState, useMemo, useCallback, memo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useProvidersStore } from '@/stores/providersStore'
import { useProxyStore } from '@/stores/proxyStore'
import { useToast } from '@/hooks/use-toast'
import { Search, Copy, CheckCircle2, XCircle, Cpu, Check, Square, Database, ChevronLeft, ChevronRight, Loader2, Stethoscope } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Account, EffectiveModel } from '@/types/electron'
import opencodeIcon from '@/assets/providers/opencode.svg'
import modelMappingIcon from '@/assets/providers/model-mapping.svg'

const providerIcons: Record<string, string> = {
  opencode: opencodeIcon,
  mapping: modelMappingIcon,
}

interface ModelInfo {
  id: string
  name: string
  providerId: string
  providerName: string
  accountId?: string
  accountName?: string
  status: 'available' | 'unavailable'
  /** OpenCode：该模型能不能按信封产出工具调用 */
  capability?: { status: string; reason: string; checkedAt: number }
}

interface ModelRowProps {
  model: ModelInfo
  isSelected: boolean
  onSelect: (modelId: string) => void
  t: (key: string, params?: Record<string, any>) => string
}

const PAGE_SIZE = 50

const ModelRow = memo(({ model, isSelected, onSelect, t }: ModelRowProps) => {
  const providerIcon = providerIcons[model.providerId]
  
  return (
    <TableRow 
      className={cn(
        'cursor-pointer hover:bg-muted/50',
        isSelected && 'bg-muted'
      )}
      onClick={() => onSelect(model.id)}
    >
      <TableCell>
        {isSelected ? (
          <Check className="h-4 w-4 text-primary" />
        ) : (
          <Square className="h-4 w-4 text-muted-foreground" />
        )}
      </TableCell>
      <TableCell>
        <code className="text-sm bg-muted px-2 py-1 rounded">
          {model.name}
        </code>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {providerIcon ? (
            <img 
              src={providerIcon} 
              alt={model.providerName} 
              className="h-4 w-4 object-contain"
            />
          ) : (
            <Database className="h-4 w-4 text-muted-foreground" />
          )}
          <Badge variant="outline">{model.providerName}</Badge>
          {model.capability && (
            <Badge
              variant={model.capability.status === 'tool-capable' ? 'secondary' : 'outline'}
              title={model.capability.reason}
            >
              {model.capability.status === 'tool-capable'
                ? t('models.toolCapable')
                : t('models.chatOnly')}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        {model.accountName ? (
          <span className="text-sm">{model.accountName}</span>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {model.status === 'available' ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="text-sm text-success">{t('models.available')}</span>
            </>
          ) : (
            <>
              <XCircle className="h-4 w-4 text-error" />
              <span className="text-sm text-error">{t('models.unavailable')}</span>
            </>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
})

ModelRow.displayName = 'ModelRow'

export function ModelList() {
  const { t } = useTranslation()
  const { providers, accounts, modelsLastUpdated } = useProvidersStore()
  const { modelMappings } = useProxyStore()
  const { toast } = useToast()
  
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string>('all')
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const [selectAll, setSelectAll] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [effectiveModelsMap, setEffectiveModelsMap] = useState<Record<string, EffectiveModel[]>>({})
  const [capabilities, setCapabilities] = useState<Record<string, { status: string; reason: string; checkedAt: number }>>({})
  const [probing, setProbing] = useState(false)
  
  const loadEffectiveModels = useCallback(async () => {
    try {
      const enabledProviders = providers.filter(p => p.enabled)
      const newMap: Record<string, EffectiveModel[]> = {}
      
      for (const provider of enabledProviders) {
        try {
          const models = await window.electronAPI.providers.getEffectiveModels(provider.id)
          newMap[provider.id] = models
        } catch (error) {
          console.error(`Failed to load models for provider ${provider.id}:`, error)
          newMap[provider.id] = []
        }
      }
      
      setEffectiveModelsMap(newMap)
    } catch (error) {
      console.error('Failed to load effective models:', error)
    }
  }, [providers])
  
  useEffect(() => {
    loadEffectiveModels()
  }, [loadEffectiveModels, modelsLastUpdated])

  const hasOpencode = providers.some(p => p.id === 'opencode')

  const loadCapabilities = useCallback(async () => {
    if (!window.electronAPI?.opencode) return
    try {
      const result = await window.electronAPI.opencode.getCapabilities()
      setCapabilities(result ?? {})
    } catch (error) {
      console.error('Failed to load OpenCode capabilities:', error)
    }
  }, [])

  useEffect(() => {
    loadCapabilities()
  }, [loadCapabilities, modelsLastUpdated])

  const runProbe = async () => {
    if (!window.electronAPI?.opencode) return
    setProbing(true)
    try {
      const result = await window.electronAPI.opencode.probeModels()
      if (result.success) {
        setCapabilities(result.capabilities ?? {})
        toast({ title: t('models.probeDone'), description: t('models.probeDoneDesc') })
      } else {
        toast({ title: t('models.probeFailed'), description: result.detail })
      }
    } catch (error) {
      toast({ title: t('models.probeFailed'), description: String(error) })
    } finally {
      setProbing(false)
    }
  }
  
  const modelList = useMemo(() => {
    const models: ModelInfo[] = []
    const enabledProviders = providers.filter(p => p.enabled)
    const addedModelNames = new Set<string>()
    
    const accountMap = new Map<string, Account[]>()
    for (const account of accounts) {
      if (!accountMap.has(account.providerId)) {
        accountMap.set(account.providerId, [])
      }
      accountMap.get(account.providerId)!.push(account)
    }
    
    const activeProviderMap = new Map<string, boolean>()
    for (const provider of enabledProviders) {
      const providerAccounts = accountMap.get(provider.id) || []
      const hasActiveAccounts = providerAccounts.some(a => a.status === 'active')
      activeProviderMap.set(provider.id, hasActiveAccounts)
    }
    
    for (const provider of enabledProviders) {
      const effectiveModels = effectiveModelsMap[provider.id] || []
      if (effectiveModels.length === 0) {
        continue
      }
      
      const providerAccounts = accountMap.get(provider.id) || []
      const hasActiveAccounts = activeProviderMap.get(provider.id) || false
      
      for (const model of effectiveModels) {
        const modelId = `${provider.id}-${model.displayName}`
        const status = hasActiveAccounts ? 'available' : 'unavailable'
        addedModelNames.add(model.displayName)
        
        models.push({
          id: modelId,
          name: model.displayName,
          providerId: provider.id,
          providerName: provider.name,
          accountId: providerAccounts[0]?.id,
          accountName: providerAccounts[0]?.name,
          status,
          capability: provider.id === 'opencode' ? capabilities[model.actualModelId] : undefined,
        })
      }
    }
    
    for (const mapping of modelMappings) {
      if (!addedModelNames.has(mapping.requestModel)) {
        models.push({
          id: `mapping-${mapping.requestModel}`,
          name: mapping.requestModel,
          providerId: 'mapping',
          providerName: t('models.modelMapping') || 'Model Mapping',
          accountId: mapping.preferredAccountId,
          accountName: mapping.preferredAccountId 
            ? (accounts.find(a => a.id === mapping.preferredAccountId)?.name)
            : undefined,
          status: 'available',
        })
      }
    }
    
    return models
  }, [providers, accounts, modelMappings, effectiveModelsMap, capabilities, t])
  
  const filteredModels = useMemo(() => {
    let filtered = modelList
    
    if (selectedProvider === 'mapping') {
      filtered = filtered.filter(m => m.providerId === 'mapping' || m.id.startsWith('mapping-'))
    } else if (selectedProvider !== 'all') {
      filtered = filtered.filter(m => m.providerId === selectedProvider)
    }
    
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(m =>
        m.name.toLowerCase().includes(query) ||
        m.providerName.toLowerCase().includes(query)
      )
    }
    
    return filtered
  }, [modelList, selectedProvider, searchQuery])
  
  const totalPages = useMemo(() => {
    return Math.ceil(filteredModels.length / PAGE_SIZE)
  }, [filteredModels.length])
  
  const paginatedModels = useMemo(() => {
    const startIndex = (currentPage - 1) * PAGE_SIZE
    return filteredModels.slice(startIndex, startIndex + PAGE_SIZE)
  }, [filteredModels, currentPage])
  
  const providerOptions = useMemo(() => {
    const enabledProviders = providers.filter(p => p.enabled)
    const options = [
      { value: 'all', label: t('models.allProviders') },
      ...enabledProviders.map(p => ({ value: p.id, label: p.name })),
    ]
    // Add 'Model Mapping' option if there are model mappings
    if (modelMappings.length > 0) {
      options.push({ value: 'mapping', label: t('models.modelMapping') || 'Model Mapping' })
    }
    return options
  }, [providers, modelMappings, t])
  
  const handleSelectAll = useCallback(() => {
    const newSelectAll = !selectAll
    setSelectAll(newSelectAll)
    if (newSelectAll) {
      setSelectedModels(new Set(paginatedModels.map(m => m.id)))
    } else {
      setSelectedModels(new Set())
    }
  }, [selectAll, paginatedModels])
  
  const handleSelectModel = useCallback((modelId: string) => {
    const newSelected = new Set(selectedModels)
    if (newSelected.has(modelId)) {
      newSelected.delete(modelId)
    } else {
      newSelected.add(modelId)
    }
    setSelectedModels(newSelected)
    setSelectAll(newSelected.size === paginatedModels.length)
  }, [selectedModels, paginatedModels.length])
  
  const handleCopySelected = useCallback(async () => {
    const selectedModelNames = filteredModels
      .filter(m => selectedModels.has(m.id))
      .map(m => m.name)
    
    if (selectedModelNames.length === 0) {
      toast({
        title: t('models.noModelsFound'),
        description: t('models.noModelsDesc'),
        variant: 'destructive',
      })
      return
    }
    
    const text = selectedModelNames.join(',')
    
    try {
      await navigator.clipboard.writeText(text)
      toast({
        title: t('models.copySuccess'),
        description: t('models.copySuccessDesc', { count: selectedModelNames.length }),
      })
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)
      toast({
        title: t('common.error'),
        description: t('common.error'),
        variant: 'destructive',
      })
    }
  }, [filteredModels, selectedModels, t])
  
  const handleCopyAll = useCallback(async () => {
    if (filteredModels.length === 0) {
      toast({
        title: t('models.noModelsFound'),
        description: t('models.noModelsDesc'),
        variant: 'destructive',
      })
      return
    }
    
    const text = filteredModels.map(m => m.name).join(',')
    
    try {
      await navigator.clipboard.writeText(text)
      toast({
        title: t('models.copySuccess'),
        description: t('models.copySuccessDesc', { count: filteredModels.length }),
      })
    } catch (error) {
      console.error('Failed to copy to clipboard:', error)
      toast({
        title: t('common.error'),
        description: t('common.error'),
        variant: 'destructive',
      })
    }
  }, [filteredModels, t])
  
  const handlePageChange = useCallback((newPage: number) => {
    setCurrentPage(newPage)
    setSelectedModels(new Set())
    setSelectAll(false)
  }, [])
  
  if (modelList.length === 0) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="h-[15px] w-[15px] text-[var(--text-muted)]" />
              <CardTitle>{t('models.modelList')}</CardTitle>
            </div>
            <Badge variant="outline">
              {t('models.totalModels', { count: 0 })}
            </Badge>
          </div>
          <CardDescription>
            {t('models.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="empty-state">
            <div className="empty-state-icon">
              <Cpu className="h-5 w-5" />
            </div>
            <p className="empty-state-title">{t('models.noModelsFound')}</p>
            <p className="empty-state-hint">{t('models.noModelsDesc')}</p>
          </div>
        </CardContent>
      </Card>
    )
  }
  
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="h-[15px] w-[15px] text-[var(--text-muted)]" />
            <CardTitle>{t('models.modelList')}</CardTitle>
          </div>
          <Badge variant="outline">
            {t('models.totalModels', { count: modelList.length })}
          </Badge>
        </div>
        <CardDescription>
          {t('models.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('models.searchModels')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={selectedProvider} onValueChange={setSelectedProvider}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providerOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSelectAll}
              className="h-8 px-2"
            >
              {selectAll ? (
                <Check className="h-4 w-4 mr-2" />
              ) : (
                <Square className="h-4 w-4 mr-2" />
              )}
              {t('models.selectAll')}
            </Button>
            {selectedModels.size > 0 && (
              <Badge variant="secondary" className="text-xs">
                {t('models.selectedModels', { count: selectedModels.size })}
              </Badge>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {hasOpencode && (
              <Button
                variant="outline"
                size="sm"
                onClick={runProbe}
                disabled={probing}
              >
                {probing ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Stethoscope className="h-4 w-4 mr-2" />
                )}
                {t('models.probeModels')}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopySelected}
              disabled={selectedModels.size === 0}
            >
              <Copy className="h-4 w-4 mr-2" />
              {t('models.copySelected')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyAll}
              disabled={filteredModels.length === 0}
            >
              <Copy className="h-4 w-4 mr-2" />
              {t('models.copyAll')}
            </Button>
          </div>
        </div>
        
        {paginatedModels.length > 0 ? (
          <>
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[50px]"></TableHead>
                    <TableHead>{t('models.modelName')}</TableHead>
                    <TableHead>{t('models.provider')}</TableHead>
                    <TableHead>{t('models.account')}</TableHead>
                    <TableHead>{t('models.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedModels.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      isSelected={selectedModels.has(model.id)}
                      onSelect={handleSelectModel}
                      t={t}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
            
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-4 py-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm">
                  {t('models.pageInfo', { 
                    current: currentPage, 
                    total: totalPages 
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Database className="h-5 w-5" />
            </div>
            <p className="empty-state-title">{t('models.noModelsFound')}</p>
            <p className="empty-state-hint">{t('models.noModelsDesc')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default ModelList
