// Preserve the existing app import path while Edge and server code share the
// exact same calculation contract.
export { completedSpendingMonths, readSpendingAverage, typicalSpendingMonths } from '../lib/server-shared/completed-year-spending.ts';
