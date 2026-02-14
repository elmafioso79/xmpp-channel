# XMPP Channel Skill

## Reactions

When using `action=react` with the XMPP channel:

- **messageId is REQUIRED** - You MUST include the `messageId` parameter pointing to the message you want to react to
- The messageId is the stanza-id of the inbound message (shown in conversation context)
- Example: `message action=react channel=xmpp target=user@xmpp-server.com messageId=abc-123-def emoji=👍`

Without messageId, the reaction will fail.
