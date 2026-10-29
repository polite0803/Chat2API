/**
 * Custom Provider Form Component
 * Create and edit custom API providers
 */

import { useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, X, HelpCircle } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { AuthType, CredentialField } from '@/types/electron'

interface CustomProviderFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: CustomProviderFormData) => void
  initialData?: Partial<CustomProviderFormData>
}

export interface CustomProviderFormData {
  name: string
  authType: AuthType
  apiEndpoint: string
  headers: Record<string, string>
  description: string
  supportedModels: string[]
  credentialFields: CredentialField[]
}

export function CustomProviderForm({
  open,
  onOpenChange,
  onSubmit,
  initialData,
}: CustomProviderFormProps) {
  const { t } = useTranslation()
  
  /**
   * 认证方式的显示文案。
   *
   * ⚠️ 标签一律取自 `providers.authLabels.*`（与卡片上的「认证方式」同一个
   * 来源）。此前这里引用的是 `providers.authToken` / `authTokenDesc` 等键，
   * **两个语言文件里都没有**，于是 `t()` 原样回显键名——选择器里显示的是
   * `providers.authToken` 这种字面量。新增枚举值时只需补一处。
   */
  const authTypeOptions: { value: AuthType; descKey: string }[] = [
    { value: 'token', descKey: 'providers.authTokenDesc' },
    { value: 'userToken', descKey: 'providers.authUserTokenDesc' },
    { value: 'refresh_token', descKey: 'providers.authRefreshTokenDesc' },
    { value: 'jwt', descKey: 'providers.authJwtDesc' },
    { value: 'realUserID_token', descKey: 'providers.authUserIdTokenDesc' },
    { value: 'tongyi_sso_ticket', descKey: 'providers.authSsoDesc' },
    { value: 'cookie', descKey: 'providers.authCookieDesc' },
    { value: 'oauth', descKey: 'providers.authOAuthDesc' },
  ]

  const defaultCredentialFields: Record<AuthType, CredentialField[]> = {
    token: [{ name: 'apiKey', label: 'API Key', type: 'password', required: true }],
    userToken: [{ name: 'token', label: 'User Token', type: 'password', required: true }],
    refresh_token: [{ name: 'refresh_token', label: 'Refresh Token', type: 'password', required: true }],
    jwt: [{ name: 'token', label: 'JWT Token', type: 'password', required: true }],
    realUserID_token: [
      { name: 'realUserID', label: 'User ID', type: 'text', required: true },
      { name: 'token', label: 'Token', type: 'password', required: true },
    ],
    tongyi_sso_ticket: [{ name: 'ticket', label: 'SSO Ticket', type: 'password', required: true }],
    cookie: [{ name: 'cookie', label: 'Cookie', type: 'textarea', required: true }],
    oauth: [],
  }

  const [formData, setFormData] = useState<CustomProviderFormData>({
    name: initialData?.name || '',
    authType: initialData?.authType || 'token',
    apiEndpoint: initialData?.apiEndpoint || '',
    headers: initialData?.headers || { 'Content-Type': 'application/json' },
    description: initialData?.description || '',
    supportedModels: initialData?.supportedModels || [],
    credentialFields: initialData?.credentialFields || defaultCredentialFields['token'],
  })

  const [newModel, setNewModel] = useState('')
  const [newHeaderKey, setNewHeaderKey] = useState('')
  const [newHeaderValue, setNewHeaderValue] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const handleAuthTypeChange = (authType: AuthType) => {
    setFormData({
      ...formData,
      authType,
      credentialFields: defaultCredentialFields[authType],
    })
  }

  const handleAddModel = () => {
    if (newModel.trim() && !formData.supportedModels.includes(newModel.trim())) {
      setFormData({
        ...formData,
        supportedModels: [...formData.supportedModels, newModel.trim()],
      })
      setNewModel('')
    }
  }

  const handleRemoveModel = (model: string) => {
    setFormData({
      ...formData,
      supportedModels: formData.supportedModels.filter((m) => m !== model),
    })
  }

  const handleAddHeader = () => {
    if (newHeaderKey.trim() && newHeaderValue.trim()) {
      setFormData({
        ...formData,
        headers: {
          ...formData.headers,
          [newHeaderKey.trim()]: newHeaderValue.trim(),
        },
      })
      setNewHeaderKey('')
      setNewHeaderValue('')
    }
  }

  const handleRemoveHeader = (key: string) => {
    const { [key]: _, ...rest } = formData.headers
    setFormData({ ...formData, headers: rest })
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!formData.name.trim()) {
      newErrors.name = t('providers.providerNameRequired')
    }

    if (!formData.apiEndpoint.trim()) {
      newErrors.apiEndpoint = t('providers.apiEndpointRequired')
    } else {
      try {
        new URL(formData.apiEndpoint)
      } catch {
        newErrors.apiEndpoint = t('providers.apiEndpointInvalid')
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = () => {
    if (validate()) {
      onSubmit(formData)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>
            {initialData ? t('providers.editProvider') : t('providers.createCustomProvider')}
          </DialogTitle>
          <DialogDescription>
            {t('providers.createCustomProviderDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="h-[500px] overflow-y-auto pr-2">
          <div className="space-y-6 py-4 px-1">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">
                  {t('providers.providerName')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., My API Provider"
                />
                {errors.name && (
                  <p className="text-xs text-destructive">{errors.name}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="authType">
                  {t('providers.authType')} <span className="text-destructive">*</span>
                </Label>
                <Select value={formData.authType} onValueChange={handleAuthTypeChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {authTypeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <div className="flex flex-col">
                          <span>{t(`providers.authLabels.${option.value}`)}</span>
                          <span className="text-xs text-muted-foreground">
                            {t(option.descKey)}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="apiEndpoint">
                  {t('providers.apiEndpoint')} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="apiEndpoint"
                  value={formData.apiEndpoint}
                  onChange={(e) => setFormData({ ...formData, apiEndpoint: e.target.value })}
                  placeholder="https://api.example.com/v1"
                />
                {errors.apiEndpoint && (
                  <p className="text-xs text-destructive">{errors.apiEndpoint}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">{t('providers.description')}</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder={t('providers.descriptionPlaceholder')}
                  rows={2}
                />
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>{t('providers.supportedModels')}</Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <HelpCircle className="h-4 w-4 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('providers.supportedModelsHelp')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="flex gap-2">
                <Input
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  placeholder={t('providers.modelNamePlaceholder')}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
                />
                <Button type="button" variant="outline" onClick={handleAddModel}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {formData.supportedModels.map((model) => (
                  <Badge key={model} variant="secondary" className="gap-1">
                    {model}
                    <X
                      className="h-3 w-3 cursor-pointer"
                      onClick={() => handleRemoveModel(model)}
                    />
                  </Badge>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <Label>{t('providers.headersConfig')}</Label>
              <div className="grid grid-cols-[1fr,1fr,auto] gap-2">
                <Input
                  value={newHeaderKey}
                  onChange={(e) => setNewHeaderKey(e.target.value)}
                  placeholder={t('providers.headerName')}
                />
                <Input
                  value={newHeaderValue}
                  onChange={(e) => setNewHeaderValue(e.target.value)}
                  placeholder={t('providers.headerValue')}
                />
                <Button type="button" variant="outline" onClick={handleAddHeader}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="space-y-2">
                {Object.entries(formData.headers).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between p-2 rounded bg-muted">
                    <div className="text-sm">
                      <span className="font-medium">{key}:</span> {value}
                    </div>
                    <X
                      className="h-4 w-4 cursor-pointer text-muted-foreground hover:text-foreground"
                      onClick={() => handleRemoveHeader(key)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>{t('providers.credentialFields')}</Label>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <HelpCircle className="h-4 w-4 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('providers.credentialFieldsHelp')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="space-y-2 p-3 rounded bg-muted/50">
                {formData.credentialFields.map((field) => (
                  <div key={field.name} className="flex items-center gap-2 text-sm">
                    <Badge variant="outline">{field.name}</Badge>
                    <span className="text-muted-foreground">{field.label}</span>
                    <span className="text-muted-foreground">({field.type})</span>
                    {field.required && <Badge variant="secondary">{t('providers.required')}</Badge>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit}>
            {initialData ? t('providers.saveChanges') : t('providers.createCustomProvider')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default CustomProviderForm
