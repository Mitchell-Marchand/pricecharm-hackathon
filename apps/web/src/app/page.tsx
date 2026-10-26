'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Logo } from '@/components/ui';
import GuestPreviewCanvas from '@/components/guest-preview';

export default function Home() {
  const [conversationStarted, setConversationStarted] = useState(false);
  return (
    <main className={`welcome-page ${conversationStarted ? 'welcome-in-conversation' : ''}`}>
      <header className="welcome-header">
        <Logo />
        <nav aria-label="Main navigation">
          <Link href="/pricing">Pricing</Link>
          <Link href="/login">
            Sign in <span aria-hidden="true">↗</span>
          </Link>
        </nav>
      </header>
      <section className="welcome-workspace" aria-labelledby="welcome-title">
        <div className="welcome-intro">
          <h1 id="welcome-title">
            Teach it how
            <br />
            you quote.
          </h1>
          <p className="welcome-lead">Build an assistant that learns from you.</p>
        </div>
        <div className="welcome-conversation">
          <GuestPreviewCanvas onPreviewChange={setConversationStarted} />
        </div>
      </section>
      <footer className="welcome-footer">
        <span>© {new Date().getFullYear()} Quotefolk</span>
        <nav aria-label="Legal and pricing">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </nav>
      </footer>
    </main>
  );
}
