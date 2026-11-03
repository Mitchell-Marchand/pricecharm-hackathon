import { redirect } from 'next/navigation';

/**
 * Past jobs came before practice once. Now they're an extra on the try page, after signup, so an
 * old link opens wherever this setup is.
 */
export default function JobsStep() {
  redirect('/start');
}
