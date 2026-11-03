# Organization MCP · local increment

The MCP reads the existing organization projection. It does not create another company, coordinator or queue. The standalone worker uses the same `OrgQueue`, result verification and Dashboard outbox/inbox. The installed IDE and this source increment have separate build states; building this package does not install it or connect an assistant.

## Build and verify

Use the repository's Node >=22.13 and pnpm version:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm check:org-execution
pnpm check:org-mcp
```

`check:org-execution` runs two independent synthetic departmental jobs, loses an acknowledgment, restarts the queue/worker/inbox, and verifies two files without a duplicate effect. It also terminates its own synthetic child after publishing one file, recovers its lease and checks that exactly one file remains. `check:org-mcp` launches a real SDK client/server over stdio, reads that HTTP projection and checks that commands stay disabled. These checks create private temporary directories and fake expiring grants, remove their own data, and call no model or external automation.

The package pins the official [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) server/client 2.4.0. The [stdio entry](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html) owns its connection; stdout contains protocol messages, stderr contains a redacted audit stream. The host must retain that stream if a durable read audit is required. Production writes require a durable server audit and are disabled here.

## Register in an authorized local host

Copy [policy.example.json](../packages/org-mcp/policy.example.json) to a private location outside the repository. Limit it to the organizations/projects and scopes the operator approved, with permissions `0600`. The example has no connection and reports **prepared**. Do not copy real credentials, session contents or financial reports into a repository.

After the owner approves registering this server in the chosen Codex host, its CLI supports this command (replace both absolute paths):

```sh
codex mcp add tac-org --env TAC_MCP_CONFIG=/ABS/private/tac-policy.json -- node /ABS/alchemist-coder/out/org-mcp/packages/org-mcp/src/stdio.js
```

This is a registration instruction, not an action the build performs. It registers in that CLI host, not automatically in a separate ChatGPT/Dot session. A host that supports only remote MCP needs an authorized, authenticated HTTPS deployment; no public MCP URL is implemented or provisioned in this increment.

For an existing, authorized projection reader, the private policy can contain:

```json
{
  "version": "ac.mcp.v1",
  "scopes": ["health:read", "organizations:read", "jobs:read", "results:read"],
  "projects": [{
    "orgRef": "OWNER_APPROVED_ORG",
    "projectRef": "OWNER_APPROVED_PROJECT",
    "connection": {"origin": "https://APPROVED_BACKEND.example", "tokenEnv": "TAC_PROJECT_READER"}
  }]
}
```

The host supplies the **existing** reader token transiently through its approved secret/environment mechanism. This package reads only the named environment variable and does not create, rotate or store credentials. Keep token values out of command history, host configuration text and browser JavaScript. The existing reader grant must have `projection:read`, the exact project, an expiry and server-side revocation. Writer grants are separate. HTTPS certificate validation remains enabled; HTTP is accepted only on explicit loopback addresses for local proof. Redirects are rejected.

With no endpoint/token, health reports prepared/unavailable, not connected. Its sequential probes share a ten-second total budget; timed-out/unprobed sources stay explicitly unknown. A successful authorized HTTP read reports connected; queue availability can still be unknown. The result tool exposes verification only: artifact contents and hashes are **not exported** by the current public projection. History coverage is partial; a missing stream/job does not prove the work never happened.

## Tools and scopes

| Tool | Host policy scope | Returned data |
| --- | --- | --- |
| `tac_health` | `health:read` | Connection/queue availability; writes disabled; no URL/token |
| `tac_organizations` | `organizations:read` | Operator-allowed organization/project references |
| `tac_jobs` | `jobs:read` | Opaque scoped jobs, state, attempts, verification and bounded reason codes; 20 per page by default, maximum 50 |
| `tac_job` | `jobs:read` | One job using project + stream + opaque task reference |
| `tac_result` | `results:read` | Result verification and explicit absence of exported details |
| `tac_command` | Operation-specific, reserved | Always denied: backend not authorized |

`tac_jobs` accepts optional `limit` and `offset` across the project's streams and returns `page.nextOffset`, per-stream observed sequences and total/unknown availability. Read a selected job with `tac_job` instead of copying a whole company into context. Pagination observes the current projection on each call, not a frozen historical snapshot.

Every call reloads the private policy. Removing a scope/project revokes subsequent calls and suppresses an in-flight result under an old policy. Stop/unregister the local host server to revoke the stdio connection; revoke the projection reader at the backend separately. For Codex, `codex mcp remove tac-org` removes its registration. A local stdio host has the OS user's access; do not register it in an untrusted host or hand it broad environment credentials.

## Dashboard commands and continuation

[Machine-readable manifest](org-mcp-manifest.v1.json) is the handoff to Dashboard/Compose. The only implemented network endpoints are the existing status ingest and projection read. There is no second command backend and no command HTTP endpoint yet.

The versioned intent is `ac.command.v1`: `orgRef`, `projectRef`, `action`, `idempotencyKey`, and operation references. `propose` requires `intentRef` for an immutable server-held workflow/input intent; `approve` requires `proposalRef`; `dispatch` requires `proposalRef` and `approvalRef`; `cancel` requires the opaque `taskRef`; `continue` requires `proposalRef`, `approvalRef` and `parentResultRef`. Unknown fields, arbitrary URLs/paths and client `approval:true` are rejected. This schema reserves integration compatibility; it does not authorize execution.

The production lifecycle must be proposal → server-verified approval → existing organization job → fenced, verified result receipt → reviewed continuation. The server must bind approval to principal, scope, exact intent, budget/resources, expiry and required human decisions; an agent or Autopilot cannot invent approval. Scope organization/project/principal/idempotency key to a canonical intent digest; duplicates return the original receipt and conflicts fail. A continuation references its committed parent result and becomes a new idempotent job. Uncertain external effects remain isolated for reconciliation.

Until that authenticated dispatcher is implemented and authorized, `writesEnabled` is false and `tac_command` returns `backend_not_authorized` even if a policy includes a write scope. Dashboard must disable action buttons with that reason and keep proposals visibly prepared. It must not infer completion from an ack, a model claim or a locally saved suggestion.

## Execution and deployment limits

The local authority holds the queue ownership lock. Worker leases use generation fencing, bounded heartbeat and a fixed task deadline. The trusted local fixture commits and verifies one atomic, idempotent file effect; stale/cancelled leases cannot report completion. After restart, only preauthorized idempotent work can replay. Reconciliation work blocks itself, not independent departments. Queue/worker corruption fails closed with the bytes preserved.

This proves one local adapter. Remote effect destinations need their own fencing/idempotency; a lease alone cannot prevent all external duplicate effects. The GCP adapter still needs transactional state, server time, authenticated worker capabilities and durable audit. No always-on scheduler, remote worker or production MCP connection is claimed. Mac render/build tasks require the Mac online; lightweight cloud work requires an approved executor. Komodo has no approved spare capacity; Chipre remains an optional pilot. Namecheap keeps the existing website/Dashboard; Firebase/GCP resources, billing/IAM, grants and deployment are pending their specific authorization.

Department/brand credentials remain separate secret references. This increment starts no social sender, scraper, notification push, publisher or payment task. Existing sandbox, approvals and edition/license checks continue to apply.
