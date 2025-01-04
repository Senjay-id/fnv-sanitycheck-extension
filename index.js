const path = require('path');
const { fs, log, selectors, util } = require('vortex-api');
const crypto = require('crypto')
const { exec } = require('child_process');

const FNV_EXECUTABLE = 'FalloutNV.exe';
const FNV_SHORTNAME = 'falloutnv';
const FNV_TRANSLATION_PLUGIN = 'FalloutNV_lang.esp';

let state;
let discovery;

function main(context) {

    context.registerTest('fnvsanitycheck-test-gamemode-activated', 'gamemode-activated', () => {
        state = context.api.getState()
        const currentGame = selectors.activeGameId(state)
        if (currentGame != FNV_SHORTNAME) //Early return if the managed game is not FNV
            return true;
        discovery = selectors.discoveryByGame(state, FNV_SHORTNAME);
        try {
            executableCheckFNV(context.api);
            translationPluginCheckFNV(context.api);
            enhancedDefaultGECKParameter(context.api);
            automaticOverrideCreation(context.api);
            firstSetup(context.api);
            context.api.events.on('mod-enabled', (profileId, modId) => {
                automaticSingleOverrideCreation(context.api, modId);
            });

            return true;
        } catch (err) {
            log('warning', `Error executing tests: ${err}`);
            return false;
        }
    });

    return true;
}

async function translationPluginCheckFNV(api) {
    const pluginPath = path.join(discovery.path, 'data', FNV_TRANSLATION_PLUGIN);
    try {
        await fs.statAsync(pluginPath);
        api.sendNotification({
            id: 'fnvsanitycheck-translationplugin',
            type: 'warning',
            message: 'Translation plugin present',
            allowSuppress: true,
            actions: [
                {
                    title: 'More',
                    action: dismiss => {
                        api.showDialog('info', 'FalloutNV_lang.esp was found in the data folder', {
                            bbcode: api.translate(`This translation plugin directly edits thousands of records to change the language, `
                                + `which will cause many incompatibilities with most mods.[br][/br][br][/br]Do you want to delete it? `)
                        }, [
                            {
                                label: 'Yes', action: () => {
                                    try {
                                        fs.removeAsync(pluginPath);
                                        log('info', 'Translatioh plugin deleted successfully');
                                        dismiss();
                                    } catch (err) {
                                        alert(`Error occurred while deleting file: ${err}`);
                                    }
                                }
                            },
                            { label: 'No' },
                            { label: 'Ignore', action: () => api.suppressNotification(`fnvsanitycheck-translationplugin`) }
                        ]);
                    },
                },
            ],
        });
    }
    catch (err) {
        return; //Exit if the translation plugin doesn't exists
    }
}

function executableCheckFNV(api) {
    const executablePath = path.join(discovery.path, FNV_EXECUTABLE);
    const fileStream = fs.createReadStream(executablePath);
    const hashAlgorithm = 'md5';
    const hash = crypto.createHash(hashAlgorithm);
    const patchedExecutableHashes = [
        '3e00e9397d71fae83af39129471024a7', //Patched GOG executable
        '27c096c5ad9657af4f39f764231521da', //Patched EpicGames executable
        '50c70408a000acade2ed257c87cecbc2', //Patched Steam executable (Presumed US Version?)
        'efee1ff64ea7f2b179d888e4a6c154c0'  //Patched Steam executable Russian Version
    ];

    fileStream.on('data', (data) => {
        hash.update(data);
    });
    fileStream.on('end', () => {
        const executableHash = hash.digest('hex');
        if (!patchedExecutableHashes.includes(executableHash)) {
            api.sendNotification({
                id: 'fnvsanitycheck-fnvexecutable',
                type: 'warning',
                message: 'Unpatched game executable',
                allowSuppress: true,
                actions: [
                    {
                        title: 'More',
                        action: dismiss => {
                            api.showDialog('info', 'Unpatched game executable', {
                                bbcode: api.translate(`The game executable hasn't been patched with the 4GB Patcher. It won't `
                                    + `load xNVSE and will be limited to 2GB of RAM[br][/br]You can download `
                                    + `and install the patch according to your platform from the link below:[br][/br][br][/br]`
                                    + `[url=https://www.nexusmods.com/newvegas/mods/62552]Steam/GOG Patcher[/url][br][/br][br][/br]`
                                    + `[url=https://www.nexusmods.com/newvegas/mods/81281]Epic Games Patcher[/url][br][/br][br][/br]`
                                    + `After patching the game you should only launch the game from the game executable at the vortex dashboard `
                                    + `highlighted by the green circle and not from New Vegas Script Extender to avoid loading the script extender twice.`
                                    + `[img]file:///${path.join(__dirname, 'assets', 'CorrectLaunch.png')}[/img]`)
                            }, [
                                { label: 'Close' },
                                { label: 'Ignore', action: () => api.suppressNotification(`fnvsanitycheck-fnvexecutable`) }
                            ]);
                        },
                    },
                ],
            });
        }
    });
    fileStream.on('error', (err) => {
        log(`error`, `Error reading executable file: ${err}`);
    });
}

async function enhancedDefaultGECKParameter() {
    const GECKConfigPath = path.join(util.getVortexPath('documents'), 'My Games', 'FalloutNV', 'GECKCustom.ini');
    const GECKConfigDirPath = path.join(util.getVortexPath('documents'), 'My Games', 'FalloutNV');
    try {
        await fs.ensureDirWritableAsync(GECKConfigDirPath);
        await fs.statAsync(GECKConfigPath); // if it doesn't exist, create an enhanced configuration
    }
    catch (err) {
        fs.writeFileAsync(GECKConfigPath, //The absent of whitespace is intended
            `[General]\n`
            + `bUseMultibounds=0\n`
            + `bAllowMultipleMasterLoads=1\n`
            + `bAllowMultipleEditors=1\n`
            + `[Localization]\n`
            + `iExtendedTopicLength=255\n`
            + `bAllowExtendedText=1`
        )
    }
}

async function createOverrideFiles(modPath, api) {
    let overrideCreated = false;
    try {
        const modDirectories = await fs.readdirAsync(modPath, { withFileTypes: true });
        let bsaFiles;

        for (const dirent of modDirectories) {
            if (!dirent.isDirectory() || dirent.name === '.git') {
                continue;  // Ignore non-directories and .git directory
            }

            const modDirPath = path.join(modPath, dirent.name);
            try {
                bsaFiles = (await fs.readdirAsync(modDirPath))
                    .filter(file => file.endsWith('.bsa'));
            } catch (e) {
                log(`error`, `An error has occured while filtering bsa files: ${e}`);
            }

            for (const bsaFile of bsaFiles) {
                const fileNameWithoutExtension = path.basename(bsaFile, '.bsa');
                const overrideFilePath = path.join(modDirPath, `${fileNameWithoutExtension}.override`);

                try {
                    await fs.statAsync(overrideFilePath); // if it doesn't exist, create the override files
                }
                catch (err) {
                    await fs.openAsync(overrideFilePath, 'a');
                    overrideCreated = true;
                    log('info', `An override file for ${bsaFile} is missing, one was automatically generated.`);
                }
            }
        }
    } catch (error) {
        log('warning', `Failed to create override files in ${modPath}: ${error.message}`);
    }
    if (overrideCreated) {
        api.sendNotification({
            id: 'fnvsanitycheck-overridedeploy',
            type: 'warning',
            message: 'Redeployment required',
            allowSuppress: true,
            actions: [
                {
                    title: 'More',
                    action: dismiss => {
                        api.showDialog('info', 'Redeployment required', {
                            bbcode: api.translate(`Vortex has automatically added .override files for all bsa files in the staging folder.[br][/br]`
                                + `Redeployment of mods is necessary to ensure the override files are added.[br][/br][br][/br]`
                                + `BSA files can be made to override previous BSA files like newer Bethesda titles by creating an empty `
                                + `text file with the same name as the BSA file and adding the extension .override to the filename. `
                                + `More information [url=https://geckwiki.com/index.php?title=BSA_Files]here[/url][br][/br][br][/br]`
                                + `This behavior requires the [url=https://www.nexusmods.com/newvegas/mods/58277]JIP LN NVSE[/url] plugin to work as expected.`)
                        }, [
                            {
                                label: 'Deploy', action: () => {
                                    api.events.emit('deploy-mods', (err) => {
                                        if (err) {
                                            log('warn', `Error deploying mods \n\n${err}`);
                                        } else {
                                            log('debug', 'Override file created, event emitted.');
                                        }
                                    });
                                    dismiss()
                                }
                            },
                            { label: 'Close' },
                            { label: 'Ignore', action: () => api.suppressNotification(`fnvsanitycheck-overridedeploy`) }
                        ]);
                    },
                },
            ],
        });
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

function automaticOverrideCreation(api) {
    const staging = selectors.installPathForGame(state, FNV_SHORTNAME);
    createOverrideFiles(staging, api);
}

function automaticSingleOverrideCreation(api, modId) {
    const staging = selectors.installPathForGame(state, FNV_SHORTNAME);
    createSingleOverrideFiles(path.join(staging, modId));
}

function firstSetup(api) {
    api.sendNotification({
        id: 'fnvsanitycheck-firstsetup',
        type: 'info',
        message: 'First time setup: Important notice',
        allowSuppress: true,
        actions: [
            {
                title: 'More',
                action: dismiss => {
                    api.showDialog('info', 'First time setup: Important notice', {
                        bbcode: api.translate(`[size=4]1. Base Address Randomization. (Credits to Viva New Vegas)[/size][br][/br]`
                            + `Base Address Randomization is a security feature in Windows that allows program's starting address to be randomized, `
                            + `which will crash the game when using NVSE plugins or the 4GB Patch.[br][/br][br][/br]While the feature should be disabled by default, `
                            + `it is still recommended to sanity check if it is disabled:[br][/br]`
                            + `[list]
                                [*] Open [b]Windows Security[/b] from your Start Menu.
                                [*] Click on [b]App & browser control[/b] in the left sidebar.
                                [*] Click on [b]Exploit protection settings[/b] under [b]Exploit protection[/b].
                                [*] Ensure [b]Force randomization for images (Mandatory ASLR)[/b] is set to [b]Use default (Off)[/b].
                                [/list][br][/br]`
                            + `[size=4]2. Outdated AMD GPU Driver Crash (only applies to [b]AMD GPU Users[/b])[/size][br][/br]`
                            + `The GPU driver version from [b]24.1.1[/b] up to [b]24.5.1[/b] may fail to compile the shader and [b]crash the game[/b]. The issue is stated `
                            + `on the official AMD website [url=https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-24-4-1.html]here[/url].[br][/br][br][/br]`
                            + `Make sure your driver version is updated.`)
                    }, [
                        { label: 'Close' },
                        { label: 'Close and forget', action: () => api.suppressNotification(`fnvsanitycheck-firstsetup`) }
                    ]);
                },
            },
        ],
    });
}

module.exports = {
    default: main,
};
