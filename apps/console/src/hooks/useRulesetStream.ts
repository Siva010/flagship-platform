'use client';

import { useEffect, useRef, useState } from 'react';

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

export interface RulesetEvent {
  version: number;
  receivedAt: number;
}

export interface StreamState {
  status: StreamStatus;
  version: number | undefined;
  lastEvent: RulesetEvent | undefined;
  eventCount: number;
}

/**
 * Subscribes to the data plane's SSE ruleset channel.
 *
 * Two decisions worth knowing:
 *
 * `EventSource` is used rather than fetch streaming because the browser
 * reconnects on its own and replays `Last-Event-ID` for us — the same
 * resumption path the SDKs use, so the console exercises real behaviour rather
 * than a parallel implementation.
 *
 * Versions are held in a ref as well as state and applied monotonically. A
 * delayed frame carrying an older version must not roll the displayed version
 * backwards, which is the same guarantee the SDK enforces.
 */
export function useRulesetStream(environmentKey: string | undefined): StreamState {
  const [state, setState] = useState<StreamState>({
    status: 'connecting',
    version: undefined,
    lastEvent: undefined,
    eventCount: 0,
  });

  const highestVersion = useRef<number>(-1);

  useEffect(() => {
    if (!environmentKey) return;

    highestVersion.current = -1;
    setState({ status: 'connecting', version: undefined, lastEvent: undefined, eventCount: 0 });

    const source = new EventSource(
      `/api/stream?env=${encodeURIComponent(environmentKey)}`,
    );

    source.onopen = () => {
      setState((previous) => ({ ...previous, status: 'live' }));
    };

    source.addEventListener('ruleset', (event) => {
      let version: number | undefined;
      try {
        version = (JSON.parse((event as MessageEvent<string>).data) as { version?: number })
          .version;
      } catch {
        // A frame we cannot parse is not worth tearing the connection down for.
        return;
      }
      if (typeof version !== 'number' || version <= highestVersion.current) return;

      highestVersion.current = version;
      setState((previous) => ({
        status: 'live',
        version,
        lastEvent: { version, receivedAt: Date.now() },
        eventCount: previous.eventCount + 1,
      }));
    });

    source.addEventListener('resync', () => {
      // The data plane evicted us as a slow consumer. The browser will
      // reconnect; surfacing it rather than hiding it means a stale console is
      // visibly stale.
      setState((previous) => ({ ...previous, status: 'reconnecting' }));
    });

    source.onerror = () => {
      // EventSource reconnects by itself, so this is "degraded", not "dead".
      setState((previous) => ({
        ...previous,
        status: source.readyState === EventSource.CLOSED ? 'error' : 'reconnecting',
      }));
    };

    return () => source.close();
  }, [environmentKey]);

  return state;
}
