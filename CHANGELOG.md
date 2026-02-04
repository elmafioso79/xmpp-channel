# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
