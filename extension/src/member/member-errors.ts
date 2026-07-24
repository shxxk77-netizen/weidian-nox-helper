export const MEMBER_ERROR_CODES = [
  'ACTION_TOKEN_MISSING',
  'ACTION_TOKEN_NOT_FOUND',
  'ACTION_TOKEN_EXPIRED',
  'ACTION_TOKEN_INVALID',
  'ACTION_TOKEN_ALREADY_USED',
  'ACTION_TOKEN_ALREADY_ACQUIRING',
  'ACTION_TOKEN_ALREADY_CONSUMING',
  'ACTION_TOKEN_ALREADY_CONSUMED',
  'ACTION_TOKEN_CONTEXT_MISMATCH',
  'ACTION_TOKEN_SOURCE_NOT_CONFIGURED',
  'MEMBER_STATE_ENDPOINT_NOT_CONFIGURED',
  'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED',
  'SESSION_MISSING',
  'SESSION_CHANGED',
  'SESSION_EXPIRED',
  'SESSION_FINGERPRINT_FAILED',
  'SHOP_ID_MISSING',
  'SHOP_ID_MISMATCH',
  'SERVER_INDEX_INVALID',
  'SERVER_INDEX_MISMATCH',
  'TARGET_INDEX_INVALID',
  'TARGET_INDEX_OUT_OF_RANGE',
  'GRADE_NAMES_INVALID',
  'GRADE_CATALOG_MISMATCH',
  'PERMISSION_DENIED',
  'MEMBER_ACTION_ALREADY_RUNNING',
  'DUPLICATE_CLIENT_REQUEST',
  'CLIENT_REQUEST_ID_MISSING',
  'TARGET_PAGE_URL_MISSING',
  'TARGET_PAGE_MISMATCH',
  'NETWORK_TIMEOUT',
  'NETWORK_ERROR',
  'SERVER_RESPONSE_INVALID',
  'SERVER_STATE_NOT_CHANGED',
  'UNKNOWN_MEMBER_ERROR'
] as const;

export type MemberErrorCode = (typeof MEMBER_ERROR_CODES)[number];

export class MemberActionError extends Error {
  constructor(
    readonly code: MemberErrorCode,
    message = code,
    readonly requestStarted = false
  ) {
    super(message);
    this.name = 'MemberActionError';
  }
}

export function toMemberActionError(error: unknown): MemberActionError {
  if (error instanceof MemberActionError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new MemberActionError('UNKNOWN_MEMBER_ERROR', sanitizeMemberErrorMessage(message));
}

export function sanitizeMemberErrorMessage(message: string): string {
  return String(message)
    .replace(
      /\b(actionToken|accessToken|refreshToken|qrCodeStatusKey|authorization|cookie|sessionId|session|token|ct)\b\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[REDACTED]'
    )
    .slice(0, 400);
}

export function errorCodeToTokenStatus(code: MemberErrorCode) {
  if (code === 'ACTION_TOKEN_EXPIRED') return 'expired' as const;
  if (code === 'ACTION_TOKEN_INVALID' || code === 'ACTION_TOKEN_ALREADY_USED') return 'invalid' as const;
  if (code === 'ACTION_TOKEN_CONTEXT_MISMATCH' || code === 'SESSION_CHANGED') return 'session-mismatch' as const;
  if (code === 'SHOP_ID_MISMATCH') return 'shop-mismatch' as const;
  if (code === 'PERMISSION_DENIED') return 'permission-denied' as const;
  if (code === 'ACTION_TOKEN_NOT_FOUND' || code === 'ACTION_TOKEN_MISSING') return 'not-found' as const;
  if (code === 'ACTION_TOKEN_SOURCE_NOT_CONFIGURED') return 'source-not-configured' as const;
  if (code === 'MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED') return 'write-endpoint-not-configured' as const;
  return 'error' as const;
}
