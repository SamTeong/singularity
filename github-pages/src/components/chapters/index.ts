// Chapter id -> component. `Record<ChapterId, ...>` is exhaustive, so adding an
// id to the ChapterId union without adding a component here is a type error —
// that is deliberate, and it is the main guard rail when editing the deck.
import type { ComponentType } from 'react';
import type { ChapterId } from '../../config/chapters';
import type { ChapterProps } from './types';
import { Orientation } from './Orientation';
import { Chaos } from './Chaos';
import { Tasks } from './Tasks';
import { FleetControl } from './FleetControl/FleetControl';
import { AgentHarness } from './AgentHarness';
import { SystemDesign } from './SystemDesign';
import { Skins } from './Skins';
import { Pipeline } from './Pipeline';
import { Themes } from './Themes';
import { OpenSpec } from './OpenSpec';
import { TakeControl } from './TakeControl';
import { AppendixA, AppendixB } from './Appendix';

export const CHAPTER_COMPONENTS: Record<ChapterId, ComponentType<ChapterProps>> = {
  orientation: Orientation,
  chaos: Chaos,
  'agent-harness': AgentHarness,
  'fleet-control': FleetControl,
  tasks: Tasks,
  'system-design': SystemDesign,
  skins: Skins,
  pipeline: Pipeline,
  themes: Themes,
  openspec: OpenSpec,
  'take-control': TakeControl,
  'appendix-a': AppendixA,
  'appendix-b': AppendixB,
};
