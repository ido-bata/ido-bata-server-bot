import { Box, Text } from "ink";
import type { FC } from "react";

import type { FeatureSnapshot, FeatureState, FeaturesSnapshot } from "../../runtime/snapshots.js";

export type FeaturesPanelProps = {
  features: FeaturesSnapshot;
};

const stateColor: Record<FeatureState, string> = {
  enabled: "green",
  disabled: "gray",
  degraded: "yellow",
};

function formatMeta(meta: FeatureSnapshot["meta"]): string {
  if (!meta) {
    return "";
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export const FeaturesPanel: FC<FeaturesPanelProps> = ({ features }) => {
  const keys = Object.keys(features).sort();
  return (
    <Box flexDirection="column">
      {keys.map((key) => {
        const feature = features[key];
        if (!feature) {
          return null;
        }
        return (
          <Text key={key}>
            <Text dimColor>{key.padEnd(16, " ")} </Text>
            <Text color={stateColor[feature.state]}>{feature.state}</Text>
            <Text dimColor>{formatMeta(feature.meta)}</Text>
          </Text>
        );
      })}
    </Box>
  );
};
