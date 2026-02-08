import type { OpenClawConfig, RuntimeEnv, WizardPrompter } from "openclaw/plugin-sdk";
import { formatDocsLink, DEFAULT_ACCOUNT_ID, normalizeAccountId, promptAccountId } from "openclaw/plugin-sdk";
import type { ChannelOnboardingAdapter, ChannelOnboardingStatus, ChannelOnboardingResult } from "./types.js";
import { listXmppAccountIds, resolveDefaultXmppAccountId, resolveXmppAccount } from "./accounts.js";
import { bareJid } from "./config-schema.js";

const channel = "xmpp" as const;

/**
 * Merge XMPP config into OpenClaw config
 */
function mergeXmppConfig(
  cfg: OpenClawConfig,
  updates: Record<string, unknown>,
  opts?: { unsetOnUndefined?: string[] }
): OpenClawConfig {
  const current = (cfg.channels?.xmpp ?? {}) as Record<string, unknown>;
  const merged = { ...current, ...updates } as Record<string, unknown>;

  // Remove undefined keys if specified
  if (opts?.unsetOnUndefined) {
    for (const key of opts.unsetOnUndefined) {
      if (updates[key] === undefined) {
        delete merged[key];
      }
    }
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      xmpp: merged,
    },
  };
}

/**
 * Prompt for XMPP JID and password
 */
async function promptXmppCredentials(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  accountId: string
): Promise<OpenClawConfig> {
  const existing = resolveXmppAccount({ cfg, accountId });

  const jid = await prompter.text({
    message: "XMPP JID (e.g., bot@example.com)",
    placeholder: "bot@xmpp.example.com",
    initialValue: existing?.config?.jid,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "JID is required";
      if (!raw.includes("@")) return "JID must include @ symbol";
      return undefined;
    },
  });

  // Note: WizardPrompter doesn't have a password method, use text instead
  const password = await prompter.text({
    message: "XMPP password",
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "Password is required";
      return undefined;
    },
  });

  const server = await prompter.text({
    message: "XMPP server (leave empty to derive from JID)",
    placeholder: jid.split("@")[1] ?? "",
    initialValue: existing?.config?.server,
  });

  const updates: Record<string, unknown> = {
    jid: jid.trim(),
    password: password.trim(),
  };

  if (server?.trim()) {
    updates.server = server.trim();
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return mergeXmppConfig(cfg, updates);
  }

  const xmppConfig = (cfg.channels?.xmpp ?? {}) as Record<string, unknown>;
  const xmppAccounts = (xmppConfig.accounts ?? {}) as Record<string, Record<string, unknown>>;

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      xmpp: {
        ...xmppConfig,
        accounts: {
          ...xmppAccounts,
          [accountId]: {
            ...(xmppAccounts[accountId] ?? {}),
            ...updates,
            enabled: true,
          },
        },
      },
    },
  };
}

/**
 * Prompt for bot owner JIDs (allowFrom)
 */
async function promptXmppOwners(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const existing = (cfg.channels?.xmpp as Record<string, unknown>)?.allowFrom as string[] | undefined;
  const existingLabel = existing?.length ? existing.join(", ") : "none";

  await prompter.note(
    [
      "`allowFrom` defines the bot owners — JIDs that always have direct chat access",
      "and can manage pairings. At least one owner JID is recommended.",
      "",
      `Current owners: ${existingLabel}`,
    ].join("\n"),
    "Bot owners"
  );

  const allowFromRaw = await prompter.text({
    message: "Owner JIDs (comma-separated)",
    placeholder: "owner@example.com, admin@example.com",
    initialValue: existing?.join(", "),
  });

  const allowFromJids = allowFromRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((jid) => bareJid(jid));

  return mergeXmppConfig(cfg, { allowFrom: allowFromJids.length > 0 ? allowFromJids : undefined });
}

/**
 * Prompt for guest direct chat policy (used by dmPolicy adapter)
 */
async function promptXmppDmPolicy(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  await prompter.note(
    [
      "`dmPolicy` controls what happens when someone NOT in allowFrom direct-chats the bot:",
      "  - open (default): guests can message freely",
      "  - disabled: only owners may direct-chat",
      "  - pairing: guests get a pairing code; an owner must approve",
      "  - allowlist: only allowFrom JIDs may direct-chat",
      "",
      `Docs: ${formatDocsLink("/xmpp", "xmpp")}`,
    ].join("\n"),
    "Guest direct chat policy"
  );

  const policy = await prompter.select({
    message: "Direct chat policy for guests (non-owners)",
    options: [
      { value: "open", label: "Open (allow all)" },
      { value: "disabled", label: "Disabled (owners only)" },
      { value: "pairing", label: "Pairing (require owner approval)" },
      { value: "allowlist", label: "Allowlist only (only allowFrom JIDs)" },
    ],
  });

  return mergeXmppConfig(cfg, { dmPolicy: policy });
}

/**
 * Prompt for MUC rooms to join
 */
async function promptXmppMucs(
  cfg: OpenClawConfig,
  prompter: WizardPrompter
): Promise<OpenClawConfig> {
  const existing = (cfg.channels?.xmpp as Record<string, unknown>)?.mucs as string[] | undefined;

  const wantsMucs = await prompter.confirm({
    message: "Configure MUC (group chat) rooms?",
    initialValue: (existing?.length ?? 0) > 0,
  });

  if (!wantsMucs) {
    return cfg;
  }

  const mucsRaw = await prompter.text({
    message: "MUC room JIDs (comma-separated)",
    placeholder: "room@conference.example.com",
    initialValue: existing?.join(", "),
  });

  const mucs = mucsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return mergeXmppConfig(cfg, { mucs: mucs.length > 0 ? mucs : undefined });
}

/**
 * XMPP Onboarding Adapter
 */
export const xmppOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,

  getStatus: async ({ cfg, accountOverrides }): Promise<ChannelOnboardingStatus> => {
    const overrideId = accountOverrides?.xmpp?.trim();
    const defaultAccountId = resolveDefaultXmppAccountId(cfg);
    const accountId = overrideId ? normalizeAccountId(overrideId) : defaultAccountId;
    const account = resolveXmppAccount({ cfg, accountId });
    const configured = Boolean(account?.config?.jid && account?.config?.password);
    const accountLabel = accountId === DEFAULT_ACCOUNT_ID ? "default" : accountId;

    return {
      channel,
      configured,
      statusLines: [`XMPP (${accountLabel}): ${configured ? "configured" : "not configured"}`],
      selectionHint: configured ? "configured" : "not configured",
      quickstartScore: configured ? 3 : 2,
    };
  },

  configure: async ({
    cfg,
    runtime,
    prompter,
    options,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }): Promise<ChannelOnboardingResult> => {
    const overrideId = accountOverrides?.xmpp?.trim();
    let accountId = overrideId
      ? normalizeAccountId(overrideId)
      : resolveDefaultXmppAccountId(cfg);

    if (shouldPromptAccountIds || options?.promptXmppAccountId) {
      if (!overrideId) {
        accountId = await promptAccountId({
          cfg,
          prompter,
          label: "XMPP",
          currentId: accountId,
          listAccountIds: listXmppAccountIds,
          defaultAccountId: resolveDefaultXmppAccountId(cfg),
        });
      }
    }

    let next = cfg;

    // Enable account if using non-default
    if (accountId !== DEFAULT_ACCOUNT_ID) {
      const xmppConfig = (next.channels?.xmpp ?? {}) as Record<string, unknown>;
      const xmppAccounts = (xmppConfig.accounts ?? {}) as Record<string, Record<string, unknown>>;
      next = {
        ...next,
        channels: {
          ...next.channels,
          xmpp: {
            ...xmppConfig,
            accounts: {
              ...xmppAccounts,
              [accountId]: {
                ...(xmppAccounts[accountId] ?? {}),
                enabled: true,
              },
            },
          },
        },
      };
    }

    // Prompt for credentials
    next = await promptXmppCredentials(next, prompter, accountId);

    // Prompt for bot owner JIDs
    next = await promptXmppOwners(next, prompter);

    // Prompt for MUC rooms
    next = await promptXmppMucs(next, prompter);

    await prompter.note(
      [
        "XMPP configuration complete.",
        `Run \`openclaw gateway\` to start the XMPP connection.`,
        `Docs: ${formatDocsLink("/xmpp", "xmpp")}`,
      ].join("\n"),
      "XMPP setup"
    );

    return { cfg: next, accountId };
  },

  // Guest DM policy is handled by the wizard's dedicated DM-policy pass
  dmPolicy: {
    label: "XMPP",
    channel,
    policyKey: "channels.xmpp.dmPolicy",
    allowFromKey: "channels.xmpp.allowFrom",
    getCurrent: (cfg) => (cfg.channels?.xmpp as Record<string, unknown>)?.dmPolicy as string ?? "open",
    setPolicy: (cfg, policy) => mergeXmppConfig(cfg, { dmPolicy: policy }),
    promptAllowFrom: async ({ cfg, prompter }) => promptXmppDmPolicy(cfg, prompter),
  },
};

export { mergeXmppConfig };
