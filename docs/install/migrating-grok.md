---
summary: "Migrate Grok Bot agents and configuration into OpenClaw"
read_when:
  - You want to move your Grok Bot setup into OpenClaw
  - You have a Grok Bot recipe or marketplace URL to import
title: "Migrating from Grok Bot"
---

The bundled Grok Bot migration provider performs a **one-time migration**. It uses
the same preview, backup, conflict handling, and report workflow as the Hermes
provider. It does not synchronize later changes with Grok.

## Preview and import

On the computer where you use Grok Bot:

```bash
openclaw migrate grok --dry-run
openclaw migrate apply grok
```

The default source combines local Grok Bot settings with authenticated cloud
reads of your owned bots. The local roster is a discovery cache; it does not
contain complete bot instructions, skills, or memory. Planning may request macOS
Keychain access to read the Grok sign-in credential. This source login is separate
from consent to copy reusable credentials into OpenClaw.

Like Hermes, onboarding imports into a fresh setup; the standalone migration CLI
also supports existing installations:

```bash
openclaw onboard --import-from grok
openclaw migrate apply grok --from ~/exports/grok --yes
```

Standalone apply requires offline access to the selected OpenClaw state and
creates a verified backup. Review conflicts before using `--overwrite`. During
onboarding, primary workspace/config changes are staged; additional agents,
shared credentials, and scheduled jobs are created after promotion. Failed
deferred steps can be retried without duplicating completed agents or jobs.

## Source choices

Use `--from` with:

- A Grok Bot application data directory, normally
  `~/Library/Application Support/Grok Bot` on macOS. Local preferences may also
  live in `~/.grokbot/settings.json`.
- `live`, for an authenticated account read without requiring a local roster.
- An exported Grok Bot recipe JSON file.
- A marketplace or share URL, such as
  `https://x.ai/bot/marketplace/bots/stalk-bot`.
- A directory containing `grok-migration.json`, for an offline account snapshot.

Recipes and marketplace URLs describe one bot. They do not include the owner's
account settings or connected credentials. The report distinguishes missing
sections from sections that were exported and are empty.

## What transfers

| Grok data                     | OpenClaw result                                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Owned agents                  | Native agents with stable IDs; the verified Grok primary agent maps to the selected/default OpenClaw agent            |
| Names and icons               | Workspace identity plus downloaded custom icons or rendered Grok shape/color avatars                                  |
| Instructions and skills       | Full source text in `SOUL.md` and workspace skills                                                                    |
| Available memory              | Appended to `MEMORY.md`, preserving existing memory and avoiding duplicate import blocks                              |
| User timezone                 | `agents.defaults.userTimezone`                                                                                        |
| Compatible MCP connections    | Native MCP configuration with supported tool restrictions, initially disabled pending scope and permission review     |
| Supported cron automations    | Native isolated agent jobs with the source schedule and timezone, initially disabled pending tool and delivery review |
| Known reusable model API keys | Native shared credential store, only with credential-import consent                                                   |

Grok's current private-bot API may not expose full memory. A complete recipe can
contain memory even when an account read cannot retrieve it. Unavailable memory
is reported explicitly; a successful partial import is not a claim of complete
source coverage.

Supported cron schedules are imported disabled because Grok's tool permission
and delivery rules do not have a verified native equivalent. The report retains
their original enabled state. Review native permissions and delivery before
enabling them. Event triggers, unsupported delivery behavior, and unresolved
plugin dependencies remain manual-review items. Original automation and
integration definitions are retained in the report's source archive with
credential values redacted.

Grok plugin IDs are not OpenClaw package names. Cloud-managed OAuth grants and
service accounts require reconnecting the corresponding integration. Grok's
computer-use model and tool permission policies are reported for review instead
of guessed model or permission mappings. Sessions, account UI preferences, and
cloud vault passwords are not imported as active OpenClaw state.

## Credentials

Interactive apply uses the migration workflow's credential consent prompt. Use
`--include-secrets` with `--yes` for an unattended import, or
`--no-auth-credentials` to skip credential copying. Plans and reports contain
credential selectors, never resolved values. Grok sign-in tokens are used only
to read the source and are never imported as model API keys.

Imported MCP connections remain disabled until their agent scope and tool
permissions are reviewed: Grok selects connections per bot, while imported native
server definitions are shared. The report preserves the source enabled state.
Connections with omitted credentials or cloud OAuth also need reconnecting.
Arbitrary user-secret names without a known OpenClaw destination are manual-review
items.

## Offline account snapshots

An offline snapshot is an import artifact, not an OpenClaw runtime config file.
Its envelope is:

```json
{
  "format": "grok-migration",
  "version": 1,
  "mainAgentId": "researcher",
  "settings": { "userTimeZoneOverride": "America/Los_Angeles" },
  "agents": [
    {
      "id": "researcher",
      "profile": { "name": "Researcher", "description": "Cite your sources." },
      "memory": [],
      "skills": [],
      "routines": [],
      "plugins": []
    }
  ],
  "mcpConfig": { "mcpServers": {} },
  "credentialNames": []
}
```

Agent content uses the Grok recipe shape. Omit unavailable arrays instead of
replacing them with empty arrays. Optional `automations` contains original Grok
automation records. Named reusable credentials can be supplied separately in a
sibling `secrets.json` object; keep that file private. The importer reads selected
values only during credential-enabled apply.

Snapshots exported from a partial account read can retain completeness using
`sourceStatus` entries such as `"memory": { "status": "partial", "reason": "Only memory facts were available." }`.
Top-level entries describe `settings`, `agents`, and `mcpServers`; each agent can
describe `memory`, `skills`, `automations`, and `plugins`. Optional `sourceIssues`
retains source warnings. Agent `avatarImage` accepts validated raster bytes as
`{ "base64": "...", "extension": "png" }` (also `jpg`, `gif`, and `webp`, up to
1 MiB). Optional `mcpMetadata` maps server names to original `instructions` and
`disabledTools`. These fields preserve available content without upgrading partial
sections to complete ones.

With multiple destination agents, pass `--agent <id>` to select the primary
import destination, including when repeating a migration that created additional
agents. A saved onboarding continuation retains its reviewed primary destination.

After migration, review the report, select a usable OpenClaw model, reconnect
manual integrations, and test the imported agents before retiring Grok Bot.
