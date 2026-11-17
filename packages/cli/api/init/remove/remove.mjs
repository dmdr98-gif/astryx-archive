// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file init.remove leaf — the `--remove` path behind `astryx init`
 * (`--remove-agents` is the same option).
 *
 * `remove(ctx)` removes the Astryx skill from every place the project saved
 * (astryx.config `skills.to`), or, with `--to`, from the places it names, and
 * drops them from what is saved. The managed block goes from every agent-doc
 * file at the project root, where init writes it, and in the working folder,
 * whenever the AGENTS.md place is one of them, and always without `--to`. A
 * skill file a person edited, or one Astryx did not write, is kept. The
 * removal engines live in foundation/agent-docs and the adapter.
 *
 * Note: removeAgentDocs() still logs its own per-file lines via humanLog
 * (shared lib behavior) — so a programmatic remove is not perfectly silent yet.
 * Threading a logger through agent-docs is a separate cleanup.
 */

import * as path from 'node:path';
import {removeProjectAgentDocs} from '../../../foundation/agent-docs/agent-docs.mjs';
import {savedName} from '../../../foundation/agent-docs/skill-places.mjs';
import {
  assertPlaceWithin,
  computerSkillFoldersSaved,
  dropComputerSkillFolders,
  readProjectPlaces,
  removeSkillPlace,
  saveProjectPlaces,
  skillProjectRoot,
  skillReceiptRow,
} from '../_adapter.mjs';
import {user} from '../user/user.mjs';
import {logger} from '../../logger.mjs';


/**
 * Remove the Astryx skill and return an `init.remove` receipt. Progress is
 * emitted through the shared `logger` (silent by default).
 *
 * @param {{cwd?: string, places?: import('../../../foundation/agent-docs/skill-places.mjs').SkillPlace[], projectRoot?: string | null}} [ctx]
 *   `places`: the places `--to` named; without them, the project's saved places
 * @returns {Promise<import('../init.type.mjs').InitRemoveResponse>}
 */
export async function remove({cwd = process.cwd(), places, projectRoot} = {}) {
  const root = projectRoot === undefined ? skillProjectRoot(cwd) : projectRoot;
  /** @type {import('../../../foundation/agent-docs/skill-places.mjs').SkillPlace[]} */
  const saved = root
    ? await readProjectPlaces(root)
    : [{scope: 'project', kind: 'agents-md'}];
  const targets = places ?? saved;
  const names = new Set(targets.map(savedName));

  // Nothing outside the project is removed through a project place, as
  // through a skills folder linked out of it.
  if (root) {
    for (const place of targets) {
      if (place.scope === 'project' && place.kind !== 'agents-md') assertPlaceWithin(place, root);
    }
  }
  // The record comes first: a config that cannot be written stops the run
  // before anything is removed.
  const left = saved.filter(place => !names.has(savedName(place)));
  const savedSomething = !(saved.length === 1 && saved[0]?.kind === 'agents-md');
  if (root && savedSomething && left.length !== saved.length) {
    saveProjectPlaces(root, left.length > 0 ? left : [{scope: 'project', kind: 'agents-md'}]);
  }

  /** @type {import('../init.type.mjs').InitRemoveData} */
  const data = {removed: false, from: targets.map(savedName), skills: [], user: null};

  if (places === undefined || targets.some(place => place.kind === 'agents-md')) {
    /** @type {string[]} */
    const skipped = [];
    const removedFrom = removeProjectAgentDocs(cwd, {
      onSkipped: (rel, reason) => skipped.push(`${rel} (${reason})`),
    });
    if (skipped.length > 0) {
      // Below the project root, as install does there (0.7.x touched only the
      // working folder): a root agent file outside the project is left alone.
      logger.warn(
        `Note: Left as ${skipped.length === 1 ? 'it is' : 'they are'}: ${skipped.join('; ')}. ` +
          'To remove the Astryx block there, delete it by hand.',
      );
    }
    data.removed = removedFrom.length > 0;
    // A project on skill places has no block; its skill lines follow.
    const savesSkill = targets.some(place => place.kind === 'skills' || place.kind === 'folder');
    if (data.removed) logger.log('[ok] AI agent docs removed.');
    else if (!savesSkill) logger.log('[ok] Nothing to remove: no Astryx agent-docs block was found.');
  }

  /** @param {string} file */
  const shown = file => {
    const rel = root ? path.relative(root, file) : '..';
    return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel.split(path.sep).join('/');
  };
  for (const place of targets) {
    if (place.kind !== 'skills' && place.kind !== 'folder') continue;
    for (const row of removeSkillPlace(place, root)) {
      const receipt = skillReceiptRow(place, row, shown, 'delete it by hand');
      if (!receipt) continue;
      data.skills.push(receipt.entry);
      logger.log(receipt.line);
    }
  }
  dropComputerSkillFolders(
    targets
      .filter(place => place.scope === 'computer' && place.kind === 'folder')
      .map(savedName),
  );
  // Without `--to`, the folders outside the project stay: they are this
  // computer's, saved by whichever run added them.
  if (places === undefined) {
    const folders = computerSkillFoldersSaved();
    if (folders.length > 0) {
      logger.warn(
        `Note: Kept the Astryx skill in ${folders.join(', ')}, saved for this computer, not the project. To remove ${folders.length === 1 ? 'it' : 'them'}: ${folders.map(folder => `\`astryx init --remove --to ${folder}\``).join(', ')}.`,
      );
    }
  }
  if (targets.some(place => place.kind === 'user')) {
    data.user = (await user({remove: true})).data;
  }
  data.removed =
    data.removed ||
    data.skills.some(row => row.action === 'removed') ||
    (data.user?.files.some(file => file.action === 'removed') ?? false);
  return {type: 'init.remove', data};
}
