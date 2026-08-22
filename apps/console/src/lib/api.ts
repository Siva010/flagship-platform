/**
 * Control-plane client.
 *
 * Calls go through Next route handlers under /api rather than to the control
 * plane directly. That keeps the admin token on the server — a token shipped to
 * the browser would be readable by anyone with devtools, and it grants full
 * write access to every flag in every environment.
 */

export interface Tenant {
  id: string;
  slug: string;
  name: string;
}

export interface Environment {
  id: string;
  key: string;
  name: string;
  version: number;
}

export interface FlagSummary {
  key: string;
  description: string;
  enabled: boolean;
  variations: { key: string; value: unknown }[];
  updatedAt: string;
}

export interface FlagDetail extends Omit<FlagSummary, 'variations'> {
  salt: string;
  bucketBy: string;
  variations: { key: string; value: unknown }[];
  defaultVariationKey: string;
  offVariationKey: string;
  rules: TargetingRuleShape[];
  prerequisites: unknown[];
}

export interface TargetingRuleShape {
  id: string;
  description: string;
  when: unknown;
  serve: { variationKey: string } | { rollout: { variationKey: string; weight: number }[] };
}

export interface Segment {
  key: string;
  description: string;
  ruleTree: unknown;
}

export interface AuditEntry {
  action: string;
  resource_type: string;
  resource_key: string;
  actor_email: string;
  previous_value: unknown;
  new_value: unknown;
  created_at: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly problems: string[];

  constructor(message: string, status: number, problems: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.problems = problems;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    // The control plane returns { error, problems? }. Surfacing `problems`
    // matters for a rejected publish: "ruleset is invalid" alone is useless,
    // while the list names the flag and rule at fault.
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      problems?: string[];
    };
    throw new ApiError(
      body.error ?? `request failed with ${response.status}`,
      response.status,
      body.problems ?? [],
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  tenants: () => request<{ tenants: Tenant[] }>('/tenants'),

  environments: (tenantId: string) =>
    request<{ environments: Environment[] }>(
      `/environments?tenantId=${encodeURIComponent(tenantId)}`,
    ),

  flags: (tenantId: string, environmentId: string) =>
    request<{ flags: FlagSummary[] }>(
      `/flags?tenantId=${encodeURIComponent(tenantId)}&environmentId=${encodeURIComponent(environmentId)}`,
    ),

  flag: (tenantId: string, environmentId: string, key: string) =>
    request<FlagDetail>(
      `/flags/${encodeURIComponent(key)}?tenantId=${encodeURIComponent(tenantId)}&environmentId=${encodeURIComponent(environmentId)}`,
    ),

  createFlag: (body: {
    tenantId: string;
    key: string;
    description: string;
    variations: { key: string; value: unknown }[];
    defaultVariationKey: string;
    offVariationKey: string;
  }) => request<{ key: string }>('/flags', { method: 'POST', body: JSON.stringify(body) }),

  updateFlag: (
    key: string,
    body: {
      tenantId: string;
      environmentId: string;
      enabled?: boolean;
      rules?: unknown;
    },
  ) =>
    request<FlagDetail>(`/flags/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  segments: (tenantId: string) =>
    request<{ segments: Segment[] }>(`/segments?tenantId=${encodeURIComponent(tenantId)}`),

  publish: (body: { tenantId: string; environmentId: string; environmentKey: string }) =>
    request<{ version: number; etag: string; pushed: boolean }>('/publish', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  audit: (tenantId: string, resourceKey?: string) =>
    request<{ entries: AuditEntry[] }>(
      `/audit?tenantId=${encodeURIComponent(tenantId)}${
        resourceKey ? `&resourceKey=${encodeURIComponent(resourceKey)}` : ''
      }`,
    ),
};
