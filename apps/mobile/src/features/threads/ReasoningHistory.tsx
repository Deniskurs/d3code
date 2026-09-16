import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createReasoningHistoryCommand } from "@t3tools/client-runtime/state/reasoning-history";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createReasoningHistoryReader } from "@t3tools/client-runtime/work-log/reasoning-history";

import { AppText as Text } from "../../components/AppText";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";

const historyCommand = createReasoningHistoryCommand(connectionAtomRuntime);

export function ReasoningHistory(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: string;
  readonly preview: string | null;
}) {
  const loadPage = useAtomCommand(historyCommand, { reportFailure: false });
  const { environmentId, threadId, itemId } = props;
  const reader = useMemo(
    () =>
      createReasoningHistoryReader(async (cursor) => {
        const result = await loadPage({
          environmentId,
          input: { threadId, itemId, ...(cursor === undefined ? {} : { cursor }) },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      }),
    [environmentId, threadId, itemId, loadPage],
  );
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  useEffect(() => () => reader.close(), [reader]);

  return (
    <View className="gap-2">
      {!state.opened ? (
        <>
          {props.preview ? (
            <ScrollView nestedScrollEnabled directionalLockEnabled className="max-h-60">
              <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
                {props.preview}
              </Text>
            </ScrollView>
          ) : null}
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center"
            onPress={() => void reader.load()}
          >
            <Text className="text-xs text-foreground underline">View full thinking history</Text>
          </Pressable>
        </>
      ) : (
        <>
          <View className="flex-row items-center justify-between gap-2">
            <Text className="text-xs text-foreground-muted">Emitted thinking history</Text>
            <Pressable
              accessibilityRole="button"
              className="min-h-11 justify-center"
              onPress={reader.close}
            >
              <Text className="text-xs text-foreground underline">Back to preview</Text>
            </Pressable>
          </View>
          {state.truncated ? (
            <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
              The history storage limit was reached. Saved text is preserved; newer thinking remains
              in the live preview.
            </Text>
          ) : null}
          {state.pages.length > 0 ? (
            <ScrollView
              nestedScrollEnabled
              directionalLockEnabled
              showsVerticalScrollIndicator
              className="max-h-80"
            >
              <Text
                accessibilityLabel="Thinking history"
                selectable
                className="font-mono text-2xs leading-normal text-foreground-muted"
              >
                {state.pages}
              </Text>
            </ScrollView>
          ) : null}
          {state.loading ? (
            <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
              Loading thinking history…
            </Text>
          ) : null}
          {state.error ? (
            <View accessibilityRole="alert">
              <Text className="text-xs text-adaptive-rose-600-400">{state.error}</Text>
              <Pressable
                accessibilityRole="button"
                className="min-h-11 justify-center"
                onPress={() => void reader.load()}
              >
                <Text className="text-xs text-foreground underline">Retry</Text>
              </Pressable>
            </View>
          ) : state.nextCursor !== null && !state.loading ? (
            <Pressable
              accessibilityRole="button"
              className="min-h-11 justify-center"
              onPress={() => void reader.load()}
            >
              <Text className="text-xs text-foreground underline">Load more</Text>
            </Pressable>
          ) : null}
          {state.pages.length > 0 && state.nextCursor === null && !state.loading ? (
            <Text className="text-xs text-foreground-muted">End of currently saved thinking.</Text>
          ) : null}
        </>
      )}
    </View>
  );
}
