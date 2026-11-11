import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_PROJECTS, groupByProject, projectLabel, projectNames } from '../web/projects.ts';

const projects = [{ id: 'p1', name: 'harness' }, { id: 'p2', name: 'orcabox' }];

test('an agent with no project reads as working across all projects', () => {
  assert.equal(projectLabel(null, projects), ALL_PROJECTS);
  assert.equal(projectLabel(null, undefined, 'Unknown project'), ALL_PROJECTS);
});

test('a project agent reads as its project, or the fallback once the project is gone', () => {
  assert.equal(projectLabel('p2', projects), 'orcabox');
  assert.equal(projectLabel(['p2'], projects), 'orcabox');
  assert.equal(projectLabel(['p1', 'p2'], projects), 'harness + 1', 'several read as the start folder plus how many more');
  assert.equal(projectLabel(['gone', 'p2'], projects), 'orcabox', 'a removed one is left out');
  assert.deepEqual(projectNames(['p2', 'p1'], projects), ['orcabox', 'harness']);
  assert.deepEqual(projectNames(null, projects), []);
  assert.equal(projectLabel('gone', projects), '');
  assert.equal(projectLabel('gone', projects, 'Unknown project'), 'Unknown project');
});

test('agents group under their projects, with no-project agents first and empty groups left out', () => {
  const agents = [
    { name: 'Ada', projectIds: ['p2'] },
    { name: 'Eli', projectIds: null },
    { name: 'Bo', projectIds: ['p2', 'p1'] },
  ];
  assert.deepEqual(groupByProject(agents, projects).map(g => [g.id, g.name, g.agents.map(a => a.name)]), [
    [null, ALL_PROJECTS, ['Eli']],
    ['p2', 'orcabox', ['Ada', 'Bo']],
  ]);
  assert.deepEqual(groupByProject(agents.filter(a => a.projectIds), projects).map(g => g.id), ['p2'], 'each agent once, under its start folder');
});
