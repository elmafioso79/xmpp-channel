# Contributing to XMPP Channel Plugin

Thank you for your interest in contributing to the XMPP Channel Plugin for OpenClaw! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites

- Node.js 18.0.0 or higher
- npm 9.0.0 or higher
- An XMPP server for testing (Prosody or ejabberd recommended)

### Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/openclaw/xmpp-channel.git
   cd xmpp-channel
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the project:**
   ```bash
   npm run build
   ```

4. **Run in development mode:**
   ```bash
   npm run dev
   ```

## Project Structure

```
xmpp-channel/
├── src/
│   ├── index.ts           # Plugin entry point
│   ├── channel.ts         # Main channel plugin with adapters
│   ├── accounts.ts        # Account resolution utilities
│   ├── config-schema.ts   # Zod schema for config validation
│   ├── monitor.ts         # XMPP connection lifecycle
│   ├── outbound.ts        # Send messages to XMPP
│   ├── onboarding.ts      # CLI setup wizard
│   ├── actions.ts         # Message actions (reactions)
│   ├── directory.ts       # Contact/room directory
│   ├── heartbeat.ts       # Heartbeat adapter
│   ├── pep.ts             # XEP-0163 Personal Eventing
│   ├── http-upload.ts     # XEP-0363 HTTP File Upload
│   ├── normalize.ts       # JID normalization
│   ├── status-issues.ts   # Status issue detection
│   ├── types.ts           # TypeScript interfaces
│   └── runtime.ts         # Runtime getter/setter
├── index.ts               # Re-exports from src/index.ts
├── openclaw.plugin.json   # OpenClaw plugin manifest
├── package.json
└── tsconfig.json
```

## Development Workflow

### Code Style

This project uses ESLint and Prettier for code formatting:

```bash
# Check linting
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Format code
npm run format

# Check formatting
npm run format:check
```

### Testing

```bash
# Run tests
npm test
```

### Building

```bash
# Build the project
npm run build

# Clean and rebuild
npm run clean && npm run build
```

## Submitting Changes

### Pull Request Process

1. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** and ensure:
   - All tests pass (`npm test`)
   - No linting errors (`npm run lint`)
   - Code is formatted (`npm run format`)
   - Build succeeds (`npm run build`)

3. **Commit your changes:**
   ```bash
   git commit -m "feat: add your feature description"
   ```

4. **Push to your fork and create a Pull Request**

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

## XEP Implementation Guidelines

When implementing new XMPP Extension Protocols (XEPs):

1. **Create a dedicated file** for the XEP (e.g., `src/xep-0XXX.ts`)
2. **Follow the @xmpp/client patterns** for stanza handling
3. **Add proper TypeScript types** for all data structures
4. **Document the XEP number and title** in code comments
5. **Update the README** with the new capability
6. **Update CHANGELOG.md** with the addition

## Testing with XMPP Servers

### Prosody

1. Install Prosody: https://prosody.im/
2. Enable required modules in prosody.cfg.lua:
   - `mod_http_upload` for file uploads
   - `mod_pep` for personal eventing
   - `mod_muc` for group chats

### ejabberd

1. Install ejabberd: https://www.ejabberd.im/
2. Enable required modules in ejabberd.yml

## Questions?

Feel free to open an issue for questions or discussions about contributing.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
