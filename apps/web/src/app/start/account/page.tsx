import { redirect } from 'next/navigation';

/** The account is made on the ready page now, right where the Charm is shown. */
export default function AccountStep() {
  redirect('/start/ready#account');
}
