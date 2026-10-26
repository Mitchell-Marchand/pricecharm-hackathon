import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

const ToastContext = createContext<(message: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const notify = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    setMessage(text);
    timer.current = window.setTimeout(() => setMessage(''), 3600);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 z-[80] flex justify-center px-4"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 76px)' }}
      >
        {message && (
          <p className="fade-up pointer-events-auto max-w-md rounded-sm bg-ink px-4 py-3 text-sm font-medium text-on-ink shadow-2">
            {message}
          </p>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
