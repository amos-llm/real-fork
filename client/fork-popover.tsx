import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ForkPoint } from "../shared/fork";
import { forkPointsRpc, forkRpc } from "../shared/fork";
import { fmtPointMeta } from "./fork-format";
import { forkPointsQueryKey } from "./fork-query";

const LIST_STYLE = { gap: 0 } as const;
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

interface PointRowProps {
  point: ForkPoint;
  /** True for a tool batch row inside a turn's collapsed group. */
  nested: boolean;
  theme: PluginButtonContentProps["theme"];
  now: number;
  disabled: boolean;
  onPick: (messageId: string) => void;
}

/**
 * One row of the list: the preview on the left (single line, ellipsized) and
 * the point's meta on the right. No row borders — spacing does the separating,
 * and nested tool rows carry a thin left guide instead.
 */
function PointRow({ point, nested, theme, now, disabled, onPick }: PointRowProps) {
  const styles = useMemo(
    () => ({
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        // Tool rows sit tighter so an open batch reads as one block under its
        // user row.
        paddingVertical: nested ? 5 : 7,
        // Tool rows sit inside their turn's group, under the user row that
        // started the turn, with a thin guide marking the nesting.
        marginStart: nested ? 10 : 0,
        paddingStart: nested ? 14 : 0,
        borderLeftWidth: nested ? 1 : 0,
        borderLeftColor: theme.colors.border,
      },
      preview: {
        color: theme.colors.foreground,
        fontSize: nested ? 12 : 14,
        // The user row is the list's primary pick, so it carries medium
        // weight; tool rows stay regular at one size down.
        fontWeight: nested ? ("400" as const) : ("500" as const),
        flex: 1,
        opacity: disabled ? 0.5 : 1,
      },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme, disabled, nested],
  );

  const handlePress = useCallback(() => {
    onPick(point.messageId);
  }, [onPick, point.messageId]);

  const meta = useMemo(
    () => fmtPointMeta(point.entries, point.at, now),
    [point.entries, point.at, now],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={nested ? `Fork after ${point.preview}` : `Fork at ${point.preview}`}
      disabled={disabled}
      onPress={handlePress}
      style={styles.row}
    >
      <Text style={styles.preview} numberOfLines={1}>
        {point.preview}
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {meta}
      </Text>
    </Pressable>
  );
}

interface TurnGroupHeaderProps {
  turnId: string;
  count: number;
  open: boolean;
  theme: PluginButtonContentProps["theme"];
  onToggle: (turnId: string) => void;
}

/** The "N TOOL CALLS" chip under a user message's turn. */
function TurnGroupHeader({ turnId, count, open, theme, onToggle }: TurnGroupHeaderProps) {
  const styles = useMemo(
    () => ({
      row: {
        alignSelf: "flex-start" as const,
        paddingVertical: 4,
      },
      // The chip is a gray pill: uppercase label plus a small chevron, so it
      // reads as a badge rather than a caption.
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        borderRadius: 999,
        backgroundColor: theme.colors.surface2,
        paddingVertical: 4,
        paddingStart: 10,
        paddingEnd: 8,
      },
      label: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        letterSpacing: 0.4,
        textTransform: "uppercase" as const,
      },
      chevron: { color: theme.colors.foregroundMuted, fontSize: 9, width: 10 },
    }),
    [theme],
  );
  const label = count === 1 ? "1 tool call" : `${count} tool calls`;
  const handlePress = useCallback(() => {
    onToggle(turnId);
  }, [onToggle, turnId]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? `Collapse ${label}` : `Expand ${label}`}
      onPress={handlePress}
      style={styles.row}
    >
      <View style={styles.chip}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.chevron}>{open ? "▾" : "▶"}</Text>
      </View>
    </Pressable>
  );
}

/**
 * Composer-pill popover body. The host owns anchoring, scrolling and padding
 * (280–420px wide, 440px tall), so this is just the list of fork points.
 * A successful fork shows no extra screen — the new agent simply appears in
 * the sidebar and the list stays open for another pick.
 *
 * The list is one interleaved timeline, newest first: a user row forks just
 * before that message (the fork rewrites it in its composer); under each user
 * row, the tool batches of the turn it started sit in a group that is
 * collapsed by default — a tool row forks just after its batch, keeping the
 * batch's results so the fork redirects the turn from there. The copy keeps
 * the source prefix either way, so the provider's prefix cache still answers
 * the first turn.
 */
export function ForkPopover(props: PluginButtonContentProps) {
  const { theme } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const fetchPoints = useRpc(forkPointsRpc);
  const runFork = useRpc(forkRpc);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTurns, setOpenTurns] = useState<ReadonlySet<string>>(() => new Set());

  const {
    data,
    error: loadError,
    isPending,
    dataUpdatedAt,
  } = useQuery({
    queryKey: forkPointsQueryKey(agentId),
    queryFn: useCallback(() => {
      if (!agentId) throw new Error("no agent");
      return fetchPoints({ agentId });
    }, [fetchPoints, agentId]),
    enabled: agentId !== null,
  });

  const toggleTurn = useCallback((turnId: string) => {
    setOpenTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);

  const handlePick = useCallback(
    (messageId: string) => {
      if (!agentId) return;
      setBusyId(messageId);
      setError(null);
      void runFork({ agentId, messageId })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          setBusyId(null);
        });
    },
    [agentId, runFork],
  );

  const styles = useMemo(
    () => ({
      title: {
        color: theme.colors.foreground,
        fontSize: 16,
        fontWeight: "700" as const,
        marginBottom: 4,
      },
      intro: {
        color: theme.colors.foregroundMuted,
        fontSize: 13,
        lineHeight: 18,
        marginBottom: 12,
      },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
      busy: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        marginVertical: 8,
      },
      error: {
        color: theme.colors.statusDanger,
        fontSize: 12,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.statusDanger,
        paddingStart: 8,
        marginTop: 8,
      },
      skeletonContainer: { gap: 6, marginTop: 8 },
      skeleton: { height: 36, borderRadius: 6, backgroundColor: theme.colors.surface2 },
      // Each turn (user row + its tool chip, + expanded tool rows) is a
      // rounded card; the gap between cards keeps turns apart.
      turn: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        marginBottom: 8,
        paddingStart: 12,
        paddingEnd: 12,
        paddingTop: 6,
        paddingBottom: 6,
      },
    }),
    [theme],
  );

  const points = data?.points ?? [];
  const disabled = busyId !== null;

  return (
    <View style={LIST_STYLE}>
      <Text style={styles.title}>Fork without losing the cache</Text>
      <Text style={styles.intro}>
        Pick a user message to rewrite it, or expand a turn's tool calls to redirect the turn after
        one of them. The copy keeps the source prefix either way, so the provider cache still
        answers the first turn.
      </Text>

      {agentId === null ? <Text style={styles.error}>Open this pill from an agent.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {busyId !== null ? <Text style={styles.busy}>Forking…</Text> : null}
      {isPending && agentId !== null ? (
        // The host sizes the popover from its first render, so a cold open must
        // already reserve near-final height — otherwise the box opens small and
        // only grows (or not at all) when the points arrive. With the tool
        // groups collapsed, the first render is already near-final.
        <View style={LIST_STYLE}>
          <Text style={styles.muted}>Reading the pi session…</Text>
          <View style={styles.skeletonContainer}>
            {SKELETON_ROWS.map((row) => (
              <View key={row} style={styles.skeleton} />
            ))}
          </View>
        </View>
      ) : null}
      {loadError ? (
        <Text style={styles.error}>
          {loadError instanceof Error ? loadError.message : String(loadError)}
        </Text>
      ) : null}
      {points.map((turn) => (
        <View key={turn.messageId} style={styles.turn}>
          {/* Ages are measured against when the list was fetched, so rendering
              never reads the clock. */}
          <PointRow
            point={turn}
            nested={false}
            theme={theme}
            now={dataUpdatedAt}
            disabled={disabled}
            onPick={handlePick}
          />
          {turn.toolPoints.length > 0 ? (
            <>
              <TurnGroupHeader
                turnId={turn.messageId}
                count={turn.toolPoints.length}
                open={openTurns.has(turn.messageId)}
                theme={theme}
                onToggle={toggleTurn}
              />
              {openTurns.has(turn.messageId)
                ? turn.toolPoints.map((tool) => (
                    <PointRow
                      key={`tool-${tool.messageId}`}
                      point={tool}
                      nested
                      theme={theme}
                      now={dataUpdatedAt}
                      disabled={disabled}
                      onPick={handlePick}
                    />
                  ))
                : null}
            </>
          ) : null}
        </View>
      ))}
    </View>
  );
}
