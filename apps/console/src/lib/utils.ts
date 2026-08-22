import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, resolving Tailwind conflicts so a later utility wins.
 *
 * Plain concatenation would leave both `px-2` and `px-4` in the class list and
 * let source order in the stylesheet decide, which makes component overrides
 * unpredictable.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
