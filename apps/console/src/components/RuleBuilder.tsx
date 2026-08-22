'use client';

import { useCallback } from 'react';
import type { AttributeValue, Condition, Operator, RuleNode, Visibility } from '@flagship/core';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Recursive rule tree editor.
 *
 * The component tree mirrors the rule tree exactly: a boolean node renders its
 * children by rendering itself. That makes the editor structurally incapable of
 * producing a shape the evaluator cannot read — there is no separate UI model to
 * drift out of sync with the wire format.
 *
 * Edits are immutable and path-based. Each node knows its path from the root and
 * an edit rebuilds the spine down to it. Mutating in place works until two nodes
 * share a reference, at which point editing one silently edits the other.
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

/** Depth is shown by a coloured edge so a deep tree stays readable without deep indentation. */
const DEPTH_EDGE = [
  'border-l-brand',
  'border-l-[#a78bfa]',
  'border-l-[#e879a8]',
  'border-l-warning',
  'border-l-success',
];

export type Path = number[];

function emptyCondition(): Condition {
  return {
    kind: 'condition',
    attribute: '',
    operator: 'eq',
    values: [''],
    // Server is the safe default: a condition the author forgot to classify
    // stays out of browser bundles.
    visibility: 'server',
  };
}

function replaceAt(root: RuleNode, path: Path, next: RuleNode): RuleNode {
  if (path.length === 0) return next;
  const [index, ...rest] = path;
  if (root.kind !== 'and' && root.kind !== 'or' && root.kind !== 'not') return root;
  return {
    ...root,
    children: root.children.map((child, i) => (i === index ? replaceAt(child, rest, next) : child)),
  };
}

function removeAt(root: RuleNode, path: Path): RuleNode {
  if (path.length === 0) return root;
  const [index, ...rest] = path;
  if (root.kind !== 'and' && root.kind !== 'or' && root.kind !== 'not') return root;
  if (rest.length === 0) {
    return { ...root, children: root.children.filter((_, i) => i !== index) };
  }
  return {
    ...root,
    children: root.children.map((child, i) => (i === index ? removeAt(child, rest) : child)),
  };
}

export function RuleBuilder({
  node,
  onChange,
  availableSegments = [],
}: {
  node: RuleNode;
  onChange: (next: RuleNode) => void;
  availableSegments?: string[];
}) {
  const update = useCallback(
    (path: Path, next: RuleNode) => onChange(replaceAt(node, path, next)),
    [node, onChange],
  );
  const remove = useCallback((path: Path) => onChange(removeAt(node, path)), [node, onChange]);

  return (
    <NodeEditor
      node={node}
      path={[]}
      depth={0}
      onUpdate={update}
      onRemove={remove}
      availableSegments={availableSegments}
      isRoot
    />
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
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface p-3">
        <span className="text-sm text-muted">
          {node.negate ? 'is not in segment' : 'is in segment'}
        </span>
        <Select
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
        </Select>
        <Button size="sm" variant="ghost" onClick={() => onUpdate(path, { ...node, negate: !node.negate })}>
          {node.negate ? 'Negated' : 'Negate'}
        </Button>
        {!isRoot && (
          <Button size="sm" variant="ghost" className="text-danger" onClick={() => onRemove(path)}>
            Remove
          </Button>
        )}
      </div>
    );
  }

  const canNest = depth < 8;

  return (
    <div
      className={cn(
        'rounded-md border border-line border-l-[3px] bg-raised/40 p-3',
        DEPTH_EDGE[Math.min(depth, DEPTH_EDGE.length - 1)],
      )}
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Select
          value={node.kind}
          onChange={(event) =>
            onUpdate(path, { ...node, kind: event.target.value as 'and' | 'or' | 'not' })
          }
          aria-label="Boolean operator"
          className="font-semibold"
        >
          <option value="and">ALL of</option>
          <option value="or">ANY of</option>
          <option value="not">NONE of</option>
        </Select>
        <span className="text-xs text-muted">
          {node.children.length} {node.children.length === 1 ? 'condition' : 'conditions'}
        </span>
        {!isRoot && (
          <Button size="sm" variant="ghost" className="ml-auto text-danger" onClick={() => onRemove(path)}>
            Remove group
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2 border-l border-dashed border-line pl-3">
        {node.children.length === 0 && (
          <p className="text-sm italic text-muted">
            {node.kind === 'and' ? 'Empty group — matches everyone.' : 'Empty group — matches no one.'}
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

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => onUpdate(path, { ...node, children: [...node.children, emptyCondition()] })}
        >
          + Condition
        </Button>
        <Button
          size="sm"
          disabled={!canNest}
          title={canNest ? undefined : 'Nesting limit reached'}
          onClick={() =>
            onUpdate(path, {
              ...node,
              children: [...node.children, { kind: 'and', children: [emptyCondition()] }],
            })
          }
        >
          + Group
        </Button>
        <Button
          size="sm"
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
        </Button>
      </div>
    </div>
  );
}

function ConditionEditor({
  node,
  path,
  onUpdate,
  onRemove,
  isRoot,
}: {
  node: Condition;
  path: Path;
  onUpdate: (path: Path, next: RuleNode) => void;
  onRemove: (path: Path) => void;
  isRoot: boolean;
}) {
  const multiValue = node.operator === 'in' || node.operator === 'notIn';

  const setValues = (raw: string): void => {
    const values: AttributeValue[] = multiValue
      ? raw.split(',').map((part) => part.trim()).filter((part) => part !== '')
      : [raw];
    onUpdate(path, { ...node, values });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface p-3">
      <Input
        value={node.attribute}
        placeholder="attribute (e.g. plan)"
        onChange={(event) => onUpdate(path, { ...node, attribute: event.target.value })}
        aria-label="Attribute"
        className="w-44"
      />
      <Select
        value={node.operator}
        onChange={(event) => onUpdate(path, { ...node, operator: event.target.value as Operator })}
        aria-label="Operator"
      >
        {OPERATORS.map((operator) => (
          <option key={operator.value} value={operator.value}>
            {operator.label}
          </option>
        ))}
      </Select>
      <Input
        value={node.values.map(String).join(multiValue ? ', ' : '')}
        placeholder={multiValue ? 'value, value, value' : 'value'}
        onChange={(event) => setValues(event.target.value)}
        aria-label="Value"
        className="min-w-40 flex-1"
      />
      <VisibilityToggle
        visibility={node.visibility}
        onChange={(visibility) => onUpdate(path, { ...node, visibility })}
      />
      {!isRoot && (
        <Button
          size="icon"
          variant="ghost"
          className="text-danger"
          aria-label="Remove condition"
          onClick={() => onRemove(path)}
        >
          ×
        </Button>
      )}
    </div>
  );
}

/**
 * Visibility is the highest-consequence control on this screen, so it is a
 * labelled toggle rather than an option someone scrolls past. Marking a
 * condition client-visible publishes its attribute and values into every browser
 * bundle holding a client key.
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
      onClick={() => onChange(isServer ? 'client' : 'server')}
      title={
        isServer
          ? 'Server-only: stripped from client SDK payloads. Safe for sensitive attributes.'
          : 'Client-visible: this attribute and its values ship in browser bundles.'
      }
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        isServer
          ? 'bg-warning/12 text-warning border-warning/35'
          : 'bg-brand-soft text-brand border-brand/35',
      )}
    >
      {isServer ? '🔒 server only' : '🌐 client visible'}
    </button>
  );
}
