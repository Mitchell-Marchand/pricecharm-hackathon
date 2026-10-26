import { readFile, writeFile } from 'node:fs/promises';

type QaOwner = {
  user: { id: string; email: string };
  business: { id: string; name: string };
};

export async function recordQaOwner(owner: QaOwner) {
  if (!owner.user.email.endsWith('@example.test')) {
    throw new Error('Browser QA fixtures must use an explicitly fictional email address.');
  }
  const path = process.env.QUOTING_QA_FIXTURES || '/tmp/quotient-redesign-fixtures.json';
  const fixture = {
    businessId: owner.business.id,
    businessName: owner.business.name,
    userId: owner.user.id,
    email: owner.user.email,
    purpose: 'Redesign browser regression',
  };
  let fixtures: Array<{ businessId: string }> = [];
  try {
    fixtures = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!fixtures.some((item) => item.businessId === fixture.businessId)) {
    fixtures.push(fixture);
    await writeFile(path, JSON.stringify(fixtures, null, 2) + '\n');
  }
  console.info('[qa fixture]', JSON.stringify(fixture));
}
