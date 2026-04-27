import { describe, expect, it } from "vitest";
import { isSenderAllowed, normalizeAllowFrom } from "../src/normalize.js";

describe("normalizeAllowFrom", () => {
  it("treats empty lists as deny-all", () => {
    const normalized = normalizeAllowFrom();
    expect(normalized).toEqual({ entries: [], hasWildcard: false });
    expect(isSenderAllowed(normalized, "user@example.com")).toBe(false);
  });

  it("allows wildcard entries", () => {
    const normalized = normalizeAllowFrom(["*"]);
    expect(normalized).toEqual({ entries: [], hasWildcard: true });
    expect(isSenderAllowed(normalized, "someone@example.com")).toBe(true);
  });

  it("normalizes prefixes, resources, and casing before matching", () => {
    const normalized = normalizeAllowFrom(["xmpp:User@Example.com/Device"]);
    expect(normalized).toEqual({ entries: ["user@example.com"], hasWildcard: false });
    expect(isSenderAllowed(normalized, "USER@example.com/mobile")).toBe(true);
  });
});
