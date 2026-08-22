'use client';

import { useEffect, useState } from 'react';
import { api, ApiError, type AuditEntry, type Tenant } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';

const ACTION_TONE = {
  create: 'client',
  update: 'neutral',
  publish: 'on',
  delete: 'danger',
} as const;

export function AuditLog() {
  const [tenant, setTenant] = useState<Tenant | undefined>();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .tenants()
      .then((data) => setTenant(data.tenants[0]))
      .catch((cause: unknown) => setError(describe(cause)));
  }, []);

  useEffect(() => {
    if (!tenant) return;
    setLoading(true);
    api
      .audit(tenant.id, filter || undefined)
      .then((data) => setEntries(data.entries))
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setLoading(false));
  }, [tenant, filter]);

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Filter" />
        <div className="p-5">
          <Field label="Resource key" hint="Leave empty for all recent activity">
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="flag key"
              aria-label="Resource key"
            />
          </Field>
        </div>
      </Card>

      {error && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      <Card>
        <CardHeader title={`Entries (${entries.length})`} />
        <div className="divide-y divide-line">
          {loading && <p className="px-5 py-8 text-sm text-muted">Loading…</p>}
          {!loading && entries.length === 0 && (
            <p className="px-5 py-8 text-sm text-muted">Nothing recorded yet.</p>
          )}
          {entries.map((entry, index) => (
            <div key={index} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Badge tone={ACTION_TONE[entry.action as keyof typeof ACTION_TONE] ?? 'neutral'}>
                {entry.action}
              </Badge>
              <span className="font-mono text-sm">{entry.resource_key}</span>
              <span className="text-xs text-muted">{entry.resource_type}</span>
              <span className="ml-auto text-xs text-muted">{entry.actor_email}</span>
              <time className="text-xs text-muted tabular-nums" dateTime={entry.created_at}>
                {new Date(entry.created_at).toLocaleString()}
              </time>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : 'Something went wrong';
}
