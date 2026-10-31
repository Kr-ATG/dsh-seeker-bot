/**
 * dsh-seeker-bot — 工作区实时回显模块出口。
 *
 * @module
 */

export { KrEchoViewport } from './KrEchoViewport.tsx'
export type { KrEchoViewportProps } from './KrEchoViewport.tsx'
export { KrEchoModal } from './KrEchoModal.tsx'
export type { KrEchoModalProps } from './KrEchoModal.tsx'
export { fetchEchoFrame, fetchEchoSpaceFrame, ECHO_VIEWPORT_FRAME_ROUTE, ECHO_VIEWPORT_SPACE_ROUTE } from './api.ts'
export type {
  EchoFrameResult,
  EchoFrameSuccess,
  EchoFrameError,
  EchoSpaceFrameResult,
  EchoSpaceFrameSuccess,
  EchoSpaceFrameError,
  FetchEchoFrameOptions,
  FetchEchoSpaceFrameOptions,
} from './api.ts'
export { collectWorkspaceHints, mergeWorkspaceHints, extractWorkspaceHints } from './workspace-hint.ts'
export { echoViewportStyles } from './styles.ts'
