'use client';

import { useCallback } from 'react';
import type { AttributeValue, Condition, Operator, RuleNode, Visibility } from '@flagship/core';

/**
 * Recursive rule tree editor.
 *
 * The component tree mirrors the rule tree exactly: a boolean node renders its
 * children by rendering itself. That keeps the editor structurally incapable of
 * producing a shape the evaluator cannot read — there is no separate "UI model"
 * to drift out of sync with the wire format.
 *
 * Edits are immutable and path-based. Each node knows its own path from the
 * root, and mutating means rebuilding the spine down to that path. Mutating in
 * place would work until two nodes shared a reference, at which point editing
 * one would silently edit the other.
 */

const OPERATORS: { value: Operator; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
  { value: 'in', label: 'is one of' },
  { value: 'notIn', label: 'is not one of' },
  { value: 'contains', label: 'contains' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'matches', label: 'matches regex' },
  { value: 'gt', label: 'is greater than' },
  { value: 'gte', label: 'is at least' },
  { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' },
  { value: 'semverGt', label: 'version is newer than' },
  { value: 'semverLt', label: 'version is older than' },
];

export type Path = number[];

export interface RuleBuilderProps {
  node: RuleNode;
  onChange: (next: RuleNode) => void;
  availableSegments?: string[];
}

function emptyCondition(): Condition {
  return {
    kind: 'condition',
    attribute: '',
    operator: 'eq',
    values: [''],
    // Defaults to server: the safe direction. A rule the author forgot to
    // classify stays out of browser bundles.
    visibility: 'server',
  };
}

/** Replaces the node at `path`, rebuilding the spine above it. */
function replaceAt(root: RuleNode, path: Path, next: RuleNode): RuleNode {
  if (path.length === 0) return next;

  const [index, ...rest] = path;
  if (root.kind !== 'and' && root.kind !== 'or' && root.kind !== 'not') return root;

  const children = root.children.map((child, i) =>
    i === index ? replaceAt(child, rest, next) : child,
  );
  return { ...root, children };
}

/** Removes the node at `path`. */
function removeAt(root: RuleNode, path: Path): RuleNode {
  if (path.length === 0) return root;

  const [index, ...rest] = path;
  if (root.kind !== 'and' && root.kind !== 'or' && root.kind !== 'not') return root;

  if (rest.length === 0) {
    return { ...root, children: root.children.filter((_, i) => i !== index) };
  }
  const children = root.children.map((child, i) =>
    i === index ? removeAt(child, rest) : child,
  );
  return { ...root, children };
}

export function RuleBuilder({ node, onChange, availableSegments = [] }: RuleBuilderProps) {
  const update = useCallback(
    (path: Path, next: RuleNode) => onChange(replaceAt(node, path, next)),
    [node, onChange],
  );

  const remove = useCallback((path: Path) => onChange(removeAt(node, path)), [node, onChange]);

  return (
    <div className="rule-builder">
      <NodeEditor
        node={node}
        path={[]}
        depth={0}
        onUpdate={update}
        onRemove={remove}
        availableSegments={availableSegments}
        isRoot
      />
    </div>
  );
}

interface NodeEditorProps {
  node: RuleNode;
  path: Path;
  depth: number;
  onUpdate: (path: Path, next: RuleNode) => void;
  onRemove: (path: Path) => void;
  availableSegments: string[];
  isRoot?: boolean;
}

function NodeEditor({
  node,
  path,
  depth,
  onUpdate,
  onRemove,
  availableSegments,
  isRoot = false,
}: NodeEditorProps) {
  if (node.kind === 'condition') {
    return (
      <ConditionEditor
        node={node}
        path={path}
        onUpdate={onUpdate}
        onRemove={onRemove}
        isRoot={isRoot}
      />
    );
  }

  if (node.kind === 'segment') {
    return (
      <div className="node node--segment">
        <span className="node__label">
          {node.negate ? 'is not in segment' : 'is in segment'}
        </span>
        <select
          value={node.segmentKey}
          onChange={(event) => onUpdate(path, { ...node, segmentKey: event.target.value })}
          aria-label="Segment"
        >
          <option value="">Select a segment…</option>
          {availableSegments.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onUpdate(path, { ...node, negate: !node.negate })}
          className="button button--ghost"
        >
          {node.negate ? 'Negated' : 'Negate'}
        </button>
        {!isRoot && (
          <button type="button" onClick={() => onRemove(path)} className="button button--danger">
            Remove
          </button>
        )}
      </div>
    );
  }

  // Boolean node: renders its children by rendering this component again.
  const canAddChild = depth < 8;

  return (
    <div className={`node node--boolean node--depth-${Math.min(depth, 4)}`}>
      <div className="node__header">
        <select
          value={node.kind}
          onChange={(event) =>
            onUpdate(path, { ...node, kind: event.target.value as 'and' | 'or' | 'not' })
          }
          aria-label="Boolean operator"
          className="select--operator"
        >
          <option value="and">ALL of</option>
          <option value="or">ANY of</option>
          <option value="not">NONE of</option>
        </select>
        <span className="node__count">
          {node.children.length} {node.children.length === 1 ? 'condition' : 'conditions'}
        </span>
        {!isRoot && (
          <button type="button" onClick={() => onRemove(path)} className="button button--danger">
            Remove group
          </button>
        )}
      </div>

      <div className="node__children">
        {node.children.length === 0 && (
          <p className="node__empty">
            {node.kind === 'and'
              ? 'Empty group — matches everyone.'
              : 'Empty group — matches no one.'}
          </p>
        )}

        {node.children.map((child, index) => (
          <NodeEditor
            // Index keys are correct here: children are positional, and a
            // reorder is a genuine change of which slot holds what.
            key={index}
            node={child}
            path={[...path, index]}
            depth={depth + 1}
            onUpdate={onUpdate}
            onRemove={onRemove}
            availableSegments={availableSegments}
          />
        ))}
      </div>

      <div className="node__actions">
        <button
          type="button"
          className="button"
          onClick={() =>
            onUpdate(path, { ...node, children: [...node.children, emptyCondition()] })
          }
        >
          + Condition
        </button>
        <button
          type="button"
          className="button"
          disabled={!canAddChild}
          title={canAddChild ? undefined : 'Nesting limit reached'}
          onClick={() =>
            onUpdate(path, {
              ...node,
              children: [...node.children, { kind: 'and', children: [emptyCondition()] }],
            })
          }
        >
          + Group
        </button>
        <button
          type="button"
          className="button"
          onClick={() =>
            onUpdate(path, {
              ...node,
              children: [
                ...node.children,
                { kind: 'segment', segmentKey: availableSegments[0] ?? '', negate: false },
              ],
            })
          }
        >
          + Segment
        </button>
      </div>
    </div>
  );
}

interface ConditionEditorProps {
  node: Condition;
  path: Path;
  onUpdate: (path: Path, next: RuleNode) => void;
  onRemove: (path: Path) => void;
  isRoot: boolean;
}

function ConditionEditor({ node, path, onUpdate, onRemove, isRoot }: ConditionEditorProps) {
  const multiValue = node.operator === 'in' || node.operator === 'notIn';

  const setValues = (raw: string): void => {
    const values: AttributeValue[] = multiValue
      ? raw
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '')
      : [raw];
    onUpdate(path, { ...node, values });
  };

  return (
    <div className="node node--condition">
      <input
        type="text"
        value={node.attribute}
        placeholder="attribute (e.g. plan)"
        onChange={(event) => onUpdate(path, { ...node, attribute: event.target.value })}
        aria-label="Attribute"
        className="input--attribute"
      />

      <select
        value={node.operator}
        onChange={(event) =>
          onUpdate(path, { ...node, operator: event.target.value as Operator })
        }
        aria-label="Operator"
      >
        {OPERATORS.map((operator) => (
          <option key={operator.value} value={operator.value}>
            {operator.label}
          </option>
        ))}
      </select>

      <input
        type="text"
        value={node.values.map(String).join(multiValue ? ', ' : '')}
        placeholder={multiValue ? 'value, value, value' : 'value'}
        onChange={(event) => setValues(event.target.value)}
        aria-label="Value"
        className="input--value"
      />

      <VisibilityToggle
        visibility={node.visibility}
        onChange={(visibility) => onUpdate(path, { ...node, visibility })}
      />

      {!isRoot && (
        <button type="button" onClick={() => onRemove(path)} className="button button--danger">
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Visibility is the highest-consequence control on this screen, so it is a
 * labelled toggle rather than a dropdown option someone scrolls past. Marking a
 * condition client-visible publishes its attribute and values into every
 * browser bundle that holds a client key.
 */
function VisibilityToggle({
  visibility,
  onChange,
}: {
  visibility: Visibility;
  onChange: (next: Visibility) => void;
}) {
  const isServer = visibility === 'server';
  return (
    <button
      type="button"
      className={`badge ${isServer ? 'badge--server' : 'badge--client'}`}
      onClick={() => onChange(isServer ? 'client' : 'server')}
      title={
        isServer
          ? 'Server-only: stripped from client SDK payloads. Safe for sensitive attributes.'
          : 'Client-visible: this attribute and its values ship in browser bundles.'
      }
    >
      {isServer ? '🔒 server only' : '🌐 client visible'}
    </button>
  );
}
