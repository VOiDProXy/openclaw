import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { applyGrokIntegrationItem, planGrokIntegrations } from "./integrations.js";
import type { GrokSourceInventory } from "./source/types.js";

const ctx: MigrationProviderContext = {
  config: {},
  stateDir: "/migration-test",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
const agentTargets = new Map();

function inventory(): GrokSourceInventory {
  return {
    source: "/grok-export",
    kind: "snapshot",
    settings: { status: "complete", value: {} },
    agents: { status: "complete", value: [] },
    mcpServers: {
      status: "complete",
      value: [
        {
          name: "calendar",
          config: { url: "https://calendar.example/mcp", type: "http" },
          disabledTools: ["delete_event"],
          credentialSelectors: [
            {
              id: "calendar-header",
              name: "Authorization",
              kind: "snapshot-secret",
              path: ["mcpServers", "calendar", "headers", "Authorization"],
            },
          ],
        },
        {
          name: "local-tools",
          config: { command: "tools-server", args: ["--stdio"] },
          enabled: false,
          credentialSelectors: [],
        },
      ],
    },
    credentials: [
      { id: "xai-key", name: "XAI_API_KEY", kind: "snapshot-secret" },
      { id: "grok-session", name: "GROK_BOT_ACCESS_TOKEN", kind: "snapshot-secret" },
      { id: "prototype-name", name: "constructor", kind: "snapshot-secret" },
    ],
    issues: [],
  };
}

describe("Grok integration migration", () => {
  it("maps MCP transport and restrictions while leaving connections disabled for scope review and gating credentials", () => {
    const items = planGrokIntegrations({ ctx, inventory: inventory(), agentTargets });
    expect(items.find((item) => item.target === "mcp.servers.calendar")?.details?.value).toEqual({
      url: "https://calendar.example/mcp",
      transport: "streamable-http",
      enabled: false,
      toolFilter: { exclude: ["delete_event"] },
    });
    expect(items.find((item) => item.target === "mcp.servers.local-tools")?.details?.value).toEqual(
      {
        command: "tools-server",
        args: ["--stdio"],
        transport: "stdio",
        enabled: false,
      },
    );
    expect(items.find((item) => item.action === "import-api-key")).toMatchObject({
      status: "skipped",
      sensitive: true,
    });
    expect(
      items.some((item) => item.kind === "manual" && item.source?.endsWith("grok-session")),
    ).toBe(true);
    expect(
      items.some((item) => item.kind === "manual" && item.source?.endsWith("prototype-name")),
    ).toBe(true);
    expect(items.filter((item) => item.action === "import-api-key")).toHaveLength(1);
    expect(
      items.find((item) => item.target === "mcp.servers.local-tools")?.details?.sourceEnabled,
    ).toBe(false);
    expect(
      items.some((item) => item.kind === "manual" && item.message?.includes("per-agent scope")),
    ).toBe(true);
  });

  it("never resolves credentials without current apply consent, and fails closed if a reviewed MCP secret disappears", async () => {
    const source = inventory();
    const items = planGrokIntegrations({
      ctx: { ...ctx, includeSecrets: true },
      inventory: source,
      agentTargets,
    });
    const item = items.find((entry) => entry.target === "mcp.servers.calendar");
    if (!item) {
      throw new Error("Missing planned MCP connection");
    }
    const readSecrets = async () => {
      throw new Error("Credential reader must not run without consent");
    };
    expect(
      await applyGrokIntegrationItem({ ctx, item, inventory: source, agentTargets, readSecrets }),
    ).toMatchObject({
      status: "skipped",
    });
    expect(
      await applyGrokIntegrationItem({
        ctx: { ...ctx, includeSecrets: true },
        item,
        inventory: source,
        agentTargets,
        readSecrets: async () => new Map(),
      }),
    ).toMatchObject({
      status: "error",
      reason: "A required MCP credential is no longer available.",
    });
  });
});
