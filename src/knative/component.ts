/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

import { KnativeItem } from './knativeItem';
import { window, commands, QuickPickItem, Uri, workspace, ExtensionContext } from 'vscode';
import { Progress } from '../util/progress';
import { ChildProcess } from 'child_process';
import { CliExitData } from '../kn/cli';
import { isURL } from 'validator';
import { Refs, Ref, Type } from '../util/refs';
import { Delayer } from '../util/async';
import { Platform } from '../util/platform';
import path = require('path');
import globby = require('globby');
import { selectWorkspaceFolder } from '../util/workspace';
import { KnAPI } from '../kn/kn-api';
import { ContextType, ComponentType, KnativeTreeObject } from '../kn/knativeTreeObject';

export class Component extends KnativeItem {
    public static extensionContext: ExtensionContext;
    static async getOpenshiftData(context: KnativeTreeObject): Promise<KnativeTreeObject> {
        return await Component.getKnativeCmdData(context,
            "In which Project you want to create a Component",
            "In which Application you want to create a Component"
        );
    }

    static async create(context: KnativeTreeObject): Promise<string> {
        const application = await Component.getOpenshiftData(context);
        if (!application) { return null; }
        const sourceTypes: QuickPickItem[] = [
            {
                label: 'Git Repository',
                description: 'Use an existing git repository as a source for the Component'
            },
            {
                label: 'Binary File',
                description: 'Use binary file as a source for the Component'
            },
            {
                label: 'Workspace Directory',
                description: 'Use workspace directory as a source for the Component'
            }
        ];
        const componentSource = await window.showQuickPick(sourceTypes, {
            placeHolder: "Select source type for Component"
        });
        if (!componentSource) { return null; }

        let command: Promise<string>;
        if (componentSource.label === 'Git Repository') {
            command = Component.createFromGit(application);
        } else if (componentSource.label === 'Binary File') {
            command = Component.createFromBinary(application);
        } else if (componentSource.label === 'Workspace Directory') {
            command = Component.createFromLocal(application);
        }
        return command.catch((err) => Promise.reject(`Failed to create Component with error '${err}'`));
    }

    static async del(treeItem: KnativeTreeObject): Promise<string> {
        const component = await Component.getKnativeCmdData(treeItem,
            "From which Project do you want to delete Component",
            "From which Application you want to delete Component",
            "Select Component to delete");
        if (!component) { return null; }
        const name: string = component.getName();
        const value = await window.showWarningMessage(`Do you want to delete Component '${name}\'?`, 'Yes', 'Cancel');

        if (value === 'Yes') {
            return Progress.execFunctionWithProgress(`Deleting the Component '${component.getName()} '`, async () => {
                if (component.contextValue === ContextType.COMPONENT_NO_CONTEXT || component.contextValue === ContextType.COMPONENT_PUSHED) {
                    await Component.unlinkAllComponents(component);
                }
                await Component.kn.deleteComponent(component);
            }).then(() => `Component '${name}' successfully deleted`)
            .catch((err) => Promise.reject(`Failed to delete Component with error '${err}'`));
        }
    }

    static async undeploy(treeItem: KnativeTreeObject): Promise<string> {
        const component = await Component.getKnativeCmdData(treeItem,
            "From which Project do you want to undeploy Component",
            "From which Application you want to undeploy Component",
            "Select Component to undeploy",
            (component) => component.contextValue === ContextType.COMPONENT_PUSHED);
        if (!component) { return null; }
        const name: string = component.getName();
        const value = await window.showWarningMessage(`Do you want to undeploy Component '${name}\'?`, 'Yes', 'Cancel');
        if (value === 'Yes') {
            return Progress.execFunctionWithProgress(`Undeploying the Component '${component.getName()} '`, async () => {
                await Component.kn.undeployComponent(component);
            }).then(() => `Component '${name}' successfully undeployed`)
            .catch((err) => Promise.reject(`Failed to undeploy Component with error '${err}'`));
        }
    }

    static async unlinkAllComponents(component: KnativeTreeObject) {
        const linkComponent = await Component.getLinkData(component);
        const getLinkComponent = linkComponent['status'].linkedComponents;
        if (getLinkComponent) {
            Object.keys(getLinkComponent).forEach(async key => {
                await Component.kn.execute(KnAPI.unlinkComponents(component.getParent().getParent().getName(), component.getParent().getName(), key, component.getName()), component.contextPath.fsPath);
            });
        }
    }

    static async describe(context: KnativeTreeObject): Promise<string> {
        const component = await Component.getKnativeCmdData(context,
            "From which Project you want to describe Component",
            "From which Application you want to describe Component",
            "Select Component you want to describe",
            (value: KnativeTreeObject) => value.contextValue === ContextType.COMPONENT_PUSHED || value.contextValue === ContextType.COMPONENT_NO_CONTEXT);
        if (!component) { return null; }
        Component.kn.executeInTerminal(KnAPI.describeComponent(component.getParent().getParent().getName(), component.getParent().getName(), component.getName()), component.contextPath ? component.contextPath.fsPath : Platform.getUserHomePath());
    }

    static async log(context: KnativeTreeObject): Promise<string> {
        const component = await Component.getKnativeCmdData(context,
            "In which Project you want to see Log",
            "In which Application you want to see Log",
            "For which Component you want to see Log",
            (value: KnativeTreeObject) => value.contextValue === ContextType.COMPONENT_PUSHED
        );
        if (!component) { return null; }
        Component.kn.executeInTerminal(KnAPI.showLog(component.getParent().getParent().getName(), component.getParent().getName(), component.getName()), component.contextPath.fsPath);
    }

    static async followLog(context: KnativeTreeObject): Promise<string> {
        const component = await Component.getKnativeCmdData(context,
            "In which Project you want to follow Log",
            "In which Application you want to follow Log",
            "For which Component you want to follow Log",
            (value: KnativeTreeObject) => value.contextValue === ContextType.COMPONENT_PUSHED
        );
        if (!component) { return null; }
        Component.kn.executeInTerminal(KnAPI.showLogAndFollow(component.getParent().getParent().getName(), component.getParent().getName(), component.getName()), component.contextPath.fsPath);
    }

    private static async getLinkData(component: KnativeTreeObject) {
        const compData = await Component.kn.execute(KnAPI.describeComponentJson(component.getParent().getParent().getName(), component.getParent().getName(), component.getName()), component.contextPath ? component.contextPath.fsPath : Platform.getUserHomePath());
        return JSON.parse(compData.stdout);
    }

    static async unlink(context: KnativeTreeObject) {
        const unlinkActions = [
            {
                label: 'Component',
                description: 'Unlink Component'
            },
            {
                label: 'Service',
                description: 'Unlink Service'
            }
        ];
        const unlinkActionSelected = await window.showQuickPick(unlinkActions, {placeHolder: 'Select the option'});
        if (!unlinkActionSelected) { return null; }
        return unlinkActionSelected.label === 'Component' ? Component.unlinkComponent(context) : unlinkActionSelected.label === 'Service' ?  Component.unlinkService(context) : null;
    }

    static async unlinkComponent(context: KnativeTreeObject) {
        const linkCompName: Array<string> = [];
        const component = await Component.getKnativeCmdData(context,
            'Select a Project',
            'Select an Application',
            'Select a Component',
            (value: KnativeTreeObject) => value.contextValue === ContextType.COMPONENT_PUSHED
        );
        if (!component) { return null; }
        const linkComponent = await Component.getLinkData(component);
        const getLinkComponent = linkComponent['status'].linkedComponents;
        if (!getLinkComponent) { throw Error('No linked Components found'); }
        Object.keys(getLinkComponent).forEach(async key => {
            linkCompName.push(key);
        });
        const compName = await window.showQuickPick(linkCompName, {placeHolder: "Select a Component to unlink"});
        if (!compName) { return null; }
        return Progress.execFunctionWithProgress(`Unlinking Component`,
            () => Component.kn.execute(KnAPI.unlinkComponents(component.getParent().getParent().getName(), component.getParent().getName(), component.getName(), compName), component.contextPath.fsPath)
                .then(() => `Component '${compName}' has been successfully unlinked from the Component '${component.getName()}'`)
                .catch((err) => Promise.reject(`Failed to unlink Component with error '${err}'`))
        );
    }

    static async unlinkService(context: KnativeTreeObject) {
        const component = await Component.getKnativeCmdData(context,
            'Select a Project',
            'Select an Application',
            'Select a Component',
            (value: KnativeTreeObject) => value.contextValue === ContextType.COMPONENT_PUSHED
        );
        if (!component) { return null; }
        const linkService = await Component.getLinkData(component);
        const getLinkService = linkService['status'].linkedServices;
        if (!getLinkService) { throw Error('No linked Services found'); }
        const serviceName = await window.showQuickPick(getLinkService, {placeHolder: "Select a Service to unlink"});
        if (!serviceName) { return null; }
        return Progress.execFunctionWithProgress(`Unlinking Service`,
            () => Component.kn.execute(KnAPI.unlinkService(component.getParent().getParent().getName(), component.getParent().getName(), serviceName, component.getName()), component.contextPath.fsPath)
                .then(() => `Service '${serviceName}' has been successfully unlinked from the Component '${component.getName()}'`)
                .catch((err) => Promise.reject(`Failed to unlink Service with error '${err}'`))
        );
    }

    static async linkComponent(context: KnativeTreeObject): Promise<String> {
        const component = await Component.getKnativeCmdData(context,
            'Select a Project',
            'Select an Application',
            'Select a Component',
            (value: KnativeTreeObject) => value.contextValue === ContextType.COMPONENT_PUSHED
        );
        if (!component) { return null; }
        const componentPresent = (await Component.kn.getComponents(component.getParent())).filter((component) => component.contextValue !== ContextType.COMPONENT);
        if (componentPresent.length === 1) { throw Error('You have no Components available to link, please create new Knative Component and try again.'); }
        const componentToLink = await window.showQuickPick(componentPresent.filter((comp)=> comp.getName() !== component.getName()), {placeHolder: "Select a Component to link"});
        if (!componentToLink) { return null; }

        const portsResult: CliExitData = await Component.kn.execute(KnAPI.listComponentPorts(component.getParent().getParent().getName(), component.getParent().getName(), componentToLink.getName()));

        let ports: string[] = portsResult.stdout.trim().split(',');
        ports = ports.slice(0, ports.length-1);
        let port: string;
        if (ports.length === 1) {
            port = ports[0];
        } else if (ports.length > 1) {
            port = await window.showQuickPick(ports, {placeHolder: "Select Port to link"});
        } else {
            return Promise.reject(`Component '${component.getName()}' has no Ports declared.`);
        }

        return Progress.execFunctionWithProgress(`Link Component '${componentToLink.getName()}' with Component '${component.getName()}'`,
            () => Component.kn.execute(KnAPI.linkComponentTo(component.getParent().getParent().getName(), component.getParent().getName(), component.getName(), componentToLink.getName(), port), component.contextPath.fsPath)
                .then(() => `Component '${componentToLink.getName()}' successfully linked with Component '${component.getName()}'`)
                .catch((err) => Promise.reject(`Failed to link component with error '${err}'`))
        );
    }

    static async linkService(context: KnativeTreeObject): Promise<String> {
        const component = await Component.getKnativeCmdData(context,
            'Select a Project',
            'Select an Application',
            'Select a Component',
            (value: KnativeTreeObject) => value.contextValue === ContextType.COMPONENT_PUSHED
        );
        if (!component) { return null; }
        const serviceToLink: KnativeTreeObject = await window.showQuickPick(Component.getOsServiceNames(component.getParent()), {placeHolder: "Select the service to link"});
        if (!serviceToLink) { return null; }

        return Progress.execFunctionWithProgress(`Link Service '${serviceToLink.getName()}' with Component '${component.getName()}'`,
            () => Component.kn.execute(KnAPI.linkServiceTo(component.getParent().getParent().getName(), component.getParent().getName(), component.getName(), serviceToLink.getName()), component.contextPath.fsPath)
                .then(() => `Service '${serviceToLink.getName()}' successfully linked with Component '${component.getName()}'`)
                .catch((err) => Promise.reject(`Failed to link Service with error '${err}'`))
        );
    }

    static getPushCmd(): Thenable< string | undefined> {
        return this.extensionContext.globalState.get('PUSH');
    }

    static setPushCmd(fsPath: string): Thenable<void> {
        return this.extensionContext.globalState.update('PUSH',  { pushCmd: KnAPI.pushComponent(),
        contextPath: fsPath});
    }

    static async push(context: KnativeTreeObject): Promise<string> {
        const component = await Component.getKnativeCmdData(context,
            "In which Project you want to push the changes",
            "In which Application you want to push the changes",
            "For which Component you want to push the changes",
            (component) => component.contextValue === ContextType.COMPONENT_PUSHED || component.contextValue === ContextType.COMPONENT);
        if (!component) { return null; }
        const choice = await Component.handleMigratedComponent(component);
        if (!choice) { return null; }
        Component.setPushCmd(component.contextPath.fsPath);
        Component.kn.executeInTerminal(KnAPI.pushComponent(), component.contextPath.fsPath);
        component.contextValue = ContextType.COMPONENT_PUSHED;
        Component.explorer.refresh(component);
    }

    static async handleMigratedComponent(component: KnativeTreeObject): Promise<string> {
        const project = component.getParent().getParent().getName();
        const app = component.getParent().getName();
        try {
            const migrated = await Component.kn.execute(`oc get DeploymentConfig/${component.getName()}-${app} --namespace ${project} -o jsonpath="{$.metadata.labels.kn\\.openshift\\.io/migrated}"`);
            const undeployRequired = JSON.parse(migrated.stdout);
            if (undeployRequired) {
                let choice: string;
                do {
                    choice = await window.showWarningMessage('This Component must be undeployed before new version is pushed, because it was created and deployed with previous version of the extension.', 'Undeploy', 'Help', 'Cancel');
                    switch (choice) {
                        case 'Undeploy':
                            await Component.undeploy(component);
                            return null;
                        case 'Help':
                            commands.executeCommand('vscode.open', Uri.parse(`https://github.com/redhat-developer/vscode-openshift-tools/wiki/Migration-to-v0.1.0`));
                            break;
                        case 'Cancel':
                            return null;
                    }
                } while (choice === 'Help');
                return choice;
            }
        } catch (ignore) {
            return 'Continue';
        }
    }

    static async lastPush() {
        const getPushCmd = await Component.getPushCmd();
        if (getPushCmd['pushCmd'] && getPushCmd['contextPath']) {
            Component.kn.executeInTerminal(getPushCmd['pushCmd'], getPushCmd['contextPath']);
        } else {
            throw Error('No existing push command found');
        }
    }

    static async watch(context: KnativeTreeObject): Promise<void> {
        const component = await Component.getKnativeCmdData(context,
            'Select a Project',
            'Select an Application',
            'Select a Component you want to watch',
            (component) => component.contextValue === ContextType.COMPONENT_PUSHED);
        if (!component) { return null; }
        Component.kn.executeInTerminal(KnAPI.watchComponent(component.getParent().getParent().getName(), component.getParent().getName(), component.getName()), component.contextPath.fsPath);
    }

    static async openUrl(context: KnativeTreeObject): Promise<ChildProcess | string> {
        const component = await Component.getKnativeCmdData(context,
            'Select a Project',
            'Select an Application',
            'Select a Component you want to open in browser',
            (value: KnativeTreeObject) => value.contextValue === ContextType.COMPONENT_PUSHED
        );
        if (!component) { return null; }
        const app: KnativeTreeObject = component.getParent();
        const urlItems = await Component.listUrl(component);
        if (urlItems === null) {
            const value = await window.showInformationMessage(`No URL for Component '${component.getName()}' in Application '${app.getName()}'. Do you want to create a URL and open it?`, 'Create', 'Cancel');
            if (value === 'Create') {
                await commands.executeCommand('openshift.url.create', component);
            }
        }

        if (urlItems !== null) {
            let selectRoute: QuickPickItem;
            const unpushedUrl = urlItems.filter((value) => value.status.state === 'Not Pushed');
            const pushedUrl = urlItems.filter((value) => value.status.state === 'Pushed');
            if (pushedUrl.length > 0) {
                const hostName: QuickPickItem[] = pushedUrl.map((value) => ({ label: `${value.spec.protocol}://${value.spec.host}`, description: `Target Port is ${value.spec.port}`}));
                if (hostName.length >1) {
                    selectRoute = await window.showQuickPick(hostName, {placeHolder: "This Component has multiple URLs. Select the desired URL to open in browser."});
                    if (!selectRoute) { return null; }
                    return commands.executeCommand('vscode.open', Uri.parse(`${selectRoute.label}`));
                } else {
                    return commands.executeCommand('vscode.open', Uri.parse(`${hostName[0].label}`));
                }
            } else if (unpushedUrl.length > 0) {
                return `${unpushedUrl.length} unpushed URL in the local config. Use \'Push\' command before opening URL in browser.`;
            }
        }
    }

    static async listUrl(component: KnativeTreeObject) {
        const UrlDetails = await Component.kn.execute(KnAPI.getComponentUrl(), component.contextPath.fsPath);
        return JSON.parse(UrlDetails.stdout).items;
    }

    static async createFromLocal(context: KnativeTreeObject): Promise<string> {
        let application: KnativeTreeObject = context;

        if (!application) { application = await Component.getOpenshiftData(context); }
        if (!application) { return null; }
        const workspacePath = await selectWorkspaceFolder();
        if (!workspacePath) { return null; }

        const componentList: Array<KnativeTreeObject> = await Component.kn.getComponents(application);
        const componentName = await Component.getName('Component name', componentList, application.getName());

        if (!componentName) { return null; }

        const componentTypeName = await window.showQuickPick(Component.kn.getComponentTypes(), {placeHolder: "Component type"});

        if (!componentTypeName) { return null; }

        const componentTypeVersion = await window.showQuickPick(Component.kn.getComponentTypeVersions(componentTypeName), {placeHolder: "Component type version"});

        if (!componentTypeVersion) { return null; }
        await Progress.execFunctionWithProgress(`Creating new Component '${componentName}'`, () => Component.kn.createComponentFromFolder(application, componentTypeName, componentTypeVersion, componentName, workspacePath));
        return `Component '${componentName}' successfully created. To deploy it on cluster, perform 'Push' action.`;
    }

    static async createFromFolder(folder: Uri): Promise<string> {
        const application = await Component.getKnativeCmdData(undefined,
            "In which Project you want to create a Component",
            "In which Application you want to create a Component"
        );
        if (!application) { return null; }
        const componentList: Array<KnativeTreeObject> = await Component.kn.getComponents(application);
        const componentName = await Component.getName('Component name', componentList, application.getName());

        if (!componentName) { return null; }

        const componentTypeName = await window.showQuickPick(Component.kn.getComponentTypes(), {placeHolder: "Component type"});

        if (!componentTypeName) { return null; }

        const componentTypeVersion = await window.showQuickPick(Component.kn.getComponentTypeVersions(componentTypeName), {placeHolder: "Component type version"});

        if (!componentTypeVersion) { return null; }

        await Progress.execFunctionWithProgress(`Creating new Component '${componentName}'`, () => Component.kn.createComponentFromFolder(application, componentTypeName, componentTypeVersion, componentName, folder));
        return `Component '${componentName}' successfully created. To deploy it on cluster, perform 'Push' action.`;
    }

    static async createFromGit(context: KnativeTreeObject): Promise<string> {
        let application: KnativeTreeObject = context;
        if (!application) { application = await Component.getOpenshiftData(context); }
        if (!application) { return null; }
        const workspacePath = await selectWorkspaceFolder();
        if (!workspacePath) { return null; }
        const delayer = new Delayer<string>(500);

        const repoURI = await window.showInputBox({
            prompt: 'Git repository URI',
            validateInput: (value: string) => {
                return delayer.trigger(async () => {
                    if (!value.trim()) { return 'Empty Git repository URL'; }
                    if (!isURL(value)) { return 'Invalid URL provided'; }
                    const references = await Refs.fetchTag(value);
                    if (!references.get('HEAD')) { return 'There is no git repository at provided URL.'; }
                });
            }
        });

        if (!repoURI) { return null; }

        const references: Map<string, Ref> = await Refs.fetchTag(repoURI);
        const gitRef = await window.showQuickPick([...references.values()].map(value => ({label: value.name, description: value.type === Type.TAG? `Tag at ${value.hash}` : value.hash })) , {placeHolder: "Select git reference (branch/tag)"});

        if (!gitRef) { return null; }

        const componentList: Array<KnativeTreeObject> = await Component.kn.getComponents(application);
        const componentName = await Component.getName('Component name', componentList, application.getName());

        if (!componentName) { return null; }

        const componentTypeName = await window.showQuickPick(Component.kn.getComponentTypes(), {placeHolder: "Component type"});

        if (!componentTypeName) { return null; }

        const componentTypeVersion = await window.showQuickPick(Component.kn.getComponentTypeVersions(componentTypeName), {placeHolder: "Component type version"});

        if (!componentTypeVersion) { return null; }

        const response = await window.showInformationMessage('Do you want to clone git repository for created Component?', 'Yes', 'No');
        if (response === 'Yes') { await commands.executeCommand('git.clone', repoURI); }
        await Component.kn.createComponentFromGit(application, componentTypeName, componentTypeVersion, componentName, repoURI, workspacePath, gitRef.label);
        return `Component '${componentName}' successfully created. To deploy it on cluster, perform 'Push' action.`;
    }

    static async createFromBinary(context: KnativeTreeObject): Promise<string> {

        let application: KnativeTreeObject = context;

        if (!application) { application = await Component.getOpenshiftData(context); }

        if (!application) { return null; }

        const workspacePath = await selectWorkspaceFolder();

        if (!workspacePath) { return null; }

        const globPath = process.platform === 'win32' ? workspacePath.fsPath.replace(/\\/g, '/') : workspacePath.path;
        const paths = globby.sync(`${globPath}`, { expandDirectories: { files: ['*'], extensions: ['jar', 'war']}, deep: 20 });

        if (paths.length === 0) { return "No binary file present in the context folder selected. We currently only support .jar and .war files. If you need support for any other file, please raise an issue."; }

        const binaryFileObj: QuickPickItem[] = paths.map((file) => ({ label: `$(file-zip) ${path.basename(file)}`, description: `${file}`}));

        const binaryFile: any = await window.showQuickPick(binaryFileObj, {placeHolder: "Select binary file"});

        if (!binaryFile) { return null; }

        const componentList: Array<KnativeTreeObject> = await Component.kn.getComponents(application);
        const componentName = await Component.getName('Component name', componentList, application.getName());

        if (!componentName) { return null; }

        const componentTypeName = await window.showQuickPick(Component.kn.getComponentTypes(), {placeHolder: "Component type"});

        if (!componentTypeName) { return null; }

        const componentTypeVersion = await window.showQuickPick(Component.kn.getComponentTypeVersions(componentTypeName), {placeHolder: "Component type version"});

        if (!componentTypeVersion) { return null; }

        await Component.kn.createComponentFromBinary(application, componentTypeName, componentTypeVersion, componentName, Uri.file(binaryFile.description), workspacePath);
        return `Component '${componentName}' successfully created. To deploy it on cluster, perform 'Push' action.`;
    }

    static async import(component: KnativeTreeObject): Promise<string> {
        const prjName = component.getParent().getParent().getName();
        const appName = component.getParent().getName();
        const compName = component.getName();
        // get pvcs and urls based on label selector
        const componentResult = await Component.kn.execute(`oc get dc -l app.kubernetes.io/instance=${compName} --namespace ${prjName} -o json`, Platform.getUserHomePath(), false);
        const componentJson = JSON.parse(componentResult.stdout).items[0];
        const componentType = componentJson.metadata.annotations['app.kubernetes.io/component-source-type'];
        if (componentType === ComponentType.BINARY) {
            return 'Import for binary Knative Components is not supported.';
        } else if (componentType !== ComponentType.GIT && componentType !== ComponentType.LOCAL) {
            throw new Error(`Cannot import unknown Component type '${componentType}'.`);
        }

        const workspaceFolder = await selectWorkspaceFolder();
        if (!workspaceFolder) { return null; }
        return await Progress.execFunctionWithProgress(`Importing component '${compName}'`, async () => {
            try {
                // use annotations to understand what kind of component is imported
                // metadata:
                //  annotations:
                //      app.kubernetes.io/component-source-type: binary
                //      app.openshift.io/vcs-uri: 'file:///helloworld.war'
                // not supported yet

                // metadata:
                //  annotations:
                //      app.kubernetes.io/component-source-type: local
                //      app.openshift.io/vcs-uri: 'file:///./'

                // metadata:
                //  annotations:
                //      app.kubernetes.io/component-source-type: git
                //      app.kubernetes.io/url: 'https://github.com/dgolovin/nodejs-ex'

                if (componentType === ComponentType.GIT) {
                    const bcResult = await Component.kn.execute(`oc get bc/${componentJson.metadata.name} --namespace ${prjName} -o json`);
                    const bcJson = JSON.parse(bcResult.stdout);
                    const compTypeName = componentJson.metadata.labels['app.kubernetes.io/name'];
                    const compTypeVersion = componentJson.metadata.labels['app.openshift.io/runtime-version'];
                    const gitUrl = componentJson.metadata.annotations['app.openshift.io/vcs-uri'] || componentJson.metadata.annotations['app.kubernetes.io/url'];
                    const gitRef = bcJson.spec.source.git.ref || 'master';
                    await Component.kn.execute(KnAPI.createGitComponent(prjName, appName, compTypeName, compTypeVersion, compName, gitUrl, gitRef), workspaceFolder.fsPath);
                } else { // componentType === ComponentType.Local
                    await Component.kn.execute(KnAPI.createLocalComponent(prjName, appName, componentJson.metadata.labels['app.kubernetes.io/name'], componentJson.metadata.labels['app.openshift.io/runtime-version'], compName, workspaceFolder.fsPath));
                }
                // import storage if present
                if (componentJson.spec.template.spec.containers[0].volumeMounts) {
                    const volumeMounts: any[] = componentJson.spec.template.spec.containers[0].volumeMounts.filter((volume) => !volume.name.startsWith(compName));
                    const volumes: any[] = componentJson.spec.template.spec.volumes.filter((volume) => volume.persistentVolumeClaim !== undefined && !volume.name.startsWith(compName));
                    const storageData: Partial<{mountPath: string, pvcName: string}>[] = volumes.map((volume) => {
                        const data: Partial<{mountPath: string, pvcName: string}> = {};
                        const mount = volumeMounts.find((mount) => mount.name === volume.name);
                        data.mountPath = mount.mountPath;
                        data.pvcName = volume.persistentVolumeClaim.claimName;
                        return data;
                    });
                    for (const storage of storageData) {
                        try {
                            const pvcResult = await Component.kn.execute(`oc get pvc/${storage.pvcName} --namespace ${prjName} -o json`, Platform.getUserHomePath(), false);
                            const pvcJson = JSON.parse(pvcResult.stdout);
                            const storageName = pvcJson.metadata.labels['app.kubernetes.io/storage-name'];
                            const size = pvcJson.spec.resources.requests.storage;
                            await Component.kn.execute(KnAPI.createStorage(storageName, storage.mountPath, size), workspaceFolder.fsPath);
                        } catch (ignore) {
                            // means there is no storage attached to component
                        }
                    }
                }
                // import routes if present
                try {
                    const routeResult = await Component.kn.execute(`oc get route -l app.kubernetes.io/instance=${compName},app.kubernetes.io/part-of=${appName} --namespace ${prjName} -o json`, Platform.getUserHomePath(), false);
                    const routeJson = JSON.parse(routeResult.stdout);
                    const routeData: Partial<{name: string, port: string}>[] = routeJson.items.map((element: any) => ({name: element.metadata.labels['kn.openshift.io/url-name'], port: element.spec.port.targetPort}));
                    for (const url of routeData) {
                        Component.kn.execute(KnAPI.createComponentCustomUrl(url.name, url.port), workspaceFolder.fsPath);
                    }
                } catch (ignore) {
                    // means there is no routes to the component
                }
                const wsFolder = workspace.getWorkspaceFolder(workspaceFolder);
                if (wsFolder) {
                    Component.kn.addWorkspaceComponent(wsFolder, component);
                } else {
                    workspace.updateWorkspaceFolders(workspace.workspaceFolders? workspace.workspaceFolders.length : 0 , null, { uri: workspaceFolder });
                }
                return `Component '${compName}' was successfully imported.`;
            } catch (errGetCompJson) {
                throw new Error(`Component import failed with error '${errGetCompJson.message}'.`);
            }
        }); // create component with the same name
    }
}
