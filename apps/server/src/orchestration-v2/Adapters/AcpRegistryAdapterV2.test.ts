import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import { ServerConfig } from "../../config.ts";
import type {
  AcpRegistryAvailableCommands,
  AcpRegistryLiveConfiguration,
} from "../../provider/acp/AcpRegistryProbe.ts";
import { makeAcpRegistryCatalog } from "../../provider/acp/AcpRegistrySupport.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import {
  ACP_REGISTRY_PROVIDER,
  AcpRegistryAdapterV2Driver,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
} from "./AcpRegistryAdapterV2.ts";

const registryUrl = "https://registry.test/registry.json";
const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-acp-registry-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

const registryLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  serverConfigLayer,
  registryLayer,
);

describe("AcpRegistryAdapterV2", () => {
  it("preserves and sanitizes structured ACP errors without exposing arbitrary defects", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
    });
    assert.deepEqual(acpRegistryPromptFailure("mistral-vibe", limit), {
      class: "usage_limit",
      message: limit.errorMessage,
      code: "-31001",
      retryable: null,
    });
    assert.equal(acpRegistryPromptFailure("other-agent", limit).class, "provider_error");
    assert.equal(
      acpRegistryPromptFailure("mistral-vibe", new Error("private defect")).message,
      "Provider turn failed.",
    );
    const rejected = acpRegistryPromptFailure(
      "any-agent",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Request rejected. api_key=private-key https://example.test/?token=secret",
      }),
    );
    assert.include(rejected.message, "Request rejected.");
    assert.notInclude(rejected.message, "private-key");
    assert.notInclude(rejected.message, "token=secret");
  });
  it("is registered as a generic provider driver with schema defaults", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(ACP_REGISTRY_PROVIDER));
    assert.equal(AcpRegistryAdapterV2Driver.driverKind, ACP_REGISTRY_PROVIDER);
    assert.deepEqual(AcpRegistryAdapterV2Driver.defaultConfig(), {
      enabled: true,
      agentId: "",
      commandPath: "",
      authMethodId: "",
      distribution: "auto",
      customModels: [],
    });
  });

  describe("native permission modes", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const reject = (method: string, code: number, message: string): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, error: { code, message } },
    });
    const modeOption = (currentValue: string, values: ReadonlyArray<string>) => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue,
      options: values.map((value) => ({ value, name: value })),
    });
    const modes = (currentModeId: string, ids: ReadonlyArray<string>) => ({
      currentModeId,
      availableModes: ids.map((id) => ({ id, name: id })),
    });
    // A scripted ACP v1 agent: initialize, session/new answered with `setup`,
    // then the frames T3 must send (and the agent's answers) to switch modes.
    const agentScript = (setup: unknown, modeFrames: ReadonlyArray<Frame>) => [
      outbound("initialize"),
      answer("initialize", {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [{ id: "test", name: "Test" }],
      }),
      outbound("session/new"),
      answer("session/new", { sessionId: "agent-session", ...(setup as object) }),
      ...modeFrames,
    ];
    const setConfigMode = (value: string) =>
      outbound("session/set_config_option", {
        sessionId: "agent-session",
        configId: "mode",
        value,
      });
    const setMode = (modeId: string) =>
      outbound("session/set_mode", { sessionId: "agent-session", modeId });

    const openSession = Effect.fn("openSession")(function* (input: {
      readonly agentId: string;
      readonly runtimeMode: RuntimeMode;
      readonly entries: ReadonlyArray<Frame>;
      readonly storedModePick?: string;
    }) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: `t3-acp-registry-mode-${input.agentId}-`,
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: `native-mode-${input.agentId}-${input.runtimeMode}`,
          entries: input.entries as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make(`acp-registry-mode-${input.agentId}`);
      const adapter = makeAcpRegistryAdapterV2({
        crypto: yield* Crypto.Crypto,
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: input.agentId,
          authMethodId: "test",
        }),
        environment: {},
        childProcessSpawner,
        fileSystem,
        idAllocator: yield* IdAllocatorV2,
        resolver: { resolve: () => Effect.die("the runtime is injected") },
        serverConfig: yield* ServerConfig,
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      });
      // Closing the session stops the agent process, which writes its replay
      // status in the same tick as its last answer, so the status is final.
      const opened = yield* adapter
        .openSession({
          threadId: ThreadId.make(`thread-acp-registry-mode-${input.agentId}`),
          providerSessionId: ProviderSessionId.make(`provider-session-mode-${input.agentId}`),
          modelSelection: {
            instanceId,
            model: "default",
            ...(input.storedModePick === undefined
              ? {}
              : { options: [{ id: "mode", value: input.storedModePick }] }),
          },
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            cwd: replayDir,
          }),
        })
        .pipe(
          Effect.map((session) => session.providerSession.capabilities.runtimePolicy.enforcement),
          Effect.scoped,
          Effect.exit,
        );
      // The agent script must be consumed exactly: no missing or extra frames.
      const consumed = yield* makeAcpReplayCompletenessAssertion(
        fileSystem,
        statusPath,
        transcript,
      ).pipe(Effect.exit);
      return {
        enforcement: Exit.isSuccess(opened) ? opened.value : undefined,
        failure: Exit.isFailure(opened) ? Cause.pretty(opened.cause) : undefined,
        consumed: Exit.isSuccess(consumed),
      };
    });

    it.effect("switches each mapped agent to its own mode", () =>
      Effect.gen(function* () {
        // One mapping per agent, through the transport each one advertises.
        const cases = [
          {
            agentId: "codex-acp",
            runtimeMode: "approval-required",
            setup: {
              configOptions: [
                modeOption("agent", ["read-only", "workspace-write", "agent", "agent-full-access"]),
              ],
            },
            frames: [
              setConfigMode("read-only"),
              answer("session/set_config_option", {
                configOptions: [modeOption("read-only", ["read-only", "agent"])],
              }),
            ],
          },
          {
            agentId: "claude-acp",
            runtimeMode: "auto-accept-edits",
            setup: {
              configOptions: [modeOption("default", ["default", "acceptEdits", "auto"])],
            },
            frames: [
              setConfigMode("acceptEdits"),
              answer("session/set_config_option", {
                configOptions: [modeOption("acceptEdits", ["default", "acceptEdits"])],
              }),
            ],
          },
          {
            agentId: "gemini",
            runtimeMode: "full-access",
            setup: { modes: modes("default", ["default", "autoEdit", "yolo"]) },
            frames: [setMode("yolo"), answer("session/set_mode", {})],
          },
          {
            agentId: "qwen-code",
            runtimeMode: "auto",
            setup: {
              configOptions: [modeOption("default", ["default", "auto-edit", "auto", "yolo"])],
            },
            frames: [
              setConfigMode("auto"),
              answer("session/set_config_option", {
                configOptions: [modeOption("auto", ["default", "auto"])],
              }),
            ],
          },
          {
            // Goose advertises a mode config option but may only handle
            // session/set_mode; T3 falls back when the config option is refused.
            agentId: "goose",
            runtimeMode: "approval-required",
            setup: {
              modes: modes("auto", ["auto", "approve", "smart_approve", "chat"]),
              configOptions: [modeOption("auto", ["auto", "approve", "smart_approve", "chat"])],
            },
            frames: [
              setConfigMode("approve"),
              reject("session/set_config_option", -32601, "Method not found"),
              setMode("approve"),
              answer("session/set_mode", {}),
            ],
          },
          {
            agentId: "mistral-vibe",
            runtimeMode: "auto-accept-edits",
            setup: {
              configOptions: [modeOption("ask", ["ask", "accept-edits", "auto-approve"])],
            },
            frames: [
              setConfigMode("accept-edits"),
              answer("session/set_config_option", {
                configOptions: [modeOption("accept-edits", ["ask", "accept-edits"])],
              }),
            ],
          },
        ] as const;
        for (const testCase of cases) {
          const result = yield* openSession({
            agentId: testCase.agentId,
            runtimeMode: testCase.runtimeMode,
            entries: agentScript(testCase.setup, testCase.frames),
            // A stored composer pick must not override the thread's mode.
            storedModePick: "agent-full-access",
          });
          assert.deepEqual(
            result,
            { enforcement: "native", failure: undefined, consumed: true },
            testCase.agentId,
          );
        }
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    );

    it.effect("refuses to open a stricter thread when the agent cannot switch", () =>
      Effect.gen(function* () {
        const codexSetup = (current: string, values: ReadonlyArray<string>) => ({
          configOptions: [modeOption(current, values)],
        });
        const cases = [
          {
            name: "mode not advertised",
            setup: codexSetup("agent", ["agent", "agent-full-access"]),
            frames: [],
            reason: "does not offer it",
          },
          {
            name: "mode rejected",
            setup: codexSetup("agent", ["read-only", "agent"]),
            frames: [
              setConfigMode("read-only"),
              reject("session/set_config_option", -32003, "Folder is not trusted"),
            ],
            reason: "refused it (Folder is not trusted)",
          },
          {
            name: "agent stays in its mode",
            setup: codexSetup("agent", ["read-only", "agent"]),
            frames: [
              setConfigMode("read-only"),
              answer("session/set_config_option", {
                configOptions: [modeOption("agent", ["read-only", "agent"])],
              }),
            ],
            reason: "stayed in 'agent'",
          },
        ] as const;
        for (const testCase of cases) {
          const strict = yield* openSession({
            agentId: "codex-acp",
            runtimeMode: "approval-required",
            entries: agentScript(testCase.setup, testCase.frames),
          });
          assert.isUndefined(strict.enforcement, testCase.name);
          assert.include(
            strict.failure ?? "",
            `Codex could not switch to its 'read-only' mode for this thread's permission mode: it ${testCase.reason}.`,
            testCase.name,
          );
        }
        // Full access proceeds: any mode the agent stays in is stricter.
        const loose = yield* openSession({
          agentId: "codex-acp",
          runtimeMode: "full-access",
          entries: agentScript(codexSetup("agent", ["read-only", "agent"]), []),
        });
        assert.deepEqual(loose, { enforcement: "native", failure: undefined, consumed: true });
        const looseRejected = yield* openSession({
          agentId: "codex-acp",
          runtimeMode: "full-access",
          entries: agentScript(codexSetup("agent", ["agent", "agent-full-access"]), [
            setConfigMode("agent-full-access"),
            reject("session/set_config_option", -32003, "Folder is not trusted"),
          ]),
        });
        assert.deepEqual(looseRejected, {
          enforcement: "native",
          failure: undefined,
          consumed: true,
        });
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    );

    it.effect("leaves unmapped agents in their own mode", () =>
      Effect.gen(function* () {
        const result = yield* openSession({
          agentId: "fixture-agent",
          runtimeMode: "approval-required",
          storedModePick: "agent-full-access",
          entries: agentScript(
            { configOptions: [modeOption("agent", ["agent", "agent-full-access"])] },
            [
              setConfigMode("agent-full-access"),
              answer("session/set_config_option", {
                configOptions: [modeOption("agent-full-access", ["agent", "agent-full-access"])],
              }),
            ],
          ),
        });
        assert.deepEqual(result, {
          enforcement: "client-boundary",
          failure: undefined,
          consumed: true,
        });
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    );
  });

  it.effect("offers client terminals to Devin only and client fs to no registry agent", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const advertisedCapabilities = Effect.fn("advertisedCapabilities")(function* (
        agentId: string,
      ) {
        let clientCapabilities: unknown;
        const instanceId = ProviderInstanceId.make(`acp-registry-capabilities-${agentId}`);
        const adapter = makeAcpRegistryAdapterV2({
          crypto: yield* Crypto.Crypto,
          selfInvocation: yield* resolveSelfInvocation(),
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId, authMethodId: "test" }),
          environment: {},
          childProcessSpawner,
          fileSystem,
          idAllocator,
          resolver: { resolve: () => Effect.die("the runtime is injected") },
          serverConfig,
          makeRuntime: (input) =>
            Effect.gen(function* () {
              clientCapabilities = input.clientCapabilities;
              const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
              const context = yield* Layer.build(
                AcpSessionRuntime.layer({
                  ...runtimeInput,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    cwd: input.cwd,
                    env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                  },
                  authMethodId: "test",
                }).pipe(
                  Layer.provide(
                    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                  ),
                ),
              );
              return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
                Effect.provide(context),
              );
            }),
        });
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        yield* adapter.openSession({
          threadId: ThreadId.make(`thread-acp-registry-capabilities-${agentId}`),
          providerSessionId: ProviderSessionId.make(`provider-session-capabilities-${agentId}`),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy,
        });
        return clientCapabilities;
      });

      assert.deepInclude(yield* advertisedCapabilities("devin"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      });
      assert.deepInclude(yield* advertisedCapabilities("gemini"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("opens a real ACP child process resolved from registry configuration", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* makeAcpRegistryCatalog({
        cacheDir: serverConfig.providerStatusCacheDir,
        toolsDir: serverConfig.baseDir + "/tools",
        registryUrl,
      });
      const settings = yield* decodeAcpRegistryAdapterSettings({
        agentId: "fixture-agent",
        commandPath: process.execPath,
        authMethodId: "test",
      });
      let startupActive = false;
      let startupCount = 0;
      const instanceId = ProviderInstanceId.make("acp-registry-fixture");
      const commandsPublished = yield* Deferred.make<{
        readonly instanceId: ProviderInstanceId;
        readonly commands: AcpRegistryAvailableCommands;
      }>();
      const configurationPublished = yield* Deferred.make<AcpRegistryLiveConfiguration>();
      const adapter = makeAcpRegistryAdapterV2({
        crypto: yield* Crypto.Crypto,
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings,
        environment: {
          T3_ACP_SESSION_LIFECYCLE: "1",
          T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "750",
        },
        childProcessSpawner,
        fileSystem,
        idAllocator,
        runtimeCoordinator: {
          withForegroundStartup: (agentId, effect) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                assert.equal(agentId, "fixture-agent");
                startupActive = true;
                startupCount += 1;
              }),
              () => effect,
              () =>
                Effect.sync(() => {
                  startupActive = false;
                }),
            ),
          runBackgroundProbe: (_agentId, effect) => effect.pipe(Effect.map(Option.some)),
          withSessionMutation: (effect) => effect,
          clearAvailableCommands: () => Effect.void,
          publishAvailableCommands: (publishedInstanceId, commands) =>
            Deferred.succeed(commandsPublished, {
              instanceId: publishedInstanceId,
              commands,
            }).pipe(Effect.asVoid),
          getAvailableCommands: () => Effect.succeed(Option.none()),
          watchAvailableCommands: () => Effect.never,
          clearLiveConfiguration: () => Effect.void,
          publishLiveConfiguration: (_publishedInstanceId, configuration) =>
            Deferred.succeed(configurationPublished, configuration).pipe(Effect.asVoid),
          getLiveConfiguration: () => Effect.succeed(Option.none()),
          watchLiveConfiguration: () => Effect.never,
          requestUrlAuthentication: () => Effect.succeed(false),
          acceptUrlAuthentication: () => Effect.succeed(false),
          getUrlAuthAction: () => Effect.succeed(Option.none()),
          watchUrlAuthAction: () => Effect.never,
        },
        resolver: {
          resolve: (configuredSettings, cwd, environment) =>
            Effect.sync(() => assert.isTrue(startupActive)).pipe(
              Effect.andThen(resolver.resolve(configuredSettings, cwd, environment)),
              Effect.map((resolved) => ({
                ...resolved,
                spawn: {
                  ...resolved.spawn,
                  args: [mockAgentPath],
                },
              })),
            ),
        },
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-registry-fixture");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-fixture"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      assert.equal(runtime.providerSession.driver, "acpRegistry");
      assert.equal(startupCount, 1);
      assert.isFalse(startupActive);
      assert.equal(providerThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.equal(providerThread.nativeMetadata?.itemIdentityVersion, 2);
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.deepEqual(yield* Deferred.await(commandsPublished), {
        instanceId,
        commands: {
          slashCommands: [
            {
              name: "review",
              description: "Review the current changes",
              input: { hint: "focus" },
            },
          ],
          skills: [
            {
              name: "workspace-skill",
              description: "Run the workspace skill",
              path: "acp://skill/workspace-skill",
              scope: "agent",
              enabled: true,
            },
          ],
        },
      });
      const configuration = yield* Deferred.await(configurationPublished);
      assert.equal(configuration.currentModelId, "default");
      assert.deepInclude(configuration.models[0], {
        id: "default",
        name: "Auto",
        description: null,
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
