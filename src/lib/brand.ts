/**
 * The shared 딴쌤 header (brand README in ddanssaem-brand). Until the ddanssaem.com hub opens, the logo goes to this
 * app's first screen and the menu shows only 클래스 and 보드. With HUB_READY=1 (a redeploy) the logo goes to the hub and
 * the 홈 item returns; the hub address follows DDANSSAEM_HUB_URL (beta on the preview). Both come in through
 * next.config.ts at build time. 수업 도구 stays hidden until the first tool exists (brand README).
 */
export const HUB_READY = process.env.HUB_READY === '1';
export const HUB_URL = (process.env.HUB_HOME_URL || 'https://ddanssaem.com').replace(/\/+$/, '');
export const CLASS_HOME = '/classes';
export const BOARD_URL = 'https://board.ddanssaem.com';
export const TOOLS_READY = false;
export const TOOLS_URL = `${HUB_URL}/#tools`;
/** The terms and privacy policy are the 딴쌤 hub's, one for every 딴쌤 app (in force from 2026-10-16). */
export const TERMS_URL = `${HUB_URL}/terms`;
export const PRIVACY_URL = `${HUB_URL}/privacy`;
