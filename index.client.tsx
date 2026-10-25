import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { ForkPopover } from "./client/fork-popover";

const PILL_ID = "real-fork";

type PillAgent = {
  id: string;
  workspaceId?: string | null;
  provider?: string | null;
};

type PillState = {
  registration: PluginButtonRegistration;
  workspaceId: string;
};

/**
 * Registers one "Real fork" composer pill per pi agent. The pill opens a picker
 * over the agent's active branch — user messages, plus each turn's tool calls
 * collapsed under its user message; picking one writes a new pi session file
 * holding the branch cut at that point and reuses it for a new agent, which
 * keeps the provider's prefix cache warm (unlike the built-in Fork, which
 * starts a new session from a text summary).
 *
 * Only pi agents get the pill: the fork is built on pi's own session JSONL, so
 * there is nothing to reuse for other providers.
 */
export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, PillState>();
  const lifetime = new AbortController();
  let stopped = false;

  const removePill = (agentId: string) => {
    const state = pills.get(agentId);
    if (!state) return;
    state.registration.remove();
    pills.delete(agentId);
  };

  const register = (agent: PillAgent) => {
    if (stopped || !agent.workspaceId) return;
    // Background providers other than pi have no session file to fork.
    if (agent.provider !== undefined && agent.provider !== "pi") {
      removePill(agent.id);
      return;
    }
    const workspaceId = agent.workspaceId;
    const existing = pills.get(agent.id);
    if (existing) {
      // Agent updates arrive constantly (title, status, last message); an
      // unchanged workspace must not touch the registration.
      if (existing.workspaceId === workspaceId) return;
      existing.registration.remove();
      pills.delete(agent.id);
    }
    const registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId: agent.id,
      button: {
        title: "Real fork (prefix cache preserved)",
        icon: "GitFork",
        label: "Real fork",
        visible: true,
        behavior: { kind: "popover", Content: ForkPopover },
      },
    });
    pills.set(agent.id, { registration, workspaceId });
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const live = new Set(entries.map(({ agent }) => agent.id));
          for (const agentId of Array.from(pills.keys())) {
            if (!live.has(agentId)) removePill(agentId);
          }
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") removePill(update.agentId);
          else register(update.agent);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("Real Fork: agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    for (const agentId of Array.from(pills.keys())) removePill(agentId);
  };
}
