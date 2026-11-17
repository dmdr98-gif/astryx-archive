// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file The skill places on disk: the project places a config saves, and the
 * skill files each place holds, checked to stay inside the project, read,
 * written, and removed under the managed file rules
 * (`managed-skill-file.mjs`). `init`, `upgrade`, and `doctor` share it.
 *
 * @input  a project root, a place, the text this release renders for it
 * @output the saved places, each file's state, and the write and remove rows
 * @position foundation/agent-docs — read by the init, upgrade, and doctor
 *   adapters
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {findConfigPath} from '../config/config-path.mjs';
import {computerSkillFile, computerSkillLinks, copyStateOf} from './computer-agent-text.mjs';
import {computerAgentTextSettings} from '../env/user-settings.mjs';
import {PathSafetyError, assertWithin} from '../fs/path-safety.mjs';
import {loadModuleWithParser} from '../fs/module-loader.mjs';
import {parseConfig} from '../../authoring/config/parse.mjs';
import {placeSkillFiles, savedProjectPlaces} from './skill-places.mjs';
import {
  keptReason,
  managedFileState,
  removeManagedFileIfOwned,
  writeManagedFile,
} from './managed-skill-file.mjs';

/**
 * The project places saved in the project's config. Only the config is
 * loaded, not its integrations. A config that cannot be loaded saves none,
 * so init writes the default as before, and the agent docs report the load
 * error.
 * @param {string} projectRoot
 * @returns {Promise<import('./skill-places.mjs').SkillPlace[]>}
 */
export async function readProjectPlaces(projectRoot) {
  try {
    const configPath = findConfigPath(projectRoot);
    const config = configPath
      ? await loadModuleWithParser(configPath, parseConfig, {
          label: 'astryx.config',
          fresh: true,
        })
      : undefined;
    return savedProjectPlaces(config, projectRoot);
  } catch {
    return savedProjectPlaces(undefined, projectRoot);
  }
}

/**
 * Why `file` belongs to another place, so it is never written or removed
 * through this one, or null when it is this place's:
 * - `computer-skill`: it is the computer-level skill
 *   (`~/.agents/skills/astryx/SKILL.md`), reached through a saved folder
 *   such as `~/.agents/skills`, or one of the links or managed copies the
 *   computer-level text made for it (a link that reaches that folder, or a
 *   folder in its table holding only an unedited Astryx skill file while the
 *   text is installed and the skill file exists), as
 *   through `~/.claude/skills`; `astryx init --remove --to user` removes it.
 * - `not-astryx`: in a folder saved for this computer, a file its linked
 *   skill folder already holds (where it holds none, the skill is written
 *   through the link). In a project place a link stays inside the
 *   project (init refuses one that leaves it), so the copies it joins share
 *   one file, written once.
 * A folder at an agent's skills path that the computer-level text never
 * made is the saved folder's own.
 * @param {string} file
 * @param {import('./skill-places.mjs').SkillPlace} place
 * @returns {'computer-skill' | 'not-astryx' | null}
 */
function otherPlacesFile(file, place) {
  const dir = path.dirname(file);
  const realOf = (/** @type {string} */ p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const at = realOf(dir);
  if (at == null) return null;
  const skillDir = path.dirname(computerSkillFile());
  const skillReal = fs.existsSync(computerSkillFile()) ? realOf(skillDir) : null;
  if (skillReal != null && at === skillReal) return 'computer-skill';
  // While the text is installed, a folder in its table that holds only an
  // unedited Astryx skill file is the copy it keeps there: Continue's, or
  // one where a link could not be made.
  if (skillReal != null && computerAgentTextSettings().install) {
    for (const place of computerSkillLinks()) {
      if (realOf(place.path) === at && copyStateOf(place.path, '') === 'differs') {
        return 'computer-skill';
      }
    }
  }
  if (place.scope !== 'computer') return null;
  // A file a linked folder already holds is someone else's; where it holds
  // none, the skill is written through the link.
  try {
    if (fs.lstatSync(dir).isSymbolicLink() && fs.existsSync(file)) return 'not-astryx';
  } catch {
    return null;
  }
  return null;
}

/**
 * A skill file's state, a file that belongs to another place
 * (otherPlacesFile) reading as one Astryx did not write for this place.
 * @param {string} file
 * @param {import('./skill-places.mjs').SkillPlace} place
 * @param {string} text
 * @returns {import('./managed-skill-file.mjs').ManagedFileState}
 */
function placeFileState(file, place, text) {
  return otherPlacesFile(file, place) ? 'foreign' : managedFileState(file, text);
}

/**
 * Write `text` to each skill file of `place`. The copies of one place are
 * written together or not at all: when any is a person's own (edited, or not
 * Astryx's), each is kept, so every agent reads one text.
 * @param {import('./skill-places.mjs').SkillPlace} place
 * @param {string | null} projectRoot
 * @param {string} text
 * @returns {Array<{file: string, action: import('./managed-skill-file.mjs').ManagedFileAction, reason?: 'edited' | 'not-astryx' | 'pair-kept' | 'computer-skill'}>}
 */
export function writeSkillPlace(place, projectRoot, text) {
  const files = placeSkillFiles(place, projectRoot);
  const states = files.map(file => ({file, state: placeFileState(file, place, text)}));
  const owned = (/** @type {string} */ state) => state === 'edited' || state === 'foreign';
  if (files.length > 1 && states.some(each => owned(each.state))) {
    return states.map(({file, state}) => ({
      file,
      action: /** @type {const} */ ('kept'),
      reason: owned(state) ? keptReason(/** @type {'edited' | 'foreign'} */ (state)) : /** @type {const} */ ('pair-kept'),
    }));
  }
  // Every copy must be writable before the first is written, so a refused
  // copy never leaves the place on two texts.
  for (const {file, state} of states) {
    if (state !== 'current' && state !== 'foreign') assertWritable(file);
  }
  return files.map(file => {
    const other = otherPlacesFile(file, place);
    return other
      ? {file, action: /** @type {const} */ ('kept'), reason: other}
      : {file, ...writeManagedFile(file, text)};
  });
}

/**
 * Throw when `file` cannot be written: the file itself, or the nearest folder
 * above it that exists, refuses writes.
 * @param {string} file
 */
function assertWritable(file) {
  let at = file;
  while (!fs.existsSync(at)) {
    const parent = path.dirname(at);
    if (parent === at) break;
    at = parent;
  }
  fs.accessSync(at, fs.constants.W_OK);
}

/**
 * Remove each skill file of `place` that is an unedited Astryx file, and
 * each folder that leaves empty, up to the folder the place names.
 * @param {import('./skill-places.mjs').SkillPlace} place
 * @param {string | null} projectRoot
 * @returns {Array<{file: string, action: import('./managed-skill-file.mjs').ManagedFileAction, reason?: 'edited' | 'not-astryx' | 'computer-skill'}>}
 */
export function removeSkillPlace(place, projectRoot) {
  // Folders the removal empties go too: a folder place as well, and the
  // project root never.
  const stop =
    place.kind !== 'folder'
      ? projectRoot
      : place.dir === projectRoot
        ? projectRoot
        : path.dirname(place.dir);
  return placeSkillFiles(place, projectRoot).map(file => {
    const other = otherPlacesFile(file, place);
    if (other) return {file, action: /** @type {const} */ ('kept'), reason: other};
    const result = removeManagedFileIfOwned(file);
    if (result.action === 'removed' && stop)
      removeEmptyFolders(path.dirname(file), stop);
    return {file, ...result};
  });
}

/**
 * Remove `dir` and each folder above it while it is empty, stopping below
 * `stop`.
 * @param {string} dir
 * @param {string} stop
 */
function removeEmptyFolders(dir, stop) {
  let at = dir;
  while (at !== stop && !path.relative(stop, at).startsWith('..')) {
    try {
      fs.rmdirSync(at);
    } catch (error) {
      // Already gone: the file's own folder goes with the file.
      if (/** @type {{code?: string}} */ (error).code !== 'ENOENT') return;
    }
    at = path.dirname(at);
  }
}

/**
 * Why a project place cannot be written: one of its skill files resolves
 * outside the project, as through a skills folder linked out of it (such as
 * `.claude` linked to `~/.claude`). Null when every file stays inside.
 * @param {import('./skill-places.mjs').SkillPlace} place
 * @param {string} projectRoot
 * @returns {string | null}
 */
export function skillPlaceEscape(place, projectRoot) {
  for (const file of placeSkillFiles(place, projectRoot)) {
    try {
      assertWithin(path.relative(projectRoot, file), projectRoot, {label: 'skill file'});
    } catch (err) {
      if (err instanceof PathSafetyError) {
        return `${err.message} Astryx writes the project skill only inside the project; make that folder a real folder in the project, or choose another place with \`astryx init --to\`.`;
      }
      throw err;
    }
  }
  return null;
}

/**
 * The state of each skill file of `place` against `text`.
 * @param {import('./skill-places.mjs').SkillPlace} place
 * @param {string | null} projectRoot
 * @param {string} text
 * @returns {Array<{file: string, state: import('./managed-skill-file.mjs').ManagedFileState}>}
 */
export function inspectSkillPlace(place, projectRoot, text) {
  return placeSkillFiles(place, projectRoot).map(file => ({
    file,
    state: placeFileState(file, place, text),
  }));
}

/**
 * What a receipt line says about a skill file a run kept as it is, by why
 * it was kept. `editedHint` says what a person does with a file they edited.
 * @param {'edited' | 'not-astryx' | 'pair-kept' | 'computer-skill' | 'not-written' | undefined} reason
 * @param {string} editedHint
 * @returns {string}
 */
export function keptText(reason, editedHint) {
  if (reason === 'edited') return `kept, edited since Astryx wrote it; ${editedHint}`;
  if (reason === 'computer-skill') {
    return 'kept: it is the computer-level skill; `astryx init --remove --to user` removes it';
  }
  if (reason === 'pair-kept') {
    return "kept: the other copy of this place is not Astryx's, so neither copy is written";
  }
  if (reason === 'not-written') return 'not written: a copy of this place could not be written, so neither was';
  return 'kept, not created by Astryx';
}
