# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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


