import fs from 'node:fs/promises';
import path from 'node:path';

/** Twelve notes: Ukrainian and English, with an `Archive/` subtree. */
export const FIXTURE_NOTES: Readonly<Record<string, string>> = {
  'Пошук у сховищі.md': '',
  'Гібридний пошук.md': [
    '---',
    'type: resource',
    'tags: [search]',
    '---',
    '',
    '# Вступ',
    '',
    'Гібридний пошук поєднує лексичний і семантичний пошук, щоб',
    'знайти точну фразу та близькі за змістом нотатки.',
    '',
    '## Деталі',
    '',
    'Розумний ранкінг враховує заголовки та тіло нотатки.',
    '',
  ].join('\n'),
  'Café notes.md': [
    '# Résumé',
    '',
    'The naïve résumé of a café owner, written once and never revised.',
    '',
    'A second paragraph that mentions nothing special at all.',
    '',
  ].join('\n'),
  'Apostrophes.md': [
    '# Словник',
    '',
    "Об'єкт у сховищі: стандартний апостроф.",
    '',
    'Обʼєкт у каталозі: модифікатор апострофа.',
    '',
    'Об’єкт у реєстрі: права лапка.',
    '',
  ].join('\n'),
  'Code sample.md': [
    '# Snippet',
    '',
    'Нижче приклад з пошуком у коді.',
    '',
    '```ts',
    'const query = "розумний пошук";',
    'search(query);',
    '```',
    '',
    'Після блоку коду йде звичайний абзац.',
    '',
  ].join('\n'),
  'Hard wrapped.md': [
    '# Перенесення',
    '',
    'Це абзац, який жорстко перенесено',
    'на кілька рядків, а фраза розумний',
    'пошук розбита між рядками.',
    '',
  ].join('\n'),
  'Tasks/Release plan.md': [
    '---',
    'type: task',
    '---',
    '',
    '# Release plan',
    '',
    'Ship the hybrid search release after the retrieval review.',
    '',
  ].join('\n'),
  'Tasks/Backlog.md': 'Черга задач: пошук, індексація, релізи.\n',
  'Ideas/Semantic ideas.md': [
    '# Ideas',
    '',
    'Semantic search over the whole vault could reuse the embedding corpus.',
    '',
    'Ідея: розумний пошук за змістом, а не лише за словами.',
    '',
  ].join('\n'),
  'Archive/Old search.md': 'Старий пошук, який більше не використовується.\n',
  'Archive/Old release.md': '# Old release\n\nAn archived release note about search.\n',
  'Archive/Naïve résumé.md': 'Архівна нотатка про naive resume та кафе.\n',
};

export async function writeFixtureVault(root: string): Promise<void> {
  for (const [rel, content] of Object.entries(FIXTURE_NOTES)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
}

export const FIXTURE_PATHS: readonly string[] = Object.keys(FIXTURE_NOTES);

/** The seven #177 query-set shapes, each aimed at the fixture above. */
export const QUERY_SETS: string[][] = [
  // phrase
  ['розумний пошук'],
  // multi-token
  ['гібридний семантичний пошук'],
  // accent-folded (query without the marks the note carries)
  ['naive resume cafe'],
  // apostrophe (query uses a variant different from some of the notes)
  ['об’єкт у сховищі'],
  // multi-query
  ['пошук', 'release', 'розумний пошук'],
  // no match
  ['цього тут немає ніде'],
  // title
  ['пошук у сховищі'],
];
