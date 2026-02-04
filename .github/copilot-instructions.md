# OpenClaw XMPP Channel Plugin - Copilot Instructions

## Project Overview
This is an **OpenClaw Channel Plugin** enabling XMPP/Jabber connectivity (Prosody, ejabberd, etc.). It bridges XMPP messaging with the OpenClaw gateway.

**Core Stack:** TypeScript, Node.js, `@xmpp/client` (xmpp.js), Zod  
**Reference:** `openclaw/openclaw/extensions/whatsapp` for complete plugin patterns

## Architecture

```
src/
├── index.ts           # Plugin entry, exports dock + handlers
├── channel.ts         # Main channel plugin with all adapters
├── accounts.ts        # Account resolution utilities
├── config-schema.ts   # Zod schema for config validation
├── monitor.ts         # XMPP connection lifecycle, inbound handling
├── outbound.ts        # Send messages to XMPP
├── onboarding.ts      # CLI setup wizard adapter
├── actions.ts         # Message actions (reactions via XEP-0444)
├── directory.ts       # Contact/room directory listings
├── heartbeat.ts       # Heartbeat adapter for status checks
├── normalize.ts       # JID normalization utilities
├── status-issues.ts   # Status issue detection
├── types.ts           # TypeScript interfaces
├── runtime.ts         # Runtime getter/setter pattern
└── declarations.d.ts  # Type declarations for SDK
```

## Key Patterns

### Plugin Entry Point (`index.ts`)
Follow OpenClaw's plugin registration pattern:
```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { xmppPlugin } from "./channel.js";
import { setXmppRuntime } from "./runtime.js";

const plugin = {
  id: "xmpp",
  name: "XMPP",
  description: "XMPP channel plugin (Prosody, ejabberd)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setXmppRuntime(api.runtime);
    api.registerChannel({ plugin: xmppPlugin });
  },
};
export default plugin;
```

### Channel Plugin Structure (`channel.ts`)
Implement full `ChannelPlugin` interface from `openclaw/plugin-sdk`:
```typescript
export const xmppPlugin = {
  id: "xmpp",
  meta: {
    id: "xmpp",
    label: "XMPP",
    selectionLabel: "XMPP (Jabber/Prosody/ejabberd)",
    docsPath: "/channels/xmpp",
    blurb: "Connect to XMPP servers",
    quickstartAllowFrom: true,
  },
  configSchema: buildChannelConfigSchema(XmppConfigSchema),
  capabilities: { chatTypes: ["direct", "group"], reactions: true },
  
  // All adapters
  onboarding: xmppOnboardingAdapter,
  pairing: { idLabel: "xmppSenderId", normalizeAllowEntry: (e) => bareJid(e) },
  config: { listAccountIds, resolveAccount, defaultAccountId, ... },
  security: { resolveDmPolicy: ... },
  groups: { resolveRequireMention: ... },
  mentions: { stripPatterns: ... },
  threading: { resolveReplyToMode, buildToolContext },
  messaging: { normalizeTarget, targetResolver },
  directory: { self, listPeers, listGroups },
  actions: { listActions, supportsAction, handleAction },
  outbound: { deliveryMode, resolveTarget, sendText },
  gateway: { startAccount },
  heartbeat: { checkReady, resolveRecipients },
  status: { defaultRuntime, collectStatusIssues, probeAccount, ... },
};
```

### Runtime Module (`runtime.ts`)
Getter/setter pattern for runtime access:
```typescript
import type { PluginRuntime } from 'openclaw/plugin-sdk';

let runtime: PluginRuntime | null = null;

export function setXmppRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getXmppRuntime(): PluginRuntime {
  if (!runtime) throw new Error('XMPP runtime not initialized');
  return runtime;
}
```

### Gateway Lifecycle (`gateway` adapter)
Persistent connection management with abort signal:
```typescript
gateway: {
  startAccount: async (ctx: GatewayStartContext): Promise<GatewayStopResult> => {
    const { account, cfg, abortSignal, log } = ctx;
    const xmpp = client({ /* config */ });
    
    xmpp.on('stanza', async (stanza) => {
      if (stanza.is('message')) {
        await handleInboundMessage(stanza, cfg, account, log);
      }
    });
    
    await xmpp.start();
    log?.info?.(`[${account.accountId}] XMPP connected`);
    
    let stopped = false;
    abortSignal?.addEventListener('abort', () => {
      if (stopped) return;
      stopped = true;
      xmpp.stop();
    });
    
    return { stop: () => { stopped = true; xmpp.stop(); } };
  },
},
```

### Plugin Manifest (`openclaw.plugin.json`)
- `id` and `channel.id` must be `"xmpp"`
- `configSchema` defines user-configurable options with JSON Schema
- Required fields: `jid`, `password`; optional: `server`, `port`, `mucs`, `prosodyHttp`

### XMPP Client Usage
```typescript
import { client, xml } from '@xmpp/client'

// Always destructure JID for username
const xmpp = client({
  service: `xmpp://${config.server}:${config.port}`,
  username: config.jid.split('@')[0],
  password: config.password,
  resource: config.resource ?? 'openclaw'
})
```

### Message Handling
- **Inbound:** Listen on `xmpp.on('stanza', ...)`, filter for `stanza.is('message')`
- **Outbound direct:** `xml('message', { to: jid, type: 'chat' }, xml('body', {}, text))`
- **Outbound MUC:** Use `type: 'groupchat'` for multi-user chat rooms
- **Media:** Implement XEP-0363 HTTP File Upload via `fileUploadUrl` config

### JID Normalization
- Strip resource from JIDs for `allowFrom` matching: `jid.split('/')[0]`
- Store bare JIDs in config, handle full JIDs at runtime

### Reconnection
Implement auto-reconnect with exponential backoff on `offline` and `error` events.

## Adapter Patterns

### Onboarding Adapter (`onboarding.ts`)
CLI wizard for channel setup:
```typescript
export const xmppOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "xmpp",
  getStatus: async ({ cfg }) => ({ channel: "xmpp", configured: Boolean(cfg.channels?.xmpp?.jid) }),
  configure: async ({ cfg, prompter }) => {
    const jid = await prompter.text({ message: "XMPP JID" });
    // ... prompt for password, allowFrom, MUCs
    return { cfg: mergedConfig, accountId };
  },
  dmPolicy: { label: "XMPP", channel: "xmpp", ... },
};
```

### Actions Adapter (`actions.ts`)
Message reactions via XEP-0444:
```typescript
export const xmppMessageActions = {
  listActions: ({ cfg }) => cfg.channels?.xmpp?.actions?.reactions ? ["react"] : [],
  supportsAction: ({ action }) => action === "react",
  handleAction: async ({ action, params, cfg, accountId }) => {
    // Send XEP-0444 reaction stanza
  },
};
```

### Directory Adapter (`directory.ts`)
Contact and room listings:
```typescript
export const xmppDirectoryAdapter = {
  self: async ({ cfg, accountId }) => ({ kind: "user", id: jid, name: "Bot" }),
  listPeers: async (params) => allowFrom.map((jid) => ({ kind: "user", id: jid })),
  listGroups: async (params) => mucs.map((muc) => ({ kind: "group", id: muc })),
};
```

### Heartbeat Adapter (`heartbeat.ts`)
Status checks and notifications:
```typescript
export const xmppHeartbeatAdapter = {
  checkReady: async ({ cfg, accountId }) => ({ ok: Boolean(activeClient), reason: "ok" }),
  resolveRecipients: ({ cfg, opts }) => ({ recipients: allowFrom, source: "allowFrom" }),
};
```

### Status Issues (`status-issues.ts`)
Detect and report problems:
```typescript
export function collectXmppStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  // Check configured, running, connected status
  // Return issues with fix suggestions
}
```

## Conventions

- **Config access:** Always validate against `config-schema.ts` before use
- **Logging:** Use OpenClaw's logging context, not raw `console.log`
- **Error handling:** Wrap XMPP operations in try/catch; emit structured errors to OpenClaw
- **Types:** Define interfaces for `XmppConfig`, `InboundMessage`, `OutboundMessage`

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Watch mode for development
npm test             # Run tests
```

## Development Phases

**Phase 1: Basic XMPP** — Connection, auth, reconnect, direct messages ✅  
**Phase 2: Groups & Adapters** — MUC, onboarding, pairing, security, actions, directory, heartbeat, status ✅  
**Phase 3: Advanced** — XEP-0363 file upload, Prosody HTTP API, live directory queries

## Dependencies

```json
{
  "@xmpp/client": "^0.13.1",
  "@xmpp/debug": "^0.13.1",
  "zod": "^3.22.0"
}
```

## Configuration Structure

Channel config lives under `channels.xmpp.accounts.<accountId>`:
```json
{
  "channels": {
    "xmpp": {
      "accounts": {
        "default": {
          "jid": "bot@example.com",
          "password": "secret123",
          "server": "example.com",
          "port": 5222,
          "allowFrom": ["user1@example.com"],
          "mucs": ["room@conference.example.com"],
          "fileUploadUrl": "https://upload.example.com"
        }
      }
    }
  }
}
```

## Testing Notes
- Mock `@xmpp/client` for unit tests
- Test stanza parsing with real XML samples from Prosody/ejabberd
- Validate config schema with edge cases (missing optional fields, invalid JIDs)
