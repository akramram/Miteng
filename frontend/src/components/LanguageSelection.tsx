import React, { useState } from 'react';
import { AlertTriangle, Globe, Info, Languages, Pin, PinOff, X } from 'lucide-react';
import Analytics from '@/lib/analytics';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useApplyTranscriptionLanguage } from '@/hooks/useApplyTranscriptionLanguage';

export interface Language {
  code: string;
  name: string;
}

// ISO 639-1 language codes supported by Whisper
export const LANGUAGES: Language[] = [
  { code: 'auto', name: 'Auto Detect (Original Language)' },
  { code: 'auto-translate', name: 'Auto Detect (Translate to English)' },
  { code: 'en', name: 'English' },
  { code: 'zh', name: 'Chinese' },
  { code: 'de', name: 'German' },
  { code: 'es', name: 'Spanish' },
  { code: 'ru', name: 'Russian' },
  { code: 'ko', name: 'Korean' },
  { code: 'fr', name: 'French' },
  { code: 'ja', name: 'Japanese' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'tr', name: 'Turkish' },
  { code: 'pl', name: 'Polish' },
  { code: 'ca', name: 'Catalan' },
  { code: 'nl', name: 'Dutch' },
  { code: 'ar', name: 'Arabic' },
  { code: 'sv', name: 'Swedish' },
  { code: 'it', name: 'Italian' },
  { code: 'id', name: 'Indonesian' },
  { code: 'hi', name: 'Hindi' },
  { code: 'fi', name: 'Finnish' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'he', name: 'Hebrew' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'el', name: 'Greek' },
  { code: 'ms', name: 'Malay' },
  { code: 'cs', name: 'Czech' },
  { code: 'ro', name: 'Romanian' },
  { code: 'da', name: 'Danish' },
  { code: 'hu', name: 'Hungarian' },
  { code: 'ta', name: 'Tamil' },
  { code: 'no', name: 'Norwegian' },
  { code: 'th', name: 'Thai' },
  { code: 'ur', name: 'Urdu' },
  { code: 'hr', name: 'Croatian' },
  { code: 'bg', name: 'Bulgarian' },
  { code: 'lt', name: 'Lithuanian' },
  { code: 'la', name: 'Latin' },
  { code: 'mi', name: 'Maori' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'cy', name: 'Welsh' },
  { code: 'sk', name: 'Slovak' },
  { code: 'te', name: 'Telugu' },
  { code: 'fa', name: 'Persian' },
  { code: 'lv', name: 'Latvian' },
  { code: 'bn', name: 'Bengali' },
  { code: 'sr', name: 'Serbian' },
  { code: 'az', name: 'Azerbaijani' },
  { code: 'sl', name: 'Slovenian' },
  { code: 'kn', name: 'Kannada' },
  { code: 'et', name: 'Estonian' },
  { code: 'mk', name: 'Macedonian' },
  { code: 'br', name: 'Breton' },
  { code: 'eu', name: 'Basque' },
  { code: 'is', name: 'Icelandic' },
  { code: 'hy', name: 'Armenian' },
  { code: 'ne', name: 'Nepali' },
  { code: 'mn', name: 'Mongolian' },
  { code: 'bs', name: 'Bosnian' },
  { code: 'kk', name: 'Kazakh' },
  { code: 'sq', name: 'Albanian' },
  { code: 'sw', name: 'Swahili' },
  { code: 'gl', name: 'Galician' },
  { code: 'mr', name: 'Marathi' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'si', name: 'Sinhala' },
  { code: 'km', name: 'Khmer' },
  { code: 'sn', name: 'Shona' },
  { code: 'yo', name: 'Yoruba' },
  { code: 'so', name: 'Somali' },
  { code: 'af', name: 'Afrikaans' },
  { code: 'oc', name: 'Occitan' },
  { code: 'ka', name: 'Georgian' },
  { code: 'be', name: 'Belarusian' },
  { code: 'tg', name: 'Tajik' },
  { code: 'sd', name: 'Sindhi' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'am', name: 'Amharic' },
  { code: 'yi', name: 'Yiddish' },
  { code: 'lo', name: 'Lao' },
  { code: 'uz', name: 'Uzbek' },
  { code: 'fo', name: 'Faroese' },
  { code: 'ht', name: 'Haitian Creole' },
  { code: 'ps', name: 'Pashto' },
  { code: 'tk', name: 'Turkmen' },
  { code: 'nn', name: 'Norwegian Nynorsk' },
  { code: 'mt', name: 'Maltese' },
  { code: 'sa', name: 'Sanskrit' },
  { code: 'lb', name: 'Luxembourgish' },
  { code: 'my', name: 'Myanmar' },
  { code: 'bo', name: 'Tibetan' },
  { code: 'tl', name: 'Tagalog' },
  { code: 'mg', name: 'Malagasy' },
  { code: 'as', name: 'Assamese' },
  { code: 'tt', name: 'Tatar' },
  { code: 'haw', name: 'Hawaiian' },
  { code: 'ln', name: 'Lingala' },
  { code: 'ha', name: 'Hausa' },
  { code: 'ba', name: 'Bashkir' },
  { code: 'jw', name: 'Javanese' },
  { code: 'su', name: 'Sundanese' },
];

const PINNED_KEY = 'transcriptionLanguagePins';

function readPinned(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((code): code is string => LANGUAGES.some(l => l.code === code)) : [];
  } catch {
    return [];
  }
}

interface LanguageSelectionProps {
  selectedLanguage: string;
  onLanguageChange: (language: string) => void;
  disabled?: boolean;
}

export function LanguageSelection({
  selectedLanguage,
  onLanguageChange,
  disabled = false,
}: LanguageSelectionProps) {
  const [saving, setSaving] = useState(false);
  const [pinned, setPinned] = useState<string[]>(readPinned);
  const pinnedLanguages = pinned.flatMap(code => LANGUAGES.filter(l => l.code === code));
  const isPinned = pinned.includes(selectedLanguage);

  const togglePin = (code: string) => {
    const next = pinned.includes(code) ? pinned.filter(c => c !== code) : [...pinned, code];
    setPinned(next);
    localStorage.setItem(PINNED_KEY, JSON.stringify(next));
  };
  const { applyLanguage, switchWhisperModel, liveModelCannotTranslate } = useApplyTranscriptionLanguage();
  const { transcriptModelConfig } = useConfig();
  const isParakeet = transcriptModelConfig.provider === 'parakeet';

  const handleLanguageChange = async (languageCode: string) => {
    setSaving(true);
    try {
      if (!(await applyLanguage(languageCode))) return;
      onLanguageChange(languageCode);
      console.log('Language preference saved:', languageCode);

      // Track language selection analytics
      const selectedLang = LANGUAGES.find(lang => lang.code === languageCode);
      await Analytics.track('language_selected', {
        language_code: languageCode,
        language_name: selectedLang?.name || 'Unknown',
        is_auto_detect: (languageCode === 'auto').toString(),
        is_auto_translate: (languageCode === 'auto-translate').toString()
      });

      // Show success toast
      const languageName = selectedLang?.name || languageCode;
      toast.success("Language preference saved", {
        description: `Transcription language set to ${languageName}`
      });
    } catch (error) {
      console.error('Failed to save language preference:', error);
      toast.error("Failed to save language preference", {
        description: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSaving(false);
    }
  };

  // Find the selected language name for display
  const selectedLanguageName = LANGUAGES.find(
    lang => lang.code === selectedLanguage
  )?.name || 'Auto Detect (Original Language)';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-af-text-2" />
          <h4 className="text-sm font-medium text-af-text">Transcription Language</h4>
        </div>
      </div>

      <div className="space-y-2">
        {pinnedLanguages.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="Pinned languages">
            {pinnedLanguages.map((language) => (
              <span
                key={language.code}
                className={`inline-flex items-center rounded-full text-xs ring-1 ring-inset ${
                  language.code === selectedLanguage
                    ? 'bg-af-accent/15 text-af-text ring-af-accent/50'
                    : 'bg-af-panel-2 text-af-text-2 ring-af-border'
                }`}
              >
                <button
                  type="button"
                  disabled={disabled || saving}
                  onClick={() => language.code !== selectedLanguage && handleLanguageChange(language.code)}
                  className="py-1 pl-2.5 pr-1 font-medium hover:text-af-text disabled:opacity-50"
                >
                  {language.name}
                </button>
                <button
                  type="button"
                  aria-label={`Unpin ${language.name}`}
                  onClick={() => togglePin(language.code)}
                  className="rounded-full p-1 pr-1.5 text-af-text-4 hover:text-af-text"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Select value={selectedLanguage} onValueChange={handleLanguageChange} disabled={disabled || saving}>
            <SelectTrigger aria-label="Transcription language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pinnedLanguages.length > 0 && (
                <>
                  <SelectGroup>
                    <SelectLabel>Pinned</SelectLabel>
                    {pinnedLanguages.map((language) => (
                      <SelectItem key={language.code} value={language.code}>
                        {language.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectSeparator />
                </>
              )}
              {LANGUAGES.filter(l => !pinned.includes(l.code)).map((language) => (
                <SelectItem key={language.code} value={language.code}>
                  {language.name}
                  {language.code !== 'auto' && language.code !== 'auto-translate' && (
                    <span className="ml-1.5 text-af-text-4">{language.code}</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => togglePin(selectedLanguage)}
            aria-label={isPinned ? 'Unpin this language' : 'Pin this language'}
            title={isPinned ? 'Unpin this language' : 'Pin this language'}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-af-text-2 ring-1 ring-inset ring-af-border hover:bg-af-hover hover:text-af-text"
          >
            {isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
        </div>

        {/* Parakeet language limitation warning */}
        {isParakeet && (
          <div className="flex gap-2.5 rounded-lg border border-af-border bg-af-panel-2 px-3 py-2.5 text-xs text-af-text-2">
            <Info className="mt-px h-4 w-4 shrink-0 text-af-text-3" />
            <div>
              <p className="font-medium text-af-text">Parakeet can't be set to one language</p>
              <p className="mt-0.5">Picking another language switches live transcription to an installed multilingual Whisper model.</p>
            </div>
          </div>
        )}

        {/* Info text */}
        <div className="text-xs space-y-2 pt-2">
          <p className="text-af-text-2">
            <strong>Current:</strong> {selectedLanguageName}
          </p>
          {selectedLanguage === 'auto' && (
            <div className="flex gap-2.5 rounded-lg border border-af-warning/35 bg-af-warning/10 px-3 py-2.5 text-af-text-2">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-af-warning" />
              <div>
                <p className="font-medium text-af-text">Auto detect can pick the wrong language</p>
                <p className="mt-0.5">For the best accuracy, choose the language people speak.</p>
              </div>
            </div>
          )}
          {selectedLanguage === 'auto-translate' && !liveModelCannotTranslate && (
            <div className="flex gap-2.5 rounded-lg border border-af-accent/35 bg-af-accent/10 px-3 py-2.5 text-af-text-2">
              <Languages className="mt-px h-4 w-4 shrink-0 text-af-accent" />
              <div>
                <p className="font-medium text-af-text">Transcripts are translated to English</p>
                <p className="mt-0.5">Useful for meetings in several languages when you want English notes.</p>
              </div>
            </div>
          )}
          {selectedLanguage === 'auto-translate' && liveModelCannotTranslate && (
            <div className="flex gap-2.5 rounded-lg border border-af-warning/35 bg-af-warning/10 px-3 py-2.5 text-af-text-2">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-af-warning" />
              <div>
                <p className="font-medium text-af-text">The live model can't translate</p>
                <p className="mt-0.5">
                  {isParakeet ? 'Parakeet' : transcriptModelConfig.model} transcribes in the original language. Translation needs Whisper Medium, Small, Large v3 or Base.
                </p>
                <button
                  type="button"
                  disabled={disabled || saving}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      if (!(await switchWhisperModel(true))) {
                        toast.warning('Download a Whisper model that can translate', {
                          description: 'Install Whisper Medium or Small in Settings → Speech model.',
                        });
                      }
                    } catch (error) {
                      toast.error('Could not switch the live model', { description: String(error) });
                    } finally {
                      setSaving(false);
                    }
                  }}
                  className="mt-2 rounded-md bg-af-panel-2 px-2.5 py-1 text-xs font-medium text-af-text ring-1 ring-inset ring-af-border hover:bg-af-hover disabled:opacity-50"
                >
                  Use a model that translates
                </button>
              </div>
            </div>
          )}
          {selectedLanguage !== 'auto' && selectedLanguage !== 'auto-translate' && (
            <p className="text-af-text-2">
              Transcription will be optimized for <strong>{selectedLanguageName}</strong>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
