export interface AsciiProfile {
  id: string;
  name: string;
  art: string;
  small: string;
  accent: string;
}

export const profiles: AsciiProfile[] = [
  {
    id: 'robot',
    name: 'Robot',
    art: [
      ' [---] ',
      ' |o o| ',
      ' | ^ | ',
      ' |===| ',
      '/|   |\\',
    ].join('\n'),
    small: '[o.o]',
    accent: '#7c5bf5',
  },
  {
    id: 'wizard',
    name: 'Wizard',
    art: [
      '  /\\  ',
      ' /  \\ ',
      ' |**| ',
      ' (oo) ',
      ' /||\\ ',
    ].join('\n'),
    small: '/oo\\',
    accent: '#a855f7',
  },
  {
    id: 'ninja',
    name: 'Ninja',
    art: [
      '  __  ',
      ' |==| ',
      ' (--) ',
      ' /||\\ ',
      ' _/\\_ ',
    ].join('\n'),
    small: '(--)',
    accent: '#6366f1',
  },
  {
    id: 'cat',
    name: 'Cat',
    art: [
      ' /\\_/\\ ',
      '( o.o )',
      ' > ^ < ',
      ' /| |\\ ',
      '(_| |_)',
    ].join('\n'),
    small: '^._.^',
    accent: '#f59e0b',
  },
  {
    id: 'skull',
    name: 'Skull',
    art: [
      ' _____ ',
      '/     \\',
      '| o o |',
      '|  ^  |',
      ' \\vvv/ ',
    ].join('\n'),
    small: 'x_x',
    accent: '#ef4444',
  },
  {
    id: 'rocket',
    name: 'Rocket',
    art: [
      '  /\\  ',
      ' |  | ',
      ' |  | ',
      ' |==| ',
      ' /||\\ ',
    ].join('\n'),
    small: '=>>',
    accent: '#22c55e',
  },
  {
    id: 'ghost',
    name: 'Ghost',
    art: [
      ' .---. ',
      '| o o |',
      '|  O  |',
      '|     |',
      ' ^~^~^ ',
    ].join('\n'),
    small: 'o_O',
    accent: '#06b6d4',
  },
  {
    id: 'alien',
    name: 'Alien',
    art: [
      '  .--.  ',
      ' / oo \\ ',
      '( >--< )',
      ' \\    / ',
      '  \\--/  ',
    ].join('\n'),
    small: '@_@',
    accent: '#84cc16',
  },
];

export function getProfile(id: string): AsciiProfile {
  return profiles.find((p) => p.id === id) || profiles[0];
}
