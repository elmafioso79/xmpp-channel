import type { OpenClawConfig, RuntimeEnv, WizardPrompter } from "openclaw/plugin-sdk";

/**
 * DM Policy type
 */
export type DmPolicy = "open" | "pairing" | "allowlist";

/**
 * Group Policy type
 */
export type GroupPolicy = "open" | "allowlist";

/**
 * XMPP actions configuration
 */
export interface XmppActionConfig {
  /** Enable XEP-0444 reactions */
  reactions?: boolean;
  /** Enable send message action */
  sendMessage?: boolean;
}

/**
 * XMPP channel configuration
 */
export interface XmppConfig {
  /** Bot JID (e.g., bot@example.com) */
  jid: string;
  /** XMPP account password */
  password: string;
  /** XMPP server hostname (defaults to JID domain) */
  server?: string;
  /** XMPP server port (default: 5222) */
  port?: number;
  /** XMPP resource identifier (default: openclaw) */
  resource?: string;
  /** Account display name */
  name?: string;
  /** Whether this account is enabled */
  enabled?: boolean;
  /** Direct message policy */
  dmPolicy?: DmPolicy;
  /** Group message policy */
  groupPolicy?: GroupPolicy;
  /** Allowed sender JIDs */
  allowFrom?: string[];
  /** MUC rooms to join */
  mucs?: string[];
  /** XEP-0363 HTTP File Upload endpoint (deprecated, use fileUploadService) */
  fileUploadUrl?: string;
  /** XEP-0363 HTTP File Upload service JID (auto-discovered if not set) */
  fileUploadService?: string;
  /** Action configuration (reactions, etc.) */
  actions?: XmppActionConfig;
  /** Inbound message prefix */
  messagePrefix?: string;
  /** Heartbeat visibility */
  heartbeatVisibility?: "visible" | "hidden";
  /** Multi-account configuration */
  accounts?: Record<string, XmppConfig>;
}

/**
 * Resolved account with runtime state
 */
export interface ResolvedXmppAccount {
  accountId: string;
  config: XmppConfig;
  enabled: boolean;
}

/**
 * Account descriptor for UI display
 */
export interface XmppAccountDescriptor {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  dmPolicy?: DmPolicy;
  allowFrom?: string[];
}

/**
 * Inbound XMPP message
 */
export interface XmppInboundMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  type: "chat" | "groupchat" | "headline" | "normal" | "error";
  timestamp: number;
  isGroup: boolean;
  roomJid?: string;
  senderNick?: string;
}

/**
 * Channel account snapshot for status updates
 */
export interface ChannelAccountStatusPatch {
  accountId: string;
  running?: boolean;
  connected?: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastConnectedAt?: number | null;
  lastDisconnect?: number | null;
  lastError?: string | null;
  [key: string]: unknown;
}

/**
 * Gateway start context from OpenClaw
 */
export interface GatewayStartContext {
  account: ResolvedXmppAccount;
  accountId: string;
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
  log?: Logger;
  runtime?: unknown;
  setStatus?: (patch: ChannelAccountStatusPatch) => void;
  getStatus?: () => ChannelAccountStatusPatch;
}

/**
 * Gateway stop result
 */
export interface GatewayStopResult {
  stop: () => void;
}

/**
 * Logger interface matching OpenClaw
 */
export interface Logger {
  debug?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
}

/**
 * Send result
 */
export interface SendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  data?: unknown;
}

/**
 * Channel message action names
 */
export type ChannelMessageActionName = "react" | "poll" | "send";

/**
 * Channel directory entry
 */
export interface ChannelDirectoryEntry {
  kind: "user" | "group";
  id: string;
  name?: string;
  raw?: Record<string, unknown>;
}

/**
 * Channel resolve result (for target resolution)
 */
export interface ChannelResolveResult {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  note?: string;
}

/**
 * Channel account snapshot for status
 */
export interface ChannelAccountSnapshot {
  accountId?: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  connected?: boolean;
  running?: boolean;
  lastConnectedAt?: number | null;
  lastDisconnect?: number | null;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  [key: string]: unknown;
}

/**
 * Channel status issue
 */
export interface ChannelStatusIssue {
  channel: string;
  accountId: string;
  kind: "auth" | "runtime" | "config";
  message: string;
  fix?: string;
}

/**
 * Channel onboarding status
 */
export interface ChannelOnboardingStatus {
  channel: string;
  configured: boolean;
  statusLines: string[];
  selectionHint?: string;
  quickstartScore?: number;
}

/**
 * Channel onboarding result
 */
export interface ChannelOnboardingResult {
  cfg: OpenClawConfig;
  accountId?: string;
}

/**
 * Channel onboarding context
 */
export interface ChannelOnboardingContext {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  options?: Record<string, unknown>;
  accountOverrides?: Record<string, string>;
  shouldPromptAccountIds?: boolean;
  forceAllowFrom?: boolean;
}

/**
 * Channel onboarding adapter
 */
export interface ChannelOnboardingAdapter {
  channel: string;
  getStatus: (ctx: { cfg: OpenClawConfig; accountOverrides?: Record<string, string> }) => Promise<ChannelOnboardingStatus>;
  configure: (ctx: ChannelOnboardingContext) => Promise<ChannelOnboardingResult>;
  dmPolicy?: {
    label: string;
    channel: string;
    policyKey: string;
    allowFromKey: string;
    getCurrent: (cfg: OpenClawConfig) => string;
    setPolicy: (cfg: OpenClawConfig, policy: string) => OpenClawConfig;
    promptAllowFrom?: (params: { cfg: OpenClawConfig; prompter: WizardPrompter }) => Promise<OpenClawConfig>;
  };
}

/**
 * Threading tool context
 */
export interface ThreadingToolContext {
  currentChannelId?: string;
  currentThreadId?: string;
  hasRepliedRef?: { value: boolean };
}
