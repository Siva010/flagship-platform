'use client';

import { cn } from '@/lib/utils';

/**
 * A flag's on/off control.
 *
 * Rendered as a real button with `role="switch"` and `aria-checked` rather than
 * a styled div, so it is reachable by keyboard and announced correctly. This is
 * the highest-consequence control in the console — it changes what production
 * serves — so it should never be operable only by mouse.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-success' : 'bg-line',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
          checked ? 'translate-x-[1.15rem]' : 'translate-x-[0.2rem]',
        )}
      />
    </button>
  );
}
