/**
 * Utility to detect whether a model string refers to an OpenAI model
 * (as opposed to an Anthropic Claude model).
 *
 * This enables mixed-provider mode: users keep their Anthropic setup
 * but can select OpenAI models via --model or ANTHROPIC_MODEL.
 */

const OPENAI_MODEL_PREFIXES = [
  'gpt-',
  'o1',
  'o3',
  'o4',
  'chatgpt-',
  'codex-',
  'davinci',
  'text-',
]

export function isOpenAIModel(model: string): boolean {
  const lower = model.toLowerCase()
  return OPENAI_MODEL_PREFIXES.some(prefix => lower.startsWith(prefix))
}
