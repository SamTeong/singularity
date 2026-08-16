import type { Ref } from 'react';

/** Every chapter <section> accepts a ref so the Three.js layer can adopt the
 *  real DOM node as a CSS3DObject in Phase 4. */
export interface ChapterProps {
  sectionRef?: Ref<HTMLElement>;
}
