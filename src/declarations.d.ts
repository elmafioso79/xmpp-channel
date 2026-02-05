declare module "openclaw/plugin-sdk" {
  export interface ChannelConfigSchema {
    schema: Record<string, unknown>;
    uiHints?: Record<string, unknown>;
  }

  /** Tool policy for group tool access control */
  export interface GroupToolPolicyConfig {
    /** Tools to explicitly allow */
    allow?: string[];
    /** Tools to explicitly deny */
    deny?: string[];
  }
  
  /** Per-sender tool policy configuration */
  export type GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig | undefined>;

  export interface OpenClawPluginApi {
    runtime: PluginRuntime;
    registerChannel: (registration: { plugin: unknown; dock?: unknown }) => void;
    [key: string]: unknown;
  }

  export interface OpenClawConfig {
    channels?: {
      xmpp?: unknown;
      [key: string]: unknown;
    };
    session?: {
      store?: unknown;
    };
    [key: string]: unknown;
  }

  export interface RuntimeEnv {
    log: (message: string) => void;
    error: (message: string) => void;
    [key: string]: unknown;
  }

  export interface WizardPrompter {
    text: (options: {
      message: string;
      placeholder?: string;
      initialValue?: string;
      validate?: (value: string) => string | undefined;
    }) => Promise<string>;
    password: (options: {
      message: string;
      validate?: (value: string) => string | undefined;
    }) => Promise<string>;
    confirm: (options: {
      message: string;
      initialValue?: boolean;
    }) => Promise<boolean>;
    select: <T extends string>(options: {
      message: string;
      options: Array<{ value: T; label: string }>;
    }) => Promise<T>;
    note: (message: string, title?: string) => Promise<void>;
    outro: (message: string) => Promise<void>;
    [key: string]: unknown;
  }

  export interface PluginRuntime {
    channel: {
      routing: {
        resolveAgentRoute: (params: unknown) => {
          agentId: string;
          sessionKey: string;
          mainSessionKey: string;
          accountId: string;
        };
      };
      session: {
        resolveStorePath: (store: unknown, params: { agentId: string }) => string;
        recordInboundSession: (params: unknown) => Promise<void>;
      };
      reply: {
        buildReplyContext: (params: unknown) => Record<string, unknown>;
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T, opts?: unknown) => T & { CommandAuthorized: boolean };
        dispatchReplyWithBufferedBlockDispatcher: (params: unknown) => Promise<{ queuedFinal: boolean }>;
      };
    };
    [key: string]: unknown;
  }

  export function emptyPluginConfigSchema(): Record<string, unknown>;
  export function buildChannelConfigSchema(schema: unknown): { schema: Record<string, unknown> };
  export function formatDocsLink(path: string, label: string): string;
  export function formatPairingApproveHint(channel: string): string;
  export function promptAccountId(params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    label: string;
    currentId: string;
    listAccountIds: (cfg: OpenClawConfig) => string[];
    defaultAccountId: string;
  }): Promise<string>;

  export const DEFAULT_ACCOUNT_ID: string;
  export function normalizeAccountId(id: string | null | undefined): string;
  export const PAIRING_APPROVED_MESSAGE: string;
  
  /** Resolve tool policy for a sender from toolsBySender config */
  export function resolveToolsBySender(params: {
    toolsBySender?: GroupToolPolicyBySenderConfig;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
  }): GroupToolPolicyConfig | undefined;
}

declare module "@xmpp/client" {
  export function client(options: {
    service: string;
    domain: string;
    username: string;
    password: string;
    resource?: string;
  }): XmppClient;

  export function xml(name: string, attrs?: Record<string, string>, ...children: unknown[]): Element;

  export interface XmppClient {
    jid?: { toString(): string };
    on(event: "stanza", handler: (stanza: Element) => void): void;
    on(event: "online", handler: (address: { toString(): string }) => void): void;
    on(event: "offline", handler: () => void): void;
    on(event: "error", handler: (err: Error) => void): void;
    off(event: "stanza", handler: (stanza: Element) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
    removeListener(event: "stanza", handler: (stanza: Element) => void): void;
    removeListener(event: string, handler: (...args: unknown[]) => void): void;
    start(): Promise<void>;
    stop(): Promise<void>;
    send(stanza: Element): Promise<void>;
  }

  export interface Element {
    name: string;
    is(name: string): boolean;
    attrs: Record<string, string>;
    getChildText(name: string): string | null;
    getChild(name: string, xmlns?: string): Element | undefined;
    getChildren(name: string): Element[];
    text(): string;
    children?: Array<Element | string>;
    toString(): string;
  }
}

declare module "@xmpp/debug" {
  export default function debug(client: unknown, enabled?: boolean): void;
}
