import { Box, Text } from "ink";
import type { FC } from "react";

import type { TimekeeperSnapshot, TimekeeperState } from "../../runtime/snapshots.js";

export type TimekeeperPanelProps = {
  timekeeper: TimekeeperSnapshot;
};

const stateColor: Record<TimekeeperState, string> = {
  idle: "gray",
  scheduled: "yellow",
  running: "green",
};

export const TimekeeperPanel: FC<TimekeeperPanelProps> = ({ timekeeper }) => {
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>state </Text>
        <Text color={stateColor[timekeeper.state]} bold>
          {timekeeper.state}
        </Text>
      </Text>
      <Text dimColor>next: {timekeeper.nextSessionAt ?? "-"}</Text>
      <Text dimColor>phase: {timekeeper.activePhase ?? "-"}</Text>
    </Box>
  );
};
