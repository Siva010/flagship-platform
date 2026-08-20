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
import { RuleBuilder } from '../components/RuleBuilder';

/**
 * Rule builder workbench.
 *
 * The three panels below the editor are the point: the same rule tree, shown as
 * the server payload, as the client payload, and as a live evaluation. Payload
 * filtering is the easiest thing in this system to get subtly wrong, and the
 * failure is invisible — a leaked rule looks exactly like a working one until
 * someone reads a browser bundle. Making both payloads visible side by side
 * turns that into something you can see.
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

export default function HomePage() {
  const [tree, setTree] = useState<RuleNode>(INITIAL_TREE);
  const [contextKey, setContextKey] = useState('user-1');
  const [attributes, setAttributes] = useState('{\n  "plan": "enterprise",\n  "email": "a@example.com"\n}');

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
      servedAt: '2026-08-20T00:00:00.000Z',
    }),
    [flag],
  );

  const clientSnapshot = useMemo(
    () => filterSnapshotForKey(serverSnapshot, 'client'),
    [serverSnapshot],
  );

  const parsedAttributes = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(attributes);
      return typeof parsed === 'object' && parsed !== null
        ? { ok: true as const, value: parsed as Record<string, string | number | boolean> }
        : { ok: false as const, error: 'Expected a JSON object' };
    } catch (error) {
      return { ok: false as const, error: (error as Error).message };
    }
  }, [attributes]);

  const evaluation = useMemo(() => {
    if (!parsedAttributes.ok) return undefined;
    const context = { key: contextKey, attributes: parsedAttributes.value };
    return {
      server: evaluateFlag('checkout-redesign', context, indexSnapshot(serverSnapshot), false),
      client: evaluateFlag('checkout-redesign', context, indexSnapshot(clientSnapshot), false),
    };
  }, [parsedAttributes, contextKey, serverSnapshot, clientSnapshot]);

  const clientRuleCount = clientSnapshot.flags[0]?.rules.length ?? 0;
  const ruleWasStripped = clientRuleCount === 0;

  return (
    <main className="page">
      <header className="page__header">
        <h1>Flagship</h1>
        <p className="page__subtitle">
          Rule builder — edit the tree and watch both payloads change.
        </p>
      </header>

      <section className="panel">
        <h2>Targeting rule</h2>
        <RuleBuilder node={tree} onChange={setTree} availableSegments={SEGMENTS} />
      </section>

      <section className="panel">
        <h2>Evaluate</h2>
        <div className="evaluate">
          <label className="field">
            <span>Context key</span>
            <input
              type="text"
              value={contextKey}
              onChange={(event) => setContextKey(event.target.value)}
            />
          </label>
          <label className="field field--grow">
            <span>Attributes (JSON)</span>
            <textarea
              value={attributes}
              onChange={(event) => setAttributes(event.target.value)}
              rows={5}
              spellCheck={false}
            />
          </label>
        </div>

        {!parsedAttributes.ok && <p className="error">Invalid JSON: {parsedAttributes.error}</p>}

        {evaluation && (
          <div className="results">
            <Result
              label="Server SDK"
              value={evaluation.server.value}
              reason={evaluation.server.reason.kind}
            />
            <Result
              label="Browser SDK"
              value={evaluation.client.value}
              reason={evaluation.client.reason.kind}
            />
          </div>
        )}

        {evaluation && evaluation.server.value !== evaluation.client.value && (
          <p className="notice">
            The two SDKs disagree, and that is correct. The browser payload no longer
            contains the server-only condition, so the rule that gated this user is not
            there to match. A client is never <em>more</em> included than the server.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Payloads</h2>
        <div className="payloads">
          <div className="payload">
            <h3>
              Server key <span className="badge badge--server">full ruleset</span>
            </h3>
            <pre>{JSON.stringify(serverSnapshot.flags[0]?.rules, null, 2)}</pre>
          </div>
          <div className="payload">
            <h3>
              Client key <span className="badge badge--client">public</span>
            </h3>
            {ruleWasStripped ? (
              <p className="stripped">
                Rule removed entirely. It contained a server-only condition, and deleting
                just that condition would leave a <strong>more permissive</strong> rule than
                the author wrote.
              </p>
            ) : (
              <pre>{JSON.stringify(clientSnapshot.flags[0]?.rules, null, 2)}</pre>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function Result({ label, value, reason }: { label: string; value: unknown; reason: string }) {
  const enabled = value === true;
  return (
    <div className={`result ${enabled ? 'result--on' : 'result--off'}`}>
      <span className="result__label">{label}</span>
      <span className="result__value">{enabled ? 'ON' : 'OFF'}</span>
      <span className="result__reason">{reason}</span>
    </div>
  );
}
