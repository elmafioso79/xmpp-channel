import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { XmppConfig, ResolvedXmppAccount } from "./types.js";

/**
 * Get root XMPP config from OpenClaw config
 */
function getRootConfig(cfg: OpenClawConfig): XmppConfig | undefined {
  return cfg?.channels?.xmpp as XmppConfig | undefined;
}

/**
 * Get account-specific config
 */
function getAccountConfig(cfg: OpenClawConfig, accountId: string): XmppConfig | undefined {
  const root = getRootConfig(cfg);
  if (!root) return undefined;

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return root;
  }

  return root.accounts?.[accountId] as XmppConfig | undefined;
}

/**
 * List all configured XMPP account IDs
 */
export function listXmppAccountIds(cfg: OpenClawConfig): string[] {
  const root = getRootConfig(cfg);
  if (!root) return [];

  const accountIds: string[] = [];

  // Check if root has direct jid config (default account)
  if (root.jid) {
    accountIds.push(DEFAULT_ACCOUNT_ID);
  }

  // Add named accounts
  if (root.accounts) {
    for (const id of Object.keys(root.accounts)) {
      if (!accountIds.includes(id)) {
        accountIds.push(id);
      }
    }
  }

  return accountIds;
}

/**
 * Resolve the default account ID
 */
export function resolveDefaultXmppAccountId(cfg: OpenClawConfig): string {
  const accountIds = listXmppAccountIds(cfg);

  // If there's exactly one account, use it
  if (accountIds.length === 1) {
    return accountIds[0];
  }

  // If there's a default account, use it
  if (accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }

  // If there are accounts but no default, use first one
  if (accountIds.length > 0) {
    return accountIds[0];
  }

  return DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve account configuration by ID
 */
export function resolveXmppAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedXmppAccount {
  const { cfg } = params;
  const accountId = normalizeAccountId(params.accountId ?? resolveDefaultXmppAccountId(cfg));
  const root = getRootConfig(cfg);

  // Get account-specific config or fall back to root
  let config: XmppConfig;

  if (accountId === DEFAULT_ACCOUNT_ID) {
    config = root ?? ({} as XmppConfig);
  } else {
    const accountConfig = getAccountConfig(cfg, accountId);
    // Merge account config with root for inherited settings
    config = {
      ...root,
      ...accountConfig,
    } as XmppConfig;
  }

  return {
    accountId,
    config,
    enabled: config?.enabled !== false,
  };
}

/**
 * List all enabled XMPP accounts
 */
export function listEnabledXmppAccounts(cfg: OpenClawConfig): ResolvedXmppAccount[] {
  return listXmppAccountIds(cfg)
    .map((id) => resolveXmppAccount({ cfg, accountId: id }))
    .filter((account) => account.enabled);
}

/**
 * Check if XMPP is configured for any account
 */
export function isXmppConfigured(cfg: OpenClawConfig): boolean {
  return listXmppAccountIds(cfg).some((id) => {
    const account = resolveXmppAccount({ cfg, accountId: id });
    return Boolean(account.config?.jid && account.config?.password);
  });
}
