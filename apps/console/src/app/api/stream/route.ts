const DATA_PLANE = process.env.DATA_PLANE_URL ?? 'http://localhost:8080';

/**
 * Proxies the data plane's SSE channel to the browser.
 *
 * The upstream body is piped through untouched rather than read and re-emitted.
 * Buffering it — which is what `await response.text()` or any JSON helper would
 * do — would hold every event until the stream ended, which for a channel
 * designed to stay open forever means the browser receives nothing at all.
 *
 * `dynamic` and `revalidate` are pinned because a cached SSE response is a
 * contradiction: the framework would serve one client's stream to another.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request): Promise<Response> {
  const environment = new URL(request.url).searchParams.get('env');
  if (environment === null || environment === '') {
    return new Response(JSON.stringify({ error: 'env is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Forward the browser's resumption cursor so a reconnect replays only what it
  // missed, exercising the same path the SDKs use.
  const lastEventId = request.headers.get('Last-Event-ID');

  let upstream: Response;
  try {
    upstream = await fetch(
      `${DATA_PLANE}/v1/stream?env=${encodeURIComponent(environment)}`,
      {
        headers: {
          Accept: 'text/event-stream',
          ...(lastEventId === null ? {} : { 'Last-Event-ID': lastEventId }),
        },
        // The client's abort signal must reach the data plane, or closing a
        // browser tab would leak a connection for the process lifetime.
        signal: request.signal,
        cache: 'no-store',
      },
    );
  } catch {
    return new Response(JSON.stringify({ error: 'data plane unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!upstream.ok || upstream.body === null) {
    return new Response(JSON.stringify({ error: 'data plane returned an error' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeats proxy buffering, which would otherwise hold frames until a
      // buffer fills and destroy the latency this channel exists for.
      'X-Accel-Buffering': 'no',
    },
  });
}
