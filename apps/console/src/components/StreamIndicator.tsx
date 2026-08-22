'use client';

import { cn } from '@/lib/utils';
import type { StreamState } from '@/hooks/useRulesetStream';

const COPY: Record<StreamState['status'], { label: string; dot: string; help: string }> = {
  connecting: {
    label: 'Connecting',
    dot: 'bg-muted',
    help: 'Opening the ruleset stream.',
  },
  live: {
    label: 'Live',
    dot: 'bg-success',
    help: 'Receiving ruleset updates over SSE.',
  },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'bg-warning',
    help: 'The stream dropped. The browser is retrying, and this view may be stale.',
  },
  error: {
    label: 'Offline',
    dot: 'bg-danger',
    help: 'The stream is closed. Flag states shown here may not match production.',
  },
};

/**
 * Connection state for the ruleset stream.
 *
 * Shown rather than hidden on purpose: a console that silently stops receiving
 * updates looks identical to one where nothing has changed, and an operator
 * deciding whether a kill switch took effect needs to know which they are
 * looking at.
 */
export function StreamIndicator({ state }: { state: StreamState }) {
  const copy = COPY[state.status];

  return (
    <div className="flex items-center gap-2" title={copy.help}>
      <span className="relative flex h-2 w-2">
        {state.status === 'live' && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
        )}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', copy.dot)} />
      </span>
      <span className="text-xs text-muted">
        {copy.label}
        {state.version !== undefined && (
          <span className="font-mono"> · v{state.version}</span>
        )}
      </span>
    </div>
  );
}
