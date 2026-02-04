/**
 * XMPP heartbeat adapter
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveXmppAccount } from "./accounts.js";
import { getActiveClient } from "./monitor.js";

/**
 * Heartbeat check result
 */
export interface HeartbeatCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Heartbeat recipients result
 */
export interface HeartbeatRecipientsResult {
  recipients: string[];
  source: string;
}

/**
 * Check if XMPP channel is ready for heartbeat
 */
export async function checkXmppHeartbeatReady(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<HeartbeatCheckResult> {
  const { cfg, accountId } = params;
  const account = resolveXmppAccount({ cfg, accountId });

  // Check if configured
  if (!account.config?.jid || !account.config?.password) {
    return { ok: false, reason: "xmpp-not-configured" };
  }

  // Check if enabled
  if (!account.enabled) {
    return { ok: false, reason: "xmpp-disabled" };
  }

  // Check if client is connected
  const client = getActiveClient(account.accountId);
  if (!client) {
    return { ok: false, reason: "xmpp-not-connected" };
  }

  return { ok: true, reason: "ok" };
}

/**
 * Resolve heartbeat recipients
 */
export function resolveXmppHeartbeatRecipients(
  cfg: OpenClawConfig,
  opts: { to?: string; all?: boolean } = {}
): HeartbeatRecipientsResult {
  const xmppConfig = cfg.channels?.xmpp as Record<string, unknown> | undefined;

  // If specific recipient provided
  if (opts.to?.trim()) {
    return { recipients: [opts.to.trim()], source: "explicit" };
  }

  // Get from allowFrom
  const allowFrom = (xmppConfig?.allowFrom as string[] | undefined) ?? [];
  const filtered = allowFrom.filter((entry) => entry !== "*" && entry.trim());

  if (filtered.length === 0) {
    return { recipients: [], source: "none" };
  }

  if (opts.all) {
    return { recipients: filtered, source: "allowFrom-all" };
  }

  // Return first recipient by default
  return { recipients: [filtered[0]], source: "allowFrom" };
}

/**
 * XMPP Heartbeat adapter
 */
export const xmppHeartbeatAdapter = {
  checkReady: checkXmppHeartbeatReady,
  resolveRecipients: ({ cfg, opts }: { cfg: OpenClawConfig; opts?: { to?: string; all?: boolean } }) =>
    resolveXmppHeartbeatRecipients(cfg, opts),
};
