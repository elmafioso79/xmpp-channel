import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ChannelConfigSchema } from "openclaw/plugin-sdk";

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
 * XMPP account configuration schema
 */
export const XmppAccountSchema = z.object({
  /** Account name (optional display name) */
  name: z.string().optional(),

  /** Whether this account is enabled */
  enabled: z.boolean().optional().default(true),

  /** Bot JID (e.g., bot@example.com) */
  jid: z.string().optional(),

  /** XMPP account password */
  password: z.string().optional(),

  /** XMPP server hostname (defaults to JID domain) */
  server: z.string().optional(),

  /** XMPP server port */
  port: z.number().int().min(1).max(65535).optional().default(5222),

  /** XMPP resource identifier */
  resource: z.string().optional().default("openclaw"),

  /** Direct message policy */
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional().default("open"),

  /** Group message policy */
  groupPolicy: z.enum(["open", "allowlist"]).optional().default("open"),

  /** Allowed sender JIDs */
  allowFrom: z.array(z.string()).optional(),

  /** MUC rooms to join */
  mucs: z.array(z.string()).optional(),

  /** XEP-0363 HTTP File Upload endpoint (deprecated) */
  fileUploadUrl: z.string().url().optional(),

  /** XEP-0363 HTTP File Upload service JID (auto-discovered if not set) */
  fileUploadService: z.string().optional(),

  /** Action configuration */
  actions: XmppActionSchema.optional(),

  /** Inbound message prefix */
  messagePrefix: z.string().optional(),

  /** Heartbeat visibility */
  heartbeatVisibility: z.enum(["visible", "hidden"]).optional(),
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
 * Convert Zod schema to JSON Schema for OpenClaw plugin system
 */
export function xmppChannelConfigSchema(): ChannelConfigSchema {
  return {
    schema: zodToJsonSchema(XmppConfigSchema, {
      target: "jsonSchema7",
      $refStrategy: "none",
    }) as Record<string, unknown>,
  };
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
