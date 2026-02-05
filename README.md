# XMPP Channel for OpenClaw

XMPP/Jabber channel plugin for OpenClaw, supporting Prosody, ejabberd, and other XMPP servers.

## Features

- **Direct Messages** — One-on-one chat via XMPP
- **Group Chat** — Multi-User Chat (MUC) with auto-join and invite handling
- **Multi-Account** — Configure multiple XMPP accounts
- **Allowlist** — Control who can interact with the bot (DM and group policies)
- **Pairing** — Approve unknown senders with pairing codes
- **Reactions** — XEP-0444 message reactions support
- **Typing Indicators** — XEP-0085 chat state notifications
- **Read Receipts** — XEP-0333 chat markers
- **Reply Context** — XEP-0461 message replies with fallback
- **Media Upload** — XEP-0363 HTTP file upload with auto-discovery
- **Stream Management** — XEP-0198 for reliable message delivery
- **Keepalive** — XEP-0199 ping for connection stability
- **Auto-Reconnect** — Exponential backoff reconnection
- **Heartbeat** — Periodic status checks and notifications
- **Onboarding** — CLI setup wizard integration
- **Directory** — Contact and room listings

## Installation

### From GitHub
```bash
openclaw plugins install github:elmafioso79/xmpp-channel
```

### Manual Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/elmafioso79/xmpp-channel.git ~/.openclaw/extensions/xmpp
   ```
2. Install dependencies and build:
   ```bash
   cd ~/.openclaw/extensions/xmpp
   npm install
   npm run build
   ```
3. Add to your `openclaw.json`:

```json
{
  "channels": {
    "xmpp": {
      "enabled": true,
      "jid": "bot@example.com",
      "password": "your-password",
      "server": "example.com",
      "port": 5222,
      "dmPolicy": "pairing",
      "allowFrom": ["user1@example.com", "user2@example.com"],
      "mucs": ["room@conference.example.com"],
      "actions": {
        "reactions": true
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `jid` | string | **required** | Bot JID (e.g., `bot@example.com`) |
| `password` | string | **required** | XMPP account password |
| `server` | string | JID domain | XMPP server hostname |
| `port` | number | `5222` | XMPP server port |
| `resource` | string | `openclaw` | XMPP resource identifier |
| `name` | string | - | Account display name |
| `enabled` | boolean | `true` | Whether account is enabled |
| `dmPolicy` | string | `open` | DM policy: `open`, `pairing`, `allowlist` |
| `groupPolicy` | string | `open` | Group policy: `open`, `allowlist` |
| `allowFrom` | string[] | `[]` | Allowed sender JIDs |
| `mucs` | string[] | `[]` | MUC rooms to auto-join |
| `fileUploadService` | string | auto | XEP-0363 HTTP File Upload service JID (auto-discovered) |
| `mucNick` | string | JID local | Nickname to use in MUC rooms |
| `groupAllowFrom` | string[] | `allowFrom` | Allowed senders in groups (falls back to `allowFrom`) |
| `actions.reactions` | boolean | `false` | Enable XEP-0444 reactions |
| `messagePrefix` | string | - | Inbound message prefix |
| `heartbeatVisibility` | string | - | Heartbeat visibility: `visible`, `hidden` |
| `groups.<roomJid>.requireMention` | boolean | `false` | Only respond when mentioned in this room |
| `groups.<roomJid>.tools` | object | - | Tool policy for this room (allow/deny lists) |

### Multi-Account Configuration

```json
{
  "channels": {
    "xmpp": {
      "accounts": {
        "work": {
          "jid": "workbot@company.com",
          "password": "work-pass",
          "mucs": ["team@conference.company.com"]
        },
        "personal": {
          "jid": "mybot@xmpp.net",
          "password": "personal-pass",
          "dmPolicy": "open"
        }
      }
    }
  }
}
```

## DM Policies

- **open** — Accept messages from any sender
- **pairing** — Unknown senders get a pairing code; approve via `openclaw pairing approve xmpp:<code>`
- **allowlist** — Only accept messages from JIDs in `allowFrom`

## Actions

### Reactions (XEP-0444)

Enable reactions in config:

```json
{
  "channels": {
    "xmpp": {
      "actions": {
        "reactions": true
      }
    }
  }
}
```

The agent can then use the `react` action to add/remove reactions to messages.

## Commands

Run the onboarding wizard:

```bash
openclaw channels add xmpp
```

Check channel status:

```bash
openclaw channels status
```

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm test             # Run tests
```

## Architecture

```
src/
├── index.ts           # Plugin entry point
├── channel.ts         # Main channel plugin definition
├── types.ts           # TypeScript interfaces
├── config-schema.ts   # Zod schema for config validation
├── runtime.ts         # Runtime getter/setter
│
├── monitor.ts         # Main XMPP connection entry point
├── state.ts           # Global state maps and constants
├── stanza-handlers.ts # Presence and invite handlers
├── inbound.ts         # Inbound message routing to OpenClaw
├── outbound.ts        # Send messages to XMPP
│
├── rooms.ts           # MUC room management and persistence
├── keepalive.ts       # XEP-0199 ping keepalive
├── reconnect.ts       # Exponential backoff reconnection
├── chat-state.ts      # XEP-0085 typing, XEP-0333 receipts
│
├── pep.ts             # XEP-0163 Personal Eventing Protocol
├── http-upload.ts     # XEP-0363 HTTP File Upload
├── actions.ts         # XEP-0444 message reactions
│
├── accounts.ts        # Account resolution utilities
├── normalize.ts       # JID normalization utilities
├── directory.ts       # Contact/room directory
├── heartbeat.ts       # Heartbeat adapter
├── onboarding.ts      # CLI setup wizard
└── status-issues.ts   # Status issue detection
```

## Roadmap

- [x] Phase 1: Basic XMPP connection, auth, direct messages
- [x] Phase 2: MUC support, group message handling, onboarding
- [x] Adapters: config, security, groups, mentions, threading, directory, actions, heartbeat, status
- [x] Phase 3: XEP-0163 PEP, XEP-0363 HTTP file upload
- [x] Phase 4: XEP-0085 typing, XEP-0333 receipts, XEP-0198 stream management, XEP-0199 keepalive, XEP-0461 replies
- [x] Code Quality: Modular architecture, split monitor.ts into focused modules
- [ ] Phase 5: OMEMO encryption (XEP-0384)

## XEP Support

| XEP | Name | Status |
|-----|------|--------|
| XEP-0045 | Multi-User Chat | ✅ Implemented (join, invite, self-presence) |
| XEP-0085 | Chat State Notifications | ✅ Implemented (typing indicators) |
| XEP-0163 | Personal Eventing Protocol (PEP) | ✅ Implemented |
| XEP-0198 | Stream Management | ✅ Implemented (ack, resume) |
| XEP-0199 | XMPP Ping | ✅ Implemented (30s keepalive) |
| XEP-0333 | Chat Markers | ✅ Implemented (read receipts) |
| XEP-0363 | HTTP File Upload | ✅ Implemented (auto-discovery) |
| XEP-0384 | OMEMO Encryption | 🔜 Planned |
| XEP-0444 | Message Reactions | ✅ Implemented |
| XEP-0461 | Message Replies | ✅ Implemented (with fallback) |

## License

MIT
