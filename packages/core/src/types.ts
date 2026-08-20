/** Wire contract shared by the control plane, data plane, console, and every SDK. */

export type AttributeValue = string | number | boolean | null;

export type Operator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'notIn'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'matches'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'semverGt'
  | 'semverLt';

export interface Condition {
  kind: 'condition';
  attribute: string;
  operator: Operator;
  values: AttributeValue[];
  /** Server-only rules are stripped from client-key payloads. */
  visibility: Visibility;
}

export interface BooleanNode {
  kind: 'and' | 'or' | 'not';
  children: RuleNode[];
}

export interface SegmentRef {
  kind: 'segment';
  segmentKey: string;
  negate: boolean;
}

export type RuleNode = Condition | BooleanNode | SegmentRef;

export type Visibility = 'client' | 'server';

export interface Variation {
  key: string;
  value: unknown;
}

/** Weights are in basis points of 100000 and must sum to 100000. */
export interface Distribution {
  variationKey: string;
  weight: number;
}

export interface TargetingRule {
  id: string;
  description: string;
  when: RuleNode;
  /** Serve a fixed variation, or split traffic across variations. */
  serve: { variationKey: string } | { rollout: Distribution[] };
}

export interface Prerequisite {
  flagKey: string;
  variationKey: string;
}

export interface Flag {
  key: string;
  enabled: boolean;
  /** Bucketing salt. Stable for the life of the flag; changing it reshuffles everyone. */
  salt: string;
  variations: Variation[];
  defaultVariationKey: string;
  offVariationKey: string;
  prerequisites: Prerequisite[];
  rules: TargetingRule[];
  /** Attribute used for bucketing, e.g. "userKey" or "accountId". */
  bucketBy: string;
}

export interface Segment {
  key: string;
  when: RuleNode;
}

/**
 * A full ruleset snapshot for one environment.
 * `version` is monotonic per environment — SDKs must reject any lower version.
 */
export interface RulesetSnapshot {
  environmentKey: string;
  version: number;
  flags: Flag[];
  segments: Segment[];
  servedAt: string;
}

export interface EvaluationContext {
  key: string;
  attributes: Record<string, AttributeValue>;
}

export type EvaluationReason =
  | { kind: 'off' }
  | { kind: 'prerequisiteFailed'; flagKey: string }
  | { kind: 'ruleMatch'; ruleId: string }
  | { kind: 'default' }
  | { kind: 'error'; message: string };

export interface EvaluationResult<T = unknown> {
  value: T;
  variationKey: string;
  reason: EvaluationReason;
  /** Present when the result came from a percentage rollout. */
  bucket?: number;
}

export interface ExposureEvent {
  flagKey: string;
  variationKey: string;
  contextKey: string;
  environmentKey: string;
  rulesetVersion: number;
  timestamp: string;
  /** Idempotency key for at-least-once delivery. */
  dedupeKey: string;
}
