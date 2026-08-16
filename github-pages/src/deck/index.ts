// Barrel for src/deck/ — the deck's simulation logic (data, telemetry
// store, hooks, and the small presentational components that read them).
// Consumed by src/components/chapters/{cockpit/*,Workflow,Capabilities,Cta}.tsx.

export { TONES, termRows, liveRows, flowData, seedChartData } from './data';
export type { ToneName, TermKind, TermRowSeed, FlowStep } from './data';

export {
  getTelemetrySnapshot,
  subscribeTelemetry,
  setTelemetry,
  useTelemetryField,
} from './telemetry';
export type { TelemetrySnapshot } from './telemetry';

export { chartData, subscribeChartData, requestChartRedraw, pushChartSample } from './chartData';

export { pushTerm, renderTerminal, useTerminalSnapshot } from './useTerminal';
export type { TerminalRow } from './useTerminal';

export { useUptime } from './useUptime';
export { useTelemetryEngine } from './useTelemetryEngine';
export { useUsageChart } from './useUsageChart';
export { useTabs } from './useTabs';
export type { CockpitView, UseTabsResult } from './useTabs';
export { useFlowStepper } from './useFlowStepper';
export type { UseFlowStepperResult } from './useFlowStepper';
export { useCopyCommand } from './useCopyCommand';
export type { CopyStatus, UseCopyCommandResult } from './useCopyCommand';

export { Segments } from './Segments';
export type { SegmentsProps } from './Segments';
export { Metric } from './Metric';
export type { MetricProps } from './Metric';
export { TerminalPane } from './TerminalPane';
export { UsageChart } from './UsageChart';
