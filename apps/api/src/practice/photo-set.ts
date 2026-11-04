import { aiProvider } from '../ai/index.js';
import {
  checkPracticePhotos,
  editPracticePhoto,
  generatePracticePhoto,
} from '../ai/practice-images.js';
import { reportError } from '../error-reporting.js';
import type { PracticePhoto, Project } from './types.js';

/**
 * A practice customer's photos, made so the owner can price the job and believe a real customer
 * took them. Each place in the project gets one photo made from words, which shows all of it. Every
 * other photo of that place is made from that one, because the image model can't repeat a scene
 * from words (src/ai/practice-images.ts). All of them are checked against the project before
 * the owner sees them. What doesn't pass gets one more try, and what still doesn't is left out.
 */

/** PRACTICE_PHOTO_SETS=off goes back to drawing each photo on its own, without a deploy. */
export const photoSetsAvailable = () =>
  aiProvider === 'meta' && process.env.PRACTICE_PHOTO_SETS !== 'off';

/** Runs a paid call against whoever's allowance this is for. */
type Spend = <T>(task: () => Promise<T>) => Promise<T>;

type SetInput = {
  /** Whose photos these are, for the image provider. */
  owner: string;
  title: string;
  project: Project;
  photos: PracticePhoto[];
  spend: Spend;
};

const placeOf = (photo: PracticePhoto) => photo.place ?? 0;
const lookOf = (project: Project, place: number) =>
  (project.places[place] ?? project.places[0]).look;
/** The first photo of each place, which the others are made from. */
const firstOf = (photos: PracticePhoto[], index: number) =>
  photos.findIndex((photo) => placeOf(photo) === placeOf(photos[index]));

/** One failed photo doesn't stop the rest: a request with fewer photos beats no customer. */
async function attempt(task: () => Promise<Buffer>) {
  try {
    return await task();
  } catch (error) {
    reportError(error, { event: 'practice_photo' });
    return null;
  }
}

/** Every photo of a place: the one from words, then the rest from it, all at once. */
async function drawPlace(input: SetInput, place: number, also: string, shots: (Buffer | null)[]) {
  const { project, photos, owner, title, spend } = input;
  const look = lookOf(project, place);
  const indexes = photos.flatMap((photo, index) => (placeOf(photo) === place ? [index] : []));
  const [first, ...rest] = indexes;
  const wide = await attempt(async () => {
    const { bytes } = await spend(() =>
      generatePracticePhoto(owner, {
        title,
        description: `${photos[first].scene} ${look} ${also}`.trim().slice(0, 1200),
      }),
    );
    return bytes;
  });
  if (!wide) return;
  shots[first] = wide;
  await Promise.all(rest.map((index) => redraw(input, index, wide, shots)));
}

/** A photo made from the first one of its place. */
async function redraw(input: SetInput, index: number, wide: Buffer, shots: (Buffer | null)[]) {
  const { project, photos, owner, spend } = input;
  const made = await attempt(async () => {
    const { bytes } = await spend(() =>
      editPracticePhoto(owner, {
        references: [wide],
        view: photos[index].scene,
        look: lookOf(project, placeOf(photos[index])),
        moved: project.photoSet === 'two_parts',
      }),
    );
    return bytes;
  });
  if (made) shots[index] = made;
}

async function check(input: SetInput, shots: (Buffer | null)[]) {
  const made = input.photos.flatMap((photo, index) =>
    shots[index]
      ? [{ scene: photo.scene, place: placeOf(photo), bytes: shots[index]!, index }]
      : [],
  );
  if (!made.length) return null;
  try {
    const verdict = await input.spend(() =>
      checkPracticePhotos({ project: input.project, photos: made }),
    );
    // By each photo's place in the set, with gaps for any that didn't get made.
    const byIndex = new Map(made.map((photo, at) => [photo.index, verdict.photos[at]]));
    return { byIndex, showsJob: verdict.showsJob };
  } catch (error) {
    // Made from one photo, they're very likely fine. A check that's down doesn't stop a customer.
    reportError(error, { event: 'practice_photo_check' });
    return null;
  }
}

type Verdict = NonNullable<Awaited<ReturnType<typeof check>>>;
const passes = (verdict: Verdict, index: number) => verdict.byIndex.get(index)?.fits !== false;

/** The photos for a customer, in order, with null for any that are left out. */
export async function drawPhotoSet(input: SetInput): Promise<(Buffer | null)[]> {
  const { photos, project } = input;
  const shots: (Buffer | null)[] = photos.map(() => null);
  const places = [...new Set(photos.map(placeOf))];
  await Promise.all(places.map((place) => drawPlace(input, place, '', shots)));
  const first = await check(input, shots);
  if (!first) return shots;

  // A first photo that's off, or a project it doesn't show, means starting that place again.
  const fix = first.showsJob ? '' : `It has to make this plain: ${project.shows[0]}.`;
  const again = places.filter(
    (place) =>
      !passes(
        first,
        photos.findIndex((photo) => placeOf(photo) === place),
      ) ||
      (!first.showsJob && place === places[0]),
  );
  const rest = photos.flatMap((_, index) =>
    firstOf(photos, index) !== index &&
    !again.includes(placeOf(photos[index])) &&
    !passes(first, index)
      ? [index]
      : [],
  );
  if (!again.length && !rest.length) return shots;

  await Promise.all([
    ...again.map((place) => drawPlace(input, place, fix, shots)),
    ...rest.map((index) => redraw(input, index, shots[firstOf(photos, index)]!, shots)),
  ]);
  const last = await check(input, shots);
  return last ? settle(photos, shots, last) : shots;
}

/**
 * What's left after the second try. A photo that still doesn't belong is left out. The first photo
 * of a place stays unless it's broken, since the rest of the customer hangs on it, and the owner
 * always gets at least one photo.
 */
function settle(photos: PracticePhoto[], shots: (Buffer | null)[], last: Verdict) {
  const kept = shots.map((shot, index) => {
    const verdict = last.byIndex.get(index);
    if (verdict?.fits !== false) return shot;
    return firstOf(photos, index) === index && !verdict.broken ? shot : null;
  });
  return kept.some(Boolean) ? kept : shots;
}

/**
 * A photo the owner asked for, made from the customer's other photos of that place, or null if
 * two tries don't pass. The customer then says they couldn't get a good one. Turning the camera
 * right around is what the image model finds hardest, so it gets a second try that says what was
 * wrong with the first.
 */
export async function drawAskedPhoto(input: {
  owner: string;
  project: Project | undefined;
  references: { scene: string; bytes: Buffer }[];
  view: string;
  place: number;
  spend: Spend;
}): Promise<Buffer | null> {
  const { owner, project, references, view, place, spend } = input;
  let wrong = '';
  for (let tries = 0; tries < 2; tries += 1) {
    const { bytes } = await spend(() =>
      editPracticePhoto(owner, {
        references: references.map((photo) => photo.bytes),
        view: wrong ? `${view} Not like the last try: ${wrong}.` : view,
        look: project ? lookOf(project, place) : '',
        moved: true,
      }),
    );
    try {
      const verdict = await spend(() =>
        checkPracticePhotos({
          project: project ?? { summary: '', shows: [view], places: [{ name: '', look: '' }] },
          photos: [
            ...references.map((photo) => ({ ...photo, place })),
            { scene: view, place, bytes },
          ],
          asked: true,
        }),
      );
      const made = verdict.photos.at(-1);
      if (made?.fits && !made.broken) return bytes;
      wrong = made?.why ?? '';
    } catch (error) {
      reportError(error, { event: 'practice_photo_check' });
      return bytes;
    }
  }
  return null;
}

/**
 * The customer's first message once only one photo is left: "First pic is the driveway, second is
 * the cracks." comes down to "Pic is the driveway."
 */
export function openerForOnePhoto(opener: string) {
  return opener
    .replace(
      /\bfirst (pic|photo) is (.+?)(,| and| then) (the )?second( one)? is [^.!?]*/i,
      'first $1 is $2',
    )
    .replace(
      /\bfirst (pic|photo) is/i,
      (_, word: string) => `${word[0].toUpperCase()}${word.slice(1)} is`,
    );
}
