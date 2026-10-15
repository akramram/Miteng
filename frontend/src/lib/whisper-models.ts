/**
 * What a Whisper model can do, from its name (`base-q5_1`, `large-v3-turbo`, …).
 */

/**
 * Whisper translates to English with its `translate` task, but `.en` models
 * only know English and the Large v3 Turbo models were not trained for
 * translation: they silently transcribe in the original language instead.
 */
export function canTranslate(name: string): boolean {
  return !name.endsWith('.en') && !name.includes('turbo');
}

/** Preferred order for live translation: accuracy that still keeps up on a laptop. */
const TRANSLATION_PREFERENCE = ['medium', 'small', 'large-v3', 'large-v2', 'large-v1', 'large', 'base', 'tiny'];

/** The best installed model for translating, or undefined if none can. */
export function pickTranslationModel(installed: string[]): string | undefined {
  const rank = (name: string) => {
    const index = TRANSLATION_PREFERENCE.findIndex((family) => name === family || name.startsWith(`${family}-`));
    return index === -1 ? TRANSLATION_PREFERENCE.length : index;
  };
  return installed.filter(canTranslate).sort((a, b) => rank(a) - rank(b))[0];
}
