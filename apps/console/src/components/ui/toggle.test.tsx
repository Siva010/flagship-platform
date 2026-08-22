import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Toggle } from './toggle';

/**
 * The flag switch.
 *
 * This is the highest-consequence control in the console — it changes what
 * production serves — so the tests here are about it being a real, reachable
 * control rather than about how it looks.
 */
describe('Toggle', () => {
  it('exposes itself as a switch with its state', () => {
    render(<Toggle checked={false} onChange={() => {}} label="Toggle checkout" />);

    const control = screen.getByRole('switch', { name: 'Toggle checkout' });
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('reports the checked state', () => {
    render(<Toggle checked onChange={() => {}} label="Toggle checkout" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('emits the opposite of its current state', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(<Toggle checked={false} onChange={onChange} label="Toggle checkout" />);
    await user.click(screen.getByRole('switch'));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  // Operable by keyboard, not only by mouse. A styled div would pass a visual
  // review and fail this.
  it('is reachable and operable from the keyboard', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(<Toggle checked={false} onChange={onChange} label="Toggle checkout" />);

    await user.tab();
    expect(screen.getByRole('switch')).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not emit while disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(<Toggle checked={false} onChange={onChange} disabled label="Toggle checkout" />);
    await user.click(screen.getByRole('switch'));

    expect(onChange).not.toHaveBeenCalled();
  });
});
