import path from "node:path";
import { decryptGrokSafeStorage, resolveGrokBotAccessToken } from "./auth.js";
import { exists, object, readJson } from "./files.js";
import { requestGrok } from "./hosted.js";
import { sourceId } from "./normalize.js";
import type { GrokCredentialSelector, GrokSourceInventory } from "./types.js";

function localSlot(data: Record<string, unknown>, scope?: string): Record<string, unknown> {
  if (data.version === 1) {
    return object(data.secrets) ?? {};
  }
  if (data.version === 2) {
    if (!scope && Object.keys(object(data.accounts) ?? {}).length) {
      throw new Error("The active Grok account scope is unavailable.");
    }
    return object(scope ? object(data.accounts)?.[scope] : undefined) ?? {};
  }
  throw new Error("Unsupported Grok user-secret storage version.");
}

/** Inspects encrypted field names only; sign-in tokens are in a different file. */
export async function listLocalCredentialSelectors(
  root: string,
  accountScope?: string,
): Promise<GrokCredentialSelector[]> {
  const sourcePath = path.join(root, "user-secrets.json");
  if (!(await exists(sourcePath))) {
    return [];
  }
  const data = await readJson(sourcePath, 1024 * 1024);
  return Object.keys(localSlot(data, accountScope))
    .toSorted()
    .map((name) => ({
      id: `secret:${sourceId(name)}`,
      name,
      kind: "local-user-secret",
      sourcePath,
      accountScope,
    }));
}

function field(data: unknown, keys: string[]): unknown {
  let value = data;
  for (const key of keys) {
    const row = object(value);
    if (!row || !Object.hasOwn(row, key)) {
      return undefined;
    }
    value = row[key];
  }
  return value;
}

export async function readGrokSecrets(options: {
  inventory: GrokSourceInventory;
  includeSecrets: boolean;
  selectors?: readonly GrokCredentialSelector[];
  resolveAccessToken?: () => Promise<string>;
}): Promise<Record<string, string>> {
  if (!options.includeSecrets) {
    return {};
  }
  const selectors = options.selectors ?? options.inventory.credentials;
  const accepted = new Map(
    options.inventory.credentials.map((selector) => [selector.id, selector]),
  );
  for (const selector of selectors) {
    if (JSON.stringify(accepted.get(selector.id)) !== JSON.stringify(selector)) {
      throw new Error("The selected Grok credential is no longer in the source inventory.");
    }
  }
  const result: Record<string, string> = {};
  const encrypted: Record<string, string> = {};
  const files = new Map<string, Record<string, unknown>>();
  let mcp: Record<string, unknown> | undefined;
  for (const selector of selectors) {
    let value: unknown;
    if (selector.kind === "mcp-secret") {
      if (selector.sourcePath !== "grok-api:mcp") {
        throw new Error("Invalid Grok MCP credential source.");
      }
      if (!mcp) {
        const reply = await requestGrok(
          await (
            options.resolveAccessToken ??
            (() =>
              resolveGrokBotAccessToken({
                userDataDir:
                  options.inventory.kind === "local" ? options.inventory.source : undefined,
              }))
          )(),
          "GetMcpConfig",
          { teamScope: false, redactSecrets: false, expandPluginVariables: true },
          true,
        );
        try {
          mcp = object(JSON.parse(typeof reply.configJson === "string" ? reply.configJson : ""));
        } catch {
          /* Fixed error below excludes source text. */
        }
        if (!mcp) {
          throw new Error("Grok did not return the selected MCP credentials.");
        }
      }
      value = field(mcp, selector.path ?? []);
    } else {
      const sourcePath = selector.sourcePath;
      if (!sourcePath) {
        throw new Error("Grok credential source is missing.");
      }
      if (
        selector.kind === "local-user-secret" &&
        path.basename(sourcePath) !== "user-secrets.json"
      ) {
        throw new Error("Invalid Grok user-secret source.");
      }
      let data = files.get(sourcePath);
      if (!data) {
        data = await readJson(sourcePath);
        files.set(sourcePath, data);
      }
      if (selector.kind === "local-user-secret") {
        value = localSlot(data, selector.accountScope)[selector.name];
        if (typeof value !== "string") {
          throw new Error("A selected Grok credential is no longer present.");
        }
        encrypted[selector.id] = value;
        continue;
      }
      value = field(data, selector.path ?? []);
    }
    if (typeof value !== "string" || /^\*+$|^<redacted>$/iu.test(value)) {
      throw new Error(
        "A selected Grok credential is missing or redacted. Reconnect that service in OpenClaw.",
      );
    }
    result[selector.id] = value;
  }
  return { ...result, ...(await decryptGrokSafeStorage(encrypted)) };
}
