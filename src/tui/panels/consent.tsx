import { Box, Text } from "ink";
import type { FC } from "react";

import { CONSENT_SCOPES, type ConsentSnapshot } from "../../runtime/snapshots.js";

export type ConsentPanelProps = {
  consent: ConsentSnapshot;
};

export const ConsentPanel: FC<ConsentPanelProps> = ({ consent }) => {
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>policy </Text>
        <Text>{consent.policyVersion}</Text>
        <Text dimColor> active </Text>
        <Text color={consent.activeGrants > 0 ? "green" : "gray"}>{consent.activeGrants}</Text>
      </Text>
      {CONSENT_SCOPES.map((scope) => {
        const count = consent.aggregateByScope[scope] ?? 0;
        return (
          <Text key={scope}>
            <Text dimColor> {scope.padEnd(20, " ")} </Text>
            <Text color={count > 0 ? "cyan" : "gray"}>{count}</Text>
          </Text>
        );
      })}
    </Box>
  );
};
