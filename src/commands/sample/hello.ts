import {AgentiaCommand, getAgentiaHost} from '@copado/agentia-plugin-sdk'
import {Args, Flags} from '@oclif/core'

export default class SampleHello extends AgentiaCommand {
  static override description = 'Print a greeting and the configured Agentia credential sets'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> World',
    '<%= config.bin %> <%= command.id %> --from agentia-cli-apex-contract-guard',
    '<%= config.bin %> <%= command.id %> --json',
  ]
  static override args = {
    name: Args.string({description: 'Name to greet', required: false}),
  }
  static override flags = {
    from: Flags.string({
      char: 'f',
      description: 'Who the greeting is from',
      default: 'agentia-cli-apex-contract-guard',
    }),
  }

  public async run() {
    const {args, flags} = await this.parse(SampleHello)
    // Keep this list in sync with "agentia.requires" in package.json.
    const host = getAgentiaHost({requires: ['auth.status', 'format.table', 'work.getWorkItem']})

    const greeting = `hello ${args.name ?? 'Agentia'} from ${flags.from}`
    const status = host.auth.status()
    const rows = Object.entries(status).map(([service, credential]) => ({
      configured: credential.configured ? 'yes' : 'no',
      ready: credential.ready === undefined ? '-' : credential.ready ? 'yes' : 'no',
      service,
      source: credential.source ?? '-',
    }))
    const story = await host.work.getWorkItem()

    this.display(() => {
      this.log(greeting)
      this.log(
        host.format.table(
          [
            {field: 'service', header: 'Service'},
            {field: 'configured', header: 'Configured'},
            {field: 'ready', header: 'Ready'},
            {field: 'source', header: 'Source'},
          ],
          rows,
        ),
      )
      this.log(
        host.format.table(
          [
            {field: 'name', header: 'Story'},
            {field: 'status', header: 'Status'},
          ],
          [story],
        ),
      )
    })

    return {auth: status, greeting, workItem: story}
  }
}
