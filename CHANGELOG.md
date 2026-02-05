# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

- **MUC Improvements**
  - Self-presence detection (status code 110) for reliable join confirmation
  - Auto-accept and join on invite with greeting message
  - Room persistence across restarts
  - Per-room tool policies (`groups.<roomJid>.tools`)
  - Per-room `requireMention` setting
  - Separate `groupAllowFrom` for group message filtering

- **Connection Reliability**
  - Exponential backoff reconnection (1s to 60s, max 20 attempts)
  - `lastOutboundAt` tracking for status monitoring
  - Unique session resources to prevent connection conflicts

### Changed

- **Modular Architecture** — Split 1200-line `monitor.ts` into focused modules:
  - `state.ts` — Global state maps and constants
  - `rooms.ts` — MUC room management and persistence
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
- Proper cleanup of pending MUC joins on account stop

## [0.1.0] - 2026-02-03

### Added

- **Core XMPP connectivity**
  - Connection to XMPP servers (Prosody, ejabberd, and others)
  - Automatic reconnection with exponential backoff
  - Resource binding and session management
  - Presence handling

- **Messaging**
  - Direct messages (1-on-1 chat)
  - Multi-User Chat (MUC/XEP-0045) support
  - Auto-join configured MUC rooms
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

## [Unreleased]

### Planned

- XEP-0384: OMEMO Encryption support
- Message carbons (XEP-0280)
- Message archive management (XEP-0313)
