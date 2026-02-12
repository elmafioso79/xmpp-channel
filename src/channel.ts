import type { OpenClawConfig, GroupToolPolicyConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, formatPairingApproveHint, resolveToolsBySender } from "openclaw/plugin-sdk";
import type {
  XmppConfig,
  XmppGroupConfig,
  ResolvedXmppAccount,
  XmppAccountDescriptor,
  GatewayStartContext,
  GatewayStopResult,
  SendResult,
  ChannelAccountSnapshot,
  ThreadingToolContext,
} from "./types.js";
import { xmppChannelConfigSchema, bareJid } from "./config-schema.js";
import { startXmppConnection } from "./monitor.js";
import { sendXmppMessage, sendXmppMedia } from "./outbound.js";
import { xmppOnboardingAdapter } from "./onboarding.js";
import {
  listXmppAccountIds,
  resolveDefaultXmppAccountId,
  resolveXmppAccount,
} from "./accounts.js";
import { collectXmppStatusIssues } from "./status-issues.js";
import { xmppDirectoryAdapter, xmppResolverAdapter } from "./directory.js";
import { xmppMessageActions } from "./actions.js";
import { xmppHeartbeatAdapter } from "./heartbeat.js";
import { normalizeXmppTarget, looksLikeXmppJid, normalizeXmppMessagingTarget, normalizeAllowFrom, isSenderAllowed } from "./normalize.js";

/**
 * Get XMPP config from OpenClaw config
 */
function getConfig(cfg: OpenClawConfig, accountId?: string): XmppConfig {
  const xmppCfg = cfg?.channels?.xmpp as XmppConfig | undefined;
  if (!xmppCfg) return {} as XmppConfig;

  if (accountId && xmppCfg.accounts?.[accountId]) {
    return { ...xmppCfg, ...xmppCfg.accounts[accountId] };
  }

  return xmppCfg;
}

/**
 * Check if XMPP is configured
 */
function isConfigured(cfg: OpenClawConfig, accountId?: string): boolean {
  const config = getConfig(cfg, accountId);
  return Boolean(config.jid && config.password);
}

/**
 * Format allowFrom entries for storage
 */
function formatAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return allowFrom
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^(xmpp|jabber):/i, ""))
    .map((entry) => bareJid(entry).toLowerCase());
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * XMPP Channel Plugin Definition
 */
export const xmppPlugin = {
  id: "xmpp",
  meta: {
    id: "xmpp",
    label: "XMPP",
    selectionLabel: "XMPP (Jabber/Prosody/ejabberd)",
    docsPath: "/channels/xmpp",
    docsLabel: "xmpp",
    blurb: "Connect to XMPP servers including Prosody and ejabberd.",
    systemImage: "message.badge.filled.fill",
    aliases: ["jabber", "prosody", "ejabberd"],
    order: 70,
    quickstartAllowFrom: true,
  },
  
  configSchema: xmppChannelConfigSchema(),
  
  capabilities: {
    chatTypes: ["direct", "group"] as const,
    reactions: true, // XEP-0444
    threads: false,
    media: false, // Phase 3: XEP-0363
    polls: false,
  },
  
  reload: { configPrefixes: ["channels.xmpp"] },
  
  // Onboarding wizard
  onboarding: xmppOnboardingAdapter,

  // Pairing support
  pairing: {
    idLabel: "xmppSenderId",
    normalizeAllowEntry: (entry: string) => bareJid(entry.replace(/^(xmpp|jabber):/i, "")),
    notifyApproval: async ({ id }: { cfg: OpenClawConfig; id: string }) => {
      // Pairing approval handled via XMPP message when user sends next message
      void id;
    },
  },

  // Config adapter
  config: {
    listAccountIds: (cfg: OpenClawConfig): string[] => listXmppAccountIds(cfg),
    
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null): ResolvedXmppAccount => 
      resolveXmppAccount({ cfg, accountId }),
    
    defaultAccountId: (cfg: OpenClawConfig): string => resolveDefaultXmppAccountId(cfg),
    
    setAccountEnabled: ({ cfg, accountId, enabled }: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const xmppConfig = (cfg.channels?.xmpp ?? {}) as Record<string, unknown>;
      
      if (accountKey === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            xmpp: {
              ...xmppConfig,
              enabled,
            },
          },
        };
      }
      const accounts = { ...(xmppConfig.accounts as Record<string, unknown> ?? {}) };
      accounts[accountKey] = { ...(accounts[accountKey] as Record<string, unknown> ?? {}), enabled };
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          xmpp: {
            ...xmppConfig,
            accounts,
          },
        },
      };
    },
    
    deleteAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const xmppConfig = (cfg.channels?.xmpp ?? {}) as Record<string, unknown>;
      const accounts = { ...(xmppConfig.accounts as Record<string, unknown> ?? {}) };
      delete accounts[accountKey];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          xmpp: {
            ...xmppConfig,
            accounts: Object.keys(accounts).length ? accounts : undefined,
          },
        },
      };
    },
    
    isEnabled: (account: ResolvedXmppAccount): boolean => account.enabled,
    disabledReason: (): string => "disabled",
    
    isConfigured: (account: ResolvedXmppAccount): boolean =>
      Boolean(account.config?.jid && account.config?.password),
    unconfiguredReason: (): string => "not configured",
    
    describeAccount: (account: ResolvedXmppAccount): XmppAccountDescriptor => ({
      accountId: account.accountId,
      name: account.config?.name || "XMPP",
      enabled: account.enabled,
      configured: Boolean(account.config?.jid),
      dmPolicy: account.config?.dmPolicy,
      allowFrom: account.config?.allowFrom,
    }),
    
    resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
      resolveXmppAccount({ cfg, accountId }).config?.allowFrom ?? [],
    
    formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
      formatAllowFromEntries(allowFrom),
  },

  // Security adapter
  security: {
    resolveDmPolicy: ({ account }: { account: ResolvedXmppAccount }) => ({
      policy: account.config?.dmPolicy || "open",
      allowFrom: account.config?.dmAllowlist || [],
      policyPath: "channels.xmpp.dmPolicy",
      allowFromPath: "channels.xmpp.dmAllowlist",
      approveHint: formatPairingApproveHint("xmpp"),
      normalizeEntry: (raw: string) => bareJid(raw.replace(/^(xmpp|jabber):/i, "")),
    }),
  },

  // Groups adapter
  groups: {
    resolveRequireMention: ({ cfg }: { cfg: OpenClawConfig }): boolean =>
      getConfig(cfg).groupPolicy !== "open",
    resolveGroupIntroHint: (): string | undefined =>
      "XMPP group chat. Mention the bot or use a direct chat for commands.",
    resolveToolPolicy: (params: {
      cfg: OpenClawConfig;
      groupId?: string | null;
      accountId?: string | null;
      senderId?: string | null;
      senderName?: string | null;
      senderUsername?: string | null;
      senderE164?: string | null;
    }): GroupToolPolicyConfig | undefined => {
      const config = getConfig(params.cfg);
      const accountConfig = params.accountId 
        ? (config.accounts?.[params.accountId] ?? config)
        : config;
      
      // Get group settings (keyed by room JID or "*" for default)
      const groupsConfig: Record<string, XmppGroupConfig> | undefined = accountConfig.groupSettings;
      
      if (!groupsConfig) return undefined;
      
      // First try specific group, then fallback to "*" default
      const groupId = params.groupId ?? undefined;
      const groupConfig: XmppGroupConfig | undefined = groupId ? groupsConfig[groupId] : undefined;
      const defaultConfig: XmppGroupConfig | undefined = groupsConfig["*"];
      
      // Priority: sender-specific in group > group tools > sender-specific in default > default tools
      // 1. Check sender-specific policy for this group
      if (groupConfig?.toolsBySender) {
        const senderPolicy = resolveToolsBySender({
          toolsBySender: groupConfig.toolsBySender,
          senderId: params.senderId ?? undefined,
          senderName: params.senderName ?? undefined,
          senderUsername: params.senderUsername ?? undefined,
          senderE164: params.senderE164 ?? undefined,
        });
        if (senderPolicy) return senderPolicy;
      }
      
      // 2. Check group-level tools policy
      if (groupConfig?.tools) return groupConfig.tools;
      
      // 3. Check sender-specific policy for default group
      if (defaultConfig?.toolsBySender) {
        const senderPolicy = resolveToolsBySender({
          toolsBySender: defaultConfig.toolsBySender,
          senderId: params.senderId ?? undefined,
          senderName: params.senderName ?? undefined,
          senderUsername: params.senderUsername ?? undefined,
          senderE164: params.senderE164 ?? undefined,
        });
        if (senderPolicy) return senderPolicy;
      }
      
      // 4. Check default group tools policy
      if (defaultConfig?.tools) return defaultConfig.tools;
      
      return undefined;
    },
  },

  // Mentions adapter
  mentions: {
    stripPatterns: ({ ctx }: { ctx: { To?: string } }) => {
      const selfJid = ctx.To?.replace(/^xmpp:/, "") || "";
      if (!selfJid) return [];
      const escaped = escapeRegExp(bareJid(selfJid));
      return [escaped, `@${escaped}`];
    },
  },

  // Threading adapter
  threading: {
    resolveReplyToMode: (): "off" | "first" | "all" => "off",
    buildToolContext: ({ context, hasRepliedRef }: { context: Record<string, unknown>; hasRepliedRef?: { value: boolean } }): ThreadingToolContext => ({
      currentChannelId: (context.From as string)?.trim() || undefined,
      currentThreadId: undefined, // XMPP doesn't have native threading
      hasRepliedRef,
    }),
  },

  // Commands adapter
  commands: {
    enforceOwnerForCommands: true,
    skipWhenConfigEmpty: true,
  },

  // Messaging adapter
  messaging: {
    normalizeTarget: normalizeXmppMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeXmppJid,
      hint: "<jid@server.com>",
    },
  },

  // Directory adapter
  directory: xmppDirectoryAdapter,

  // Resolver adapter (for message send target resolution)
  resolver: xmppResolverAdapter,

  // Actions adapter
  actions: xmppMessageActions,

  // Outbound adapter
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 10000,
    
    resolveTarget: ({ to, ctx }: { to?: string; ctx?: Record<string, unknown> }): { ok: true; to: string } | { ok: false; error: Error } => {
      // Try explicit target first
      const trimmed = to?.trim();
      if (trimmed) {
        const normalized = normalizeXmppTarget(trimmed);
        if (normalized) {
          return { ok: true, to: normalized };
        }
        return { ok: false, error: new Error(`Invalid XMPP JID: ${trimmed}`) };
      }
      
      // Fall back to session context (From field contains the peer JID)
      if (ctx) {
        // Check OriginatingTo first (group or DM target)
        const originatingTo = ctx.OriginatingTo as string | undefined;
        if (originatingTo) {
          const jid = originatingTo.replace(/^xmpp:/, "").trim();
          if (jid && looksLikeXmppJid(jid)) {
            return { ok: true, to: bareJid(jid) };
          }
        }
        
        // Check ConversationLabel (room JID for groups, sender JID for DMs)
        const conversationLabel = ctx.ConversationLabel as string | undefined;
        if (conversationLabel && looksLikeXmppJid(conversationLabel)) {
          return { ok: true, to: bareJid(conversationLabel) };
        }
        
        // Check From field
        const from = ctx.From as string | undefined;
        if (from) {
          const jid = from.replace(/^xmpp:/, "").trim();
          if (jid && looksLikeXmppJid(jid)) {
            return { ok: true, to: bareJid(jid) };
          }
        }
      }
      
      return { ok: false, error: new Error("XMPP message requires --to <jid@server> or must be used within an XMPP session context") };
    },
    
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      log,
    }: {
      cfg: OpenClawConfig;
      to: string;
      text: string;
      accountId?: string | null;
      log?: unknown;
    }) => {
      const config = getConfig(cfg, accountId ?? undefined);
      if (!config.jid) {
        throw new Error("XMPP not configured");
      }
      const result = await sendXmppMessage(config, to, text, { log, accountId: accountId ?? undefined });
      if (!result.ok) {
        throw new Error(result.error ?? "Failed to send XMPP message");
      }
      return { channel: "xmpp" as const, messageId: result.messageId ?? `msg_${Date.now()}` };
    },
    
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      accountId,
      log,
    }: {
      cfg: OpenClawConfig;
      to: string;
      text?: string;
      mediaUrl?: string;
      accountId?: string | null;
      log?: unknown;
    }) => {
      const typedLog = log as import("./types.js").Logger | undefined;
      typedLog?.info?.(`[XMPP] outbound.sendMedia called: to=${to}, mediaUrl=${mediaUrl}, text=${text?.substring(0, 50)}`);
      
      const config = getConfig(cfg, accountId ?? undefined);
      if (!config.jid) {
        typedLog?.error?.(`[XMPP] sendMedia: XMPP not configured`);
        throw new Error("XMPP not configured");
      }
      
      let result: SendResult;
      
      // If we have a media URL, use HTTP Upload (XEP-0363)
      if (mediaUrl) {
        typedLog?.info?.(`[XMPP] sendMedia: calling sendXmppMedia with mediaUrl`);
        
        // Resolve local files before calling sendXmppMedia (which only handles network)
        let resolvedMedia: import("./outbound.js").ResolvedMedia | undefined;
        try {
          const url = new URL(mediaUrl);
          if (url.protocol === "file:") {
            const { readFileUrl } = await import("./file-read.js");
            resolvedMedia = readFileUrl(mediaUrl, typedLog);
          }
        } catch {
          // Not a valid URL — treat as local file path
          const { readLocalFile } = await import("./file-read.js");
          const result = readLocalFile(mediaUrl, typedLog);
          if (!result) throw new Error(`File not found: ${mediaUrl}`);
          resolvedMedia = result;
        }
        
        result = await sendXmppMedia(config, to, mediaUrl, text, { 
          log: typedLog, 
          accountId: accountId ?? undefined,
          resolvedMedia,
        });
      } else if (text) {
        // Otherwise, just send text
        typedLog?.info?.(`[XMPP] sendMedia: no mediaUrl, sending text only`);
        result = await sendXmppMessage(config, to, text, { log, accountId: accountId ?? undefined });
      } else {
        typedLog?.warn?.(`[XMPP] sendMedia: no content to send`);
        throw new Error("No content to send");
      }
      
      if (!result.ok) {
        throw new Error(result.error ?? "Failed to send XMPP message");
      }
      
      return { channel: "xmpp" as const, messageId: result.messageId ?? `msg_${Date.now()}` };
    },
  },

  // Gateway adapter
  gateway: {
    startAccount: async (ctx: GatewayStartContext): Promise<void> => {
      return startXmppConnection(ctx);
    },
  },

  // Heartbeat adapter
  heartbeat: xmppHeartbeatAdapter,

  // Status adapter
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastMessageAt: null,
      lastEventAt: null,
      lastError: null,
    } as ChannelAccountSnapshot,
    
    collectStatusIssues: collectXmppStatusIssues,
    
    probeAccount: async ({ account }: { account: ResolvedXmppAccount }) => {
      if (!account.config?.jid) {
        return { ok: false, error: "Not configured" };
      }
      return { ok: true, jid: account.config.jid };
    },
    
    buildChannelSummary: async ({ account, snapshot }: { account: ResolvedXmppAccount; snapshot?: ChannelAccountSnapshot }) => ({
      configured: Boolean(account.config?.jid && account.config?.password),
      enabled: account.enabled,
      running: snapshot?.running ?? false,
      connected: snapshot?.connected ?? false,
      jid: account.config?.jid,
      server: account.config?.server,
      lastConnectedAt: snapshot?.lastConnectedAt ?? null,
      lastError: snapshot?.lastError ?? null,
    }),
    
    buildAccountSnapshot: ({ account, runtime }: { account: ResolvedXmppAccount; runtime?: ChannelAccountSnapshot }): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.config?.name,
      enabled: account.enabled,
      configured: Boolean(account.config?.jid && account.config?.password),
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      lastError: runtime?.lastError ?? null,
      dmPolicy: account.config?.dmPolicy,
      allowFrom: account.config?.allowFrom,
    }),
  },
};

export { getConfig, isConfigured };
