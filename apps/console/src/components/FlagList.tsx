'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Environment, type FlagSummary, type Tenant } from '@/lib/api';
import { useRulesetStream } from '@/hooks/useRulesetStream';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { StreamIndicator } from '@/components/StreamIndicator';

export function FlagList() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [flags, setFlags] = useState<FlagSummary[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [publishNote, setPublishNote] = useState<string | undefined>();

  const environment = environments.find((candidate) => candidate.id === environmentId);
  const stream = useRulesetStream(environment?.key);

  useEffect(() => {
    api
      .tenants()
      .then((data) => {
        setTenants(data.tenants);
        setTenantId((current) => current || (data.tenants[0]?.id ?? ''));
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    api
      .environments(tenantId)
      .then((data) => {
        setEnvironments(data.environments);
        setEnvironmentId((current) =>
          data.environments.some((candidate) => candidate.id === current)
            ? current
            : (data.environments[0]?.id ?? ''),
        );
      })
      .catch((cause: unknown) => setError(describe(cause)));
  }, [tenantId]);

  const reload = useCallback(() => {
    if (!tenantId || !environmentId) return;
    api
      .flags(tenantId, environmentId)
      .then((data) => setFlags(data.flags))
      .catch((cause: unknown) => setError(describe(cause)));
  }, [tenantId, environmentId]);

  useEffect(reload, [reload]);

  // A published ruleset means someone changed something — possibly in another
  // tab or by another operator. Refetching on the stream event is what makes
  // this a live view rather than a snapshot taken when the page loaded.
  useEffect(() => {
    if (stream.lastEvent !== undefined) reload();
  }, [stream.lastEvent, reload]);

  async function toggle(flag: FlagSummary, enabled: boolean) {
    setBusy(true);
    setError(undefined);
    // Optimistic: the switch should feel instant. Reverted below if the write
    // fails, so the UI never claims a state the server rejected.
    setFlags((current) =>
      current.map((candidate) =>
        candidate.key === flag.key ? { ...candidate, enabled } : candidate,
      ),
    );
    try {
      await api.updateFlag(flag.key, { tenantId, environmentId, enabled });
    } catch (cause) {
      setFlags((current) =>
        current.map((candidate) =>
          candidate.key === flag.key ? { ...candidate, enabled: flag.enabled } : candidate,
        ),
      );
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!environment) return;
    setBusy(true);
    setError(undefined);
    setPublishNote(undefined);
    try {
      const result = await api.publish({
        tenantId,
        environmentId,
        environmentKey: environment.key,
      });
      setPublishNote(
        result.pushed
          ? `Published v${result.version} and pushed to the data plane.`
          : `Published v${result.version}. The data plane did not confirm the push; SDKs will reconcile by polling.`,
      );
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  const visible = flags.filter(
    (flag) =>
      flag.key.toLowerCase().includes(filter.toLowerCase()) ||
      flag.description.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Environment"
          action={<StreamIndicator state={stream} />}
        />
        <CardBody className="flex flex-wrap items-end gap-4">
          <Field label="Tenant">
            <Select
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
              aria-label="Tenant"
            >
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Environment">
            <Select
              value={environmentId}
              onChange={(event) => setEnvironmentId(event.target.value)}
              aria-label="Environment"
            >
              {environments.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Filter">
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="flag key or description"
              aria-label="Filter flags"
            />
          </Field>

          <div className="ml-auto flex items-center gap-3">
            {environment && (
              <span className="text-xs text-muted font-mono">
                published v{environment.version}
              </span>
            )}
            <Button variant="primary" onClick={publish} disabled={busy || !environment}>
              Publish ruleset
            </Button>
          </div>
        </CardBody>
      </Card>

      {error && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      {publishNote && (
        <p className="rounded-md border border-line bg-raised px-4 py-3 text-sm text-muted">
          {publishNote}
        </p>
      )}

      <Card>
        <CardHeader
          title={`Flags (${visible.length})`}
          description="Toggling changes the stored configuration. It reaches SDKs when you publish."
        />
        <div className="divide-y divide-line">
          {loading && <p className="px-5 py-8 text-sm text-muted">Loading…</p>}

          {!loading && visible.length === 0 && (
            <p className="px-5 py-8 text-sm text-muted">
              {flags.length === 0
                ? 'No flags yet. Create one to get started.'
                : 'No flags match this filter.'}
            </p>
          )}

          {visible.map((flag) => (
            <div
              key={flag.key}
              className="flex flex-wrap items-center gap-4 px-5 py-3.5 hover:bg-raised/60"
            >
              <Toggle
                checked={flag.enabled}
                onChange={(next) => void toggle(flag, next)}
                disabled={busy}
                label={`Toggle ${flag.key}`}
              />

              <div className="min-w-0 flex-1">
                <Link
                  href={`/flags/${encodeURIComponent(flag.key)}`}
                  className="font-mono text-sm text-ink hover:text-brand hover:underline"
                >
                  {flag.key}
                </Link>
                {flag.description && (
                  <p className="truncate text-xs text-muted">{flag.description}</p>
                )}
              </div>

              <Badge tone={flag.enabled ? 'on' : 'off'}>{flag.enabled ? 'on' : 'off'}</Badge>

              <span className="hidden text-xs text-muted sm:inline">
                {flag.variations.length} variations
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.problems.length > 0
      ? `${cause.message}: ${cause.problems.join('; ')}`
      : cause.message;
  }
  return cause instanceof Error ? cause.message : 'Something went wrong';
}
