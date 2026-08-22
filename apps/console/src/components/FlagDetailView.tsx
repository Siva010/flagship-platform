'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  evaluateFlag,
  filterSnapshotForKey,
  indexSnapshot,
  type Flag,
  type RuleNode,
  type RulesetSnapshot,
} from '@flagship/core';
import {
  api,
  ApiError,
  type Environment,
  type FlagDetail,
  type Segment,
  type Tenant,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { RuleBuilder } from '@/components/RuleBuilder';

const EMPTY_TREE: RuleNode = { kind: 'and', children: [] };

export function FlagDetailView({ flagKey }: { flagKey: string }) {
  const [tenant, setTenant] = useState<Tenant | undefined>();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [flag, setFlag] = useState<FlagDetail | undefined>();
  const [tree, setTree] = useState<RuleNode>(EMPTY_TREE);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const [contextKey, setContextKey] = useState('user-1');
  const [attributes, setAttributes] = useState('{"plan":"enterprise","email":"a@example.com"}');

  useEffect(() => {
    api
      .tenants()
      .then((data) => {
        const first = data.tenants[0];
        setTenant(first);
        if (first) {
          void api.environments(first.id).then((environmentData) => {
            setEnvironments(environmentData.environments);
            setEnvironmentId((current) => current || (environmentData.environments[0]?.id ?? ''));
          });
          void api.segments(first.id).then((segmentData) => setSegments(segmentData.segments));
        }
      })
      .catch((cause: unknown) => setError(describe(cause)));
  }, []);

  const load = useCallback(() => {
    if (!tenant || !environmentId) return;
    api
      .flag(tenant.id, environmentId, flagKey)
      .then((data) => {
        setFlag(data);
        // The first rule's tree is what this screen edits. A flag with no rules
        // starts from an empty AND, which matches everyone — the same semantics
        // the evaluator applies.
        setTree((data.rules[0]?.when as RuleNode) ?? EMPTY_TREE);
        setDirty(false);
      })
      .catch((cause: unknown) => setError(describe(cause)));
  }, [tenant, environmentId, flagKey]);

  useEffect(load, [load]);

  async function save() {
    if (!tenant || !flag) return;
    setBusy(true);
    setError(undefined);
    setStatus(undefined);

    const rules = [
      {
        id: flag.rules[0]?.id ?? 'rule-1',
        description: flag.rules[0]?.description ?? '',
        when: tree,
        serve: flag.rules[0]?.serve ?? { variationKey: firstNonOff(flag) },
      },
    ];

    try {
      const updated = await api.updateFlag(flagKey, {
        tenantId: tenant.id,
        environmentId,
        rules,
      });
      setFlag(updated);
      setDirty(false);
      setStatus('Saved. Publish to send it to SDKs.');
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(enabled: boolean) {
    if (!tenant || !flag) return;
    setBusy(true);
    setFlag({ ...flag, enabled });
    try {
      await api.updateFlag(flagKey, { tenantId: tenant.id, environmentId, enabled });
    } catch (cause) {
      setFlag({ ...flag, enabled: !enabled });
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    const environment = environments.find((candidate) => candidate.id === environmentId);
    if (!tenant || !environment) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.publish({
        tenantId: tenant.id,
        environmentId,
        environmentKey: environment.key,
      });
      setStatus(`Published v${result.version}.`);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  }

  const preview = usePreview(flag, tree, contextKey, attributes);

  if (!flag) {
    return (
      <div className="flex flex-col gap-4">
        <Link href="/" className="text-sm text-brand hover:underline">
          ← All flags
        </Link>
        {error ? (
          <p className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-brand hover:underline">
            ← All flags
          </Link>
          <h1 className="mt-1 font-mono text-xl font-semibold tracking-tight">{flag.key}</h1>
          {flag.description && <p className="text-sm text-muted">{flag.description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={environmentId}
            onChange={(event) => setEnvironmentId(event.target.value)}
            aria-label="Environment"
          >
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </Select>
          <div className="flex items-center gap-2">
            <Toggle
              checked={flag.enabled}
              onChange={(next) => void toggleEnabled(next)}
              disabled={busy}
              label={`Toggle ${flag.key}`}
            />
            <Badge tone={flag.enabled ? 'on' : 'off'}>{flag.enabled ? 'on' : 'off'}</Badge>
          </div>
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}
      {status && (
        <p className="rounded-md border border-line bg-raised px-4 py-3 text-sm text-muted">
          {status}
        </p>
      )}

      <Card>
        <CardHeader
          title="Targeting rule"
          description="Contexts matching this tree are served the rule's variation."
          action={
            <div className="flex gap-2">
              <Button onClick={save} disabled={busy || !dirty} variant={dirty ? 'primary' : 'secondary'}>
                {dirty ? 'Save changes' : 'Saved'}
              </Button>
              <Button onClick={publish} disabled={busy}>
                Publish
              </Button>
            </div>
          }
        />
        <CardBody>
          <RuleBuilder
            node={tree}
            onChange={(next) => {
              setTree(next);
              setDirty(true);
            }}
            availableSegments={segments.map((segment) => segment.key)}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Preview"
          description="Evaluated locally against the unsaved tree, using the same engine the SDKs run."
        />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <Field label="Context key">
              <Input value={contextKey} onChange={(event) => setContextKey(event.target.value)} />
            </Field>
            <Field label="Attributes (JSON)" hint={preview.parseError}>
              <Input
                value={attributes}
                onChange={(event) => setAttributes(event.target.value)}
                className="min-w-72 font-mono text-xs"
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <ResultTile label="Server SDK" value={preview.server} />
            <ResultTile label="Browser SDK" value={preview.client} />
          </div>

          {preview.diverges && (
            <p className="rounded-md border-l-[3px] border-brand bg-raised px-4 py-3 text-sm text-muted">
              The two SDKs disagree, and that is correct. The browser payload no longer
              contains the server-only condition, so the rule that gated this context is
              not there to match. A client is never <em>more</em> included than the server.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function ResultTile({ label, value }: { label: string; value: string }) {
  const on = value === 'ON';
  return (
    <div className="rounded-md border border-line px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-lg font-bold ${on ? 'text-success' : 'text-muted'}`}>{value}</p>
    </div>
  );
}

/** Evaluates the in-progress tree with the real engine, both payload shapes. */
function usePreview(
  flag: FlagDetail | undefined,
  tree: RuleNode,
  contextKey: string,
  attributes: string,
): { server: string; client: string; diverges: boolean; parseError?: string } {
  if (!flag) return { server: '—', client: '—', diverges: false };

  let parsed: Record<string, string | number | boolean>;
  try {
    parsed = JSON.parse(attributes) as Record<string, string | number | boolean>;
  } catch (cause) {
    return { server: '—', client: '—', diverges: false, parseError: (cause as Error).message };
  }

  const built: Flag = {
    key: flag.key,
    enabled: flag.enabled,
    salt: flag.salt,
    bucketBy: flag.bucketBy,
    variations: flag.variations,
    defaultVariationKey: flag.defaultVariationKey,
    offVariationKey: flag.offVariationKey,
    prerequisites: [],
    rules: [
      {
        id: 'preview',
        description: '',
        when: tree,
        serve: { variationKey: firstNonOff(flag) },
      },
    ],
  };

  const snapshot: RulesetSnapshot = {
    environmentKey: 'preview',
    version: 1,
    flags: [built],
    segments: [],
    servedAt: new Date(0).toISOString(),
  };

  const context = { key: contextKey, attributes: parsed };
  const server = evaluateFlag(flag.key, context, indexSnapshot(snapshot), false);
  const client = evaluateFlag(
    flag.key,
    context,
    indexSnapshot(filterSnapshotForKey(snapshot, 'client')),
    false,
  );

  return {
    server: server.value === true ? 'ON' : 'OFF',
    client: client.value === true ? 'ON' : 'OFF',
    diverges: server.value !== client.value,
  };
}

function firstNonOff(flag: FlagDetail): string {
  const candidate = flag.variations.find((variation) => variation.key !== flag.offVariationKey);
  return candidate?.key ?? flag.defaultVariationKey;
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.problems.length > 0
      ? `${cause.message}: ${cause.problems.join('; ')}`
      : cause.message;
  }
  return cause instanceof Error ? cause.message : 'Something went wrong';
}
