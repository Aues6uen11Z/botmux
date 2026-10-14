import type { CliId } from '../adapters/cli/types.js';
import {
  callOrca,
  callOrcaSync,
  hasStableOrcaTerminalIdentity,
  matchesOrcaTerminalIdentity,
  type OrcaInstance,
  type OrcaTerminalIdentity,
} from '../services/orca-cli.js';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { findCodexRolloutByPid } from '../services/codex-transcript.js';
import { findCocoSessionByPid } from '../services/coco-transcript.js';
import { findTraexRolloutByPid } from '../services/traex-transcript.js';
import { readClaudeSessionMeta } from '../services/claude-transcript.js';
import { queryOrcaRelayPtyMetadata } from '../services/orca-relay.js';
import { queryOrcaDaemonSessions, type OrcaDaemonSessionMetadata } from '../services/orca-daemon.js';

export interface OrcaTerminalSummary extends OrcaTerminalIdentity {
  worktreePath: string;
  branch?: string;
  title?: string | null;
  lastOutputAt?: number | null;
}
export interface OrcaAdoptableSession {
  source: 'orca';
  orcaInstance: OrcaInstance;
  orcaTerminalHandle: string;
  orcaPtyId?: string;
  orcaIncarnationId?: string;
  orcaExecutionHostId?: string;
  orcaWorktreeId: string;
  orcaAgentIdentity: string;
  orcaTerminalTitle?: string;
  cliPid?: number;
  sessionId?: string;
  cliId: CliId;
  cwd: string;
  startedAt?: number;
  paneCols: number;
  paneRows: number;
  paneSizeVerified: boolean;
}

function scanLocalOrcaCliPids(
  rootPidByHandle: ReadonlyMap<string, number>,
  expectedCliByHandle: ReadonlyMap<string, CliId>,
): Map<string, { pid: number; cliId: CliId }> {
  const byHandle = new Map<string, { pid: number; cliId: CliId }>();
  const candidates = new Map<string, Array<{ pid: number; cliId: CliId; depth: number }>>();
  let pids: number[];
  try {
    pids = readdirSync('/proc')
      .filter(name => /^\d+$/.test(name))
      .map(Number);
  } catch {
    return byHandle;
  }
  const parentByPid = new Map<number, number>();
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const match = status.match(/^PPid:\s+(\d+)/m);
      if (match) parentByPid.set(pid, Number(match[1]));
    } catch { /* exited */ }
  }
  const depthFrom = (pid: number, rootPid: number): number | undefined => {
    const seen = new Set<number>();
    let current: number | undefined = pid;
    let depth = 0;
    while (current && !seen.has(current)) {
      if (current === rootPid) return depth;
      seen.add(current);
      current = parentByPid.get(current);
      depth += 1;
    }
    return undefined;
  };
  const processCliIds: Readonly<Record<string, CliId>> = {
    claude: 'claude-code',
    codex: 'codex',
    coco: 'coco',
    traex: 'traex',
    traecli: 'traex',
    'cursor-agent': 'cursor',
    gemini: 'gemini',
    opencode: 'opencode',
    opencode2: 'opencode2',
    mtr: 'mtr',
    hermes: 'hermes',
    pi: 'pi',
    omp: 'oh-my-pi',
    grok: 'grok',
    'kiro-cli': 'kiro-cli',
  };
  for (const pid of pids) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`);
      const handleMatch = env.toString('utf-8').match(/(?:^|\0)ORCA_TERMINAL_HANDLE=([^\0]+)/);
      if (!handleMatch) continue;
      const rootPid = rootPidByHandle.get(handleMatch[1]!);
      if (!rootPid) continue;
      const expectedCliId = expectedCliByHandle.get(handleMatch[1]!);
      if (!expectedCliId) continue;
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
      let executable = '';
      try { executable = basename(readlinkSync(`/proc/${pid}/exe`)); } catch { /* unreadable */ }
      const processName = processCliIds[comm] ?? processCliIds[executable];
      const cliId = (comm === 'traecli' || executable === 'traecli')
        && (expectedCliId === 'traex' || expectedCliId === 'coco')
        ? expectedCliId
        : processName;
      const depth = depthFrom(pid, rootPid);
      if (cliId !== expectedCliId || depth === undefined) continue;
      const list = candidates.get(handleMatch[1]!) ?? [];
      list.push({ pid, cliId, depth });
      candidates.set(handleMatch[1]!, list);
    } catch { /* another user's or exited process */ }
  }
  for (const [handle, list] of candidates) {
    list.sort((a, b) => b.depth - a.depth);
    if (list.length > 1 && list[0]!.depth === list[1]!.depth) continue;
    const selected = list[0];
    if (selected) byHandle.set(handle, { pid: selected.pid, cliId: selected.cliId });
  }
  return byHandle;
}

function sessionIdForCliPid(cliId: CliId, pid: number | undefined): string | undefined {
  if (!pid) return undefined;
  if (cliId === 'claude-code') return readClaudeSessionMeta(pid)?.sessionId;
  if (cliId === 'traex') return findTraexRolloutByPid(pid)?.cliSessionId;
  if (cliId === 'codex') return findCodexRolloutByPid(pid)?.cliSessionId;
  if (cliId === 'coco') return findCocoSessionByPid(pid)?.sessionId;
  return undefined;
}

interface TerminalListResult {
  terminals?: OrcaTerminalSummary[];
}

interface TerminalShowResult {
  terminal?: OrcaTerminalSummary;
}

// MTR/Hermes remain discoverable for terminal I/O, but their external transcript
// ownership is not reliable enough to construct reply history (see adopt docs).
const ORCA_AGENT_CLI_IDS: Readonly<Record<string, CliId>> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  coco: 'coco',
  trae: 'traex',
  'trae-cli': 'traex',
  traex: 'traex',
  cursor: 'cursor',
  gemini: 'gemini',
  opencode: 'opencode',
  opencode2: 'opencode2',
  mtr: 'mtr',
  hermes: 'hermes',
  pi: 'pi',
  omp: 'oh-my-pi',
  'oh-my-pi': 'oh-my-pi',
  grok: 'grok',
  'kiro-cli': 'kiro-cli',
};

export function cliIdFromOrcaAgentIdentity(identity: string | undefined): CliId | undefined {
  return identity ? ORCA_AGENT_CLI_IDS[identity.trim().toLowerCase()] : undefined;
}

function toCandidate(
  terminal: OrcaTerminalSummary,
  filterCliId: CliId | undefined,
  instance: OrcaInstance,
  localPids: ReadonlyMap<string, { pid: number; cliId: CliId }> = new Map(),
  sizes: ReadonlyMap<string, { cols: number; rows: number }> = new Map(),
): OrcaAdoptableSession | undefined {
  const cliId = cliIdFromOrcaAgentIdentity(terminal.agentIdentity);
  if (!cliId || (filterCliId && cliId !== filterCliId)) return undefined;
  if (!terminal.handle || !terminal.worktreeId || !terminal.worktreePath) return undefined;
  if (terminal.connected !== true || terminal.writable !== true) return undefined;
  if (!hasStableOrcaTerminalIdentity(terminal)) return undefined;
  const local = localPids.get(terminal.handle);
  const cliPid = local?.cliId === cliId ? local.pid : undefined;
  const size = sizes.get(terminal.handle);
  return {
    source: 'orca',
    orcaInstance: instance,
    orcaTerminalHandle: terminal.handle,
    orcaPtyId: terminal.ptyId ?? undefined,
    orcaIncarnationId: terminal.incarnationId ?? undefined,
    orcaExecutionHostId: terminal.executionHostId,
    orcaWorktreeId: terminal.worktreeId,
    orcaAgentIdentity: terminal.agentIdentity!,
    orcaTerminalTitle: terminal.title?.trim() || undefined,
    cliId,
    cliPid,
    sessionId: sessionIdForCliPid(cliId, cliPid),
    cwd: terminal.worktreePath,
    startedAt: undefined,
    // Without an attested geometry (relay socket or terminal daemon) the
    // public CLI offers none; keep conservative render defaults.
    paneCols: size?.cols ?? 120,
    paneRows: size?.rows ?? 50,
    paneSizeVerified: size !== undefined,
  };
}

function relayPtyId(terminal: OrcaTerminalSummary): string | undefined {
  const ptyId = terminal.ptyId ?? '';
  const separator = ptyId.indexOf('@@');
  return separator >= 0 ? ptyId.slice(separator + 2) || undefined : undefined;
}

async function localPidsForTerminals(
  instances: ReadonlyArray<{ instance: OrcaInstance; terminals: readonly OrcaTerminalSummary[] }>,
  daemonSessions: ReadonlyMap<string, OrcaDaemonSessionMetadata>,
): Promise<{
  localPids: Map<string, { pid: number; cliId: CliId }>;
  sizes: Map<string, { cols: number; rows: number }>;
}> {
  const relayIds = instances.flatMap(({ instance, terminals }) => (
    instance === 'relay'
      ? terminals.flatMap(terminal => {
        const id = relayPtyId(terminal);
        return id ? [id] : [];
      })
      : []
  ));
  const relayMetadata = relayIds.length > 0 ? await queryOrcaRelayPtyMetadata(relayIds) : new Map<string, never>();
  const rootsByHandle = new Map<string, number>();
  const expectedCliByHandle = new Map<string, CliId>();
  const sizes = new Map<string, { cols: number; rows: number }>();
  for (const { instance, terminals } of instances) {
    for (const terminal of terminals) {
      // Same-host root pids and geometry: relay terminals via the SSH relay
      // socket, server terminals via the terminal daemon, both keyed by handle.
      const relayId = instance === 'relay' ? relayPtyId(terminal) : undefined;
      const entry = instance === 'server'
        ? daemonSessions.get(terminal.handle)
        : relayId ? relayMetadata.get(relayId) : undefined;
      if (entry?.pid) rootsByHandle.set(terminal.handle, entry.pid);
      if (entry?.cols && entry.rows) sizes.set(terminal.handle, { cols: entry.cols, rows: entry.rows });
      const expectedCliId = cliIdFromOrcaAgentIdentity(terminal.agentIdentity);
      if (expectedCliId) expectedCliByHandle.set(terminal.handle, expectedCliId);
    }
  }
  return { localPids: scanLocalOrcaCliPids(rootsByHandle, expectedCliByHandle), sizes };
}

export async function discoverAdoptableOrcaSessions(
  filterCliId?: CliId,
  filterExecutable?: string,
): Promise<OrcaAdoptableSession[]> {
  // Orca exposes an agent kind, not the exact executable. A configured custom
  // runtime therefore cannot be proven to be the bot's selected distribution.
  if (filterExecutable) return [];
  const [relayList, serverList, daemonSessions] = await Promise.all([
    callOrca<TerminalListResult>(['terminal', 'list', '--limit', '1000']),
    callOrca<TerminalListResult>(['terminal', 'list', '--limit', '1000'], 'server'),
    queryOrcaDaemonSessions(),
  ]);
  const instances = [
    ...(relayList.ok ? [{ instance: 'relay' as const, terminals: relayList.value.terminals ?? [] }] : []),
    ...(serverList.ok ? [{ instance: 'server' as const, terminals: serverList.value.terminals ?? [] }] : []),
  ];
  const { localPids, sizes } = await localPidsForTerminals(instances, daemonSessions);
  const byHandle = new Map<string, OrcaAdoptableSession>();
  for (const { instance, terminals } of instances) {
    for (const terminal of terminals) {
      const candidate = toCandidate(terminal, filterCliId, instance, localPids, sizes);
      if (!candidate) continue;
      // The relay resolver's PATH fallback can land on the server CLI, so the
      // same handle may surface from both instances; keep the server entry,
      // which carries daemon-attested pid/geometry.
      const existing = byHandle.get(candidate.orcaTerminalHandle);
      if (!existing || instance === 'server') byHandle.set(candidate.orcaTerminalHandle, candidate);
    }
  }
  return [...byHandle.values()];
}

export async function discoverAdoptableOrcaSessionByHandle(
  handle: string,
  filterCliId?: CliId,
  filterExecutable?: string,
): Promise<OrcaAdoptableSession | undefined> {
  if (!handle || filterExecutable) return undefined;
  const [relayResult, serverResult, daemonSessions] = await Promise.all([
    callOrca<TerminalShowResult>(['terminal', 'show', '--terminal', handle]),
    callOrca<TerminalShowResult>(['terminal', 'show', '--terminal', handle], 'server'),
    queryOrcaDaemonSessions(),
  ]);
  // Prefer the server instance on dual hits (same rationale as list dedup).
  const serverTerminal = serverResult.ok ? serverResult.value.terminal : undefined;
  const relayTerminal = relayResult.ok ? relayResult.value.terminal : undefined;
  const instance: OrcaInstance | undefined = serverTerminal ? 'server' : relayTerminal ? 'relay' : undefined;
  const terminal = instance === 'server' ? serverTerminal : relayTerminal;
  if (!instance || !terminal) return undefined;
  const { localPids, sizes } = await localPidsForTerminals([{ instance, terminals: [terminal] }], daemonSessions);
  return toCandidate(terminal, filterCliId, instance, localPids, sizes);
}

export type OrcaAdoptValidationResult = 'alive' | 'missing' | 'unknown';

export function validateOrcaAdoptTarget(
  target: Pick<OrcaAdoptableSession, 'orcaTerminalHandle' | 'orcaPtyId' | 'orcaIncarnationId' | 'orcaExecutionHostId' | 'orcaWorktreeId' | 'orcaAgentIdentity'> & { orcaInstance?: OrcaInstance },
): OrcaAdoptValidationResult {
  // Absent instance = rows persisted before server support; they are relay terminals.
  const result = callOrcaSync<TerminalShowResult>([
    'terminal', 'show', '--terminal', target.orcaTerminalHandle,
  ], target.orcaInstance ?? 'relay');
  if (!result.ok) return result.kind === 'missing' ? 'missing' : 'unknown';
  const terminal = result.value.terminal;
  if (!terminal) return 'missing';
  const identityMatches = matchesOrcaTerminalIdentity(terminal, {
    terminalHandle: target.orcaTerminalHandle,
    ptyId: target.orcaPtyId,
    incarnationId: target.orcaIncarnationId,
    executionHostId: target.orcaExecutionHostId,
    worktreeId: target.orcaWorktreeId,
    agentIdentity: target.orcaAgentIdentity,
  });
  return identityMatches ? 'alive' : 'missing';
}
