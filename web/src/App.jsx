import { AgentsProvider } from '@/providers/AgentsProvider.jsx';
import AppShell from '@/shell/AppShell.jsx';

// App is the composition root: the domain-state boundary (AgentsProvider) around
// the shell. Theme/colour boundaries live above this, in main.jsx.
export default function App() {
  return (
    <AgentsProvider>
      <AppShell />
    </AgentsProvider>
  );
}
