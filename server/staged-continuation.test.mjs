import test from 'node:test';
import assert from 'node:assert/strict';
import { stagedContinuation } from './analysis-jobs.mjs';

test('a direct answer that did not fit can continue through the staged reading', () => {
  const paused = { phase: 'answer_direct', completed: 0, total: 64, error: 'A IA não concluiu a resposta nesta tentativa.', supportPending: [1, 2] };
  const next = stagedContinuation(paused);
  assert.equal(next.phase, 'context');
  assert.equal(next.directChecked, true);
  assert.equal(next.completed, 0);
  assert.equal(next.total, 64);
  assert.ok(!('error' in next));
  assert.match(next.notice, /leitura em etapas/);
  // The paused progress stays untouched so a retry can still use the direct answer.
  assert.equal(paused.phase, 'answer_direct');
  assert.equal(paused.error, 'A IA não concluiu a resposta nesta tentativa.');
});

test('without pending support notes the staged reading starts at the summaries', () => {
  assert.equal(stagedContinuation({ phase: 'answer_direct', supportPending: [] }).phase, 'review');
  assert.equal(stagedContinuation({ phase: 'answer_direct' }).phase, 'review');
});

test('only a paused direct answer is redirected to the staged reading', () => {
  assert.equal(stagedContinuation({ phase: 'review' }), null);
  assert.equal(stagedContinuation({ phase: 'complete' }), null);
  assert.equal(stagedContinuation(null), null);
  assert.equal(stagedContinuation(undefined), null);
});
