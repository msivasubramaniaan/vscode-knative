/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as fsExtra from 'fs-extra';
import * as path from 'path';
import * as vscode from 'vscode';
import { which } from 'shelljs';
import { Archive } from '../util/archive';
import { DownloadUtil } from '../util/download';
import { Platform } from '../util/platform';

import hasha = require('hasha');
import semver = require('semver');
import configData = require('./kn-cli-config.json');

export default class KnCliConfig {
  static tools: object = KnCliConfig.loadMetadata(configData, Platform.OS);

  static loadMetadata(requirements, platform: string): object {
    const reqs = JSON.parse(JSON.stringify(requirements));
    for (const object in requirements) {
      if (reqs[object].platform) {
        if (reqs[object].platform[platform]) {
          Object.assign(reqs[object], reqs[object].platform[platform]);
          delete reqs[object].platform;
        } else {
          delete reqs[object];
        }
      }
    }
    return reqs;
  }

  static resetConfiguration(): void {
    KnCliConfig.tools = KnCliConfig.loadMetadata(configData, Platform.OS);
  }

  static async detectOrDownload(cmd: string): Promise<string> {
    let toolLocation: string = KnCliConfig.tools[cmd].location;

    if (toolLocation === undefined) {
      const toolCacheLocation = path.resolve(
        Platform.getUserHomePath(),
        '.vs-kn',
        KnCliConfig.tools[cmd].cmdFileName,
      );
      const whichLocation = which(cmd);
      const toolLocations: string[] = [
        whichLocation ? whichLocation.stdout : null,
        toolCacheLocation,
      ];
      toolLocation = await KnCliConfig.selectTool(
        toolLocations,
        KnCliConfig.tools[cmd].versionRange,
      );

      if (toolLocation === undefined) {
        // otherwise request permission to download
        const toolDlLocation = path.resolve(
          Platform.getUserHomePath(),
          '.vs-kn',
          KnCliConfig.tools[cmd].dlFileName,
        );
        const installRequest = `Download and install v${KnCliConfig.tools[cmd].version}`;
        const response = await vscode.window.showInformationMessage(
          `Cannot find ${KnCliConfig.tools[cmd].description} ${KnCliConfig.tools[cmd].versionRangeLabel}.`,
          installRequest,
          'Help',
          'Cancel',
        );
        fsExtra.ensureDirSync(path.resolve(Platform.getUserHomePath(), '.vs-kn'));
        if (response === installRequest) {
          let action: string;
          do {
            action = undefined;
            await vscode.window.withProgress(
              {
                cancellable: true,
                location: vscode.ProgressLocation.Notification,
                title: `Downloading ${KnCliConfig.tools[cmd].description}`,
              },
              (progress: vscode.Progress<{ increment: number; message: string }>) => {
                return DownloadUtil.downloadFile(
                  KnCliConfig.tools[cmd].url,
                  toolDlLocation,
                  (dlProgress, increment) =>
                    progress.report({ increment, message: `${dlProgress}%` }),
                );
              },
            );
            const sha256sum: string = await hasha.fromFile(toolDlLocation, { algorithm: 'sha256' });
            if (sha256sum !== KnCliConfig.tools[cmd].sha256sum) {
              fsExtra.removeSync(toolDlLocation);
              action = await vscode.window.showInformationMessage(
                `Checksum for downloaded ${KnCliConfig.tools[cmd].description} v${KnCliConfig.tools[cmd].version} is not correct.`,
                'Download again',
                'Cancel',
              );
            }
          } while (action === 'Download again');

          if (action !== 'Cancel') {
            if (toolDlLocation.endsWith('.zip') || toolDlLocation.endsWith('.tar.gz')) {
              await Archive.unzip(
                toolDlLocation,
                path.resolve(Platform.getUserHomePath(), '.vs-kn'),
                KnCliConfig.tools[cmd].filePrefix,
              );
            } else if (toolDlLocation.endsWith('.gz')) {
              await Archive.unzip(
                toolDlLocation,
                toolCacheLocation,
                KnCliConfig.tools[cmd].filePrefix,
              );
            }
            fsExtra.removeSync(toolDlLocation);
            if (Platform.OS !== 'win32') {
              fs.chmodSync(toolCacheLocation, 0o765);
            }
            toolLocation = toolCacheLocation;
          }
        } else if (response === `Help`) {
          vscode.commands.executeCommand(
            'vscode.open',
            vscode.Uri.parse(
              `https://github.com/talamer/vscode-knative/blob/master/README.md#requirements`,
            ),
          );
        }
      }
      if (toolLocation) {
        KnCliConfig.tools[cmd].location = toolLocation;
      }
    }
    return toolLocation;
  }

  static async getVersion(location: string): Promise<string> {
    let detectedVersion: string;
    if (fs.existsSync(location)) {
      // const version = new RegExp(`${cmd.toLocaleLowerCase()} v((([0-9]+)\\.([0-9]+)\\.([0-9]+)(?:-([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?)(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?).*`);
      const version = new RegExp(
        `Version:(\\s+)v((([0-9]+)\\.([0-9]+)\\.([0-9]+)(?:-([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?)(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?).*`,
      );
      const result = await Cli.getInstance().execute(`"${location}" version`);
      if (result.stdout) {
        const toolVersion: string[] = result.stdout
          .trim()
          .split('\n')
          .filter((value) => {
            return value.match(version);
          })
          .map((value) => version.exec(value)[2]);
        if (toolVersion.length) {
          detectedVersion = toolVersion[0];
        }
      }
    }
    return detectedVersion;
  }

  static async selectTool(locations: string[], versionRange: string): Promise<string> {
    let result: string;
    for (const location of locations) {
      if (location && semver.satisfies(await KnCliConfig.getVersion(location), versionRange)) {
        result = location;
        break;
      }
    }
    return result;
  }
}
