import { NextResponse } from 'next/server';

/**
 * Server-side proxy to the control plane.
 *
 * The admin token lives here and never reaches the browser. Shipping it to the
 * client would put full write access to every flag in every environment behind
 * a devtools inspection.
 */
const CONTROL_PLANE =
  process.env.CONTROL_PLANE_URL ?? 'http://localhost:4000';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

export async function forward(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<NextResponse> {
  if (ADMIN_TOKEN === '') {
    // Fail loudly rather than making an unauthenticated call that returns a
    // confusing 401 from upstream.
    return NextResponse.json(
      { error: 'ADMIN_TOKEN is not configured on the console server' },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(`${CONTROL_PLANE}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });

    const text = await response.text();
    const payload: unknown = text === '' ? {} : JSON.parse(text);
    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.name === 'TimeoutError'
            ? 'control plane timed out'
            : 'control plane unreachable',
      },
      { status: 502 },
    );
  }
}

/** Rebuilds the upstream query string from the incoming request. */
export function queryOf(request: Request, keys: string[]): string {
  const incoming = new URL(request.url).searchParams;
  const outgoing = new URLSearchParams();
  for (const key of keys) {
    const value = incoming.get(key);
    if (value !== null) outgoing.set(key, value);
  }
  const query = outgoing.toString();
  return query === '' ? '' : `?${query}`;
}
