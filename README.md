# agentia-cli-apex-contract-guard

Agentia CLI oclif plugin

After install or link, it adds:

```text
agentia sample hello [NAME] [--from VALUE] [--json]
```

It prints a greeting, which Agentia credential sets (`cicd`, `crt`, `ai`) are configured, and the active work item, using the plugin SDK.

## Getting started

If you created this plugin with `npm init @copado/agentia-plugin`, dependencies are already installed.

```sh
npm run build
agentia plugins link .
```

Confirm:

```sh
agentia plugins
agentia sample hello
agentia sample hello World --from me
```

Re-run `npm run build` after TypeScript changes. Linked ESM plugins load compiled `dist/` output.

## Install from npm

```sh
agentia plugins install agentia-cli-apex-contract-guard
```

## Using the Agentia host

Commands extend `AgentiaCommand` from `@copado/agentia-plugin-sdk`, which adds `--json`, `display`, and `withSpinner`. Call the host from inside `run()`:

```ts
import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'

const host = getAgentiaHost({requires: ['auth.status', 'format.table', 'work.getWorkItem']})
const story = await host.work.getWorkItem()
this.display(() => {
  this.log(host.format.table(
    [{field: 'name', header: 'Story'}, {field: 'status', header: 'Status'}],
    [story],
  ))
})
```

Host methods available today: `work.getWorkItem`, `organization.healthCheck`, `auth.status`, and `format.table`. See the [SDK README](https://www.npmjs.com/package/@copado/agentia-plugin-sdk) for details.

- List every host method the plugin uses in `requires` (in the command and in `agentia.requires` in `package.json`). An older CLI then fails with a clear "update the CLI" message.
- Fill in `agentia.permissions` in `package.json` honestly (network hosts, file scope, executables, environment variables). It is declared for review and is not enforced.
- The host never gives a plugin credentials. Do not import `@copado/agentia-cli` or run `agentia` as a subprocess.
- Plugins run in the CLI process with the user's permissions. Install only plugins you trust.

## Not supported yet

- Extending or wrapping existing Agentia commands (`cicd work commit`, and so on)
- Registering MCP tools through a plugin (`agentia mcp start` only loads tools shipped with the CLI)

Need another host capability? Ask the Agentia CLI team; each method is a deliberate addition.

## Requirements

- Node.js 22.12 or newer
- Agentia CLI available on your `PATH`

## Layout

```text
agentia-cli-apex-contract-guard/
  package.json
  tsconfig.json
  src/
    index.ts
    commands/
      sample/
        hello.ts
  dist/
```

Generated with `npm init @copado/agentia-plugin`.
