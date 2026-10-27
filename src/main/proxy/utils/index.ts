/**
 * Utils Module - Export all utility functions for tool calling
 */

export * from './tools'
// 新的统一工具解析模块
export * from './toolParser/index'
// 旧的 streamToolHandler 只补充统一解析模块没有的名字，避免同名导出冲突
export { createToolCallState, processStreamContent, createBaseChunk } from './streamToolHandler'
export type { ToolCallState } from './streamToolHandler'
