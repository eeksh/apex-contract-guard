
import { AgentiaCommand } from '@copado/agentia-plugin-sdk'
import { Flags } from '@oclif/core'
import { readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

interface ApexMethod {
  className: string
  methodName: string
  returnType: string
  parameters: string
  file: string
  queriedFields?: string[]
}

interface LwcConsumer {
  methodName: string
  apexClass: string
  file: string
  importedAs: string
  properties: string[]
  argumentKeys?: string[]
  invocations?: string[][]
}

interface ContractSnapshot {
  generatedAt: string
  methods: ApexMethod[]
  consumers: LwcConsumer[]
}

interface Change {
  severity: 'BREAKING' | 'POTENTIALLY BREAKING' | 'SAFE'
  message: string
  affectedConsumers: string[]
}

interface Parameter {
  type: string
  name: string
}

export default class ContractCompare extends AgentiaCommand {
  static override description =
    'Compare Apex contracts and LWC consumers against a saved baseline'

  static override flags = {
    path: Flags.string({
      char: 'p',
      description: 'Salesforce project directory',
      default: '.',
    }),
    source: Flags.string({
      description: 'Comparison source: baseline or git',
      options: ['baseline', 'git'],
      default: 'baseline',
    }),
  }

  private async getGitApexFiles(root: string): Promise<ApexMethod[]> {
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        root,
        'ls-tree',
        '-r',
        '--name-only',
        'HEAD',
        '--',
        'force-app/main/default/classes',
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    )

    const classFiles = stdout
      .split(/\r?\n/)
      .filter(file => file.endsWith('.cls'))

    const methods: ApexMethod[] = []

    for (const gitPath of classFiles) {
      const { stdout: source } = await execFileAsync(
        'git',
        ['-C', root, 'show', `HEAD:${gitPath}`],
        { maxBuffer: 10 * 1024 * 1024 },
      )

      const className = path.basename(gitPath, '.cls')

      const pattern =
        /@AuraEnabled\b[\s\S]{0,300}?\b(?:public|global)\s+(?:(?:static)\s+)?([\w.<>\[\]]+)\s+(\w+)\s*\(([^)]*)\)/g

      let match: RegExpExecArray | null

      while ((match = pattern.exec(source)) !== null) {
        methods.push({
  className,
  methodName: match[2],
  returnType: match[1],
  parameters: match[3].trim() || 'none',
  file: gitPath,
  queriedFields: this.extractSoqlFields(
    source,
    match.index + match[0].length,
  ),
})
      }
    }

    return methods
  }

  // Find files by extension.
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

  // Split parameters without breaking nested generic types.
  private splitParameters(parameters: string): string[] {
    if (!parameters || parameters.trim() === 'none') {
      return []
    }

    const result: string[] = []
    let current = ''
    let angleDepth = 0
    let squareDepth = 0

    for (const character of parameters) {
      if (character === '<') angleDepth++
      if (character === '>') angleDepth--
      if (character === '[') squareDepth++
      if (character === ']') squareDepth--

      if (
        character === ',' &&
        angleDepth === 0 &&
        squareDepth === 0
      ) {
        result.push(current.trim())
        current = ''
      } else {
        current += character
      }
    }

    if (current.trim()) {
      result.push(current.trim())
    }

    return result
  }

  private getParameters(parameters: string): Parameter[] {
    return this.splitParameters(parameters).map(parameter => {
      const parts = parameter.trim().split(/\s+/)

      return {
        name: parts[parts.length - 1],
        type: parts.slice(0, -1).join(' '),
      }
    })
  }

  private normalizeType(type: string): string {
    return type.replace(/\s+/g, '')
  }

  // Extract the body of an Apex method using brace matching.
private extractMethodBody(
  source: string,
  declarationEnd: number,
): string {
  const openingBrace = source.indexOf('{', declarationEnd)

  if (openingBrace === -1) {
    return ''
  }

  let depth = 0

  for (let i = openingBrace; i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--

    if (depth === 0) {
      return source.slice(openingBrace + 1, i)
    }
  }

  return ''
}

// Extract fields from a straightforward SOQL SELECT statement.
private extractSoqlFields(
  source: string,
  declarationEnd: number,
): string[] {
  const body = this.extractMethodBody(source, declarationEnd)

  const selectMatch = body.match(
    /\bSELECT\s+([\s\S]*?)\s+\bFROM\b/i,
  )

  if (!selectMatch) {
    return []
  }

  return [
    ...new Set(
      selectMatch[1]
        .split(',')
        .map(field => field.trim())
        .filter(field => /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(field)),
    ),
  ]
}

  // Identify overloads using class, method and parameter TYPES.
  // Parameter names are deliberately excluded.
  private getMethodKey(method: ApexMethod): string {
    const parameters = this.getParameters(method.parameters)

    const parameterTypes = parameters.map(
      parameter => this.normalizeType(parameter.type),
    )

    return JSON.stringify([
      method.className,
      method.methodName,
      parameterTypes,
    ])
  }

  private getParameterTypeKey(method: ApexMethod): string {
    return JSON.stringify(
      this.getParameters(method.parameters)
        .map(parameter => this.normalizeType(parameter.type)),
    )
  }

  private async findUnannotatedMethods(
    root: string,
  ): Promise<ApexMethod[]> {
    const classDirectory = path.join(
      root,
      'force-app',
      'main',
      'default',
      'classes',
    )

    const files = await this.findFiles(classDirectory, '.cls')
    const methods: ApexMethod[] = []

    const pattern =
      /\b(?:public|global)\s+(?:(?:static)\s+)?([\w.<>\[\]]+)\s+(\w+)\s*\(([^)]*)\)/g

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      const className = path.basename(file, '.cls')

      let match: RegExpExecArray | null

      while ((match = pattern.exec(source)) !== null) {
        const precedingText = source.slice(
          Math.max(0, match.index - 300),
          match.index,
        )

        if (/@AuraEnabled\b/.test(precedingText)) {
          continue
        }

        methods.push({
          className,
          methodName: match[2],
          returnType: match[1],
          parameters: match[3].trim() || 'none',
          file: path.relative(root, file),
        })
      }
    }

    return methods
  }

  // Extract argument keys from an LWC Apex call.
  private extractArgumentKeys(argumentsText: string): string[] {
    const keys = new Set<string>()
    const pattern = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g

    let match: RegExpExecArray | null

    while ((match = pattern.exec(argumentsText)) !== null) {
      keys.add(match[1])
    }

    return [...keys]
  }

  // Extract properties accessed through a response variable.
  
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


  // Read the current LWC imports and identify their Apex consumers.
  private async findCurrentLwcConsumers(
    root: string,
  ): Promise<LwcConsumer[]> {
    const lwcDirectory = path.join(
      root,
      'force-app',
      'main',
      'default',
      'lwc',
    )

    const files = await this.findFiles(lwcDirectory, '.js')
    const consumers: LwcConsumer[] = []

    for (const file of files) {
      const source = await readFile(file, 'utf8')

      const importPattern =
        /import\s+(\w+)\s+from\s+['"]@salesforce\/apex\/(\w+)\.(\w+)['"]/g

      let match: RegExpExecArray | null

      while ((match = importPattern.exec(source)) !== null) {
        const importedAs = match[1]
        const apexClass = match[2]
        const methodName = match[3]

        const escapedName = importedAs.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        )

        const argumentKeys = new Set<string>()
const invocations: string[][] = []
const properties = new Set<string>()

        // Detect imperative Apex calls.
        const imperativePattern = new RegExp(
          '\\b' + escapedName + '\\s*\\(\\s*\\{([^{}]*)\\}\\s*\\)',
          'g',
        )

        let callMatch: RegExpExecArray | null

        while ((callMatch = imperativePattern.exec(source)) !== null) {
  const callArguments = this.extractArgumentKeys(callMatch[1])

  invocations.push(callArguments)

  for (const key of callArguments) {
    argumentKeys.add(key)
  }

          const callEnd = source.indexOf(')', callMatch.index)
          const section = source.slice(
            callEnd === -1 ? callMatch.index : callEnd,
          )

          const thenPattern =
            /\.then\s*\(\s*(?:\(?\s*(\w+)\s*\)?\s*=>|\(\s*(\w+)\s*\)\s*=>)/g

          let thenMatch: RegExpExecArray | null

          while ((thenMatch = thenPattern.exec(section)) !== null) {
            const resultVariable = thenMatch[1] || thenMatch[2]
            const bodyStart = thenMatch.index + thenMatch[0].length
            const body = section.slice(bodyStart)

            for (const property of this.extractProperties(
              body,
              [resultVariable],
            )) {
              properties.add(property)
            }
          }
        }

        // Detect @wire Apex calls.
        const wirePattern = new RegExp(
          '@wire\\s*\\(\\s*' + escapedName +
          '\\s*,\\s*\\{([^{}]*)\\}\\s*\\)',
          'g',
        )

        let wireMatch: RegExpExecArray | null

        while ((wireMatch = wirePattern.exec(source)) !== null) {
  const wireArguments = this.extractArgumentKeys(wireMatch[1])

  invocations.push(wireArguments)

  for (const key of wireArguments) {
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
              '\\b' + handlerName +
              '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}',
            )

            const handler = source.match(handlerPattern)

            if (handler) {
              for (const property of this.extractProperties(
                handler[1],
                ['data'],
              )) {
                properties.add(property)
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
  invocations,
})
      }
    }

    return consumers
  }

  private getConsumerKey(consumer: LwcConsumer): string {
    return JSON.stringify([
      consumer.apexClass,
      consumer.methodName,
      consumer.file.replace(/\\/g, '/'),
    ])
  }

  public async run() {
    const { flags } = await this.parse(ContractCompare)
    const root = path.resolve(flags.path)

    const baselinePath = path.join(
      root,
      '.apex-contract-guard',
      'baseline.json',
    )

    const classDirectory = path.join(
      root,
      'force-app',
      'main',
      'default',
      'classes',
    )

    try {
      const baselineContent = await readFile(baselinePath, 'utf8')
      const savedBaseline = JSON.parse(
        baselineContent,
      ) as ContractSnapshot

      const baseline: ContractSnapshot = {
        ...savedBaseline,
        methods:
          flags.source === 'git'
            ? await this.getGitApexFiles(root)
            : savedBaseline.methods,
      }

      const files = await this.findFiles(classDirectory, '.cls')
      const currentMethods: ApexMethod[] = []

      for (const file of files) {
        const source = await readFile(file, 'utf8')
        const className = path.basename(file, '.cls')

        const pattern =
          /@AuraEnabled\b[\s\S]{0,300}?\b(?:public|global)\s+(?:(?:static)\s+)?([\w.<>\[\]]+)\s+(\w+)\s*\(([^)]*)\)/g

        let match: RegExpExecArray | null

        while ((match = pattern.exec(source)) !== null) {
          currentMethods.push({
  className,
  methodName: match[2],
  returnType: match[1],
  parameters: match[3].trim() || 'none',
  file: path.relative(root, file),
  queriedFields: this.extractSoqlFields(
    source,
    match.index + match[0].length,
  ),
})
        }
      }

      // Compare current LWC imports with the saved baseline consumers.
      const currentConsumers = await this.findCurrentLwcConsumers(root)
      const consumerChanges: string[] = []

      const baselineConsumerKeys = new Set(
        baseline.consumers.map(consumer => this.getConsumerKey(consumer)),
      )

      const currentConsumerKeys = new Set(
        currentConsumers.map(consumer => this.getConsumerKey(consumer)),
      )

      for (const oldConsumer of baseline.consumers) {
        const key = this.getConsumerKey(oldConsumer)

        if (!currentConsumerKeys.has(key)) {
          consumerChanges.push(
            `[REMOVED] ${oldConsumer.apexClass}.${oldConsumer.methodName} ` +
            `is no longer imported by ${oldConsumer.file}`,
          )
        }
      }

      for (const currentConsumer of currentConsumers) {
        const key = this.getConsumerKey(currentConsumer)

        if (!baselineConsumerKeys.has(key)) {
          consumerChanges.push(
            `[ADDED] ${currentConsumer.apexClass}.${currentConsumer.methodName} ` +
            `is now imported by ${currentConsumer.file}`,
          )
        }
      }

      const unannotatedMethods = await this.findUnannotatedMethods(root)
      
// Validate LWC Apex invocation argument names against current Apex parameters.
// Validate each LWC Apex invocation against current Apex parameters.
for (const consumer of currentConsumers) {
  const apexMethod = currentMethods.find(
    method =>
      method.className === consumer.apexClass &&
      method.methodName === consumer.methodName,
  )

  if (!apexMethod) {
    continue
  }

  const expectedArguments = this.getParameters(apexMethod.parameters)
    .map(parameter => parameter.name)

  const invocations = consumer.invocations || []

  invocations.forEach((actualArguments, index) => {
    const missingArguments = expectedArguments.filter(
      argument => !actualArguments.includes(argument),
    )

    const unexpectedArguments = actualArguments.filter(
      argument => !expectedArguments.includes(argument),
    )

    if (missingArguments.length > 0 || unexpectedArguments.length > 0) {
      consumerChanges.push(
        `[BREAKING] Argument mismatch for ` +
        `${consumer.apexClass}.${consumer.methodName} in ${consumer.file} ` +
        `(invocation ${index + 1}). ` +
        `Expected: (${expectedArguments.join(', ')}); ` +
        `Found: (${actualArguments.join(', ')})`,
      )
    }
  })
}

      const changes: Change[] = []
      const matchedCurrentMethods = new Set<string>()

      for (const oldMethod of baseline.methods) {
        const oldKey = this.getMethodKey(oldMethod)

        const methodConsumers = baseline.consumers.filter(
          consumer =>
            consumer.apexClass === oldMethod.className &&
            consumer.methodName === oldMethod.methodName,
        )

        const consumers = [
          ...new Set(methodConsumers.map(consumer => consumer.file)),
        ]

        // Find the exact method signature, not just its name.
        const currentMethod = currentMethods.find(
          method => this.getMethodKey(method) === oldKey,
        )

        if (currentMethod) {
          matchedCurrentMethods.add(oldKey)

          if (currentMethod.returnType !== oldMethod.returnType) {
            changes.push({
              severity: 'BREAKING',
              message:
                `${oldMethod.className}.${oldMethod.methodName} ` +
                `return type changed from ${oldMethod.returnType} ` +
                `to ${currentMethod.returnType}`,
              affectedConsumers: consumers,
            })
          }

          // Detect parameter name changes even when parameter types match.
          if (currentMethod.parameters !== oldMethod.parameters) {
            const oldParameters = this.getParameters(oldMethod.parameters)
            const newParameters = this.getParameters(currentMethod.parameters)

            const hasConsumerMismatch = methodConsumers.some(consumer => {
              const argumentKeys = consumer.argumentKeys || []

              return oldParameters.some(
                (oldParameter, index) =>
                  oldParameter.name !== newParameters[index]?.name &&
                  argumentKeys.includes(oldParameter.name),
              )
            })

            changes.push({
              severity: hasConsumerMismatch
                ? 'BREAKING'
                : 'POTENTIALLY BREAKING',
              message: hasConsumerMismatch
                ? `${oldMethod.className}.${oldMethod.methodName} ` +
                  `parameter changed from (${oldMethod.parameters}) ` +
                  `to (${currentMethod.parameters}). ` +
                  `Existing LWC consumers still pass the old parameter name.`
                : `${oldMethod.className}.${oldMethod.methodName} ` +
                  `parameters changed from (${oldMethod.parameters}) ` +
                  `to (${currentMethod.parameters}). ` +
                  `Consumer compatibility needs verification.`,
              affectedConsumers: consumers,
            })
          }
          // Detect SOQL fields removed while current LWC consumers still use them.
const oldFields = oldMethod.queriedFields || []
const newFields = currentMethod.queriedFields || []

const normalizedNewFields = new Set(
  newFields.map(field => field.toLowerCase()),
)

const activeConsumers = currentConsumers.filter(
  consumer =>
    consumer.apexClass === oldMethod.className &&
    consumer.methodName === oldMethod.methodName &&
    baseline.consumers.some(
      oldConsumer =>
        this.getConsumerKey(oldConsumer) ===
        this.getConsumerKey(consumer),
    ),
)

const missingFields = new Set<string>()
const affectedFieldConsumers = new Set<string>()

for (const consumer of activeConsumers) {
  for (const property of consumer.properties) {
    const wasPreviouslyQueried = oldFields.some(
      field => field.toLowerCase() === property.toLowerCase(),
    )

    const isCurrentlyQueried = normalizedNewFields.has(
      property.toLowerCase(),
    )

    if (wasPreviouslyQueried && !isCurrentlyQueried) {
      missingFields.add(property)
      affectedFieldConsumers.add(consumer.file)
    }
  }
}

if (missingFields.size > 0) {
  changes.push({
    severity: 'BREAKING',
    message:
      `SOQL fields removed from ${oldMethod.className}.` +
      `${oldMethod.methodName}: ${[...missingFields].join(', ')}. ` +
      `Existing LWC consumers still access these fields.`,
    affectedConsumers: [...affectedFieldConsumers],
  })
}
          continue
        }

        const unannotatedMethod = unannotatedMethods.find(
          method => this.getMethodKey(method) === oldKey,
        )

        if (unannotatedMethod) {
          changes.push({
            severity: 'BREAKING',
            message:
              `@AuraEnabled annotation removed from ` +
              `${oldMethod.className}.${oldMethod.methodName}(${oldMethod.parameters})`,
            affectedConsumers: consumers,
          })
          continue
        }

        // Detect an added required parameter.
        const addedParameterCandidate = currentMethods.find(method => {
          if (
            method.className !== oldMethod.className ||
            method.methodName !== oldMethod.methodName
          ) {
            return false
          }

          const oldParams = this.getParameters(oldMethod.parameters)
          const newParams = this.getParameters(method.parameters)

          return (
            newParams.length > oldParams.length &&
            oldParams.every((oldParam, index) =>
              this.normalizeType(oldParam.type) ===
              this.normalizeType(newParams[index]?.type),
            )
          )
        })

        if (addedParameterCandidate) {
          const oldParams = this.getParameters(oldMethod.parameters)
          const newParams = this.getParameters(
            addedParameterCandidate.parameters,
          )
          const addedParams = newParams.slice(oldParams.length)

          changes.push({
            severity: 'BREAKING',
            message:
              `Required parameter added to ${oldMethod.className}.${oldMethod.methodName}: ` +
              addedParams.map(param => `${param.type} ${param.name}`).join(', '),
            affectedConsumers: consumers,
          })

          matchedCurrentMethods.add(
            this.getMethodKey(addedParameterCandidate),
          )
          continue
        }

        // Detect parameter type changes for the same class and method.
        const typeChangeCandidates = currentMethods.filter(method => {
          const oldParameters = this.getParameters(oldMethod.parameters)
          const newParameters = this.getParameters(method.parameters)

          return (
            method.className === oldMethod.className &&
            method.methodName === oldMethod.methodName &&
            oldParameters.length === newParameters.length &&
            oldParameters.some(
              (parameter, index) =>
                this.normalizeType(parameter.type) !==
                this.normalizeType(newParameters[index].type),
            )
          )
        })

        if (typeChangeCandidates.length === 1) {
          const changedMethod = typeChangeCandidates[0]
          const oldParameters = this.getParameters(oldMethod.parameters)
          const newParameters = this.getParameters(changedMethod.parameters)

          const differences = oldParameters
            .map((parameter, index) => {
              const newParameter = newParameters[index]

              if (
                this.normalizeType(parameter.type) ===
                this.normalizeType(newParameter.type)
              ) {
                return null
              }

              return `${parameter.name}: ${parameter.type} → ${newParameter.type}`
            })
            .filter(Boolean)

          changes.push({
            severity: 'BREAKING',
            message:
              `${oldMethod.className}.${oldMethod.methodName} ` +
              `parameter type changed: ${differences.join(', ')}`,
            affectedConsumers: consumers,
          })

          matchedCurrentMethods.add(this.getMethodKey(changedMethod))
          continue
        }

        // Detect combined signature changes, such as a parameter type change
// together with one or more added parameters.
const signatureChangeCandidates = currentMethods.filter(method => {
  const key = this.getMethodKey(method)

  return (
    method.className === oldMethod.className &&
    method.methodName === oldMethod.methodName &&
    key !== oldKey &&
    !matchedCurrentMethods.has(key)
  )
})

if (signatureChangeCandidates.length === 1) {
  const candidate = signatureChangeCandidates[0]
  const oldParams = this.getParameters(oldMethod.parameters)
  const newParams = this.getParameters(candidate.parameters)

  if (newParams.length > oldParams.length) {
    const commonCount = Math.min(oldParams.length, newParams.length)

    const typeChanges = oldParams
      .slice(0, commonCount)
      .map((parameter, index) => {
        const newParameter = newParams[index]

        if (
          this.normalizeType(parameter.type) ===
          this.normalizeType(newParameter.type)
        ) {
          return null
        }

        return (
          `${parameter.name}: ${parameter.type} → ` +
          `${newParameter.type}`
        )
      })
      .filter((change): change is string => change !== null)

    const addedParams = newParams.slice(oldParams.length)

    const details: string[] = []

    if (typeChanges.length > 0) {
      details.push(`parameter type changed: ${typeChanges.join(', ')}`)
    }

    if (addedParams.length > 0) {
      details.push(
        `required parameter(s) added: ${
          addedParams
            .map(parameter => `${parameter.type} ${parameter.name}`)
            .join(', ')
        }`,
      )
    }

    if (candidate.returnType !== oldMethod.returnType) {
      details.push(
        `return type changed from ${oldMethod.returnType} ` +
        `to ${candidate.returnType}`,
      )
    }

    changes.push({
      severity: 'BREAKING',
      message:
        `${oldMethod.className}.${oldMethod.methodName} signature changed. ` +
        details.join('; '),
      affectedConsumers: consumers,
    })

    matchedCurrentMethods.add(this.getMethodKey(candidate))
    continue
  }
}

        // Detect a method rename.
        const renameCandidates = currentMethods.filter(method => {
          const key = this.getMethodKey(method)

          return (
            method.className === oldMethod.className &&
            method.methodName !== oldMethod.methodName &&
            method.returnType === oldMethod.returnType &&
            this.getParameterTypeKey(method) ===
              this.getParameterTypeKey(oldMethod) &&
            !matchedCurrentMethods.has(key)
          )
        })

        if (renameCandidates.length === 1) {
          const renamedMethod = renameCandidates[0]
          const renamedKey = this.getMethodKey(renamedMethod)

          matchedCurrentMethods.add(renamedKey)

          changes.push({
            severity: 'BREAKING',
            message:
              `${oldMethod.className}.${oldMethod.methodName} ` +
              `was probably renamed to ${renamedMethod.methodName}. ` +
              `Update the LWC import and invocation.`,
            affectedConsumers: consumers,
          })
        } else {
          changes.push({
            severity: 'BREAKING',
            message:
              `${oldMethod.className}.${oldMethod.methodName} ` +
              `with parameter types (${this.getParameterTypeKey(oldMethod)}) ` +
              `was removed`,
            affectedConsumers: consumers,
          })
        }
      }

      // Every unmatched signature is a newly added method or overload.
      for (const currentMethod of currentMethods) {
        const key = this.getMethodKey(currentMethod)

        if (!matchedCurrentMethods.has(key)) {
          changes.push({
            severity: 'SAFE',
            message:
              `New method or overload added: ` +
              `${currentMethod.className}.${currentMethod.methodName} ` +
              `(${currentMethod.parameters})`,
            affectedConsumers: [],
          })
        }
      }

      // Display results.
      this.log('\nAPEX CONTRACT GUARD')
      this.log('==================')

      this.log('\nBASELINE COMPARISON')
      this.log('-------------------')

      if (changes.length === 0) {
        this.log('No Apex contract changes detected.')
      }

      for (const change of changes) {
        this.log(`\n[${change.severity}] ${change.message}`)

        if (change.affectedConsumers.length > 0) {
          this.log('  Affected LWC consumers:')

          for (const consumer of change.affectedConsumers) {
            this.log(`    - ${consumer}`)
          }
        }
      }

      this.log('\nLWC CONSUMER COMPARISON')
      this.log('-----------------------')

      if (consumerChanges.length === 0) {
        this.log('No LWC consumer changes detected.')
      } else {
        for (const consumerChange of consumerChanges) {
          this.log(consumerChange)
        }
      }

     const apexBreaking = changes.filter(
  change => change.severity === 'BREAKING',
).length

const lwcBreaking = consumerChanges.filter(
  change => change.startsWith('[BREAKING]'),
).length

const breaking = apexBreaking + lwcBreaking

      const potential = changes.filter(
        change => change.severity === 'POTENTIALLY BREAKING',
      ).length

      const safe = changes.filter(
        change => change.severity === 'SAFE',
      ).length

      this.log('\nSUMMARY')
this.log('-------')
this.log(`Breaking changes: ${breaking}`)
this.log(`Apex breaking changes: ${apexBreaking}`)
this.log(`LWC invocation errors: ${lwcBreaking}`)
this.log(`Potentially breaking: ${potential}`)
this.log(`Safe changes: ${safe}`)
this.log(`LWC consumer changes: ${consumerChanges.length}`)
    } catch (error) {
      this.error(
        `Comparison failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}
