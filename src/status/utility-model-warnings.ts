import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { listAgentIds, resolveAgentConfig } from "../agents/agent-scope.js";
import {
  cliBackendSupportsExactToolAvailability,
  isCliRuntimeModelBackendForProvider,
} from "../agents/cli-backends.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { readUtilityModelSetting } from "../agents/utility-model-setting.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackend } from "../plugins/setup-registry.js";

/** Known descriptor mismatches only; model quality and live availability remain runtime facts. */
export function collectUtilityModelWarnings(config: OpenClawConfig): ConfigValidationIssue[] {
  if (
    config.agents?.defaults?.utilityModel === undefined &&
    !Object.values(config.agents?.entries ?? {}).some((agent) => agent.utilityModel !== undefined)
  ) {
    return [];
  }
  const warnings = new Map<string, ConfigValidationIssue>();
  const resolveBackend = (id: string) => {
    const normalized = normalizeProviderId(id);
    return (
      resolveRuntimeCliBackends().find(
        (backend) => normalizeProviderId(backend.id) === normalized,
      ) ?? resolvePluginSetupCliBackend({ backend: normalized, config })?.backend
    );
  };
  for (const agentId of listAgentIds(config)) {
    const utility = readUtilityModelSetting(config, agentId);
    if (utility.kind === "disabled") {
      continue;
    }
    const candidates =
      utility.kind === "explicit" ? [utility.modelRef, ...utility.fallbacks] : utility.fallbacks;
    if (candidates.length === 0) {
      continue;
    }
    const defaultProvider = resolveDefaultModelForAgent({
      cfg: config,
      agentId,
      manifestPlugins: [],
    }).provider;
    const aliasIndex = buildModelAliasIndex({
      cfg: config,
      agentId,
      defaultProvider,
      manifestPlugins: [],
    });
    const path =
      resolveAgentConfig(config, agentId)?.utilityModel === undefined
        ? "agents.defaults.utilityModel"
        : `agents.entries.${agentId}.utilityModel`;
    for (const raw of candidates) {
      const resolved = resolveModelRefFromString({
        cfg: config,
        agentId,
        raw,
        defaultProvider,
        aliasIndex,
        manifestPlugins: [],
      });
      if (!resolved) {
        continue;
      }
      const { provider, model } = resolved.ref;
      const runtime = resolveModelRuntimePolicy({ config, agentId, provider, modelId: model })
        .policy?.id;
      const direct = resolveBackend(provider);
      // A CLI alias owns its canonical provider; otherwise respect a mapped runtime pin.
      const backend =
        direct?.modelProvider || !isCliRuntimeModelBackendForProvider({ provider, runtime, config })
          ? direct
          : resolveBackend(runtime ?? "");
      if (!backend || cliBackendSupportsExactToolAvailability(backend)) {
        continue;
      }
      const message = `Utility model "${provider}/${model}" uses CLI backend "${backend.id}", which cannot enforce the tool-free utility contract. Choose a capable utility model or add capable utilityModel fallbacks; the explicit route is unchanged.`;
      warnings.set(`${path}:${message}`, { path, message });
    }
  }
  return [...warnings.values()];
}
