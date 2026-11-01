
import { AgentiaCommand } from '@copado/agentia-plugin-sdk'
import { Flags } from '@oclif/core'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

interface ApexMethod {
  className: string
  methodName: string
  returnType: string
  parameters: string
  file: string
  queriedFields: string[]
}

interface LwcConsumer {
  methodName: string
  apexClass: string
  file: string
  importedAs: string
  properties: string[]
  argumentKeys: string[]
}

interface ContractSnapshot {
  generatedAt: string
  methods: ApexMethod[]
  consumers: LwcConsumer[]
}

export default class ContractScan extends AgentiaCommand {
  static override description =
    'Scan Apex contracts and identify LWC consumers'

  static override flags = {
    path: Flags.string({
      char: 'p',
      description: 'Salesforce project directory',
      default: '.',
    }),
    'save-baseline': Flags.boolean({
      description: 'Save the discovered contracts as a baseline JSON snapshot',
      default: false,
    }),
  }

  private async findFiles(
    directory: string,
    extension: string,
  ): Promise<string[]> {
    const results: string[] = []
    let entries

    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return results
    }

    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === '.apex-contract-guard'
      ) {
        continue
      }

      const fullPath = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        results.push(...await this.findFiles(fullPath, extension))
      } else if (entry.name.endsWith(extension)) {
        results.push(fullPath)
      }
    }

    return results
  }

  private extractArgumentKeys(argumentsText: string): string[] {
    const keys = new Set<string>()
    const pattern = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g

    let match: RegExpExecArray | null

    while ((match = pattern.exec(argumentsText)) !== null) {
      keys.add(match[1])
    }

    return [...keys]
  }

  private extractProperties(
  source: string,
  variableNames: string[],
): string[] {
  const properties = new Set<string>()

  for (const variable of variableNames) {
    const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    const pattern = new RegExp(
      '\\b' + escaped +
      '(?:\\s*\\[\\s*\\d+\\s*\\])?\\s*((?:\\.\\s*[A-Za-z_$][\\w$]*)+)',
      'g',
    )

    let match: RegExpExecArray | null

    while ((match = pattern.exec(source)) !== null) {
      const property = match[1]
        .split('.')
        .map(part => part.trim())
        .filter(Boolean)
        .join('.')

      if (property) {
        properties.add(property)
      }
    }
  }

  return [...properties]
}

  private extractMethodBody(
    source: string,
    startIndex: number,
  ): string {
    const bodyStart = source.indexOf('{', startIndex)

    if (bodyStart === -1) return ''

    let depth = 0

    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === '{') depth++
      if (source[i] === '}') depth--

      if (depth === 0) {
        return source.slice(bodyStart + 1, i)
      }
    }

    return ''
  }

  private extractCallbackBody(
  source: string,
  startIndex: number,
): string {
  const bodyStart = source.indexOf('{', startIndex)

  if (bodyStart === -1) return ''

  let depth = 0

  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--

    if (depth === 0) {
      return source.slice(bodyStart + 1, i)
    }
  }

  return ''
}

  private extractSoqlFields(methodBody: string): string[] {
    const fields = new Set<string>()
    const queryPattern = /\bSELECT\s+([\s\S]*?)\s+FROM\b/gi

    let match: RegExpExecArray | null

    while ((match = queryPattern.exec(methodBody)) !== null) {
      for (const field of match[1].split(',')) {
        const cleaned = field.trim()

        if (/^[A-Za-z_][\w.]*$/.test(cleaned)) {
          fields.add(cleaned)
        }
      }
    }

    return [...fields]
  }

  public async run() {
    const { flags } = await this.parse(ContractScan)
    const root = path.resolve(flags.path)

    const classDirectory = path.join(
      root,
      'force-app',
      'main',
      'default',
      'classes',
    )

    const lwcDirectory = path.join(
      root,
      'force-app',
      'main',
      'default',
      'lwc',
    )

    try {
      const apexFiles = await this.findFiles(classDirectory, '.cls')
      const lwcFiles = await this.findFiles(lwcDirectory, '.js')

      const methods: ApexMethod[] = []
      const consumers: LwcConsumer[] = []

      // Extract exposed Apex methods.
      for (const file of apexFiles) {
        const source = await readFile(file, 'utf8')
        const className = path.basename(file, '.cls')

        const pattern =
          /@AuraEnabled\b[\s\S]{0,300}?\b(?:public|global)\s+(?:(?:static)\s+)?([\w.<>\[\]]+)\s+(\w+)\s*\(([^)]*)\)/g

        let match: RegExpExecArray | null

        while ((match = pattern.exec(source)) !== null) {
          const methodBody = this.extractMethodBody(
            source,
            pattern.lastIndex,
          )

          methods.push({
            className,
            methodName: match[2],
            returnType: match[1],
            parameters: match[3].trim() || 'none',
            file: path.relative(root, file),
            queriedFields: this.extractSoqlFields(methodBody),
          })
        }
      }

      // Extract individual LWC consumers.
      for (const file of lwcFiles) {
        const source = await readFile(file, 'utf8')

        const importPattern =
          /import\s+(\w+)\s+from\s+['"]@salesforce\/apex\/(\w+)\.(\w+)['"]/g

        let importMatch: RegExpExecArray | null

        while ((importMatch = importPattern.exec(source)) !== null) {
          const importedAs = importMatch[1]
          const apexClass = importMatch[2]
          const methodName = importMatch[3]

          const escapedName = importedAs.replace(
            /[.*+?^${}()|[\]\\]/g,
            '\\$&',
          )

          const argumentKeys = new Set<string>()
          const properties = new Set<string>()

          // Find imperative calls to this imported Apex method.
          // Find imperative calls to this imported Apex method.
          
          // Find imperative calls to this imported Apex method.
          const imperativePattern = new RegExp(
            '\\b' + escapedName + '\\s*\\(\\s*\\{([^{}]*)\\}\\s*\\)',
            'g',
          )

          let callMatch: RegExpExecArray | null

          while ((callMatch = imperativePattern.exec(source)) !== null) {
            for (const key of this.extractArgumentKeys(callMatch[1])) {
              argumentKeys.add(key)
            }

            const callEnd = callMatch.index + callMatch[0].length

            const nextCall = imperativePattern.exec(source)
            const sectionEnd = nextCall
              ? nextCall.index
              : source.length

            // Reset the regex position so the outer loop processes the next call.
            imperativePattern.lastIndex = callEnd

            const section = source.slice(callEnd, sectionEnd)

            const thenPattern =
              /\.then\s*\(\s*(?:\(?\s*(\w+)\s*\)?\s*=>|\(\s*(\w+)\s*\)\s*=>)/g

            const thenMatch = thenPattern.exec(section)

            if (thenMatch) {
              const resultVariable = thenMatch[1] || thenMatch[2]
              const bodyStart = thenMatch.index + thenMatch[0].length
              const body = this.extractCallbackBody(section, bodyStart)

              for (const property of this.extractProperties(
                body,
                [resultVariable],
              )) {
                properties.add(property)
              }
            }
          }

          // Find @wire consumers and their specific handler.
          const wirePattern = new RegExp(
            '@wire\\s*\\(\\s*' + escapedName +
            '\\s*,\\s*\\{([^{}]*)\\}\\s*\\)',
            'g',
          )

          let wireMatch: RegExpExecArray | null

          while ((wireMatch = wirePattern.exec(source)) !== null) {
            for (const key of this.extractArgumentKeys(wireMatch[1])) {
              argumentKeys.add(key)
            }

            const afterWire = source.slice(
              wireMatch.index + wireMatch[0].length,
            )

            const handlerMatch = afterWire.match(
              /^\s*(?:[A-Za-z_$][\w$]*\s*[,;]\s*)?(\w+)\s*\(/,
            )

            if (handlerMatch) {
              const handlerName = handlerMatch[1]

              const handlerPattern = new RegExp(
                '\\b' + handlerName + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}',
              )

              const handler = source.match(handlerPattern)

              if (handler) {
                const handlerBody = handler[1]

                for (const property of this.extractProperties(
                  handlerBody,
                  ['data'],
                )) {
                  properties.add(property)
                }

                // Handle destructured wire responses and common assignments.
                const assignmentPattern =
                  /this\.(\w+)\s*=\s*data/g

                let assignmentMatch: RegExpExecArray | null

                while (
                  (assignmentMatch = assignmentPattern.exec(handlerBody)) !== null
                ) {
                  const assignedProperty = assignmentMatch[1]

                  for (const property of this.extractProperties(
                    handlerBody,
                    ['data', assignedProperty],
                  )) {
                    properties.add(property)
                  }
                }
              }
            }
          }

          consumers.push({
            methodName,
            apexClass,
            importedAs,
            file: path.relative(root, file),
            properties: [...properties],
            argumentKeys: [...argumentKeys],
          })
        }
      }

      const snapshot: ContractSnapshot = {
        generatedAt: new Date().toISOString(),
        methods,
        consumers,
      }

      this.log('\nAPEX CONTRACT GUARD')
      this.log('==================\n')

      this.log('EXPOSED APEX METHODS')
      this.log('--------------------')

      for (const method of methods) {
        this.log(`${method.className}.${method.methodName}`)
        this.log(`  Return type: ${method.returnType}`)
        this.log(`  Parameters:  ${method.parameters}`)
        this.log(`  File:        ${method.file}`)
        this.log(
          `  SOQL fields: ${method.queriedFields.join(', ') || 'None detected'}\n`,
        )
      }

      this.log('\nLWC CONSUMERS')
      this.log('-------------')

      for (const consumer of consumers) {
        this.log(`${consumer.apexClass}.${consumer.methodName}`)
        this.log(`  Imported as: ${consumer.importedAs}`)
        this.log(`  LWC file:    ${consumer.file}`)
        this.log(
          `  Properties:  ${consumer.properties.join(', ') || 'Not detected'}`,
        )
        this.log(
          `  Argument keys: ${consumer.argumentKeys.join(', ') || 'Not detected'}\n`,
        )
      }

      // Validate LWC dependencies against Apex contracts.
      this.log('\nDEPENDENCY VALIDATION')
      this.log('--------------------')

      for (const consumer of consumers) {
        const consumerMethods = methods.filter(
          method =>
            method.className === consumer.apexClass &&
            method.methodName === consumer.methodName,
        )

        const matchingMethod = consumerMethods.find(method => {
          const parameterNames = method.parameters
            .split(',')
            .map(parameter => parameter.trim().split(/\s+/).pop() || '')
            .filter(Boolean)

          return consumer.argumentKeys.every(key =>
            parameterNames.includes(key),
          )
        })

        if (!matchingMethod) {
          this.log(
            `${consumer.apexClass}.${consumer.methodName}: UNRESOLVED`,
          )
          continue
        }

        this.log(
          `\n${consumer.apexClass}.${consumer.methodName}`,
        )

        const queriedFields = new Set(
          matchingMethod.queriedFields.map(field => field.toLowerCase()),
        )

        let hasMissingFields = false

        for (const property of consumer.properties) {
          const available = queriedFields.has(property.toLowerCase())

          this.log(
            `  ${property}: ${available ? 'AVAILABLE' : 'MISSING'}`,
          )

          if (!available) {
            hasMissingFields = true
          }
        }

        if (hasMissingFields) {
          this.log('\n  [BREAKING CHANGE]')
          this.log(
            `  Method: ${matchingMethod.className}.${matchingMethod.methodName}(${matchingMethod.parameters})`,
          )

          const missingFields = consumer.properties.filter(
            property => !queriedFields.has(property.toLowerCase()),
          )

          for (const field of missingFields) {
            this.log(`  Missing field: ${field}`)
          }

          this.log(`  Consumer: ${consumer.file}`)
          this.log('  Suggested fix:')
          this.log(
            '  Add the missing field to the Apex SOQL SELECT statement,',
          )
          this.log(
            '  or update the LWC to stop accessing that field.',
          )
        } else {
          this.log('  FIELD CONTRACT: VALID')
        }
      }

      if (flags['save-baseline']) {
        const snapshotDirectory = path.join(
          root,
          '.apex-contract-guard',
        )

        await mkdir(snapshotDirectory, { recursive: true })

        const snapshotPath = path.join(
          snapshotDirectory,
          'baseline.json',
        )

        await writeFile(
          snapshotPath,
          JSON.stringify(snapshot, null, 2),
          'utf8',
        )

        this.log(`\nBaseline saved: ${snapshotPath}`)
      }

      this.log('\nSCAN SUMMARY')
      this.log('------------')
      this.log(`Apex methods: ${methods.length}`)
      this.log(`LWC consumers: ${consumers.length}`)
    } catch (error) {
      this.error(
        `Unable to scan Salesforce project: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}
