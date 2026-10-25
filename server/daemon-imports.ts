import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Why not the `paseo` CLI: the CLI's import cannot target a workspace. The
 * daemon files an imported agent into the OLDEST active workspace for its
 * cwd, which is the parent's workspace — the fork would show up as a tab in
 * the parent instead of its own sidebar entry. The wire protocol
 * (`import_agent_request`) and the daemon client both accept a `workspaceId`,
 * so this module opens a short-lived client connection and imports straight
 * into the workspace the fork handler just created. Same path the CLI uses,
 * one extra field.
 *
 * No credentials are needed on a local daemon: loopback clients are admitted
 * as the owner (the daemon keeps no password). The local credential file is
 * offered anyway for daemons that require it.
 */

export interface ImportedAgent {
  agentId: string;
  title: string | null;
}

export type ImportSession = (input: {
  sessionFile: string;
  cwd: string;
  workspaceId: string;
  title: string;
  labels: Record<string, string>;
}) => Promise<ImportedAgent>;

const CONNECT_TIMEOUT_MS = 10_000;

function paseoHome(): string {
  return process.env.PASEO_HOME?.trim() || path.join(homedir(), ".paseo");
}

/** The daemon's configured listen address; falls back to the default local TCP endpoint. */
async function resolveDaemonUrl(): Promise<string> {
  try {
    const raw = await readFile(path.join(paseoHome(), "config.json"), "utf8");
    const listen = (JSON.parse(raw) as { daemon?: { listen?: unknown } })?.daemon?.listen;
    if (typeof listen === "string" && /^[0-9a-fA-F.:*[\]]+:\d{1,5}$/.test(listen)) {
      const [host, port] = listen.split(":");
      const hostname = host === "*" || host === "::" ? "127.0.0.1" : host;
      return `ws://${hostname}:${port}/ws`;
    }
  } catch {
    // No config or unreadable: default endpoint.
  }
  return "ws://127.0.0.1:6767/ws";
}

async function readLocalCredential(): Promise<string | undefined> {
  try {
    return (await readFile(path.join(paseoHome(), "local-credential"), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Import one prepared pi session file into a specific workspace and name the
 * agent, over one short-lived daemon client connection.
 */
export const importIntoWorkspace: ImportSession = async ({
  sessionFile,
  cwd,
  workspaceId,
  title,
  labels,
}) => {
  const client = new DaemonClient({
    url: await resolveDaemonUrl(),
    clientId: `real-fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    clientType: "cli",
    localCredential: readLocalCredential,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    const snapshot = await client.importAgent({
      provider: "pi",
      sessionId: sessionFile,
      cwd,
      workspaceId,
      labels,
    });
    // The import titles the agent from its first user message, which is the
    // parent's — rename so the fork is distinguishable in the sidebar.
    await client.updateAgent(snapshot.id, { name: title });
    return { agentId: snapshot.id, title };
  } finally {
    await client.close();
  }
};
