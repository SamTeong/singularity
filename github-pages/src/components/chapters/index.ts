import type { ComponentType } from 'react';
import type { ChapterId } from '../../config/chapters';
import type { ChapterProps } from './types';
import { Hero } from './Hero'; // agent 2B
import { Problem } from './Problem'; // agent 2B
import { Workflow } from './Workflow'; // agent 2B
import { Cockpit } from './cockpit/Cockpit'; // agent 2C
import { Capabilities } from './Capabilities'; // agent 2D
import { Local } from './Local'; // agent 2D
import { Cta } from './Cta'; // agent 2D

export const CHAPTER_COMPONENTS: Record<ChapterId, ComponentType<ChapterProps>> = {
  arrival: Hero,
  problem: Problem,
  control: Cockpit,
  workflow: Workflow,
  systems: Capabilities,
  local: Local,
  boot: Cta,
};
