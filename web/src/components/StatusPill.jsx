import { StatusPill as ZapacStatusPill } from '@zapac/mui-theme';
import { Stamp } from 'phosphor-console-theme/components';
import { useThemeSkin } from '@/theme/index.js';
import { getDomainState } from '@/lib/domainState.js';

/**
 * `status`'s legacy four-value vocabulary (`done|active|review|error` — see
 * `lib/agentStatus.js`'s `KIND` map and every call site below) mapped onto the
 * shared six-value `DomainStateId` (`lib/domainState.js`) each one reads its
 * Phosphor `tone`/`filled` from. `active` means "currently executing", the
 * same meaning as `domainState`'s `running`; `error` covers both a hard
 * failure and a lost connection, the same meaning as `domainState`'s `failed`.
 */
const STATUS_TO_DOMAIN = { done: 'done', active: 'running', review: 'review', error: 'failed' };

/**
 * StatusPill — skin-neutral status/lifecycle pill (task 2.1, design.md D3).
 *
 * Same prop shape as the ZAPAC-owned `@zapac/mui-theme` `StatusPill` it
 * replaces at every call site (`status`, `children`, `sx`), so migrating an
 * import is a pure path swap. Adds one optional prop, `blink`, for an
 * in-progress/live state — a no-op under ZAPAC (which has no blink grammar)
 * and forwarded to the vendored `Stamp`'s `blink` under Phosphor.
 *
 * Resolution strategy: branches on {@link useThemeSkin} rather than resolving
 * purely through `getRoles(theme).status` (design.md D1's preferred no-branch
 * path), because the ZAPAC pill's `review` state reads
 * `var(--mui-palette-brand-ink)` — a one-off brand color `StatusRole`
 * deliberately excludes (see `theme/contract.js`) — and tints its background
 * via `color-mix` off that same ink, not a flat semantic color. Delegating
 * straight to the vendored ZAPAC component keeps that branch byte-for-byte
 * identical instead of approximating the ink with a nearby semantic color.
 * Under Phosphor, `status` maps to a `DomainStateId` (`STATUS_TO_DOMAIN`
 * above) and renders through the vendored `Stamp`'s `tone`/`filled` grammar.
 *
 * Accessible-label state: `children` is always the visible label text (every
 * call site passes a real status word, e.g. `agent.status`), and `Stamp`
 * renders it as ordinary boxed text — never `aria-hidden` — so the state is
 * already conveyed by text, not color alone; no separate `aria-label` is
 * needed.
 *
 * @param {Object} props
 * @param {'done'|'active'|'review'|'error'} props.status
 * @param {import('react').ReactNode} props.children visible label (also the accessible name)
 * @param {object} [props.sx]
 * @param {boolean} [props.blink=false] Phosphor-only in-progress blink (see the vendored `Stamp`'s `blink`)
 */
export function StatusPill({ status, children, sx, blink = false }) {
  const { skinId } = useThemeSkin();

  if (skinId === 'phosphor') {
    const { tone, filled } = getDomainState(STATUS_TO_DOMAIN[status] ?? 'review');
    return (
      <Stamp tone={tone} filled={filled} blink={blink} sx={sx}>
        {children}
      </Stamp>
    );
  }

  // ZAPAC (and any future skin without a Phosphor mapping) — delegate to the
  // vendored component itself so pixel output stays identical.
  return (
    <ZapacStatusPill status={status} sx={sx}>
      {children}
    </ZapacStatusPill>
  );
}
