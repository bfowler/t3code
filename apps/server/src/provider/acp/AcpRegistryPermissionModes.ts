import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";

import { ACP_SESSION_MODE_OPTION_ID } from "./AcpSessionConfig.ts";

/**
 * Each registry agent's own permission mode for a T3 runtime mode, so the
 * agent enforces the thread's policy with its own sandbox and approvals, as
 * Claude and Codex do. Ids come from each agent's source:
 * codex-acp `AgentMode.ts`, claude-agent-acp `session-mode.ts`, gemini-cli
 * `ApprovalMode`, qwen-code `setMode`, goose `GooseMode`, mistral-vibe
 * `agents/models.py`. Agents without a row keep their own default mode and
 * T3 answers their permission prompts by policy.
 */
const ACP_REGISTRY_PERMISSION_MODES: Readonly<
  Record<string, Readonly<Record<RuntimeMode, string>>>
> = {
  "codex-acp": {
    "approval-required": "read-only",
    "auto-accept-edits": "workspace-write",
    auto: "agent",
    "full-access": "agent-full-access",
  },
  "claude-acp": {
    "approval-required": "default",
    "auto-accept-edits": "acceptEdits",
    auto: "auto",
    "full-access": "bypassPermissions",
  },
  // Gemini has no classifier mode, so auto keeps it asking.
  gemini: {
    "approval-required": "default",
    "auto-accept-edits": "autoEdit",
    auto: "default",
    "full-access": "yolo",
  },
  "qwen-code": {
    "approval-required": "default",
    "auto-accept-edits": "auto-edit",
    auto: "auto",
    "full-access": "yolo",
  },
  // Goose has no edits-only mode; smart_approve asks only for sensitive calls.
  goose: {
    "approval-required": "approve",
    "auto-accept-edits": "smart_approve",
    auto: "smart_approve",
    "full-access": "auto",
  },
  "mistral-vibe": {
    "approval-required": "ask",
    "auto-accept-edits": "accept-edits",
    auto: "smart-approve",
    "full-access": "auto-approve",
  },
};

/** Whether T3 maps this registry agent's runtime modes onto its own modes. */
export function acpRegistryHasNativePermissionModes(agentId: string): boolean {
  return Object.hasOwn(ACP_REGISTRY_PERMISSION_MODES, agentId);
}

/** The agent's own mode for a runtime mode, or undefined when T3 has no mapping. */
export function acpRegistryPermissionMode(
  agentId: string,
  runtimeMode: RuntimeMode,
): string | undefined {
  return acpRegistryHasNativePermissionModes(agentId)
    ? ACP_REGISTRY_PERMISSION_MODES[agentId]?.[runtimeMode]
    : undefined;
}

/**
 * The agent's permission-mode picker: the synthetic descriptor for modes set
 * through `session/set_mode`, or the `mode` config option.
 */
export function acpRegistryIsModeOptionDescriptor(descriptor: ProviderOptionDescriptor): boolean {
  return descriptor.id === ACP_SESSION_MODE_OPTION_ID || descriptor.id === "mode";
}
