import { createCipheriv, pbkdf2Sync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ fetch: vi.fn(), media: vi.fn(), execFile: vi.fn() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: io.fetch,
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  fetchRemoteMedia: io.media,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: io.execFile,
}));

import {
  createGrokAccessTokenResolver,
  detectGrokSource,
  readGrokSecrets,
  readGrokSource,
} from "./index.js";

const recipe = {
  profile: {
    name: "Fixture bot",
    description: "Full instructions",
    avatarShape: "hexagon",
    avatarColor: "#9159FE",
  },
  memory: [{ kind: "profile", content: "Remember this fact." }],
  skills: [{ name: "Research", description: "A skill", content: "Complete skill body" }],
  routines: [
    { name: "Morning", slug: "morning", description: "A routine", content: "Routine body" },
  ],
  plugins: [{ name: "Fixture service", pluginId: "5" }],
  gettingStarted: { skill: "Research" },
};
let root: string;
async function write(file: string, value: unknown): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}
function routes(values: Record<string, unknown>) {
  io.fetch.mockImplementation(async ({ url }: { url: string }) => {
    const value = values[url] ?? values[new URL(url).pathname.split("/").at(-1)!];
    if (value === undefined) {
      throw new Error("Unexpected test request");
    }
    return {
      response: value instanceof Response ? value : Response.json(value),
      release: async () => {},
    };
  });
}
function hosted(overrides: Record<string, unknown> = {}) {
  routes({
    GetGrokBotUserRuntimeSettings: { settings: { mainAgentId: "runtime-id", userTimeZone: "UTC" } },
    GetGrokBotUserMcpSettings: {
      settings: { servers: [{ serverId: "7", disabledTools: ["write"] }] },
    },
    GetGrokBotMcpToolPermissions: { servers: [] },
    GetMcpConfig: {
      configJson: JSON.stringify({
        mcpServers: {
          remote: { url: "https://mcp.example.com", headers: { Authorization: "***" } },
        },
      }),
      serverMetadataByName: { remote: { serverId: "7" } },
    },
    GetAvailableMcpServers: {
      servers: [{ name: "remote", enabled: true, userHasAccessToken: true }],
    },
    ListGrokBotAgents: {
      agents: [
        {
          id: "database-id",
          agentId: "runtime-id",
          name: "Fixture bot",
          description: "Actual instructions",
          kind: 1,
          visibility: 1,
          avatarUrl: "https://images.example.com/avatar.png",
        },
        { agentId: "room", name: "Room", kind: 2, visibility: 1 },
        { agentId: "shared", name: "Shared", kind: 1, visibility: 2 },
      ],
    },
    ListGrokBotUserBotMemories: {
      memories: [{ factId: "fact", text: "A learned fact", learnedAtMs: "1600000000000" }],
    },
    ListGrokBotAgentSkills: {
      skills: [{ name: "Research", description: "Summary", body: "Complete source body" }],
    },
    ListGrokBotAgentAutomations: {
      automations: [
        {
          automationId: "job",
          recordJson: JSON.stringify({
            id: "job",
            name: "Morning",
            prompt: "Full prompt",
            trigger: { type: "cron", schedule: "0 8 * * *" },
            isEnabled: true,
          }),
        },
      ],
    },
    GetGrokBotAgentPlugins: { serviceAccountsEnabled: true },
    ...overrides,
  });
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-migration-source-"));
  vi.clearAllMocks();
  vi.stubEnv("GROK_BOT_ACCESS_TOKEN", "");
  io.execFile.mockImplementation(() => {
    throw new Error("Unexpected Keychain access");
  });
  io.media.mockResolvedValue({ buffer: Buffer.from([137, 80, 78, 71]), contentType: "image/png" });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Grok migration source boundary", () => {
  it("detects native data without authentication or reading sign-in contents", async () => {
    const app = path.join(root, "Library/Application Support/Grok Bot");
    await write(path.join(app, "sand-secrets.json"), "not a valid account file");
    const token = vi.fn();
    expect(await detectGrokSource({ homeDir: root, resolveAccessToken: token })).toMatchObject({
      detected: true,
      kind: "local",
      source: app,
    });
    expect(token).not.toHaveBeenCalled();
    expect(io.execFile).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it("does not turn a settings-only apply session into a credential request", async () => {
    await write(path.join(root, "settings.json"), { version: 1, userTimeZone: "UTC" });
    const resolveAccessToken = createGrokAccessTokenResolver({ source: root });
    const inventory = await readGrokSource({ source: root, resolveAccessToken });
    expect(inventory.settings.value.userTimeZone).toBe("UTC");
    expect(inventory.agents.status).toBe("unavailable");
    expect(inventory.issues).toContainEqual(
      expect.objectContaining({ code: "source_sign_in_unavailable" }),
    );
    expect(io.execFile).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it("reads an offline recipe completely and identifies its default agent", async () => {
    const source = await write(path.join(root, "recipe.json"), recipe);
    const token = vi.fn();
    const inventory = await readGrokSource({ source, resolveAccessToken: token });
    expect(inventory.mainAgentId).toBe(inventory.agents.value[0]?.id);
    expect(inventory.agents.value[0]).toMatchObject({
      instructions: "Full instructions",
      gettingStarted: { skill: "Research" },
      memory: { status: "complete", value: recipe.memory },
      skills: { value: recipe.skills },
      avatar: { color: "#9159FE" },
    });
    expect(inventory.settings.status).toBe("unavailable");
    expect(token).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it("keeps secrets out of inventory and resolves only selected values during explicit apply", async () => {
    const source = await write(path.join(root, "grok-migration.json"), {
      format: "grok-migration",
      version: 1,
      settings: {
        userTimeZone: "UTC",
        accountScopes: { other: { token: "private-account-token" } },
        apiKey: "private-settings-key",
      },
      agents: [{ ...recipe, id: "one" }],
      credentialNames: ["PROVIDER_KEY"],
      mcpConfig: {
        mcpServers: {
          local: {
            command: "fixture-mcp",
            args: ["serve"],
            env: { API_KEY: "private-mcp-key", EMPTY: "" },
          },
          embedded: {
            url: "https://user:private-url-key@example.com",
            auth: { token: "private-auth-key" },
          },
        },
      },
    });
    await write(path.join(root, "secrets.json"), { PROVIDER_KEY: "private-provider-key" });
    const inventory = await readGrokSource({ source });
    expect(JSON.stringify(inventory)).not.toContain("private-");
    expect(inventory.settings.value).toEqual({ userTimeZone: "UTC" });
    expect(inventory.mcpServers.value[1]?.config).toMatchObject({
      unsupportedEmbeddedCredentials: true,
      sourceAuthenticationRequired: true,
    });
    const selectors = inventory.credentials.filter(
      (selector) => selector.name === "PROVIDER_KEY" || selector.name === "EMPTY",
    );
    expect(await readGrokSecrets({ inventory, includeSecrets: false, selectors })).toEqual({});
    const values = await readGrokSecrets({ inventory, includeSecrets: true, selectors });
    expect(Object.values(values).toSorted()).toEqual(["", "private-provider-key"]);
    expect(io.execFile).not.toHaveBeenCalled();
    await expect(
      readGrokSecrets({
        inventory,
        includeSecrets: true,
        selectors: [{ ...selectors[0]!, sourcePath: "/unrelated" }],
      }),
    ).rejects.toThrow("no longer in the source inventory");
  });

  it.skipIf(process.platform !== "darwin")(
    "decrypts only selected native secrets in one captured Keychain operation without writing source state",
    async () => {
      const password = "synthetic-storage-password";
      const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
      const encrypted = (value: string) => {
        const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
        return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]).toString(
          "base64",
        );
      };
      await write(path.join(root, "settings.json"), { version: 1, activeAccountScope: "active" });
      const file = await write(path.join(root, "user-secrets.json"), {
        version: 2,
        accounts: {
          active: { FIRST: encrypted("first-value"), SECOND: encrypted("second-value") },
          other: { PRIVATE: encrypted("unselected-value") },
        },
      });
      const before = await fs.readFile(file);
      const inventory = await readGrokSource({ source: root });
      expect(inventory.credentials.map((selector) => selector.name)).toEqual(["FIRST", "SECOND"]);
      expect(io.execFile).not.toHaveBeenCalled();
      io.execFile.mockImplementation((_command, _args, _options, callback) =>
        callback(null, Buffer.from(password + "\n")),
      );
      expect(
        Object.values(await readGrokSecrets({ inventory, includeSecrets: true })).toSorted(),
      ).toEqual(["first-value", "second-value"]);
      expect(io.execFile).toHaveBeenCalledTimes(1);
      expect(io.execFile.mock.calls[0]?.[1]).toEqual([
        "find-generic-password",
        "-s",
        "Grok Bot Safe Storage",
        "-w",
      ]);
      expect(await fs.readFile(file)).toEqual(before);
    },
  );

  it("reads unredacted hosted MCP credentials only during explicit apply", async () => {
    hosted({
      GetAvailableMcpServers: {
        servers: [{ name: "remote", enabled: true, hasStaticCredentialHeaders: true }],
      },
    });
    const token = vi.fn().mockResolvedValue("fixture-token");
    const resolveAccessToken = createGrokAccessTokenResolver({
      source: "live",
      homeDir: root,
      resolveAccessToken: token,
    });
    expect(token).not.toHaveBeenCalled();
    const inventory = await readGrokSource({
      source: "live",
      homeDir: root,
      resolveAccessToken,
    });
    expect(
      io.fetch.mock.calls
        .filter(([request]) => request.url.endsWith("/GetMcpConfig"))
        .map(([request]) => JSON.parse(request.init.body).redactSecrets),
    ).toEqual([true]);
    await readGrokSecrets({ inventory, includeSecrets: false, resolveAccessToken });
    hosted({
      GetMcpConfig: {
        configJson: JSON.stringify({
          mcpServers: { remote: { headers: { Authorization: "portable-static-key" } } },
        }),
      },
    });
    const result = await readGrokSecrets({
      inventory,
      includeSecrets: true,
      resolveAccessToken,
    });
    expect(Object.values(result)).toEqual(["portable-static-key"]);
    expect(token).toHaveBeenCalledTimes(1);
    expect(
      io.fetch.mock.calls
        .filter(([request]) => request.url.endsWith("/GetMcpConfig"))
        .map(([request]) => JSON.parse(request.init.body).redactSecrets),
    ).toEqual([true, false]);
  });

  it("round-trips available partial content, photos, and MCP restrictions without claiming completeness", async () => {
    const image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=";
    const source = await write(path.join(root, "grok-migration.json"), {
      format: "grok-migration",
      version: 1,
      mainAgentId: "one",
      settings: { userTimeZone: "UTC" },
      agents: [
        {
          ...recipe,
          id: "one",
          avatarImage: { base64: image, extension: "png" },
          sourceStatus: {
            memory: { status: "partial", reason: "Facts only" },
            plugins: { status: "partial", reason: "Metadata only" },
          },
        },
      ],
      mcpConfig: {
        mcpServers: {
          remote: {
            url: "https://mcp.example.com",
            sourceAuthenticationRequired: true,
            enabled: false,
          },
        },
      },
      mcpMetadata: { remote: { instructions: "Only read", disabledTools: ["delete"] } },
      sourceStatus: {
        settings: { status: "partial", reason: "Some unavailable" },
        agents: { status: "complete" },
        mcpServers: { status: "partial", reason: "Assignments unavailable" },
      },
      sourceIssues: [{ code: "source_memory_partial", message: "Facts were retained." }],
    });
    const inventory = await readGrokSource({ source });
    expect(inventory.settings).toMatchObject({ status: "partial", reason: "Some unavailable" });
    expect(inventory.agents.value[0]?.memory).toMatchObject({
      status: "partial",
      value: recipe.memory,
      reason: "Facts only",
    });
    expect(inventory.agents.value[0]?.avatar?.image).toEqual({
      bytes: Buffer.from(image, "base64"),
      extension: "png",
    });
    expect(inventory.agents.value[0]?.plugins.status).toBe("partial");
    expect(inventory.mcpServers).toMatchObject({
      status: "partial",
      value: [
        {
          instructions: "Only read",
          disabledTools: ["delete"],
          enabled: false,
          config: { sourceAuthenticationRequired: true },
        },
      ],
    });
    expect(inventory.issues).toContainEqual(
      expect.objectContaining({ code: "source_memory_partial" }),
    );
    expect(io.fetch).not.toHaveBeenCalled();
    expect(io.execFile).not.toHaveBeenCalled();
  });

  it("rejects invalid completeness and mismatched photo formats in exported snapshots", async () => {
    const source = await write(path.join(root, "grok-migration.json"), {
      format: "grok-migration",
      version: 1,
      sourceStatus: { agents: { status: "complete" } },
    });
    await expect(readGrokSource({ source })).rejects.toThrow("section completeness");
    await write(source, {
      format: "grok-migration",
      version: 1,
      settings: [],
      sourceStatus: { settings: { status: "complete" } },
    });
    await expect(readGrokSource({ source })).rejects.toThrow("snapshot settings");
    await write(source, {
      format: "grok-migration",
      version: 1,
      agents: [{ ...recipe, memory: null }],
    });
    await expect(readGrokSource({ source })).rejects.toThrow("memory must be an array");
    await write(source, {
      format: "grok-migration",
      version: 1,
      agents: [
        {
          ...recipe,
          avatarImage: {
            base64: Buffer.from("private-invalid-image").toString("base64"),
            extension: "png",
          },
        },
      ],
    });
    await expect(readGrokSource({ source })).rejects.toThrow("matching PNG");
  });

  it("distinguishes omitted snapshot data from empty arrays and rejects duplicate identities", async () => {
    const source = await write(path.join(root, "grok-migration.json"), {
      format: "grok-migration",
      version: 1,
      agents: [{ id: "one", profile: recipe.profile, skills: [] }],
    });
    const inventory = await readGrokSource({ source });
    expect(inventory.agents.value[0]?.memory.status).toBe("unavailable");
    expect(inventory.agents.value[0]?.skills).toEqual({ status: "complete", value: [] });
    await write(source, {
      format: "grok-migration",
      version: 1,
      agents: [
        { ...recipe, id: "one" },
        { ...recipe, id: "one" },
      ],
    });
    await expect(readGrokSource({ source })).rejects.toThrow("duplicate agent IDs");
  });

  it("combines native settings and hosted owned agents by default, including full skills and photo bytes", async () => {
    await write(path.join(root, ".grokbot/settings.json"), {
      version: 1,
      computerUseModel: { modelId: "source-model" },
      activeAccountScope: "scope",
      accountScopes: { scope: { toolPermissions: { shell: "ask" } } },
    });
    hosted();
    const token = vi.fn().mockResolvedValue("fixture-token");
    const inventory = await readGrokSource({ homeDir: root, resolveAccessToken: token });
    expect(token).toHaveBeenCalledTimes(1);
    expect(inventory.mainAgentId).toBe("runtime-id");
    expect(inventory.agents.value).toHaveLength(1);
    expect(inventory.agents.value[0]).toMatchObject({
      id: "runtime-id",
      instructions: "Actual instructions",
      skills: { value: [{ content: "Complete source body" }] },
      memory: {
        status: "partial",
        value: [{ content: "A learned fact", createdAt: "2020-09-13T12:26:40.000Z" }],
      },
      plugins: { status: "unavailable" },
      avatar: { image: { bytes: Buffer.from([137, 80, 78, 71]), extension: "png" } },
    });
    expect(inventory.settings.value).toMatchObject({
      computerUseModel: { modelId: "source-model" },
      toolPermissions: { shell: "ask" },
      userTimeZone: "UTC",
    });
    expect(inventory.credentials).toEqual([]);
    expect(inventory.mcpServers.value[0]).toMatchObject({
      disabledTools: ["write"],
      config: { sourceAuthenticationRequired: true },
    });
    expect(io.media).toHaveBeenCalledWith(
      expect.objectContaining({ requireHttps: true, maxRedirects: 0, maxBytes: 1024 * 1024 }),
    );
    const skillCall = io.fetch.mock.calls.find(([request]) =>
      request.url.endsWith("/ListGrokBotAgentSkills"),
    );
    expect(JSON.parse(skillCall?.[0].init.body)).toEqual({ agentId: "runtime-id" });
    expect(JSON.stringify(inventory)).not.toContain("fixture-token");
  });

  it("reports access failure and truncated inventory instead of claiming an empty successful migration", async () => {
    const denied = await readGrokSource({
      source: "live",
      homeDir: root,
      resolveAccessToken: async () => {
        throw new Error("private upstream diagnostic");
      },
    });
    expect(denied.agents.status).toBe("unavailable");
    expect(denied.issues).toContainEqual(
      expect.objectContaining({ code: "source_auth_unavailable" }),
    );
    expect(JSON.stringify(denied)).not.toContain("private upstream");
    hosted({ ListGrokBotAgents: { agents: [], truncated: true } });
    const partial = await readGrokSource({
      source: "live",
      homeDir: root,
      resolveAccessToken: async () => "fixture-token",
    });
    expect(partial.agents.status).toBe("unavailable");
    expect(partial.issues).toContainEqual(
      expect.objectContaining({ code: "source_section_unavailable" }),
    );
  });

  it("reports a denied memory read without losing other owned bot data", async () => {
    hosted({ ListGrokBotUserBotMemories: new Response("private diagnostic", { status: 403 }) });
    const inventory = await readGrokSource({
      source: "live",
      homeDir: root,
      resolveAccessToken: async () => "fixture-token",
    });
    expect(inventory.agents.value[0]?.memory).toMatchObject({ status: "unavailable", value: [] });
    expect(inventory.agents.value[0]?.memory.reason).toContain("HTTP 403");
    expect(inventory.agents.value[0]?.skills.status).toBe("complete");
    expect(JSON.stringify(inventory)).not.toContain("private diagnostic");
  });

  it("downloads canonical URL recipes with authentication confined to the API", async () => {
    routes({
      GetGrokBotTemplateImportDetails: { blobGetUrl: "https://blobs.example.com/recipe" },
      "https://blobs.example.com/recipe": recipe,
    });
    const inventory = await readGrokSource({
      source: "https://x.ai/bot/fixture-id",
      resolveAccessToken: async () => "fixture-token",
    });
    expect(inventory.mainAgentId).toBe("template-fixture-id");
    expect(inventory.agents.value[0]?.memory.value).toEqual(recipe.memory);
    expect(io.fetch.mock.calls[0]?.[0].init.headers.authorization).toBe("Bearer fixture-token");
    expect(io.fetch.mock.calls[1]?.[0].init.headers.authorization).toBeUndefined();
  });
});
