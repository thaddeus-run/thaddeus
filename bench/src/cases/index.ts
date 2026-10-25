import type { BenchCase } from '../case';
import openCases from './open';
import oplogCases from './oplog';
import storeCases from './store';

// The library suite's registry: every in-process case. The runner imports
// this module by path, in the parent and in each child, and looks cases up
// by id.
const libraryCases: readonly BenchCase[] = [
  ...storeCases,
  ...oplogCases,
  ...openCases,
];

export default libraryCases;
