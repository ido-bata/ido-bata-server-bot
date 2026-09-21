import { Box, Text } from "ink";
import type { FC } from "react";

import type { RuntimeSnapshot } from "../../runtime/snapshots.js";

export type RuntimePanelProps = {
  runtime: RuntimeSnapshot;
};

/** Format a byte count using IEC units (KiB, MiB, GiB) — never reveals raw bytes in UI noise. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0B";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${rounded}${units[unitIndex]}`;
}

export const RuntimePanel: FC<RuntimePanelProps> = ({ runtime }) => {
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>pid </Text>
        <Text>{runtime.pid}</Text>
        <Text dimColor> node </Text>
        <Text>{runtime.node}</Text>
        <Text dimColor> rss </Text>
        <Text>{formatBytes(runtime.rssBytes)}</Text>
      </Text>
      {runtime.httpEndpoints.length === 0 ? (
        <Text dimColor>http: (none)</Text>
      ) : (
        runtime.httpEndpoints.map((endpoint) => (
          <Text key={endpoint.name}>
            <Text dimColor>http </Text>
            <Text color={endpoint.state === "listening" ? "green" : "red"}>{endpoint.state}</Text>
            <Text dimColor>
              {" "}
              {endpoint.name} {endpoint.url}
            </Text>
          </Text>
        ))
      )}
    </Box>
  );
};
