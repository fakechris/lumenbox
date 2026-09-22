import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matrixReport } from './cua-matrix.mjs';

test('GUI oracle catalog fails closed for missing cases, infrastructure errors and duplicate results', () => {
  const matrix = { version: 'fixture-1', cases: [{ id: 'delivered' }, { id: 'refused', expected: 'no input' }] };
  assert.equal(matrixReport(matrix, [{ id: 'delivered', status: 'pass' }]).passed, false);
  assert.equal(matrixReport(matrix, [{ id: 'delivered', status: 'pass' }, { id: 'refused', status: 'environment_error' }]).passed, false);
  assert.equal(matrixReport(matrix, [{ id: 'delivered', status: 'pass' }, { id: 'refused', status: 'pass' }]).passed, true);
  assert.equal(matrixReport({version:'empty', cases:[]}, []).passed, false);
  assert.equal(matrixReport(matrix, [{id:'delivered',status:'pass'},{id:'refused',status:'pass'}], {environment_error:'fixture crashed'}).passed, false);
  assert.throws(() => matrixReport(matrix, [{ id: 'other', status: 'pass' }]), /no matrix contract/);
  assert.throws(() => matrixReport(matrix, [{ id: 'delivered', status: 'pass' }, { id: 'delivered', status: 'pass' }]), /duplicate/);
});
