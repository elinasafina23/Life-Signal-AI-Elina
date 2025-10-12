"use server";

import { ai } from "@/ai/genkit";
import { z } from "genkit";

const AskAiAssistantInputSchema = z.object({
  question: z
    .string()
    .min(1, { message: "Question is required." })
    .describe("The user's question for the assistant."),
});
export type AskAiAssistantInput = z.infer<typeof AskAiAssistantInputSchema>;

const AskAiAssistantOutputSchema = z.object({
  answer: z
    .string()
    .min(1, { message: "Assistant responses must contain text." })
    .describe("A conversational yet concise answer for the user."),
  mood: z
    .string()
    .min(1, { message: "Mood labels are required." })
    .describe("A single-word or short phrase summarizing the user's mental state."),
  moodDescription: z
    .string()
    .optional()
    .describe("A brief description of the tone analysis to share with emergency contacts."),
});
export type AskAiAssistantOutput = z.infer<typeof AskAiAssistantOutputSchema>;

export async function runAskAiAssistant(input: AskAiAssistantInput): Promise<AskAiAssistantOutput> {
  return askAiAssistantFlow(input);
}

const askAiAssistantPrompt = ai.definePrompt({
  name: "askAiAssistantPrompt",
  input: { schema: AskAiAssistantInputSchema },
  output: { schema: AskAiAssistantOutputSchema },
  prompt: `You are a compassionate wellbeing assistant that helps users with safety and emotional support questions.

For the given user question, craft a clear answer in a friendly tone. Keep the answer between 3 and 6 sentences.

Also assess the emotional tone conveyed in the user's question. Infer their current mood using a short label (for example: "calm", "anxious", "overwhelmed", "optimistic"). Provide a one-sentence explanation of your reasoning using neutral language suitable for sharing with their emergency contacts.

Respond strictly in JSON with the following shape:
{
  "answer": string, // assistant reply for the user
  "mood": string,   // the short label for their mental state
  "moodDescription"?: string // optional short explanation
}

User question: {{{question}}}
`,
});

const askAiAssistantFlow = ai.defineFlow(
  {
    name: "askAiAssistantFlow",
    inputSchema: AskAiAssistantInputSchema,
    outputSchema: AskAiAssistantOutputSchema,
  },
  async (input) => {
    const { output } = await askAiAssistantPrompt(input);
    return output!;
  },
);