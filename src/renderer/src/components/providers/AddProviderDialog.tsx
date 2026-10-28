import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Check, Plus, ArrowRight, Loader2, AlertCircle, CheckCircle2, ArrowLeft, Eye, EyeOff, Copy } from 'lucide-react'
import type { BuiltinProviderConfig } from '@/types/electron'
import { cn } from '@/lib/utils'
import opencodeIcon from '@/assets/providers/opencode.svg'

interface AddProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  builtinProviders: BuiltinProviderConfig[]
  onSelectBuiltin: (provider: BuiltinProviderConfig, credentials: Record<string, string>) => void
  onCreateCustom: () => void
  onValidateToken?: (providerId: string, credentials: Record<string, string>) => Promise<{
    valid: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>
}

const providerIcons: Record<string, string> = {
  opencode: opencodeIcon,
}

export function AddProviderDialog({
  open,
  onOpenChange,
  builtinProviders,
  onSelectBuiltin,
  onCreateCustom,
  onValidateToken,
}: AddProviderDialogProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState<1 | 2>(1)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set())
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [isValidating, setIsValidating] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    valid?: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>({})
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({})
  const [copiedFields, setCopiedFields] = useState<Record<string, boolean>>({})

  const toggleFieldVisibility = (fieldName: string) => {
    setVisibleFields(prev => ({
      ...prev,
      [fieldName]: !prev[fieldName]
    }))
  }

  const copyToClipboard = async (fieldName: string, value: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopiedFields(prev => ({ ...prev, [fieldName]: true }))
      setTimeout(() => {
        setCopiedFields(prev => ({ ...prev, [fieldName]: false }))
      }, 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const providers = builtinProviders

  const getProviderName = (provider: BuiltinProviderConfig) => {
    return t(`${provider.id}.name`, { defaultValue: provider.name })
  }

  const getProviderDescription = (provider: BuiltinProviderConfig) => {
    return t(`${provider.id}.description`, { defaultValue: provider.description })
  }

  const filteredProviders = providers.filter((provider) =>
    getProviderName(provider).toLowerCase().includes(searchQuery.toLowerCase()) ||
    getProviderDescription(provider)?.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const selectedProviderData = selectedProvider 
    ? providers.find((p) => p.id === selectedProvider) 
    : null

  const toggleModelExpansion = (providerId: string) => {
    setExpandedModels(prev => {
      const newSet = new Set(prev)
      if (newSet.has(providerId)) {
        newSet.delete(providerId)
      } else {
        newSet.add(providerId)
      }
      return newSet
    })
  }

  useEffect(() => {
    if (!open) {
      setStep(1)
      setSelectedProvider(null)
      setSearchQuery('')
      setCredentials({})
      setValidationResult({})
      setVisibleFields({})
      setCopiedFields({})
    }
  }, [open])

  const handleCredentialChange = (fieldName: string, value: string) => {
    setCredentials(prev => ({
      ...prev,
      [fieldName]: value,
    }))
    setValidationResult({})
  }

  const handleValidate = async () => {
    if (!selectedProviderData || !onValidateToken) return

    const credentialFields = selectedProviderData.credentialFields || []
    const requiredFields = credentialFields.filter(f => f.required)
    const missingFields = requiredFields.filter(f => !credentials[f.name])
    
    if (missingFields.length > 0) {
      setValidationResult({
        valid: false,
        error: t('providers.fillRequiredFields', { fields: missingFields.map(f => f.label).join(', ') }),
      })
      return
    }

    setIsValidating(true)
    setValidationResult({})

    try {
      const result = await onValidateToken(selectedProviderData.id, credentials)
      setValidationResult(result)
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : t('providers.validateFailed'),
      })
    } finally {
      setIsValidating(false)
    }
  }

  const handleSubmit = async () => {
    if (!selectedProviderData) return

    const credentialFields = selectedProviderData.credentialFields || []
    const requiredFields = credentialFields.filter(f => f.required)
    const missingFields = requiredFields.filter(f => !credentials[f.name])
    
    if (missingFields.length > 0) {
      setValidationResult({
        valid: false,
        error: t('providers.fillRequiredFields', { fields: missingFields.map(f => f.label).join(', ') }),
      })
      return
    }

    setIsSubmitting(true)

    try {
      await onSelectBuiltin(selectedProviderData, credentials)
      onOpenChange(false)
      setStep(1)
      setSelectedProvider(null)
      setSearchQuery('')
      setCredentials({})
      setValidationResult({})
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : t('providers.saveFailed'),
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCreateCustom = () => {
    onCreateCustom()
    setSelectedProvider(null)
    setSearchQuery('')
  }

  const handleNextStep = () => {
    if (selectedProvider) {
      setStep(2)
    }
  }

  const handleBackStep = () => {
    setStep(1)
    setCredentials({})
    setValidationResult({})
  }

  const renderCredentialFields = () => {
    if (!selectedProviderData) return null

    const credentialFields = selectedProviderData.credentialFields || []

    return (
      <div className="space-y-4">
        {credentialFields.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('providers.noCredentialsRequired')}</p>
        )}
        {credentialFields.map((field) => {
          const translated = {
            label: field.label,
            placeholder: field.placeholder,
            helpText: field.helpText,
          }
          const isPasswordField = field.type === 'password'
          const isVisible = visibleFields[field.name]
          const isCopied = copiedFields[field.name]
          const fieldValue = credentials[field.name] || ''

          return (
            <div key={field.name} className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor={field.name}>{translated.label}</Label>
                {field.required && (
                  <Badge variant="outline" className="text-xs">{t('providers.required')}</Badge>
                )}
              </div>
              {field.type === 'textarea' ? (
                <div className="relative">
                  <textarea
                    id={field.name}
                    className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 pr-20"
                    placeholder={translated.placeholder}
                    value={fieldValue}
                    onChange={(e) => handleCredentialChange(field.name, e.target.value)}
                  />
                  <div className="absolute right-1 top-1 flex gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => copyToClipboard(field.name, fieldValue)}
                      disabled={!fieldValue}
                    >
                      {isCopied ? (
                        <Check className="h-4 w-4 text-success" />
                      ) : (
                        <Copy className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => toggleFieldVisibility(field.name)}
                    >
                      {isVisible ? (
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Eye className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>
              ) : isPasswordField ? (
                <div className="relative">
                  <Input
                    id={field.name}
                    type={isVisible ? 'text' : 'password'}
                    placeholder={translated.placeholder}
                    value={fieldValue}
                    onChange={(e) => handleCredentialChange(field.name, e.target.value)}
                    className="pr-20"
                  />
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => copyToClipboard(field.name, fieldValue)}
                      disabled={!fieldValue}
                    >
                      {isCopied ? (
                        <Check className="h-4 w-4 text-success" />
                      ) : (
                        <Copy className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => toggleFieldVisibility(field.name)}
                    >
                      {isVisible ? (
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Eye className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </div>
              ) : (
                <Input
                  id={field.name}
                  type={field.type}
                  placeholder={translated.placeholder}
                  value={fieldValue}
                  onChange={(e) => handleCredentialChange(field.name, e.target.value)}
                />
              )}
              {translated.helpText && (
                <p className="text-xs text-muted-foreground">{translated.helpText}</p>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const renderStep1 = () => (
    <Tabs defaultValue="builtin" className="mt-4">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="builtin">{t('providers.builtinProviders')}</TabsTrigger>
        <TabsTrigger value="custom" disabled className="gap-1">
          {t('providers.customProviders')}
          <span className="text-micro text-[var(--text-muted)]">({t('providers.customProviderNotSupported')})</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="builtin" className="mt-4">
        <div className="space-y-4">
          <Input
            placeholder={t('providers.searchProviders')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <ScrollArea className="h-[300px]">
            <div className="grid gap-2 pr-4">
              {filteredProviders.map((provider) => (
                <div
                  key={provider.id}
                  className={cn(
                    'flex items-start justify-between p-3 rounded-lg border cursor-pointer transition-colors',
                    selectedProvider === provider.id
                      ? 'border-primary bg-primary/5'
                      : 'hover:bg-muted/50'
                  )}
                  onClick={() => setSelectedProvider(provider.id)}
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden flex-shrink-0">
                      {providerIcons[provider.id] ? (
                        <img 
                          src={providerIcons[provider.id]} 
                          alt={provider.name}
                          className="h-8 w-8 object-contain"
                        />
                      ) : (
                        <span className="text-xl">🔌</span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{getProviderName(provider)}</span>
                        <Badge variant="outline" className="text-xs">
                          {t('providers.builtin')}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {getProviderDescription(provider)}
                      </p>
                      <div className="flex items-center gap-1 mt-1 flex-wrap">
                        {expandedModels.has(provider.id) ? (
                          provider.supportedModels?.map((model) => (
                            <Badge key={model} variant="secondary" className="text-xs">
                              {model}
                            </Badge>
                          ))
                        ) : (
                          <>
                            {provider.supportedModels?.slice(0, 3).map((model) => (
                              <Badge key={model} variant="secondary" className="text-xs">
                                {model}
                              </Badge>
                            ))}
                          </>
                        )}
                        {(provider.supportedModels?.length || 0) > 3 && (
                          <Badge 
                            variant="secondary" 
                            className="text-xs cursor-pointer hover:bg-secondary/80"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleModelExpansion(provider.id)
                            }}
                          >
                            {expandedModels.has(provider.id) ? t('providers.collapse') : `+${(provider.supportedModels?.length || 0) - 3}`}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  {selectedProvider === provider.id && (
                    <Check className="h-5 w-5 text-primary flex-shrink-0 ml-2" />
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </TabsContent>

      <TabsContent value="custom" className="mt-4">
        <div className="flex flex-col items-center justify-center py-8 space-y-4">
          <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
            <Plus className="h-8 w-8 text-primary" />
          </div>
          <div className="text-center">
            <h3 className="font-medium">{t('providers.createCustomProvider')}</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {t('providers.createCustomProviderDesc')}
            </p>
          </div>
          <Button onClick={handleCreateCustom}>
            {t('providers.startCreating')}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </TabsContent>
    </Tabs>
  )

  const renderStep2 = () => (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden">
          {providerIcons[selectedProviderData?.id || ''] ? (
            <img 
              src={providerIcons[selectedProviderData?.id || '']} 
              alt={selectedProviderData?.name || ''}
              className="h-8 w-8 object-contain"
            />
          ) : (
            <span className="text-xl">🔌</span>
          )}
        </div>
        <div>
          <span className="font-medium">{selectedProviderData ? getProviderName(selectedProviderData) : ''}</span>
          <p className="text-xs text-muted-foreground">
            {selectedProviderData ? getProviderDescription(selectedProviderData) : ''}
          </p>
        </div>
      </div>

      <div className="border-t pt-4">
        <h4 className="text-sm font-medium mb-3">{t('providers.credentials')}</h4>

        {renderCredentialFields()}

        {validationResult.error && (
          <div className="flex items-center gap-2 text-sm text-error bg-error-soft p-3 rounded-lg mt-4">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{validationResult.error}</span>
          </div>
        )}

        {validationResult.valid && (
          <div className="flex items-center gap-2 text-sm text-success bg-success-soft p-3 rounded-lg mt-4">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
            <div>
              <span className="font-medium">{t('providers.validationSuccess')}</span>
              {validationResult.userInfo?.quota !== undefined && (
                <span className="ml-2">
                  {t('providers.quota')}: {validationResult.userInfo?.used || 0} / {validationResult.userInfo?.quota}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {step === 1 ? t('providers.addProvider') : t('providers.addAccount')}
          </DialogTitle>
          <DialogDescription>
            {step === 1 
              ? t('providers.selectProvider')
              : t('providers.credentials')
            }
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? renderStep1() : renderStep2()}

        <DialogFooter>
          {step === 1 ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleNextStep}
                disabled={!selectedProvider}
              >
                {t('common.next')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={handleBackStep}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t('common.previous')}
              </Button>
              {onValidateToken && (selectedProviderData?.credentialFields?.length ?? 0) > 0 && (
                <Button
                  variant="outline"
                  onClick={handleValidate}
                  disabled={isValidating || isSubmitting}
                >
                  {isValidating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('oauth.validating')}
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      {t('providers.validateCredentials')}
                    </>
                  )}
                </Button>
              )}
              <Button
                onClick={handleSubmit}
                disabled={isValidating || isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('providers.processing')}
                  </>
                ) : (
                  t('providers.addAccount')
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default AddProviderDialog
