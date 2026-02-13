# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-02-12

### Fixed

- **XEP-0444 Reactions: send as plaintext siblings** — Reactions are now sent as plaintext `<reactions>` elements as siblings to the OMEMO `<encrypted>` element, NOT inside the encrypted payload. This matches native client behavior (Gajim, Conversations) where reactions are sent unencrypted alongside an OMEMO message. The OMEMO payload is kept minimal (empty) to maintain session continuity while reactions appear as proper emoji reactions to recipients.

## [0.3.9] - 2026-02-12

### Fixed

- **Reactions: wrap in SCE envelope per XEP-0420** — The OMEMO-encrypted reaction payload now properly wraps the `<reactions>` element in a Stanza Content Encryption (SCE) `<envelope><content>` structure. This matches the XEP-0420 profile that native XMPP clients expect. Without this wrapper, the raw `<reactions>` XML inside the encrypted payload wasn't being parsed correctly by clients like Gajim and Conversations.

## [0.3.8] - 2026-02-12

### Fixed

- **Reactions: put `<reactions>` inside OMEMO encrypted payload** — Previously the `<reactions>` element was sent as a plaintext sibling to `<encrypted>`, which most XMPP clients ignore. Now the reactions XML is encrypted as the payload content, matching how native clients send OMEMO-encrypted reactions.

## [0.3.7] - 2026-02-12

### Fixed

- **Reactions: strip `xmpp:` channel prefix from target JID** — The LLM passes JIDs with the `xmpp:` channel prefix (e.g., `xmpp:user@server`), which was leaking into the `to` attribute of the reaction stanza. The prefix is now stripped in all code paths.
- **Reactions: OMEMO-encrypt reaction stanzas** — When OMEMO is active, Gajim and Conversations silently drop plaintext stanzas from contacts with established OMEMO sessions. Reaction stanzas are now wrapped in OMEMO encryption (empty payload with `<reactions>` sibling), matching what native XMPP clients expect.

## [0.3.6] - 2026-02-12

### Fixed

- **Reactions: use XEP-0359 stanza-id for message references** — The `<reactions>` stanza now references the server-assigned `stanza-id` (XEP-0359) instead of the sender's stanza `id` attribute. Most XMPP clients (Conversations, Gajim, Dino) index messages by stanza-id, so reactions referencing the wrong ID were silently ignored.
- **MessageSid prefers stanza-id** — The `MessageSid` field in OpenClaw context now uses the server-assigned stanza-id when available, making the LLM's message references match what the receiving client expects.
- **Action handler logging** — Added console logging to `handleXmppAction` for debugging reaction delivery (logs target JID, messageId, emoji, and the full stanza).

## [0.3.5] - 2026-02-12

### Fixed

- **Actions: never throw, always return `jsonResult()`** — Every error path in `handleAction` / `handleXmppAction` now returns `jsonResult({ ok: false, error })` instead of throwing. This ensures `toolResult` messages in the session history always have a `content[]` array, preventing the LLM provider crash (`msg.content.filter(...)` on undefined). Old sessions with broken tool results from pre-v0.3.4 may still trigger this — start a fresh conversation to clear them.

## [0.3.4] - 2026-02-12

### Fixed

- **Actions crash: "Cannot read properties of undefined (reading 'filter')"** — `handleAction` now returns proper `AgentToolResult` via `jsonResult()` instead of a plain object; errors are thrown instead of returned (matching WhatsApp/BlueBubbles pattern)
- **SDK type declarations** — Added `jsonResult` export to `declarations.d.ts`

## [0.3.3] - 2026-02-12

### Added

- **XEP-0333 Read Receipts** — Bot sends `displayed` chat markers for incoming DMs
  - New `sendReadReceipts` config option (default `true`), configurable at root and per-account level
  - Follows WhatsApp channel parity: defaults on, skips group chats, errors are non-fatal
- **XEP-0444 Inbound reaction detection** — Incoming reactions are logged and skipped (no AI processing)

### Fixed

- **OMEMO fallback body suppression** — No longer processes plaintext `<body>` on OMEMO-encrypted stanzas (prevents AI from responding to "I sent you an encrypted message" notices)
- **Actions adapter improvements** — Correct `type` attribute on reaction stanzas (`chat`/`groupchat`), added `<store>` hint (XEP-0334), improved target resolution with `toolContext` fallback, bare JID normalization

## [0.3.2] - 2026-02-11

### Changed

- **Renamed config fields** — Eliminated confusing "MUC" terminology from user-facing config
  - `mucs` → `groups` (room JID list)
  - `groups` → `groupSettings` (per-room config like tools, requireMention)
  - `mucNick` → `nickname` (display name in group chats)
- **Separated owner list from DM allowlist** — `allowFrom` is now strictly for bot owners (cannot be removed by the agent); new `dmAllowlist` field for JIDs allowed to direct-chat when `dmPolicy` is `"allowlist"`
  - Prevents accidental owner lockout if a guest asks the agent to remove a JID
  - `allowFrom` = bot owners (immutable, always have access)
  - `dmAllowlist` = guest-level DM access list (managed separately)

## [0.3.1] - 2026-02-08

### Changed

- **Unified access model** — Removed separate `dms` config field; `allowFrom` now serves as both bot-owner list and direct chat allowlist
  - `allowFrom` = bot owners (always have direct chat access)
  - `dmPolicy` = controls guest access (JIDs not in allowFrom): open, disabled, pairing, allowlist
- **Improved onboarding** — Wizard now asks for owner JIDs first, then guest policy in a logical order; eliminated duplicate DM policy prompt
- **Updated terminology** — "DMs" → "direct chats" throughout user-facing messages and docs

### Refactored

- **Shared utilities** — Extracted duplicated `toBase64`, `fromBase64`, `getElementText`, `extractErrorText`, `iqId`, `waitForIq` into shared `xml-utils.ts` module
- **Dynamic version** — `iq-handlers.ts` now reads plugin version from `package.json` instead of hardcoded constant

## [0.3.0] - 2026-02-06

### Added

- **OMEMO Encryption (XEP-0384)**
  - End-to-end encryption using the Signal protocol
  - Uses legacy namespace `eu.siacs.conversations.axolotl` for Conversations/Gajim compatibility
  - Automatic device ID and key bundle publication via PEP
  - Automatic decryption of incoming OMEMO messages
  - Automatic encryption of outgoing messages when OMEMO is enabled
  - Group chat encryption with per-occupant key distribution
  - Always-trust policy (accepts any identity key without verification)
  - Persistent key storage across restarts via OpenClaw's key-value storage
  - Device list caching with PEP subscription for updates
  - Group room occupant tracking for real JID discovery (non-anonymous rooms)
  - Self-encryption support for multi-device scenarios
  - Configurable device label for OMEMO device list

### Fixed

- Skip group self-echo messages before OMEMO decryption (prevents "decrypt on sending chain" errors)
- Skip group history messages before OMEMO decryption (forward secrecy prevents decryption of old messages)

### Technical Details

- Uses `@privacyresearch/libsignal-protocol-typescript` for Signal protocol
- AES-128-GCM for payload encryption (legacy OMEMO 0.3 format)
- Supports both prekey and regular Signal messages

## [0.2.0] - 2026-02-04

### Added

- **XEP-0085 Chat State Notifications**
  - Send `composing` indicator before AI response
  - Send `active` indicator after response delivery

- **XEP-0333 Chat Markers**
  - Send read receipts (`received`, `displayed`, `acknowledged`)

- **XEP-0198 Stream Management**
  - Automatic stanza acknowledgment
  - Session resume on reconnect
  - Failed stanza detection

- **XEP-0199 XMPP Ping**
  - 30-second keepalive interval
  - Automatic ping to server

- **XEP-0461 Message Replies**
  - Include reply context in outbound messages
  - Parse reply references from inbound messages
  - Fallback support for older clients

- **Group Chat Improvements**
  - Self-presence detection (status code 110) for reliable join confirmation
  - Auto-accept and join on invite with greeting message
  - Room persistence across restarts
  - Per-room tool policies (`groupSettings.<roomJid>.tools`)
  - Per-room `requireMention` setting
  - Separate `groupAllowFrom` for group message filtering

- **Connection Reliability**
  - Exponential backoff reconnection (1s to 60s, max 20 attempts)
  - `lastOutboundAt` tracking for status monitoring
  - Unique session resources to prevent connection conflicts

### Changed

- **Modular Architecture** — Split 1200-line `monitor.ts` into focused modules:
  - `state.ts` — Global state maps and constants
  - `rooms.ts` — Group room management and persistence
  - `keepalive.ts` — XEP-0199 ping management
  - `reconnect.ts` — Exponential backoff logic
  - `chat-state.ts` — Typing indicators and read receipts
  - `stanza-handlers.ts` — Presence and invite handlers
  - `inbound.ts` — Message routing to OpenClaw

### Fixed

- Removed duplicate `normalizeAllowFrom`/`isSenderAllowed` functions
- Added proper TypeScript interfaces for `XmppToolPolicy` and `XmppGroupConfig`
- Extracted magic numbers to named constants
- Silenced harmless `recipient-unavailable` presence errors
- Proper cleanup of pending room joins on account stop

## [0.1.0] - 2026-02-03

### Added

- **Core XMPP connectivity**
  - Connection to XMPP servers (Prosody, ejabberd, and others)
  - Automatic reconnection with exponential backoff
  - Resource binding and session management
  - Presence handling

- **Messaging**
  - Direct messages (1-on-1 chat)
  - Multi-User Chat (XEP-0045) support
  - Auto-join configured group rooms
  - Message filtering for self-messages and history

- **Security & Access Control**
  - DM policies: `open`, `pairing`, `allowlist`
  - Group policies: `open`, `allowlist`
  - JID normalization and validation
  - Pairing code support for unknown senders

- **XEP Support**
  - XEP-0045: Multi-User Chat
  - XEP-0163: Personal Eventing Protocol (PEP)
  - XEP-0363: HTTP File Upload with auto-discovery
  - XEP-0444: Message Reactions

- **OpenClaw Integration**
  - Full channel plugin implementation
  - Onboarding wizard adapter
  - Directory adapter (contacts and rooms)
  - Heartbeat adapter for status checks
  - Actions adapter (reactions)
  - Threading and mentions support
  - Multi-account configuration

- **Media Handling**
  - HTTP Upload service auto-discovery
  - Support for local files and HTTP URLs
  - Proper OOB (Out-of-Band) data for inline display
  - JWT authentication for upload slots

### Technical Details

- TypeScript ES2022 with ESNext modules
- Uses `@xmpp/client` v0.13.1
- Zod schema validation for configuration
- Comprehensive type definitions


