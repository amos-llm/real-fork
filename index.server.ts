import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createForkHandler, createForkPointsHandler } from "./server/fork-agent";
import { forkPointsRpc, forkRpc } from "./shared/fork";

/**
 * Forking a pi agent at the provider-session level: the plugin writes a new pi
 * session file holding the branch up to a user message and hands it to a fresh
 * agent, so the first turn repeats the source prefix exactly and the provider's
 * prefix cache still applies.
 */
export default function contribute(server: PluginServerContext) {
  server.handle(forkPointsRpc, createForkPointsHandler());
  server.handle(forkRpc, createForkHandler());
  return () => {};
}
