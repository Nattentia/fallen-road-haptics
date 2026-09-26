import {
  CONTACT_CHARACTERS,
  type ContactCharacter,
  type Hint,
  type MaterialField,
  type Question,
} from './contract';

/**
 * The questions the live decision model is asked. They are about the
 * meaning of the description only (material and kind of contact); size,
 * outcome and timing are never asked (v4 4). Ordered scales are asked as
 * `choice` questions, which the model answers more reliably than `score`.
 *
 * The exact wording is tokenized ahead of time (tools/laya), so changing a
 * prompt or option means regenerating tools/laya/vocabulary.json.
 */

type Scale = {
  question: Question;
  field: MaterialField;
  /** Material value for each option, in option order. */
  values: readonly number[];
};

type Character = {
  question: Question;
  field: 'contact';
  values: readonly ContactCharacter[];
};

export type LiveQuestion = Scale | Character;

const scale = (
  field: MaterialField,
  prompt: string,
  options: string[]
): Scale => ({
  question: { id: field, kind: 'choice', prompt, options },
  field,
  values: options.map((_, i) => i / (options.length - 1)),
});

export const LIVE_QUESTIONS: readonly LiveQuestion[] = [
  scale('hardness', 'How hard is what is touched?', [
    'very soft',
    'soft',
    'medium',
    'hard',
    'very hard',
  ]),
  scale('weight', 'How heavy is what is touched or what strikes?', [
    'very light',
    'light',
    'medium',
    'heavy',
    'very heavy',
  ]),
  scale('roughness', 'How rough does the contact feel?', [
    'smooth',
    'slightly rough',
    'rough',
    'very rough',
    'jagged',
  ]),
  {
    question: {
      id: 'contact',
      kind: 'choice',
      prompt: 'What kind of contact is this?',
      options: [
        'a sharp edge slices',
        'a point pierces',
        'a heavy mass crushes',
        'a surface scrapes along',
        'something fragile shatters',
      ],
    },
    field: 'contact',
    values: CONTACT_CHARACTERS,
  },
];

/** 1 − normalized entropy: how decided the answer is (0..1). */
export const decidedness = (p: readonly number[]): number => {
  const k = p.length;
  if (k < 2) return 1;
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log(x);
  return Math.min(1, Math.max(0, 1 - h / Math.log(k)));
};

/**
 * Turns the model's probabilities for one question into a hint. Scales take
 * the expected value; the contact character takes the most likely option.
 * `confidence` is the raw decidedness; calibration (stage 4) adjusts it.
 */
export const toHint = (
  q: LiveQuestion,
  voice: string,
  probabilities: readonly number[],
  latencyMs: number
): Hint | null => {
  if (probabilities.length !== q.values.length) return null;
  const confidence = decidedness(probabilities);
  const base = { voice, questionId: q.question.id, confidence, latencyMs };
  if (q.field === 'contact') {
    let best = 0;
    probabilities.forEach((p, i) => {
      if (p > probabilities[best]!) best = i;
    });
    return { ...base, field: 'contact', value: q.values[best]! };
  }
  const value = probabilities.reduce((sum, p, i) => sum + p * q.values[i]!, 0);
  return { ...base, field: q.field, value };
};
