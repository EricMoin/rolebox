import { describe, expect, it } from "vitest";
import { isOpencodeV1Version } from "./opencode.ts";

describe("OpenCode v1 integration prerequisite", () => {
  it.each(["1.0.0", "1.18.31", "v1.18.31", "opencode 1.18.31", "opencode v1.18.31", " 1.18.31\r\n", "1.19.0-rc.2+build.7"])(
    "accepts a v1 CLI version: %s",
    version => expect(isOpencodeV1Version(version)).toBe(true),
  );

  it.each(["0.9.0", "2.0.18", "opencode v2.0.18\n", "2.0.0-rc.1", "10.1.0"])(
    "rejects a recognized incompatible CLI version: %s",
    version => expect(isOpencodeV1Version(version)).toBe(false),
  );

  it.each(["", " \n", "latest", "other-tool 1.18.31", "1.18", "1.18.31.2", "01.18.31", "1.18.31\n2.0.18"])(
    "fails explicitly for an unknown version format: %j",
    version => expect(() => isOpencodeV1Version(version)).toThrow("cannot determine v1 SDK compatibility"),
  );
});
