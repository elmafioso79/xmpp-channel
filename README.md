# XMPP Channel for OpenClaw

XMPP/Jabber channel plugin for OpenClaw, supporting Prosody, ejabberd, and other XMPP servers.

## Features

- **Direct Messages** — One-on-one chat via XMPP
- **Group Chat** — Multi-User Chat (MUC) support
- **Multi-Account** — Configure multiple XMPP accounts
- **Allowlist** — Control who can interact with the bot
- **Pairing** — Approve unknown senders with pairing codes
- **Reactions** — XEP-0444 message reactions support
- **Heartbeat** — Periodic status checks and notifications
- **Onboarding** — CLI setup wizard integration
- **Directory** — Contact and room listings

## Installation

```bash
npm install @openclaw/xmpp
```

Or add to your OpenClaw plugins:

```bash
openclaw plugins add xmpp
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

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
| `actions.reactions` | boolean | `false` | Enable XEP-0444 reactions |
| `messagePrefix` | string | - | Inbound message prefix |
| `heartbeatVisibility` | string | - | Heartbeat visibility: `visible`, `hidden` |

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
├── accounts.ts        # Account resolution utilities
├── config-schema.ts   # Zod schema for config validation
├── monitor.ts         # XMPP connection lifecycle
├── outbound.ts        # Send messages to XMPP
├── pep.ts             # XEP-0163 Personal Eventing Protocol
├── http-upload.ts     # XEP-0363 HTTP File Upload
├── onboarding.ts      # CLI setup wizard
├── actions.ts         # Message actions (reactions)
├── directory.ts       # Contact/room directory
├── heartbeat.ts       # Heartbeat adapter
├── normalize.ts       # JID normalization utilities
├── status-issues.ts   # Status issue detection
├── types.ts           # TypeScript interfaces
└── runtime.ts         # Runtime getter/setter
```

## Roadmap

- [x] Phase 1: Basic XMPP connection, auth, direct messages
- [x] Phase 2: MUC support, group message handling, onboarding
- [x] Adapters: config, security, groups, mentions, threading, directory, actions, heartbeat, status
- [x] Phase 3: XEP-0163 PEP, XEP-0363 HTTP file upload
- [ ] Phase 4: OMEMO encryption (XEP-0384)

## XEP Support

| XEP | Name | Status |
|-----|------|--------|
| XEP-0045 | Multi-User Chat | ✅ Implemented |
| XEP-0163 | Personal Eventing Protocol (PEP) | ✅ Implemented |
| XEP-0363 | HTTP File Upload | ✅ Implemented |
| XEP-0384 | OMEMO Encryption | 🔜 Planned |
| XEP-0444 | Message Reactions | ✅ Implemented |

## License

MIT
