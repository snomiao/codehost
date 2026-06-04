// Room-token complexity policy, shared by the browser, the CLI daemon, and the
// Cloudflare Worker. The token is a bearer secret — anyone who has it can see
// and connect to every server in the room — so a guessable token is a real
// compromise. These rules are the single source of truth; all three entry
// points (CLI `serve`, the codehost.dev token form, and the Worker's /room
// route) validate against them so a weak token can't slip in from any side.

/** Minimum token length. Short tokens are brute-forceable bearer secrets. */
export const TOKEN_MIN_LENGTH = 12;
/** Upper bound, mostly to keep URLs and storage sane. */
export const TOKEN_MAX_LENGTH = 256;
/** How many of {lowercase, uppercase, digit, symbol} a token must mix. */
export const TOKEN_MIN_CHAR_CLASSES = 3;

/** Human-readable summary of the policy, for CLI errors and the UI hint. */
export const TOKEN_REQUIREMENTS =
  `at least ${TOKEN_MIN_LENGTH} characters, no spaces, ` +
  `mixing at least ${TOKEN_MIN_CHAR_CLASSES} of: lowercase, uppercase, digits, symbols`;

// Obviously weak tokens that technically pass the structural rules but are the
// first things an attacker tries. Compared case-insensitively after trimming.
const WEAK_TOKENS = new Set([
  "changeme1234",
  "password1234",
  "codehost1234",
  "letmein12345",
]);

const CLASS_PATTERNS = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];

export interface TokenCheck {
  ok: boolean;
  /** Present when `ok` is false: why the token was rejected. */
  reason?: string;
}

/**
 * Validate a room token against the complexity policy. Does not trim — callers
 * should pass the already-trimmed token (a leading/trailing space is itself a
 * footgun in a shared secret, so embedded whitespace is rejected outright).
 */
export function validateToken(token: string): TokenCheck {
  if (token.length < TOKEN_MIN_LENGTH) {
    return { ok: false, reason: `token must be at least ${TOKEN_MIN_LENGTH} characters` };
  }
  if (token.length > TOKEN_MAX_LENGTH) {
    return { ok: false, reason: `token must be at most ${TOKEN_MAX_LENGTH} characters` };
  }
  if (/\s/.test(token)) {
    return { ok: false, reason: "token must not contain whitespace" };
  }
  const classes = CLASS_PATTERNS.filter((re) => re.test(token)).length;
  if (classes < TOKEN_MIN_CHAR_CLASSES) {
    return {
      ok: false,
      reason: `token must mix at least ${TOKEN_MIN_CHAR_CLASSES} of: lowercase, uppercase, digits, symbols`,
    };
  }
  if (WEAK_TOKENS.has(token.toLowerCase())) {
    return { ok: false, reason: "token is too common; choose a unique secret" };
  }
  return { ok: true };
}

/** Convenience: a strong random token that satisfies the policy. */
export function generateToken(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  // Guarantee class coverage regardless of how the random draw landed.
  return `${out}aA1-`;
}
