/** Strip credentials before anything reaches Walrus. Mirrors the MCP plugin's filter. */
const PATTERNS: Array<[string, RegExp]> = [
  ["sui-private-key", /\bsuiprivkey1[0-9a-z]{20,}\b/gi],
  ["openai-style-key", /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ["openrouter-key", /\bsk-or-[A-Za-z0-9_-]{16,}\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["slack-token", /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g],
  ["telegram-token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ["discord-token", /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["bearer", /\bBearer\s+[A-Za-z0-9._-]{16,}/g],
  ["seed-phrase", /\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}\b/gi],
  ["hex-key-64", /\b[0-9a-f]{64}\b/gi],
  ["url-credentials", /\/\/[^\s/:]+:[^\s/@]+@/g],
];

export interface RedactResult {
  text: string;
  removed: string[];
}

export function redactCredentials(input: string): RedactResult {
  let text = input;
  const removed: string[] = [];
  for (const [kind, re] of PATTERNS) {
    if (re.test(text)) {
      removed.push(kind);
      text = text.replace(re, `[REDACTED:${kind}]`);
    }
    re.lastIndex = 0;
  }
  return { text, removed };
}
