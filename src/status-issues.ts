/**
 * XMPP channel status issue detection
 */

import type { ChannelAccountSnapshot, ChannelStatusIssue } from "./types.js";

/**
 * XMPP account status fields
 */
type XmppAccountStatus = {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
  connected?: unknown;
  running?: unknown;
  lastError?: unknown;
  lastConnectedAt?: unknown;
  lastDisconnect?: unknown;
};

/**
 * Safely extract string from unknown value
 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Check if value is a record
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read XMPP account status from snapshot
 */
function readXmppAccountStatus(value: ChannelAccountSnapshot): XmppAccountStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    accountId: value.accountId,
    enabled: value.enabled,
    configured: value.configured,
    connected: value.connected,
    running: value.running,
    lastError: value.lastError,
    lastConnectedAt: value.lastConnectedAt,
    lastDisconnect: value.lastDisconnect,
  };
}

/**
 * Collect status issues for XMPP accounts
 */
export function collectXmppStatusIssues(
  accounts: ChannelAccountSnapshot[]
): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];

  for (const entry of accounts) {
    const account = readXmppAccountStatus(entry);
    if (!account) {
      continue;
    }

    const accountId = asString(account.accountId) ?? "default";
    const enabled = account.enabled !== false;

    if (!enabled) {
      continue;
    }

    const configured = account.configured === true;
    const running = account.running === true;
    const connected = account.connected === true;
    const lastError = asString(account.lastError);

    // Not configured
    if (!configured) {
      issues.push({
        channel: "xmpp",
        accountId,
        kind: "auth",
        message: "Not configured (missing JID or password).",
        fix: "Run: openclaw channels add xmpp (or configure JID and password in config).",
      });
      continue;
    }

    // Running but not connected
    if (running && !connected) {
      issues.push({
        channel: "xmpp",
        accountId,
        kind: "runtime",
        message: `Configured but disconnected${lastError ? `: ${lastError}` : "."}`,
        fix: "Check XMPP server connectivity and credentials. Run: openclaw doctor",
      });
    }

    // Has error
    if (lastError && !issues.some((i) => i.accountId === accountId)) {
      issues.push({
        channel: "xmpp",
        accountId,
        kind: "runtime",
        message: `Error: ${lastError}`,
        fix: "Check logs for details. Run: openclaw logs --follow",
      });
    }
  }

  return issues;
}
