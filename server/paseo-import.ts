import { execCommand } from "@getpaseo/plugin/server";

/**
 * Paseo's plugin SDK exposes `agents.create` but not `importAgent`, and creating
 * an agent then patching its session file cannot work: the daemon keeps the live
 * pi process, so the patched file is never loaded (the fork would show no
 * history). The CLI's `paseo import` runs the real import path, which resumes the
 * agent straight from the session file we just wrote — no window, no patching.
 */

const IMPORT_TIMEOUT_MS = 60_000;

export interface ImportedAgent {
  agentId: string;
  title: string | null;
}

export type ImportSession = (input: {
  sessionFile: string;
  cwd: string;
  title: string;
  labels: Record<string, string>;
}) => Promise<ImportedAgent>;

function parseImportOutput(result: { stdout: string; stderr: string }): ImportedAgent {
  const trimmed = result.stdout.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const agentId = record.agentId;
      if (typeof agentId === "string" && agentId.length > 0) {
        return { agentId, title: typeof record.title === "string" ? record.title : null };
      }
    }
  } catch {
    // Fall through to the error below; the CLI prints JSON with --json.
  }
  throw new Error(`Unexpected paseo import output: ${trimmed || result.stderr || "(empty)"}`);
}

/** Runs the Paseo CLI's import for one prepared session file. */
export const runPaseoImport: ImportSession = async ({ sessionFile, cwd, title, labels }) => {
  const args = ["import", sessionFile, "--provider", "pi", "--cwd", cwd, "--json"];
  for (const [key, value] of Object.entries(labels)) {
    args.push("--label", `${key}=${value}`);
  }
  const imported = parseImportOutput(await runCli(args, cwd, "import"));
  // Paseo titles an imported agent from its first user message, which is the
  // parent's — rename so the fork is distinguishable in the agent list.
  if (title) {
    await runCli(["agent", "update", imported.agentId, "--name", title, "--json"], cwd, "rename");
    return { ...imported, title };
  }
  return imported;
};

async function runCli(
  args: string[],
  cwd: string,
  what: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execCommand(process.env.PASEO_CLI?.trim() || "paseo", args, {
      cwd,
      timeout: IMPORT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    const notFound = (error as { code?: string }).code === "ENOENT";
    const reason = notFound
      ? "the `paseo` CLI is not on the daemon's PATH; set PASEO_CLI to its path"
      : stderr || (error as Error).message;
    throw new Error(`paseo ${what} failed: ${reason}`, { cause: error });
  }
}
