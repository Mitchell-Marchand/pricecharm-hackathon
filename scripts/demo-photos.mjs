// Makes the sample photos a visitor can "send" in the public demo, two for each trade, into
// apps/web/public/demo-photos. The captions the assistant reads live with the demo data in
// packages/trades/demos.js, so check them against any photo you make again.
//
//   node scripts/demo-photos.mjs                  every photo that isn't there yet
//   node scripts/demo-photos.mjs gutters-wide     just these, made again
//
// Uses OPENAI_API_KEY (and OPENAI_IMAGE_MODEL, if set) from apps/api/.env.
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(root, 'apps/api/.env'), quiet: true });
const out = join(root, 'apps/web/public/demo-photos');

/** What each photo shows. The first of each pair is the wide shot, the second the detail. */
const SCENES = {
  'pressure-washing-wide':
    'A two-car concrete driveway in front of a closed garage door, dull grey with grime, tire tracks and green-black algae streaks along the edges. Overcast Pacific Northwest light.',
  'pressure-washing-detail':
    'Looking down at the same concrete driveway near the garage door: a large dark oil stain and a few smaller drip stains soaked into the concrete.',
  'window-cleaning-wide':
    'The front of a two-story suburban house with a lot of windows, seen from the front lawn. The glass looks dull and dusty in the sun.',
  'window-cleaning-detail':
    'Looking up at an upstairs window from below: the glass has hard-water spots, dust and cobwebs in the corners of the frame.',
  'gutters-wide':
    'The roof edge of a two-story house in fall, with the gutter packed with wet brown leaves and a few small weeds growing out of it. Tall trees nearby.',
  'gutters-detail':
    'The corner of a house where a downspout comes down: water overflowing the top of the gutter and a muddy puddle at the base of the downspout after rain.',
  'house-cleaning-wide':
    'A lived-in home kitchen: crumbs and small appliances on the counters, smudged cabinet fronts, a few dishes in the sink, dusty top of the fridge.',
  'house-cleaning-detail':
    'An open oven door showing the inside of the oven: baked-on grease and dark burnt spots on the bottom and the inside of the door glass.',
  'carpet-wide':
    'A living room with light beige wall-to-wall carpet, with a visibly darker worn traffic lane from the doorway to the couch.',
  'carpet-detail':
    'Close-up of the beige carpet next to a dog bed: a faded yellowish pet stain and dog hair matted into the carpet.',
  'lawn-wide':
    'A suburban backyard with ankle-high overgrown grass, a few dandelions and a wooden privacy fence, in a warm Southern summer.',
  'lawn-detail':
    'Tall grass growing over the edge of a concrete patio and along the fence line, untrimmed and shaggy.',
  'landscaping-wide':
    'Front-yard garden beds along a house, full of weeds, with thin faded mulch and patchy bare dirt. Dry, sunny Colorado light.',
  'landscaping-detail':
    'A dead brown shrub in the garden bed, next to a small pile of pulled weeds and old branches on the lawn.',
  'trees-wide':
    'A large mature oak tree in a backyard, about 45 feet tall, with long branches reaching over the roof of the house.',
  'trees-detail':
    'Looking up from the ground at one thick dead branch with no leaves, hanging over the roof of the house.',
  'painting-wide':
    'A living room ready for painting, with the furniture pushed to the middle and the beige walls showing scuffs and faded patches where pictures hung.',
  'painting-detail':
    'Close-up of an interior wall: several small nail holes and a couple of shallow dings and scuff marks in the paint.',
  'handyman-wide':
    'A hallway with an interior door open against the wall, and a hole in the drywall where the doorknob hit it.',
  'handyman-detail':
    'Close-up of a round doorknob-sized hole in the drywall, with crumbling edges and torn paper around it.',
  'junk-wide':
    'A cluttered two-car garage packed with cardboard boxes, old furniture, a bike and general junk, with barely a path through it. Bright Arizona light from the open door.',
  'junk-detail':
    'In the corner of the garage: an old stained mattress leaning against the wall next to a broken white washing machine.',
  'moving-wide':
    'A small apartment living room in the middle of packing: stacks of taped cardboard boxes, a rolled rug and a couch.',
  'moving-detail':
    'A narrow carpeted staircase going up to a second-floor apartment, seen from the bottom step.',
  'fencing-wide':
    'An old weathered wooden privacy fence along a backyard, grey and leaning, with a few missing and cracked boards.',
  'fencing-detail':
    'Close-up of the bottom of a fence post: the wood is rotted and broken at the ground, and the fence section is leaning.',
  'decks-wide':
    'A weathered grey wooden deck off the back of a house, with faded boards, peeling old stain and a couple of chairs.',
  'decks-detail':
    'Close-up of a deck board that is cracked and soft with rot near a nail, next to boards with peeling stain.',
  'roofing-wide':
    'An asphalt shingle roof seen from the yard, with a few shingles missing near the ridge and some curling at the edges.',
  'roofing-detail':
    'Inside a bedroom, looking up at the ceiling: a brown water stain on the white drywall ceiling near the corner.',
  'flooring-wide':
    'A dated kitchen with old worn beige linoleum flooring, scuffed and discolored, with oak cabinets.',
  'flooring-detail':
    'Close-up of the kitchen floor: the old linoleum peeling up and cracked at a seam near the cabinet base.',
  'hvac-wide':
    'An outdoor central air conditioner condenser unit beside a brick house, with some leaves and grass clippings stuck to the side fins.',
  'hvac-detail':
    'A furnace and air handler inside a utility closet, with the front panel on and a dusty air filter leaning next to it.',
  'plumbing-wide':
    'The open cabinet under a kitchen sink: pipes, a few cleaning bottles pushed aside and a small bucket under the drain pipe.',
  'plumbing-detail':
    'Close-up of the drain pipe under the sink: water droplets dripping from a slip-nut joint and a damp stain on the cabinet floor.',
  'electrical-wide':
    'An old grey metal electrical panel on an unfinished garage wall, with conduit going into it.',
  'electrical-detail':
    'The open door of the old electrical panel showing rows of older breakers. Any labels are faded and unreadable.',
  'pools-wide':
    'A backyard swimming pool in Arizona with cloudy green water, desert landscaping and a block wall behind it.',
  'pools-detail':
    'The raised spa attached to the same pool, with green murky water and leaves floating in it.',
  'pest-wide':
    'A Florida home kitchen with tile floors, and a dog food bowl and water bowl on the floor by the counter.',
  'pest-detail':
    'Close-up of a line of small ants crawling along a kitchen windowsill and down the counter edge.',
  'detailing-wide':
    'The back seat of a mid-size car with grey cloth seats covered in dog hair, a crumpled blanket and a few crumbs.',
  'detailing-detail': 'Close-up of a coffee stain soaked into the grey cloth driver seat of a car.',
  'photography-wide':
    'A backyard garden in late afternoon golden light, with a big shade tree, a lawn and a flower bed, where a family wants their portraits taken.',
  'photography-detail':
    'A wooden bench under string lights next to a flowering bush in the same backyard.',
  'events-wide':
    'A large empty backyard lawn with string lights hung between trees, ready for a party, in warm Southern evening light.',
  'events-detail':
    'A brick patio at the edge of the lawn with a few folding tables stacked against the wall, where the food could go.',
};

const prompt = (scene) =>
  `A real smartphone photo that a homeowner took to send to a local business when asking for a quote. ${scene}
Ordinary phone camera at a handheld angle, natural light, slightly imperfect framing, everyday wear and mess. Not staged, not a professional or stock photo, no filters or dramatic lighting. No people, faces or hands. No text, signs, logos, brand names, watermarks, readable labels or house numbers.`;

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

async function make(key) {
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare',
      n: 1,
      size: '1536x1024',
      quality: 'medium',
      output_format: 'jpeg',
      prompt: prompt(SCENES[key]),
    }),
  });
  if (!response.ok) throw new Error(`${key}: ${response.status} ${await response.text()}`);
  const { data } = await response.json();
  const photo = await sharp(Buffer.from(data[0].b64_json, 'base64'))
    .resize({ width: 1080, height: 810, fit: 'cover' })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
  await writeFile(join(out, `${key}.jpg`), photo);
  console.log(`${key}.jpg ${Math.round(photo.length / 1024)} KB`);
}

if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY in apps/api/.env first.');
await mkdir(out, { recursive: true });
const asked = process.argv.slice(2);
const unknown = asked.filter((key) => !SCENES[key]);
if (unknown.length) throw new Error(`No scene for ${unknown.join(', ')}`);
const keys = asked.length
  ? asked
  : (
      await Promise.all(
        Object.keys(SCENES).map(async (key) =>
          (await exists(join(out, `${key}.jpg`))) ? null : key,
        ),
      )
    ).filter(Boolean);

// A few at a time, so one slow photo doesn't hold up the rest.
const queue = [...keys];
const failed = [];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let key = queue.shift(); key; key = queue.shift())
      await make(key).catch((error) => {
        failed.push(key);
        console.error(error.message);
      });
  }),
);
if (failed.length) {
  console.error(`Failed: ${failed.join(' ')}`);
  process.exitCode = 1;
}
