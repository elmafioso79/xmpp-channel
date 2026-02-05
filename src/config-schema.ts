import { z } from "zod";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk";

/**
 * XMPP action configuration schema
 */
export const XmppActionSchema = z.object({
  /** Enable XEP-0444 reactions */
  reactions: z.boolean().optional(),
  /** Enable send message action */
  sendMessage: z.boolean().optional(),
});

/**
 * Tool policy schema for group tool access control
 */
export const ToolPolicySchema = z.object({
  /** Tools to explicitly allow */
  allow: z.array(z.string()).optional(),
  /** Tools to add to an existing allow list */
  alsoAllow: z.array(z.string()).optional(),
  /** Tools to explicitly deny */
  deny: z.array(z.string()).optional(),
});

/**
 * Group-specific configuration schema
 */
export const XmppGroupConfigSchema = z.object({
  /** Require @mention in this group */
  requireMention: z.boolean().optional(),
  /** Group-level tool access policy */
  tools: ToolPolicySchema.optional(),
  /** Per-sender tool access overrides */
  toolsBySender: z.record(z.string(), ToolPolicySchema.optional()).optional(),
});

/**
 * XMPP account configuration schema
 */
export const XmppAccountSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional().describe("Display name for this account"),

  /** Whether this account is enabled */
  enabled: z.boolean().optional().default(true).describe("Enable or disable this account"),

  /** Allow the agent to write to config (e.g., add users to allowlist) */
  configWrites: z.boolean().optional().describe("Allow agent to modify config (default: true)"),

  /** Bot JID (e.g., bot@example.com) */
  jid: z.string().optional().describe("Bot JID (e.g., bot@example.com)"),

  /** XMPP account password */
  password: z.string().optional().describe("XMPP account password"),

  /** XMPP server hostname (defaults to JID domain) */
  server: z.string().optional().describe("XMPP server hostname (defaults to JID domain)"),

  /** XMPP server port */
  port: z.number().int().min(1).max(65535).optional().default(5222).describe("XMPP server port"),

  /** XMPP resource identifier (internal, auto-generated if not set) */
  resource: z.string().optional().describe("XMPP resource identifier (auto-generated for uniqueness)"),

  /** MUC nickname (what's shown in group chats) */
  mucNick: z.string().optional().describe("Display name in group chats (defaults to local part of JID, e.g., 'Aurora')"),

  /** Direct message policy */
  dmPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).optional().default("open").describe("Direct message policy: open (allow all), pairing (require pairing), allowlist (only allowFrom), disabled (block all DMs)"),

  /** Group message policy */
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional().default("open").describe("Group message policy: open (respond to all), allowlist (require mention or allowlist), disabled (block all groups)"),

  /** Allowed sender JIDs (for DMs) */
  allowFrom: z.array(z.string()).optional().describe("Allowed sender JIDs for DMs (use * for all)"),

  /** Allowed sender JIDs for groups */
  groupAllowFrom: z.array(z.string()).optional().describe("Allowed sender JIDs for groups (defaults to allowFrom, use * for all)"),

  /** MUC rooms to join */
  mucs: z.array(z.string()).optional().describe("MUC rooms to join on startup"),

  /** XEP-0363 HTTP File Upload endpoint (deprecated) */
  fileUploadUrl: z.string().url().optional().describe("HTTP File Upload URL (deprecated, use fileUploadService)"),

  /** XEP-0363 HTTP File Upload service JID (auto-discovered if not set) */
  fileUploadService: z.string().optional().describe("HTTP File Upload service JID (auto-discovered if not set)"),

  /** Action configuration */
  actions: XmppActionSchema.optional().describe("Action configuration (reactions, sendMessage)"),

  /** Inbound message prefix */
  messagePrefix: z.string().optional().describe("Prefix added to inbound messages"),

  /** Heartbeat visibility */
  heartbeatVisibility: z.enum(["visible", "hidden"]).optional().describe("Heartbeat visibility in status"),

  /** Per-group configuration (keyed by room JID or "*" for default) */
  groups: z.record(z.string(), XmppGroupConfigSchema).optional().describe("Per-group configuration for tool policies and mentions"),
});

/**
 * XMPP configuration schema using Zod
 */
export const XmppConfigSchema = XmppAccountSchema.extend({
  /** Multi-account configuration */
  accounts: z.record(z.string(), XmppAccountSchema.partial()).optional(),
});

export type XmppConfigSchemaType = z.infer<typeof XmppConfigSchema>;

/**
 * Build channel config schema using OpenClaw SDK helper
 */
export function xmppChannelConfigSchema() {
  return buildChannelConfigSchema(XmppConfigSchema);
}

/**
 * Extract server from JID if not explicitly provided
 */
export function resolveServer(config: { jid: string; server?: string }): string {
  if (config.server) return config.server;
  const domain = config.jid.split("@")[1];
  if (!domain) throw new Error(`Invalid JID: ${config.jid}`);
  return domain;
}

/**
 * Extract username from JID
 */
export function extractUsername(jid: string): string {
  const username = jid.split("@")[0];
  if (!username) throw new Error(`Invalid JID: ${jid}`);
  return username;
}

/**
 * Normalize JID to bare JID (strip resource)
 */
export function bareJid(jid: string): string {
  return jid.split("/")[0];
}
