import type { AgentAdapter, AgentName } from './adapter.js';
import { ClaudeAdapter } from './claude/discover.js';
import { CodexAdapter } from './codex/discover.js';

export function adapterFor(name: AgentName): AgentAdapter {
  return name === 'claude-code' ? new ClaudeAdapter() : new CodexAdapter();
}
