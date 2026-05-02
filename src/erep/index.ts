export { AuthManager, type AuthManagerOptions } from './auth.js';
export { ErepClient, type ErepClientOptions } from './client.js';
export {
  type SessionRecord,
  type SessionStore,
  FileSessionStore,
  MemorySessionStore,
} from './session-store.js';
export { PostgresSessionStore } from './postgres-session-store.js';
export { type PlayerInfo, parseHome } from './parse-home.js';
export { type Logger, ConsoleLogger, MemoryLogger, SilentLogger } from './logger.js';
export {
  ErepError,
  AuthRequiredError,
  BadCredentialsError,
  CaptchaGateError,
  CloudflareChallengeError,
  ErepHttpError,
  LoginLockedOutError,
  MissingCsrfError,
  SessionStoreError,
} from './errors.js';
export { CookieJar } from './cookie-jar.js';
export {
  DEFAULT_USER_AGENT,
  navigationHeaders,
  topLevelHeaders,
  xhrHeaders,
} from './headers.js';
export type {
  CampaignsResponse,
  Battle,
  BattleZone,
  WallInfo,
  SideInfo,
  CountryInfo,
} from './types/campaigns.js';
export { findAirZoneId } from './types/campaigns.js';
export type {
  BattleStatsResponse,
  DivisionStats,
  FighterRow,
  TopDamageEntry,
} from './types/battle-stats.js';
export { flattenTopDamage } from './types/battle-stats.js';
export { type CitizenProfile, parseCitizenProfileJson } from './types/citizen-profile.js';
