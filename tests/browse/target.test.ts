/**
 * The target grammar: every documented form, every documented rejection.
 *
 * These tests pin the parser, not the browser: a plan's kind and payload, the
 * case-folding of roles and refs, quote/escape handling in `role=[name=...]`, and
 * the fact that an unknown prefix is refused instead of being treated as text.
 */

import { describe, expect, it } from "vitest";
import { describeTarget, isRefTarget, parseTarget } from "../../src/browse/target.ts";
import { BrowseError } from "../../src/browse/types.ts";

function invalid(input: string): BrowseError {
  try {
    parseTarget(input);
  } catch (error) {
    expect(error).toBeInstanceOf(BrowseError);
    const browse = error as BrowseError;
    expect(browse.code).toBe("invalid_target");
    expect(typeof browse.hint).toBe("string");
    expect(browse.hint!.length).toBeGreaterThan(0);
    return browse;
  }
  throw new Error(`expected "${input}" to be rejected`);
}

describe("parseTarget refs", () => {
  it("parses eN and @eN into the same normalized ref", () => {
    expect(parseTarget("e12")).toEqual({ kind: "ref", ref: "e12" });
    expect(parseTarget("@e12")).toEqual({ kind: "ref", ref: "e12" });
    expect(parseTarget("  @E7  ")).toEqual({ kind: "ref", ref: "e7" });
    expect(isRefTarget(parseTarget("e1"))).toBe(true);
    expect(isRefTarget(parseTarget("css=#a"))).toBe(false);
  });

  it("does not treat a letter-only word as a ref", () => {
    expect(parseTarget("e")).toEqual({ kind: "text", text: "e" });
    expect(parseTarget("@example")).toEqual({ kind: "text", text: "@example" });
  });
});

describe("parseTarget prefixes", () => {
  it("parses css, text, label, placeholder, alt, title and testid", () => {
    expect(parseTarget("css=#submit")).toEqual({ kind: "css", selector: "#submit" });
    expect(parseTarget("css=  main > .item  ")).toEqual({ kind: "css", selector: "main > .item" });
    expect(parseTarget("text=Sign in")).toEqual({ kind: "text", text: "Sign in" });
    expect(parseTarget("label=Email address")).toEqual({ kind: "label", text: "Email address" });
    expect(parseTarget("placeholder=Your name")).toEqual({ kind: "placeholder", text: "Your name" });
    expect(parseTarget("alt=Company logo")).toEqual({ kind: "alt", text: "Company logo" });
    expect(parseTarget("title=Close dialog")).toEqual({ kind: "title", text: "Close dialog" });
    expect(parseTarget("testid=checkout-button")).toEqual({ kind: "testid", testId: "checkout-button" });
  });

  it("accepts whitespace and mixed case in prefixes", () => {
    expect(parseTarget("  TEXT=hello  ")).toEqual({ kind: "text", text: "hello" });
    expect(parseTarget("Css=.a")).toEqual({ kind: "css", selector: ".a" });
  });

  it("treats a bare string as text and trims it", () => {
    expect(parseTarget("  Sign in now  ")).toEqual({ kind: "text", text: "Sign in now" });
    expect(parseTarget("a price=5")).toEqual({ kind: "text", text: "a price=5" });
    expect(parseTarget("role = button")).toEqual({ kind: "text", text: "role = button" });
  });
});

describe("parseTarget role targets", () => {
  it("parses a role alone, case-insensitively", () => {
    expect(parseTarget("role=button")).toEqual({ kind: "role", role: "button" });
    expect(parseTarget("role=BUTTON")).toEqual({ kind: "role", role: "button" });
    expect(parseTarget("role=menuitem")).toEqual({ kind: "role", role: "menuitem" });
  });

  it("parses an optional quoted name", () => {
    expect(parseTarget('role=button[name="Save"]')).toEqual({ kind: "role", role: "button", name: "Save" });
    expect(parseTarget('role=link[name="Sign in"]')).toEqual({ kind: "role", role: "link", name: "Sign in" });
    expect(parseTarget('role=button [ name = "Save" ]')).toEqual({ kind: "role", role: "button", name: "Save" });
  });

  it("unescapes escaped quotes and backslashes in a name", () => {
    expect(parseTarget('role=button[name="Say \\"hi\\""]')).toEqual({ kind: "role", role: "button", name: 'Say "hi"' });
    expect(parseTarget('role=button[name="Back\\\\slash"]')).toEqual({ kind: "role", role: "button", name: "Back\\slash" });
  });

  it("rejects an unquoted or empty name", () => {
    invalid("role=button[name=Save]");
    invalid('role=button[name=""]');
    invalid("role=button[]");
    invalid("role=button[name]");
    invalid("role=[]");
  });
});

describe("parseTarget rejections", () => {
  it("rejects an empty or whitespace-only target", () => {
    invalid("");
    invalid("   ");
  });

  it("rejects a known prefix with no value", () => {
    invalid("css=");
    invalid("text=   ");
    invalid("role=");
    invalid("label=");
    invalid("placeholder=");
    invalid("alt=");
    invalid("title=");
    invalid("testid=");
  });

  it("rejects an unknown prefix instead of treating it as text", () => {
    const error = invalid("href=/checkout");
    expect(error.message).toContain("href");
    expect(error.message).toContain("unknown target prefix");
    invalid("xyzz=button");
    invalid("price=5");
  });
});

describe("describeTarget", () => {
  it("renders every kind back into the target grammar", () => {
    expect(describeTarget(parseTarget("e3"))).toBe("ref=e3");
    expect(describeTarget(parseTarget("css=#a"))).toBe("css=#a");
    expect(describeTarget(parseTarget("text=Hello"))).toBe("text=Hello");
    expect(describeTarget(parseTarget("role=button"))).toBe("role=button");
    expect(describeTarget(parseTarget('role=button[name="Save"]'))).toBe('role=button[name="Save"]');
    expect(describeTarget(parseTarget("label=Name"))).toBe("label=Name");
    expect(describeTarget(parseTarget("placeholder=Name"))).toBe("placeholder=Name");
    expect(describeTarget(parseTarget("alt=Logo"))).toBe("alt=Logo");
    expect(describeTarget(parseTarget("title=Close"))).toBe("title=Close");
    expect(describeTarget(parseTarget("testid=go"))).toBe("testid=go");
  });

  it("escapes a quote in a role name so the output parses again", () => {
    const target = parseTarget('role=button[name="Say \\"hi\\""]');
    const rendered = describeTarget(target);
    expect(rendered).toBe('role=button[name="Say \\"hi\\""]');
    expect(parseTarget(rendered)).toEqual(target);
  });
});
