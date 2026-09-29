/** The four coding agents, by harness id. */
export type AgentId = 'claude-code' | 'codex' | 'gemini' | 'grok';
export const AGENTS: AgentId[] = ['claude-code', 'codex', 'gemini', 'grok'];

export interface McpDefinition {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface Source {
  agent: AgentId;
  scope: 'user' | 'project' | 'local';
  file: string;
}

/** How an agent gets something: from its own config, or by importing Claude Code's (Grok does). */
export type Via = 'own' | 'compat';

export interface McpServer {
  /** Name + definition fingerprint: two configs can use one name for different servers. */
  id: string;
  name: string;
  /** Another config uses the same name for a different server. */
  conflict: boolean;
  def: McpDefinition;
  sources: Source[];
  agents: Partial<Record<AgentId, Via>>;
}

export interface Skill {
  name: string;
  description: string;
  sources: Source[];
  agents: Partial<Record<AgentId, Via>>;
}

export interface Hook {
  event: string;
  matcher: string | null;
  command: string;
  sources: Source[];
  agents: Partial<Record<AgentId, Via>>;
}

export interface InstructionFile {
  name: string;
  path: string;
  exists: boolean;
  bytes: number;
  /** Pulls AGENTS.md in with an @AGENTS.md import line. */
  importsAgents: boolean;
}

export interface Instructions {
  files: InstructionFile[];
  /** Which file(s) each agent reads in this project. */
  readBy: Record<AgentId, string[]>;
  /** Every agent ends up reading AGENTS.md. */
  unified: boolean;
}

export interface Inventory {
  mcp: McpServer[];
  skills: Skill[];
  hooks: Hook[];
  instructions: Instructions | null;
  /** Grok imports Claude Code's MCP servers, skills and hooks unless turned off. */
  grokCompat: { mcps: boolean; skills: boolean; hooks: boolean };
}
