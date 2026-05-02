export { AuthManager, type AuthManagerOptions } from './auth.js';
export { ErepClient, type ErepClientOptions } from './client.js';
export {
  type SessionRecord,
  type SessionStore,
  FileSessionStore,
  MemorySessionStore,
} from './session-store.js';
export { type PlayerInfo, parseHome } from './parse-home.js';
export { type Logger, ConsoleLogger, MemoryLogger, SilentLogger } from './logger.js';
export {
  ErepError,
  AuthRequiredError,
  BadCredentialsError,
  CaptchaGateError,
  CloudflareChallengeError,
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
