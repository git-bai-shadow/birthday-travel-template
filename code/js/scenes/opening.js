/* ==========================================================================
   幕 2 · 开场语
   两行字，大量留白。从"惊喜"过渡到"旅行"这个主题。
   ========================================================================== */

import { config } from '../config.js';
import { h } from '../lib/dom.js';
import { createStarfield } from '../lib/fx.js';
import { makeScrollHint } from '../lib/scroll.js';

export function createOpening() {
  const lines = config.opening.lines;

  const canvas = h('canvas', { class: 'canvas-layer', 'aria-hidden': 'true' });
  const hint = makeScrollHint();

  const lineEls = lines.map((text, i) => h('p', {
    class: 'opening__line reveal',
    text,
    style: { transitionDelay: `${i * 600}ms` },
  }));

  const el = h('section', { class: 'scene', id: 'scene-opening' },
    canvas,
    h('div', { class: 'scene__inner stack stack--center' }, ...lineEls),
    hint);

  let stars = null;

  return {
    el,
    onEnter() {
      if (!stars) stars = createStarfield(canvas, 46);
      else stars.start();
      setTimeout(() => hint.classList.add('is-in'), 2600);
    },
    onLeave() { stars?.stop(); },
    destroy() { stars?.destroy(); },
  };
}
