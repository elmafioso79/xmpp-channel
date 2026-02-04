import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setXmppRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getXmppRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("XMPP runtime not initialized");
  }
  return runtime;
}
