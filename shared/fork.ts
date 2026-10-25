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
  /** How many entries the forked session would keep: everything before the point. */
  entries: z.number().int().nonnegative(),
});

export type ForkPoint = z.infer<typeof forkPointSchema>;

/**
 * One row of the picker: a user message anchor plus the tool batches of the
 * turn it started. The tool rows render collapsed under the message, keeping
 * the interleaved timeline readable when a turn runs many tool calls.
 */
export const forkTurnSchema = z.object({
  ...forkPointSchema.shape,
  /**
   * Tool call anchors of this message's turn, newest first — one per
   * completed tool batch (every call has its result): the cut is just after
   * the batch, which the fork keeps, so it redirects the turn from there.
   */
  toolPoints: z.array(forkPointSchema),
});

export type ForkTurn = z.infer<typeof forkTurnSchema>;

/**
 * Fork points of one agent, from its active pi branch, newest first. Reading
 * them needs the pi session file, which only the daemon side can locate, so
 * the picker asks the server instead of the timeline.
 */
export const forkPointsRpc = defineRpc({
  name: "real-fork.points",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    agentId: z.string(),
    cwd: z.string(),
    sessionFile: z.string(),
    /** Total entries on the active branch (root → leaf). */
    branchEntries: z.number().int().nonnegative(),
    /**
     * User message anchors, newest first. Each carries the tool batches of
     * the turn it started, so the picker renders the interleaved timeline
     * with the (many) tool rows collapsed by default.
     */
    points: z.array(forkTurnSchema),
  }),
});

/**
 * Fork an agent by writing a new pi session file and reusing it for a new
 * agent. The copy is the active branch cut at `messageId`: a user message is
 * cut just before (the point's message is dropped so the fork rewrites it in
 * its composer), a completed tool batch is cut just after (the fork keeps the
 * batch and redirects the turn from there). Anything after the cut —
 * including a half-finished turn — is dropped, so the copy is always a state
 * pi can resume.
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
    /** Entries kept from the source branch (root → the cut). */
    entries: z.number().int().nonnegative(),
    /** Entries dropped from the cut on. */
    dropped: z.number().int().nonnegative(),
  }),
});

export type ForkResult = z.infer<typeof forkRpc.output>;
