import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { RuleNode } from '@flagship/core';
import { RuleBuilder } from './RuleBuilder';

/**
 * Wraps the builder in state so edits round-trip, since the component is
 * controlled and an uncontrolled render would never show the result of a click.
 */
function Harness({
  initial,
  onTree,
  segments = [],
}: {
  initial: RuleNode;
  onTree?: (tree: RuleNode) => void;
  segments?: string[];
}) {
  const [tree, setTree] = useState<RuleNode>(initial);
  return (
    <RuleBuilder
      node={tree}
      onChange={(next) => {
        setTree(next);
        onTree?.(next);
      }}
      availableSegments={segments}
    />
  );
}

const EMPTY: RuleNode = { kind: 'and', children: [] };

const CONDITION: RuleNode = {
  kind: 'condition',
  attribute: 'plan',
  operator: 'eq',
  values: ['pro'],
  visibility: 'client',
};

describe('RuleBuilder', () => {
  it('explains what an empty group means', () => {
    render(<Harness initial={EMPTY} />);
    // An empty AND matching everyone is boolean-algebra convention but a
    // genuine surprise, so the UI states it rather than leaving it implicit.
    expect(screen.getByText(/matches everyone/i)).toBeInTheDocument();
  });

  it('warns that an empty ANY group matches nobody', async () => {
    const user = userEvent.setup();
    render(<Harness initial={EMPTY} />);

    await user.selectOptions(screen.getByLabelText('Boolean operator'), 'or');
    expect(screen.getByText(/matches no one/i)).toBeInTheDocument();
  });

  it('adds a condition', async () => {
    const user = userEvent.setup();
    render(<Harness initial={EMPTY} />);

    await user.click(screen.getByRole('button', { name: '+ Condition' }));
    expect(screen.getByLabelText('Attribute')).toBeInTheDocument();
  });

  // The security-relevant default. A condition whose visibility the author
  // never set must not end up in browser bundles.
  it('defaults a new condition to server-only', async () => {
    const user = userEvent.setup();
    const onTree = vi.fn();
    render(<Harness initial={EMPTY} onTree={onTree} />);

    await user.click(screen.getByRole('button', { name: '+ Condition' }));

    const tree = onTree.mock.calls.at(-1)?.[0] as RuleNode;
    expect(tree.kind).toBe('and');
    if (tree.kind !== 'and') throw new Error('expected an and node');
    expect(tree.children[0]).toMatchObject({ visibility: 'server' });
  });

  it('toggles a condition between server and client visibility', async () => {
    const user = userEvent.setup();
    const onTree = vi.fn();
    render(<Harness initial={{ kind: 'and', children: [CONDITION] }} onTree={onTree} />);

    await user.click(screen.getByRole('button', { name: /client visible/i }));

    const tree = onTree.mock.calls.at(-1)?.[0] as RuleNode;
    if (tree.kind !== 'and') throw new Error('expected an and node');
    expect(tree.children[0]).toMatchObject({ visibility: 'server' });
  });

  it('edits an attribute without disturbing its siblings', async () => {
    const user = userEvent.setup();
    const onTree = vi.fn();
    const second = { ...CONDITION, attribute: 'region' } as RuleNode;

    render(<Harness initial={{ kind: 'and', children: [CONDITION, second] }} onTree={onTree} />);

    const inputs = screen.getAllByLabelText('Attribute');
    await user.type(inputs[0]!, 'X');

    const tree = onTree.mock.calls.at(-1)?.[0] as RuleNode;
    if (tree.kind !== 'and') throw new Error('expected an and node');
    // Path-based immutable edits: touching one child must leave the other
    // exactly as it was. Shared references would corrupt both.
    expect(tree.children[1]).toMatchObject({ attribute: 'region' });
  });

  it('removes the right child when several are present', async () => {
    const user = userEvent.setup();
    const onTree = vi.fn();
    const keep = { ...CONDITION, attribute: 'keep-me' } as RuleNode;
    const drop = { ...CONDITION, attribute: 'drop-me' } as RuleNode;

    render(<Harness initial={{ kind: 'and', children: [keep, drop] }} onTree={onTree} />);

    const removes = screen.getAllByRole('button', { name: 'Remove condition' });
    await user.click(removes[1]!);

    const tree = onTree.mock.calls.at(-1)?.[0] as RuleNode;
    if (tree.kind !== 'and') throw new Error('expected an and node');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({ attribute: 'keep-me' });
  });

  it('nests a group and edits inside it', async () => {
    const user = userEvent.setup();
    const onTree = vi.fn();
    render(<Harness initial={EMPTY} onTree={onTree} />);

    await user.click(screen.getByRole('button', { name: '+ Group' }));

    const tree = onTree.mock.calls.at(-1)?.[0] as RuleNode;
    if (tree.kind !== 'and') throw new Error('expected an and node');
    const child = tree.children[0]!;
    expect(child.kind).toBe('and');
    if (child.kind !== 'and') throw new Error('expected a nested and node');
    expect(child.children[0]).toMatchObject({ kind: 'condition' });
  });

  it('splits comma-separated values only for set operators', async () => {
    const user = userEvent.setup();
    const onTree = vi.fn();
    render(<Harness initial={{ kind: 'and', children: [CONDITION] }} onTree={onTree} />);

    await user.selectOptions(screen.getByLabelText('Operator'), 'in');
    await user.clear(screen.getByLabelText('Value'));
    await user.type(screen.getByLabelText('Value'), 'eu, us');

    const tree = onTree.mock.calls.at(-1)?.[0] as RuleNode;
    if (tree.kind !== 'and') throw new Error('expected an and node');
    expect(tree.children[0]).toMatchObject({ values: ['eu', 'us'] });
  });

  it('offers the segments it was given', () => {
    render(
      <Harness
        initial={{ kind: 'and', children: [{ kind: 'segment', segmentKey: 'staff', negate: false }] }}
        segments={['staff', 'beta']}
      />,
    );

    const select = screen.getByLabelText('Segment');
    expect(select).toHaveValue('staff');
    expect(screen.getByRole('option', { name: 'beta' })).toBeInTheDocument();
  });

  it('does not offer to remove the root node', () => {
    render(<Harness initial={EMPTY} />);
    expect(screen.queryByRole('button', { name: 'Remove group' })).not.toBeInTheDocument();
  });
});
