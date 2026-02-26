import {
  PluginExecutionError,
  PluginTransportError,
} from "@openzeppelin/relayer-plugin-channels/dist/client";

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export function formatRelayerError(error: unknown): string {
  if (error instanceof PluginExecutionError) {
    const code =
      typeof error.errorDetails?.code === "string" && error.errorDetails.code.trim().length > 0
        ? ` (${error.errorDetails.code.trim()})`
        : "";
    return `${error.message}${code}`;
  }

  if (error instanceof PluginTransportError) {
    if (typeof error.statusCode === "number") {
      return `${error.message} (status ${error.statusCode})`;
    }
    return error.message;
  }

  return normalizeErrorMessage(error);
}
