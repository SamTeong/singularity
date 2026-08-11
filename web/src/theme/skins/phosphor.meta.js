/**
 * Phosphor Console skin metadata — plain data, split out of `phosphor.jsx` so
 * it (and its `supportsColorMode: false` dark-only declaration) is
 * unit-testable without a JSX loader.
 * @type {{ id: 'phosphor', label: string, description: string, supportsColorMode: false }}
 */
export const PHOSPHOR_META = {
  id: 'phosphor',
  label: 'Phosphor Console',
  description: 'NERV/MAGI tactical CRT command deck — colour is state.',
  supportsColorMode: false, // dark-only
};
