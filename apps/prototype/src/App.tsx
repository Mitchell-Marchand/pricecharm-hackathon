import { useEffect } from 'react';
import { ToastProvider } from './components/Toast';
import { StoreProvider, useStore } from './lib/store';
import { Account } from './screens/Account';
import { Business } from './screens/Business';
import { Jobs } from './screens/Jobs';
import { Landing } from './screens/Landing';
import { Live } from './screens/Live';
import { Practice } from './screens/Practice';
import { Ready } from './screens/Ready';

function Screens() {
  const { state } = useStore();
  useEffect(() => {
    window.scrollTo({ top: 0 });
    try {
      window.history.replaceState(null, '', `#${state.screen}`);
    } catch {
      // Some embedded viewers don't allow changing the address; navigation still works.
    }
  }, [state.screen]);
  switch (state.screen) {
    case 'landing':
      return <Landing />;
    case 'business':
      return <Business />;
    case 'jobs':
      return <Jobs />;
    case 'practice':
      return <Practice />;
    case 'ready':
      return <Ready />;
    case 'account':
      return <Account />;
    case 'live':
      return <Live />;
  }
}

export function App() {
  return (
    <StoreProvider>
      <ToastProvider>
        <Screens />
      </ToastProvider>
    </StoreProvider>
  );
}
