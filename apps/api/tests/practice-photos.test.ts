import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groundedPracticeScenes,
  practicePhotoIntent,
  practiceSceneKey,
  safePracticeReply,
} from '../src/training-photos.js';

const scenario = {
  title: 'Fictional three-room painting request',
  customerName: 'Practice customer',
  description: 'I want the living room, kitchen and bedroom painted.',
  details: {
    quantity: '3 rooms',
    rooms: 'Living room, kitchen, bedroom',
    condition: 'Walls have ordinary scuffs. No hidden damage has been confirmed.',
  },
};
test('a legacy promised-photo followup resolves all fixed rooms without inventing unnamed rooms', () => {
  assert.equal(
    practicePhotoIntent('All rooms, please.', [
      { role: 'assistant', content: 'I will send photos shortly.' },
    ]),
    true,
  );
  assert.equal(practicePhotoIntent('All rooms, please.', []), false);
  assert.equal(practicePhotoIntent('Do not send photos.', []), false);
  assert.deepEqual(
    groundedPracticeScenes(scenario, 'All rooms, please.').map((scene) => scene.subject),
    ['living room', 'kitchen', 'bedroom'],
  );
  assert.deepEqual(
    groundedPracticeScenes(scenario, 'A photo of the living room, please.').map(
      (scene) => scene.subject,
    ),
    ['living room'],
  );
  const unknown = groundedPracticeScenes(
    {
      ...scenario,
      description: 'A painting request.',
      details: { quantity: '3 rooms' },
      title: 'Practice request',
    },
    'All rooms, please.',
  );
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].title, 'Representative project view');
});
test('scene reuse keys are stable and unavailable text replies cannot promise future images', () => {
  assert.equal(
    practiceSceneKey({ subject: 'Living room', title: 'A view', description: 'Known scuffs.' }),
    'living room',
  );
  assert.equal(
    practiceSceneKey({ title: 'Living room overview photo', description: 'Known scuffs.' }),
    'living room',
  );
  assert.doesNotMatch(safePracticeReply("I'll send those photos shortly."), /send|shortly/i);
  assert.equal(safePracticeReply('The room has normal scuffs.'), 'The room has normal scuffs.');
});

test('an explicit close-up or different angle preserves its scene and cannot reuse the wide room view', () => {
  const overview = groundedPracticeScenes(scenario, 'Show a photo of the living room.')[0];
  const proposed = {
    subject: 'living room wall detail',
    title: 'Living room wall scuffs close-up',
    description: 'A close-up of the ordinary scuffs on the living room wall.',
  };
  const closeup = groundedPracticeScenes(scenario, 'Show a close-up of the living room scuffs.', [
    proposed,
  ])[0];
  assert.equal(closeup.subject, proposed.subject);
  assert.equal(closeup.title, proposed.title);
  assert.ok(closeup.description.startsWith(proposed.description));
  assert.match(
    closeup.description,
    /does not confirm unknown or hidden damage or exact measurements/,
  );
  assert.notEqual(practiceSceneKey(closeup), practiceSceneKey(overview));
  const fallback = groundedPracticeScenes(scenario, 'Show the living room from another angle.')[0];
  assert.notEqual(practiceSceneKey(fallback), practiceSceneKey(overview));
  assert.match(fallback.title, /alternate angle/);
  const repeated = groundedPracticeScenes(scenario, 'Show the living room again.', [proposed])[0];
  assert.equal(
    practiceSceneKey(repeated),
    practiceSceneKey(overview),
    'An ordinary repeat keeps the stable room key even if the model suggests a detail view',
  );
});
