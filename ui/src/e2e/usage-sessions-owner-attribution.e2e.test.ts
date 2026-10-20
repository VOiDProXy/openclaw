import path from "node:path";
import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import { createZeroUsageFixture } from "../../../src/agents/test-helpers/usage-fixtures.ts";
import { setRuntimeConfigSnapshot } from "../../../src/config/runtime-snapshot.js";
import { createExactAssistantMessage } from "../../../src/config/sessions/transcript-message.test-support.ts";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { resetLogger, setLoggerOverride } from "../../../src/logging/logger.ts";
import type { SessionsUsageResult } from "../../../src/shared/usage-types.ts";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI usage sessions owner attribution",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const viewport = { height: 900, width: 1_440 };

const PROOF_SESSION_ID = "tg-dm-owner-attribution-proof";
const PROOF_STORE_KEY = "agent:main:telegram:dm";
const PROOF_LABEL = "Telegram DM";

async function dragTimelineRange(page: Page, fraction: number) {
  const panel = page.locator(".session-detail-panel");
  const handle = panel.locator(".chart-handle-right");
  await handle.scrollIntoViewIfNeeded();
  const handleBox = await handle.boundingBox();
  const chartBox = await panel.locator(".timeseries-svg").boundingBox();
  if (!handleBox || !chartBox) {
    throw new Error("Timeline drag handles did not render");
  }
  const y = handleBox.y + handleBox.height / 2;
  const x = chartBox.x + (chartBox.width * (30 + 366 * fraction)) / 400;
  await page.mouse.move(handleBox.x + handleBox.width / 2, y);
  await page.mouse.down();
  const move = () => page.mouse.move(x, y, { steps: 8 });
  await move();
  return move;
}

async function requestGateway<T>(
  page: Page,
  methodName: string,
  requestParams: Record<string, unknown>,
) {
  return await evaluateControlUiContext(
    page,
    async (context, { method, params }) => {
      const client = context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Usage proof has no connected Gateway client");
      }
      return await client.request<T>(method, params);
    },
    { method: methodName, params: requestParams },
  );
}

async function runUsageScenario(
  context: Parameters<typeof suite.runScenario>[0],
  label: string,
  prepare: (
    state: OpenClawTestState,
    port: number,
    signal: AbortSignal,
  ) => Promise<typeof import("../../../src/gateway/server.js").startGatewayServer>,
  run: (state: OpenClawTestState, port: number, signal: AbortSignal) => Promise<void>,
  restore?: () => void,
) {
  let fixture: OpenClawTestState | undefined;
  let gateway: Promise<GatewayServer> | undefined;
  await suite.runScenario(context, {
    retainedState: () => fixture?.root,
    close: async () => {
      await (await gateway)?.close({ reason: `${label} cleanup` });
    },
    release: async () => {
      restore?.();
      await fixture?.cleanup();
      resetLogger();
    },
    run: async (signal) => {
      const port = await getFreePort();
      signal.throwIfAborted();
      const state = await createOpenClawTestState({
        label,
        env: {
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          VITEST: "1",
        },
      });
      fixture = state;
      setLoggerOverride({
        file: state.path("gateway.log"),
        level: "silent",
        consoleLevel: "silent",
      });
      signal.throwIfAborted();
      const startGatewayServer = await prepare(state, port, signal);
      signal.throwIfAborted();
      gateway = startGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      await gateway;
      signal.throwIfAborted();
      await run(state, port, signal);
    },
  });
}

function gatewayConfig(port: number): OpenClawConfig["gateway"] {
  return {
    mode: "local",
    port,
    bind: "loopback",
    auth: { mode: "none" },
    controlUi: { enabled: false },
  };
}

suite.define(() => {
  it.for([false, true])(
    "keeps same-id owners separate with an empty current session: %s",
    async (resetCurrentSession, context) => {
      await runUsageScenario(
        context,
        "usage-sessions-owner-attribution",
        async (state, port, signal) => {
          const { startGatewayServer } = await import("../../../src/gateway/server.js");
          signal.throwIfAborted();
          const { persistSessionTranscriptTurn, upsertSessionEntryCore } =
            await import("../../../src/config/sessions/session-accessor.js");

          signal.throwIfAborted();
          const config: OpenClawConfig = {
            agents: {
              ownership: "explicit",
              defaults: { workspace: state.workspaceDir },
              entries: {
                main: { name: "Molty", workspace: state.workspaceDir },
                opus: { name: "Molty", workspace: state.workspaceDir },
              },
            },
            gateway: gatewayConfig(port),
            plugins: { enabled: false },
            session: {
              store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
            },
          };
          await state.writeConfig(config);
          setRuntimeConfigSnapshot(config);

          for (const agentId of ["main", "opus"]) {
            signal.throwIfAborted();
            const scope = {
              agentId,
              sessionId: PROOF_SESSION_ID,
              sessionKey: agentId === "main" ? PROOF_STORE_KEY : `agent:opus:${PROOF_SESSION_ID}`,
              storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
            };
            const now = Date.now();
            if (agentId === "main") {
              await upsertSessionEntryCore(scope, {
                sessionId: PROOF_SESSION_ID,
                label: PROOF_LABEL,
                updatedAt: now,
              });
            }
            signal.throwIfAborted();
            // Both transcripts must fall inside the dashboard's current date window.
            await persistSessionTranscriptTurn(scope, {
              cwd: state.workspaceDir,
              updateMode: "none",
              messages: [
                { message: { role: "user", content: `${agentId} turn`, timestamp: now }, now },
              ],
            });
          }

          signal.throwIfAborted();
          if (resetCurrentSession) {
            await upsertSessionEntryCore(
              {
                agentId: "main",
                sessionKey: PROOF_STORE_KEY,
                storePath: path.join(state.sessionsDir("main"), "sessions.json"),
              },
              {
                sessionId: "empty-current-session",
                label: PROOF_LABEL,
                updatedAt: Date.now(),
              },
            );
          }
          return startGatewayServer;
        },
        async (_state, port) => {
          await suite.withPage(
            {
              locale: "en-US",
              serviceWorkers: "block",
              viewport,
            },
            async ({ page }) => {
              const pageErrors: string[] = [];
              page.on("pageerror", (error) => pageErrors.push(String(error)));

              const url = new URL("usage", suite.server.baseUrl);
              url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
              await page.goto(url.toString());
              const confirmation = page.locator("openclaw-gateway-url-confirmation");
              await confirmation.waitFor();
              await confirmation
                .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
                .click();

              // The named family stays visible before its new current instance has a transcript.
              for (const [key, agentId] of [
                [`agent:opus:${PROOF_SESSION_ID}`, "opus"],
                [PROOF_STORE_KEY, "main"],
              ] as const) {
                const ownerRow = page.locator(`.session-bar-row[title="${key}"]`);
                await ownerRow.waitFor();
                await expect.poll(() => ownerRow.count()).toBe(1);
                const chip = ownerRow.getByRole("img", {
                  name: `Molty (agent:${agentId})`,
                  exact: true,
                });
                await expect.poll(() => chip.getAttribute("data-agent-id")).toBe(agentId);
                await expect.poll(() => ownerRow.locator(".agent-row-chip").count()).toBe(1);
              }
              await expect.poll(() => page.locator(".session-bar-row").count()).toBe(2);

              expect(await page.locator(".community-invite-card").count()).toBe(0);
              expect(pageErrors).toEqual([]);
            },
          );
        },
      );
    },
  );

  it.for([1, 2])(
    "clears ranges after session recreation (%s points)",
    async (pointCount, context) => {
      let restoreClock: (() => void) | undefined;
      await runUsageScenario(
        context,
        "usage-detail-instance",
        async (state, port) => {
          await state.writeConfig({
            agents: {
              ownership: "explicit",
              defaults: { workspace: state.workspaceDir },
              entries: { main: {}, opus: {} },
            },
            gateway: gatewayConfig(port),
            plugins: { enabled: false },
          });
          const { startGatewayServer } = await import("../../../src/gateway/server.js");
          const { ensureGatewayOwnerProfile } = await import("../../../src/state/user-profiles.js");
          ensureGatewayOwnerProfile("Usage Proof", { env: state.env });
          return startGatewayServer;
        },
        async (state, port, signal) => {
          const { persistSessionTranscriptTurn } =
            await import("../../../src/config/sessions/session-accessor.js");
          await suite.withPage(
            { locale: "en-US", timezoneId: "UTC", serviceWorkers: "block", viewport },
            async ({ page }) => {
              const key = "agent:opus:usage-instance-proof";
              const gatewayUrl = new URL(`ws://127.0.0.1:${port}`).href;
              const pageErrors: string[] = [];
              const overviewRequests = new Map<string, Record<string, unknown>>();
              const observedOverviews: Array<{
                params: Record<string, unknown>;
                session?: SessionsUsageResult["sessions"][number];
              }> = [];
              let connections = 0;
              page.on("pageerror", (error) => pageErrors.push(String(error)));
              page.on("websocket", (socket) => {
                if (socket.url() !== gatewayUrl) {
                  return;
                }
                connections++;
                socket.on("framesent", ({ payload }) => {
                  const frame: {
                    type: string;
                    id: string;
                    method?: string;
                    params?: Record<string, unknown>;
                  } = JSON.parse(payload.toString());
                  if (
                    frame.type === "req" &&
                    frame.method === "sessions.usage" &&
                    frame.params &&
                    frame.params.key === undefined
                  ) {
                    overviewRequests.set(frame.id, frame.params);
                  }
                });
                socket.on("framereceived", ({ payload }) => {
                  const frame: {
                    type: string;
                    id: string;
                    ok?: boolean;
                    payload?: SessionsUsageResult;
                  } = JSON.parse(payload.toString());
                  const params = overviewRequests.get(frame.id);
                  if (frame.type !== "res" || !frame.ok || !params || !frame.payload) {
                    return;
                  }
                  observedOverviews.push({
                    params,
                    session: frame.payload.sessions.find((entry) => entry.key === key),
                  });
                });
              });
              const url = new URL("settings/general", suite.server.baseUrl);
              url.searchParams.set("gatewayUrl", gatewayUrl);
              await page.goto(url.toString());
              await page
                .locator("openclaw-gateway-url-confirmation")
                .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
                .click();
              await waitForControlUiGatewayReady(page);

              const date = new Date().toISOString().slice(0, 10);
              const timestamp = Date.parse(`${date}T12:00:00Z`);
              const createSession = async (label: string, tokens: number, timestamps: number[]) => {
                const created = await requestGateway<{
                  ok: boolean;
                  key: string;
                  sessionId: string;
                }>(page, "sessions.create", {
                  key,
                  agentId: "opus",
                  label: `${label} usage session`,
                });
                expect(created).toMatchObject({ ok: true, key });
                expect(created.sessionId).toBeTruthy();
                signal.throwIfAborted();
                await persistSessionTranscriptTurn(
                  {
                    agentId: "opus",
                    sessionKey: key,
                    sessionId: created.sessionId,
                    env: state.env,
                  },
                  {
                    cwd: state.workspaceDir,
                    updateMode: "none",
                    messages: timestamps.map((turnTimestamp, index) => ({
                      now: turnTimestamp,
                      message: {
                        ...createExactAssistantMessage({
                          text: `${label} reply ${index + 1}`,
                          provider: "fixture",
                          model: "usage-proof",
                        }),
                        timestamp: turnTimestamp,
                        usage: {
                          ...createZeroUsageFixture(),
                          input: tokens,
                          totalTokens: tokens,
                          cost: { ...createZeroUsageFixture().cost, input: 0.01, total: 0.01 },
                        },
                      },
                    })),
                  },
                );
                return created.sessionId;
              };
              const originalId = await createSession("Original", 100, [
                timestamp,
                timestamp + 1_000,
              ]);
              await page.goto(new URL("usage", suite.server.baseUrl).toString());
              await waitForControlUiGatewayReady(page);
              const selected = page.locator(
                `.session-bar-row[title="${key}"] .session-bar-selection`,
              );
              await selected.click();
              const panel = page.locator(".session-detail-panel");
              const timeline = panel.locator(".timeseries-summary");
              const logs = panel.locator(".session-log-content");
              const readDetails = async () => ({
                timeline: (await timeline.allTextContents()).join("\n"),
                conversation: await logs.allTextContents(),
              });
              await expect.poll(readDetails).toEqual({
                timeline: expect.stringContaining("200"),
                conversation: ["Original reply 1", "Original reply 2"],
              });
              const initialOverview = observedOverviews.findLast(
                (overview) => overview.session?.sessionId === originalId,
              );
              if (!initialOverview) {
                throw new Error("The Usage page did not receive its original session overview");
              }
              const moveOriginalRange = await dragTimelineRange(page, 0.5);
              await panel.locator(".session-detail-indicator").waitFor({ state: "visible" });
              if (pointCount === 1) {
                await page.mouse.up();
              }
              const selectedConnections = connections;

              const deleted = await requestGateway<{ deleted: boolean }>(page, "sessions.delete", {
                key,
                agentId: "opus",
                expectedSessionId: originalId,
                deleteTranscript: true,
              });
              expect(deleted.deleted).toBe(true);
              const replacementId = await createSession(
                "Replacement",
                300,
                Array.from(
                  { length: pointCount },
                  (_, index) => timestamp + 60_000 + index * 1_000,
                ),
              );
              expect(replacementId).not.toBe(originalId);

              // Age the real cache without replacing its loader or advancing asynchronous timers.
              const realNow = Date.now.bind(Date);
              const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
              restoreClock = () => clock.mockRestore();
              const overviewParams = initialOverview.params;
              // The first stale-while-refresh read may still return the retired instance.
              await expect
                .poll(async () => {
                  const overview = await requestGateway<SessionsUsageResult>(
                    page,
                    "sessions.usage",
                    overviewParams,
                  );
                  const current = overview.sessions.find((session) => session.key === key);
                  return { sessionId: current?.sessionId, tokens: current?.usage?.totalTokens };
                })
                .toEqual({ sessionId: replacementId, tokens: pointCount * 300 });
              const focusOverviewStart = observedOverviews.length;

              // Keep the real connection active while aging the browser's five-minute focus TTL.
              const browserNow = await page.evaluate(() => Date.now());
              for (let step = 1; step <= 31; step++) {
                await page.clock.setFixedTime(new Date(browserNow + step * 10_000));
                await requestGateway(page, "health", {});
              }
              await page.bringToFront();
              await page.evaluate(() => window.dispatchEvent(new Event("focus")));
              await expect
                .poll(() => panel.locator(".session-detail-title").textContent())
                .toContain("Replacement usage session");
              await expect
                .poll(() => panel.locator(".session-detail-stats").textContent())
                .toContain(String(pointCount * 300));
              const selectedReplacement = page.locator(
                ".session-bar-row.selected .session-bar-selection",
              );
              expect(await selectedReplacement.count()).toBe(1);
              expect(await selectedReplacement.getAttribute("aria-pressed")).toBe("true");
              expect(await selectedReplacement.getAttribute("aria-label")).toBe(
                "Replacement usage session",
              );
              await expect
                .poll(() =>
                  observedOverviews
                    .slice(focusOverviewStart)
                    .some((overview) => overview.session?.sessionId === replacementId),
                )
                .toBe(true);
              expect(connections).toBe(selectedConnections);
              if (pointCount === 2) {
                await moveOriginalRange();
                await page.mouse.up();
              }
              try {
                await expect.poll(readDetails).toEqual({
                  timeline: pointCount === 1 ? "" : expect.stringContaining("600"),
                  conversation: Array.from(
                    { length: pointCount },
                    (_, index) => `Replacement reply ${index + 1}`,
                  ),
                });
                expect(await panel.locator(".timeseries-summary__range").count()).toBe(0);
              } finally {
                await page.mouse.up();
              }
              if (pointCount === 2) {
                await dragTimelineRange(page, 0.25);
                await page.mouse.up();
                await expect.poll(() => logs.allTextContents()).toEqual(["Replacement reply 1"]);
                await panel.getByRole("button", { name: "Reset", exact: true }).click();
                await expect.poll(() => logs.count()).toBe(2);
              }
              expect(connections).toBe(selectedConnections);
              expect(await page.locator(".community-invite-card").count()).toBe(0);
              expect(pageErrors).toEqual([]);
            },
          );
        },
        () => restoreClock?.(),
      );
    },
  );
});
