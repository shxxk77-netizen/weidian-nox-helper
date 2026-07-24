import type { MemberPageContext } from '../../../src/common/types';
import { MemberActionError } from './member-errors';

export function validateMemberPageContext(context: MemberPageContext): MemberPageContext {
  let pageUrl: URL;
  try {
    pageUrl = new URL(context.pageUrl);
  } catch {
    throw new MemberActionError('TARGET_PAGE_MISMATCH');
  }
  if (
    pageUrl.protocol !== 'https:' ||
    !/(^|\.)weidian\.com$/i.test(pageUrl.hostname) ||
    !/mkt-h5-member-detail/i.test(pageUrl.pathname)
  ) {
    throw new MemberActionError('TARGET_PAGE_MISMATCH', '현재 페이지가 Weidian Member 상세 페이지가 아닙니다.');
  }
  if (!context.shopId) throw new MemberActionError('SHOP_ID_MISSING');
  if (!context.sessionFingerprint) throw new MemberActionError('SESSION_FINGERPRINT_FAILED');
  if (!Number.isInteger(context.currentServerIndex)) throw new MemberActionError('SERVER_INDEX_INVALID');
  if (context.currentServerIndex < 0 || context.currentServerIndex >= context.gradeCount) {
    throw new MemberActionError('SERVER_INDEX_INVALID');
  }
  if (!Array.isArray(context.gradeNames)) throw new MemberActionError('GRADE_NAMES_INVALID');
  if (context.gradeNames.length !== context.gradeCount || context.gradeCount < 1) {
    throw new MemberActionError('GRADE_CATALOG_MISMATCH');
  }
  return {
    ...context,
    origin: pageUrl.origin,
    gradeNames: [...context.gradeNames],
    currentName: context.currentName?.trim().slice(0, 80) || context.gradeNames[context.currentServerIndex],
    remaining: finiteNonNegative(context.remaining),
    originalProgress: finiteNonNegative(context.originalProgress)
  };
}

function finiteNonNegative(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}
