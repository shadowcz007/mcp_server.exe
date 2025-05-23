import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  McpServer,
  type ResourceMetadata
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  Implementation,
  Tool,
  CallToolResult,
  Resource,
  Prompt
} from '@modelcontextprotocol/sdk/types.js'
import {
  SSEClientTransport,
  type SSEClientTransportOptions
} from '@modelcontextprotocol/sdk/client/sse.js'
import {
  StdioClientTransport,
  type StdioServerParameters
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { jsonSchemaToZod } from './utils/schemaConverter'
import { formatLog } from './utils/console'

const NAMESPACE_SEPARATOR = '::'

type ConnectionConfig =
  | {
      type: 'sse'
      url: URL
      params: SSEClientTransportOptions
      tools: string[]
      name: string
    }
  | {
      type: 'stdio'
      params: StdioServerParameters
      tools: string[]
      name: string
    }

interface ToolChainStep {
  toolName: string
  args: any
  outputMapping?: {
    [key: string]: string // 将当前步骤的输出映射到下一个步骤的输入
  }
  fromStep?: number
}

interface ToolChainOutput {
  steps?: number[] // 指定要输出的步骤索引，如果为空则输出所有步骤
  final?: boolean // 是否只输出最后一步
}

interface ToolChain {
  name: string
  steps: ToolChainStep[]
  description?: string
  output?: ToolChainOutput // 添加输出配置
}

export class McpServerComposer {
  public readonly server: McpServer
  public namespace: string = NAMESPACE_SEPARATOR
  private readonly targetClients: Map<
    string,
    {
      clientInfo: Implementation
      config: ConnectionConfig
    }
  > = new Map()
  private readonly clientTools: Map<string, Set<string>> = new Map()

  constructor (serverInfo: Implementation) {
    this.server = new McpServer(serverInfo)
  }

  async add (
    config: ConnectionConfig,
    clientInfo: Implementation,
    skipRegister = false,
    retryCount = 0
  ): Promise<void> {
    const targetClient = new Client(clientInfo)
    const transport =
      config.type === 'sse'
        ? new SSEClientTransport(config.url)
        : new StdioClientTransport(config.params)

    try {
      await targetClient.connect(transport)
    } catch (error) {
      if (retryCount >= 2) {
        formatLog(
          'ERROR',
          `Connection failed after 2 retries: ${
            config.type === 'sse' ? config.url : config.params.command
          } -> ${clientInfo.name}\n` +
            `Reason: ${(error as Error).message}\n` +
            `Skipping connection...`
        )
        return
      }

      formatLog(
        'ERROR',
        `Connection failed: ${
          config.type === 'sse' ? config.url : config.params.command
        } -> ${clientInfo.name}\n` +
          `Reason: ${(error as Error).message}\n` +
          `Will retry in 15 seconds... (Attempt ${retryCount + 1}/2)`
      )

      // If the connection fails, retry after 15 seconds
      return new Promise(resolve => {
        setTimeout(() => {
          resolve(this.add(config, clientInfo, skipRegister, retryCount + 1))
        }, 15000)
      })
    }

    formatLog(
      'INFO',
      `Successfully connected to server: ${
        config.type === 'sse' ? config.url : config.params.command
      } (${clientInfo.name})`
    )

    const name = config.name

    this.targetClients.set(name, { clientInfo, config })

    if (skipRegister) {
      formatLog('INFO', `Skipping capability registration: ${name}`)
      return
    }

    const capabilities = await targetClient.getServerCapabilities()

    formatLog(
      'INFO',
      `Starting server capability registration: ${name} ${JSON.stringify(
        capabilities,
        null,
        2
      )}`
    )

    if (capabilities?.tools) {
      let tools: any = null
      try {
        tools = await targetClient.listTools()
      } catch (error) {
        console.log('Tool list:::error ',error)
      }
   
      try {
        this.composeTools(tools.tools, name)

        formatLog(
          'INFO',
          `Tool registration completed [${name}]: ${tools.tools.length} tools in total`
        )
      } catch (error) {
        formatLog(
          'ERROR',
          `Tool registration failed: ${name} ${JSON.stringify(error, null, 2)}`
        )
      }
    }

    if (capabilities?.resources) {
      try {
        const resources = await targetClient.listResources()
        this.composeResources(resources.resources, name)

        formatLog(
          'INFO',
          `Resource registration completed [${name}]: ${resources.resources.length} resources in total`
        )
      } catch (error) {
        formatLog(
          'ERROR',
          `Resource registration failed: ${name} ${JSON.stringify(
            error,
            null,
            2
          )}`
        )
      }
    }

    if (capabilities?.prompts) {
      try {
        const prompts = await targetClient.listPrompts()
        this.composePrompts(prompts.prompts, name)

        formatLog(
          'INFO',
          `Prompt registration completed [${name}]: ${prompts.prompts.length} prompts in total`
        )
      } catch (error) {
        formatLog(
          'ERROR',
          `Prompt registration failed: ${name} ${JSON.stringify(
            error,
            null,
            2
          )}`
        )
      }
    }

    formatLog(
      'INFO',
      `All capabilities registration completed for server ${name}`
    )
    targetClient.close()
  }

  composeToolChain (toolChain: ToolChain) {
    this.server.tool(
      toolChain.name,
      toolChain.description ?? 'Execute a chain of tools',
      {},
      async () => {
        const results: any[] = []
        const clientsMap = new Map<string, Client>()

        try {
          for (let i = 0; i < toolChain.steps.length; i++) {
            const step = toolChain.steps[i]

            // 查找所有注册的工具中匹配的工具（支持命名空间和非命名空间）
            let registeredTool
            let foundToolName

            // @ts-ignore
            for (const [name, tool] of Object.entries(
              // @ts-ignore
              this.server._registeredTools
            )) {
              if (
                name === step.toolName ||
                name.endsWith(`${this.namespace}${step.toolName}`)
              ) {
                registeredTool = tool
                foundToolName = name
                break
              }
            }

            if (!registeredTool) {
              throw new Error(`Tool not found: ${step.toolName}`)
            }

            formatLog('DEBUG', `Executing chain step ${i}: ${foundToolName}\n`)

            if (step.outputMapping) {
              const sourceResult =
                step.fromStep !== undefined
                  ? results[step.fromStep]
                  : results[results.length - 1]

              if (sourceResult) {
                for (const [key, path] of Object.entries(step.outputMapping)) {
                  try {
                    const value = this.getNestedValue(sourceResult, path)
                    if (value !== undefined) {
                      step.args[key] = value
                    } else {
                      formatLog(
                        'INFO',
                        `Output mapping path "${path}" returned undefined for step ${i}`
                      )
                    }
                  } catch (error) {
                    formatLog(
                      'ERROR',
                      `Failed to map output for step ${i}: ${error.message}`
                    )
                  }
                }
              }
            }

            let result
            try {
              if (registeredTool.needsClient) {
                let foundClientName: string | undefined

                for (const [clientName, _] of this.targetClients.entries()) {
                  // 使用 clientTools 来判断客户端是否真的支持这个工具
                  const supportedTools = this.clientTools.get(clientName)
                  // 检查完整的命名空间工具名
                  if (supportedTools?.has(foundToolName)) {
                    foundClientName = clientName
                    break
                  }
                }

                if (!foundClientName) {
                  throw new Error(`No client found for tool: ${foundToolName}`)
                }

                // 复用或创建客户端连接
                let client = clientsMap.get(foundClientName)
                if (!client) {
                  const clientItem = this.targetClients.get(foundClientName)
                  if (!clientItem) {
                    throw new Error(
                      `Client configuration not found for: ${foundClientName}`
                    )
                  }
                  client = new Client(clientItem.clientInfo)
                  await client.connect(this.createTransport(clientItem.config))
                  clientsMap.set(foundClientName, client)
                }

                result = await registeredTool.chainExecutor(step.args, client)
              } else {
                // 本地工具直接调用
                result = await registeredTool.callback(step.args)
              }

              // 确保结果不是undefined
              results.push(result || { content: [{ type: 'text', text: '' }] })
            } catch (error) {
              formatLog(
                'ERROR',
                `Step ${i} (${foundToolName}) execution failed: ${error.message}`
              )
              // 在错误时添加一个空结果
              results.push({
                content: [{ type: 'text', text: `Error: ${error.message}` }]
              })
            }
          }

          formatLog('DEBUG', `Chain execution completed`)

          // 处理输出结果时添加安全检查
          let outputResults: any[] = []
          try {
            if (toolChain.output?.final) {
              const finalResult = results[results.length - 1]
              outputResults = finalResult ? [finalResult] : []
            } else if (
              toolChain.output?.steps &&
              toolChain.output.steps.length > 0
            ) {
              outputResults = toolChain.output.steps
                .filter(
                  stepIndex => stepIndex >= 0 && stepIndex < results.length
                )
                .map(stepIndex => results[stepIndex])
                .filter(result => result !== undefined)
            } else {
              outputResults = results.filter(result => result !== undefined)
            }
          } catch (error) {
            formatLog(
              'ERROR',
              `Failed to process output results: ${error.message}`
            )
            outputResults = []
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(outputResults || [])
              }
            ]
          }
        } finally {
          // 关闭所有客户端连接
          for (const client of clientsMap.values()) {
            await client.close()
          }
        }
      }
    )
  }

  private getNestedValue (obj: any, path: string): any {
    try {
      return path.split('.').reduce((current, key) => {
        if (current === undefined || current === null) {
          return undefined
        }
        return current[key]
      }, obj)
    } catch (error) {
      formatLog(
        'ERROR',
        `Failed to get nested value for path "${path}": ${error.message}`
      )
      return undefined
    }
  }

  listTargetClients () {
    return Array.from(this.targetClients.values())
  }

  private createTransport (config: ConnectionConfig) {
    return config.type === 'sse'
      ? new SSEClientTransport(config.url)
      : new StdioClientTransport(config.params)
  }

  private composeTools (tools: Tool[], name: string) {
    if (!Array.isArray(tools)) {
      throw new Error('Tools must be an array')
    }
    if (!name || typeof name !== 'string') {
      throw new Error('Name must be a non-empty string')
    }

    try {
      //@ts-ignore
      const existingTools = this.server._registeredTools
      // 记录这个客户端支持的工具
      const toolSet = new Set<string>()

      for (const tool of tools) {
        try {
          if (!tool.name) {
            throw new Error('Tool name is required')
          }

          // 使用客户端名称作为命名空间
          const namespacedToolName = `${name}${this.namespace}${tool.name}`
          toolSet.add(namespacedToolName)

          if (existingTools[namespacedToolName]) {
            formatLog('INFO', `Tool ${namespacedToolName} already exists, skipping...`)
            continue
          }

          let schemaObject
          try {
            schemaObject = jsonSchemaToZod(tool.inputSchema)
          } catch (error) {
            throw new Error(`Failed to convert schema for tool ${tool.name}: ${error.message}`)
          }

          // 创建工具执行函数
          const toolExecutor = async (args: any, client?: Client) => {
            let needToClose = false
            let toolClient = client

            try {
              if (!toolClient) {
                // 如果没有传入client，说明是直接调用，需要创建新的连接
                const clientItem = this.targetClients.get(name)
                if (!clientItem) {
                  throw new Error(`Client for ${name} not found`)
                }

                toolClient = new Client(clientItem.clientInfo)
                try {
                  await toolClient.connect(this.createTransport(clientItem.config))
                  needToClose = true // 标记需要关闭连接
                } catch (error) {
                  throw new Error(`Failed to connect to client: ${error.message}`)
                }
              }

              formatLog('DEBUG', `Calling tool: ${tool.name} from ${name}\n`)

              try {
                const result = await toolClient.callTool({
                  name: tool.name, // 调用原始工具名
                  arguments: args
                })
                return result as CallToolResult
              } catch (error) {
                throw new Error(`Tool execution failed: ${error.message}`)
              }
            } finally {
              if (needToClose && toolClient) {
                try {
                  await toolClient.close()
                } catch (closeError) {
                  formatLog('ERROR', `Failed to close client connection: ${closeError.message}`)
                }
              }
            }
          }

          try {
            // 注册工具时使用带命名空间的名称
            this.server.tool(
              namespacedToolName,
              `[${name}] ${tool.description ?? ''}`, // 在描述中标明来源
              schemaObject,
              async args => toolExecutor(args)
            )

            // 保存执行函数和标记为需要客户端的工具
            // @ts-ignore
            this.server._registeredTools[namespacedToolName].chainExecutor = toolExecutor
            // @ts-ignore
            this.server._registeredTools[namespacedToolName].needsClient = true
            // 保存原始工具名到元数据中
            // @ts-ignore
            this.server._registeredTools[namespacedToolName].originalName = tool.name

            formatLog('INFO', `Successfully registered tool: ${namespacedToolName}`)
          } catch (error) {
            throw new Error(`Failed to register tool ${namespacedToolName}: ${error.message}`)
          }
        } catch (error) {
          formatLog('ERROR', `Failed to process tool: ${error.message}`)
          throw error // 重新抛出错误以便上层处理
        }
      }

      this.clientTools.set(name, toolSet)
      formatLog('INFO', `Successfully registered ${toolSet.size} tools for ${name}`)
    } catch (error) {
      formatLog('ERROR', `Failed to compose tools: ${error.message}`)
      throw error // 重新抛出错误以便上层处理
    }
  }

  private composeResources (resources: Resource[], name: string) {
    // @ts-ignore
    const existingResources = this.server._registeredResources
    //  console.log(existingResources,resources)
    for (const resource of resources) {
      if (existingResources[resource.uri]) {
        continue
      }
      this.server.resource(
        resource.name,
        resource.uri,
        { description: resource.description, mimeType: resource.mimeType },
        async uri => {
          const clientItem = this.targetClients.get(name)
          if (!clientItem) {
            throw new Error(`Client for ${name} not found`)
          }

          const client = new Client(clientItem.clientInfo)
          await client.connect(this.createTransport(clientItem.config))

          const result = await client.readResource({
            uri: uri.toString(),
            _meta: resource._meta as ResourceMetadata
          })
          await client.close()
          return result
        }
      )
    }
  }

  private composePrompts (prompts: Prompt[], name: string) {
    // @ts-ignore
    const existingPrompts = this.server._registeredPrompts
    for (const prompt of prompts) {
      if (existingPrompts[prompt.name]) {
        continue
      }
      const argsSchema = jsonSchemaToZod(prompt.arguments)
      this.server.prompt(
        prompt.name,
        prompt.description ?? '',
        argsSchema,
        async args => {
          const clientItem = this.targetClients.get(name)
          if (!clientItem) {
            throw new Error(`Client for ${name} not found`)
          }

          const client = new Client(clientItem.clientInfo)
          await client.connect(this.createTransport(clientItem.config))

          const result = await client.getPrompt({
            name: prompt.name,
            arguments: args
          })
          await client.close()
          return result
        }
      )
    }
  }

  private handleTargetServerClose (
    name: string,
    config: ConnectionConfig,
    clientInfo: Implementation
  ) {
    return () => {
      this.targetClients.delete(name)

      formatLog(
        'ERROR',
        `Server connection lost:\n` +
          `- Name: ${name}\n` +
          `- Type: ${config.type}\n` +
          `- Config: ${
            config.type === 'sse' ? config.url : config.params.command
          }\n` +
          `- Client: ${clientInfo.name}\n` +
          `Will try to reconnect in 10 seconds...`
      )

      return this.add(config, clientInfo, true)
    }
  }

  async disconnectAll () {
    for (const client of this.targetClients.keys()) {
      await this.disconnect(client)
    }
  }

  async disconnect (clientName: string) {
    const client = this.targetClients.get(clientName)
    if (client) {
      this.targetClients.delete(clientName)
    }
  }
}
