import { assert, describe, it } from "@effect/vitest";

import { acpRegistryPermissionMode } from "./AcpRegistryPermissionModes.ts";

describe("acpRegistryPermissionMode", () => {
  it("leaves unmapped agents, including prototype keys, in their own mode", () => {
    assert.isUndefined(acpRegistryPermissionMode("devin", "full-access"));
    assert.isUndefined(acpRegistryPermissionMode("toString", "full-access"));
    assert.isUndefined(acpRegistryPermissionMode("__proto__", "approval-required"));
  });
});
