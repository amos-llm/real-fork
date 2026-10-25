import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ForkPoint, ForkResult } from "../shared/fork";
import { forkPointsRpc, forkRpc } from "../shared/fork";
import { fmtPointMeta } from "./fork-format";
import { forkPointsQueryKey } from "./fork-query";

const LIST_STYLE = { gap: 0 } as const;
const ROW_STYLE = { paddingVertical: 8, gap: 2 } as const;
const HEADER_STYLE = { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 };
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

interface PointRowProps {
  point: ForkPoint;
  latest: boolean;
  theme: PluginButtonContentProps["theme"];
  now: number;
  disabled: boolean;
  onPick: (messageId: string) => void;
}

function PointRow({ point, latest, theme, now, disabled, onPick }: PointRowProps) {
  const styles = useMemo(
    () => ({
      row: { ...ROW_STYLE, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
      preview: {
        color: theme.colors.foreground,
        fontSize: 13,
        opacity: disabled ? 0.5 : 1,
      },
      meta: { color: theme.colors.foregroundMuted, fontSize: 11 },
      badge: { color: theme.colors.accent, fontSize: 11, fontWeight: "600" as const },
    }),
    [theme, disabled],
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
      accessibilityLabel={`Fork at ${point.preview}`}
      disabled={disabled}
      onPress={handlePress}
      style={styles.row}
    >
      <View style={HEADER_STYLE}>
        {latest ? <Text style={styles.badge}>latest</Text> : null}
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <Text style={styles.preview} numberOfLines={2}>
        {point.preview}
      </Text>
    </Pressable>
  );
}

/**
 * Composer-pill popover body. The host owns anchoring, scrolling and padding
 * (280–420px wide, 440px tall), so this is just the list of fork points plus
 * the outcome of the last fork.
 *
 * A fork writes a new pi session file holding the active branch cut at a
 * chosen user message and reuses it for a new agent in a new workspace, so the
 * provider still sees the source prefix and its cache answers the first turn.
 */
export function ForkPopover(props: PluginButtonContentProps) {
  const { theme, close } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const fetchPoints = useRpc(forkPointsRpc);
  const runFork = useRpc(forkRpc);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [result, setResult] = useState<ForkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const handlePick = useCallback(
    (messageId: string) => {
      if (!agentId) return;
      setBusyId(messageId);
      setError(null);
      setResult(null);
      void runFork({ agentId, messageId })
        .then((forked) => {
          setResult(forked);
          return undefined;
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          setBusyId(null);
        });
    },
    [agentId, runFork],
  );

  const handleClose = useCallback(() => {
    close();
  }, [close]);

  const handleForkAgain = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  const styles = useMemo(
    () => ({
      intro: { color: theme.colors.foregroundMuted, fontSize: 11 },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      skeleton: { height: 40, borderRadius: 6, backgroundColor: theme.colors.surface2 },
      successTitle: {
        color: theme.colors.statusSuccess,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      agentTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      button: {
        marginTop: 8,
        paddingVertical: 8,
        alignItems: "center" as const,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      buttonText: { color: theme.colors.foreground, fontSize: 13 },
    }),
    [theme],
  );

  const points = data?.points ?? [];
  const disabled = busyId !== null;

  // The fork point list can be long, so the outcome replaces it instead of being
  // appended below the fold.
  if (result) {
    return (
      <View style={LIST_STYLE}>
        <Text style={styles.successTitle}>Forked ✓</Text>
        <Text style={styles.agentTitle}>{result.title ?? "New agent"}</Text>
        <Text style={styles.muted}>
          {`${result.entries} entries kept · ${result.dropped} dropped · ${result.agentId.slice(0, 8)}`}
        </Text>
        <Text style={styles.muted}>
          It is a new entry in the sidebar — its own workspace in the same directory — with the
          whole conversation and the source cache key.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fork again"
          onPress={handleForkAgain}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Fork again</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={handleClose}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={LIST_STYLE}>
      <Text style={styles.title}>Fork without losing the cache</Text>
      <Text style={styles.intro}>
        Copies the pi session, cut at a user message, then resumes it in a new agent — same cwd,
        model and tools, so the provider prefix cache still applies.
      </Text>

      {agentId === null ? <Text style={styles.error}>Open this pill from an agent.</Text> : null}
      {busyId !== null ? <Text style={styles.muted}>Forking…</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {isPending && agentId !== null ? (
        // The host sizes the popover from its first render, so a cold open must
        // already reserve near-final height — otherwise the box opens small and
        // only grows (or not at all) when the points arrive.
        <View style={LIST_STYLE}>
          <Text style={styles.muted}>Reading the pi session…</Text>
          {SKELETON_ROWS.map((row) => (
            <View key={row} style={styles.skeleton} />
          ))}
        </View>
      ) : null}
      {loadError ? (
        <Text style={styles.error}>
          {loadError instanceof Error ? loadError.message : String(loadError)}
        </Text>
      ) : null}
      {points.map((point, index) => (
        <PointRow
          key={point.messageId}
          point={point}
          latest={index === 0}
          theme={theme}
          // Ages are measured against when the list was fetched, so rendering
          // never reads the clock.
          now={dataUpdatedAt}
          disabled={disabled}
          onPick={handlePick}
        />
      ))}

      {busyId !== null ? <Text style={styles.muted}>Forking…</Text> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={handleClose}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Close</Text>
      </Pressable>
    </View>
  );
}
