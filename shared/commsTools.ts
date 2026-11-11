// The team tools' MCP server is "podcode" (ALL-D5); before the rename it was "agentscode". Tool
// calls arrive as mcp__<server>__<tool> (Claude, OrcaCode) or <server>.<tool> (Codex), and
// transcripts saved before the rename keep the old name, so everything that recognises a team tool
// by its name goes through here and accepts both.

export const COMMS_SERVER_NAME = 'podcode';
/** The server's name before the rename, still found in saved transcripts. */
export const LEGACY_COMMS_SERVER_NAME = 'agentscode';

const SERVERS = `(?:${COMMS_SERVER_NAME}|${LEGACY_COMMS_SERVER_NAME})`;
const PREFIX = new RegExp(`^(?:mcp__${SERVERS}__|${SERVERS}\\.)`);

/** Whether a server name is the team tools' (now or before the rename). */
export function isCommsServer(server: string): boolean {
  return server === COMMS_SERVER_NAME || server === LEGACY_COMMS_SERVER_NAME;
}

/** The bare tool name of a team tool call ("send_message"), or null for any other tool. */
export function commsTool(name: string): string | null {
  const match = PREFIX.exec(name);
  return match ? name.slice(match[0].length) : null;
}

/** A pattern matching team tool calls whose bare name matches `tools` (a regex source such as "remember|forget"). */
export function commsToolPattern(tools: string): RegExp {
  return new RegExp(`(?:^mcp__${SERVERS}__|^${SERVERS}\\.)(${tools})$`);
}

/** A team tool call under the current name: mcp__agentscode__x and agentscode.x become mcp__podcode__x. */
export function currentCommsName(name: string): string {
  const tool = commsTool(name);
  return tool === null ? name : `mcp__${COMMS_SERVER_NAME}__${tool}`;
}
