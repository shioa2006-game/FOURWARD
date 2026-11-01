// 16x16 pixel-art sprites. Keys are palette characters from palette.ts ('.' = transparent).
// Style rules: 1px dark outline 'k' around every silhouette, light from the top-left,
// one highlight colour + one shade colour per material, readable at 32px.

export interface SpriteDef {
  rows: string[];
}

import { SPRITES_HERO_UI } from './sprites/hero_ui.ts';
import { SPRITES_ITEMS_A } from './sprites/items_a.ts';
import { SPRITES_ITEMS_B } from './sprites/items_b.ts';
import { SPRITES_ENEMIES_A } from './sprites/enemies_a.ts';
import { SPRITES_ENEMIES_B } from './sprites/enemies_b.ts';
import { SPRITES_BOSSES } from './sprites/bosses.ts';
import { SPRITES_PROPS } from './sprites/props.ts';
import { SPRITES_EXTRA } from './sprites/extra.ts';

const BASE: Record<string, SpriteDef> = {
  hero: {
    rows: [
      '................',
      '......kkkk......',
      '....kkyyyykk....',
      '...kyyzzyyyyk...',
      '...kyzyyyyyYk...',
      '...kyyyyyyyYk...',
      '...kkkkkkkkkk...',
      '...kHwkkkkwHk...',
      '...kkkkkkkkkk...',
      '....kbbbbbbk....',
      '...kbuubbbbBk...',
      '..kgkbbbbbbkgk..',
      '..kgkBBBBBBkgk..',
      '...kkNNkkNNkk...',
      '...kNNk..kNNk...',
      '....kk....kk....',
    ],
  },
  slime: {
    rows: [
      '................',
      '................',
      '................',
      '................',
      '......kkkk......',
      '....kkllllkk....',
      '...kllwwllllk...',
      '..klwwllllllek..',
      '..kllllllllllk..',
      '.kllkkllllkklek.',
      '.kllkwlllkwleek.',
      '.klllllllllleek.',
      '.kelllllllleeek.',
      '..keeeeeeeeeek..',
      '...kkkkkkkkkk...',
      '................',
    ],
  },
  item_sword: {
    rows: [
      '................',
      '.............kk.',
      '............kwgk',
      '...........kwgk.',
      '..........kwgk..',
      '.........kwgk...',
      '........kwgk....',
      '..kk...kwgk.....',
      '..kyk.kwgk......',
      '...kykwgk.......',
      '....kykk........',
      '...kNkyk........',
      '..kNk.kyk.......',
      '.kNk...kk.......',
      '.kk.............',
      '................',
    ],
  },
};

export const SPRITES: Record<string, SpriteDef> = {
  ...BASE,
  ...SPRITES_HERO_UI,
  ...SPRITES_ITEMS_A,
  ...SPRITES_ITEMS_B,
  ...SPRITES_ENEMIES_A,
  ...SPRITES_ENEMIES_B,
  ...SPRITES_BOSSES,
  ...SPRITES_PROPS,
  ...SPRITES_EXTRA,
};
