'use server';
/**
 * @fileOverview AI agent that evaluates the transcribed user speech and compares it to previously stored voice messages in order to verify user's condition.
 *
 * - assessVoiceCheckIn - A function that handles the voice check-in assessment process.
 * - AssessVoiceCheckInInput - The input type for the assessVoiceCheckIn function.
 * - AssessVoiceCheckInOutput - The return type for the assessVoiceCheckIn function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const AssessVoiceCheckInInputSchema = z.object({
  transcribedSpeech: z.string().describe('The transcribed speech from the user voice check-in.'),
  previousVoiceMessages: z.array(z.string()).describe('An array of previously stored voice messages from the user.'),
});
export type AssessVoiceCheckInInput = z.infer<typeof AssessVoiceCheckInInputSchema>;

const AssessVoiceCheckInOutputSchema = z.object({
  anomalyDetected: z.boolean().describe('Whether or not an anomaly was detected in the user\'s voice.'),
  explanation: z.string().describe('An explanation of the anomaly, if any.'),
});
export type AssessVoiceCheckInOutput = z.infer<typeof AssessVoiceCheckInOutputSchema>;

export async function assessVoiceCheckIn(input: AssessVoiceCheckInInput): Promise<AssessVoiceCheckInOutput> {
  return assessVoiceCheckInFlow(input);
}

const prompt = ai.definePrompt({
  name: 'assessVoiceCheckInPrompt',
  input: {schema: AssessVoiceCheckInInputSchema},
  output: {schema: AssessVoiceCheckInOutputSchema},
  prompt: `You are an AI assistant specializing in behavioral biometrics, particularly voice analysis.

You will analyze the transcribed speech from the user's voice check-in and compare it to their previously stored voice messages.

Based on the speech rate, cadence, typical phrases, and other voice characteristics, you will determine if there are any noticeable anomalies that indicate the user might not be okay.

Transcribed Speech: {{{transcribedSpeech}}}
Previous Voice Messages: {{#each previousVoiceMessages}}- {{{this}}}\n{{/each}}

Consider the following:
- Significant changes in speech rate (faster or slower than usual).
- Unusual pauses or hesitations.
- Use of atypical phrases or vocabulary.
- Emotional tone (e.g., unusually subdued or agitated).

Based on this analysis, determine if an anomaly is detected and provide an explanation.

Output your findings in JSON format.
`,
});

const assessVoiceCheckInFlow = ai.defineFlow(
  {
    name: 'assessVoiceCheckInFlow',
    inputSchema: AssessVoiceCheckInInputSchema,
    outputSchema: AssessVoiceCheckInOutputSchema,
  },
  async input => {
    const {output} = await prompt(input);
    return output!;
  }
);
