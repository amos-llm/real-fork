import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Label written on every forked agent so the family is visible in Paseo's agent
 * list and from the CLI (`paseo inspect <id>`).
 */
export const FORK_SOURCE_LABEL = "real-fork.source";

/** Label recording the pi entry id the fork was taken at. */
export const FORK_POINT_LABEL = "real-fork.point";

export const forkPointSchema = z.object({
  /** pi entry id of a user message; also Paseo's `messageId` for that row. */
  messageId: z.string().min(1),
  /** One-line preview of the message text. */
  preview: z.string(),
  /** pi entry timestamp, ISO-8601, when the entry carries one. */
  at: z.string().nullable(),
  /** How many entries the forked session would contain (context size proxy). */
  entries: z.number().int().nonnegative(),
});

export type ForkPoint = z.infer<typeof forkPointSchema>;

/**
 * Fork points of one agent: the user messages on its active pi branch, newest
 * first. Reading them needs the pi session file, which only the daemon side can
 * locate, so the picker asks the server instead of the timeline.
 */
export const forkPointsRpc = defineRpc({
  name: "real-fork.points",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    agentId: z.string(),
    cwd: z.string(),
    sessionFile: z.string(),
    /** Entries on the active branch (context size at the newest point). */
    branchEntries: z.number().int().nonnegative(),
    points: z.array(forkPointSchema),
  }),
});

/**
 * Fork an agent by writing a new pi session file and reusing it for a new agent.
 * The copy is the active branch cut at `messageId` (a user message): the fork
 * re-answers that question, and anything after the point — including a
 * half-finished turn — is dropped, so the copy is always a settled session.
 */
export const forkRpc = defineRpc({
  name: "real-fork.fork",
  input: z.object({
    agentId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  output: z.object({
    agentId: z.string(),
    title: z.string().nullable(),
    cwd: z.string(),
    sessionFile: z.string(),
    /** Entries kept from the source branch (root → fork point). */
    entries: z.number().int().nonnegative(),
    /** Entries dropped after the fork point (the part the parent keeps). */
    dropped: z.number().int().nonnegative(),
  }),
});

export type ForkResult = z.infer<typeof forkRpc.output>;
