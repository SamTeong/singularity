/**
 * ZAPAC skin metadata — plain data, split out of `zapac.jsx` so it (and the
 * `DEFAULT_SKIN_ID` relationship) is unit-testable without a JSX loader.
 * @type {{ id: 'zapac', label: string, description: string, supportsColorMode: true }}
 */
export const ZAPAC_META = {
  id: 'zapac',
  label: 'ZAPAC',
  description: 'Glass-over-gradient on the Zühlke purple→cyan identity.',
  supportsColorMode: true,
};
