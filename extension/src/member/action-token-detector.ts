import type { MemberActionType } from '../../../src/common/types';

export type ActionTokenPlacement = 'query' | 'header' | 'body' | 'response' | 'bootstrap';

export interface DetectedActionToken {
  rawToken: string;
  keyPath: string;
  placement: ActionTokenPlacement;
  action?: Exclude<MemberActionType, 'sync-vip-grades'>;
  issuedAtEpochMs: number;
  expiresAtEpochMs?: number;
  oneTime: boolean;
  source: 'page-bootstrap' | 'network-request' | 'network-response';
}

export interface DetectActionTokenOptions {
  placement: ActionTokenPlacement;
  url?: string;
  now?: number;
}

const ACTION_TOKEN_KEY = /^(?:(?:x[-_])?action[-_]?token|wdtoken)$/i;
const MAX_DEPTH = 6;
const MAX_OBJECT_KEYS = 160;
const MAX_TOKEN_LENGTH = 4096;

export function detectActionTokens(
  input: unknown,
  options: DetectActionTokenOptions
): DetectedActionToken[] {
  const now = options.now ?? Date.now();
  const detected: DetectedActionToken[] = [];
  const seen = new Set<string>();
  const root = decodeStructuredValue(input);

  visit(root, [], undefined, 0);
  return detected;

  function visit(
    value: unknown,
    path: string[],
    parent: Record<string, unknown> | undefined,
    depth: number
  ): void {
    if (depth > MAX_DEPTH || value === null || value === undefined) return;
    const decoded = decodeStructuredValue(value);
    if (decoded !== value) {
      visit(decoded, path, parent, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, MAX_OBJECT_KEYS).forEach((item, index) => {
        visit(item, [...path, String(index)], undefined, depth + 1);
      });
      return;
    }
    if (!isRecord(value)) return;

    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [key, child] of entries) {
      if (ACTION_TOKEN_KEY.test(key)) {
        const rawToken = normalizeToken(child);
        if (rawToken && !seen.has(rawToken)) {
          seen.add(rawToken);
          const metadata = tokenMetadata(value, root, now);
          detected.push({
            rawToken,
            keyPath: [...path, key].join('.'),
            placement: options.placement,
            action: inferMemberAction(value, options.url),
            issuedAtEpochMs: metadata.issuedAtEpochMs,
            expiresAtEpochMs: metadata.expiresAtEpochMs,
            oneTime: /^wdtoken$/i.test(key) ? false : metadata.oneTime,
            source:
              options.placement === 'bootstrap'
                ? 'page-bootstrap'
                : options.placement === 'response'
                  ? 'network-response'
                  : 'network-request'
          });
        }
      }
      visit(child, [...path, key], value, depth + 1);
    }
  }
}

export function decodeStructuredValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || text.length > 1_000_000) return value;
  if (
    (text.startsWith('{') && text.endsWith('}')) ||
    (text.startsWith('[') && text.endsWith(']'))
  ) {
    try {
      return JSON.parse(text);
    } catch {
      return value;
    }
  }
  if (!text.includes('=')) return value;
  try {
    const params = new URLSearchParams(text);
    const entries = [...params.entries()];
    if (!entries.length) return value;
    return Object.fromEntries(entries);
  } catch {
    return value;
  }
}

export function inferMemberAction(
  value: unknown,
  url = ''
): Exclude<MemberActionType, 'sync-vip-grades'> | undefined {
  const text = [
    url,
    ...collectActionHints(value)
  ].join(' ').toLowerCase();
  if (/(?:reset|restore|clear|initialize)[-_ /]?(?:vip|member|grade|level|setting)?/.test(text)) {
    return 'reset-vip-settings';
  }
  if (/(?:save|update|modify|change|set)[-_ /]?(?:vip|member|grade|level|setting)?/.test(text)) {
    return 'save-vip-settings';
  }
  if (/(?:vip|member)[-_ /]?(?:save|update|modify|change|set)/.test(text)) {
    return 'save-vip-settings';
  }
  return undefined;
}

function collectActionHints(value: unknown, depth = 0): string[] {
  if (depth > 3 || !isRecord(value)) return [];
  const hints: string[] = [];
  for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (/^(?:action|command|operation|event|type|name)$/i.test(key) && typeof child === 'string') {
      hints.push(child.slice(0, 200));
    } else if (isRecord(child)) {
      hints.push(...collectActionHints(child, depth + 1));
    }
  }
  return hints;
}

function tokenMetadata(
  local: Record<string, unknown>,
  root: unknown,
  now: number
): {
  issuedAtEpochMs: number;
  expiresAtEpochMs?: number;
  oneTime: boolean;
} {
  const rootRecord = isRecord(root) ? root : {};
  const issuedAtEpochMs =
    normalizeEpoch(readFirst(local, ['issuedAtEpochMs', 'issuedAt', 'issueTime', 'createdAt'])) ??
    normalizeEpoch(readFirst(rootRecord, ['issuedAtEpochMs', 'issuedAt', 'issueTime', 'createdAt'])) ??
    now;
  const explicitExpiry =
    normalizeEpoch(readFirst(local, ['expiresAtEpochMs', 'expiresAt', 'expireAt', 'expiredAt', 'expiration'])) ??
    normalizeEpoch(readFirst(rootRecord, ['expiresAtEpochMs', 'expiresAt', 'expireAt', 'expiredAt', 'expiration']));
  const expiresIn =
    normalizeDuration(readFirst(local, ['expiresInMs', 'expiresIn', 'expireIn', 'ttl', 'ttlSeconds'])) ??
    normalizeDuration(readFirst(rootRecord, ['expiresInMs', 'expiresIn', 'expireIn', 'ttl', 'ttlSeconds']));
  const oneTimeValue =
    readFirst(local, ['oneTime', 'singleUse', 'oneTimeUse', 'once']) ??
    readFirst(rootRecord, ['oneTime', 'singleUse', 'oneTimeUse', 'once']);
  return {
    issuedAtEpochMs,
    expiresAtEpochMs: explicitExpiry ?? (expiresIn === undefined ? undefined : issuedAtEpochMs + expiresIn),
    oneTime: oneTimeValue === undefined ? true : Boolean(oneTimeValue)
  };
}

function readFirst(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const actual = Object.keys(record).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actual !== undefined) return record[actual];
  }
  return undefined;
}

function normalizeEpoch(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  if (numeric < 10_000_000_000) return Math.round(numeric * 1000);
  return Math.round(numeric);
}

function normalizeDuration(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.round(numeric <= 86_400 ? numeric * 1000 : numeric);
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const token = value.trim();
  if (
    token.length < 4 ||
    token.length > MAX_TOKEN_LENGTH ||
    token === '[REDACTED]' ||
    /^__CONFIGURE_/i.test(token)
  ) {
    return undefined;
  }
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
