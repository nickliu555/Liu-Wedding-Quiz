'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TIME_LIMIT_SEC = 20;

class QuestionsError extends Error {}

function loadQuestions(filePath) {
  const abs = path.resolve(filePath);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw new QuestionsError(`Could not read questions file at ${abs}: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new QuestionsError(`Invalid JSON in ${abs}: ${e.message}`);
  }
  return validateQuestions(data);
}

function validateQuestions(data) {
  if (!data || !Array.isArray(data.questions)) {
    throw new QuestionsError('Top-level must be { "questions": [...] }');
  }
  if (data.questions.length === 0) {
    throw new QuestionsError('questions array is empty');
  }
  const seenIds = new Set();
  const normalized = data.questions.map((q, i) => {
    const where = `question[${i}]${q && q.id ? ` (id=${q.id})` : ''}`;
    if (!q || typeof q !== 'object') {
      throw new QuestionsError(`${where}: must be an object`);
    }
    if (typeof q.id !== 'string' || !q.id.trim()) {
      throw new QuestionsError(`${where}: id must be a non-empty string`);
    }
    if (seenIds.has(q.id)) {
      throw new QuestionsError(`${where}: duplicate id "${q.id}"`);
    }
    seenIds.add(q.id);
    if (typeof q.prompt !== 'string' || !q.prompt.trim()) {
      throw new QuestionsError(`${where}: prompt must be a non-empty string`);
    }
    if (!Array.isArray(q.choices) || q.choices.length !== 4) {
      throw new QuestionsError(`${where}: choices must be an array of exactly 4 strings`);
    }
    q.choices.forEach((c, ci) => {
      if (typeof c !== 'string' || !c.trim()) {
        throw new QuestionsError(`${where}: choices[${ci}] must be a non-empty string`);
      }
    });
    if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex > 3) {
      throw new QuestionsError(`${where}: correctIndex must be integer 0..3`);
    }
    let timeLimitSec = q.timeLimitSec;
    if (timeLimitSec === undefined || timeLimitSec === null) {
      timeLimitSec = DEFAULT_TIME_LIMIT_SEC;
    }
    if (typeof timeLimitSec !== 'number' || !Number.isFinite(timeLimitSec) || timeLimitSec < 3 || timeLimitSec > 120) {
      throw new QuestionsError(`${where}: timeLimitSec must be a number between 3 and 120`);
    }
    if (q.image !== undefined && q.image !== null && typeof q.image !== 'string') {
      throw new QuestionsError(`${where}: image must be a string URL/path if provided`);
    }
    // Optional Simplified-Chinese translations. When present they let the
    // player phone show the question/answers in Chinese (language toggle).
    // Both are optional; a missing field simply falls back to English on the
    // client. If provided they must be well-formed.
    let promptZh = null;
    if (q.prompt_zh !== undefined && q.prompt_zh !== null) {
      if (typeof q.prompt_zh !== 'string' || !q.prompt_zh.trim()) {
        throw new QuestionsError(`${where}: prompt_zh must be a non-empty string if provided`);
      }
      promptZh = q.prompt_zh;
    }
    let choicesZh = null;
    if (q.choices_zh !== undefined && q.choices_zh !== null) {
      if (!Array.isArray(q.choices_zh) || q.choices_zh.length !== 4) {
        throw new QuestionsError(`${where}: choices_zh must be an array of exactly 4 strings if provided`);
      }
      q.choices_zh.forEach((c, ci) => {
        if (typeof c !== 'string' || !c.trim()) {
          throw new QuestionsError(`${where}: choices_zh[${ci}] must be a non-empty string`);
        }
      });
      choicesZh = q.choices_zh.slice();
    }
    return {
      id: q.id,
      prompt: q.prompt,
      prompt_zh: promptZh,
      image: q.image || null,
      choices: q.choices.slice(),
      choices_zh: choicesZh,
      correctIndex: q.correctIndex,
      timeLimitSec,
    };
  });
  return normalized;
}

module.exports = { loadQuestions, validateQuestions, QuestionsError, DEFAULT_TIME_LIMIT_SEC };
