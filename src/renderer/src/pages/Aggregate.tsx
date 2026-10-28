import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Loader2, Plus, RefreshCw, Search, Trash2, Wifi } from 'lucide-react'
import type {
  AggregateEntry,
  AggregateEntryState,
  AggregateListResult,
  AggregateOperationResult,
} from '../../../shared/aggregate'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
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
import { useToast } from '@/hooks/use-toast'

type CategoryFilter = 'all' | AggregateEntry['category']

interface EditorState {
  entry: AggregateEntry
  apiKey: string
  baseUrl: string
  models: string
  enabled: boolean
}

function initialEditor(entry: AggregateEntry, state?: AggregateEntryState): EditorState {
  return {
    entry,
    apiKey: '',
    baseUrl: state?.baseUrl || entry.baseUrl || '',
    models: entry.models.map(model => model.id).join('\n'),
    enabled: state?.configured ? state.enabled : true,
  }
}

function categoryLabelKey(category: AggregateEntry['category']): string {
  if (category === 'free-tier') return 'aggregate.category.freeTier'
  if (category === 'apikey') return 'aggregate.category.apikey'
  return 'aggregate.category.local'
}

export function Aggregate() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [entries, setEntries] = useState<AggregateEntry[]>([])
  const [states, setStates] = useState<Record<string, AggregateEntryState>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result: AggregateListResult = await window.electronAPI.aggregate.list()
    setEntries(result.entries)
    setStates(result.states)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const reasonText = useCallback((reason?: string) => {
    if (!reason) return t('aggregate.reasons.unknown')
    const key = `aggregate.reasons.${reason}`
    const translated = t(key)
    return translated === key ? reason : translated
  }, [t])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return entries.filter(entry => {
      if (category !== 'all' && entry.category !== category) return false
      if (!needle) return true
      if (entry.id.toLowerCase().includes(needle)) return true
      if (entry.name.toLowerCase().includes(needle)) return true
      return entry.models.some(model => model.id.toLowerCase().includes(needle))
    })
  }, [entries, search, category])

  const handleSave = async () => {
    if (!editor) return
    setSaving(true)
    const models = editor.models
      .split(/[\n,]/)
      .map(model => model.trim())
      .filter(Boolean)
    const result = await window.electronAPI.aggregate.save({
      id: editor.entry.id,
      apiKey: editor.apiKey.trim() || undefined,
      baseUrl: editor.baseUrl.trim() || undefined,
      models: models.length > 0 ? models : undefined,
      enabled: editor.enabled,
    })
    setSaving(false)

    if (!result.success) {
      toast({
        title: t('common.error'),
        description: `${reasonText(result.reason)}`,
        variant: 'destructive',
      })
      return
    }
    toast({ title: t('aggregate.result.saved', { name: editor.entry.name }) })
    setEditor(null)
    await refresh()
  }

  const handleToggle = async (entry: AggregateEntry, enabled: boolean) => {
    setBusyId(entry.id)
    const result = await window.electronAPI.aggregate.setEnabled(entry.id, enabled)
    setBusyId(null)
    if (!result.success) {
      toast({
        title: t('common.error'),
        description: reasonText(result.reason),
        variant: 'destructive',
      })
      return
    }
    await refresh()
  }

  const handleRemove = async (entry: AggregateEntry) => {
    if (!window.confirm(t('aggregate.deleteConfirm', { name: entry.name }))) return
    setBusyId(entry.id)
    await window.electronAPI.aggregate.remove(entry.id)
    setBusyId(null)
    toast({ title: t('aggregate.result.removed', { name: entry.name }) })
    await refresh()
  }

  const handleProbe = async (entry: AggregateEntry, action: 'test' | 'discover') => {
    setBusyId(entry.id)
    const result: AggregateOperationResult = action === 'test'
      ? await window.electronAPI.aggregate.test(entry.id)
      : await window.electronAPI.aggregate.discoverModels(entry.id)
    setBusyId(null)

    if (!result.success) {
      toast({
        title: t('common.error'),
        description: reasonText(result.reason),
        variant: 'destructive',
      })
      return
    }
    toast({
      title: action === 'test'
        ? t('aggregate.result.testOk', { count: result.modelCount ?? 0 })
        : t('aggregate.result.discovered', { count: result.modelCount ?? 0 }),
    })
    if (action === 'discover') await refresh()
  }

  const stateOf = (entry: AggregateEntry): AggregateEntryState =>
    states[entry.id] ?? {
      configured: false,
      enabled: false,
      hasApiKey: false,
      baseUrl: entry.baseUrl,
      modelCount: entry.models.length,
    }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t('aggregate.title')}</h2>
        <p className="text-muted-foreground">{t('aggregate.description')}</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder={t('aggregate.searchPlaceholder')}
                className="pl-9"
              />
            </div>
            <Select value={category} onValueChange={value => setCategory(value as CategoryFilter)}>
              <SelectTrigger className="w-full sm:w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('aggregate.allCategories')}</SelectItem>
                <SelectItem value="apikey">{t('aggregate.category.apikey')}</SelectItem>
                <SelectItem value="free-tier">{t('aggregate.category.freeTier')}</SelectItem>
                <SelectItem value="local">{t('aggregate.category.local')}</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('common.refresh')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('aggregate.columnProvider')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('aggregate.columnCategory')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('aggregate.columnWire')}</TableHead>
                <TableHead>{t('aggregate.columnModels')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead className="text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                    {t('common.loading')}
                  </TableCell>
                </TableRow>
              )}
              {!loading && filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    {t('common.noData')}
                  </TableCell>
                </TableRow>
              )}
              {!loading && filtered.map(entry => {
                const state = stateOf(entry)
                const unsupported = entry.authKind === 'unsupported'
                const busy = busyId === entry.id
                return (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-semibold uppercase">
                          {entry.name.slice(0, 1)}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{entry.name}</div>
                          <div className="truncate text-xs text-muted-foreground">{entry.id}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Badge variant={entry.category === 'free-tier' ? 'secondary' : 'outline'}>
                        {t(categoryLabelKey(entry.category))}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                      {entry.wire === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Chat'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {state.configured ? state.modelCount : entry.models.length}
                    </TableCell>
                    <TableCell>
                      {unsupported ? (
                        <Badge variant="destructive">{t('aggregate.unsupported')}</Badge>
                      ) : state.configured ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={state.enabled}
                            disabled={busy}
                            onCheckedChange={checked => void handleToggle(entry, checked)}
                          />
                          <span className="text-xs text-muted-foreground">
                            {state.enabled ? t('aggregate.active') : t('aggregate.disabled')}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('aggregate.notConfigured')}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {unsupported ? null : (
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditor(initialEditor(entry, state))}
                          >
                            {state.configured ? (
                              <>
                                <KeyRound className="mr-1 h-3.5 w-3.5" />
                                {t('aggregate.configure')}
                              </>
                            ) : (
                              <>
                                <Plus className="mr-1 h-3.5 w-3.5" />
                                {t('aggregate.add')}
                              </>
                            )}
                          </Button>
                          {state.configured && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy || !entry.modelsUrl}
                                title={entry.modelsUrl ? t('aggregate.test') : t('aggregate.reasons.no_model_list')}
                                onClick={() => void handleProbe(entry, 'test')}
                              >
                                <Wifi className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy || !entry.modelsUrl}
                                title={t('aggregate.discover')}
                                onClick={() => void handleProbe(entry, 'discover')}
                              >
                                {busy ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-3.5 w-3.5" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => void handleRemove(entry)}
                              >
                                <Trash2 className="h-3.5 w-3.5 text-destructive" />
                              </Button>
                            </>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={Boolean(editor)} onOpenChange={open => !open && setEditor(null)}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('aggregate.dialog.title', { name: editor?.entry.name })}</DialogTitle>
            <DialogDescription>{editor?.entry.notes || editor?.entry.website}</DialogDescription>
          </DialogHeader>

          {editor && (
            <div className="space-y-4">
              {editor.entry.authKind === 'apiKey' && (
                <div className="space-y-1.5">
                  <Label htmlFor="aggregate-key">{t('aggregate.dialog.apiKey')}</Label>
                  <Input
                    id="aggregate-key"
                    type="password"
                    value={editor.apiKey}
                    placeholder={stateOf(editor.entry).hasApiKey
                      ? t('aggregate.dialog.apiKeyKeep')
                      : t('aggregate.dialog.apiKeyPlaceholder')}
                    onChange={event => setEditor({ ...editor, apiKey: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('aggregate.dialog.apiKeyHint')}
                    {editor.entry.authUrl ? ` · ${editor.entry.authUrl}` : ''}
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="aggregate-base-url">{t('aggregate.dialog.baseUrl')}</Label>
                <Input
                  id="aggregate-base-url"
                  value={editor.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={event => setEditor({ ...editor, baseUrl: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">{t('aggregate.dialog.baseUrlHint')}</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="aggregate-models">{t('aggregate.dialog.models')}</Label>
                <Textarea
                  id="aggregate-models"
                  rows={6}
                  value={editor.models}
                  onChange={event => setEditor({ ...editor, models: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">{t('aggregate.dialog.modelsHint')}</p>
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <div className="text-sm font-medium">{t('aggregate.dialog.enabled')}</div>
                  <div className="text-xs text-muted-foreground">{t('aggregate.dialog.enabledHint')}</div>
                </div>
                <Switch
                  checked={editor.enabled}
                  onCheckedChange={checked => setEditor({ ...editor, enabled: checked })}
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setEditor(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Aggregate
