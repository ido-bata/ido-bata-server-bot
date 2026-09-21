import { Box, Text, useApp, useInput } from "ink";
import type { FC } from "react";
import { useEffect, useReducer, useSyncExternalStore } from "react";
import type { RuntimeStatusSnapshot } from "../runtime/snapshots.js";
import type { RuntimeStatusStore } from "../runtime/status-store.js";
import { ConsentPanel } from "./panels/consent.js";
import { DiscordPanel } from "./panels/discord.js";
import { EventsPanel } from "./panels/events.js";
import { FeaturesPanel } from "./panels/features.js";
import { HeaderPanel } from "./panels/header.js";
import { RuntimePanel } from "./panels/runtime.js";
import { TimekeeperPanel } from "./panels/timekeeper.js";

export type TuiAppProps = {
  store: RuntimeStatusStore;
  /** Re-render cadence in milliseconds. Defaults to 1000 (1 Hz). */
  intervalMs?: number;
};

/**
 * Ink `App` component. Subscribes to the RuntimeStatusStore via
 * `useSyncExternalStore` so any change re-renders the panel tree, and
 * additionally drives a 1 Hz tick so time-derived slices (uptime, RSS)
 * stay current even when no events fire.
 *
 * No interactive keybinds — this is a monitoring surface. Ctrl+C is
 * forwarded to `useApp().exit()`; the actual SIGINT/SIGTERM teardown
 * lives in `src/features/shutdown/handler.ts`.
 */
export const TuiApp: FC<TuiAppProps> = ({ store, intervalMs = 1000 }) => {
  const { exit } = useApp();
  const [, forceTick] = useReducer((count: number) => count + 1, 0);

  const subscribe = (listener: () => void) => store.subscribe(() => listener());
  const getSnapshot = (): RuntimeStatusSnapshot => store.snapshot;
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const id = setInterval(forceTick, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });

  return (
    <Box flexDirection="column">
      <HeaderPanel app={snapshot.app} />
      <Box marginTop={1} flexDirection="row">
        <Box flexDirection="column" width={36} borderStyle="single" paddingX={1}>
          <Text dimColor>discord</Text>
          <DiscordPanel discord={snapshot.discord} />
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="single" paddingX={1}>
          <Text dimColor>features</Text>
          <FeaturesPanel features={snapshot.features} />
        </Box>
      </Box>
      <Box flexDirection="row">
        <Box flexDirection="column" width={36} borderStyle="single" paddingX={1}>
          <Text dimColor>consent</Text>
          <ConsentPanel consent={snapshot.consent} />
        </Box>
        <Box flexDirection="column" width={36} borderStyle="single" paddingX={1}>
          <Text dimColor>timekeeper</Text>
          <TimekeeperPanel timekeeper={snapshot.timekeeper} />
        </Box>
      </Box>
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Text dimColor>runtime</Text>
        <RuntimePanel runtime={snapshot.runtime} />
      </Box>
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Text dimColor>events</Text>
        <EventsPanel events={snapshot.events} />
      </Box>
    </Box>
  );
};
