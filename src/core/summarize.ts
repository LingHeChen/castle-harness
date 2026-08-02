import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { flattenTranscript, type Summarizer } from "./context";

const SUMMARY_SYSTEM = `You compress an AI coding agent's earlier work into a dense
briefing so it can keep going without the original detail. Preserve, tersely:
- the goal and what has been tried
- key file paths and code locations discovered
- concrete findings, decisions, and their rationale
- what is still open or in progress
Drop pleasantries and raw tool dumps. Output only the briefing.`;

/**
 * A {@link Summarizer} backed by a real model call. The slice is flattened to a
 * plain-text transcript first, so this summarization request never has to honor
 * tool-call/result pairing — it's just text in, text out.
 */
export function createSummarizer(model: LanguageModel): Summarizer {
  return async (messages: ModelMessage[]): Promise<string> => {
    const transcript = flattenTranscript(messages);
    const res = await generateText({
      model,
      system: SUMMARY_SYSTEM,
      prompt: `Compress this earlier portion of the session:\n\n${transcript}`,
    });
    return res.text.trim();
  };
}
