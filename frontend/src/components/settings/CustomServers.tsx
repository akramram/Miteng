'use client';

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { ChevronDown, CloudDownload, Eye, EyeOff, Pencil, Plus, Server, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { IconButton } from '@/components/ui/icon-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  deleteCustomProvider,
  fetchCustomProviderModels,
  saveCustomProvider,
  testCustomProviderConnection,
  type CustomModel,
  type CustomProvider,
} from '@/lib/custom-providers';
import { useCustomProviders } from '@/hooks/useCustomProviders';

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
}

/** Saved custom servers with add, edit and delete. Lives in Settings → Summaries. */
export function CustomServers() {
  const providers = useCustomProviders();
  const [editing, setEditing] = useState<CustomProvider | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CustomProvider | null>(null);

  const openForm = (provider: CustomProvider | null) => {
    setEditing(provider);
    setFormOpen(true);
  };

  return (
    <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-semibold text-af-text">Custom servers</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">
            OpenAI-compatible servers such as vLLM, LM Studio, LiteLLM or OpenRouter. Pick one under Summary model or Ask AI model.
          </p>
        </div>
        <Button variant="secondary" size="sm" className="shrink-0" onClick={() => openForm(null)}>
          <Plus />
          Add server
        </Button>
      </div>

      {providers && providers.length > 0 && (
        <ul className="mt-4 divide-y divide-af-border overflow-hidden rounded-xl border border-af-border bg-af-panel-2">
          {providers.map((provider) => (
            <li key={provider.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <Server className="h-4 w-4 shrink-0 text-af-text-3" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-af-text">{provider.name}</p>
                <p className="truncate text-[12px] text-af-text-3">
                  {endpointHost(provider.endpoint)} · {provider.models.length} {provider.models.length === 1 ? 'model' : 'models'}
                </p>
              </div>
              <IconButton label={`Edit ${provider.name}`} icon={<Pencil className="size-4" />} onClick={() => openForm(provider)} />
              <IconButton
                label={`Delete ${provider.name}`}
                icon={<Trash2 className="size-4" />}
                className="hover:text-af-danger"
                onClick={() => setPendingDelete(provider)}
              />
            </li>
          ))}
        </ul>
      )}
      {providers?.length === 0 && (
        <p className="mt-4 rounded-xl border border-dashed border-af-border px-3.5 py-3 text-[13px] text-af-text-3">
          No custom servers yet.
        </p>
      )}

      <CustomServerDialog open={formOpen} onOpenChange={setFormOpen} provider={editing} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        variant="danger"
        title={`Delete ${pendingDelete?.name ?? 'server'}?`}
        description="Its endpoint, key and model list are removed from this computer."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await deleteCustomProvider(pendingDelete.id);
            toast.success(`${pendingDelete.name} deleted`);
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
          }
        }}
      />
    </div>
  );
}

interface CustomServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null adds a new server. */
  provider: CustomProvider | null;
  onSaved?: (provider: CustomProvider) => void;
}

/** Add or edit one custom server. */
export function CustomServerDialog({ open, onOpenChange, provider, onSaved }: CustomServerDialogProps) {
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [models, setModels] = useState<CustomModel[]>([]);
  const [modelDraft, setModelDraft] = useState('');
  const [modelNameDraft, setModelNameDraft] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [temperature, setTemperature] = useState('');
  const [topP, setTopP] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fetched, setFetched] = useState<CustomModel[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [fetchFilter, setFetchFilter] = useState('');
  const [fetching, setFetching] = useState(false);
  const [testModel, setTestModel] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset the form each time it opens, from the server being edited or blank.
  useEffect(() => {
    if (!open) return;
    setName(provider?.name ?? '');
    setEndpoint(provider?.endpoint ?? '');
    setApiKey(provider?.apiKey ?? '');
    setShowApiKey(false);
    setModels(provider?.models ?? []);
    setModelDraft('');
    setModelNameDraft('');
    setMaxTokens(provider?.maxTokens?.toString() ?? '');
    setTemperature(provider?.temperature?.toString() ?? '');
    setTopP(provider?.topP?.toString() ?? '');
    setAdvancedOpen(provider?.maxTokens != null || provider?.temperature != null || provider?.topP != null);
    setFetched(null);
    setPicked(new Set());
    setFetchFilter('');
    setTestModel(provider?.models[0]?.id ?? '');
  }, [open, provider]);

  const addModels = (added: CustomModel[]) => {
    const fresh = added
      .map((model) => ({ id: model.id.trim(), name: model.name?.trim() || null }))
      .filter((model) => model.id);
    setModels((current) => {
      const next = [...current];
      for (const model of fresh) {
        if (!next.some((entry) => entry.id === model.id)) next.push(model);
      }
      return next;
    });
    if (!testModel && fresh[0]) setTestModel(fresh[0].id);
  };

  const removeModel = (id: string) => {
    setModels((current) => current.filter((entry) => entry.id !== id));
    if (testModel === id) setTestModel('');
  };

  const addDraft = () => {
    addModels([{ id: modelDraft, name: modelNameDraft }]);
    setModelDraft('');
    setModelNameDraft('');
  };

  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addDraft();
  };

  const fetchModels = async () => {
    setFetching(true);
    try {
      const available = await fetchCustomProviderModels(endpoint.trim(), apiKey.trim() || null);
      setFetched(available);
      setPicked(new Set());
      setFetchFilter('');
      if (available.length === 0) toast.info('The server listed no models. Add model names by hand.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setFetching(false);
    }
  };

  const visibleFetched = useMemo(() => {
    const needle = fetchFilter.trim().toLowerCase();
    return (fetched ?? []).filter(
      (model) =>
        !models.some((entry) => entry.id === model.id) &&
        (!needle || model.id.toLowerCase().includes(needle) || model.name?.toLowerCase().includes(needle))
    );
  }, [fetched, fetchFilter, models]);

  const togglePicked = (id: string, checked: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const addPicked = () => {
    addModels(visibleFetched.filter((model) => picked.has(model.id)));
    setPicked(new Set());
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const result = await testCustomProviderConnection(endpoint.trim(), apiKey.trim() || null, testModel);
      toast.success(result.message || 'Connection works');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveCustomProvider({
        id: provider?.id ?? null,
        name: name.trim(),
        endpoint: endpoint.trim(),
        apiKey: apiKey.trim() || null,
        models,
        maxTokens: maxTokens.trim() ? Number(maxTokens) : null,
        temperature: temperature.trim() ? Number(temperature) : null,
        topP: topP.trim() ? Number(topP) : null,
      });
      toast.success(provider ? `${saved.name} updated` : `${saved.name} added`);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const canReachServer = endpoint.trim().length > 0;
  const canSave = name.trim().length > 0 && canReachServer && models.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{provider ? `Edit ${provider.name}` : 'Add custom server'}</DialogTitle>
          <DialogDescription>Any server that speaks the OpenAI chat completions API.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="custom-server-name">Name</Label>
            <Input
              id="custom-server-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Office vLLM"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-server-endpoint">Endpoint URL</Label>
            <Input
              id="custom-server-endpoint"
              type="url"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="http://localhost:8000/v1"
            />
            <p className="text-[12px] text-af-text-3">The base URL, usually ending in /v1.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-server-key">API key (optional)</Label>
            <div className="relative">
              <Input
                id="custom-server-key"
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Leave empty if the server needs none"
                className="pr-10"
                autoComplete="off"
              />
              <IconButton
                label={showApiKey ? 'Hide key' : 'Show key'}
                tooltip={false}
                size="icon-xs"
                icon={showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                className="absolute right-1 top-1/2 -translate-y-1/2"
                onClick={() => setShowApiKey((shown) => !shown)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="custom-server-model">Models</Label>
              <Button variant="ghost" size="xs" onClick={fetchModels} loading={fetching} disabled={!canReachServer}>
                {!fetching && <CloudDownload />}
                Fetch models
              </Button>
            </div>
            {models.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Models">
                {models.map((model) => (
                  <li
                    key={model.id}
                    title={model.id}
                    className="flex max-w-full items-center gap-1 rounded-full border border-af-border bg-af-panel-2 py-0.5 pl-2.5 pr-1 text-[12px] text-af-text"
                  >
                    <span className="truncate">{model.name || model.id}</span>
                    {model.name && <span className="truncate text-af-text-3">{model.id}</span>}
                    <button
                      type="button"
                      aria-label={`Remove ${model.name || model.id}`}
                      onClick={() => removeModel(model.id)}
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-af-text-3 hover:bg-af-hover hover:text-af-text"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-af-text-3">Add at least one model, by name or from the server.</p>
            )}
            <div className="flex gap-2">
              <Input
                id="custom-server-model"
                value={modelDraft}
                onChange={(event) => setModelDraft(event.target.value)}
                onKeyDown={onDraftKeyDown}
                placeholder="Model id, e.g. llama-3.1-70b"
              />
              <Input
                value={modelNameDraft}
                onChange={(event) => setModelNameDraft(event.target.value)}
                onKeyDown={onDraftKeyDown}
                placeholder="Display name (optional)"
                aria-label="Model display name"
              />
              <Button variant="secondary" onClick={addDraft} disabled={!modelDraft.trim()}>
                Add
              </Button>
            </div>

            {fetched && fetched.length > 0 && (
              <div className="space-y-2 rounded-xl border border-af-border bg-af-panel-2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[12px] font-medium text-af-text-2">
                    {fetched.length} {fetched.length === 1 ? 'model' : 'models'} on the server. Pick the ones to keep.
                  </p>
                  <Button variant="ghost" size="xs" onClick={() => setFetched(null)}>
                    Close
                  </Button>
                </div>
                {fetched.length > 8 && (
                  <Input
                    value={fetchFilter}
                    onChange={(event) => setFetchFilter(event.target.value)}
                    placeholder="Filter models…"
                    className="h-8"
                  />
                )}
                <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                  {visibleFetched.map((model) => (
                    <li key={model.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] text-af-text hover:bg-af-hover">
                        <Checkbox checked={picked.has(model.id)} onCheckedChange={(checked) => togglePicked(model.id, checked === true)} />
                        <span className="min-w-0 flex-1 truncate">{model.name || model.id}</span>
                        {model.name && <span className="max-w-[45%] shrink-0 truncate text-[11px] text-af-text-3">{model.id}</span>}
                      </label>
                    </li>
                  ))}
                  {visibleFetched.length === 0 && (
                    <li className="px-1.5 py-1 text-[12px] text-af-text-3">
                      {fetchFilter.trim() ? 'No model matches.' : 'All of these are already added.'}
                    </li>
                  )}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={addPicked} disabled={picked.size === 0}>
                    Add {picked.size > 0 ? picked.size : ''} selected
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => addModels(visibleFetched)} disabled={visibleFetched.length === 0}>
                    Add all{visibleFetched.length > 0 ? ` (${visibleFetched.length})` : ''}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div>
            <button
              type="button"
              className="flex w-full items-center justify-between py-1 text-[13px] font-medium text-af-text-2 hover:text-af-text"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              Advanced
              <ChevronDown className={cn('h-4 w-4 text-af-text-3 transition-transform duration-200', advancedOpen && 'rotate-180')} />
            </button>
            {advancedOpen && (
              <div className="mt-2 grid grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="custom-server-max-tokens">Max tokens</Label>
                  <Input
                    id="custom-server-max-tokens"
                    type="number"
                    min="1"
                    step="1"
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    placeholder="4096"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="custom-server-temperature">Temperature</Label>
                  <Input
                    id="custom-server-temperature"
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={temperature}
                    onChange={(event) => setTemperature(event.target.value)}
                    placeholder="0–2"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="custom-server-top-p">Top P</Label>
                  <Input
                    id="custom-server-top-p"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    value={topP}
                    onChange={(event) => setTopP(event.target.value)}
                    placeholder="0–1"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex items-end gap-2 border-t border-af-border pt-4">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label>Test connection with</Label>
              <Select value={testModel} onValueChange={setTestModel} disabled={models.length === 0}>
                <SelectTrigger aria-label="Model to test">
                  <SelectValue placeholder="Add a model first" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name || model.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button variant="secondary" onClick={testConnection} loading={testing} disabled={!canReachServer || !testModel}>
              Test
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!canSave}>
            {provider ? 'Save changes' : 'Add server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
