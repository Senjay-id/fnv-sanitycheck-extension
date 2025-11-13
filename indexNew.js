const path = require('path');
const semver = require('semver');
const { spawn } = require('child_process');
const { fs, log, selectors, util, actions } = require('vortex-api');
const crypto = require('crypto');
const { RegGetValue, RegSetKeyValue } = require('winapi-bindings');

const DEBUG = false;

const FNV_EXECUTABLE = 'FalloutNV.exe';
const FNV_SHORTNAME = 'falloutnv';
const FNV_TRANSLATION_PLUGIN = 'FalloutNV_lang.esp';
const NVSE_EXECUTABLE = 'nvse_loader.exe';
const PATCH_4GB_EXECUTABLES = ['FNVpatch.exe', 'FalloutNVpatch.exe', 'Patcher.exe'];

const JIP_LNVSE_MOD_ID = 58277;
const PATCH_4GB_MOD_ID = 62552;
const PATCH_4GB_MOD_ID_EPIC = 81281;

function isJIPLNVSEEnabled(api) {
  if (selectors?.getMod == null) {
    return false;
  }
  const mod = selectors?.getMod?.(api.getState(), FNV_SHORTNAME, JIP_LNVSE_MOD_ID);
  if (mod == null) {
    return false;
  }
  const profile = selectors.activeProfile(api.getState());
  if (profile == null) {
    return false;
  }
  return profile.modState?.[mod.id]?.enabled === true;
}

function testASLR(api) {
  const activeGameId = selectors.activeGameId(api.getState());
  if (activeGameId !== FNV_SHORTNAME) {
    return Promise.resolve(undefined);
  }
  const aslrEnabled = isASLREnabled() || DEBUG;
  if (!aslrEnabled) {
    return Promise.resolve(undefined);
  }

  return new Promise(async (resolve) => {
    const res = {
      description: {
        short: 'Base Address Randomization is enabled',
        long: api.translate(''
          + `Base Address Randomization is a security feature in Windows that allows program's starting address to be randomized, `
          + `which will crash the game when using NVSE plugins or the 4GB Patch.<br/><br/>While the feature should be disabled by default, `
          + `it is currently enabled on your system. <br/><br/>`
          + `Vortex can automatically disable Base Address Randomization for you by modifying the necessary registry keys.<br/><br/>`
          + `Alternatively you can disable it manually:<br/><br/>`
          + `[list]
                [*] Open [b]Windows Security[/b] from your Start Menu.
                [*] Click on [b]App & browser control[/b] in the left sidebar.
                [*] Click on [b]Exploit protection settings[/b] under [b]Exploit protection[/b].
                [*] Ensure [b]Force randomization for images (Mandatory ASLR)[/b] is set to [b]Use default (Off)[/b].
                [/list]<br/><br/>`),
      },
      severity: 'warning',
      automaticFix: (async () => disableASLR()),
      onRecheck: (async () => isASLREnabled())
    }
    return res !== undefined ? resolve(res) : resolve(undefined)
  });
}

function testAMDDriver(api) {
  const activeGameId = selectors.activeGameId(api.getState());
  if (activeGameId !== FNV_SHORTNAME) {
    return Promise.resolve(undefined);
  }
  const hasOutdatedDriver = hasOutdatedAMDDriver() || DEBUG;
  if (!hasOutdatedDriver) {
    return Promise.resolve(undefined);
  }
  return new Promise(async (resolve) => {
    const res = {
      description: {
        short: 'Outdated AMD GPU Driver detected',
        long: api.translate(''
          + `The GPU driver version from [b]24.1.1[/b] up to [b]24.5.1[/b] may fail to compile the shader and [b]crash the game[/b]. The issue is stated `
          + `on the official AMD website [url=https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-24-4-1.html]here[/url].<br/><br/>`
          + `Make sure your driver version is updated.`),
      },
      severity: 'warning',
      // No automatic fix available
    }
    return resolve(res);
  });
}

async function isExecutablePatched(api) {
  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, FNV_SHORTNAME);
  if (!discovery?.path) {
    return false;
  }
  try {
    const executablePath = path.join(discovery.path, FNV_EXECUTABLE);
    const fileData = await fs.readFileAsync(executablePath);
    const hash = crypto.createHash('md5');
    hash.update(fileData);
    const executableHash = hash.digest('hex');

    const patchedExecutableHashes = [
      '3e00e9397d71fae83af39129471024a7', //Patched GOG executable
      '27c096c5ad9657af4f39f764231521da', //Patched EpicGames executable
      '50c70408a000acade2ed257c87cecbc2', //Patched Steam executable (Presumed US Version?)
      'efee1ff64ea7f2b179d888e4a6c154c0'  //Patched Steam executable Russian Version
    ];

    return patchedExecutableHashes.includes(executableHash);
  } catch (err) {
    log('error', `Error reading executable file: ${err}`);
    return false;
  }
}

function testExecutable(api) {
  return new Promise(async (resolve) => {
    const activeGameId = selectors.activeGameId(api.getState());
    if (activeGameId !== FNV_SHORTNAME) {
      return resolve(undefined);
    }

    const state = api.getState();
    const discovery = selectors.discoveryByGame(state, FNV_SHORTNAME);
    if (!discovery?.path) {
      return resolve(undefined);
    }

    try {
      const isPatched = await isExecutablePatched(api);
      if (!isPatched || DEBUG) {
        const res = {
          description: {
            short: 'Unpatched game executable',
            long: api.translate(''
              + `The game executable hasn't been patched with the 4GB Patcher. It won't `
              + `load xNVSE and will be limited to 2GB of RAM.<br/><br/> `
              + `Vortex can automatically download, install and run the 4GB Patcher for you.<br/><br/>`
              + `Alternatively, you can download `
              + `and install the patch according to your platform from the link below:<br/><br/>`
              + `[url=https://www.nexusmods.com/newvegas/mods/62552]Steam/GOG Patcher[/url]<br/><br/>`
              + `[url=https://www.nexusmods.com/newvegas/mods/81281]Epic Games Patcher[/url]<br/><br/>`
              + `After patching the game you should only launch the game from the game executable at the vortex dashboard `
              + `highlighted by the green circle and not from New Vegas Script Extender to avoid loading the script extender twice.`),
          },
          automaticFix: (async () => downloadAndInstall4GBPatch(api)),
          onRecheck: (async () => isExecutablePatched(api)),
          severity: 'warning',
        };
        return resolve(res);
      }
    } catch (err) {
      log('error', `Error reading executable file: ${err}`);
    }
    return resolve(undefined);
  });
}

function testTranslationPlugin(api) {
  return new Promise(async (resolve) => {
    const activeGameId = selectors.activeGameId(api.getState());
    if (activeGameId !== FNV_SHORTNAME) {
      return resolve(undefined);
    }

    const state = api.getState();
    const discovery = selectors.discoveryByGame(state, FNV_SHORTNAME);
    if (!discovery?.path) {
      return resolve(undefined);
    }

    const pluginPath = path.join(discovery.path, 'data', FNV_TRANSLATION_PLUGIN);
    try {
      DEBUG ? Promise.resolve() : await fs.statAsync(pluginPath);
      const res = {
        description: {
          short: 'Translation plugin present',
          long: api.translate(''
            + `FalloutNV_lang.esp was found in the data folder.<br/><br/>`
            + `This translation plugin directly edits thousands of records to change the language, `
            + `which will cause many incompatibilities with most mods.<br/><br/>`
            + `It is recommended to delete it.`),
        },
        severity: 'warning',
        automaticFix: (async () => {
          await fs.removeAsync(pluginPath);
          log('info', 'Translation plugin deleted successfully');
        }),
      };
      return resolve(res);
    } catch (err) {
      // Plugin doesn't exist - that's good
      return resolve(undefined);
    }
  });
}

async function isLegacyNVSEExecutable(api) {
  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, FNV_SHORTNAME);
  if (!discovery?.path) {
    return false;
  }

  const nvseExecutable = path.join(discovery.path, NVSE_EXECUTABLE);
  try {
    await fs.statAsync(nvseExecutable);
    const fileData = await fs.readFileAsync(nvseExecutable);
    const hash = crypto.createHash('md5');
    hash.update(fileData);
    const executableHash = hash.digest('hex');
    const legacyExecutableHash = '23bd7b28b6022c23ff1fb2443467ad99';
    return legacyExecutableHash === executableHash || DEBUG;
  } catch (err) {
    // NVSE doesn't exist or can't be read - not a problem
    return false;
  }
}

function testLegacyNVSE(api) {
  return new Promise(async (resolve) => {
    const activeGameId = selectors.activeGameId(api.getState());
    if (activeGameId !== FNV_SHORTNAME) {
      return resolve(undefined);
    }

    try {
      const isLegacy = await isLegacyNVSEExecutable(api);
      if (isLegacy) {
        const res = {
          description: {
            short: 'Old NVSE version detected',
            long: api.translate(''
              + `Vortex has detected that you're using an old legacy version of the NVSE hosted on the silverlock website `
              + `which might cause issues with the current plugin mods.<br/><br/>`
              + `A newer version of NVSE can be found [url=https://www.nexusmods.com/newvegas/mods/67883]here[/url]`),
          },
          severity: 'warning',
          automaticFix: () => api.emitAndAwait('download-script-extender', FNV_SHORTNAME),
          onRecheck: (async () => isLegacyNVSEExecutable(api)),
        };
        return resolve(res);
      }
    } catch (err) {
      // NVSE doesn't exist or can't be read - not a problem
    }
    return resolve(undefined);
  });
}

function main(context) {
  // Register all tests - pass functions, don't call them
  context.registerTest('fnvsanitycheck-test-amd-driver', 'gamemode-activated', () => testAMDDriver(context.api));
  context.registerTest('fnvsanitycheck-test-disable-aslr', 'gamemode-activated', () => testASLR(context.api));
  context.registerTest('fnvsanitycheck-test-executable', 'gamemode-activated', () => testExecutable(context.api));
  context.registerTest('fnvsanitycheck-test-translation-plugin', 'gamemode-activated', () => testTranslationPlugin(context.api));
  context.registerTest('fnvsanitycheck-test-legacy-nvse', 'gamemode-activated', () => testLegacyNVSE(context.api));

  // Register one-time setup tasks that run on game activation
  context.once(() => {
    context.api.events.on('gamemode-activated', (gameId) => {
      if (gameId !== FNV_SHORTNAME) {
        return;
      }
      automaticOverrideCreation(context.api);
      enhancedDefaultGECKParameter(context.api);
    });
    context.api.events.on('mod-enabled', (profileId, modId) => {
      const profile = selectors.profileById(context.api.getState(), profileId);
      if (profile?.gameId !== FNV_SHORTNAME) {
        return;
      }
      automaticSingleOverrideCreation(context.api, modId);
    });
  });

  return true;
}

function disableASLR() {
  try {
    // Disable MoveImages (system-wide ASLR)
    // Setting this to 0 disables ASLR for all executables system-wide
    try {
      RegSetKeyValue(
        'HKEY_LOCAL_MACHINE',
        'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management',
        'MoveImages',
        0
      );
      log('info', 'MoveImages set to 0 (system-wide ASLR disabled).');
    } catch (err) {
      log('debug', `Failed to set MoveImages: ${err}`);
    }

    // Disable Mandatory ASLR in MitigationOptions
    // Read current MitigationOptions to preserve other mitigations
    const currentResult = RegGetValue(
      'HKEY_LOCAL_MACHINE',
      'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Kernel',
      'MitigationOptions'
    );

    let mitigationOptionsBuffer;

    if (currentResult && Buffer.isBuffer(currentResult.value)) {
      // Preserve existing settings
      mitigationOptionsBuffer = Buffer.from(currentResult.value);
    } else {
      // Create new buffer if key doesn't exist
      mitigationOptionsBuffer = Buffer.alloc(8, 0);
    }

    // Disable only Mandatory ASLR bits (bits 0-1 of byte 1)
    // Preserve all other mitigation settings
    if (mitigationOptionsBuffer.length >= 2) {
      mitigationOptionsBuffer[1] = mitigationOptionsBuffer[1] & ~0x03; // Clear bits 0 and 1
    }

    RegSetKeyValue(
      'HKEY_LOCAL_MACHINE',
      'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Kernel',
      'MitigationOptions',
      mitigationOptionsBuffer
    );
    log('info', 'Mandatory ASLR disabled in MitigationOptions (other mitigations preserved).');
    log('info', 'ASLR fully disabled. System restart required for changes to take effect.');
  } catch (err) {
    log('error', `Failed to disable ASLR: ${err}`);
  }
}

function isASLREnabled() {
  try {
    // Check for MoveImages (system-wide ASLR override)
    // This key usually doesn't exist, which means default behavior (ASLR disabled unless forced per-executable)
    const moveImagesResult = RegGetValue(
      'HKEY_LOCAL_MACHINE',
      'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management',
      'MoveImages'
    );

    if (moveImagesResult?.value && moveImagesResult.value !== 0) {
      log('warn', `MoveImages is set to ${moveImagesResult.value}, indicating ASLR is enabled system-wide.`);
      return true;
    }
  } catch (err) {
    // Key doesn't exist - this is normal, means default ASLR behavior
    log('debug', 'MoveImages registry key does not exist (default behavior)');
  }

  try {
    // Check for Mandatory ASLR (MitigationOptions)
    //  This key usually doesn't exist, which means default behavior
    const mitigationOptionsResult = RegGetValue(
      'HKEY_LOCAL_MACHINE',
      'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Kernel',
      'MitigationOptions'
    );

    if (mitigationOptionsResult && Buffer.isBuffer(mitigationOptionsResult.value)) {
      const mitigationOptions = mitigationOptionsResult.value;

      if (mitigationOptions.length >= 2) {
        // Mandatory ASLR is controlled by bits in byte 1 (second byte)
        // Bit 0 and 1 of byte 1 control Mandatory ASLR
        const byte1 = mitigationOptions[1];
        const mandatoryASLR = (byte1 & 0x03) !== 0;

        if (mandatoryASLR) {
          log('warn', 'Mandatory ASLR (Force randomization) is enabled in MitigationOptions');
          return true; // ASLR is forced
        } else {
          log('info', 'Mandatory ASLR is disabled in MitigationOptions');
          return false; // ASLR is disabled (safe)
        }
      }
    }
  } catch (err) {
    // Key doesn't exist - means Mandatory ASLR is not forced
    log('debug', 'MitigationOptions registry key does not exist (Mandatory ASLR not forced)');
  }

  // Neither MoveImages nor Mandatory ASLR are enabled
  return false;
}

function hasOutdatedAMDDriver() {
  try {
    const driverVersionResult = RegGetValue(
      'HKEY_LOCAL_MACHINE',
      'SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000',
      'DriverVersion'
    );
    if (driverVersionResult && typeof driverVersionResult.value === 'string') {
      const driverVersion = driverVersionResult.value;
      const problematicDriverVersionRegex = /^24\.[1-5]\.\d+/;
      if (problematicDriverVersionRegex.test(driverVersion)) {
        log('warn', `Detected problematic AMD GPU driver version: ${driverVersion}`);
        return true;
      }
    }
  } catch (err) {
    // meh
  }
  return false;
}


async function enhancedDefaultGECKParameter(api) {
  const GECKConfigDirPath = path.join(util.getVortexPath('documents'), 'My Games', 'FalloutNV');
  const GECKConfigPath = path.join(GECKConfigDirPath, 'GECKCustom.ini');

  try {
    await fs.ensureDirWritableAsync(GECKConfigDirPath);
    await fs.statAsync(GECKConfigPath); // Check if the file exists
  } catch (err) {
    if (err.code !== 'ENOENT') {
      api.showErrorNotification('Failed to access GECKConfig file', err);
      log('error', `Unexpected error accessing GECKConfig file: ${err.message}`);
      return;
    }

    try {
      await fs.writeFileAsync(GECKConfigPath,
        `[General]\n`
        + `bUseMultibounds=0\n`
        + `bAllowMultipleMasterLoads=1\n`
        + `bAllowMultipleEditors=1\n`
        + `[Localization]\n`
        + `iExtendedTopicLength=255\n`
        + `bAllowExtendedText=1`
      );
    } catch (writeErr) {
      api.showErrorNotification('Failed to write GECKConfig file', writeErr);
      log('error', `Error writing GECKConfig file: ${writeErr.message}`);
    }
  }
}

async function createOverrideFiles(modPath, api) {
  let overrideCreated = false;
  try {
    await util.walk(modPath, util.toBlue(async () => async (entry) => {
      if (!entry.isDirectory && path.extname(entry.filePath) === '.bsa') {
        const fileNameWithoutExtension = path.basename(entry.filePath, '.bsa');
        const overrideFilePath = path.join(path.dirname(entry.filePath), `${fileNameWithoutExtension}.override`);
        try {
          await fs.statAsync(overrideFilePath); // if it doesn't exist, create the override files
        } catch (err) {
          await fs.openAsync(overrideFilePath, 'a');
          overrideCreated = true;
          log('info', `An override file for ${entry.filePath} is missing, one was automatically generated.`);
        }
        return null;
      }
    }), { ignoreErrors: true });
    if (overrideCreated) {
      api.store.dispatch(actions.setDeploymentNecessary(FNV_SHORTNAME, true));
    }
  } catch (error) {
    log(`warn`, `Failed to create override files in ${modPath}. error message: ${error}`);
  }
}

async function createSingleOverrideFiles(modPath) {
  try {
    const files = await fs.readdirAsync(modPath);
    const bsaFiles = files.filter(file => file.endsWith('.bsa'));

    for (const bsaFile of bsaFiles) {
      const fileNameWithoutExtension = path.basename(bsaFile, '.bsa');
      const overrideFilePath = path.join(modPath, `${fileNameWithoutExtension}.override`);

      try {
        await fs.statAsync(overrideFilePath); // Check if file exists
      } catch (err) {
        await fs.openAsync(overrideFilePath, 'a'); // Create the override file
        log('info', `An override file for ${bsaFile} was created.`);
      }
    }

  } catch (error) {
    log(`warn`, `Failed to create override files in ${modPath}. error message: ${error}`);
  }
}

async function downloadAndInstall4GBPatch(api) {
  const state = api.getState();
  const discovery = selectors.discoveryByGame(state, FNV_SHORTNAME);
  const hasNewSelectors = selectors.getDownloadByIds != null && selectors.getMod != null;
  if (!discovery?.path) {
    log('error', 'Could not find game path for 4GB patch download');
    return;
  }
  const patchModId = discovery.store === 'epic' ? PATCH_4GB_MOD_ID_EPIC : PATCH_4GB_MOD_ID;
  let nxmUrl = `https://www.nexusmods.com/newvegas/mods/${patchModId}?tab=files`;
  if (!hasNewSelectors) {
    log('error', 'Vortex version does not support automatic 4GB patch download');
    util.opn(nxmUrl).catch(() => null);
    return;
  }
  try {
    if (api.ext?.ensureLoggedIn !== undefined) {
      await api.ext.ensureLoggedIn();
    }
    const modFiles = await api.ext.nexusGetModFiles(FNV_SHORTNAME, patchModId);

    const file = modFiles
      .filter(file => file.category_id === 1)
      .sort((lhs, rhs) => semver.rcompare(util.coerceToSemver(lhs.version), util.coerceToSemver(rhs.version)))[0];

    if (file === undefined) {
      throw new util.ProcessCanceled('No 4GB patch main file found');
    }

    const dlInfo = {
      game: FNV_SHORTNAME,
      name: '4GB Patch',
    };

    const existingDownload = selectors.getDownloadByIds?.(api.getState(), {
      gameId: FNV_SHORTNAME,
      modId: patchModId,
      fileId: file.file_id,
    });
    nxmUrl = `nxm://${FNV_SHORTNAME}/mods/${patchModId}/files/${file.file_id}`;
    const dlId = existingDownload
      ? existingDownload.id
      : await util.toPromise<string>(cb => api.events.emit('start-download', [nxmUrl], dlInfo, undefined, cb, 'never', { allowInstall: false }));
    const existingMod = selectors.getMod?.(api.getState(), FNV_SHORTNAME, patchModId);
    const modId = ((existingMod?.state === 'installed') && (existingMod.attributes?.fileId === file.file_id))
      ? existingMod.id
      : await util.toPromise<string>(cb => api.events.emit('start-install-download', dlId, { allowAutoEnable: false }, cb));
    const profileId = selectors.lastActiveProfileForGame(api.getState(), FNV_SHORTNAME);
    await actions.setModsEnabled(api, profileId, [modId], true, {
      allowAutoDeploy: false,
      installed: true,
    });
    await api.emitAndAwait('deploy-single-mod', FNV_SHORTNAME, modId);
    await runInstaller4GBPatch(api, modId);
  } catch (err) {
    log('error', 'Failed to download patch', err);
    util.opn(nxmUrl).catch(() => null);
  }
}

async function runInstaller4GBPatch(api, modId) {
  const state = api.getState();
  const mod = selectors.getMod?.(state, FNV_SHORTNAME, modId);
  if (!mod?.installationPath) {
    log('error', `Could not find mod ${modId} for 4GB patch installation`);
    return;
  }
  const discovery = selectors.discoveryByGame(state, FNV_SHORTNAME);
  if (!discovery?.path) {
    log('error', 'Could not find game path for 4GB patch installation');
    return;
  }
  const installPath = selectors.getModInstallPath?.(state, FNV_SHORTNAME, modId);
  if (!installPath) {
    log('error', 'Could not find installation path for 4GB patch mod');
    return;
  }
  const files = await fs.readdirAsync(installPath);
  const patchExec = files.find(f => PATCH_4GB_EXECUTABLES.includes(f));
  if (!patchExec) {
    log('error', 'Could not find 4GB patch executable');
    return;
  }
  const patchPath = path.join(installPath, patchExec);
  try {
    await new Promise((resolve, reject) => {
      const cp = spawn(patchPath, [], {
        cwd: discovery.path,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      cp.stdout?.on('data', (data) => {
        const lines = data.toString().split('\n').map(l => l.trim()).filter(l => l);
        const logLines = lines.map(l => `[4GB Patch Installer] ${l}`);
        log('info', logLines.join('\n'));
        if (logLines.map(l => l.toLowerCase()).some(l => l.includes('any key'))) {
          cp.stdin?.write('\n');
        }
      });

      cp.stderr?.on('data', (data) => {
        log('warn', `[4GB Patch Installer] ${data.toString()}`);
      });

      cp.on('error', (error) => {
        reject(error);
      });

      cp.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`4GB patch installer exited with code ${code}`));
        }
      });
    });
    api.sendNotification({
      type: 'success',
      message: '4GB patch installed successfully',
      displayMS: 3000,
    });
  } catch (err) {
    log('error', 'Failed to run 4GB patch installer', err);
    api.sendNotification({
      type: 'error',
      message: 'Failed to install 4GB patch',
      displayMS: 5000,
    });
  }
}

function automaticOverrideCreation(api) {
  if (!isJIPLNVSEEnabled(api)) {
    return;
  }
  const state = api.getState();
  const staging = selectors.installPathForGame(state, FNV_SHORTNAME);
  createOverrideFiles(staging, api);
}

function automaticSingleOverrideCreation(api, modId) {
  if (!isJIPLNVSEEnabled(api)) {
    return;
  }
  const state = api.getState();
  const staging = selectors.installPathForGame(state, FNV_SHORTNAME);
  createSingleOverrideFiles(path.join(staging, modId));
}

module.exports = {
  default: main,
};
