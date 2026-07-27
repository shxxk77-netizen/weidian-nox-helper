import { createHash } from 'node:crypto';
import type {
  BrowserMemberApiContractObservation,
  MemberApiContractSource,
  MemberApiContractTokenPlacement
} from './types';

const MAX_SHAPE_DEPTH = 5;
const MAX_KEYS = 100;
const SAFE_SHAPE_WORDS = new Set([
  'array',
  'binary',
  'boolean',
  'empty',
  'null',
  'number',
  'object',
  'string',
  'undefined',
  'unavailable'
]);

export function normalizeMemberApiContractObservation(
  value: unknown
): BrowserMemberApiContractObservation {
  if (!value || typeof value !== 'object') {
    throw new Error('Member API 관찰 데이터가 올바르지 않습니다.');
  }
  const envelope = value as Record<string, unknown>;
  const raw =
    envelope.observation && typeof envelope.observation === 'object'
      ? envelope.observation as Record<string, unknown>
      : envelope;
  const endpoint = normalizeWeidianEndpoint(raw.url);
  const method = normalizeMethod(raw.method);
  const source = normalizeSource(envelope.source ?? raw.source);
  const observedAtIso = normalizeDate(raw.observedAtIso);
  const queryKeys = normalizeKeys(raw.queryKeys);
  const requestHeaderNames = normalizeNames(raw.requestHeaderNames);
  const responseHeaderNames = normalizeNames(raw.responseHeaderNames);
  const requestBodyShape = normalizeContractShape(raw.requestBodyShape);
  const queryShape = normalizeContractShape(raw.queryShape);
  const responseBodyShape = normalizeContractShape(raw.responseBodyShape);
  const tokenPlacement = normalizeTokenPlacement(raw.tokenPlacement);
  const page = normalizeOptionalWeidianPage(envelope.pageUrl ?? raw.page);
  const shopId = normalizeShopId(envelope.shopId ?? raw.shopId);
  const requestHeaderMetadata = normalizeHeaderMetadata(raw.requestHeaderMetadata);
  const status = normalizeStatus(raw.status);
  const signature = JSON.stringify({
    source,
    method,
    endpoint,
    queryKeys,
    queryShape,
    requestHeaderNames,
    requestHeaderMetadata,
    requestBodyShape,
    tokenPlacement
  });
  const id = createHash('sha256').update(signature).digest('hex').slice(0, 20);
  const normalized: BrowserMemberApiContractObservation = {
    id,
    observerVersion: normalizeObserverVersion(raw.observerVersion),
    source,
    observedAtIso,
    lastObservedAtIso: observedAtIso,
    sampleCount: 1,
    page,
    shopId,
    transport: normalizeLabel(raw.transport, 'unknown', 40),
    method,
    url: endpoint,
    queryKeys,
    queryShape,
    requestHeaderNames,
    requestHeaderMetadata,
    requestBodyShape,
    tokenPlacement,
    chromeSessionCookie:
      raw.chromeSessionCookie === true || requestHeaderNames.includes('cookie'),
    credentials: normalizeOptionalLabel(raw.credentials, 40),
    status,
    outcome: normalizeOptionalLabel(raw.outcome, 40),
    errorName: normalizeOptionalLabel(raw.errorName, 120),
    responseHeaderNames,
    responseContentType: normalizeContentType(raw.responseContentType),
    responseBodyShape,
    curlTemplate: ''
  };
  normalized.curlTemplate = createMemberApiCurlTemplate(normalized);
  return normalized;
}

export function createMemberApiCurlTemplate(
  contract: Omit<BrowserMemberApiContractObservation, 'curlTemplate'>
    | BrowserMemberApiContractObservation
): string {
  const lines = [`curl --request ${contract.method} ${shellQuote(withQueryPlaceholders(contract.url, contract.queryKeys))}`];
  const contentType =
    contract.requestHeaderMetadata?.contentType ||
    (contract.requestBodyShape === undefined ? undefined : 'application/json');
  if (contentType) lines.push(`  --header ${shellQuote(`Content-Type: ${contentType}`)}`);
  if (contract.requestHeaderMetadata?.origin) {
    lines.push(`  --header ${shellQuote(`Origin: ${contract.requestHeaderMetadata.origin}`)}`);
  }
  if (contract.requestHeaderMetadata?.referer) {
    lines.push(`  --header ${shellQuote(`Referer: ${contract.requestHeaderMetadata.referer}`)}`);
  }
  if (contract.tokenPlacement === 'header') {
    const tokenHeader =
      contract.requestHeaderNames.find((name) => /^(?:(?:x-)?action[-_]?token|wdtoken)$/i.test(name)) ||
      'X-Action-Token';
    lines.push(`  --header ${shellQuote(`${tokenHeader}: <ACTION_TOKEN>`)}`);
  }
  const generatedHeaders = new Set([
    'content-type',
    'origin',
    'referer',
    'cookie',
    ...contract.requestHeaderNames.filter((name) => /^(?:(?:x-)?action[-_]?token|wdtoken)$/i.test(name))
  ]);
  for (const headerName of contract.requestHeaderNames) {
    if (generatedHeaders.has(headerName) || isBrowserManagedHeader(headerName)) continue;
    lines.push(`  --header ${shellQuote(`${headerName}: <${placeholderName(headerName)}>`)}`);
  }
  if (contract.chromeSessionCookie) {
    lines.push(`  --cookie ${shellQuote('<CHROME_SESSION_COOKIE>')}`);
  }
  if (contract.method !== 'GET' && contract.requestBodyShape !== undefined) {
    if (contentType === 'application/x-www-form-urlencoded') {
      for (const key of topLevelKeys(contract.requestBodyShape)) {
        lines.push(`  --data-urlencode ${shellQuote(`${key}=<${placeholderName(key)}>`)}`);
      }
    } else {
      lines.push(`  --data-raw ${shellQuote(JSON.stringify(shapeToTemplate(contract.requestBodyShape), null, 2))}`);
    }
  }
  return lines.join(' \\\n');
}

function normalizeWeidianEndpoint(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('Member API endpoint URL이 올바르지 않습니다.');
  }
  if (url.protocol !== 'https:' || !/(^|\.)weidian\.com$/i.test(url.hostname)) {
    throw new Error('Weidian HTTPS endpoint만 관찰 데이터로 저장할 수 있습니다.');
  }
  return `${url.origin}${url.pathname}`;
}

function normalizeOptionalWeidianPage(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)weidian\.com$/i.test(url.hostname)) return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function normalizeMethod(value: unknown): string {
  const method = String(value || 'GET').trim().toUpperCase();
  return /^(GET|POST|PUT|PATCH|DELETE)$/.test(method) ? method : 'GET';
}

function normalizeSource(value: unknown): MemberApiContractSource {
  return value === 'page-main' ? 'page-main' : 'chrome-web-request';
}

function normalizeTokenPlacement(value: unknown): MemberApiContractTokenPlacement {
  return value === 'header' ||
    value === 'body' ||
    value === 'query' ||
    value === 'response'
    ? value
    : 'not-observed';
}

function normalizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^[a-z0-9_.-]{1,100}$/i.test(item))
  )].sort().slice(0, MAX_KEYS);
}

function normalizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => /^[a-z0-9_.-]{1,100}$/i.test(item))
  )].sort().slice(0, MAX_KEYS);
}

function normalizeContractShape(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (depth >= MAX_SHAPE_DEPTH) return Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;
  if (Array.isArray(value)) {
    return value.length ? [normalizeContractShape(value[0], depth + 1)] : ['empty'];
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => /^[\w.-]{1,100}$/u.test(key))
        .slice(0, MAX_KEYS)
        .map(([key, child]) => [key, normalizeContractShape(child, depth + 1)])
    );
  }
  if (typeof value === 'string' && SAFE_SHAPE_WORDS.has(value)) return value;
  return typeof value;
}

function normalizeHeaderMetadata(value: unknown): BrowserMemberApiContractObservation['requestHeaderMetadata'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const contentType = normalizeContentType(raw.contentType);
  const origin = normalizeOptionalWeidianPage(raw.origin);
  const referer = normalizeOptionalWeidianPage(raw.referer);
  return contentType || origin || referer ? { contentType, origin, referer } : undefined;
}

function normalizeContentType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const contentType = value.split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType) ? contentType.slice(0, 100) : undefined;
}

function normalizeShopId(value: unknown): string | undefined {
  const shopId = String(value || '').trim();
  return /^\d{6,20}$/.test(shopId) ? shopId : undefined;
}

function normalizeStatus(value: unknown): number | undefined {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function normalizeDate(value: unknown): string {
  const date = new Date(String(value || ''));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalizeObserverVersion(value: unknown): number {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 1;
}

function normalizeLabel(value: unknown, fallback: string, max: number): string {
  return normalizeOptionalLabel(value, max) || fallback;
}

function normalizeOptionalLabel(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  return label ? label.slice(0, max) : undefined;
}

function withQueryPlaceholders(rawUrl: string, queryKeys: string[]): string {
  if (!queryKeys.length) return rawUrl;
  const query = queryKeys
    .map((key) => `${encodeURIComponent(key)}=<${placeholderName(key)}>`)
    .join('&');
  return `${rawUrl}?${query}`;
}

function shapeToTemplate(value: unknown, key = 'VALUE'): unknown {
  if (Array.isArray(value)) return [shapeToTemplate(value[0], key)];
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, shapeToTemplate(child, childKey)])
    );
  }
  return `<${placeholderName(key)}>`;
}

function topLevelKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : ['BODY'];
}

function isBrowserManagedHeader(name: string): boolean {
  return name === 'accept' ||
    name === 'accept-encoding' ||
    name === 'accept-language' ||
    name === 'connection' ||
    name === 'content-length' ||
    name === 'host' ||
    name === 'priority' ||
    name === 'user-agent' ||
    name.startsWith('sec-');
}

function placeholderName(value: string): string {
  return String(value || 'VALUE')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'VALUE';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
