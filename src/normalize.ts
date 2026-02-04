/**
 * XMPP target normalization utilities
 */

import { bareJid } from "./config-schema.js";

/**
 * Check if a string looks like an XMPP JID
 */
export function looksLikeXmppJid(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed) return false;
  
  // Must have @ symbol
  if (!trimmed.includes("@")) return false;
  
  // Must have domain after @
  const parts = trimmed.split("@");
  if (parts.length !== 2) return false;
  if (!parts[0] || !parts[1]) return false;
  
  // Domain should have at least one dot or be localhost
  const domain = parts[1].split("/")[0];
  if (domain !== "localhost" && !domain.includes(".")) return false;
  
  return true;
}

/**
 * Check if JID is a MUC room
 */
export function isXmppMucJid(jid: string, mucDomains?: string[]): boolean {
  const domain = bareJid(jid).split("@")[1];
  if (!domain) return false;
  
  // Common MUC domain patterns
  const mucPatterns = [
    "conference.",
    "muc.",
    "rooms.",
    "chat.",
    "groupchat.",
  ];
  
  // Check custom domains
  if (mucDomains?.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return true;
  }
  
  // Check common patterns
  return mucPatterns.some((pattern) => domain.startsWith(pattern));
}

/**
 * Normalize XMPP target for messaging
 */
export function normalizeXmppTarget(raw: string | null | undefined): string | null {
  if (!raw) return null;
  
  let target = raw.trim();
  
  // Strip xmpp: or jabber: prefix
  target = target.replace(/^(xmpp|jabber):/i, "");
  
  // Validate
  if (!looksLikeXmppJid(target)) return null;
  
  // Return bare JID
  return bareJid(target);
}

/**
 * Normalize XMPP messaging target (for plugin interface)
 */
export function normalizeXmppMessagingTarget(params: {
  target?: string;
}): { targetId: string } | null {
  const normalized = normalizeXmppTarget(params.target);
  return normalized ? { targetId: normalized } : null;
}

/**
 * Format JID for display
 */
export function formatXmppJid(jid: string): string {
  return bareJid(jid);
}

/**
 * Extract resource from full JID
 */
export function extractResource(jid: string): string | undefined {
  const parts = jid.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : undefined;
}

/**
 * Build full JID from bare JID and resource
 */
export function buildFullJid(bareJid: string, resource: string): string {
  return `${bareJid}/${resource}`;
}

/**
 * Normalized allowFrom list result
 */
export interface NormalizedAllowFrom {
  entries: string[];
  hasWildcard: boolean;
}

/**
 * Normalize allowFrom list for matching
 */
export function normalizeAllowFrom(list?: string[]): NormalizedAllowFrom {
  if (!list || list.length === 0) {
    return { entries: [], hasWildcard: true }; // Empty = allow all
  }
  const entries = list.map((jid) => bareJid(jid).toLowerCase());
  const hasWildcard = entries.includes("*");
  return { entries, hasWildcard };
}

/**
 * Check if sender is allowed based on normalized allowFrom
 */
export function isSenderAllowed(allowFrom: NormalizedAllowFrom, senderJid: string): boolean {
  if (allowFrom.hasWildcard || allowFrom.entries.length === 0) return true;
  const normalized = bareJid(senderJid).toLowerCase();
  return allowFrom.entries.includes(normalized);
}
