// Loads the compiled course and caches audio for offline use.

import { clipUrl } from '../audio/player';
import type { CourseIndex, Lesson, Module, Word } from '../types';

export const AUDIO_CACHE = 'bdl-audio-v1';
const DOWNLOADED_KEY = 'bdl.downloaded';

export class Course {
  private modules = new Map<string, Module>();
  private wordIndex = new Map<string, { word: Word; lessonId: string }>();

  constructor(readonly index: CourseIndex) {}

  static async load(): Promise<Course> {
    const res = await fetch('course/index.json');
    if (!res.ok) throw new Error(`course index: ${res.status}`);
    return new Course((await res.json()) as CourseIndex);
  }

  /** All lesson ids in course order. */
  get lessonIds(): string[] {
    return this.index.modules.flatMap((m) => m.lessons.map((l) => l.id));
  }

  moduleOf(lessonId: string): string {
    return lessonId.slice(0, 3);
  }

  lessonSummary(lessonId: string) {
    const m = this.index.modules.find((x) => x.id === this.moduleOf(lessonId));
    const l = m?.lessons.find((x) => x.id === lessonId);
    return m && l ? { module: m, lesson: l, number: m.lessons.indexOf(l) + 1 } : null;
  }

  async module(id: string): Promise<Module> {
    let m = this.modules.get(id);
    if (!m) {
      const res = await fetch(`course/${id}.json`);
      if (!res.ok) throw new Error(`module ${id}: ${res.status}`);
      m = (await res.json()) as Module;
      this.modules.set(id, m);
      for (const l of m.lessons) for (const w of [...l.words, ...l.phrases]) this.wordIndex.set(w.id, { word: w, lessonId: l.id });
    }
    return m;
  }

  async lesson(id: string): Promise<Lesson> {
    const m = await this.module(this.moduleOf(id));
    const l = m.lessons.find((x) => x.id === id);
    if (!l) throw new Error(`lesson ${id} not found`);
    return l;
  }

  /** Loads the modules needed to resolve the given word ids and returns the words. */
  async words(ids: string[], hintModules: string[] = []): Promise<Word[]> {
    const missing = ids.filter((id) => !this.wordIndex.has(id));
    if (missing.length) {
      const toLoad = hintModules.length ? hintModules : this.index.modules.map((m) => m.id);
      for (const mid of toLoad) {
        if (!missing.some((id) => !this.wordIndex.has(id))) break;
        try {
          await this.module(mid);
        } catch {
          /* offline and not cached */
        }
      }
    }
    return ids.map((id) => this.wordIndex.get(id)?.word).filter((w): w is Word => !!w);
  }

  /** Words from all loaded modules (used for distractors). */
  loadedWords(): Word[] {
    return [...this.wordIndex.values()].map((x) => x.word);
  }

  lessonOfWord(id: string): string | undefined {
    return this.wordIndex.get(id)?.lessonId;
  }

  // ---- Audio downloads ----------------------------------------------------------

  isDownloaded(moduleId: string): boolean {
    return downloaded().includes(`${moduleId}@${this.index.version}`) || downloaded().includes(`${moduleId}@*`);
  }

  /**
   * Makes sure all clips of a module (or 'core') are in the cache.
   * Resolves false if something could not be downloaded.
   */
  async download(moduleId: string | 'core', onProgress?: (done: number, total: number) => void): Promise<boolean> {
    const clips = moduleId === 'core' ? this.index.coreClips : (this.index.modules.find((m) => m.id === moduleId)?.clips ?? []);
    const ok = await cacheClips(clips, onProgress);
    if (ok) markDownloaded(`${moduleId}@${this.index.version}`);
    return ok;
  }
}

function downloaded(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DOWNLOADED_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function markDownloaded(tag: string): void {
  const list = downloaded().filter((t) => t.split('@')[0] !== tag.split('@')[0]);
  list.push(tag);
  try {
    localStorage.setItem(DOWNLOADED_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export async function cacheClips(clips: string[], onProgress?: (done: number, total: number) => void): Promise<boolean> {
  if (!('caches' in window)) return navigator.onLine;
  const cache = await caches.open(AUDIO_CACHE);
  const urls = clips.map(clipUrl);
  let done = 0;
  let failed = 0;
  const queue = [...urls];
  const worker = async () => {
    for (;;) {
      const url = queue.shift();
      if (!url) return;
      try {
        const hit = await cache.match(url);
        if (!hit) {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res);
          else failed++;
        }
      } catch {
        failed++;
      }
      done++;
      if (done % 20 === 0 || done === urls.length) onProgress?.(done, urls.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return failed === 0;
}
