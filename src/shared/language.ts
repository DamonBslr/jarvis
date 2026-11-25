import type { AppLanguage } from './types'

/** Languages Jarvis can run in. One setting drives replies, transcription and the reply voice. */
export const LANGUAGES: Record<AppLanguage, { label: string; whisper: string }> = {
  en: { label: 'English', whisper: 'en' },
  de: { label: 'Deutsch', whisper: 'de' }
}

export const languageOf = (value: unknown): AppLanguage => (value === 'de' ? 'de' : 'en')

/**
 * Pinned into every run. Without it the model guesses from the transcript, names or retrieved
 * context, and can flip languages mid-chat.
 */
export function languageInstruction(lang: AppLanguage): string {
  const name = lang === 'de' ? 'German (Deutsch)' : 'English'
  return (
    `Reply language: always answer in ${name}. Keep to it even when the user's message, a voice transcript, ` +
    `tool output or retrieved context is in another language, or the user seems to speak another language. ` +
    `Switch only if the user explicitly asks you to answer in a different language. Code, commands and identifiers stay as they are.`
  )
}

/** Piper voices for German replies (rhasspy/piper-voices). */
export const GERMAN_VOICES: { id: string; label: string; mb: number }[] = [
  { id: 'de_DE-thorsten-high', label: 'Thorsten — male, clear (best)', mb: 114 },
  { id: 'de_DE-thorsten-medium', label: 'Thorsten — male, lighter', mb: 63 },
  { id: 'de_DE-kerstin-medium', label: 'Kerstin — female', mb: 63 }
]
export const DEFAULT_GERMAN_VOICE = GERMAN_VOICES[0].id
