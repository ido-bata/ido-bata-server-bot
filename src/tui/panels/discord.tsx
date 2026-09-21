import { Box, Text } from "ink";
import type { FC } from "react";

import type { DiscordSnapshot, DiscordState } from "../../runtime/snapshots.js";

export type DiscordPanelProps = {
  discord: DiscordSnapshot;
};

const stateColor: Record<DiscordState, string> = {
  connecting: "yellow",
  ready: "green",
  disconnected: "red",
};

export const DiscordPanel: FC<DiscordPanelProps> = ({ discord }) => {
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>discord </Text>
        <Text color={stateColor[discord.state]} bold>
          {discord.state}
        </Text>
      </Text>
      <Text dimColor>
        user: {discord.user ?? "-"} guilds: {discord.guildCount} ping:{" "}
        {discord.pingMs === null ? "-" : `${discord.pingMs}ms`}
      </Text>
    </Box>
  );
};
