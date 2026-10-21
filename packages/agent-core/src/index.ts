// @ai-pro/agent-core — public API.
export { createAgent, sanitizeState, resolveReference, isReference, EMPTY_STATE, DEFAULT_TEXT } from "./agent.ts";
export type { Agent, AgentOptions, AgentText, HandleInput } from "./agent.ts";
export { applyLessons, checkLesson, isGeneric, isNegativeFeedback, isSensitive, parseForget, parseTeaching } from "./learning.ts";
export type { LessonCheck, Teaching } from "./learning.ts";
export { compileTemplate, matchTemplate } from "./templates.ts";
export type { CompiledTemplate, TemplateMatch } from "./templates.ts";
export { cleanValue, fold, foldChar, foldWithMap, originalSpan, tokens } from "./text.ts";
export type { Folded } from "./text.ts";
export type * from "./types.ts";
