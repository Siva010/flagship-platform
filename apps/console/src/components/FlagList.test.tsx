import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { FlagList } from './FlagList';

// The stream is exercised in its own test file; here it would only add an
// EventSource jsdom does not have.
vi.mock('@/hooks/useRulesetStream', () => ({
  useRulesetStream: () => ({
    status: 'live',
    version: 3,
    lastEvent: undefined,
    eventCount: 0,
  }),
}));

const { flags, updateFlag, publish } = vi.hoisted(() => ({
  flags: vi.fn(),
  updateFlag: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    tenants: () => Promise.resolve({ tenants: [{ id: 't1', slug: 'acme', name: 'Acme' }] }),
    environments: () =>
      Promise.resolve({
        environments: [{ id: 'e1', key: 'production', name: 'Production', version: 3 }],
      }),
    flags,
    updateFlag,
    publish,
  },
}));

const CHECKOUT = {
  key: 'checkout-redesign',
  description: 'New checkout flow',
  enabled: false,
  variations: [
    { key: 'on', value: true },
    { key: 'off', value: false },
  ],
  updatedAt: '2026-08-22T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  flags.mockResolvedValue({ flags: [CHECKOUT] });
  updateFlag.mockResolvedValue({ ...CHECKOUT, enabled: true });
  publish.mockResolvedValue({ version: 4, etag: 'abc', pushed: true });
});

describe('FlagList', () => {
  it('lists flags for the selected environment', async () => {
    render(<FlagList />);
    expect(await screen.findByText('checkout-redesign')).toBeInTheDocument();
    expect(screen.getByText('New checkout flow')).toBeInTheDocument();
  });

  it('sends the toggle to the API with the tenant and environment scope', async () => {
    const user = userEvent.setup();
    render(<FlagList />);
    await screen.findByText('checkout-redesign');

    await user.click(screen.getByRole('switch', { name: /toggle checkout-redesign/i }));

    await waitFor(() =>
      expect(updateFlag).toHaveBeenCalledWith('checkout-redesign', {
        tenantId: 't1',
        environmentId: 'e1',
        enabled: true,
      }),
    );
  });

  it('reflects the toggle immediately, before the request resolves', async () => {
    const user = userEvent.setup();
    // Never resolves, so the only state the UI can be showing is the optimistic one.
    updateFlag.mockReturnValue(new Promise(() => {}));

    render(<FlagList />);
    await screen.findByText('checkout-redesign');

    const control = screen.getByRole('switch', { name: /toggle checkout-redesign/i });
    expect(control).toHaveAttribute('aria-checked', 'false');

    await user.click(control);
    expect(control).toHaveAttribute('aria-checked', 'true');
  });

  // The half of optimism that is easy to skip: if the write fails, the UI must
  // stop claiming a state the server rejected.
  it('reverts the toggle and surfaces the error when the write fails', async () => {
    const user = userEvent.setup();
    updateFlag.mockRejectedValue(new ApiError('flag not found', 404));

    render(<FlagList />);
    await screen.findByText('checkout-redesign');

    const control = screen.getByRole('switch', { name: /toggle checkout-redesign/i });
    await user.click(control);

    await waitFor(() => expect(control).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByText('flag not found')).toBeInTheDocument();
  });

  it('filters by key and by description', async () => {
    const user = userEvent.setup();
    flags.mockResolvedValue({
      flags: [CHECKOUT, { ...CHECKOUT, key: 'search-ranking', description: 'Ranking model' }],
    });

    render(<FlagList />);
    await screen.findByText('checkout-redesign');

    const filter = screen.getByLabelText('Filter flags');
    await user.type(filter, 'ranking');

    expect(screen.getByText('search-ranking')).toBeInTheDocument();
    expect(screen.queryByText('checkout-redesign')).not.toBeInTheDocument();
  });

  it('reports the published version after a publish', async () => {
    const user = userEvent.setup();
    render(<FlagList />);
    await screen.findByText('checkout-redesign');

    await user.click(screen.getByRole('button', { name: /publish ruleset/i }));

    expect(await screen.findByText(/Published v4/)).toBeInTheDocument();
  });

  // A publish that stored but did not reach the data plane is not a failure —
  // SDKs reconcile by polling — but saying so is the difference between a user
  // waiting and a user knowing.
  it('says so when the data plane did not confirm the push', async () => {
    const user = userEvent.setup();
    publish.mockResolvedValue({ version: 4, etag: 'abc', pushed: false });

    render(<FlagList />);
    await screen.findByText('checkout-redesign');
    await user.click(screen.getByRole('button', { name: /publish ruleset/i }));

    expect(await screen.findByText(/reconcile by polling/i)).toBeInTheDocument();
  });

  it('shows a validation failure with the problems the server listed', async () => {
    const user = userEvent.setup();
    publish.mockRejectedValue(
      new ApiError('ruleset is invalid', 422, ['flag "checkout" references unknown segment "ghost"']),
    );

    render(<FlagList />);
    await screen.findByText('checkout-redesign');
    await user.click(screen.getByRole('button', { name: /publish ruleset/i }));

    // "ruleset is invalid" alone is useless; the problems name the offender.
    expect(await screen.findByText(/unknown segment "ghost"/)).toBeInTheDocument();
  });

  it('tells the user when there are no flags at all', async () => {
    flags.mockResolvedValue({ flags: [] });
    render(<FlagList />);
    expect(await screen.findByText(/No flags yet/i)).toBeInTheDocument();
  });
});
