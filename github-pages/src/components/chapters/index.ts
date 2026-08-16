// Chapter id -> component. `Record<ChapterId, ...>` is exhaustive, so adding an
// id to the ChapterId union without adding a component here is a type error —
// that is deliberate, and it is the main guard rail when editing the deck.
import type { ComponentType } from 'react';
import type { ChapterId } from '../../config/chapters';
import type { ChapterProps } from './types';
import { Hero } from './Hero';
import { Problem } from './Problem';
import { Workflow } from './Workflow';
import { Cockpit } from './cockpit/Cockpit';
import { Capabilities } from './Capabilities';
import { Local } from './Local';
import { Cta } from './Cta';

export const CHAPTER_COMPONENTS: Record<ChapterId, ComponentType<ChapterProps>> = {
  arrival: Hero,
  problem: Problem,
  control: Cockpit,
  workflow: Workflow,
  systems: Capabilities,
  local: Local,
  boot: Cta,
};
