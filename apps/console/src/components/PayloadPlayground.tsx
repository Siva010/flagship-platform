'use client';

import { useMemo, useState } from 'react';
import {
  evaluateFlag,
  filterSnapshotForKey,
  indexSnapshot,
  type Flag,
  type RuleNode,
  type RulesetSnapshot,
} from '@flagship/core';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { RuleBuilder } from '@/components/RuleBuilder';

/**
 * Payload filtering, made visible.
 *
 * The same rule tree is shown as the server payload, the client payload, and a
 * live evaluation against both. A leaked rule looks exactly like a working one
 * until somebody reads a browser bundle, so showing both side by side turns an
 * invisible failure into one you can see.
 */

const SEGMENTS = ['internal-staff', 'beta-testers', 'enterprise-accounts'];

const INITIAL_TREE: RuleNode = {
  kind: 'and',
  children: [
    {
      kind: 'condition',
      attribute: 'plan',
      operator: 'eq',
      values: ['enterprise'],
      visibility: 'client',
    },
    {
      kind: 'condition',
      attribute: 'email',
      operator: 'endsWith',
      values: ['@competitor.com'],
      visibility: 'server',
    },
  ],
};

export function PayloadPlayground() {
  const [tree, setTree] = useState<RuleNode>(INITIAL_TREE);
  const [contextKey, setContextKey] = useState('user-1');
  const [attributes, setAttributes] = useState(
    '{"plan":"enterprise","email":"spy@competitor.com"}',
  );

  const flag: Flag = useMemo(
    () => ({
      key: 'checkout-redesign',
      enabled: true,
      salt: 'salt-a',
      bucketBy: 'key',
      variations: [
        { key: 'on', value: true },
        { key: 'off', value: false },
      ],
      defaultVariationKey: 'off',
      offVariationKey: 'off',
      prerequisites: [],
      rules: [{ id: 'rule-1', description: '', when: tree, serve: { variationKey: 'on' } }],
    }),
    [tree],
  );

  const serverSnapshot: RulesetSnapshot = useMemo(
    () => ({
      environmentKey: 'production',
      version: 1,
      flags: [flag],
      segments: SEGMENTS.map((key) => ({
        key,
        when: {
          kind: 'condition',
          attribute: 'group',
          operator: 'eq',
          values: [key],
          visibility: 'client',
        },
      })),
      servedAt: new Date(0).toISOString(),
    }),
    [flag],
  );

  const clientSnapshot = useMemo(
    () => filterSnapshotForKey(serverSnapshot, 'client'),
    [serverSnapshot],
  );

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(attributes) as Record<string, never> };
    } catch (cause) {
      return { ok: false as const, error: (cause as Error).message };
    }
  }, [attributes]);

  const evaluation = useMemo(() => {
    if (!parsed.ok) return undefined;
    const context = { key: contextKey, attributes: parsed.value };
    return {
      server: evaluateFlag('checkout-redesign', context, indexSnapshot(serverSnapshot), false),
      client: evaluateFlag('checkout-redesign', context, indexSnapshot(clientSnapshot), false),
    };
  }, [parsed, contextKey, serverSnapshot, clientSnapshot]);

  const stripped = (clientSnapshot.flags[0]?.rules.length ?? 0) === 0;

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Targeting rule" />
        <CardBody>
          <RuleBuilder node={tree} onChange={setTree} availableSegments={SEGMENTS} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Evaluate" />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <Field label="Context key">
              <Input value={contextKey} onChange={(event) => setContextKey(event.target.value)} />
            </Field>
            <Field
              label="Attributes (JSON)"
              hint={parsed.ok ? undefined : `Invalid JSON: ${parsed.error}`}
            >
              <Input
                value={attributes}
                onChange={(event) => setAttributes(event.target.value)}
                className="min-w-80 font-mono text-xs"
              />
            </Field>
          </div>

          {evaluation && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Tile
                label="Server SDK"
                on={evaluation.server.value === true}
                reason={evaluation.server.reason.kind}
              />
              <Tile
                label="Browser SDK"
                on={evaluation.client.value === true}
                reason={evaluation.client.reason.kind}
              />
            </div>
          )}

          {evaluation && evaluation.server.value !== evaluation.client.value && (
            <p className="rounded-md border-l-[3px] border-brand bg-raised px-4 py-3 text-sm text-muted">
              The two SDKs disagree, and that is correct. The browser payload no longer
              contains the server-only condition, so the rule that gated this user is not
              there to match. A client is never <em>more</em> included than the server.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Payloads" />
        <CardBody className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              Server key <Badge tone="server">full ruleset</Badge>
            </h3>
            <pre className="max-h-80 overflow-auto rounded-md border border-line bg-canvas p-3 text-xs">
              {JSON.stringify(serverSnapshot.flags[0]?.rules, null, 2)}
            </pre>
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              Client key <Badge tone="client">public</Badge>
            </h3>
            {stripped ? (
              <p className="rounded-md border border-dashed border-warning/40 bg-warning/10 p-3 text-sm text-muted">
                Rule removed entirely. It contained a server-only condition, and deleting
                just that condition would leave a <strong>more permissive</strong> rule than
                the author wrote.
              </p>
            ) : (
              <pre className="max-h-80 overflow-auto rounded-md border border-line bg-canvas p-3 text-xs">
                {JSON.stringify(clientSnapshot.flags[0]?.rules, null, 2)}
              </pre>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function Tile({ label, on, reason }: { label: string; on: boolean; reason: string }) {
  return (
    <div className="rounded-md border border-line px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-lg font-bold ${on ? 'text-success' : 'text-muted'}`}>
        {on ? 'ON' : 'OFF'}
      </p>
      <p className="font-mono text-xs text-muted">{reason}</p>
    </div>
  );
}
