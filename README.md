# XMPP Channel for OpenClaw

XMPP/Jabber channel plugin for OpenClaw, supporting Prosody, ejabberd, and other XMPP servers.

> **Note:** This plugin has been tested with [Conversations](https://conversations.im/) (Android) and [Gajim](https://gajim.org/) (Desktop). Other XMPP clients may work but have not been verified.

## Features

- **Direct Messages** — One-on-one chat via XMPP
- **Group Chat** — Group chat rooms with auto-join and invite handling
- **Multi-Account** — Configure multiple XMPP accounts
- **Owner Access** — `allowFrom` defines bot owners who always have direct chat access
- **Guest Policies** — `dmPolicy` controls guest access: open, disabled, pairing, or allowlist
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

### Manual Installation
1. Clone the repository:
   ```bash
   git clone git@github.com:elmafioso79/xmpp-channel.git ~/.openclaw/extensions/xmpp
   ```
2. Install dependencies and build:
   ```bash
   cd ~/.openclaw/extensions/xmpp
   npm install
   npm run build
   ```
3. Configure with openclaw or add to your `openclaw.json`:
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
         "groups": ["room@conference.example.com"],
         "actions": {
         "reactions": true
         }
       }
     }
   }
   ```
4. Enable plugin
   ```bash
   openclaw plugins enable xmpp 
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
| `dmPolicy` | string | `open` | Guest direct chat policy: `disabled`, `open`, `pairing`, `allowlist` |
| `allowFrom` | string[] | `[]` | Bot owner JIDs (always have direct chat access, cannot be removed by guests) |
| `dmAllowlist` | string[] | `[]` | JIDs allowed to direct-chat when dmPolicy is `allowlist` |
| `groupPolicy` | string | `open` | Group policy: `open`, `allowlist` |
| `groups` | string[] | `[]` | Group chat rooms to auto-join |
| `nickname` | string | JID local | Nickname to use in group chats |
| `groupAllowFrom` | string[] | `allowFrom` | Allowed senders in groups (falls back to `allowFrom`) |
| `actions.reactions` | boolean | `false` | Enable XEP-0444 reactions |
| `messagePrefix` | string | - | Inbound message prefix |
| `heartbeatVisibility` | string | - | Heartbeat visibility: `visible`, `hidden` |
| `groupSettings.<roomJid>.requireMention` | boolean | `false` | Only respond when mentioned in this room |
| `groupSettings.<roomJid>.tools` | object | - | Tool policy for this room (allow/deny lists) |
| `omemo.enabled` | boolean | `false` | Enable OMEMO encryption (XEP-0384) |
| `omemo.deviceLabel` | string | - | Display label for this device in OMEMO device list |

### Multi-Account Configuration

```json
{
  "channels": {
    "xmpp": {
      "accounts": {
        "work": {
          "jid": "workbot@company.com",
          "password": "work-pass",
          "groups": ["team@conference.company.com"]
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

## Direct Chat Policies

- **disabled** — Only owner JIDs (in `allowFrom`) can direct-chat the bot
- **open** — Accept direct chats from any sender
- **pairing** — Guests get a pairing code; approve via `openclaw pairing approve xmpp:<code>`
- **allowlist** — Only owner JIDs and JIDs in `dmAllowlist` may direct-chat; owners cannot be removed by the agent

## Group Chat Policies

- **open** — Respond to all messages in configured group rooms
- **allowlist** — Only respond to messages from JIDs in `groupAllowFrom` (falls back to `allowFrom`)

### Important: Non-Anonymous Rooms Required for `groupAllowFrom`

For `groupAllowFrom` to work properly, your MUC rooms must be configured as **non-anonymous**. In non-anonymous rooms, the server includes the sender's real JID in presence stanzas, which the plugin uses to verify the sender against the allowlist.

**Room Anonymity Types:**

| Type | Who Can See Real JIDs | Default in Prosody? |
|------|----------------------|---------------------|
| Non-anonymous | Everyone in the room | No |
| Semi-anonymous | Only moderators | **Yes** (user-created rooms) |
| Anonymous | No one | No |

In **semi-anonymous** rooms (the default for user-created rooms in Prosody), only moderators can see real JIDs. Since the bot is typically a participant, it cannot see real JIDs and `groupAllowFrom` won't work.

**Prosody Configuration:**

```lua
Component "conference.example.com" "muc"
  -- Option 1: Make all rooms non-anonymous by default
  default_room_options = {
    anonymous = false;
  }
  
  -- Option 2: Use members-only rooms (automatically non-anonymous)
  default_room_options = {
    members_only = true;
  }
```

**Alternative: Make the bot a moderator**

If you can't change room anonymity settings, make the bot's JID a moderator in the room. Moderators can see real JIDs even in semi-anonymous rooms.

**ejabberd Configuration:**
```yaml
# In ejabberd.yml
modules:
  mod_muc:
    default_room_options:
      anonymous: false
```

If the room is semi-anonymous or anonymous and the bot cannot see real JIDs, the plugin will allow messages from all occupants in the room (since the room itself is already configured in `groups`).

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

### OMEMO Encryption (XEP-0384)

Enable end-to-end encryption with OMEMO:

```json
{
  "channels": {
    "xmpp": {
      "omemo": {
        "enabled": true,
        "deviceLabel": "OpenClaw Bot"
      }
    }
  }
}
```

When OMEMO is enabled:
- The bot automatically publishes its device ID and key bundle via PEP
- Incoming encrypted messages are automatically decrypted
- Outgoing messages are automatically encrypted for all recipient devices
- Group chat messages are encrypted for all room occupants (requires non-anonymous rooms)
- If a room is not OMEMO-capable, group replies are blocked and a warning is sent instead of plaintext
- The bot uses **always-trust** policy (accepts any identity key without verification)
- Keys are persisted across restarts via OpenClaw's key-value storage

#### OMEMO Requirements

- **Server:** Must support PEP (XEP-0163). Most modern servers (Prosody, ejabberd) support this.
- **Group Rooms:** Must be configured as "non-anonymous" for OMEMO to work. This allows the bot to discover real JIDs of occupants.
- **Clients:** Use an OMEMO-capable client like Conversations or Gajim.

#### OMEMO Technical Details

- Uses the **legacy OMEMO namespace** (`eu.siacs.conversations.axolotl`) for maximum compatibility with Conversations and Gajim
- Signal protocol via `@privacyresearch/libsignal-protocol-typescript`
- AES-128-GCM payload encryption (OMEMO 0.3 format)
- Supports both prekey (initial) and regular Signal messages

#### OMEMO Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Messages not encrypting | OMEMO not enabled | Add `"omemo": { "enabled": true }` to config |
| Can't decrypt in group | Room is semi-anonymous | Configure room as "non-anonymous" in server |
| Client doesn't see bot's device | Device not published | Restart openclaw; check PEP is enabled on server |
| "No devices found" error | Can't fetch recipient's device list | Ensure recipient has OMEMO enabled; check PEP access |
| Decryption fails after restart | Keys not persisted | Check OpenClaw data directory is writable |
| Old messages unreadable | Forward secrecy | Normal - OMEMO can't decrypt messages from before session |

**Clearing OMEMO State:**

If you need to reset OMEMO keys (e.g., after corruption), delete the OMEMO store from OpenClaw's key-value storage and restart. The bot will generate new keys and republish its device.

## Commands

Run the onboarding wizard:

```bash
openclaw channels add
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
npm run lint         # ESLint check (flat config in eslint.config.js)
npm run lint:fix     # Apply ESLint auto-fixes
npm test -- --run    # Run tests once
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
├── iq-handlers.ts     # XEP-0092 version, XEP-0202 time
├── inbound.ts         # Inbound message routing to OpenClaw
├── outbound.ts        # Send messages to XMPP
│
├── rooms.ts           # Group room management and persistence
├── keepalive.ts       # XEP-0199 ping keepalive
├── reconnect.ts       # Exponential backoff reconnection
├── chat-state.ts      # XEP-0085 typing, XEP-0333 receipts
│
├── pep.ts             # XEP-0163 Personal Eventing Protocol
├── http-upload.ts     # XEP-0363 HTTP File Upload
├── actions.ts         # XEP-0444 message reactions
├── xml-utils.ts       # Shared XML/stanza utilities
│
├── accounts.ts        # Account resolution utilities
├── normalize.ts       # JID normalization utilities
├── directory.ts       # Contact/room directory
├── heartbeat.ts       # Heartbeat adapter
├── onboarding.ts      # CLI setup wizard
├── status-issues.ts   # Status issue detection
│
└── omemo/             # OMEMO encryption (XEP-0384)
    ├── index.ts       # OMEMO encrypt/decrypt entry points
    ├── bundle.ts      # Key bundle generation and publishing
    ├── device.ts      # Device list management
    ├── device-cache.ts# Device list caching with TTL
    ├── muc-occupants.ts # MUC occupant tracking for real JIDs
    ├── store.ts       # Signal protocol store implementation
    └── types.ts       # OMEMO type definitions
```

## Roadmap

- [x] Phase 1: Basic XMPP connection, auth, direct messages
- [x] Phase 2: Group chat support, group message handling, onboarding
- [x] Adapters: config, security, groups, mentions, threading, directory, actions, heartbeat, status
- [x] Phase 3: XEP-0163 PEP, XEP-0363 HTTP file upload
- [x] Phase 4: XEP-0085 typing, XEP-0333 receipts, XEP-0198 stream management, XEP-0199 keepalive, XEP-0461 replies
- [x] Code Quality: Modular architecture, split monitor.ts into focused modules
- [x] Phase 5: OMEMO encryption (XEP-0384) with Signal protocol
- [x] Phase 6: Message carbons (XEP-0280)

## XEP Support

| XEP | Name | Status |
|-----|------|--------|
| XEP-0045 | Multi-User Chat | ✅ Implemented (join, invite, self-presence) |
| XEP-0085 | Chat State Notifications | ✅ Implemented (typing indicators) |
| XEP-0092 | Software Version | ✅ Implemented |
| XEP-0163 | Personal Eventing Protocol (PEP) | ✅ Implemented |
| XEP-0198 | Stream Management | ✅ Implemented (ack, resume) |
| XEP-0199 | XMPP Ping | ✅ Implemented (30s keepalive) |
| XEP-0202 | Entity Time | ✅ Implemented |
| XEP-0280 | Message Carbons | ✅ Implemented |
| XEP-0333 | Chat Markers | ✅ Implemented (read receipts) |
| XEP-0363 | HTTP File Upload | ✅ Implemented (auto-discovery) |
| XEP-0384 | OMEMO Encryption | ✅ Implemented (legacy 0.3, always-trust) |
| XEP-0444 | Message Reactions | ✅ Implemented |
| XEP-0461 | Message Replies | ✅ Implemented (with fallback) |

## Tested Clients

This plugin has been tested with the following XMPP clients:

| Client | Platform | OMEMO | Notes |
|--------|----------|-------|-------|
| [Conversations](https://conversations.im/) | Android | ✅ | Recommended for mobile |
| [Gajim](https://gajim.org/) | Desktop (Win/Linux/Mac) | ✅ | Recommended for desktop |

Other OMEMO-capable clients may work but have not been verified.

## License

MIT
