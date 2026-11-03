import { redirect } from 'next/navigation';

/** Setup's first screen before it was split up. Its links and bookmarks land on the trade. */
export default function BusinessStep() {
  redirect('/start/trade');
}
