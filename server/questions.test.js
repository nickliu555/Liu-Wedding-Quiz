'use strict';

const { validateQuestions, QuestionsError } = require('./questions');

let failures = 0;
function expectThrow(fn, match, name) {
  try {
    fn();
    console.error(`FAIL: ${name} -> expected throw`);
    failures++;
  } catch (e) {
    if (!(e instanceof QuestionsError)) {
      console.error(`FAIL: ${name} -> threw non-QuestionsError: ${e.message}`);
      failures++;
      return;
    }
    if (match && !e.message.includes(match)) {
      console.error(`FAIL: ${name} -> message "${e.message}" missing "${match}"`);
      failures++;
      return;
    }
    console.log(`ok: ${name}`);
  }
}
function expectOk(fn, name) {
  try {
    fn();
    console.log(`ok: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name} -> ${e.message}`);
    failures++;
  }
}

const good = {
  questions: [
    { id: 'a', prompt: 'p', choices: ['1', '2', '3', '4'], correctIndex: 0 },
    { id: 'b', prompt: 'p', choices: ['1', '2', '3', '4'], correctIndex: 3, timeLimitSec: 10 },
  ],
};

expectOk(() => {
  const n = validateQuestions(good);
  if (n[0].timeLimitSec !== 20) throw new Error('default timeLimit not applied');
  if (n[1].timeLimitSec !== 10) throw new Error('override timeLimit ignored');
}, 'valid input normalizes with default timeLimit');

expectThrow(() => validateQuestions({}), 'questions', 'rejects missing questions array');
expectThrow(() => validateQuestions({ questions: [] }), 'empty', 'rejects empty array');
expectThrow(
  () => validateQuestions({ questions: [{ id: 'a', prompt: 'p', choices: ['1', '2', '3'], correctIndex: 0 }] }),
  'exactly 4',
  'rejects wrong choice count'
);
expectThrow(
  () => validateQuestions({ questions: [{ id: 'a', prompt: 'p', choices: ['1', '2', '3', '4'], correctIndex: 5 }] }),
  'correctIndex',
  'rejects out-of-range correctIndex'
);
expectThrow(
  () => validateQuestions({
    questions: [
      { id: 'a', prompt: 'p', choices: ['1', '2', '3', '4'], correctIndex: 0 },
      { id: 'a', prompt: 'p', choices: ['1', '2', '3', '4'], correctIndex: 0 },
    ],
  }),
  'duplicate',
  'rejects duplicate ids'
);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll questions tests passed');
