// File-type predicates shared by the tenet checks, in one place so "what counts as source / UI /
// docs" is defined exactly once (the Maintainability tenet, applied to ourselves).
export const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|kt|swift)$/i;
export const UI = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$/i;
export const DOC = /\.(md|mdx|rst|adoc|txt)$/i;

export const isSource = (path: string): boolean => SOURCE.test(path);
export const isUi = (path: string): boolean => UI.test(path);
export const isDoc = (path: string): boolean => DOC.test(path);
