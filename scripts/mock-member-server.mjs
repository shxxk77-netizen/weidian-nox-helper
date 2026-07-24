import {
  MEMBER_LAB_MODES,
  createMemberSecurityLabServer
} from './member-security-lab-core.mjs';

const host = '127.0.0.1';
const port = readPort(process.env.MEMBER_LAB_PORT);
const mode = readMode(process.env.MEMBER_LAB_MODE);
const { server } = createMemberSecurityLabServer({ mode });

server.listen(port, host, () => {
  console.log(`노무현 Member 보안 랩 (${mode}): http://${host}:${port}`);
  console.log('세션 쿠키·actionToken 원문은 로그에 기록하지 않습니다.');
  console.log('실제 Weidian 쓰기 어댑터: disabled (MEMBER_WRITE_ENDPOINT_NOT_CONFIGURED)');
});

function readMode(value) {
  if (!value) return MEMBER_LAB_MODES.FIXED;
  if (value === MEMBER_LAB_MODES.VULNERABLE || value === MEMBER_LAB_MODES.FIXED) return value;
  throw new Error(`MEMBER_LAB_MODE는 vulnerable 또는 fixed여야 합니다: ${value}`);
}

function readPort(value) {
  if (!value) return 4173;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`MEMBER_LAB_PORT가 올바르지 않습니다: ${value}`);
  }
  return port;
}
