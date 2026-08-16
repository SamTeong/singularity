// Source line 444. Width is written EVERY FRAME by the world's onFrame
// callback (source L1436), so it is a ref write, never React state.
import type { Ref } from 'react';

export function ScrollProgress({ barRef }: { barRef?: Ref<HTMLDivElement> }) {
  return <div className="sx-progress" id="sxProgress" aria-hidden="true" ref={barRef} />;
}
