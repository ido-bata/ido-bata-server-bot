export type Logger = {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};
