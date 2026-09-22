/** One result for every declared case. Missing tests and infrastructure failures never pass. */
export function matrixReport(matrix, results, metadata = {}) {
  const ids = new Set(matrix.cases.map(row => row.id));
  if (ids.size !== matrix.cases.length) throw new Error('duplicate matrix case');
  if (new Set(results.map(row => row.id)).size !== results.length) throw new Error('duplicate case result');
  if (results.some(row => !ids.has(row.id))) throw new Error('result has no matrix contract');
  const rows = matrix.cases.map(contract => ({ ...contract, ...(results.find(result => result.id === contract.id) ?? { status: 'not_run' }) }));
  return { schema_version: 1, fixture_version: matrix.version, ...metadata, passed: metadata.environment_error === undefined && rows.length > 0 && rows.every(row => row.status === 'pass'), rows };
}
