import { isDeepStrictEqual } from "node:util";
import {
  applyMigrationConfigPatchItem,
  createMigrationConfigPatchItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
  resolveMigrationConfigRuntime,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GrokCredentialSelector, GrokMcpServer, GrokSourceInventory } from "./source/types.js";
import { grokImportId, type GrokAgentTargets } from "./targets.js";

const API_KEY_PROVIDERS: Readonly<Record<string, string>> = {
  XAI_API_KEY: "xai",
  OPENAI_API_KEY: "openai",
  ANTHROPIC_API_KEY: "anthropic",
  OPENROUTER_API_KEY: "openrouter",
  GOOGLE_API_KEY: "google",
  GEMINI_API_KEY: "google",
  GROQ_API_KEY: "groq",
  MISTRAL_API_KEY: "mistral",
  DEEPSEEK_API_KEY: "deepseek",
};

type IntegrationParams = {
  inventory: GrokSourceInventory;
  ctx: MigrationProviderContext;
  agentTargets: GrokAgentTargets;
};

function apiKeyProvider(name: string): string | undefined {
  return Object.hasOwn(API_KEY_PROVIDERS, name) ? API_KEY_PROVIDERS[name] : undefined;
}

function manual(
  source: string,
  id: string,
  message: string,
  recommendation: string,
): MigrationItem {
  return createMigrationManualItem({ id, source, message, recommendation });
}

function sameDefinition(existing: unknown, value: unknown, credentialSelectors: boolean): boolean {
  if (!isRecord(existing)) {
    return false;
  }
  const definition = credentialSelectors
    ? Object.fromEntries(
        Object.entries(existing).filter(([key]) => key !== "env" && key !== "headers"),
      )
    : existing;
  return isDeepStrictEqual(definition, value);
}

function mcpDefinition(server: GrokMcpServer): Record<string, unknown> | undefined {
  const raw = server.config;
  const command = normalizeOptionalString(raw.command);
  const url = normalizeOptionalString(raw.url);
  if (Boolean(command) === Boolean(url)) {
    return undefined;
  }
  const type = normalizeOptionalString(raw.type) ?? normalizeOptionalString(raw.transport);
  if (type && !["stdio", "http", "sse", "streamable-http"].includes(type)) {
    return undefined;
  }
  if ((command && type && type !== "stdio") || (url && type === "stdio")) {
    return undefined;
  }
  if (url) {
    const parsed = URL.parse(url);
    if (
      !parsed ||
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      [...parsed.searchParams.keys()].some((key) => /token|key|secret|password|auth/iu.test(key))
    ) {
      return undefined;
    }
  }
  if (
    raw.args !== undefined &&
    (!Array.isArray(raw.args) || !raw.args.every((value) => typeof value === "string"))
  ) {
    return undefined;
  }
  const mapped: Record<string, unknown> = {
    ...(command ? { command, ...(raw.args ? { args: raw.args } : {}) } : { url }),
    transport: command ? "stdio" : type === "sse" ? "sse" : "streamable-http",
    // Grok selects MCP connections per agent. A global native entry cannot preserve that scope.
    enabled: false,
  };
  const cwd = normalizeOptionalString(raw.cwd);
  if (cwd) {
    mapped.cwd = cwd;
  }
  if (server.disabledTools?.length) {
    if (server.disabledTools.some((tool) => !tool.trim() || /[?[*]/u.test(tool))) {
      return undefined;
    }
    mapped.toolFilter = { exclude: server.disabledTools };
  }
  return mapped;
}

export function planGrokIntegrations(params: IntegrationParams): MigrationItem[] {
  const { inventory, ctx } = params;
  const items: MigrationItem[] = [];
  for (const server of inventory.mcpServers.value) {
    const source = `${inventory.source}#mcpServers.${server.name}`;
    const id = grokImportId(`mcp:${server.name}`);
    const value = mcpDefinition(server);
    if (!value || ["__proto__", "constructor", "prototype"].includes(server.name)) {
      items.push(
        manual(
          source,
          `manual:${id}`,
          `MCP server "${server.name}" requires manual translation.`,
          "Review the archived connection definition and create a native MCP connection with the same restrictions.",
        ),
      );
      continue;
    }
    const path = ["mcp", "servers", server.name];
    items.push({
      ...createMigrationConfigPatchItem({
        id: `config:${id}`,
        source,
        target: `mcp.servers.${server.name}`,
        path,
        value,
        conflict:
          !ctx.overwrite &&
          !sameDefinition(
            ctx.config.mcp?.servers?.[server.name],
            value,
            Boolean(ctx.includeSecrets) && server.credentialSelectors.length > 0,
          ) &&
          hasMigrationConfigPatchConflict(ctx.config, path, value),
        message: `Import MCP connection "${server.name}".`,
        sensitive: server.credentialSelectors.length > 0,
        details: {
          serverName: server.name,
          sourceEnabled: server.enabled ?? null,
          includeSecrets: Boolean(ctx.includeSecrets),
          credentialIds: server.credentialSelectors.map((selector) => selector.id).toSorted(),
        },
      }),
      action: "import-mcp",
    });
    items.push(
      manual(
        source,
        `manual:${id}:scope`,
        `MCP connection "${server.name}" is imported disabled because Grok's per-agent scope is not preserved by a global native connection.`,
        "Review the intended agent scope and native tool permissions before enabling this connection.",
      ),
    );
    const unmapped = Object.keys(server.config).filter(
      (key) =>
        ![
          "command",
          "args",
          "url",
          "cwd",
          "type",
          "transport",
          "sourceAuthenticationRequired",
        ].includes(key),
    );
    if (unmapped.length) {
      items.push(
        manual(
          source,
          `manual:${id}:settings`,
          `MCP connection "${server.name}" has source settings without a verified native mapping: ${unmapped.toSorted().join(", ")}.`,
          "Review these settings in the archived source before enabling the connection.",
        ),
      );
    }
    if (server.credentialSelectors.length > 0 && !ctx.includeSecrets) {
      items.push(
        manual(
          source,
          `manual:${id}:credentials`,
          `MCP connection "${server.name}" stays disabled because its credentials were not selected.`,
          "Rerun with --include-secrets or configure its environment and headers before enabling it.",
        ),
      );
    }
    if (server.config.sourceAuthenticationRequired === true) {
      items.push(
        manual(
          source,
          `manual:${id}:oauth`,
          `MCP connection "${server.name}" needs a new authorization in OpenClaw.`,
          "Configure native MCP authentication and sign in again before enabling the connection. Grok OAuth grants are not copied.",
        ),
      );
    }
    if (server.instructions) {
      items.push(
        manual(
          source,
          `manual:${id}:instructions`,
          `Grok-specific instructions for MCP connection "${server.name}" need review.`,
          "Copy the archived connection instructions into the intended agent's instructions after reviewing their scope.",
        ),
      );
    }
  }
  for (const agent of inventory.agents.value) {
    for (const plugin of agent.plugins.value) {
      items.push(
        manual(
          `${inventory.source}#agents.${agent.id}.plugins.${plugin.pluginId}`,
          `manual:${grokImportId(`plugin:${agent.id}:${plugin.pluginId}`)}`,
          `Grok plugin "${plugin.name}" used by "${agent.name}" has no verified native package mapping.`,
          "Install an equivalent OpenClaw integration and authorize it. Grok cloud connector grants and plugin identifiers are not reusable packages.",
        ),
      );
    }
  }
  for (const selector of inventory.credentials) {
    const provider = apiKeyProvider(selector.name);
    const source = `${inventory.source}#credentials.${selector.id}`;
    if (!provider) {
      items.push(
        manual(
          source,
          `manual:${grokImportId(`credential:${selector.id}`)}`,
          `Credential "${selector.name}" has no verified reusable provider mapping.`,
          "Configure the matching integration manually. Source sign-in tokens and service-specific OAuth grants are not model API keys.",
        ),
      );
      continue;
    }
    const profileId = `${provider}:${grokImportId(`credential:${selector.id}`)}`;
    items.push({
      id: `secret:${profileId}`,
      kind: "secret",
      action: "import-api-key",
      status: ctx.includeSecrets ? "planned" : "skipped",
      source,
      target: `auth.profiles.${profileId}`,
      sensitive: true,
      applyPhase: "after-promotion",
      ...(!ctx.includeSecrets
        ? { reason: "Credential migration requires --include-secrets." }
        : {}),
      message: `Import the reusable ${provider} API key into the shared native credential store.`,
      details: { selectorId: selector.id, provider, profileId },
    });
  }
  return items;
}

async function applyApiKey(
  params: IntegrationParams & {
    item: MigrationItem;
    readSecrets: (
      selectors: readonly GrokCredentialSelector[],
    ) => Promise<ReadonlyMap<string, string>>;
  },
): Promise<MigrationItem> {
  const { ctx, item, inventory } = params;
  const selector = inventory.credentials.find((entry) => entry.id === item.details?.selectorId);
  const provider = selector && apiKeyProvider(selector.name);
  const profileId = provider && `${provider}:${grokImportId(`credential:${selector?.id}`)}`;
  if (!selector || !provider || !profileId || profileId !== item.details?.profileId) {
    return markMigrationItemError(item, "The reviewed provider credential is no longer available.");
  }
  const configApi = resolveMigrationConfigRuntime(ctx);
  if (!configApi) {
    return markMigrationItemError(item, "config runtime unavailable");
  }
  const profile = { provider, mode: "api_key" as const };
  const existingConfig = configApi.current().auth?.profiles?.[profileId];
  if (
    existingConfig &&
    !ctx.overwrite &&
    (existingConfig.provider !== provider || existingConfig.mode !== "api_key")
  ) {
    return markMigrationItemConflict(
      item,
      "A different provider credential profile already exists.",
    );
  }
  const value = (await params.readSecrets([selector])).get(selector.id);
  ctx.signal?.throwIfAborted();
  if (!value?.trim()) {
    return markMigrationItemError(item, "The reviewed provider credential is no longer available.");
  }
  let conflict = false;
  const store = await updateAuthProfileStoreWithLock({
    stateDir: ctx.stateDir,
    sharedStoreWrite: true,
    profileId,
    updater(fresh) {
      ctx.signal?.throwIfAborted();
      const existing = fresh.profiles[profileId];
      if (existing && !ctx.overwrite) {
        conflict =
          existing.type !== "api_key" || existing.provider !== provider || existing.key !== value;
        return false;
      }
      fresh.profiles[profileId] = {
        type: "api_key",
        provider,
        key: value,
        displayName: "Grok import",
      };
      return true;
    },
  });
  if (conflict) {
    return markMigrationItemConflict(item, "A different provider credential already exists.");
  }
  if (!store?.profiles[profileId]) {
    return markMigrationItemError(item, "The native credential store did not accept the import.");
  }
  if (existingConfig && existingConfig.provider === provider && existingConfig.mode === "api_key") {
    return { ...item, status: "migrated", deferredCompletion: true };
  }
  const updated = await applyMigrationConfigPatchItem(ctx, {
    ...item,
    details: { path: ["auth", "profiles", profileId], value: profile },
  });
  return {
    ...item,
    status: updated.status,
    ...(updated.status === "migrated" ? { deferredCompletion: true } : {}),
    reason:
      updated.status === "error"
        ? "The native config writer rejected the credential profile."
        : updated.reason,
  };
}

class McpMigrationConflict extends Error {}

async function writeMcpConfig(
  ctx: MigrationProviderContext,
  item: MigrationItem,
  name: string,
  value: Record<string, unknown>,
): Promise<MigrationItem> {
  const api = resolveMigrationConfigRuntime(ctx);
  if (!api) {
    return markMigrationItemError(item, "config runtime unavailable");
  }
  if (isDeepStrictEqual(api.current().mcp?.servers?.[name], value)) {
    return { ...item, status: "migrated" };
  }
  try {
    await api.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        const existing = draft.mcp?.servers?.[name];
        if (existing && !ctx.overwrite && !isDeepStrictEqual(existing, value)) {
          throw new McpMigrationConflict();
        }
        draft.mcp ??= {};
        draft.mcp.servers ??= {};
        // Replace this reviewed connection; merging would retain obsolete transports or credentials.
        draft.mcp.servers[name] = value;
      },
    });
    return { ...item, status: "migrated" };
  } catch (error) {
    return error instanceof McpMigrationConflict
      ? markMigrationItemConflict(item, "A different MCP connection already exists.")
      : markMigrationItemError(item, "The native config writer rejected the MCP connection.");
  }
}

export async function applyGrokIntegrationItem(
  params: IntegrationParams & {
    item: MigrationItem;
    readSecrets: (
      selectors: readonly GrokCredentialSelector[],
    ) => Promise<ReadonlyMap<string, string>>;
  },
): Promise<MigrationItem> {
  const { ctx, item, inventory } = params;
  if (item.status !== "planned") {
    return item;
  }
  if (item.action === "import-api-key") {
    return ctx.includeSecrets
      ? applyApiKey(params)
      : markMigrationItemSkipped(item, "Credential migration requires --include-secrets.");
  }
  if (item.action !== "import-mcp") {
    return markMigrationItemError(item, "Unknown Grok integration migration action.");
  }
  const server = inventory.mcpServers.value.find(
    (entry) => entry.name === item.details?.serverName,
  );
  if (
    !server ||
    ["__proto__", "constructor", "prototype"].includes(server.name) ||
    !isRecord(item.details?.value)
  ) {
    return markMigrationItemError(item, "The reviewed MCP connection is no longer available.");
  }
  const definition = mcpDefinition(server);
  if (
    !definition ||
    !isDeepStrictEqual(definition, item.details.value) ||
    !isDeepStrictEqual(
      server.credentialSelectors.map((selector) => selector.id).toSorted(),
      item.details.credentialIds,
    )
  ) {
    return markMigrationItemError(item, "The source MCP connection changed. Review a new plan.");
  }
  const value = structuredClone(definition);
  if (item.details.includeSecrets === true && server.credentialSelectors.length > 0) {
    if (!ctx.includeSecrets) {
      return markMigrationItemSkipped(item, "Credential migration requires --include-secrets.");
    }
    const secrets = await params.readSecrets(server.credentialSelectors);
    ctx.signal?.throwIfAborted();
    for (const selector of server.credentialSelectors) {
      // The version-1 snapshot nests the same standard MCP config under mcpConfig.
      const selectorPath =
        selector.path?.[0] === "mcpConfig" ? selector.path.slice(1) : selector.path;
      const [root, name, field, key, ...tail] = selectorPath ?? [];
      const secret = secrets.get(selector.id);
      if (
        root !== "mcpServers" ||
        name !== server.name ||
        (field !== "env" && field !== "headers") ||
        !key ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        tail.length ||
        secret === undefined
      ) {
        return markMigrationItemError(item, "A required MCP credential is no longer available.");
      }
      const current = isRecord(value[field]) ? value[field] : {};
      value[field] = { ...current, [key]: secret };
    }
  }
  // Returned plans/reports retain selectors only, never the ephemeral credential-bearing patch.
  return await writeMcpConfig(ctx, item, server.name, value);
}
