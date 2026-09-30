import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORLD_FORMAT_VERSION } from '../src/core/index.ts';

test('ядро импортируется в Node без DOM', () => {
  assert.equal(WORLD_FORMAT_VERSION, 1);
});
