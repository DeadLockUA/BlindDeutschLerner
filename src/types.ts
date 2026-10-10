// Types of the compiled course data (produced by scripts/build-content.mjs).

/** An utterance: display text plus the audio clips that speak it, in order. */
export interface Utt {
  t: string;
  c: string[];
}

export interface Word {
  id: string;
  kind: 'word' | 'phrase';
  /** German, male voice. */
  de: Utt;
  /** German, female voice. */
  deF: Utt;
  ru: Utt;
  plural?: Utt;
  ex?: Utt;
  exRu?: Utt;
}

/** A multiple-choice question. The first option is always the correct one. */
export interface Choice {
  q: Utt;
  options: Utt[];
}

export interface DialogueLine {
  who: string;
  de: Utt;
  ru: Utt;
}

export interface Dialogue {
  title: Utt;
  lines: DialogueLine[];
  questions: Choice[];
}

export interface Grammar {
  title: Utt;
  explain: Utt[];
  exercises: Choice[];
}

export interface Lesson {
  id: string;
  title: Utt;
  intro?: Utt;
  words: Word[];
  phrases: Word[];
  grammar?: Grammar;
  dialogues: Dialogue[];
}

export interface Module {
  id: string;
  title: Utt;
  exam?: boolean;
  lessons: Lesson[];
}

export interface ModuleSummary {
  id: string;
  title: Utt;
  exam?: boolean;
  lessons: { id: string; title: Utt }[];
  /** All clip ids needed for the module. */
  clips: string[];
  bytes: number;
}

export interface CourseIndex {
  version: string;
  modules: ModuleSummary[];
  prompts: Record<string, Utt>;
  /** Clips needed by the app shell (prompts, numbers). */
  coreClips: string[];
  coreBytes: number;
}
