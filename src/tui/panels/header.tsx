import { Box, Text } from "ink";
import type { FC } from "react";

import type { AppSnapshot } from "../../runtime/snapshots.js";

export type HeaderPanelProps = {
  app: AppSnapshot;
};

/** Format a millisecond duration as `Xd Yh Zm Ws` (no leading zeros, never negative). */
export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "0s";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export const HeaderPanel: FC<HeaderPanelProps> = ({ app }) => {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text>
        <Text color="cyan" bold>
          {app.name}
        </Text>
        <Text dimColor> v{app.version}</Text>
      </Text>
      <Text>
        <Text dimColor>mode </Text>
        <Text color={app.mode === "tty" ? "green" : "yellow"}>{app.mode}</Text>
        <Text dimColor> uptime </Text>
        <Text>{formatUptime(app.uptimeMs)}</Text>
      </Text>
    </Box>
  );
};
