import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Copy, CopyCheck, FlaskConical, Settings2, Wrench, XCircle } from 'lucide-react'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  P0_TOOL_CLIENT_ADAPTERS,
  type ToolCallingConfig,
  type ToolCallingModeSetting,
  type ToolClientAdapterId,
} from '../../../../shared/toolCalling'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import type { ToolCallingSmokeFixture } from '@/types/electron'
import { useProxyStore } from '@/stores/proxyStore'

type ToolCallingConfigPatch = Partial<Omit<ToolCallingConfig, 'advanced'>> & {
  advanced?: Partial<ToolCallingConfig['advanced']>
}

type WireBadge = 'managed' | 'envelope' | 'native'

const BADGE_VARIANTS: Record<WireBadge, 'default' | 'secondary' | 'outline'> = {
  managed: 'default',
  envelope: 'secondary',
  native: 'outline',
}

/**
 * 每条上游线路的工具调用方式（与 forwarder 的实际分派一致）：
 * 默认 chat 走托管 XML；opencode 自管（信封）；账号通道 / anthropic / responses 原生直通。
 */
const WIRES: Array<{ id: string; badge: WireBadge }> = [
  { id: 'chatManaged', badge: 'managed' },
  { id: 'opencode', badge: 'envelope' },
  { id: 'accountChannels', badge: 'native' },
  { id: 'anthropic', badge: 'native' },
  { id: 'responses', badge: 'native' },
]

const HOW_STEPS = [1, 2, 3, 4]

// i18next 会把字符串里的 {{xxx}} 当作插值变量；把字面量作为变量传回去，占位符提示才能原样显示。
const TEMPLATE_TOKENS = { tools: '{{tools}}', tool_names: '{{tool_names}}', format: '{{format}}' }

function mergeToolCallingConfig(
  config: ToolCallingConfig,
  updates: ToolCallingConfigPatch,
): ToolCallingConfig {
  return {
    ...config,
    ...updates,
    advanced: {
      ...config.advanced,
      ...updates.advanced,
    },
    enabled: updates.mode === 'off' ? false : updates.enabled ?? config.enabled,
  }
}

export function ToolCallingPanel() {
  const { t } = useTranslation()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [smokeStatus, setSmokeStatus] = useState<'not_run' | 'running' | 'pass' | 'failed'>('not_run')
  const [smokeError, setSmokeError] = useState<string | null>(null)
  const [fixture, setFixture] = useState<ToolCallingSmokeFixture | null>(null)
  const [fixtureCopied, setFixtureCopied] = useState(false)
  const config = appConfig?.toolCallingConfig ?? DEFAULT_TOOL_CALLING_CONFIG

  const selectedClient = useMemo(
    () => P0_TOOL_CLIENT_ADAPTERS.find((adapter) => adapter.id === config.clientAdapterId),
    [config.clientAdapterId],
  )

  const saveConfig = (updates: ToolCallingConfigPatch) => {
    if (!appConfig) return
    saveAppConfig({ toolCallingConfig: mergeToolCallingConfig(config, updates) })
  }

  const runSmoke = async () => {
    setSmokeStatus('running')
    setSmokeError(null)
    setFixtureCopied(false)
    try {
      const result = await window.electronAPI?.toolCalling?.runSmoke?.({
        clientAdapterId: config.clientAdapterId,
      })
      if (result?.success) {
        setSmokeStatus('pass')
        setFixture(result?.data?.fixture ?? null)
        return
      }
      setSmokeStatus('failed')
      setSmokeError(result?.error?.message ?? t('toolCalling.smoke.failedHint'))
    } catch (error) {
      setSmokeStatus('failed')
      setSmokeError(error instanceof Error ? error.message : t('toolCalling.smoke.failedHint'))
    }
  }

  const copyFixture = async () => {
    if (!fixture) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(fixture, null, 2))
      setFixtureCopied(true)
      window.setTimeout(() => setFixtureCopied(false), 2000)
    } catch {
      // 剪贴板不可用时保持原状，用例仍可手动选中复制
    }
  }

  const enabled = config.enabled && config.mode !== 'off'

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="card-icon">
              <Wrench className="h-3.5 w-3.5" />
            </div>
            <div>
              <CardTitle className="text-base">{t('toolCalling.title')}</CardTitle>
              <CardDescription>{t('toolCalling.description')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant={enabled ? 'default' : 'destructive'}>
            {enabled ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            <AlertDescription>
              {enabled ? t('toolCalling.statusEnabled') : t('toolCalling.statusDisabled')}
            </AlertDescription>
          </Alert>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('toolCalling.clientType')}</Label>
              <Select
                value={config.clientAdapterId}
                onValueChange={(value) => saveConfig({ clientAdapterId: value as ToolClientAdapterId })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {P0_TOOL_CLIENT_ADAPTERS.map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>{adapter.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {selectedClient ? t(selectedClient.descriptionKey) : t('toolCalling.clients.unknown')}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t('toolCalling.mode')}</Label>
              <Select
                value={config.mode}
                onValueChange={(value) => saveConfig({
                  mode: value as ToolCallingModeSetting,
                  enabled: value !== 'off',
                })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t('toolCalling.modes.off')}</SelectItem>
                  <SelectItem value="auto">{t('toolCalling.modes.auto')}</SelectItem>
                  <SelectItem value="force">{t('toolCalling.modes.force')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t(`toolCalling.modeHints.${config.mode}`)}</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('toolCalling.how.title')}</Label>
            <ol className="space-y-2 rounded-md border p-3">
              {HOW_STEPS.map((step) => (
                <li key={step} className="flex gap-2 text-xs text-muted-foreground">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground">
                    {step}
                  </span>
                  <span>{t(`toolCalling.how.steps.${step}`)}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="space-y-2">
            <Label>{t('toolCalling.wireMatrix.title')}</Label>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-2/5">{t('toolCalling.wireMatrix.columnWire')}</TableHead>
                  <TableHead>{t('toolCalling.wireMatrix.columnMode')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {WIRES.map((wire) => (
                  <TableRow key={wire.id}>
                    <TableCell className="text-sm font-medium">
                      {t(`toolCalling.wireMatrix.rows.${wire.id}`)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={BADGE_VARIANTS[wire.badge]}>
                          {t(`toolCalling.wireMatrix.badges.${wire.badge}`)}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {t(`toolCalling.wireMatrix.details.${wire.id}`)}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <Label>{t('toolCalling.smoke.title')}</Label>
                <p className="text-xs text-muted-foreground">{t('toolCalling.smoke.description')}</p>
                {smokeStatus === 'failed' && smokeError && (
                  <p className="mt-1 text-xs text-destructive">{smokeError}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={smokeStatus === 'pass' ? 'default' : 'outline'}>
                  {t(`toolCalling.smoke.${smokeStatus}`)}
                </Badge>
                <Button variant="outline" size="sm" onClick={runSmoke} disabled={smokeStatus === 'running'}>
                  <FlaskConical className="mr-2 h-4 w-4" />
                  {t('toolCalling.smoke.run')}
                </Button>
              </div>
            </div>

            {fixture && (
              <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs">{t('toolCalling.smoke.fixture')}</Label>
                  <Button variant="ghost" size="sm" onClick={copyFixture}>
                    {fixtureCopied
                      ? <CopyCheck className="mr-2 h-4 w-4" />
                      : <Copy className="mr-2 h-4 w-4" />}
                    {fixtureCopied ? t('toolCalling.smoke.copied') : t('toolCalling.smoke.copy')}
                  </Button>
                </div>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-micro text-muted-foreground">
                  {JSON.stringify(fixture, null, 2)}
                </pre>
                <p className="text-xs text-muted-foreground">{t('toolCalling.smoke.hint')}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="card-icon">
              <Settings2 className="h-3.5 w-3.5" />
            </div>
            <div>
              <CardTitle className="text-base">{t('toolCalling.advanced.title')}</CardTitle>
              <CardDescription>{t('toolCalling.advanced.description')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label>{t('toolCalling.advanced.customTemplate')}</Label>
          <Textarea
            className="min-h-[160px] font-mono text-micro"
            value={config.advanced.customPromptTemplate ?? ''}
            onChange={(event) => saveConfig({
              advanced: { customPromptTemplate: event.target.value || undefined },
            })}
            placeholder={t('toolCalling.advanced.customTemplatePlaceholder', TEMPLATE_TOKENS)}
          />
        </CardContent>
      </Card>
    </div>
  )
}
