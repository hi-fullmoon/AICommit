export const ERROR_CATEGORIES = Object.freeze({
  CONFIG: 'config',
  GIT_STATE: 'git_state',
  NETWORK: 'network',
  PROVIDER: 'provider',
  RESPONSE_FORMAT: 'response_format',
  SENSITIVE_DATA: 'sensitive_data',
  CONCURRENT_MODIFICATION: 'concurrent_modification',
  INTERNAL: 'internal',
});

export const EXIT_CODES = Object.freeze({
  success: 0,
  [ERROR_CATEGORIES.INTERNAL]: 1,
  [ERROR_CATEGORIES.CONFIG]: 2,
  [ERROR_CATEGORIES.GIT_STATE]: 3,
  [ERROR_CATEGORIES.NETWORK]: 4,
  [ERROR_CATEGORIES.PROVIDER]: 5,
  [ERROR_CATEGORIES.RESPONSE_FORMAT]: 6,
  [ERROR_CATEGORIES.SENSITIVE_DATA]: 7,
  [ERROR_CATEGORIES.CONCURRENT_MODIFICATION]: 8,
});

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export class AicommitError extends Error {
  constructor(category, message, options = {}) {
    super(message);
    this.name = 'AicommitError';
    this.category = category;
    this.exitCode = EXIT_CODES[category] ?? EXIT_CODES.internal;
    this.reported = Boolean(options.reported);
    if (options.data && typeof options.data === 'object' && !Array.isArray(options.data)) {
      this.data = options.data;
    }
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function fail(category, message, options) {
  return new AicommitError(category, message, options);
}

function errorCode(err) {
  return err?.code || err?.cause?.code || '';
}

export function classifyError(err) {
  if (err instanceof AicommitError) return err;

  const message = String(err?.message || err || 'Unknown error');
  const lower = message.toLowerCase();
  const code = errorCode(err);
  if (
    err instanceof TypeError ||
    NETWORK_CODES.has(code) ||
    /timed out|fetch failed|socket|network|dns|econn|enotfound/.test(lower)
  ) {
    return fail(ERROR_CATEGORIES.NETWORK, message, { cause: err });
  }
  if (/^http \d{3}:|streaming api error|rate limit|provider request/.test(lower)) {
    return fail(ERROR_CATEGORIES.PROVIDER, message, { cause: err });
  }
  if (
    /invalid json|invalid conventional commit|empty commit message|empty split plan|failed to parse.*plan|provider returned an invalid response|no text came back/.test(
      lower,
    )
  ) {
    return fail(ERROR_CATEGORIES.RESPONSE_FORMAT, message, { cause: err });
  }
  if (
    /invalid config|failed to (?:parse|read).*?(?:config|team policy)|environment variable|credential helper|unknown provider|provider.*defined|unknown option|missing value|unexpected extra argument|invalid reasoning level|not a valid directory|--output=json/.test(
      lower,
    )
  ) {
    return fail(ERROR_CATEGORIES.CONFIG, message, { cause: err });
  }
  if (
    /git|staged|working tree|nothing to commit|no changes to commit|not a git repository/.test(
      lower,
    )
  ) {
    return fail(ERROR_CATEGORIES.GIT_STATE, message, { cause: err });
  }
  return fail(ERROR_CATEGORIES.INTERNAL, message, { cause: err });
}
