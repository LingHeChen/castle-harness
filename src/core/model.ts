import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export type ModelConfig = {
  model: string;
  apiKey: string;
  baseURL: string;
};

/**
 * Resolve the model configuration from the environment. Bun auto-loads `.env`,
 * so `DEEPSEEK_API_KEY` there is picked up without any dotenv dependency.
 */
export function resolveModelConfig(overrideModel?: string): ModelConfig {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add your key.",
    );
  }
  return {
    model: overrideModel ?? process.env.CASTLE_MODEL ?? "deepseek-chat",
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
  };
}

/**
 * DeepSeek exposes an OpenAI-compatible API, but only the Chat Completions
 * surface — not the newer Responses API that `openai(modelId)` defaults to.
 * We must go through `.chat()` explicitly.
 */
export function createModel(cfg: ModelConfig): LanguageModel {
  const provider = createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  return provider.chat(cfg.model);
}
