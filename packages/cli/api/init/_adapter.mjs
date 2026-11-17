// Copyright (c) Meta Platforms, Inc. and affiliates.

/**
 * @file Environment adapter for init: for `init --user`, the home folder, the
 * settings file, the per-user state, and the search path (spec AST-081 FR7,
 * FR8); for `init --to`, the project's saved places, its config, and the
 * skill files each place holds; for the getting-started steps, the project's
 * install command (architecture:cli-surface INV21).
 *
 * @input  the home folder, the settings file, the search path
 * @output the computer-level agent text written or removed, with the setting
 *   and the links recorded
 * @position packages/cli/api/init — imported by the user and run leaves
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  COMPUTER_COMMAND,
  COMPUTER_INSTALL_STEP,
  astryxOnSearchPath,
  computerAgentCommand,
  displayHomePath,
  removeComputerAgentText,
  writeComputerAgentText,
} from '../../foundation/agent-docs/computer-agent-text.mjs';
import {
  computerAgentTextSettings,
  recordComputerAgentTextSettings,
} from '../../foundation/env/user-settings.mjs';
import {recordAgentTextWritten} from '../../foundation/release/global-state.mjs';
import {cliVersion} from '../../foundation/release/run-context.mjs';
import {installStepFor} from '../../foundation/discovery/template-needs.mjs';
export {STARTER_THEME} from '../../foundation/discovery/theme-discovery.mjs';
import {
  computerInstallStep,
  renderComputerAgentText,
} from '../../foundation/agent-docs/computer-agent-text.mjs';
import {resolveAgentDocsRoot} from '../../foundation/agent-docs/agent-docs-target.mjs';
import {renderAgentDocsBlock} from '../../foundation/agent-docs/agent-docs.mjs';
import {
  savedName,
  projectPlacesValue,
  renderProjectSkill,
} from '../../foundation/agent-docs/skill-places.mjs';
import {
  computerSkillFolders,
  recordComputerSkillFolders,
} from '../../foundation/env/user-settings.mjs';
import {setConfigValues} from '../../foundation/config/config-writer.mjs';
import {AstryxError} from '../error.mjs';
import {ERROR_CODES} from '../../foundation/response/error-codes.mjs';

export {COMPUTER_COMMAND, COMPUTER_INSTALL_STEP, displayHomePath};
export {
  readProjectPlaces,
  removeSkillPlace,
  writeSkillPlace,
} from '../../foundation/agent-docs/skill-place-files.mjs';
import {keptText, skillPlaceEscape} from '../../foundation/agent-docs/skill-place-files.mjs';

// What the run leaf reads before it writes agent docs: the state of the files
// it is about to write.
export {
  inspectAgentDocs,
  resolveAgentPaths,
} from '../../foundation/agent-docs/agent-docs.mjs';

/**
 * Write or refresh the computer-level agent text, or remove it, and record
 * the setting and the links Astryx made; after a write, record the release
 * that wrote it.
 * @param {{remove: boolean}} options
 * @returns {{home: string, command: string, files: import('./init.type.mjs').InitUserFile[], cliOnSearchPath: boolean}}
 */
export function applyComputerAgentText({remove}) {
  const home = os.homedir();
  const command = computerAgentCommand();
  const recorded = computerAgentTextSettings().links;
  /** @type {import('./init.type.mjs').InitUserFile[]} */
  let files;
  if (remove) {
    files = removeComputerAgentText({home, links: recorded});
    recordComputerAgentTextSettings({install: false, links: []});
  } else {
    const written = writeComputerAgentText({home, command});
    files = written.rows;
    recordComputerAgentTextSettings({
      install: true,
      links: [...new Set([...recorded, ...written.links])],
    });
    recordAgentTextWritten(cliVersion());
  }
  return {home, command, files, cliOnSearchPath: astryxOnSearchPath()};
}

/**
 * The install step to print for `packages` in the project at `cwd`: its
 * package manager's command, or `npm install` with a note when its lockfiles
 * disagree.
 * @param {string[]} packages
 * @param {string} cwd
 * @returns {{line: string, note: string | null}}
 */
export function projectInstallStep(packages, cwd) {
  return installStepFor(packages, cwd);
}

/**
 * The project root a skill place belongs to, or null when no folder above
 * `cwd` has a package.json.
 * @param {string} cwd
 * @returns {string | null}
 */
export function skillProjectRoot(cwd) {
  return resolveAgentDocsRoot(cwd);
}


/**
 * Save the project places in `skills.to` of the project's config: no key for
 * the default alone, and no config file when nothing else is left in it. A
 * protected or dynamic config throws, before any file is written.
 * @param {string} projectRoot
 * @param {readonly import('../../foundation/agent-docs/skill-places.mjs').SkillPlace[]} places
 * @param {{check?: boolean}} [options] `check`: throw as the save would, and
 *   write nothing, so a run can stop before it changes any place
 */
export function saveProjectPlaces(projectRoot, places, {check = false} = {}) {
  let written;
  try {
    written = setConfigValues(projectRoot, [['skills.to', projectPlacesValue(places)]], {check});
  } catch (error) {
    // A protected config keeps the stable code every consumer-file writer
    // uses (spec:AST-040 FR4, FR6).
    const code = /** @type {{code?: unknown}} */ (error)?.code;
    const stable = [
      ERROR_CODES.ERR_CODEMOD_PROTECTED,
      ERROR_CODES.ERR_CODEMOD_PROTECTION_SOURCE,
    ].find(each => each === code);
    throw new AstryxError(
      error instanceof Error ? error.message : String(error),
      undefined,
      stable ?? ERROR_CODES.ERR_WRITE_FAILED,
    );
  }
  // A config left holding nothing says what no config says, so it goes, as
  // after a move back to the default place in a project init gave a config.
  if (
    !check &&
    written.changed &&
    /^export default \{\};?\s*$/u.test(fs.readFileSync(written.file, 'utf8'))
  ) {
    fs.unlinkSync(written.file);
  }
}

/**
 * Refuse a project place whose skill files resolve outside the project, as
 * through a skills folder linked out of it, before anything is written.
 * @param {import('../../foundation/agent-docs/skill-places.mjs').SkillPlace} place
 * @param {string} projectRoot
 */
export function assertPlaceWithin(place, projectRoot) {
  const escape = skillPlaceEscape(place, projectRoot);
  if (escape) throw new AstryxError(escape, undefined, ERROR_CODES.ERR_PATH_TRAVERSAL);
}

/**
 * The project skill's text for the project at `projectRoot`.
 * @param {string} projectRoot
 * @returns {Promise<string>}
 */
export async function projectSkillText(projectRoot) {
  return renderProjectSkill(await renderAgentDocsBlock(projectRoot));
}

/**
 * The computer-level skill's text, for a folder outside any project.
 * @param {string} command
 * @returns {string}
 */
export function computerSkillText(command) {
  return renderComputerAgentText({command, install: computerInstallStep()});
}




/**
 * Add folders outside any project to the ones the settings file records.
 * @param {readonly string[]} folders as saved: `~/<path>` or absolute
 */
export function addComputerSkillFolders(folders) {
  const saved = computerSkillFolders();
  recordComputerSkillFolders([...new Set([...saved, ...folders])]);
}

/**
 * Drop folders outside any project from the ones the settings file records.
 * @param {readonly string[]} folders as saved: `~/<path>` or absolute
 */
export function dropComputerSkillFolders(folders) {
  const drop = new Set(folders);
  const saved = computerSkillFolders();
  if (saved.some(each => drop.has(each))) {
    recordComputerSkillFolders(saved.filter(each => !drop.has(each)));
  }
}

/**
 * The folders outside any project the settings file records.
 * @returns {string[]}
 */
export function computerSkillFoldersSaved() {
  return computerSkillFolders();
}


/**
 * One receipt row, and its line, for one skill file a run wrote or removed.
 * Null for a file that was not there.
 * @param {import('../../foundation/agent-docs/skill-places.mjs').SkillPlace} place
 * @param {{file: string, action: string, reason?: 'edited' | 'not-astryx' | 'pair-kept' | 'computer-skill'}} row
 * @param {(file: string) => string} shown the file as the receipt names it
 * @param {string} editedHint what a person does with a file they edited
 * @returns {{entry: import('./init.type.mjs').InitSkillFile, line: string} | null}
 */
export function skillReceiptRow(place, row, shown, editedHint) {
  if (row.action === 'absent') return null;
  /** @type {import('./init.type.mjs').InitSkillFile} */
  const entry = {
    path: shown(row.file),
    place: savedName(place),
    action: /** @type {import('./init.type.mjs').InitSkillFile['action']} */ (row.action),
  };
  if (row.reason) entry.reason = row.reason;
  const line =
    entry.action === 'kept'
      ? `[skip] Astryx skill: ${entry.path} ${keptText(entry.reason, editedHint)}`
      : entry.action === 'unchanged'
        ? `[ok] Astryx skill: ${entry.path} already current, nothing changed`
        : `[ok] Astryx skill: ${entry.path} ${entry.action}`;
  return {entry, line};
}
