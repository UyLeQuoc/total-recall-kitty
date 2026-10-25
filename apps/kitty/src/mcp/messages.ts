/**
 * What a member's wallet signs to create or revoke a read-only MCP token (KT4, ADR-0067). The web and
 * the server build the same text, so the wallet shows exactly what the server checks.
 */

/** A signed request is good for this long. */
export const MESSAGE_MAX_AGE_MS = 5 * 60_000;

const line = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export const tokenMessage = (o: { potId: string; member: string; name: string; at: string }) =>
  [
    "Kitty: create a read-only MCP token",
    `pot: ${line(o.potId)}`,
    `member: ${line(o.member)}`,
    `name: ${line(o.name)}`,
    `at: ${line(o.at)}`,
  ].join("\n");

export const revokeMessage = (o: { potId: string; tokenId: string; member: string; at: string }) =>
  [
    "Kitty: revoke an MCP token",
    `pot: ${line(o.potId)}`,
    `token: ${line(o.tokenId)}`,
    `member: ${line(o.member)}`,
    `at: ${line(o.at)}`,
  ].join("\n");
