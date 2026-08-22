import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border',
  {
    variants: {
      tone: {
        neutral: 'bg-raised text-muted border-line',
        on: 'bg-success/12 text-success border-success/35',
        off: 'bg-raised text-muted border-line',
        server: 'bg-warning/12 text-warning border-warning/35',
        client: 'bg-brand-soft text-brand border-brand/35',
        danger: 'bg-danger/12 text-danger border-danger/35',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
