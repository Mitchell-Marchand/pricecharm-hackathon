import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { closeDatabase, mutate, rows } from '../db.js';

/**
 * Points our WhatsApp test number at one business, until owners connect their own numbers through
 * Meta's Embedded Signup. Uses WHATSAPP_PHONE_NUMBER_ID and, for what the owner sees,
 * WHATSAPP_DISPLAY_NUMBER. `--test` lists the numbers the owner tries it from: chats from those
 * are tests, never billed or emailed.
 *
 *   node --import tsx src/channels/connect.ts <business-slug> [--test +15551234567,...]
 *   node --import tsx src/channels/connect.ts <business-slug> --off
 */
const USAGE =
  'Usage: node --import tsx src/channels/connect.ts <business-slug> [--test <numbers> | --off]';

async function main() {
  const [slug, flag, value] = process.argv.slice(2);
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!slug || (flag && flag !== '--off' && flag !== '--test') || (flag === '--test' && !value))
    throw new Error(USAGE);
  const testNumbers =
    flag === '--test' ? value.split(',').map((number) => number.replace(/\D/g, '')) : [];
  if (testNumbers.some((number) => number.length < 8)) throw new Error(USAGE);
  if (!phoneNumberId) throw new Error('Set WHATSAPP_PHONE_NUMBER_ID in apps/api/.env first.');
  const [business] = await rows('SELECT id,name,link_on FROM businesses WHERE slug=?', [slug]);
  if (!business) throw new Error(`No business has the link /q/${slug}.`);
  if (flag === '--off') {
    await mutate(
      "UPDATE channel_accounts SET status='off' WHERE kind='whatsapp' AND platform_id=? AND business_id=?",
      [phoneNumberId, business.id],
    );
    console.info(`WhatsApp is off for ${business.name}.`);
    return;
  }
  await mutate(
    `INSERT INTO channel_accounts (id,business_id,kind,platform_id,display_name,test_numbers) VALUES (?,?,'whatsapp',?,?,?)
     ON DUPLICATE KEY UPDATE business_id=VALUES(business_id),display_name=VALUES(display_name),test_numbers=VALUES(test_numbers),status='connected'`,
    [
      randomUUID(),
      business.id,
      phoneNumberId,
      process.env.WHATSAPP_DISPLAY_NUMBER?.trim() ?? '',
      testNumbers.join(','),
    ],
  );
  console.info(
    `WhatsApp number ${phoneNumberId} now answers for ${business.name}.${business.link_on ? '' : ' Its Charm is paused, so turn quoting on before testing.'}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
