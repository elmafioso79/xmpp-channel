/**
 * XMPP target normalization utilities
 */

import { bareJid } from "./config-schema.js";
const JID_PREFIX_RE = /^(xmpp|jabber):/i;

/**
 * Normalize a bare JID for stable matching.
 * Applies Unicode NFC normalization and lowercases the domain.
 */
export function normalizeXmppBareJid(jid: string): string {
  const raw = String(jid ?? "").trim().replace(JID_PREFIX_RE, "");
  if (!raw) {
    throw new Error("Empty JID");
  }
  const bare = bareJid(raw).normalize("NFC");
  const at = bare.indexOf("@");
  if (at <= 0 || at >= bare.length - 1) {
    throw new Error(`Invalid JID: ${jid}`);
  }
  const local = bare.slice(0, at).normalize("NFC");
  const domain = bare.slice(at + 1).normalize("NFC").toLowerCase();
  return `${local}@${domain}`;
}

function normalizeXmppBareJidForMatch(jid: string): string {
  return normalizeXmppBareJid(jid).toLowerCase();
}

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
  
  const target = raw.trim().replace(JID_PREFIX_RE, "");
  
  // Validate
  if (!looksLikeXmppJid(target)) return null;
  
  // Return canonical bare JID
  try {
    return normalizeXmppBareJid(target);
  } catch {
    return null;
  }
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
    return { entries: [], hasWildcard: false }; // Empty = allow none
  }
  const rawEntries = list
    .map((jid) => String(jid ?? "").trim())
    .filter(Boolean)
    .map((jid) => jid.replace(JID_PREFIX_RE, ""));
  const hasWildcard = rawEntries.includes("*");
  const entries = rawEntries
    .filter((entry) => entry !== "*")
    .map((jid) => {
      try {
        return normalizeXmppBareJidForMatch(jid);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  return { entries, hasWildcard };
}

/**
 * Check if sender is allowed based on normalized allowFrom
 */
export function isSenderAllowed(allowFrom: NormalizedAllowFrom, senderJid: string): boolean {
  if (allowFrom.hasWildcard) return true;
  if (!senderJid.trim()) return false;
  try {
    const normalized = normalizeXmppBareJidForMatch(senderJid);
    return allowFrom.entries.includes(normalized);
  } catch {
    return false;
  }
}
