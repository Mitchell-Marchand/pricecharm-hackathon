import { useState } from 'react';
import { ArrowRight, CircleCheckBig, Hand, MessageSquareText, MonitorSmartphone, Receipt } from 'lucide-react';
import { Logo } from '../components/Logo';
import { PrototypeMenu } from '../components/PrototypeMenu';
import { QuoteForm } from '../components/QuoteForm';
import { Button } from '../components/ui';
import { FACT_LABELS, SCENARIOS_BY_ID } from '../data/scenarios';
import { tradeName } from '../data/trades';
import { autoSendReady, learnedRate, practiceResults } from '../lib/learn';
import { useStore } from '../lib/store';
import { money, rate } from '../lib/util';
import { CustomerDemo } from './CustomerDemo';

export function Ready() {
  const { state, dispatch } = useStore();
  const [demo, setDemo] = useState(false);
  const business = state.business.name || 'Your business';
  const runs = state.runs.filter((run) => run.finished);
  const results = practiceResults(state.runs);
  const autoSend = autoSendReady(state.runs);
  const quotes = runs.flatMap((run) => (run.quote ? [run.quote] : []));
  const rateCents = learnedRate(state, state.runs.length).cents;

  const asked = [...new Set(runs.flatMap((run) => run.asked))].filter((key) => FACT_LABELS[key]);
  const questions = ['Can you send a few photos?', ...asked.map((key) => FACT_LABELS[key].question)];
  if (questions.length < 4) {
    for (const key of ['size', 'surface', 'stains']) {
      const question = FACT_LABELS[key].question;
      if (!questions.includes(question)) questions.push(question);
    }
  }
  const pricing = [
    `About ${rate(rateCents)} per sq ft for patios and flatwork`,
    ...runs.flatMap((run) =>
      run.insights.filter((item) => /^(Adds|Gives|Takes)/.test(item.text)).map((item) => item.text),
    ),
  ];
  const handoffs = [
    ...runs.flatMap((run) => run.insights.filter((item) => /^Won't send/.test(item.text)).map((item) => item.text)),
    'Anything over $1,500',
    state.business.area ? `Jobs more than ${state.business.radius} miles from ${state.business.area}` : 'Jobs outside your service area',
    'Services you don’t offer, or anything it hasn’t seen before',
  ];

  return (
    <div className="min-h-dvh">
      <header className="gutter mx-auto flex h-18 max-w-5xl items-center gap-3">
        <Logo onClick={() => dispatch({ type: 'go', screen: 'landing' })} />
        <PrototypeMenu />
      </header>
      <main className="gutter mx-auto max-w-5xl pt-6 pb-20">
        <div className="grid items-center gap-12 md:grid-cols-[1fr_380px]">
          <div>
            <p className="inline-flex items-center gap-2 font-semibold text-go">
              <CircleCheckBig className="size-5" aria-hidden /> Training complete
            </p>
            <h1 className="t-hero mt-4">Your AI is ready.</h1>
            <p className="mt-5 max-w-xl text-lg text-ink-2">
              It learned from {state.jobs.length} past {state.jobs.length === 1 ? 'job' : 'jobs'} and {runs.length} practice
              customers. Here's how it will handle {tradeName(state.business.tradeId, state.business.customTrade).toLowerCase()}{' '}
              requests for {business}.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" onClick={() => dispatch({ type: 'go', screen: 'account' })}>
                Create your free account <ArrowRight aria-hidden />
              </Button>
              <Button size="lg" variant="secondary" onClick={() => setDemo(true)}>
                <MonitorSmartphone aria-hidden /> Try it as a customer
              </Button>
            </div>
          </div>
          <div className="relative mx-auto h-[430px] w-full max-w-[360px]" aria-label="Your practice quotes">
            {quotes.slice(-3).map((quote, position) => (
              <div
                key={quote.number}
                className="absolute top-0 left-3 w-[calc(100%-72px)]"
                style={{
                  transform: `translate(${position * 18}px, ${position * 28}px) rotate(${(position - 1) * 2.5}deg)`,
                }}
              >
                <QuoteForm quote={quote} business={business} stamp="practice" compact />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-16 grid gap-10 border-t border-line pt-12 md:grid-cols-3 md:gap-8">
          <section>
            <h2 className="flex items-center gap-2 t-h3">
              <MessageSquareText className="size-5 text-accent" aria-hidden /> It will ask
            </h2>
            <ul className="mt-4 flex flex-col gap-2.5 text-ink-2">
              {questions.slice(0, 6).map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="flex items-center gap-2 t-h3">
              <Receipt className="size-5 text-accent" aria-hidden /> How it prices
            </h2>
            <ul className="mt-4 flex flex-col gap-2.5 text-ink-2">
              {[...new Set(pricing)].slice(0, 6).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="flex items-center gap-2 t-h3">
              <Hand className="size-5 text-accent" aria-hidden /> When it checks with you
            </h2>
            <ul className="mt-4 flex flex-col gap-2.5 text-ink-2">
              {[...new Set(handoffs)].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        </div>

        <section className="mt-14 rounded-md border border-line bg-surface p-5 sm:p-6" aria-labelledby="accuracy-title">
          <h2 id="accuracy-title" className="t-h2">
            Its guesses next to yours
          </h2>
          <div className="mt-5">
            <table className="w-full max-w-2xl text-left text-[15px]">
              <thead>
                <tr className="border-b border-line text-sm text-muted">
                  <th className="py-2 pr-4 font-medium">Practice</th>
                  <th className="py-2 pr-4 text-right font-medium">Its guess</th>
                  <th className="py-2 pr-4 text-right font-medium">You</th>
                  <th className="py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => {
                  const scenario = SCENARIOS_BY_ID[result.scenarioId];
                  return (
                    <tr key={result.scenarioId} className="border-b border-line last:border-0">
                      <td className="py-3 pr-4">{scenario.customer}</td>
                      <td className="tabular py-3 pr-4 text-right font-mono">
                        {result.siteVisit && result.aiFlagged ? 'Visit first' : result.guessCents !== null ? money(result.guessCents) : '—'}
                      </td>
                      <td className="tabular py-3 pr-4 text-right font-mono">
                        {result.siteVisit ? 'Visit first' : result.ownerCents !== null ? money(result.ownerCents) : '—'}
                      </td>
                      <td className="py-3">
                        {result.siteVisit ? (
                          result.aiFlagged ? (
                            <span className="text-go">Agreed</span>
                          ) : (
                            <span className="text-muted">Learned</span>
                          )
                        ) : (
                          <span className={result.agree ? 'text-go' : 'text-muted'}>{result.gap}% apart</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-5 max-w-2xl text-ink-2">
            {autoSend ? (
              <>
                <span className="font-semibold text-ink">Quotes will go out on their own.</span> Its last two answers matched
                yours, so quotes inside your usual range send automatically. Anything unusual waits for your OK.
              </>
            ) : (
              <>
                <span className="font-semibold text-ink">You'll approve each quote for now.</span> Its guesses aren't close
                enough yet, so every quote waits for a one-tap OK. That switches off once it matches you more often.
              </>
            )}
          </p>
        </section>
      </main>
      <CustomerDemo open={demo} onClose={() => setDemo(false)} />
    </div>
  );
}
