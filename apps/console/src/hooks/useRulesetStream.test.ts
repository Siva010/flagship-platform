import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRulesetStream } from './useRulesetStream';

/**
 * A minimal EventSource stand-in.
 *
 * jsdom has no EventSource, and the behaviour under test is our version
 * handling rather than the browser's transport, so a fake that lets a test
 * deliver frames in a chosen order is both sufficient and more precise than a
 * real connection would be.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;

  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  readonly #listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
    const existing = this.#listeners.get(type) ?? [];
    this.#listeners.set(type, [...existing, handler]);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Test helper: deliver a frame of the given type. */
  emit(type: string, data: string): void {
    for (const handler of this.#listeners.get(type) ?? []) {
      handler({ data } as MessageEvent<string>);
    }
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  fail(state: number): void {
    this.readyState = state;
    this.onerror?.();
  }
}

function latest(): FakeEventSource {
  const instance = FakeEventSource.instances.at(-1);
  if (instance === undefined) throw new Error('no EventSource was created');
  return instance;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRulesetStream', () => {
  it('does not connect without an environment', () => {
    renderHook(() => useRulesetStream(undefined));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('connects to the environment it was given', () => {
    renderHook(() => useRulesetStream('production'));
    expect(latest().url).toContain('env=production');
  });

  it('reports live once the connection opens', () => {
    const { result } = renderHook(() => useRulesetStream('production'));
    expect(result.current.status).toBe('connecting');

    act(() => latest().open());
    expect(result.current.status).toBe('live');
  });

  it('tracks the version from a ruleset frame', () => {
    const { result } = renderHook(() => useRulesetStream('production'));

    act(() => {
      latest().open();
      latest().emit('ruleset', JSON.stringify({ version: 4 }));
    });

    expect(result.current.version).toBe(4);
    expect(result.current.eventCount).toBe(1);
  });

  // The guarantee that matters. Out-of-order delivery is normal on a reconnect
  // that replays history, and a stale frame must not roll the display backwards
  // — the SDK enforces the same rule against its own ruleset.
  it('ignores a frame carrying an older version', () => {
    const { result } = renderHook(() => useRulesetStream('production'));

    act(() => {
      latest().open();
      latest().emit('ruleset', JSON.stringify({ version: 9 }));
      latest().emit('ruleset', JSON.stringify({ version: 3 }));
    });

    expect(result.current.version).toBe(9);
    expect(result.current.eventCount).toBe(1);
  });

  it('ignores a repeat of the version it already holds', () => {
    const { result } = renderHook(() => useRulesetStream('production'));

    act(() => {
      latest().open();
      latest().emit('ruleset', JSON.stringify({ version: 5 }));
      latest().emit('ruleset', JSON.stringify({ version: 5 }));
    });

    expect(result.current.eventCount).toBe(1);
  });

  it('survives an unparseable frame without dropping the connection', () => {
    const { result } = renderHook(() => useRulesetStream('production'));

    act(() => {
      latest().open();
      latest().emit('ruleset', 'not json at all');
      latest().emit('ruleset', JSON.stringify({ version: 2 }));
    });

    expect(result.current.status).toBe('live');
    expect(result.current.version).toBe(2);
  });

  it('surfaces a slow-consumer eviction as reconnecting', () => {
    const { result } = renderHook(() => useRulesetStream('production'));

    act(() => {
      latest().open();
      latest().emit('resync', JSON.stringify({ reason: 'slow_consumer' }));
    });

    // Hiding this would make a stale console look identical to a quiet one.
    expect(result.current.status).toBe('reconnecting');
  });

  it('distinguishes a retrying connection from a closed one', () => {
    const { result } = renderHook(() => useRulesetStream('production'));

    act(() => latest().fail(0));
    expect(result.current.status).toBe('reconnecting');

    act(() => latest().fail(FakeEventSource.CLOSED));
    expect(result.current.status).toBe('error');
  });

  it('closes the connection on unmount', () => {
    const { unmount } = renderHook(() => useRulesetStream('production'));
    const source = latest();

    unmount();
    expect(source.closed).toBe(true);
  });

  it('reconnects and resets its version floor when the environment changes', () => {
    const { result, rerender } = renderHook(
      ({ environment }: { environment: string }) => useRulesetStream(environment),
      { initialProps: { environment: 'production' } },
    );

    act(() => {
      latest().open();
      latest().emit('ruleset', JSON.stringify({ version: 20 }));
    });
    expect(result.current.version).toBe(20);

    rerender({ environment: 'staging' });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().url).toContain('env=staging');

    // A different environment has its own version sequence, so a lower number
    // here is current rather than stale. Carrying the old floor across would
    // silently ignore every early frame from the new environment.
    act(() => {
      latest().open();
      latest().emit('ruleset', JSON.stringify({ version: 2 }));
    });
    expect(result.current.version).toBe(2);
  });
});
