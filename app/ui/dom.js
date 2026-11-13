/**
 * The few things every part of the interface reaches for.
 *
 * First out of app.js, because nothing can be moved out of it until these
 * can be imported from somewhere that is not it.
 */
export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => [...document.querySelectorAll(sel)];

export const fmt = (n) => Number(n || 0).toLocaleString();
export const authorsOf = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

/**
 * One of the sprite's icons, as an element.
 *
 * The markup is ours and static — never author text — so innerHTML is safe
 * here in a way it is not two lines below, where a title goes in by
 * textContent because someone wrote it.
 */
export function icon(name, className = 'ic') {
  const span = document.createElement('span');
  span.innerHTML = `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  return span.firstChild;
}

export const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

