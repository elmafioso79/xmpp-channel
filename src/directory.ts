/**
 * XMPP directory adapter - contact/room listings
 */

import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ChannelDirectoryEntry, ChannelResolveResult, XmppConfig } from "./types.js";
import { resolveXmppAccount } from "./accounts.js";
import { bareJid } from "./config-schema.js";
import { looksLikeXmppJid } from "./normalize.js";

/**
 * Get self JID for account
 */
export async function getXmppSelf(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ChannelDirectoryEntry | null> {
  const account = resolveXmppAccount(params);
  const jid = account.config?.jid;

  if (!jid) {
    return null;
  }

  return {
    kind: "user",
    id: bareJid(jid),
    name: account.config?.name || "XMPP Bot",
    raw: { jid: bareJid(jid) },
  };
}

/**
 * List known peers from allowFrom configuration
 */
export async function listXmppPeersFromConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ChannelDirectoryEntry[]> {
  const account = resolveXmppAccount(params);
  const allowFrom = account.config?.allowFrom;

  if (!allowFrom || allowFrom.length === 0 || allowFrom.includes("*")) {
    return [];
  }

  return allowFrom
    .filter((jid) => jid !== "*")
    .map((jid) => ({
      kind: "user" as const,
      id: bareJid(jid),
      name: bareJid(jid),
      raw: { jid: bareJid(jid) },
    }));
}

/**
 * List configured MUC rooms
 */
export async function listXmppGroupsFromConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<ChannelDirectoryEntry[]> {
  const account = resolveXmppAccount(params);
  const mucs = account.config?.mucs;

  if (!mucs || mucs.length === 0) {
    return [];
  }

  return mucs.map((muc) => ({
    kind: "group" as const,
    id: bareJid(muc),
    name: bareJid(muc).split("@")[0] || muc,
    raw: { roomJid: bareJid(muc) },
  }));
}

/**
 * Resolve XMPP targets from input strings
 */
export async function resolveXmppTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  inputs: string[];
  kind: "user" | "group";
  runtime: RuntimeEnv;
}): Promise<ChannelResolveResult[]> {
  const { cfg, accountId, inputs, kind } = params;
  const account = resolveXmppAccount({ cfg, accountId });
  
  const results: ChannelResolveResult[] = [];
  
  for (const input of inputs) {
    const trimmed = input.trim().replace(/^(xmpp|jabber):/i, "");
    
    if (!trimmed) {
      results.push({ input, resolved: false, note: "empty input" });
      continue;
    }
    
    // Check if it looks like a JID
    if (looksLikeXmppJid(trimmed)) {
      const normalized = bareJid(trimmed);
      results.push({
        input,
        resolved: true,
        id: normalized,
        name: normalized.split("@")[0],
      });
      continue;
    }
    
    // Try to find in allowFrom or mucs based on kind
    if (kind === "user") {
      const allowFrom = account.config?.allowFrom ?? [];
      const match = allowFrom.find((jid) => 
        jid !== "*" && (
          bareJid(jid).toLowerCase().includes(trimmed.toLowerCase()) ||
          bareJid(jid).split("@")[0].toLowerCase() === trimmed.toLowerCase()
        )
      );
      if (match) {
        results.push({
          input,
          resolved: true,
          id: bareJid(match),
          name: bareJid(match).split("@")[0],
        });
        continue;
      }
    } else if (kind === "group") {
      const mucs = account.config?.mucs ?? [];
      const match = mucs.find((muc) =>
        bareJid(muc).toLowerCase().includes(trimmed.toLowerCase()) ||
        bareJid(muc).split("@")[0].toLowerCase() === trimmed.toLowerCase()
      );
      if (match) {
        results.push({
          input,
          resolved: true,
          id: bareJid(match),
          name: bareJid(match).split("@")[0],
        });
        continue;
      }
    }
    
    results.push({ input, resolved: false, note: "not found" });
  }
  
  return results;
}

/**
 * XMPP Directory adapter
 */
export const xmppDirectoryAdapter = {
  self: getXmppSelf,
  listPeers: listXmppPeersFromConfig,
  listGroups: listXmppGroupsFromConfig,
};

/**
 * XMPP Resolver adapter
 */
export const xmppResolverAdapter = {
  resolveTargets: resolveXmppTargets,
};
